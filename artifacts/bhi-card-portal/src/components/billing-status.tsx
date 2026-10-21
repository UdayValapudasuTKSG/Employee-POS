import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  BillingRunSummaryStatus,
  GenerateBillingItemStatus,
  type BillingRunSummary,
  getGetAdminDashboardQueryKey,
  getGetBillingRunQueryKey,
  getListBillingRunsQueryKey,
  useListBillingRuns,
  type ListBillingRunsParams,
} from '@workspace/api-client-react';
import { StatusPill, type PillTone } from '@/components/screen-ui';

/**
 * Pieces shared by the billing list and the billing run page.
 *
 * A run is DRAFT until a super admin finalises it, FINAL once frozen, and
 * SUPERSEDED when a later calculation of the same company and month replaced
 * the draft (kept for the record, hidden by default). The portal shows a
 * superseded run as "Replaced", and a draft that replaced one as
 * "Recalculated 2 min ago".
 */

export const BILLING_HREF = '/admin/billing';

export const billingRunPath = (runId: number) => `${BILLING_HREF}/runs/${runId}`;

/** Titles for the refusals the billing pages can meet; the server's message is the description. */
export const BILLING_ERROR_TITLES: Record<string, string> = {
  RUN_HAS_ISSUES: 'Unpriced members remain',
  RUN_NOT_DRAFT: 'Only a draft can be finalised',
  UNKNOWN_COMPANY: 'Unknown company',
  INVALID_INPUT: 'Check the details',
  NOT_FOUND: 'Not found',
};

const RUN_STATUS_PILL: Record<BillingRunSummaryStatus, { tone: PillTone; label: string }> = {
  [BillingRunSummaryStatus.DRAFT]: { tone: 'warning', label: 'Draft' },
  [BillingRunSummaryStatus.FINAL]: { tone: 'success', label: 'Final' },
  // Stored as SUPERSEDED.
  [BillingRunSummaryStatus.SUPERSEDED]: { tone: 'neutral', label: 'Replaced' },
};

/** When a superseded run was replaced: the replacing run's generation time and id. */
export interface Replacement {
  at: string | null;
  byRunId: number;
}

type RunKey = Pick<BillingRunSummary, 'billingRunId' | 'companyNumber' | 'billingMonth' | 'generatedAt' | 'status'>;

/**
 * Reads the versions of each company's bill for a month from `runs`:
 *   replacedBy    for a SUPERSEDED run, the run that replaced it — the next
 *                 run by id. The database keeps no replacement time, but the
 *                 replacing run's generatedAt is that moment.
 *   recalculated  the runs that replaced an earlier version, i.e. a
 *                 recalculation rather than the month's first calculation.
 * Only what is in `runs` is known: pass the superseded runs too.
 */
export function runHistory(runs: RunKey[]): { replacedBy: Map<number, Replacement>; recalculated: Set<number> } {
  const groups = new Map<string, Map<number, RunKey>>();
  for (const r of runs) {
    const key = `${r.companyNumber}|${r.billingMonth}`;
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key)!.set(r.billingRunId, r);
  }
  const replacedBy = new Map<number, Replacement>();
  const recalculated = new Set<number>();
  for (const group of groups.values()) {
    const byId = [...group.values()].sort((a, b) => a.billingRunId - b.billingRunId);
    byId.forEach((r, i) => {
      if (i > 0) recalculated.add(r.billingRunId);
      const next = byId[i + 1];
      if (r.status === BillingRunSummaryStatus.SUPERSEDED && next) {
        replacedBy.set(r.billingRunId, { at: next.generatedAt, byRunId: next.billingRunId });
      }
    });
  }
  return { replacedBy, recalculated };
}

