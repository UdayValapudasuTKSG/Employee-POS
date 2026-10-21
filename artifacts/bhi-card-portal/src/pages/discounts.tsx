import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import QRCode from 'react-qr-code';
import type { LucideIcon } from 'lucide-react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Drumstick,
  Loader2,
  Pizza,
  QrCode,
  ShoppingBag,
  TicketPercent,
} from 'lucide-react';
import { format } from 'date-fns';
import {
  getGetDiscountsQueryKey,
  getListDiscountCouponsQueryKey,
  useGenerateDiscountCoupon,
  useGetDiscounts,
  useListDiscountCoupons,
} from '@workspace/api-client-react';
import type {
  ApiErrorEnvelope,
  DiscountBrand,
  DiscountBrandInfo,
  ErrorType,
  ListDiscountCouponsParams,
  ListDiscountCouponsStatus,
  OwnDiscountCoupon,
} from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MemberLogoutButton, MemberNav } from '@/components/member-nav';
import {
  AutoGrid,
  EmptyState,
  IconTile,
  MemberShell,
  MemberTopBar,
  PageHead,
  Panel,
  SectionHead,
  Skeleton,
  StatusPill,
  UnavailableState,
  type PillTone,
} from '@/components/screen-ui';
import { MONEY, formatMonth } from '@/lib/format';

const BRAND_ICONS: Record<DiscountBrand, LucideIcon> = {
  KFC: Drumstick,
  PIZZA_HUT: Pizza,
};

const STATUS_PILL: Record<OwnDiscountCoupon['status'], { tone: PillTone; label: string }> = {
  ACTIVE: { tone: 'brand', label: 'Ready to use' },
  EXPIRED: { tone: 'neutral', label: 'Expired' },
  REDEEMED: { tone: 'success', label: 'Redeemed' },
  VOIDED: { tone: 'warning', label: 'Sale voided' },
  CANCELLED: { tone: 'neutral', label: 'Replaced' },
};

function gyd(amount: number): string {
  return `GYD ${MONEY.format(amount)}`;
}

// ---------------------------------------------------------------------------
// Codes the member generated in this card session
// ---------------------------------------------------------------------------

/**
 * The server returns a coupon's code once, when it is generated, and keeps only
 * its hash. It is held here, in this tab's sessionStorage beside the card token
 * and tied to it, so the QR can be shown again after moving between pages. A
 * new card session ignores and replaces whatever the last one left.
 */
const CODES_KEY = 'bhi_discount_codes';

function readCodes(owner: string): Record<string, string> {
  try {
    const stored = JSON.parse(sessionStorage.getItem(CODES_KEY) ?? 'null');
    return stored?.owner === owner && stored.codes ? stored.codes : {};
  } catch {
    return {};
  }
}

function saveCode(owner: string, couponId: string, code: string): Record<string, string> {
  const codes = { ...readCodes(owner), [couponId]: code };
  try {
    sessionStorage.setItem(CODES_KEY, JSON.stringify({ owner, codes }));
  } catch {
    // Storage unavailable: the QR still shows now, just not after navigating away.
  }
  return codes;
}

