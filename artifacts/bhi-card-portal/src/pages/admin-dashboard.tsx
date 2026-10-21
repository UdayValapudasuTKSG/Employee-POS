import { Link } from 'wouter';
import { useGetAdminDashboard } from '@workspace/api-client-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Users,
  UserCheck,
  UserX,
  UsersRound,
  Calendar,
  CalendarX,
  ShieldAlert,
  AlertCircle,
  Building2,
  Activity,
  CheckCircle2,
  Lock,
  SearchX,
  ChevronRight,
  ClipboardList,
  Receipt,
  Sun,
  Moon,
  Sunrise,
  Plus,
  FileUp,
  ArrowUpRight,
  TriangleAlert,
} from 'lucide-react';
import { format } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '@/contexts/auth-context';
import { canSeePolicy } from '@/lib/policy-visibility';
import { IMPORT_EXCEPTION_ROLES } from '@/components/admin-nav';
import { PanelCard, StatTile } from '@/components/screen-ui';
import { NalicoLogo } from '@/components/nalico-logo';

/** The roof from the NALICO logo, alone. Decorative. */
function RoofIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 236 52" className={className} aria-hidden="true">
      <path d="M118 0 L236 52 L208 52 L118 13 L28 52 L0 52 Z" fill="currentColor" />
    </svg>
  );
}

type Severity = 'critical' | 'warning' | 'clear';

const SEVERITY: Record<Severity, { dot: string; chip: string; count: string; word: string }> = {
  critical: {
    dot: 'bg-[var(--status-error)]',
    chip: 'bg-error-soft text-error',
    count: 'text-[var(--status-error)]',
    word: 'Critical',
  },
  warning: {
    dot: 'bg-[var(--status-warning)]',
    chip: 'bg-warning-soft text-warning-text',
    count: 'text-[var(--status-warning-text)]',
    word: 'Review',
  },
  clear: {
    dot: 'bg-[var(--status-success)]',
    chip: 'bg-[var(--surface-4)] text-[var(--fg-3)]',
    count: 'text-[var(--fg-1)]',
    word: 'Clear',
  },
};

/**
 * One line of the work queue: something an administrator may have to act on.
 * Severity is always spelled out in a word beside the coloured dot, so it never
 * rests on colour alone.
 */
function QueueRow({
  label,
  value,
  icon: Icon,
  detail,
  href,
  severity,
  testId,
  detailTestId,
  detailEmphasis = false,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  detail: string;
  /** Where the items can be worked through, when there is such a list. */
  href?: string;
  severity: Severity;
  testId?: string;
  detailTestId?: string;
  detailEmphasis?: boolean;
}) {
  const tone = SEVERITY[severity];
  const row = (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <span
        aria-hidden="true"
        className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px] ${tone.chip}`}
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${tone.dot}`} />
          <span className="truncate text-[16px] font-bold text-[var(--fg-1)]">{label}</span>
          <span className={`hidden rounded-full px-2 py-px text-[11px] font-bold uppercase tracking-[0.06em] sm:inline ${tone.chip}`}>
            {tone.word}
          </span>
        </div>
        <div
          className={`mt-0.5 truncate text-[14.5px] ${
            detailEmphasis ? 'font-semibold text-[var(--status-warning-text)]' : 'text-[var(--fg-3)]'
          }`}
          data-testid={detailTestId}
        >
          {detail}
        </div>
      </div>
      <div className={`tnum text-[24px] font-bold leading-none ${tone.count}`}>{value.toLocaleString()}</div>
      {href && (
        <ChevronRight
          aria-hidden="true"
          className="h-5 w-5 flex-shrink-0 text-[var(--fg-4)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--brand-600)]"
        />
      )}
    </div>
  );
  return href ? (
    <Link
      href={href}
      className="group block transition-colors hover:bg-[var(--brand-50)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      data-testid={testId}
    >
      {row}
    </Link>
  ) : (
    <div data-testid={testId}>{row}</div>
  );
}

