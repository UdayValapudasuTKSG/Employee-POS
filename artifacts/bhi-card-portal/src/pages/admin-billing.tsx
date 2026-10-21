import { useState } from 'react';
import { Link } from 'wouter';
import {
  useListCompanies,
  useListBillingRuns,
  getListBillingRunsQueryKey,
  useGenerateBillingRuns,
  BillingRunSummaryStatus,
  GenerateBillingItemStatus,
  type BillingRunSummary,
  type Company,
  type GenerateBillingResult,
  type ListBillingRunsParams,
} from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';
import { PageHeader } from '@/components/page-header';
import { StatusPill } from '@/components/screen-ui';
import {
  BILLING_ERROR_TITLES,
  BillingStatusPill,
  DraftAge,
  GenerateResultPill,
  billingRunPath,
  runHistory,
  useInvalidateBilling,
  useNow,
} from '@/components/billing-status';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { THIS_MONTH, shiftMonth } from '@/lib/dates';
import { formatMoney, formatMonth, formatTimestamp } from '@/lib/format';
import { describeError, useApiErrorToast } from '@/lib/api-errors';
import { AlertCircle, AlertTriangle, ChevronRight, Info, Play } from 'lucide-react';

// Monthly bills (spec FR-024). One run per company per month, priced from each
// member's state at 00:00 on the 1st (Guyana time): their class, and their tier
// from the number of active dependants (capped at "more than two"). A company's
// own rate wins over the standard rate. Generating again recalculates: the old
// draft is kept as SUPERSEDED (shown as "Replaced") and a new draft replaces it,
// marked "Recalculated 2 min ago". FINAL runs are frozen.
//
// Anyone with BILLING_READ reads the runs in their scope; only a super admin
// (BILLING_MANAGE) generates, recalculates and finalises.

const ALL = '__ALL__';

/** Next month (bills can be prepared ahead), this month, then the two years before. */
const MONTH_OPTIONS = Array.from({ length: 26 }, (_, i) => shiftMonth(THIS_MONTH, 1 - i));

const STATUS_ORDER: Record<BillingRunSummaryStatus, number> = {
  [BillingRunSummaryStatus.DRAFT]: 0,
  [BillingRunSummaryStatus.FINAL]: 0,
  [BillingRunSummaryStatus.SUPERSEDED]: 1,
};

function companyLabel(companies: Company[] | undefined, companyNumber: string, fallback?: string | null): string {
  return fallback ?? companies?.find((c) => c.companyNumber === companyNumber)?.companyName ?? companyNumber;
}