/** Re-renders every second while `on`, for the expiry countdown. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [on]);
  return now;
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// The coupon on screen
// ---------------------------------------------------------------------------

function CouponDialog({
  coupon,
  code,
  brandName,
  onOpenChange,
}: {
  coupon: OwnDiscountCoupon | null;
  code: string | null;
  brandName: string;
  onOpenChange: (open: boolean) => void;
}) {
  const now = useNow(coupon?.status === 'ACTIVE');
  const open = coupon != null && code != null;
  const remainingMs = coupon ? new Date(coupon.expiresAt).getTime() - now : 0;
  const expired = coupon?.status === 'EXPIRED' || (coupon?.status === 'ACTIVE' && remainingMs <= 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="coupon-dialog">
        <DialogHeader>
          <DialogTitle>{brandName} coupon</DialogTitle>
          <DialogDescription>
            {coupon?.discountPercent}% off your bill. Show this at the counter for the cashier to scan.
          </DialogDescription>
        </DialogHeader>

        {coupon && code && (
          <div className="flex flex-col items-center gap-4">
            {coupon.status === 'REDEEMED' ? (
              <div role="status" className="flex flex-col items-center gap-2 py-6 text-center">
                <CheckCircle2 aria-hidden="true" className="h-12 w-12 text-success" />
                <div className="ds-card-title">Coupon redeemed</div>
                <p className="ds-meta">
                  You saved {gyd(coupon.discountAmount ?? 0)} on a bill of {gyd(coupon.billAmount ?? 0)}.
                </p>
              </div>
            ) : (
              <>
                {/* Always black on white, whatever the theme: a scanner needs the contrast. */}
                <div
                  className={`rounded-2xl bg-white p-4 shadow-[var(--shadow-sm)] ${expired || coupon.status !== 'ACTIVE' ? 'opacity-25' : ''}`}
                >
                  <QRCode value={code} size={208} level="M" bgColor="#ffffff" fgColor="#000000" title={`Coupon ${code}`} />
                </div>
                <div className="tnum select-all text-center font-mono text-2xl font-bold tracking-[0.12em] text-[var(--fg-1)]" data-testid="coupon-code">
                  {code}
                </div>
                {expired ? (
                  <StatusPill tone="neutral" icon={Clock}>Expired — generate a new coupon</StatusPill>
                ) : coupon.status === 'ACTIVE' ? (
                  <p className="ds-meta text-center" aria-live="off">
                    Valid for <span className="tnum font-semibold text-[var(--fg-2)]">{countdown(remainingMs)}</span>, until{' '}
                    {format(new Date(coupon.expiresAt), 'h:mm a')}. Single use.
                  </p>
                ) : (
                  <StatusPill tone={STATUS_PILL[coupon.status].tone}>{STATUS_PILL[coupon.status].label}</StatusPill>
                )}
              </>
            )}
            <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Coupon history: filtered and paged
// ---------------------------------------------------------------------------

const HISTORY_PAGE_SIZE = 10;

/** The Select needs a non-empty value for "no filter". */
const ALL = 'all';

const STATUS_FILTERS: { value: ListDiscountCouponsStatus; label: string }[] = [
  { value: 'ACTIVE', label: 'Ready to use' },
  { value: 'REDEEMED', label: 'Redeemed' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'VOIDED', label: 'Sale voided' },
  { value: 'CANCELLED', label: 'Replaced' },
];

