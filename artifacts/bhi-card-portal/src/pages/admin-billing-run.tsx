import { useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import {
  useGetBillingRun,
  getGetBillingRunQueryKey,
  useGenerateBillingRuns,
  useFinaliseBillingRun,
  exportBillingRun,
  BillingIssueReason,
  BillingLineRateSource,
  BillingRunSummaryStatus,
  GenerateBillingItemStatus,
  type BillingRunDetail,
  type BillingRunSummary,
} from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';
import { PageHeader } from '@/components/page-header';
import { StatusPill } from '@/components/screen-ui';
import {
  BILLING_ERROR_TITLES,
  BILLING_HREF,
  BillingStatusPill,
  billingRunPath,
  DraftAge,
  timeAgo,
  useInvalidateBilling,
  useNow,
  useRunHistory,
  type Replacement,
} from '@/components/billing-status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { downloadBlob } from '@/lib/card-render';
import { formatDay, formatMoney, formatMonth, formatTimestamp } from '@/lib/format';
import { describeError, useApiErrorToast } from '@/lib/api-errors';
import { AlertCircle, AlertTriangle, ArrowLeft, Download, Info, Lock, RefreshCw } from 'lucide-react';

// One company's bill for one month (spec FR-024): the totals per class and
// tier, the members that could not be priced, and every priced line. A draft
// can be recalculated or, once nothing is unpriced, finalised by a super admin
// (BILLING_MANAGE). A final run is frozen; a superseded one is kept for the
// record after a recalculation replaced it.

const RATES_HREF = '/admin/rates';

const ISSUE_REASON_LABELS: Record<BillingIssueReason, string> = {
  [BillingIssueReason.NO_RATE]: 'No company or standard rate for this class and tier',
  [BillingIssueReason.CLASS_RETIRED_NO_RATE]: 'Class retired, and no rate for it is in force',
};

const runTitle = (run: BillingRunSummary) => run.companyName ?? run.companyNumber;

function BackLink() {
  return (
    <Link
      href={BILLING_HREF}
      className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      data-testid="link-back"
    >
      <ArrowLeft className="mr-2 h-4 w-4" />
      Back to billing
    </Link>
  );
}

function Figure({ label, value, strong = false }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={`mt-1 truncate ${strong ? 'tnum text-xl font-bold text-foreground' : 'text-sm text-foreground'}`}>
        {value}
      </div>
    </div>
  );
}

// ---- Actions ---------------------------------------------------------------------

