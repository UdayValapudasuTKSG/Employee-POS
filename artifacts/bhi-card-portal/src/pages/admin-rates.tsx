import { useState } from 'react';
import { Link, useSearch } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListCompanies,
  useListClasses,
  getListClassesQueryKey,
  useGetRateCard,
  getGetRateCardQueryKey,
  useGetRateHistory,
  getGetRateHistoryQueryKey,
  useCreateRateSet,
  useUpdateRate,
  useListBillingRules,
  getListBillingRulesQueryKey,
  useCreateBillingRule,
  ResolvedTierSource,
  type ClassItem,
  type Company,
  type GetRateCardParams,
  type GetRateHistoryParams,
  type PremiumRate,
  type RateCardClass,
  type ResolvedTier,
} from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';
import { PageHeader } from '@/components/page-header';
import { EmptyState, StatTile, StatusPill, type PillTone } from '@/components/screen-ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { TODAY } from '@/lib/dates';
import { MONEY, formatDay, formatMoney, formatTimestamp } from '@/lib/format';
import { describeError, useApiErrorToast, type DescribedError } from '@/lib/api-errors';
import {
  AlertCircle,
  AlertTriangle,
  BadgeDollarSign,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  Circle,
  History,
  Info,
  Layers,
  Plus,
  Receipt,
} from 'lucide-react';

// The premium rate card (spec FR-022, FR-023). Every class has four tiers set by
// how many active dependants a member has; every dependant costs the same and
// more than two is one flat tier. A company's own rate overrides the standard
// card for that company from its effective date. Amounts are never edited: a
// price changes by adding a new rate set with a later effective date, and a row
// can only be deactivated, reactivated or annotated.
//
// Any admin reads the rate card for the companies in their scope. Only a super
// admin (RATE_MANAGE) sees the standard card picker, the history and adds rate
// sets. Billing rules are read with RATE_MANAGE or BILLING_READ.

const STANDARD = '__STANDARD__';
const ALL = '__ALL__';
const CLASSES_HREF = '/admin/classes';

/** The four tiers, in dependentBand order. */
const TIERS = [
  { dependentBand: 0, code: 'EMP_ONLY', label: 'Employee only' },
  { dependentBand: 1, code: 'EMP_PLUS_1', label: 'Employee + 1 dependent' },
  { dependentBand: 2, code: 'EMP_PLUS_2', label: 'Employee + 2 dependents' },
  { dependentBand: 3, code: 'EMP_PLUS_3PLUS', label: 'Employee + 3 or more dependents' },
] as const;

type TabValue = 'card' | 'history' | 'add' | 'billing';

/** Titles for the refusals this page can meet; the server's message is the description. */
const ERROR_TITLES: Record<string, string> = {
  RATE_EXISTS: 'A rate set already exists',
  RULE_EXISTS: 'A billing rule already exists',
  UNKNOWN_COMPANY: 'Unknown company',
  INVALID_INPUT: 'Check the details',
  NOT_FOUND: 'Not found',
};

// ---- Amounts and dates -------------------------------------------------------
// Display formatting (money, days, timestamps) lives in @/lib/format.

/**
 * An amount as integer cents, or null when it is not one. Same rule as the
 * server (at most two decimals, never negative); thousands separators typed
 * by habit are dropped.
 */