/** This month and the eleven before it, newest first, as YYYY-MM. */
function recentMonths(current: string, count = 12): string[] {
  const [y, m] = current.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(y, m - 1 - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: { value: string; label: string }[];
  testId: string;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger aria-label={label} className="h-10 w-full min-w-0 sm:w-44" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{`All ${label.toLowerCase()}`}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CouponHistory({
  cardToken,
  codes,
  brands,
  currentMonth,
  watching,
  onShow,
}: {
  cardToken: string;
  codes: Record<string, string>;
  brands: DiscountBrandInfo[];
  currentMonth: string;
  /** A coupon is on screen: keep this page fresh so a redemption shows here too. */
  watching: boolean;
  onShow: (couponId: string) => void;
}) {
  const [filters, setFilters] = useState<ListDiscountCouponsParams>({ page: 1, pageSize: HISTORY_PAGE_SIZE });
  const { data, isLoading, isFetching, isError, refetch } = useListDiscountCoupons(filters, {
    query: {
      // Keyed by the session too, like the card and the summary.
      queryKey: [...getListDiscountCouponsQueryKey(filters), cardToken],
      staleTime: 0,
      refetchInterval: watching ? 4000 : false,
      // Keep the current page on screen while the next one loads, so the list does not jump.
      placeholderData: (previous) => previous,
    },
  });

  const filtered = Boolean(filters.brand || filters.status || filters.month);
  const setFilter = <K extends 'brand' | 'status' | 'month'>(key: K, value: ListDiscountCouponsParams[K] | undefined) =>
    setFilters((prev) => ({ ...prev, [key]: value, page: 1 }));
  const goTo = (page: number) => setFilters((prev) => ({ ...prev, page }));
  const clear = () => setFilters({ page: 1, pageSize: HISTORY_PAGE_SIZE });
  const brandName = (brand: DiscountBrand) => brands.find((b) => b.brand === brand)?.name ?? brand;

  return (
    <section aria-labelledby="coupons-title" className="flex flex-col gap-4">
      <SectionHead id="coupons-title" title="Your coupons" />

      <div role="group" aria-label="Filter your coupons" className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <FilterSelect
          label="Partners"
          value={filters.brand}
          onChange={(v) => setFilter('brand', v as DiscountBrand | undefined)}
          options={brands.map((b) => ({ value: b.brand, label: b.name }))}
          testId="filter-brand"
        />
        <FilterSelect
          label="Statuses"
          value={filters.status}
          onChange={(v) => setFilter('status', v as ListDiscountCouponsStatus | undefined)}
          options={STATUS_FILTERS}
          testId="filter-status"
        />
        <FilterSelect
          label="Months"
          value={filters.month}
          onChange={(v) => setFilter('month', v)}
          options={recentMonths(currentMonth).map((m) => ({ value: m, label: formatMonth(m) }))}
          testId="filter-month"
        />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clear} className="min-h-10 self-start sm:self-auto" data-testid="button-clear-filters">
            Clear filters
          </Button>
        )}
      </div>

      {isLoading ? (
        <div role="status" aria-live="polite">
          <span className="sr-only">Loading your coupons…</span>
          <Skeleton height={200} radius={18} />
        </div>
      ) : isError || !data ? (
        <UnavailableState
          what="your coupons"
          action={
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      ) : data.totalItems === 0 ? (
        filtered ? (
          <EmptyState
            icon={TicketPercent}
            title="No coupons match these filters"
            body="Try another partner, status or month."
            action={
              <Button variant="outline" size="sm" onClick={clear}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={TicketPercent}
            title="No coupons yet"
            body="Coupons you generate will be listed here, with what you saved."
          />
        )
      ) : (
        <>
          <ul
            className={`ds-card divide-y divide-[var(--surface-hairline)] px-5 transition-opacity ${isFetching ? 'opacity-70' : ''}`}
            aria-busy={isFetching}
            data-testid="coupon-list"
          >
            {data.items.map((c) => {
              const showable = c.status === 'ACTIVE' && codes[c.id];
              // Active, but its code was shown in another tab or session and is not kept anywhere else.
              const pill =
                c.status === 'ACTIVE' && !showable
                  ? { tone: 'neutral' as PillTone, label: 'Active elsewhere' }
                  : STATUS_PILL[c.status];
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <IconTile icon={BRAND_ICONS[c.brand]} size={36} />
                    <div className="min-w-0">
                      <div className="ds-card-title">{brandName(c.brand)}</div>
                      <div className="ds-meta">
                        {c.redeemedAt
                          ? `Redeemed ${format(new Date(c.redeemedAt), 'd MMM yyyy, h:mm a')}`
                          : `Generated ${format(new Date(c.createdAt), 'd MMM yyyy, h:mm a')}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {c.discountAmount != null && (
                      <span className="tnum text-[14.5px] font-semibold text-[var(--fg-1)]">
                        Saved {gyd(c.discountAmount)}
                      </span>
                    )}
                    {showable ? (
                      <Button size="sm" variant="outline" onClick={() => onShow(c.id)}>
                        <QrCode aria-hidden="true" className="h-4 w-4" />
                        Show
                      </Button>
                    ) : (
                      <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <nav aria-label="Coupon pages" className="flex flex-wrap items-center justify-between gap-3">
            <p className="ds-meta tnum" aria-live="polite" data-testid="coupon-page-status">
              Page {Math.min(data.page, Math.max(1, data.totalPages))} of {Math.max(1, data.totalPages)} ·{' '}
              {data.totalItems} coupon{data.totalItems === 1 ? '' : 's'}
            </p>
            {/* Always shown, disabled at either end, so the controls never appear and vanish. */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="min-h-10"
                onClick={() => goTo(data.page - 1)}
                disabled={data.page <= 1}
                data-testid="button-prev-page"
              >
                <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-10"
                onClick={() => goTo(data.page + 1)}
                disabled={data.page >= data.totalPages}
                data-testid="button-next-page"
              >
                Next
                <ChevronRight aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          </nav>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default function Discounts() {
  const [, setLocation] = useLocation();
  const { cardToken } = useAuth();
  const { toast } = useToast();
  const [codes, setCodes] = useState<Record<string, string>>(() => (cardToken ? readCodes(cardToken) : {}));
  const [shownId, setShownId] = useState<string | null>(null);

  // Keyed by the session, like the card: one member's coupons are never shown to the next.
  const { data, isLoading, error, refetch } = useGetDiscounts({
    query: {
      queryKey: [...getGetDiscountsQueryKey(), cardToken ?? ''],
      enabled: !!cardToken,
      staleTime: 0,
      // While a coupon is on screen, watch for the till redeeming it.
      refetchInterval: shownId ? 4000 : false,
    },
  });
  const generate = useGenerateDiscountCoupon();
  const queryClient = useQueryClient();

  // Same gate as the card: discounts are for a verified member only.
  useEffect(() => {
    if (!cardToken) setLocation('/lookup');
  }, [cardToken, setLocation]);

  if (!cardToken) return null;

  const top = <MemberTopBar right={<MemberLogoutButton />} />;

  if (isLoading) {
    return (
      <MemberShell width="xl" top={top}>
        <MemberNav />
        <div role="status" aria-live="polite" className="flex flex-col gap-4">
          <span className="sr-only">Loading your discounts…</span>
          <Skeleton height={36} radius={10} className="max-w-xs" />
          <Skeleton height={120} radius={18} />
          <Skeleton height={220} radius={18} />
        </div>
      </MemberShell>
    );
  }

  if (error || !data) {
    return (
      <MemberShell width="xl" top={top}>
        <MemberNav />
        <h1 className="sr-only">Employee discounts</h1>
        <div role="alert">
          <EmptyState
            icon={AlertCircle}
            title="We could not load your discounts"
            body="Your session may have expired. Verify again to continue."
            action={
              <Button size="lg" onClick={() => setLocation('/lookup')} className="mt-1">
                Verify again
              </Button>
            }
          />
        </div>
      </MemberShell>
    );
  }

  const brandName = (brand: DiscountBrand) => data.brands.find((b) => b.brand === brand)?.name ?? brand;
  const usedPct = data.monthlyCap > 0 ? Math.min(100, (data.usedThisMonth / data.monthlyCap) * 100) : 100;
  const exhausted = data.remainingThisMonth <= 0;
  const now = Date.now();
  const isLive = (c: OwnDiscountCoupon) => c.status === 'ACTIVE' && new Date(c.expiresAt).getTime() > now;
  /** The member's live coupon for a brand whose code this tab still holds. */
  const liveCoupon = (brand: DiscountBrand) => data.coupons.find((c) => c.brand === brand && isLive(c) && codes[c.id]);
  /** A live coupon generated in another tab or session: its code is not here, and a new one replaces it. */
  const liveElsewhere = (brand: DiscountBrand) => data.coupons.some((c) => c.brand === brand && isLive(c) && !codes[c.id]);
  const shown = shownId ? (data.coupons.find((c) => c.id === shownId) ?? null) : null;
  // A new coupon belongs at the top of the history, whatever page or filter is showing.
  const refreshHistory = () => queryClient.invalidateQueries({ queryKey: getListDiscountCouponsQueryKey() });

  const handleGenerate = (brand: DiscountBrand) => {
    generate.mutate(
      { data: { brand } },
      {
        onSuccess: (result) => {
          setCodes(saveCode(cardToken, result.coupon.id, result.code));
          setShownId(result.coupon.id);
          void refetch();
          void refreshHistory();
        },
        onError: (err) => {
          const envelope = (err as ErrorType<ApiErrorEnvelope>)?.data;
          toast({
            title: 'Could not generate a coupon',
            description: envelope?.error?.message ?? 'Something went wrong. Try again shortly.',
            variant: 'destructive',
          });
          void refetch();
        },
      },
    );
  };

  return (
    <MemberShell width="xl" top={top}>
      <MemberNav />

      <PageHead
        eyebrow="Employee benefits"
        title="Employee discounts"
        sub={`${data.discountPercent}% off at ${data.brands.map((b) => b.name).join(' and ')}. Generate a coupon and show it at the counter.`}
      />

      {/* This month's allowance */}
      <Panel title={`Your allowance for ${formatMonth(data.month)}`} className="max-w-2xl">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="tnum text-[28px] font-bold leading-none text-[var(--fg-1)]" data-testid="allowance-remaining">
            {gyd(data.remainingThisMonth)}
          </div>
          <div className="ds-meta tnum">left of {gyd(data.monthlyCap)}</div>
        </div>
        <Progress
          value={usedPct}
          aria-label={`${gyd(data.usedThisMonth)} of ${gyd(data.monthlyCap)} used this month`}
          className="h-2.5 bg-[var(--surface-4)]"
        />
        <p className="ds-meta">
          {gyd(data.usedThisMonth)} of discount used this month, across all partners. Your allowance renews on the 1st.
        </p>
      </Panel>

      <section aria-labelledby="partners-title" className="flex flex-col gap-4">
        <SectionHead
          id="partners-title"
          title="Partners"
          sub={`Each coupon is single use and valid for ${data.couponTtlMinutes} minutes.`}
        />
        <AutoGrid min={260} gap={16}>
          {data.brands.map(({ brand, name }) => {
            const live = liveCoupon(brand);
            const pending = generate.isPending && generate.variables?.data.brand === brand;
            return (
              <article key={brand} className="ds-card flex min-w-0 flex-col gap-4 px-5 py-5" data-testid={`partner-${brand}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <IconTile icon={BRAND_ICONS[brand]} size={48} />
                    <div className="min-w-0">
                      <h3 className="ds-card-title truncate">{name}</h3>
                      <div className="ds-meta">Restaurant</div>
                    </div>
                  </div>
                  <StatusPill tone="brand" icon={TicketPercent}>
                    {data.discountPercent}% off
                  </StatusPill>
                </div>
                <p className="ds-meta">
                  {data.discountPercent}% off your bill, up to what is left of your monthly allowance.
                </p>
                {live ? (
                  <Button className="mt-auto" onClick={() => setShownId(live.id)} data-testid={`button-show-${brand}`}>
                    <QrCode aria-hidden="true" className="h-4 w-4" />
                    Show coupon
                  </Button>
                ) : (
                  <Button
                    className="mt-auto"
                    disabled={exhausted || generate.isPending}
                    onClick={() => handleGenerate(brand)}
                    data-testid={`button-generate-${brand}`}
                  >
                    {pending ? (
                      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                    ) : (
                      <TicketPercent aria-hidden="true" className="h-4 w-4" />
                    )}
                    {exhausted ? 'Allowance used up' : liveElsewhere(brand) ? 'Generate new coupon' : 'Generate coupon'}
                  </Button>
                )}
              </article>
            );
          })}

          {/* Not yet a partner on the POS integration. */}
          <article className="ds-card flex min-w-0 flex-col gap-4 px-5 py-5" data-testid="partner-sterling">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <IconTile icon={ShoppingBag} size={48} />
                <div className="min-w-0">
                  <h3 className="ds-card-title truncate">Sterling</h3>
                  <div className="ds-meta">Partner</div>
                </div>
              </div>
              <StatusPill tone="neutral" icon={Clock}>
                Coming soon
              </StatusPill>
            </div>
            <p className="ds-meta">Discount details will appear here.</p>
            <Button disabled className="mt-auto">
              <TicketPercent aria-hidden="true" className="h-4 w-4" />
              Generate coupon
            </Button>
          </article>
        </AutoGrid>
      </section>

      <CouponHistory
        cardToken={cardToken}
        codes={codes}
        brands={data.brands}
        currentMonth={data.month}
        watching={shownId != null}
        onShow={setShownId}
      />

      <CouponDialog
        coupon={shown}
        code={shown ? (codes[shown.id] ?? null) : null}
        brandName={shown ? brandName(shown.brand) : ''}
        onOpenChange={(open) => {
          if (!open) setShownId(null);
        }}
      />
    </MemberShell>
  );
}