/** Freezing a draft needs a reason for the audit trail. */
function FinaliseDialog({ run, onClose }: { run: BillingRunSummary; onClose: () => void }) {
  const { toast } = useToast();
  const apiError = useApiErrorToast(BILLING_ERROR_TITLES);
  const invalidate = useInvalidateBilling();
  const finaliseMutation = useFinaliseBillingRun();
  const [reason, setReason] = useState('');

  const submit = () => {
    finaliseMutation.mutate(
      { runId: run.billingRunId, data: { reason: reason.trim() } },
      {
        onSuccess: () => {
          invalidate(run.billingRunId);
          toast({
            title: 'Bill finalised',
            description: `${runTitle(run)} · ${formatMonth(run.billingMonth)}`,
          });
          onClose();
        },
        onError: (e: any) => {
          // The run may have changed under us (recalculated or finalised elsewhere).
          invalidate(run.billingRunId);
          apiError(e, 'Unable to finalise the bill');
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Finalise {runTitle(run)} — {formatMonth(run.billingMonth)}
          </DialogTitle>
          <DialogDescription>
            A final bill is frozen: it can no longer be recalculated, and generating this month again leaves it
            unchanged. Total GYD {formatMoney(run.totals.totalPremium)} across {run.lineCount} line
            {run.lineCount === 1 ? '' : 's'}.
          </DialogDescription>
        </DialogHeader>
        <div>
          <div className="mb-1 text-xs font-semibold">Reason (required, min 3 characters)</div>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-testid="textarea-finalise-reason"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={reason.trim().length < 3 || finaliseMutation.isPending}
            data-testid="button-confirm-finalise"
          >
            {finaliseMutation.isPending ? 'Finalising…' : 'Finalise bill'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Recalculating replaces this draft with a new one; the old draft is kept as superseded ("Replaced"). */
function RecalculateDialog({ run, onClose }: { run: BillingRunSummary; onClose: () => void }) {
  const { toast } = useToast();
  const apiError = useApiErrorToast(BILLING_ERROR_TITLES);
  const invalidate = useInvalidateBilling();
  const [, setLocation] = useLocation();
  const generateMutation = useGenerateBillingRuns();

  const submit = () => {
    generateMutation.mutate(
      { data: { month: run.billingMonth, companies: [run.companyNumber] } },
      {
        onSuccess: (data) => {
          invalidate(run.billingRunId);
          const item = data.results.find((r) => r.companyNumber === run.companyNumber) ?? data.results[0];
          if (item?.status === GenerateBillingItemStatus.DRAFT && item.runId !== null) {
            toast({
              title: 'Bill recalculated',
              description: `${item.lines ?? 0} line${item.lines === 1 ? '' : 's'}, ${item.issues ?? 0} unpriced · total GYD ${formatMoney(
                item.totals?.totalPremium,
              )}`,
            });
            onClose();
            if (item.runId !== run.billingRunId) setLocation(billingRunPath(item.runId));
          } else {
            toast({
              title: item?.status === GenerateBillingItemStatus.ALREADY_FINAL ? 'Bill is already final' : 'Recalculation failed',
              description: item?.message ?? 'The bill was not recalculated.',
              variant: 'destructive',
            });
            onClose();
          }
        },
        onError: (e: any) => apiError(e, 'Unable to recalculate the bill'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Recalculate {runTitle(run)} — {formatMonth(run.billingMonth)}
          </DialogTitle>
          <DialogDescription>
            Prices every member again from their class and active dependants at 00:00 on the 1st, using the rates in
            force now. A new draft replaces this one, which is kept as an earlier calculation.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={generateMutation.isPending} data-testid="button-confirm-recalculate">
            {generateMutation.isPending ? 'Recalculating…' : 'Recalculate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useExportCsv(run: BillingRunSummary | undefined) {
  const apiError = useApiErrorToast(BILLING_ERROR_TITLES);
  const [pending, setPending] = useState(false);

  const exportCsv = async () => {
    if (!run) return;
    setPending(true);
    try {
      // Through the API client so the Authorization header goes with it; a
      // plain link to the URL would be sent without the bearer token.
      const body: unknown = await exportBillingRun(run.billingRunId, { responseType: 'blob' });
      const blob =
        body instanceof Blob ? body : new Blob([typeof body === 'string' ? body : ''], { type: 'text/csv;charset=utf-8' });
      downloadBlob(blob, `billing-${run.companyNumber}-${run.billingMonth}-run${run.billingRunId}.csv`);
    } catch (e: any) {
      apiError(e, 'Unable to export the bill');
    } finally {
      setPending(false);
    }
  };

  return { exportCsv, pending };
}

// ---- Sections --------------------------------------------------------------------

function SummaryCard({
  run,
  replacement,
  recalculated,
  now,
}: {
  run: BillingRunSummary;
  replacement?: Replacement;
  recalculated: boolean;
  now: number;
}) {
  return (
    <Card>
      <CardContent className="grid gap-5 pt-6 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="Status"
          value={
            <>
              <BillingStatusPill status={run.status} replacement={replacement} />
              <DraftAge run={run} recalculated={recalculated} now={now} />
            </>
          }
        />
        <Figure label="Billing month" value={formatMonth(run.billingMonth)} />
        <Figure label="Billing date" value={formatDay(run.billingDate)} />
        <Figure
          label="Generated"
          value={
            <span title={run.generatedBy ?? undefined}>
              {formatTimestamp(run.generatedAt)}
              {run.generatedBy && <span className="text-muted-foreground"> · {run.generatedBy}</span>}
            </span>
          }
        />
        <Figure label="Total (GYD)" value={formatMoney(run.totals.totalPremium)} strong />
        <Figure label="Company (GYD)" value={formatMoney(run.totals.companyPremium)} strong />
        <Figure label="Employee (GYD)" value={formatMoney(run.totals.employeePremium)} strong />
        <Figure
          label="Lines · unpriced"
          value={
            <span className="tnum">
              {run.lineCount} ·{' '}
              <span className={run.issueCount > 0 ? 'font-semibold text-error' : undefined}>{run.issueCount}</span>
            </span>
          }
        />
      </CardContent>
    </Card>
  );
}

function ClassTierTotals({ detail }: { detail: BillingRunDetail }) {
  const rows = [...detail.totalsByClassTier].sort(
    (a, b) => a.classCode.localeCompare(b.classCode) || a.dependentBand - b.dependentBand,
  );
  const headcount = rows.reduce((n, r) => n + r.headcount, 0);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Totals by class and tier</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Class</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead className="text-right">Headcount</TableHead>
              <TableHead className="text-right">Total (GYD)</TableHead>
              <TableHead className="text-right">Company (GYD)</TableHead>
              <TableHead className="text-right">Employee (GYD)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length > 0 ? (
              rows.map((r) => (
                <TableRow key={`${r.classCode}-${r.dependentBand}`} data-testid={`row-class-tier-${r.classCode}-${r.dependentBand}`}>
                  <TableCell className="mono-id font-medium">{r.classCode}</TableCell>
                  <TableCell>
                    <div className="text-sm">{r.coverageLabel}</div>
                    <div className="mono-id text-xs text-muted-foreground">{r.coverageBand}</div>
                  </TableCell>
                  <TableCell className="tnum text-right">{r.headcount}</TableCell>
                  <TableCell className="tnum text-right font-medium">{formatMoney(r.totalPremium)}</TableCell>
                  <TableCell className="tnum text-right">{formatMoney(r.companyPremium)}</TableCell>
                  <TableCell className="tnum text-right">{formatMoney(r.employeePremium)}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="h-20 text-center text-muted-foreground">
                  No priced members
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          {rows.length > 0 && (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2} className="font-semibold">
                  Total
                </TableCell>
                <TableCell className="tnum text-right font-semibold">{headcount}</TableCell>
                <TableCell className="tnum text-right font-semibold">{formatMoney(detail.run.totals.totalPremium)}</TableCell>
                <TableCell className="tnum text-right font-semibold">{formatMoney(detail.run.totals.companyPremium)}</TableCell>
                <TableCell className="tnum text-right font-semibold">{formatMoney(detail.run.totals.employeePremium)}</TableCell>
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </CardContent>
    </Card>
  );
}

function IssuesCard({ detail, canManage }: { detail: BillingRunDetail; canManage: boolean }) {
  const { issues, run } = detail;
  const isDraft = run.status === BillingRunSummaryStatus.DRAFT;
  return (
    <Card className="border-destructive/35" data-testid="card-billing-issues">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-error" />
          {issues.length} unpriced member{issues.length === 1 ? '' : 's'}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          These members have no rate for their class and tier on the billing date, so they are not on the bill and it
          cannot be finalised. Add the missing rate on the{' '}
          <Link href={RATES_HREF} className="font-medium text-foreground underline" data-testid="link-issues-rates">
            Rates page
          </Link>
          {isDraft ? (canManage ? ', then recalculate this bill.' : ', then ask a super admin to recalculate this bill.') : '.'}
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {issues.map((issue) => (
              <TableRow key={issue.memberId} data-testid={`row-billing-issue-${issue.memberId}`}>
                <TableCell className="text-sm">{issue.memberName ?? '—'}</TableCell>
                <TableCell className="mono-id text-sm">{issue.idNumber ?? '—'}</TableCell>
                <TableCell className="mono-id">{issue.classCode ?? '—'}</TableCell>
                <TableCell className="text-sm text-error">{ISSUE_REASON_LABELS[issue.reason] ?? issue.reason}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function LinesCard({ detail }: { detail: BillingRunDetail }) {
  const lines = [...detail.lines].sort((a, b) => a.memberName.localeCompare(b.memberName));
  const columnCount = 10;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Lines <span className="font-normal text-muted-foreground">({lines.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Class</TableHead>
              <TableHead className="text-right">Dependants</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead className="text-right">Total (GYD)</TableHead>
              <TableHead className="text-right">Company (GYD)</TableHead>
              <TableHead className="text-right">Employee (GYD)</TableHead>
              <TableHead>Rate effective</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.length > 0 ? (
              lines.map((l) => (
                <TableRow key={l.billingLineId} data-testid={`row-billing-line-${l.billingLineId}`}>
                  <TableCell className="text-sm">{l.memberName}</TableCell>
                  <TableCell className="text-sm">
                    <div className="mono-id">{l.idNumber}</div>
                    <div className="text-xs text-muted-foreground">{l.idType}</div>
                  </TableCell>
                  <TableCell className="mono-id">{l.classCode}</TableCell>
                  <TableCell className="tnum text-right">{l.activeDependentCount}</TableCell>
                  <TableCell>
                    <div className="whitespace-nowrap text-sm">{l.coverageLabel}</div>
                    <div className="mono-id text-xs text-muted-foreground">{l.coverageBand}</div>
                  </TableCell>
                  <TableCell className="tnum text-right font-medium">{formatMoney(l.totalPremium)}</TableCell>
                  <TableCell className="tnum text-right">{formatMoney(l.companyPremium)}</TableCell>
                  <TableCell className="tnum text-right">{formatMoney(l.employeePremium)}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{formatDay(l.rateEffectiveDate)}</TableCell>
                  <TableCell>
                    {l.rateSource === BillingLineRateSource.COMPANY ? (
                      <StatusPill tone="brand">Company</StatusPill>
                    ) : (
                      <StatusPill tone="neutral">Standard</StatusPill>
                    )}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columnCount} className="h-20 text-center text-muted-foreground">
                  No priced members on this bill
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ---- Page ------------------------------------------------------------------------

/**
 * One billing run. Read with BILLING_READ; a super admin (BILLING_MANAGE) also
 * recalculates and finalises a draft.
 */
export default function AdminBillingRun() {
  const params = useParams<{ runId: string }>();
  const runId = Number(params.runId);
  const validId = Number.isInteger(runId) && runId > 0;
  const { hasPermission } = useAuth();
  const canManage = hasPermission('BILLING_MANAGE');
  const [finaliseOpen, setFinaliseOpen] = useState(false);
  const [recalculateOpen, setRecalculateOpen] = useState(false);

  const { data, isLoading, error } = useGetBillingRun(runId, {
    query: { enabled: validId, queryKey: getGetBillingRunQueryKey(runId) },
  });
  const run = data?.run;
  const { exportCsv, pending: exporting } = useExportCsv(run);
  const { replacement, recalculated } = useRunHistory(run);
  const now = useNow();

  if (validId && isLoading) {
    return (
      <div>
        <BackLink />
        <PageHeader title="Loading…" eyebrow="Billing" />
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      </div>
    );
  }

  if (!validId || error || !data || !run) {
    return (
      <div>
        <BackLink />
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {validId && error
              ? describeError(error, 'Billing run not found or you do not have access.', BILLING_ERROR_TITLES).message
              : 'Billing run not found or you do not have access.'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const isDraft = run.status === BillingRunSummaryStatus.DRAFT;
  const canFinalise = isDraft && run.issueCount === 0;
  const finaliseHint = !isDraft
    ? 'Only a draft can be finalised.'
    : run.issueCount > 0
      ? 'Price every member before finalising.'
      : undefined;

  return (
    <div>
      <BackLink />

      <PageHeader
        eyebrow="Billing"
        title={runTitle(run)}
        description={`${run.companyNumber} · ${formatMonth(run.billingMonth)} · billing date ${formatDay(run.billingDate)} · run #${run.billingRunId}`}
        action={
          <>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting} data-testid="button-export-csv">
              <Download className="mr-2 h-4 w-4" />
              {exporting ? 'Exporting…' : 'Export CSV'}
            </Button>
            {canManage && isDraft && (
              <Button variant="outline" size="sm" onClick={() => setRecalculateOpen(true)} data-testid="button-recalculate">
                <RefreshCw className="mr-2 h-4 w-4" />
                Recalculate
              </Button>
            )}
            {canManage && (
              <Button
                size="sm"
                onClick={() => setFinaliseOpen(true)}
                disabled={!canFinalise}
                title={finaliseHint}
                data-testid="button-finalise"
              >
                <Lock className="mr-2 h-4 w-4" />
                Finalise
              </Button>
            )}
          </>
        }
      />

      <div className="space-y-6">
        {run.status === BillingRunSummaryStatus.SUPERSEDED && (
          <Alert data-testid="alert-run-superseded">
            <Info className="h-4 w-4" />
            <AlertTitle>Replaced — an old version</AlertTitle>
            <AlertDescription>
              This is an earlier calculation of the bill, kept for the record.{' '}
              {replacement ? (
                <>
                  It was replaced by{' '}
                  <Link href={billingRunPath(replacement.byRunId)} className="font-medium text-foreground underline">
                    run #{replacement.byRunId}
                  </Link>
                  {replacement.at ? ` ${timeAgo(replacement.at, now)} (${formatTimestamp(replacement.at)})` : ''}. The current
                  bill for{' '}
                </>
              ) : (
                'The current bill for '
              )}
              {formatMonth(run.billingMonth)} is on the{' '}
              <Link href={BILLING_HREF} className="font-medium text-foreground underline">
                Billing page
              </Link>
              .
            </AlertDescription>
          </Alert>
        )}
        {run.status === BillingRunSummaryStatus.FINAL && (
          <Alert data-testid="alert-run-final">
            <Lock className="h-4 w-4" />
            <AlertDescription>This bill is final and frozen. Generating the month again leaves it unchanged.</AlertDescription>
          </Alert>
        )}
        {canManage && isDraft && run.issueCount > 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-finalise-blocked">
            Finalise is unavailable while {run.issueCount} member{run.issueCount === 1 ? ' is' : 's are'} unpriced.
          </p>
        )}

        <SummaryCard run={run} replacement={replacement} recalculated={recalculated} now={now} />
        {data.issues.length > 0 && <IssuesCard detail={data} canManage={canManage} />}
        <ClassTierTotals detail={data} />
        <LinesCard detail={data} />
      </div>

      {finaliseOpen && <FinaliseDialog run={run} onClose={() => setFinaliseOpen(false)} />}
      {recalculateOpen && <RecalculateDialog run={run} onClose={() => setRecalculateOpen(false)} />}
    </div>
  );
}