function greeting(hour: number): { text: string; icon: LucideIcon } {
  if (hour < 12) return { text: 'Good morning', icon: Sunrise };
  if (hour < 18) return { text: 'Good afternoon', icon: Sun };
  return { text: 'Good evening', icon: Moon };
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading dashboard">
      <Skeleton className="h-[150px] w-full rounded-2xl" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="rounded-2xl border border-[var(--surface-border)] bg-card p-5">
            <div className="flex items-start justify-between">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-9 w-9 rounded-[10px]" />
            </div>
            <Skeleton className="mt-2 h-9 w-24" />
            <Skeleton className="mt-4 h-3.5 w-36" />
          </div>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-card">
            <div className="flex items-center gap-3 border-b border-[var(--surface-hairline)] px-5 py-4">
              <Skeleton className="h-9 w-9 rounded-[10px]" />
              <Skeleton className="h-5 w-40" />
            </div>
            {[...Array(4)].map((_, j) => (
              <div key={j} className="flex items-center gap-4 border-b border-[var(--surface-hairline)] px-5 py-4 last:border-0">
                <Skeleton className="h-10 w-10 rounded-[10px]" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
                <Skeleton className="h-6 w-10" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const { data: stats, isLoading, error } = useGetAdminDashboard();
  const { adminUser, hasPermission } = useAuth();
  // The fix list is linked only for the roles its sidebar entry shows to.
  const canOpenExceptions =
    adminUser?.role !== undefined && IMPORT_EXCEPTION_ROLES.includes(adminUser.role);
  const canOpenCompanies = adminUser?.role === 'ROLE_PLATFORM_ADMIN' && hasPermission('PLATFORM_MANAGE');
  const showPolicy = canSeePolicy(adminUser?.role);

  const now = new Date();
  const hello = greeting(now.getHours());
  const HelloIcon = hello.icon;
  const firstName = adminUser?.displayName?.split(/\s+/)[0];

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  if (error || !stats) {
    return (
      <div>
        <h1 className="ds-page-title mb-6">Dashboard</h1>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Unable to load dashboard data.</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Null for every role but super admin, the only one who can open the alerts
  // page; for them the row shows even at zero.
  const openLookupAlerts = stats.openLookupAlerts;
  // Both null without BILLING_READ, which is also what the Billing page needs.
  const draftBillingRuns = stats.draftBillingRuns;
  const unpricedMembers = stats.unpricedMembers ?? 0;

  const activeShare =
    stats.totalMembers > 0 ? Math.round((stats.activeMembers / stats.totalMembers) * 100) : 0;

  // Only the genuinely outstanding items. A member aging out at 65 is the plan
  // working as intended, so Inactive is never here; it sits with the KPIs.
  const attention = [
    {
      label: 'Expired policies',
      value: showPolicy ? stats.expiredPolicyCount : 0,
      icon: Calendar,
      detail: 'Policy end date has passed',
    },
    {
      label: 'Locked verifications',
      value: stats.lockedVerifications,
      icon: Lock,
      detail: 'Card lookups locked out after too many failed attempts',
    },
    {
      label: 'No date of birth',
      value: stats.membersWithoutDateOfBirth,
      icon: CalendarX,
      detail: 'Active members who can never be retired at 65 until one is added',
      href: '/admin/members?missingDateOfBirth=true',
    },
  ].filter((item) => item.value > 0);

  const attentionTotal = attention.reduce((n, item) => n + item.value, 0);
  const queueOpen =
    (openLookupAlerts ?? 0) + (canOpenExceptions ? stats.openImportExceptions : 0) + (draftBillingRuns ?? 0);

  const heroLine =
    attention.length > 0
      ? `${attentionTotal.toLocaleString()} item${attentionTotal === 1 ? ' needs' : 's need'} your attention${
          queueOpen > 0 ? `, and ${queueOpen.toLocaleString()} more ${queueOpen === 1 ? 'is' : 'are'} waiting in the work queues.` : '.'
        }`
      : queueOpen > 0
        ? `Nothing critical outstanding. ${queueOpen.toLocaleString()} item${queueOpen === 1 ? ' is' : 's are'} waiting in the work queues.`
        : showPolicy
          ? 'Everything is up to date — no expired policies, locked verifications or open queues.'
          : 'Everything is up to date — no locked verifications or open queues.';

  return (
    // nalico-dash recolours this page alone in the logo's purple and red.
    <div className="nalico-dash space-y-5">
      {/* Greeting, under the NALICO roof */}
      <section className="admin-hero ds-rise px-7 pb-6 pt-7">
        <span aria-hidden="true" className="nalico-roof-edge" />
        {/* The logo's roof, large and faint, as the banner's watermark. */}
        <svg
          viewBox="0 0 236 52"
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-6 right-[-40px] z-0 h-[150px] w-[680px] text-white/[0.07]"
        >
          <path d="M118 0 L236 52 L208 52 L118 13 L28 52 L0 52 Z" fill="currentColor" />
        </svg>

        <div className="relative z-[1] flex flex-wrap items-center justify-between gap-6">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <RoofIcon className="h-3.5 w-8 text-[var(--nalico-red)]" />
              <span className="flex items-center gap-2 text-[12.5px] font-bold uppercase tracking-[0.12em] text-[#ddd0fb]">
                <HelloIcon aria-hidden="true" className="h-4 w-4 text-[#ffb3b7]" />
                {format(now, 'EEEE, MMMM d, yyyy')}
              </span>
            </div>
            <h1 className="mt-2.5 text-[clamp(26px,3vw,34px)] font-bold leading-tight tracking-[-0.015em] text-white">
              {hello.text}
              {firstName ? `, ${firstName}` : ''}.
            </h1>
            <p className="mt-1.5 max-w-2xl text-[16.5px] leading-relaxed text-[#e6dcfb]" data-testid="text-dashboard-summary">
              {heroLine}
            </p>
          </div>

          <div className="flex flex-col items-start gap-4 sm:items-end">
            {/* The company's own mark, on white as it is printed. */}
            <div className="flex items-center gap-3.5 rounded-2xl bg-white px-4 py-2.5 shadow-[0_10px_24px_-10px_rgba(20,6,60,0.55)]">
              <NalicoLogo className="h-11 w-auto" />
              <span aria-hidden="true" className="h-9 w-px bg-[var(--surface-border)]" />
              <span className="leading-tight">
                <span className="block text-[14.5px] font-bold text-[var(--nalico-purple)]">Health card</span>
                <span className="block text-[12.5px] font-semibold uppercase tracking-[0.1em] text-[var(--nalico-red)]">
                  Administration
                </span>
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
            {hasPermission('MEMBER_CREATE') && (
              <Link href="/admin/members/new">
                <Button
                  variant="outline"
                  className="border-white bg-white font-bold text-[var(--brand-600)] shadow-[0_6px_18px_-6px_rgba(0,0,0,0.35)] hover:bg-[var(--brand-50)]"
                  data-testid="button-hero-new-member"
                >
                  <Plus className="h-4 w-4" />
                  New member
                </Button>
              </Link>
            )}
            {hasPermission('MEMBER_IMPORT') && (
              <Link href="/admin/import">
                <Button variant="ghost" className="border-white/35 bg-white/10 text-white hover:bg-white/20 hover:text-white" data-testid="button-hero-import">
                  <FileUp className="h-4 w-4" />
                  Import file
                </Button>
              </Link>
            )}
            </div>
          </div>
        </div>
      </section>

      {/* Headline figures. Inactive members are retained, so Total = Active + Inactive. */}
      <div className="ds-stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="Total members"
          value={stats.totalMembers.toLocaleString()}
          icon={Users}
          accent="nalico"
          footnote={
            stats.totalMembers > 0 ? (
              <span className="flex items-center gap-2.5">
                <span className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--surface-4)]">
                  <span
                    className="block h-full rounded-full bg-[var(--brand-600)]"
                    style={{ width: `${activeShare}%` }}
                  />
                </span>
                {activeShare}% active
              </span>
            ) : (
              'No members yet'
            )
          }
        />
        <StatTile
          label="Active members"
          value={stats.activeMembers.toLocaleString()}
          icon={UserCheck}
          accent="success"
          footnote="Eligible to be issued a card"
        />
        <StatTile
          label="Dependents"
          value={stats.totalDependents.toLocaleString()}
          icon={UsersRound}
          accent="roof"
          footnote="Printed on the reverse of the card"
        />
        <StatTile
          label="Inactive"
          value={stats.inactiveMembers.toLocaleString()}
          icon={UserX}
          accent="gold"
          footnote="Deactivated or aged out, retained"
        />
        <StatTile
          label="Verifications today"
          value={stats.verificationsToday.toLocaleString()}
          icon={ShieldAlert}
          accent="teal"
          footnote="Card lookups since midnight"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Outstanding work and the queues that feed it */}
        <PanelCard
          icon={TriangleAlert}
          title="Needs attention"
          id="dashboard-attention"
          footer={
            <span>
              {attention.length > 0
                ? `${attention.length} critical · ${queueOpen.toLocaleString()} queued`
                : `Nothing critical · ${queueOpen.toLocaleString()} queued`}
            </span>
          }
        >
          <div className="divide-y divide-[var(--surface-hairline)]">
            {attention.length === 0 && (
              <div className="flex items-center gap-3 px-5 py-4 text-[15px] text-[var(--fg-2)]">
                <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px] bg-success-soft text-success">
                  <CheckCircle2 aria-hidden="true" className="h-[18px] w-[18px]" />
                </span>
                {showPolicy
                  ? 'Nothing outstanding — no expired policies, locked verifications or missing dates of birth.'
                  : 'Nothing outstanding — no locked verifications or missing dates of birth.'}
              </div>
            )}
            {attention.map((item) => (
              <QueueRow key={item.label} {...item} severity="critical" />
            ))}
            {openLookupAlerts !== null && (
              <QueueRow
                label="Open lookup alerts"
                value={openLookupAlerts}
                icon={SearchX}
                detail="Contact matched several companies"
                href="/admin/lookup-alerts"
                severity={openLookupAlerts > 0 ? 'critical' : 'clear'}
                testId="link-open-lookup-alerts"
              />
            )}
            {canOpenExceptions && (
              <QueueRow
                label="Open import exceptions"
                value={stats.openImportExceptions}
                icon={ClipboardList}
                detail="Rows held for HR to fix"
                href="/admin/import-exceptions"
                severity={stats.openImportExceptions > 0 ? 'warning' : 'clear'}
                testId="link-open-import-exceptions"
              />
            )}
            {draftBillingRuns !== null && (
              <QueueRow
                label="Draft bills"
                value={draftBillingRuns}
                icon={Receipt}
                detail={
                  unpricedMembers > 0
                    ? `${unpricedMembers.toLocaleString()} unpriced member${unpricedMembers === 1 ? '' : 's'}`
                    : 'Awaiting finalisation'
                }
                detailEmphasis={unpricedMembers > 0}
                detailTestId="text-unpriced-members"
                href="/admin/billing"
                severity={unpricedMembers > 0 || draftBillingRuns > 0 ? 'warning' : 'clear'}
                testId="link-open-billing"
              />
            )}
          </div>
        </PanelCard>

        {/* Recent audit */}
        <PanelCard
          icon={Activity}
          title="Recent activity"
          id="dashboard-activity"
          bodyClassName="max-h-[420px] overflow-y-auto"
          footer={
            <>
              <span>{stats.recentAudit.length} latest events</span>
              {hasPermission('AUDIT_READ') && (
                <Link
                  href="/admin/audit"
                  className="inline-flex items-center gap-1 font-bold text-[var(--brand-600)] hover:underline"
                >
                  View all <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
                </Link>
              )}
            </>
          }
        >
          {stats.recentAudit.length === 0 ? (
            <div className="px-5 py-10 text-center text-[15px] text-[var(--fg-3)]">No activity recorded yet.</div>
          ) : (
            <div className="divide-y divide-[var(--surface-hairline)]">
              {stats.recentAudit.map((entry) => (
                <div key={entry.id} className="flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-[var(--surface-2)]">
                  <span aria-hidden="true" className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-[var(--brand-400)]" />
                  <div className="min-w-0 flex-1">
                    {/* The action is the subject of the row, so it reads as a
                        label rather than as body text. */}
                    <span className="inline-block rounded-md bg-[var(--brand-50)] px-2 py-0.5 text-[12px] font-bold uppercase tracking-[0.05em] text-[var(--brand-700)]">
                      {entry.action.replace(/_/g, ' ')}
                    </span>
                    <div className="mt-1.5 truncate text-[14.5px] text-[var(--fg-3)]">
                      <span className="font-semibold text-[var(--fg-2)]">{entry.actor}</span>
                      <span className="mx-1.5 text-[var(--fg-4)]">·</span>
                      {entry.actorRole.replace('ROLE_', '').replace(/_/g, ' ')}
                      {entry.entityId && (
                        <span className="mono-id ml-2 text-[var(--fg-4)]">#{entry.entityId}</span>
                      )}
                    </div>
                  </div>
                  <time
                    className="flex-shrink-0 whitespace-nowrap text-[13.5px] font-medium text-[var(--fg-4)]"
                    dateTime={new Date(entry.timestamp).toISOString()}
                  >
                    {format(new Date(entry.timestamp), 'MMM d, h:mm a')}
                  </time>
                </div>
              ))}
            </div>
          )}
        </PanelCard>
      </div>

      {/* By company */}
      {stats.byCompany.length > 0 && (
        <PanelCard
          icon={Building2}
          title="Members by company"
          id="dashboard-companies"
          action={
            <span className="rounded-full bg-[var(--surface-4)] px-3 py-1 text-[13.5px] font-semibold text-[var(--fg-3)]">
              {stats.byCompany.length} companies
            </span>
          }
          footer={
            canOpenCompanies ? (
              <>
                <span>Bar shows the active share of each company's roster</span>
                <Link
                  href="/admin/companies"
                  className="inline-flex items-center gap-1 font-bold text-[var(--brand-600)] hover:underline"
                >
                  Manage companies <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
                </Link>
              </>
            ) : undefined
          }
        >
          {/* Each cell draws its own right and bottom rule; the negative margin
              tucks the outermost ones under the panel's edge, so a short last
              row leaves white space rather than a grey block. */}
          <div className="-mb-px -mr-px grid sm:grid-cols-2 xl:grid-cols-3">
            {stats.byCompany.map((company) => {
              const share =
                company.memberCount > 0 ? Math.round((company.activeCount / company.memberCount) * 100) : 0;
              return (
                <div
                  key={company.companyNumber}
                  className="border-b border-r border-[var(--surface-hairline)] px-5 py-4 transition-colors hover:bg-[var(--surface-2)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[16px] font-bold text-[var(--fg-1)]">{company.companyName}</div>
                      <div className="mono-id mt-0.5 text-[13px] font-semibold text-[var(--brand-600)]">
                        {company.companyNumber}
                      </div>
                    </div>
                    <div className="flex-shrink-0 text-right">
                      <div className="tnum text-[20px] font-bold leading-none text-[var(--fg-1)]">
                        {company.memberCount.toLocaleString()}
                      </div>
                      <div className="mt-1 text-[13px] text-[var(--fg-3)]">{company.activeCount} active</div>
                    </div>
                  </div>
                  {/* The bar makes an inactive-heavy company visible at a
                      glance, which two numbers side by side did not. */}
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--surface-4)]" role="presentation">
                    <div
                      className={`h-full rounded-full ${
                        company.memberCount === 0
                          ? ''
                          : share === 100
                            ? 'bg-[var(--status-success)]'
                            : 'bg-[var(--gold-500)]'
                      }`}
                      style={{ width: `${share}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </PanelCard>
      )}
    </div>
  );
}