/** "just now", "2 min ago", "3 h ago", "yesterday", else the date. */
export function timeAgo(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return 'yesterday';
  return `on ${new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/**
 * The versions of one run's bill: every run of its company and month, live and
 * superseded. Fetched only for a draft or a superseded run.
 */
export function useRunHistory(run: BillingRunSummary | undefined): {
  replacement: Replacement | undefined;
  recalculated: boolean;
} {
  const enabled = run?.status === BillingRunSummaryStatus.SUPERSEDED || run?.status === BillingRunSummaryStatus.DRAFT;
  const params: ListBillingRunsParams = { month: run?.billingMonth ?? '', company: run?.companyNumber ?? '' };
  const supersededParams: ListBillingRunsParams = { ...params, status: BillingRunSummaryStatus.SUPERSEDED };
  const live = useListBillingRuns(params, { query: { enabled, queryKey: getListBillingRunsQueryKey(params) } });
  const old = useListBillingRuns(supersededParams, {
    query: { enabled, queryKey: getListBillingRunsQueryKey(supersededParams) },
  });
  if (!enabled || !run) return { replacement: undefined, recalculated: false };
  const history = runHistory([run, ...(live.data?.runs ?? []), ...(old.data?.runs ?? [])]);
  return { replacement: history.replacedBy.get(run.billingRunId), recalculated: history.recalculated.has(run.billingRunId) };
}

/** The current time, refreshed every minute, so "2 min ago" keeps counting. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function BillingStatusPill({
  status,
  replacement,
}: {
  status: BillingRunSummaryStatus;
  /** For a superseded run: when, and by which run, it was replaced (shown on hover). */
  replacement?: Replacement;
}) {
  const pill = RUN_STATUS_PILL[status] ?? { tone: 'neutral' as const, label: status };
  const title =
    status === BillingRunSummaryStatus.SUPERSEDED && replacement
      ? `Replaced by run #${replacement.byRunId}${replacement.at ? ` on ${new Date(replacement.at).toLocaleString()}` : ''}`
      : undefined;
  return (
    <span title={title}>
      <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
    </span>
  );
}

/** Under a draft: "Recalculated 2 min ago", or "Generated 2 min ago" for the month's first calculation. */
export function DraftAge({
  run,
  recalculated,
  now,
}: {
  run: Pick<BillingRunSummary, 'status' | 'generatedAt'>;
  recalculated: boolean;
  now: number;
}) {
  if (run.status !== BillingRunSummaryStatus.DRAFT || !run.generatedAt) return null;
  return (
    <div className="mt-1 whitespace-nowrap text-xs text-muted-foreground" title={new Date(run.generatedAt).toLocaleString()}>
      {recalculated ? 'Recalculated' : 'Generated'} {timeAgo(run.generatedAt, now)}
    </div>
  );
}

const RESULT_PILL: Record<GenerateBillingItemStatus, { tone: PillTone; label: string }> = {
  [GenerateBillingItemStatus.DRAFT]: { tone: 'warning', label: 'Draft created' },
  [GenerateBillingItemStatus.ALREADY_FINAL]: { tone: 'neutral', label: 'Already final' },
  [GenerateBillingItemStatus.FAILED]: { tone: 'error', label: 'Failed' },
};

export function GenerateResultPill({ status }: { status: GenerateBillingItemStatus }) {
  const pill = RESULT_PILL[status] ?? { tone: 'neutral' as const, label: status };
  return <StatusPill tone={pill.tone}>{pill.label}</StatusPill>;
}

/** Refresh everything a generate or finalise can change: the lists, the run, and the dashboard counts. */
export function useInvalidateBilling() {
  const queryClient = useQueryClient();
  return (runId?: number) => {
    // No params: prefix-matches every cached month, company and status.
    queryClient.invalidateQueries({ queryKey: getListBillingRunsQueryKey() });
    if (runId !== undefined) queryClient.invalidateQueries({ queryKey: getGetBillingRunQueryKey(runId) });
    queryClient.invalidateQueries({ queryKey: getGetAdminDashboardQueryKey() });
  };
}
