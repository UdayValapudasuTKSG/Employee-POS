import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "react-qr-code";
import { useLocation } from "wouter";
import {
  api,
  ApiError,
  gyd,
  gydShort,
  type CodeStatus,
  type HistoryFilters,
  type HistoryItem,
  type HistoryPage,
  type Me,
  type SentOtp,
  type StoreId,
} from "../api";
import { Alert, Logo, Modal, OtpInput, StoreMark, StoreStrip, mmss, useNow } from "../ui";

const MONTH_FMT = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });
const WHEN_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return MONTH_FMT.format(new Date(y, m - 1, 1));
};

export function Dashboard() {
  const [, navigate] = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [justUsed, setJustUsed] = useState<HistoryItem | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const watching = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const m = await api.me();
      // The code on screen was used at a till since the last look.
      if (watching.current && !m.activeCode && m.latestCode?.id === watching.current && m.latestCode.status === "REDEEMED") {
        setJustUsed(m.latestCode);
        setHistoryKey((k) => k + 1);
      }
      watching.current = m.activeCode?.id ?? null;
      setMe(m);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate("/signin");
      else setLoadError("We could not load your discount just now. Check your connection and try again.");
    }
  }, [navigate]);

  useEffect(() => {
    void load();
  }, [load]);
  // While a code is live, watch for the till using it.
  useEffect(() => {
    if (!me?.activeCode) return;
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [me?.activeCode, load]);

  const signOut = async () => {
    await api.signOut().catch(() => undefined);
    navigate("/");
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Logo />
          <div className="flex items-center gap-3">
            {me && <span className="hidden text-[15px] text-muted sm:inline">{me.employee.firstName} {me.employee.lastName}</span>}
            <button type="button" onClick={signOut} className="btn-ghost min-h-10 px-4 text-[15px]">Sign out</button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
        {loadError && <Alert>{loadError}</Alert>}
        {!me && !loadError && (
          <div role="status" className="grid gap-6 lg:grid-cols-[1.25fr_1fr]">
            <span className="sr-only">Loading…</span>
            <div className="h-96 animate-pulse rounded-2xl bg-line/60" />
            <div className="h-64 animate-pulse rounded-2xl bg-line/60" />
          </div>
        )}
        {me && (
          <>
            <div>
              <span className="eyebrow">{me.employee.company}</span>
              <h1 className="mt-1 text-3xl font-bold sm:text-4xl">Hi {me.employee.firstName}</h1>
            </div>

            {justUsed && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-ok-soft px-5 py-4 text-ok" role="status">
                {justUsed.store && <StoreMark store={justUsed.store} size={40} />}
                <p className="min-w-0 flex-1 font-semibold">
                  Your code was used at {justUsed.storeName}. You saved {gyd(justUsed.discountAmount ?? 0)} on {gyd(justUsed.billAmount ?? 0)}.
                </p>
                <button type="button" className="text-sm font-semibold underline" onClick={() => setJustUsed(null)}>Dismiss</button>
              </div>
            )}

            <div className="grid items-start gap-6 lg:grid-cols-[1.25fr_1fr]">
              <CodeCard me={me} onChanged={() => { void load(); setHistoryKey((k) => k + 1); }} />
              <AllowanceCard me={me} />
            </div>

            <History stores={me.stores} currentMonth={me.allowance.month} refreshKey={historyKey} />
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The one code
// ---------------------------------------------------------------------------

function CodeCard({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [asking, setAsking] = useState(false);
  const [emailedTo, setEmailedTo] = useState<string | null>(null);
  const live = me.activeCode;
  const now = useNow(live != null);
  const left = live ? new Date(live.expiresAt).getTime() - now : 0;
  const exhausted = me.allowance.remaining <= 0;

  return (
    <section aria-labelledby="code-title" className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-4">
        <h2 id="code-title" className="text-xl font-bold">Your discount code</h2>
        <span className="rounded-full bg-brand px-3 py-1 text-sm font-bold text-white">{me.allowance.samePercent ? `${me.allowance.percent}% off` : `Up to ${me.allowance.percent}% off`}</span>
      </div>

      {live && left > 0 ? (
        <div className="grid gap-6 p-6 sm:grid-cols-[auto_1fr] sm:items-center">
          <div className="mx-auto rounded-2xl border border-line bg-white p-4">
            <QRCode value={live.code} size={196} level="M" aria-label={`QR code for ${live.code}`} />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <p className="whitespace-nowrap font-mono text-[clamp(1.35rem,2.4vw,1.8rem)] font-bold tracking-[0.08em] tnum" data-testid="live-code">{live.code}</p>
            <p className="text-muted">
              Show this at the counter. Valid for <b className="tnum text-ink">{mmss(left)}</b>, at any one of:
            </p>
            <ul className="flex flex-wrap gap-2">
              {me.stores.map((s) => (
                <li key={s.id} className="flex items-center gap-2 rounded-xl border border-line bg-white py-1 pl-1 pr-3 text-sm font-medium">
                  <StoreMark store={s.id} size={30} />
                  {s.name}
                  <span className="font-bold text-brand-dark">{s.percent}%</span>
                  {s.remaining != null && <span className="text-muted">· {gyd(s.remaining)} left here</span>}
                </li>
              ))}
            </ul>
            {emailedTo && <p className="text-sm text-ok">A copy with the QR code was emailed to {emailedTo}.</p>}
            <button type="button" className="btn-ghost mt-1 self-start" onClick={() => setAsking(true)} disabled={exhausted}>
              Replace with a new code
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-4 p-6 sm:p-8">
          <StoreStrip stores={me.stores} size={44} label="Use your code at" />
          <p className="max-w-md text-muted">
            {exhausted
              ? "You have used this month's allowance. It renews on the 1st."
              : `Get a code when you're ready to pay. It works once, at any of our ${me.stores.length} stores, for ${me.codeTtlMinutes} minutes.`}
          </p>
          <button type="button" className="btn-primary px-6" onClick={() => setAsking(true)} disabled={exhausted} data-testid="button-get-code">
            Get my code
          </button>
        </div>
      )}

      <GetCodeModal
        open={asking}
        replacing={Boolean(live && left > 0)}
        onClose={() => setAsking(false)}
        onCreated={(to) => {
          setAsking(false);
          setEmailedTo(to);
          onChanged();
        }}
      />
    </section>
  );
}

function GetCodeModal({ open, replacing, onClose, onCreated }: { open: boolean; replacing: boolean; onClose: () => void; onCreated: (emailedTo: string | null) => void }) {
  const [sent, setSent] = useState<(SentOtp & { sentAt: number }) | null>(null);
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(open && sent != null);

  const request = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.requestCodeOtp();
      setSent({ ...s, sentAt: Date.now() });
      setOtp("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again shortly.");
    } finally {
      setBusy(false);
    }
  }, []);

  // Opening the dialog sends the confirmation code.
  useEffect(() => {
    if (open) void request();
    else {
      setSent(null);
      setError(null);
      setOtp("");
    }
  }, [open, request]);

  const confirm = async (code: string) => {
    if (!sent || code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.generateCode(sent.challengeId, code);
      onCreated(r.emailedTo);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again shortly.");
      setOtp("");
    } finally {
      setBusy(false);
    }
  };

  const resendIn = sent ? Math.ceil((sent.sentAt + sent.resendAfterSeconds * 1000 - Math.max(now, sent.sentAt)) / 1000) : 0;

  return (
    <Modal open={open} onClose={onClose} title="Confirm it's you">
      <div className="flex flex-col gap-4" data-testid="code-otp-dialog">
        <p className="text-muted">
          {sent ? (
            <>We sent a 6-digit code to <b className="font-semibold text-ink">{sent.maskedEmail}</b>. Enter it to get your discount code.</>
          ) : busy ? "Sending you a code…" : "We need to send you a code first."}
        </p>
        {replacing && <Alert tone="info">Your current code will stop working when the new one is made.</Alert>}
        {sent?.devCode && <Alert tone="info">Development mode: your code is <b className="font-mono">{sent.devCode}</b></Alert>}
        {sent && <OtpInput id="code-otp" value={otp} onChange={setOtp} onComplete={confirm} disabled={busy} />}
        {error && <Alert>{error}</Alert>}
        <button type="button" className="btn-primary w-full" disabled={!sent || busy || otp.length !== 6} onClick={() => confirm(otp)} data-testid="button-confirm-code">
          {busy && sent ? "Getting your code…" : "Get my code"}
        </button>
        <button type="button" className="text-sm font-semibold text-brand disabled:text-muted" disabled={resendIn > 0 || busy} onClick={request}>
          {resendIn > 0 ? `Send a new code in ${resendIn}s` : "Send a new code"}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The allowance
// ---------------------------------------------------------------------------

function AllowanceCard({ me }: { me: Me }) {
  const a = me.allowance;
  const usedPct = a.monthlyCap > 0 ? Math.min(100, (a.used / a.monthlyCap) * 100) : 100;
  return (
    <section aria-labelledby="allowance-title" className="card p-6">
      <h2 id="allowance-title" className="text-xl font-bold">Your allowance for {monthLabel(a.month)}</h2>
      <p className="mt-4 font-display text-4xl font-extrabold tnum" data-testid="allowance-remaining">{gyd(a.remaining)}</p>
      <p className="text-muted">left of {gydShort(a.monthlyCap)}</p>
      <div className="mt-4 h-3 overflow-hidden rounded-full bg-brand-soft" role="progressbar" aria-valuemin={0} aria-valuemax={a.monthlyCap} aria-valuenow={a.used} aria-label="Allowance used">
        <div className="h-full rounded-full bg-brand" style={{ width: `${usedPct}%` }} />
      </div>
      <p className="mt-3 text-sm text-muted">
        {gyd(a.used)} saved this month across all stores. Renews at midnight on the 1st, Guyana time.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// History: filtered and paged
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<CodeStatus, { label: string; cls: string }> = {
  ACTIVE: { label: "Ready to use", cls: "bg-accent-soft text-ink" },
  REDEEMED: { label: "Used", cls: "bg-ok-soft text-ok" },
  EXPIRED: { label: "Expired", cls: "bg-paper text-muted border border-line" },
  VOIDED: { label: "Sale voided", cls: "bg-danger-soft text-danger" },
  REPLACED: { label: "Replaced", cls: "bg-paper text-muted border border-line" },
};

function recentMonths(current: string, n = 12): string[] {
  const [y, m] = current.split("-").map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(y, m - 1 - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
}

const PAGE_SIZE = 10;

function History({ stores, currentMonth, refreshKey }: { stores: Me["stores"]; currentMonth: string; refreshKey: number }) {
  const [filters, setFilters] = useState<HistoryFilters>({ page: 1, pageSize: PAGE_SIZE });
  const [data, setData] = useState<HistoryPage | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .history(filters)
      .then((d) => live && (setData(d), setError(false)))
      .catch(() => live && setError(true))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [filters, refreshKey]);

  const set = (patch: Partial<HistoryFilters>) => setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  const filtered = Boolean(filters.store || filters.status || filters.month);
  const totalPages = Math.max(1, data?.totalPages ?? 1);
  const page = Math.min(filters.page, totalPages);

  return (
    <section aria-labelledby="history-title" className="flex flex-col gap-4">
      <h2 id="history-title" className="text-2xl font-bold">Your codes</h2>
      <div role="group" aria-label="Filter your codes" className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <select aria-label="Store" className="field sm:w-52" value={filters.store ?? ""} onChange={(e) => set({ store: (e.target.value || undefined) as StoreId | undefined })} data-testid="filter-store">
          <option value="">All stores</option>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select aria-label="Status" className="field sm:w-44" value={filters.status ?? ""} onChange={(e) => set({ status: (e.target.value || undefined) as CodeStatus | undefined })} data-testid="filter-status">
          <option value="">All statuses</option>
          {(Object.keys(STATUS_LABEL) as CodeStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s].label}</option>)}
        </select>
        <select aria-label="Month" className="field sm:w-48" value={filters.month ?? ""} onChange={(e) => set({ month: e.target.value || undefined })} data-testid="filter-month">
          <option value="">All months</option>
          {recentMonths(currentMonth).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        {filtered && (
          <button type="button" className="self-start px-2 py-2 text-sm font-semibold text-brand sm:self-auto" onClick={() => setFilters({ page: 1, pageSize: PAGE_SIZE })}>
            Clear filters
          </button>
        )}
      </div>

      {error ? (
        <Alert>We could not load your codes just now. Try again in a moment.</Alert>
      ) : !data ? (
        <div className="h-48 animate-pulse rounded-2xl bg-line/60" />
      ) : data.totalItems === 0 ? (
        <div className="card flex flex-col items-start gap-2 border-dashed p-8">
          <p className="font-display text-lg font-bold">{filtered ? "No codes match these filters" : "No codes yet"}</p>
          <p className="text-muted">{filtered ? "Try another store, status or month." : "Codes you get will be listed here, with what you saved."}</p>
        </div>
      ) : (
        <ul className={`card divide-y divide-line px-5 transition-opacity ${loading ? "opacity-60" : ""}`} data-testid="history-list">
          {data.items.map((c) => {
            const st = STATUS_LABEL[c.status];
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  {c.store ? <StoreMark store={c.store} size={40} /> : <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-xl border border-dashed border-line text-muted">–</span>}
                  <div className="min-w-0">
                    <p className="font-semibold">{c.storeName ?? "Not used"}{c.storeLocation ? <span className="font-normal text-muted"> · {c.storeLocation}</span> : null}</p>
                    <p className="text-sm text-muted">
                      {c.redeemedAt ? `Used ${WHEN_FMT.format(new Date(c.redeemedAt))}` : `Created ${WHEN_FMT.format(new Date(c.createdAt))}`}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {c.discountAmount != null && (
                    <span className="font-semibold tnum">
                      Saved {gyd(c.discountAmount)}
                      <span className="font-normal text-muted"> on {gyd(c.billAmount ?? 0)}</span>
                    </span>
                  )}
                  <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-bold ${st.cls}`}>{st.label}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {data && (
        <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted tnum" data-testid="page-status">
            Page {page} of {totalPages} · {data.totalItems} code{data.totalItems === 1 ? "" : "s"}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost min-h-10 px-4 text-sm" disabled={page <= 1} onClick={() => set({ page: page - 1 })} data-testid="button-prev">
              ← Previous
            </button>
            <button type="button" className="btn-ghost min-h-10 px-4 text-sm" disabled={page >= totalPages} onClick={() => set({ page: page + 1 })} data-testid="button-next">
              Next →
            </button>
          </div>
        </nav>
      )}
    </section>
  );
}