function toCents(value: string): number | null {
  const s = value.trim().replace(/,/g, '');
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

const centsToAmount = (cents: number) => (cents / 100).toFixed(2);

const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

// ---- Shared pieces -------------------------------------------------------------

function useInvalidateRates() {
  const queryClient = useQueryClient();
  return () => {
    // No params: each prefix-matches every cached variant.
    queryClient.invalidateQueries({ queryKey: getGetRateCardQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetRateHistoryQueryKey() });
    // A class is "Rates complete" once its four standard tiers are priced.
    queryClient.invalidateQueries({ queryKey: getListClassesQueryKey() });
  };
}

function companyLabel(companies: Company[] | undefined, companyNumber: string | null): string {
  if (companyNumber === null) return 'Standard card';
  return companies?.find((c) => c.companyNumber === companyNumber)?.companyName ?? companyNumber;
}

function CompanySelect({
  value,
  onChange,
  companies,
  loading,
  includeStandard = false,
  includeAll = false,
  placeholder = 'Choose a company',
  className = 'w-full md:w-72',
  testId,
}: {
  value: string | null;
  onChange: (value: string) => void;
  companies: Company[] | undefined;
  loading: boolean;
  includeStandard?: boolean;
  includeAll?: boolean;
  placeholder?: string;
  className?: string;
  testId: string;
}) {
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger className={className} data-testid={testId}>
        <SelectValue placeholder={loading ? 'Loading companies…' : placeholder} />
      </SelectTrigger>
      <SelectContent>
        {includeAll && <SelectItem value={ALL}>All cards</SelectItem>}
        {includeStandard && <SelectItem value={STANDARD}>Standard card</SelectItem>}
        {companies?.map((company) => (
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

function ClassSelect({
  value,
  onChange,
  classes,
  includeAll = false,
  className = 'w-full md:w-64',
  testId,
}: {
  value: string | null;
  onChange: (value: string) => void;
  classes: ClassItem[] | undefined;
  includeAll?: boolean;
  className?: string;
  testId: string;
}) {
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger className={className} data-testid={testId}>
        <SelectValue placeholder={classes ? 'Choose a class' : 'Loading classes…'} />
      </SelectTrigger>
      <SelectContent>
        {includeAll && <SelectItem value={ALL}>All classes</SelectItem>}
        {classes?.map((c) => (
          <SelectItem key={c.classCode} value={c.classCode}>
            <span className="mono-id mr-2">{c.classCode}</span>
            {c.className}
            {!c.active && <span className="ml-2 text-xs text-muted-foreground">(retired)</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const SOURCE_PILL: Record<ResolvedTierSource, { tone: PillTone; label: string }> = {
  [ResolvedTierSource.COMPANY]: { tone: 'brand', label: 'Company' },
  [ResolvedTierSource.STANDARD]: { tone: 'neutral', label: 'Standard' },
  [ResolvedTierSource.NONE]: { tone: 'error', label: 'None' },
};

function SourcePill({ source }: { source: ResolvedTierSource }) {
  const pill = SOURCE_PILL[source];
  return (
    <StatusPill tone={pill.tone} icon={source === ResolvedTierSource.NONE ? AlertTriangle : undefined}>
      {pill.label}
    </StatusPill>
  );
}

// ---- Rate card -------------------------------------------------------------------

/** Filter bar shared by the tabs: controls on the left, a line of help on the right. */
function Toolbar({ children, help }: { children: React.ReactNode; help?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-[var(--surface-border)] bg-card p-5 shadow-[var(--shadow-sm)] lg:flex-row lg:items-end">
      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">{children}</div>
      {help && (
        <p className="flex items-start gap-2 text-[14.5px] leading-relaxed text-[var(--fg-3)] lg:ml-auto lg:max-w-md">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--brand-600)]" />
          <span>{help}</span>
        </p>
      )}
    </div>
  );
}

/** Company and employee shares of one tier, as a two-part bar with a legend. */
function SplitBar({ company, employee }: { company: string | null; employee: string | null }) {
  const c = Number(company ?? 0);
  const e = Number(employee ?? 0);
  const total = c + e;
  const companyPct = total > 0 ? Math.round((c / total) * 100) : 0;
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-[var(--surface-4)]" role="presentation">
        <div className="h-full bg-[var(--brand-600)]" style={{ width: `${companyPct}%` }} />
        <div className="h-full bg-[var(--gold-500)]" style={{ width: `${total > 0 ? 100 - companyPct : 0}%` }} />
      </div>
      <dl className="mt-2.5 space-y-1 text-[14px]">
        <div className="flex items-center justify-between gap-2">
          <dt className="flex items-center gap-2 text-[var(--fg-3)]">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--brand-600)]" />
            Company
          </dt>
          <dd className="tnum font-semibold text-[var(--fg-1)]">{formatMoney(company)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="flex items-center gap-2 text-[var(--fg-3)]">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--gold-500)]" />
            Employee
          </dt>
          <dd className="tnum font-semibold text-[var(--fg-1)]">{formatMoney(employee)}</dd>
        </div>
      </dl>
    </div>
  );
}

function TierTile({ tier, classCode }: { tier: ResolvedTier; classCode: string }) {
  const none = tier.source === ResolvedTierSource.NONE;
  return (
    <div
      className={`flex min-w-0 flex-col rounded-xl border p-4 ${
        none
          ? 'border-dashed border-[#f5c2c2] bg-[var(--status-error-bg)]/60'
          : 'border-[var(--surface-border)] bg-white transition-[border-color,box-shadow] hover:border-[var(--brand-200)] hover:shadow-[var(--shadow-sm)]'
      }`}
      data-testid={`row-rate-${classCode}-${tier.dependentBand}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[15.5px] font-bold leading-snug text-[var(--fg-1)]">{tier.coverageLabel}</div>
          <div className="mono-id text-[12.5px] font-semibold text-[var(--fg-4)]">{tier.coverageBand}</div>
        </div>
        <SourcePill source={tier.source} />
      </div>
      {none ? (
        <p className="mt-4 text-[14.5px] font-semibold leading-snug text-error">
          Missing — no company or standard rate is in force on this date
        </p>
      ) : (
        <>
          <div className="mt-4 text-[11.5px] font-bold uppercase tracking-[0.08em] text-[var(--fg-4)]">Total premium</div>
          <div className="tnum mt-0.5 flex items-baseline gap-1.5 text-[26px] font-bold leading-none text-[var(--fg-1)]">
            <span className="text-[13px] font-bold text-[var(--fg-4)]">GYD</span>
            {formatMoney(tier.totalPremium)}
          </div>
          <div className="mt-4">
            <SplitBar company={tier.companyPremium} employee={tier.employeePremium} />
          </div>
          <div className="mt-3 flex items-center gap-1.5 border-t border-[var(--surface-hairline)] pt-2.5 text-[13.5px] text-[var(--fg-3)]">
            <CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />
            Effective {formatDay(tier.effectiveDate)}
          </div>
        </>
      )}
    </div>
  );
}

function RateCardClassTable({ cls }: { cls: RateCardClass }) {
  const missing = cls.tiers.filter((t) => t.source === ResolvedTierSource.NONE).length;
  const tiers = [...cls.tiers].sort((a, b) => a.dependentBand - b.dependentBand);
  return (
    <section
      className={`overflow-hidden rounded-2xl border bg-card shadow-[var(--shadow-sm)] ${
        missing > 0 ? 'border-[#f5c2c2]' : 'border-[var(--surface-border)]'
      }`}
      data-testid={`card-rate-class-${cls.classCode}`}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-[var(--surface-hairline)] px-5 py-4">
        <span className="mono-id rounded-lg bg-[var(--brand-50)] px-2.5 py-1 text-[14px] font-bold text-[var(--brand-700)]">
          {cls.classCode}
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[18.5px] font-bold text-[var(--fg-1)]">{cls.className}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {!cls.active && <StatusPill tone="neutral">Retired</StatusPill>}
          {missing > 0 ? (
            <StatusPill tone="error" icon={AlertTriangle}>
              {missing} tier{missing === 1 ? '' : 's'} missing
            </StatusPill>
          ) : (
            <StatusPill tone="success">All tiers priced</StatusPill>
          )}
        </div>
      </header>
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        {tiers.map((t) => (
          <TierTile key={t.dependentBand} tier={t} classCode={cls.classCode} />
        ))}
      </div>
    </section>
  );
}

/** Loading shape of the rate card: summary tiles, then class cards of four tier tiles. */
function RateCardSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading rate card">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-2xl border border-[var(--surface-border)] bg-card p-5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="mt-3 h-8 w-16" />
            <Skeleton className="mt-3 h-3.5 w-32" />
          </div>
        ))}
      </div>
      {[...Array(2)].map((_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-card">
          <div className="flex items-center gap-3 border-b border-[var(--surface-hairline)] px-5 py-4">
            <Skeleton className="h-7 w-16 rounded-lg" />
            <Skeleton className="h-5 w-48" />
            <Skeleton className="ml-auto h-6 w-28 rounded-full" />
          </div>
          <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
            {[...Array(4)].map((_, j) => (
              <div key={j} className="rounded-xl border border-[var(--surface-border)] p-4">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="mt-1.5 h-3 w-1/3" />
                <Skeleton className="mt-5 h-3 w-20" />
                <Skeleton className="mt-2 h-7 w-32" />
                <Skeleton className="mt-4 h-2 w-full rounded-full" />
                <Skeleton className="mt-3 h-3.5 w-full" />
                <Skeleton className="mt-1.5 h-3.5 w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function RateCardTab({
  companies,
  companiesLoading,
  canManage,
}: {
  companies: Company[] | undefined;
  companiesLoading: boolean;
  canManage: boolean;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [asOf, setAsOf] = useState(TODAY);

  // A super admin starts on the standard card; everyone else on their first
  // (for most, their only) company.
  const selected = picked ?? (canManage ? STANDARD : companies?.[0]?.companyNumber ?? null);

  const params: GetRateCardParams = {};
  if (selected && selected !== STANDARD) params.company = selected;
  if (isDay(asOf)) params.asOf = asOf;

  const { data, isLoading, error } = useGetRateCard(params, {
    query: { enabled: selected !== null, queryKey: getGetRateCardQueryKey(params) },
  });

  const activeClasses = data?.classes.filter((c) => c.active) ?? [];
  const activeTiers = activeClasses.flatMap((c) => c.tiers);
  const missing = data
    ? activeTiers.filter((t) => t.source === ResolvedTierSource.NONE).length
    : undefined;
  const companyOverrides = activeTiers.filter((t) => t.source === ResolvedTierSource.COMPANY).length;

  return (
    <div className="space-y-5">
      <Toolbar
        help={
          selected === STANDARD
            ? 'The standard card applies to every company that has no rate of its own for a tier.'
            : "A company's own rate overrides the standard card for that tier; otherwise the standard rate applies."
        }
      >
        <div>
          <Label className="mb-2 block">Card</Label>
          <CompanySelect
            value={selected}
            onChange={setPicked}
            companies={companies}
            loading={companiesLoading}
            includeStandard={canManage}
            testId="select-rate-card-company"
          />
        </div>
        <div>
          <Label htmlFor="rate-card-as-of" className="mb-2 block">
            As of
          </Label>
          <Input
            id="rate-card-as-of"
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="w-48"
            data-testid="input-rate-card-as-of"
          />
        </div>
      </Toolbar>

      {selected === null ? (
        <EmptyState
          icon={BadgeDollarSign}
          title={companiesLoading ? 'Loading companies…' : 'Choose a company'}
          body="Pick a card above to see its premium for every class and tier."
        />
      ) : error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{describeError(error, 'Unable to load the rate card.', ERROR_TITLES).message}</AlertDescription>
        </Alert>
      ) : isLoading || !data ? (
        <RateCardSkeleton />
      ) : data.classes.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No classes yet"
          body="Rates are set per class. Create a class first, then price its four tiers."
          action={
            <Link href={CLASSES_HREF}>
              <Button variant="outline">Go to classes</Button>
            </Link>
          }
        />
      ) : (
        <>
          <div className="ds-stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Active classes"
              value={activeClasses.length}
              icon={Layers}
              accent="brand"
              footnote={`${data.classes.length - activeClasses.length} retired`}
            />
            <StatTile
              label="Tiers priced"
              value={`${activeTiers.length - (missing ?? 0)}/${activeTiers.length}`}
              icon={CheckCircle2}
              accent="success"
              footnote="Across every active class"
            />
            <StatTile
              label="Missing tiers"
              value={missing ?? 0}
              icon={AlertTriangle}
              accent={missing ? 'error' : 'teal'}
              footnote={missing ? 'No rate in force on this date' : 'Nothing missing'}
            />
            <StatTile
              label={selected === STANDARD ? 'Card' : 'Company overrides'}
              value={selected === STANDARD ? 'Standard' : companyOverrides}
              icon={Building2}
              accent="gold"
              footnote={
                selected === STANDARD ? 'The default for every company' : 'Tiers priced by the company itself'
              }
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[15px] text-[var(--fg-3)]" data-testid="text-rate-card-summary">
              <span className="font-bold text-[var(--fg-1)]">{companyLabel(companies, data.companyNumber)}</span> as of{' '}
              {formatDay(data.asOf)}
            </div>
            <div className="flex items-center gap-4 text-[13.5px] text-[var(--fg-3)]">
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--brand-600)]" /> Company share
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--gold-500)]" /> Employee share
              </span>
            </div>
          </div>

          {missing !== undefined && missing > 0 && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {missing} tier{missing === 1 ? ' has' : 's have'} no rate in force on this date for an active class.
                {canManage && ' Add a standard rate set to fill them.'}
              </AlertDescription>
            </Alert>
          )}
          <div className="space-y-4">
            {data.classes.map((cls) => (
              <RateCardClassTable key={cls.classCode} cls={cls} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---- History -----------------------------------------------------------------------

/** Deactivate or reactivate one rate row. Amounts never change. */
function RateStatusDialog({
  rate,
  classes,
  companies,
  onClose,
}: {
  rate: PremiumRate;
  classes: ClassItem[] | undefined;
  companies: Company[] | undefined;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const apiError = useApiErrorToast(ERROR_TITLES);
  const invalidate = useInvalidateRates();
  const updateMutation = useUpdateRate();
  const [reason, setReason] = useState('');
  const deactivating = rate.active;
  const className = classes?.find((c) => c.classCode === rate.classCode)?.className;

  const submit = () => {
    updateMutation.mutate(
      { premiumRateId: rate.premiumRateId, data: { active: !deactivating, reason: reason.trim() } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: deactivating ? 'Rate deactivated' : 'Rate reactivated' });
          onClose();
        },
        onError: (e: any) => apiError(e, deactivating ? 'Unable to deactivate the rate' : 'Unable to reactivate the rate'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{deactivating ? 'Deactivate rate' : 'Reactivate rate'}</DialogTitle>
          <DialogDescription>
            {companyLabel(companies, rate.companyNumber)} · class {rate.classCode}
            {className ? ` (${className})` : ''} · {rate.coverageLabel} · GYD {formatMoney(rate.totalPremium)} from{' '}
            {formatDay(rate.effectiveDate)}.{' '}
            {deactivating
              ? 'An inactive rate no longer counts on the rate card; the latest earlier rate, or the standard card, applies instead.'
              : 'The rate counts on the rate card again from its effective date.'}
          </DialogDescription>
        </DialogHeader>
        <div>
          <div className="mb-1 text-xs font-semibold">Reason (required, min 3 characters)</div>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="textarea-rate-status-reason" />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={deactivating ? 'destructive' : 'default'}
            onClick={submit}
            disabled={reason.trim().length < 3 || updateMutation.isPending}
            data-testid="button-confirm-rate-status"
          >
            {updateMutation.isPending ? 'Saving…' : deactivating ? 'Deactivate rate' : 'Reactivate rate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryTab({
  companies,
  companiesLoading,
  classes,
}: {
  companies: Company[] | undefined;
  companiesLoading: boolean;
  classes: ClassItem[] | undefined;
}) {
  const [classFilter, setClassFilter] = useState<string>(ALL);
  const [companyFilter, setCompanyFilter] = useState<string>(ALL);
  const [target, setTarget] = useState<PremiumRate | null>(null);

  const params: GetRateHistoryParams = {};
  if (classFilter !== ALL) params.classCode = classFilter;
  if (companyFilter === STANDARD) params.company = 'STANDARD';
  else if (companyFilter !== ALL) params.company = companyFilter;

  const { data, isLoading, error } = useGetRateHistory(params, {
    query: { queryKey: getGetRateHistoryQueryKey(params) },
  });
  const rates = data?.rates ?? [];
  const columnCount = 10;

  return (
    <div className="space-y-5">
      <Toolbar help="Every rate row, oldest first. Amounts are never edited; to change a price, add a new rate set with a later effective date.">
          <div>
            <Label className="mb-2 block">Class</Label>
            <ClassSelect value={classFilter} onChange={setClassFilter} classes={classes} includeAll testId="select-history-class" />
          </div>
          <div>
            <Label className="mb-2 block">Card</Label>
            <CompanySelect
              value={companyFilter}
              onChange={setCompanyFilter}
              companies={companies}
              loading={companiesLoading}
              includeAll
              includeStandard
              testId="select-history-company"
            />
          </div>
      </Toolbar>

      <Card>
        <CardContent className="p-0">
          {error ? (
            <div className="p-6">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>Unable to load the rate history.</AlertDescription>
              </Alert>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Effective</TableHead>
                  <TableHead>Card</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Total (GYD)</TableHead>
                  <TableHead className="text-right">Company (GYD)</TableHead>
                  <TableHead className="text-right">Employee (GYD)</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead>Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  [...Array(5)].map((_, i) => (
                    <TableRow key={i}>
                      {[...Array(columnCount)].map((_, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-16" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : rates.length > 0 ? (
                  rates.map((r) => (
                    <TableRow
                      key={r.premiumRateId}
                      className={r.active ? undefined : 'text-muted-foreground'}
                      data-testid={`row-rate-history-${r.premiumRateId}`}
                    >
                      <TableCell className="whitespace-nowrap text-sm">{formatDay(r.effectiveDate)}</TableCell>
                      <TableCell className="text-sm">
                        {r.companyNumber === null ? (
                          <StatusPill tone="neutral">Standard</StatusPill>
                        ) : (
                          <>
                            <div>{companyLabel(companies, r.companyNumber)}</div>
                            <div className="mono-id text-xs text-muted-foreground">{r.companyNumber}</div>
                          </>
                        )}
                      </TableCell>
                      <TableCell className="mono-id">{r.classCode}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{r.coverageLabel}</TableCell>
                      <TableCell className="tnum text-right font-medium">{formatMoney(r.totalPremium)}</TableCell>
                      <TableCell className="tnum text-right">{formatMoney(r.companyPremium)}</TableCell>
                      <TableCell className="tnum text-right">{formatMoney(r.employeePremium)}</TableCell>
                      <TableCell className="max-w-[200px] truncate text-sm" title={r.notes ?? undefined}>
                        {r.notes ?? '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatTimestamp(r.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={r.active}
                          onCheckedChange={() => setTarget(r)}
                          aria-label={r.active ? 'Deactivate rate' : 'Reactivate rate'}
                          data-testid={`switch-rate-active-${r.premiumRateId}`}
                        />
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={columnCount} className="h-24 text-center text-muted-foreground">
                      No rates match these filters
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {target && (
        <RateStatusDialog rate={target} classes={classes} companies={companies} onClose={() => setTarget(null)} />
      )}
    </div>
  );
}

// ---- Add rate set ---------------------------------------------------------------------

// The admin enters the company and employee premiums; the total is their sum,
// so it can never disagree with them.
type TierDraft = { company: string; employee: string };
const EMPTY_TIERS: TierDraft[] = TIERS.map(() => ({ company: '', employee: '' }));

/** The tier's total in cents, once both shares are valid amounts; otherwise null. */
function tierTotal(t: TierDraft): number | null {
  const company = t.company.trim() ? toCents(t.company) : null;
  const employee = t.employee.trim() ? toCents(t.employee) : null;
  return company === null || employee === null ? null : company + employee;
}

/** A tier's live check: whether it is ready to send, and what is wrong if not. */
function checkTier(t: TierDraft): { ready: boolean; problem: string | null } {
  const blank = !t.company.trim() && !t.employee.trim();
  if (blank) return { ready: false, problem: null };
  const company = t.company.trim() ? toCents(t.company) : undefined;
  const employee = t.employee.trim() ? toCents(t.employee) : undefined;
  if (company === null || employee === null) {
    return { ready: false, problem: 'Amounts are numbers of at least zero with at most two decimals.' };
  }
  if (company === undefined || employee === undefined) {
    return { ready: false, problem: 'Enter the company and employee premiums (0 if one pays nothing).' };
  }
  return { ready: true, problem: null };
}

/** A numbered block of the rate set form. */
function RateSection({
  step,
  title,
  sub,
  children,
}: {
  step: number;
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-card shadow-[var(--shadow-sm)]">
      <header className="flex items-center gap-3.5 border-b border-[var(--surface-hairline)] px-6 py-4">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--brand-600)] text-[15px] font-bold text-white shadow-[0_4px_10px_-4px_rgba(1,35,212,0.6)]"
        >
          {step}
        </span>
        <div className="min-w-0">
          <h3 className="text-[18.5px] font-bold leading-tight text-[var(--fg-1)]">{title}</h3>
          {sub && <p className="mt-0.5 text-[14.5px] text-[var(--fg-3)]">{sub}</p>}
        </div>
      </header>
      <div className="px-6 py-5">{children}</div>
    </section>
  );
}

/** Amount input with the currency set inside the well. */
function MoneyInput(props: React.ComponentProps<typeof Input>) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[12.5px] font-bold text-[var(--fg-4)]">
        GYD
      </span>
      <Input {...props} className={`tnum pl-12 text-right ${props.className ?? ''}`} />
    </div>
  );
}

function AddRateSetTab({
  companies,
  companiesLoading,
  classes,
  initialClass,
}: {
  companies: Company[] | undefined;
  companiesLoading: boolean;
  classes: ClassItem[] | undefined;
  initialClass: string | null;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateRates();
  const createMutation = useCreateRateSet();
  const [company, setCompany] = useState<string>(STANDARD);
  const [classCode, setClassCode] = useState<string | null>(initialClass);
  const [effectiveDate, setEffectiveDate] = useState(TODAY);
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [tiers, setTiers] = useState<TierDraft[]>(EMPTY_TIERS);
  const [serverError, setServerError] = useState<DescribedError | null>(null);

  const setTier = (index: number, field: keyof TierDraft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setTiers(tiers.map((t, i) => (i === index ? { ...t, [field]: e.target.value } : t)));

  const checks = tiers.map(checkTier);
  const readyTiers = checks.filter((c) => c.ready).length;
  const valid =
    classCode !== null &&
    isDay(effectiveDate) &&
    checks.every((c) => c.ready) &&
    reason.trim().length >= 3;

  const pickedClass = classes?.find((c) => c.classCode === classCode);

  const readiness = [
    { label: 'Class chosen', done: classCode !== null },
    { label: 'Effective date', done: isDay(effectiveDate) },
    { label: `All four tiers priced (${readyTiers}/4)`, done: readyTiers === TIERS.length },
    { label: 'Reason (3+ characters)', done: reason.trim().length >= 3 },
  ];

  const submit = () => {
    if (!classCode) return;
    setServerError(null);
    createMutation.mutate(
      {
        data: {
          companyNumber: company === STANDARD ? null : company,
          classCode,
          effectiveDate,
          tiers: TIERS.map((tier, i) => ({
            dependentBand: tier.dependentBand,
            totalPremium: centsToAmount(tierTotal(tiers[i]!)!),
            companyPremium: centsToAmount(toCents(tiers[i]!.company)!),
            employeePremium: centsToAmount(toCents(tiers[i]!.employee)!),
          })),
          notes: notes.trim() ? notes.trim() : null,
          reason: reason.trim(),
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({
            title: 'Rate set added',
            description: `${companyLabel(companies, company === STANDARD ? null : company)} · class ${classCode} from ${formatDay(
              effectiveDate,
            )}`,
          });
          setTiers(EMPTY_TIERS);
          setNotes('');
          setReason('');
        },
        onError: (e: any) => setServerError(describeError(e, 'Unable to add the rate set.', ERROR_TITLES)),
      },
    );
  };

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-5">
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            A rate set prices all four tiers of one class from an effective date, on the standard card or for one
            company. Amounts are never edited afterwards: to change a price, add a new rate set with a later date. A
            new class can be given to members once its standard set is priced.
          </AlertDescription>
        </Alert>

        <RateSection step={1} title="Where it applies" sub="The card, the class and the day the prices take effect.">
          <div className="grid gap-x-5 gap-y-4 md:grid-cols-3">
            <div>
              <Label className="mb-2 block">Card</Label>
              <CompanySelect
                value={company}
                onChange={setCompany}
                companies={companies}
                loading={companiesLoading}
                includeStandard
                className="w-full"
                testId="select-add-rate-company"
              />
            </div>
            <div>
              <Label className="mb-2 block">Class</Label>
              <ClassSelect value={classCode} onChange={setClassCode} classes={classes} className="w-full" testId="select-add-rate-class" />
            </div>
            <div>
              <Label htmlFor="add-rate-effective" className="mb-2 block">
                Effective date
              </Label>
              <Input
                id="add-rate-effective"
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
                data-testid="input-add-rate-effective"
              />
            </div>
          </div>
          {pickedClass && !pickedClass.active && (
            <Alert className="mt-4">
              <Info className="h-4 w-4" />
              <AlertDescription>Class {pickedClass.classCode} is retired. Its rates apply only to members who still carry it.</AlertDescription>
            </Alert>
          )}
        </RateSection>

        <RateSection
          step={2}
          title="Tier premiums"
          sub="Enter what the company and the employee each pay. The total is worked out as you type."
        >
          {/* Column heads, shown once above the rows on wide screens. */}
          <div className="mb-2 hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4 px-4 text-[12px] font-bold uppercase tracking-[0.08em] text-[var(--fg-4)] md:grid">
            <span>Tier</span>
            <span>Company pays</span>
            <span>Employee pays</span>
            <span className="text-right">Total</span>
          </div>
          <div className="space-y-2.5">
            {TIERS.map((tier, i) => {
              const check = checks[i]!;
              const total = tierTotal(tiers[i]!);
              return (
                <div
                  key={tier.dependentBand}
                  className={`grid items-center gap-3 rounded-xl border px-4 py-3 transition-colors md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] md:gap-4 ${
                    check.problem
                      ? 'border-[#f5c2c2] bg-[var(--status-error-bg)]/50'
                      : check.ready
                        ? 'border-[#bfe3cb] bg-[var(--status-success-bg)]/50'
                        : 'border-[var(--surface-border)] bg-[var(--surface-2)]'
                  }`}
                  data-testid={`row-add-rate-${tier.dependentBand}`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[14px] font-bold ${
                        check.ready ? 'bg-[var(--status-success)] text-white' : 'bg-white text-[var(--brand-600)] ring-1 ring-inset ring-[var(--surface-border)]'
                      }`}
                    >
                      {check.ready ? <Check className="h-4 w-4" strokeWidth={3} /> : tier.dependentBand === 3 ? '3+' : tier.dependentBand}
                    </span>
                    <div className="min-w-0">
                      <div className="text-[15.5px] font-bold leading-snug text-[var(--fg-1)]">{tier.label}</div>
                      <div className="mono-id text-[12.5px] font-semibold text-[var(--fg-4)]">{tier.code}</div>
                    </div>
                  </div>
                  {(['company', 'employee'] as const).map((field) => (
                    <div key={field}>
                      <span className="mb-1 block text-[12px] font-bold uppercase tracking-[0.08em] text-[var(--fg-4)] md:hidden">
                        {field === 'company' ? 'Company pays' : 'Employee pays'}
                      </span>
                      <MoneyInput
                        inputMode="decimal"
                        value={tiers[i]![field]}
                        onChange={setTier(i, field)}
                        placeholder="0.00"
                        className="bg-white"
                        aria-invalid={check.problem !== null}
                        aria-label={`${tier.label} ${field} premium`}
                        data-testid={`input-add-rate-${tier.dependentBand}-${field}`}
                      />
                    </div>
                  ))}
                  {/* Company + employee, worked out as they are typed. */}
                  <div
                    className={`tnum flex h-11 items-center justify-end gap-1.5 rounded-lg px-3.5 text-[17px] font-bold ${
                      total === null ? 'bg-white text-[var(--fg-4)] ring-1 ring-inset ring-[var(--surface-border)]' : 'bg-[var(--brand-600)] text-white'
                    }`}
                    aria-label={`${tier.label} total premium`}
                    data-testid={`total-add-rate-${tier.dependentBand}`}
                  >
                    {total === null ? (
                      '—'
                    ) : (
                      <>
                        <span className="text-[12px] font-bold opacity-75">GYD</span>
                        {MONEY.format(total / 100)}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {checks.some((c) => c.problem) && (
            <ul
              className="mt-3 space-y-1 rounded-xl border border-[#f5c2c2] bg-error-soft px-4 py-3 text-[14px] font-semibold text-error"
              data-testid="list-add-rate-problems"
            >
              {checks.map((c, i) =>
                c.problem ? (
                  <li key={i}>
                    {TIERS[i]!.label}: {c.problem}
                  </li>
                ) : null,
              )}
            </ul>
          )}
        </RateSection>

        <RateSection step={3} title="Notes and reason" sub="The reason is recorded in the audit trail.">
          <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
            <div>
              <Label htmlFor="add-rate-notes">Notes (optional)</Label>
              <Textarea
                id="add-rate-notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="mt-2"
                placeholder="Shown in the rate history"
                data-testid="textarea-add-rate-notes"
              />
            </div>
            <div>
              <Label htmlFor="add-rate-reason">Reason (required, min 3 characters)</Label>
              <Textarea
                id="add-rate-reason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="mt-2"
                placeholder="Why are these prices changing?"
                data-testid="textarea-add-rate-reason"
              />
            </div>
          </div>
        </RateSection>
      </div>

      {/* Summary rail: what will be saved and whether it can be. */}
      <aside className="min-w-0 space-y-4 xl:sticky xl:top-0">
        <div className="overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-card shadow-[var(--shadow-sm)]">
          <div className="admin-hero rounded-none px-5 py-5 shadow-none">
            <div className="relative z-[1]">
              <div className="text-[12px] font-bold uppercase tracking-[0.12em] text-[#c7d2fe]">Rate set summary</div>
              <div className="mt-1.5 text-[19px] font-bold leading-tight text-white">
                {classCode ? (
                  <>
                    <span className="mono-id">{classCode}</span>
                    {pickedClass ? ` · ${pickedClass.className}` : ''}
                  </>
                ) : (
                  'No class chosen'
                )}
              </div>
              <div className="mt-1 text-[14.5px] text-[#dbe2fe]">
                {companyLabel(companies, company === STANDARD ? null : company)} · from{' '}
                {isDay(effectiveDate) ? formatDay(effectiveDate) : '—'}
              </div>
            </div>
          </div>
          <dl className="divide-y divide-[var(--surface-hairline)] text-[14.5px]">
            {TIERS.map((tier, i) => {
              const total = tierTotal(tiers[i]!);
              return (
                <div key={tier.dependentBand} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <dt className="truncate text-[var(--fg-3)]">{tier.label}</dt>
                  <dd className={`tnum whitespace-nowrap font-bold ${total === null ? 'text-[var(--fg-4)]' : 'text-[var(--fg-1)]'}`}>
                    {total === null ? '—' : MONEY.format(total / 100)}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>

        <div className="rounded-2xl border border-[var(--surface-border)] bg-card p-5 shadow-[var(--shadow-sm)]">
          <div className="text-[16px] font-bold text-[var(--fg-1)]">Ready to add</div>
          <ul className="mt-3 space-y-2">
            {readiness.map((r) => (
              <li key={r.label} className="flex items-center gap-2.5 text-[14.5px]">
                {r.done ? (
                  <CheckCircle2 aria-hidden="true" className="h-[18px] w-[18px] flex-shrink-0 text-[var(--status-success)]" />
                ) : (
                  <Circle aria-hidden="true" className="h-[18px] w-[18px] flex-shrink-0 text-[var(--fg-4)]" />
                )}
                <span className={r.done ? 'text-[var(--fg-2)]' : 'text-[var(--fg-3)]'}>
                  {r.label}
                  <span className="sr-only">{r.done ? ' — done' : ' — missing'}</span>
                </span>
              </li>
            ))}
          </ul>

          {serverError && (
            <Alert variant="destructive" className="mt-4" data-testid="alert-add-rate-error">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{serverError.title}</AlertTitle>
              <AlertDescription>{serverError.message}</AlertDescription>
            </Alert>
          )}

          <Button
            size="lg"
            className="mt-5 w-full"
            onClick={submit}
            disabled={!valid || createMutation.isPending}
            data-testid="button-add-rate-set"
          >
            <Plus className="h-4 w-4" />
            {createMutation.isPending ? 'Adding…' : 'Add rate set'}
          </Button>
        </div>
      </aside>
    </div>
  );
}

// ---- Billing rules -------------------------------------------------------------------

/** A share as hundredths of a percent (0–10000), or null when it is not one. */
function toShareHundredths(value: string): number | null {
  const s = value.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const n = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return n > 10_000 ? null : n;
}

function AddBillingRuleDialog({
  companyNumber,
  companyName,
  onClose,
}: {
  companyNumber: string;
  companyName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createMutation = useCreateBillingRule();
  const [companyShare, setCompanyShare] = useState('');
  const [employeeShare, setEmployeeShare] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(TODAY);
  const [active, setActive] = useState(true);
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [serverError, setServerError] = useState<DescribedError | null>(null);

  const company = companyShare.trim() ? toShareHundredths(companyShare) : undefined;
  const employee = employeeShare.trim() ? toShareHundredths(employeeShare) : undefined;
  let shareProblem: string | null = null;
  if (company === null || employee === null) {
    shareProblem = 'Shares are percentages from 0 to 100 with at most two decimals.';
  } else if (company !== undefined && employee !== undefined && company + employee !== 10_000) {
    shareProblem = `The shares total ${((company + employee) / 100).toFixed(2)}%; they must total 100%.`;
  }
  const valid =
    company != null &&
    employee != null &&
    shareProblem === null &&
    isDay(effectiveDate) &&
    reason.trim().length >= 3;

  const submit = () => {
    if (company == null || employee == null) return;
    setServerError(null);
    createMutation.mutate(
      {
        companyNumber,
        data: {
          companySharePercent: (company / 100).toFixed(2),
          employeeSharePercent: (employee / 100).toFixed(2),
          effectiveDate,
          active,
          notes: notes.trim() ? notes.trim() : null,
          reason: reason.trim(),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListBillingRulesQueryKey(companyNumber) });
          toast({ title: 'Billing rule added', description: companyName });
          onClose();
        },
        onError: (e: any) => setServerError(describeError(e, 'Unable to add the billing rule.', ERROR_TITLES)),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add billing rule for {companyName}</DialogTitle>
          <DialogDescription>
            How the company's premiums are split between the company and its employees, from the effective date. The
            two shares must total 100%.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="rule-company-share">Company share (%)</Label>
              <Input
                id="rule-company-share"
                inputMode="decimal"
                value={companyShare}
                onChange={(e) => setCompanyShare(e.target.value)}
                placeholder="0.00"
                className="tnum mt-1.5"
                aria-invalid={shareProblem !== null}
                data-testid="input-rule-company-share"
              />
            </div>
            <div>
              <Label htmlFor="rule-employee-share">Employee share (%)</Label>
              <Input
                id="rule-employee-share"
                inputMode="decimal"
                value={employeeShare}
                onChange={(e) => setEmployeeShare(e.target.value)}
                placeholder="0.00"
                className="tnum mt-1.5"
                aria-invalid={shareProblem !== null}
                data-testid="input-rule-employee-share"
              />
            </div>
          </div>
          {shareProblem && (
            <p className="text-xs text-destructive" data-testid="text-rule-share-problem">
              {shareProblem}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="rule-effective">Effective date</Label>
              <Input
                id="rule-effective"
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
                className="mt-1.5"
                data-testid="input-rule-effective"
              />
            </div>
            <div className="flex items-end gap-2 pb-2">
              <Switch id="rule-active" checked={active} onCheckedChange={setActive} data-testid="switch-rule-active" />
              <Label htmlFor="rule-active" className="font-normal">
                Active
              </Label>
            </div>
          </div>
          <div>
            <Label htmlFor="rule-notes">Notes (optional)</Label>
            <Textarea
              id="rule-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1.5"
              data-testid="textarea-rule-notes"
            />
          </div>
          <div>
            <Label htmlFor="rule-reason">Reason (required, min 3 characters)</Label>
            <Textarea
              id="rule-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1.5"
              data-testid="textarea-rule-reason"
            />
          </div>
          {serverError && (
            <Alert variant="destructive" data-testid="alert-rule-error">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{serverError.title}</AlertTitle>
              <AlertDescription>{serverError.message}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || createMutation.isPending} data-testid="button-confirm-add-rule">
            {createMutation.isPending ? 'Adding…' : 'Add rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BillingRulesTab({
  companies,
  companiesLoading,
  canManage,
}: {
  companies: Company[] | undefined;
  companiesLoading: boolean;
  canManage: boolean;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const selected = picked ?? companies?.[0]?.companyNumber ?? null;

  const { data, isLoading, error } = useListBillingRules(selected ?? '', {
    query: { enabled: selected !== null, queryKey: getListBillingRulesQueryKey(selected ?? '') },
  });
  const rules = data?.rules ?? [];
  const columnCount = 6;

  return (
    <div className="space-y-5">
      <Toolbar help="How the company's premiums are split between the company and its employees, newest first.">
          <div>
            <Label className="mb-2 block">Company</Label>
            <CompanySelect
              value={selected}
              onChange={setPicked}
              companies={companies}
              loading={companiesLoading}
              testId="select-billing-company"
            />
          </div>
          {canManage && selected && (
            <Button onClick={() => setAddOpen(true)} data-testid="button-add-billing-rule">
              <Plus className="h-4 w-4" />
              Add rule
            </Button>
          )}
      </Toolbar>

      {selected === null ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {companiesLoading ? 'Loading companies…' : 'Choose a company to see its billing rules.'}
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            {error ? (
              <div className="p-6">
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{describeError(error, 'Unable to load billing rules.', ERROR_TITLES).message}</AlertDescription>
                </Alert>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Effective</TableHead>
                    <TableHead className="text-right">Company share</TableHead>
                    <TableHead className="text-right">Employee share</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead>Added</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    [...Array(3)].map((_, i) => (
                      <TableRow key={i}>
                        {[...Array(columnCount)].map((_, j) => (
                          <TableCell key={j}>
                            <Skeleton className="h-4 w-16" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : rules.length > 0 ? (
                    rules.map((r) => (
                      <TableRow key={r.companyBillingRuleId} data-testid={`row-billing-rule-${r.companyBillingRuleId}`}>
                        <TableCell className="whitespace-nowrap text-sm">{formatDay(r.effectiveDate)}</TableCell>
                        <TableCell className="tnum text-right">{r.companySharePercent}%</TableCell>
                        <TableCell className="tnum text-right">{r.employeeSharePercent}%</TableCell>
                        <TableCell>
                          <StatusPill tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Active' : 'Inactive'}</StatusPill>
                        </TableCell>
                        <TableCell className="max-w-[240px] truncate text-sm" title={r.notes ?? undefined}>
                          {r.notes ?? '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {formatTimestamp(r.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={columnCount} className="h-24 text-center text-muted-foreground">
                        No billing rules for this company yet
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {addOpen && selected && (
        <AddBillingRuleDialog
          companyNumber={selected}
          companyName={companyLabel(companies, selected)}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}

// ---- Page ------------------------------------------------------------------------------

/**
 * Premium rates per class and tier. Opens on the tab named by `?tab=`, and the
 * "Add rate set" tab takes `?class=` so the Classes page can link a class that
 * still needs rates straight to its form.
 */
export default function AdminRates() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('RATE_MANAGE');
  const canReadBilling = canManage || hasPermission('BILLING_READ');
  const search = useSearch();

  const allowedTabs: TabValue[] = [
    'card',
    ...(canManage ? (['history', 'add'] as const) : []),
    ...(canReadBilling ? (['billing'] as const) : []),
  ];
  const [initial] = useState(() => new URLSearchParams(search));
  const requested = initial.get('tab') as TabValue | null;
  const [tab, setTab] = useState<TabValue>(requested && allowedTabs.includes(requested) ? requested : 'card');

  const { data: companies, isLoading: companiesLoading } = useListCompanies();
  const classParams = { includeRetired: true };
  const { data: classData } = useListClasses(classParams, {
    query: { enabled: canManage, queryKey: getListClassesQueryKey(classParams) },
  });
  const classes = classData?.classes;

  return (
    <div>
      <PageHeader
        title="Rates"
        description={
          canManage
            ? 'Premium rates per class and tier, on the standard card and for each company'
            : 'Premium rates per class and tier for your companies. Read-only.'
        }
      />

      <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
        <TabsList className="mb-5">
          <TabsTrigger value="card" data-testid="tab-rate-card">
            <BadgeDollarSign aria-hidden="true" />
            Rate card
          </TabsTrigger>
          {canManage && (
            <TabsTrigger value="history" data-testid="tab-rate-history">
              <History aria-hidden="true" />
              History
            </TabsTrigger>
          )}
          {canManage && (
            <TabsTrigger value="add" data-testid="tab-add-rate-set">
              <Plus aria-hidden="true" />
              Add rate set
            </TabsTrigger>
          )}
          {canReadBilling && (
            <TabsTrigger value="billing" data-testid="tab-billing-rules">
              <Receipt aria-hidden="true" />
              Billing rules
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="card">
          <RateCardTab companies={companies} companiesLoading={companiesLoading} canManage={canManage} />
        </TabsContent>
        {canManage && (
          <TabsContent value="history">
            <HistoryTab companies={companies} companiesLoading={companiesLoading} classes={classes} />
          </TabsContent>
        )}
        {canManage && (
          <TabsContent value="add">
            <AddRateSetTab
              companies={companies}
              companiesLoading={companiesLoading}
              classes={classes}
              initialClass={initial.get('class')?.toUpperCase() || null}
            />
          </TabsContent>
        )}
        {canReadBilling && (
          <TabsContent value="billing">
            <BillingRulesTab companies={companies} companiesLoading={companiesLoading} canManage={canManage} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