function MonthSelect({ value, onChange, testId }: { value: string; onChange: (value: string) => void; testId: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full md:w-56" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MONTH_OPTIONS.map((month) => (
          <SelectItem key={month} value={month}>
            {formatMonth(month)}
            {month === THIS_MONTH && <span className="ml-2 text-xs text-muted-foreground">(this month)</span>}
            {month > THIS_MONTH && <span className="ml-2 text-xs text-muted-foreground">(next month)</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CompanyFilter({
  value,
  onChange,
  companies,
  loading,
  allLabel,
  activeOnly = false,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  companies: Company[] | undefined;
  loading: boolean;
  allLabel: string;
  activeOnly?: boolean;
  testId: string;
}) {
  const shown = activeOnly ? companies?.filter((c) => c.active) : companies;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full md:w-72" data-testid={testId}>
        <SelectValue placeholder={loading ? 'Loading companies…' : allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {shown?.map((company) => (
          <SelectItem key={company.companyNumber} value={company.companyNumber}>
            {company.companyName}
            <span className="mono-id ml-2 text-xs text-muted-foreground">{company.companyNumber}</span>
            {!company.active && <span className="ml-2 text-xs text-muted-foreground">(offboarded)</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---- Generate ------------------------------------------------------------------

function GenerateResults({ result, companies }: { result: GenerateBillingResult; companies: Company[] | undefined }) {
  if (result.results.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No active companies to bill for this month.</p>;
  }
  return (
    <div className="max-h-[50vh] overflow-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Company</TableHead>
            <TableHead>Result</TableHead>
            <TableHead className="text-right">Lines</TableHead>
            <TableHead className="text-right">Issues</TableHead>
            <TableHead className="text-right">Total (GYD)</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.results.map((item) => (
            <TableRow key={item.companyNumber} data-testid={`row-generate-result-${item.companyNumber}`}>
              <TableCell>
                <div className="text-sm">{companyLabel(companies, item.companyNumber)}</div>
                <div className="mono-id text-xs text-muted-foreground">{item.companyNumber}</div>
              </TableCell>
              <TableCell>
                <GenerateResultPill status={item.status} />
                {item.message && <div className="mt-1 max-w-xs text-xs text-muted-foreground">{item.message}</div>}
                {item.supersededRunId !== null && (
                  <div className="mt-1 text-xs text-muted-foreground">Replaces run #{item.supersededRunId}</div>
                )}
              </TableCell>
              <TableCell className="tnum text-right">{item.lines ?? '—'}</TableCell>
              <TableCell className="tnum text-right">
                {item.issues === null ? (
                  '—'
                ) : item.issues > 0 ? (
                  <span className="font-semibold text-error">{item.issues}</span>
                ) : (
                  item.issues
                )}
              </TableCell>
              <TableCell className="tnum text-right font-medium">{formatMoney(item.totals?.totalPremium)}</TableCell>
              <TableCell className="text-right">
                {item.runId !== null && (
                  <Link
                    href={billingRunPath(item.runId)}
                    className="whitespace-nowrap text-sm font-medium text-foreground underline"
                    data-testid={`link-generate-result-run-${item.companyNumber}`}
                  >
                    Open
                  </Link>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function GenerateDialog({
  month,
  initialCompany,
  companies,
  companiesLoading,
  onGenerated,
  onClose,
}: {
  month: string;
  initialCompany: string;
  companies: Company[] | undefined;
  companiesLoading: boolean;
  /** Called with the month just generated, so the list behind the dialog shows it. */
  onGenerated: (month: string) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const apiError = useApiErrorToast(BILLING_ERROR_TITLES);
  const invalidate = useInvalidateBilling();
  const generateMutation = useGenerateBillingRuns();
  const [targetMonth, setTargetMonth] = useState(month);
  const [scope, setScope] = useState(initialCompany);
  const [result, setResult] = useState<GenerateBillingResult | null>(null);

  const submit = () => {
    generateMutation.mutate(
      { data: { month: targetMonth, companies: scope === ALL ? 'ALL' : [scope] } },
      {
        onSuccess: (data) => {
          invalidate();
          setResult(data);
          onGenerated(data.month);
          const failed = data.results.filter((r) => r.status === GenerateBillingItemStatus.FAILED).length;
          const drafts = data.results.filter((r) => r.status === GenerateBillingItemStatus.DRAFT).length;
          toast({
            title: failed > 0 ? 'Bills generated with failures' : 'Bills generated',
            description: `${formatMonth(data.month)}: ${drafts} draft${drafts === 1 ? '' : 's'} created${
              failed > 0 ? `, ${failed} failed` : ''
            }.`,
            variant: failed > 0 ? 'destructive' : undefined,
          });
        },
        onError: (e: any) => apiError(e, 'Unable to generate the bills'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className={result ? 'max-w-3xl' : 'max-w-lg'}>
        <DialogHeader>
          <DialogTitle>{result ? `Bills for ${formatMonth(result.month)}` : 'Generate bills'}</DialogTitle>
          <DialogDescription>
            {result
              ? 'A draft is ready to check and finalise. A company whose bill is already final was left unchanged.'
              : 'Prices every member from their class and active dependants at 00:00 on the 1st. If a draft already exists it is recalculated: the old version is kept as an earlier calculation. Final bills are never changed.'}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <GenerateResults result={result} companies={companies} />
        ) : (
          <div className="space-y-4">
            <div>
              <Label className="mb-1.5 block">Month</Label>
              <MonthSelect value={targetMonth} onChange={setTargetMonth} testId="select-generate-month" />
            </div>
            <div>
              <Label className="mb-1.5 block">Companies</Label>
              <CompanyFilter
                value={scope}
                onChange={setScope}
                companies={companies}
                loading={companiesLoading}
                allLabel="All active companies"
                activeOnly
                testId="select-generate-company"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={onClose} data-testid="button-generate-done">
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={generateMutation.isPending} data-testid="button-confirm-generate">
                {generateMutation.isPending ? 'Generating…' : 'Generate'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Page ------------------------------------------------------------------------

function sortRuns(runs: BillingRunSummary[]): BillingRunSummary[] {
  return [...runs].sort(
    (a, b) =>
      (a.companyName ?? a.companyNumber).localeCompare(b.companyName ?? b.companyNumber) ||
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (b.generatedAt ?? '').localeCompare(a.generatedAt ?? ''),
  );
}

/**
 * Monthly bills by company. Read with BILLING_READ; a super admin
 * (BILLING_MANAGE) also generates them.
 */
export default function AdminBilling() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('BILLING_MANAGE');
  const [month, setMonth] = useState(THIS_MONTH);
  const [company, setCompany] = useState<string>(ALL);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);

  const { data: companies, isLoading: companiesLoading } = useListCompanies();

  const params: ListBillingRunsParams = { month };
  if (company !== ALL) params.company = company;
  const { data, isLoading, error } = useListBillingRuns(params, {
    query: { queryKey: getListBillingRunsQueryKey(params) },
  });

  // Superseded runs are hidden unless asked for by status, so they are a second
  // list. It is always read — it tells a recalculated draft from a first one —
  // but shown only when the switch is on.
  const supersededParams: ListBillingRunsParams = { ...params, status: BillingRunSummaryStatus.SUPERSEDED };
  const superseded = useListBillingRuns(supersededParams, {
    query: { queryKey: getListBillingRunsQueryKey(supersededParams) },
  });

  const runs = sortRuns([...(data?.runs ?? []), ...(showSuperseded ? superseded.data?.runs ?? [] : [])]);
  const history = runHistory([...(data?.runs ?? []), ...(superseded.data?.runs ?? [])]);
  const now = useNow();
  const loading = isLoading || (showSuperseded && superseded.isLoading);
  const loadError = error ?? (showSuperseded ? superseded.error : null);
  const withIssues = runs.filter((r) => r.status === BillingRunSummaryStatus.DRAFT && r.issueCount > 0).length;
  const columnCount = 10;

  return (
    <div>
      <PageHeader
        title="Billing"
        description={
          canManage
            ? 'Monthly bills per company, priced from each member’s class and tier'
            : 'Monthly bills for your companies. Read-only.'
        }
        action={
          canManage ? (
            <Button size="sm" onClick={() => setGenerateOpen(true)} data-testid="button-generate-bills">
              <Play className="mr-2 h-4 w-4" />
              Generate
            </Button>
          ) : undefined
        }
      />

      <Alert className="mb-6">
        <Info className="h-4 w-4" />
        <AlertDescription>
          Each bill is priced from every member’s class and number of active dependants at 00:00 on the 1st of the
          month (Guyana time). Changes recorded after that count from the next month’s bill.
        </AlertDescription>
      </Alert>

      <Card className="mb-6">
        <CardContent className="flex flex-col gap-4 pt-6 md:flex-row md:items-end">
          <div>
            <Label className="mb-1.5 block">Month</Label>
            <MonthSelect value={month} onChange={setMonth} testId="select-billing-month" />
          </div>
          <div>
            <Label className="mb-1.5 block">Company</Label>
            <CompanyFilter
              value={company}
              onChange={setCompany}
              companies={companies}
              loading={companiesLoading}
              allLabel="All companies"
              testId="select-billing-run-company"
            />
          </div>
          <div className="flex items-center gap-2 md:ml-auto md:pb-2">
            <Switch
              id="show-superseded"
              checked={showSuperseded}
              onCheckedChange={setShowSuperseded}
              data-testid="switch-show-superseded"
            />
            <Label htmlFor="show-superseded" className="text-sm font-normal">
              Show earlier calculations
            </Label>
          </div>
        </CardContent>
      </Card>

      {withIssues > 0 && (
        <Alert variant="destructive" className="mb-6" data-testid="alert-billing-issues">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {withIssues} draft{withIssues === 1 ? ' has' : 's have'} unpriced members and cannot be finalised until
            the missing rates are added and the bill is recalculated.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {describeError(loadError, 'Unable to load billing runs.', BILLING_ERROR_TITLES).message}
                </AlertDescription>
              </Alert>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Issues</TableHead>
                  <TableHead className="text-right">Total (GYD)</TableHead>
                  <TableHead className="text-right">Company (GYD)</TableHead>
                  <TableHead className="text-right">Employee (GYD)</TableHead>
                  <TableHead>Generated</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  [...Array(4)].map((_, i) => (
                    <TableRow key={i}>
                      {[...Array(columnCount)].map((_, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-16" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : runs.length > 0 ? (
                  runs.map((r) => {
                    const stale = r.status === BillingRunSummaryStatus.SUPERSEDED;
                    return (
                      <TableRow
                        key={r.billingRunId}
                        className={stale ? 'text-muted-foreground' : undefined}
                        data-testid={`row-billing-run-${r.billingRunId}`}
                      >
                        <TableCell>
                          <div className="text-sm font-medium">{companyLabel(companies, r.companyNumber, r.companyName)}</div>
                          <div className="mono-id text-xs text-muted-foreground">{r.companyNumber}</div>
                        </TableCell>
                        <TableCell>
                          <BillingStatusPill status={r.status} replacement={history.replacedBy.get(r.billingRunId)} />
                          <DraftAge run={r} recalculated={history.recalculated.has(r.billingRunId)} now={now} />
                        </TableCell>
                        <TableCell className="tnum text-right">{r.lineCount}</TableCell>
                        <TableCell className="tnum text-right">
                          {r.issueCount > 0 ? (
                            <StatusPill tone="error" icon={AlertTriangle}>
                              {r.issueCount}
                            </StatusPill>
                          ) : (
                            0
                          )}
                        </TableCell>
                        <TableCell className="tnum text-right font-medium">{formatMoney(r.totals.totalPremium)}</TableCell>
                        <TableCell className="tnum text-right">{formatMoney(r.totals.companyPremium)}</TableCell>
                        <TableCell className="tnum text-right">{formatMoney(r.totals.employeePremium)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {formatTimestamp(r.generatedAt)}
                        </TableCell>
                        <TableCell className="max-w-[160px] truncate text-sm" title={r.generatedBy ?? undefined}>
                          {r.generatedBy ?? '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          <Link
                            href={billingRunPath(r.billingRunId)}
                            className="inline-flex items-center whitespace-nowrap text-sm font-medium text-foreground hover:underline"
                            data-testid={`link-billing-run-${r.billingRunId}`}
                          >
                            View
                            <ChevronRight className="ml-1 h-4 w-4" />
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={columnCount} className="h-24 text-center text-muted-foreground">
                      No bills for {formatMonth(month)} yet
                      {canManage && ' — use Generate to calculate them'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {generateOpen && (
        <GenerateDialog
          month={month}
          // Offboarded companies are not billed, so they are not offered here.
          initialCompany={companies?.find((c) => c.companyNumber === company)?.active ? company : ALL}
          companies={companies}
          companiesLoading={companiesLoading}
          onGenerated={setMonth}
          onClose={() => setGenerateOpen(false)}
        />
      )}
    </div>
  );
}
