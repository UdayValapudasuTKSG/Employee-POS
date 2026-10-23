import { useEffect, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { gyd } from "../api";
import { Alert, StoreMark } from "../ui";
import { AdminHead, AdminLayout } from "./AdminLayout";
import { adminApi, type Kpis, type Metrics } from "./adminApi";
import { BarList, ColumnChart } from "./charts";

const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const gydWhole = (v: number) => `GYD ${WHOLE.format(Math.round(v))}`;
/** Axis ticks: "15k", "1.5k", "800". */
const compact = (v: number) => (v >= 1_000_000 ? `${+(v / 1_000_000).toFixed(1)}m` : v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${v}`);
const MONTH_FMT = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });
const SHORT_MONTH = new Intl.DateTimeFormat("en-GB", { month: "short" });
const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
const monthDate = (ym: string) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return new Date(y, m - 1, 1);
};
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function recentMonths(n = 12): string[] {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
}

export function AdminDashboard() {
  const [month, setMonth] = useState<string>(recentMonths(1)[0]!);
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    setError(false);
    adminApi
      .metrics(month)
      .then((d) => live && setM(d))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [month]);

  return (
    <AdminLayout>
      <AdminHead
        title="Dashboard"
        sub={m ? <>Staff discounts for {MONTH_FMT.format(monthDate(m.month))}{m.isCurrentMonth ? ", so far" : ""}. Months are Guyana time.</> : "Loading…"}
        action={
          <label className="flex items-center gap-2 text-sm font-semibold">
            Month
            <select className="field w-48" value={month} onChange={(e) => setMonth(e.target.value)} data-testid="month-select">
              {recentMonths().map((x) => (
                <option key={x} value={x}>
                  {MONTH_FMT.format(monthDate(x))}
                </option>
              ))}
            </select>
          </label>
        }
      />
      {error && <Alert>We could not load the figures. Refresh to try again.</Alert>}
      {!m && !error && <div className="h-96 animate-pulse rounded-2xl bg-line/60" />}
      {m && <Body m={m} />}
    </AdminLayout>
  );
}

function Body({ m }: { m: Metrics }) {
  const k = m.kpis.current;
  const p = m.kpis.previous;
  const avgBill = k.redemptions ? k.sales / k.redemptions : 0;
  const prevAvgBill = p.redemptions ? p.sales / p.redemptions : 0;
  const usedRate = pct(k.redemptions + k.voids, k.generated);
  const daily = m.days.map((d, i) => {
    const date = new Date(`${d.day}T12:00:00`);
    const day = date.getDate();
    return {
      label: d.day,
      tick: day === 1 || day % 5 === 0 ? String(day) : undefined,
      value: d.saved,
      tip: [date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }), `${gyd(d.saved)} saved`, `${d.redemptions} use${d.redemptions === 1 ? "" : "s"} · ${gyd(d.sales)} in bills`],
      key: i,
    };
  });

  return (
    <>
      {/* The month in numbers */}
      <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Saved by employees" value={gydWhole(k.saved)} now={k.saved} before={p.saved} hero />
        <Stat label="Bills paid with a code" value={gydWhole(k.sales)} now={k.sales} before={p.sales} />
        <Stat label="Codes used" value={WHOLE.format(k.redemptions)} now={k.redemptions} before={p.redemptions} />
        <Stat
          label="Employees who saved"
          value={WHOLE.format(k.employeesSaving)}
          note={`of ${WHOLE.format(m.employees.active)} active (${pct(k.employeesSaving, m.employees.active)}%)`}
          now={k.employeesSaving}
          before={p.employeesSaving}
        />
      </section>
      <section aria-label="More figures" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Small label="Average bill" value={gydWhole(avgBill)} now={avgBill} before={prevAvgBill} />
        <Small label="Codes generated" value={WHOLE.format(k.generated)} note={`${usedRate}% were used`} />
        <Small label="Expired unused" value={WHOLE.format(k.expiredUnused)} note={`${pct(k.expiredUnused, k.generated)}% of codes`} />
        <Small label="Signed in" value={WHOLE.format(k.signedIn)} note="employees this month" />
        <Small label="Reached the limit" value={WHOLE.format(k.atCap)} note={`used all ${gydWhole(m.terms.monthlyCap)}`} />
        <Small label="Voided sales" value={WHOLE.format(k.voids)} note={`${k.partial} part-discounts applied`} />
      </section>
      {m.isCurrentMonth && (
        <p className="-mt-2 text-sm text-muted">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-ok align-middle" aria-hidden="true" />
          {m.liveCodes} code{m.liveCodes === 1 ? " is" : "s are"} live right now, waiting to be used.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title="Saved each day" sub="GYD of discount given, by day" className="lg:col-span-2">
          <ColumnChart data={daily} format={compact} title="Discount given each day" valueLabel="Saved (GYD)" />
        </Panel>
        <Panel title="How much of the allowance employees used" sub={`Active employees, by share of ${gydWhole(m.terms.monthlyCap)}`}>
          <ColumnChart
            height={220}
            data={m.allowanceUse.map((b) => ({ label: b.label, tick: b.label, value: b.employees, tip: [b.label, `${b.employees} employee${b.employees === 1 ? "" : "s"}`] }))}
            format={(v) => WHOLE.format(v)}
            title="Employees by share of allowance used"
            valueLabel="Employees"
          />
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="By store" sub="Discount given this month" action={<Link href="/admin/discounts" className="text-sm font-semibold text-brand">Change discounts</Link>}>
          <BarList
            title="Discount given by store"
            valueLabel="Saved"
            data={m.stores.map((s) => ({
              key: s.store,
              text: s.name,
              label: (
                <span className="flex min-w-0 items-center gap-2">
                  <StoreMark store={s.store} size={30} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{s.name}</span>
                    <span className="block text-xs text-muted">{s.enabled ? `${s.percent}% off` : "Switched off"}</span>
                  </span>
                </span>
              ),
              value: s.saved,
              display: gydWhole(s.saved),
              detail: `${s.redemptions} uses, ${gyd(s.sales)} in bills`,
              muted: !s.enabled,
            }))}
          />
          <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[30rem] text-sm tnum">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 font-semibold">Store</th>
                <th className="py-2 text-right font-semibold">Uses</th>
                <th className="py-2 text-right font-semibold">Bills</th>
                <th className="py-2 text-right font-semibold">Avg bill</th>
                <th className="py-2 text-right font-semibold">Employees</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {m.stores.map((s) => (
                <tr key={s.store}>
                  <td className="py-2">{s.name}</td>
                  <td className="py-2 text-right">{s.redemptions}</td>
                  <td className="py-2 text-right">{gydWhole(s.sales)}</td>
                  <td className="py-2 text-right">{gydWhole(s.averageBill)}</td>
                  <td className="py-2 text-right">{s.employees}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Panel>
        <Panel title="Last six months" sub="GYD of discount given, by month">
          <ColumnChart
            data={m.months.map((x) => ({
              label: MONTH_FMT.format(monthDate(x.month)),
              tick: SHORT_MONTH.format(monthDate(x.month)),
              value: x.saved,
              tip: [MONTH_FMT.format(monthDate(x.month)), `${gyd(x.saved)} saved`, `${x.redemptions} uses · ${gyd(x.sales)} in bills`],
            }))}
            format={compact}
            title="Discount given by month"
            valueLabel="Saved (GYD)"
          />
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="When codes are used" sub="Uses by hour of day, Guyana time">
          <ColumnChart
            height={200}
            data={m.hours.map((h) => {
              const label = new Date(2000, 0, 1, h.hour).toLocaleTimeString("en-US", { hour: "numeric", hour12: true });
              return { label, tick: h.hour % 3 === 0 ? label.replace(" ", "").toLowerCase() : undefined, value: h.redemptions, tip: [`${label}–${new Date(2000, 0, 1, h.hour + 1).toLocaleTimeString("en-US", { hour: "numeric", hour12: true })}`, `${h.redemptions} use${h.redemptions === 1 ? "" : "s"}`] };
            })}
            format={(v) => WHOLE.format(v)}
            title="Codes used by hour of day"
            valueLabel="Uses"
          />
        </Panel>
        <Panel title="Top savers" sub="Employees who saved the most this month">
          {m.topEmployees.length === 0 ? (
            <p className="text-muted">No codes used this month yet.</p>
          ) : (
            <table className="w-full text-sm tnum">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 font-semibold">Employee</th>
                  <th className="py-2 text-right font-semibold">Uses</th>
                  <th className="py-2 text-right font-semibold">Saved</th>
                  <th className="py-2 text-right font-semibold">Of limit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {m.topEmployees.map((e) => (
                  <tr key={e.id}>
                    <td className="py-2">
                      <span className="font-semibold">{e.name}</span>
                      <span className="block text-xs text-muted">{e.employeeNumber ?? e.email}</span>
                    </td>
                    <td className="py-2 text-right">{e.redemptions}</td>
                    <td className="py-2 text-right font-semibold">{gydWhole(e.saved)}</td>
                    <td className="py-2 text-right">{pct(e.saved, m.terms.monthlyCap)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel title="Latest sales" sub="The most recent codes used this month">
        {m.recent.length === 0 ? (
          <p className="text-muted">No codes used this month yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm tnum">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 font-semibold">When</th>
                  <th className="py-2 font-semibold">Store</th>
                  <th className="py-2 font-semibold">Employee</th>
                  <th className="py-2 text-right font-semibold">Bill</th>
                  <th className="py-2 text-right font-semibold">Discount</th>
                  <th className="py-2 text-right font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {m.recent.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap py-2.5">{WHEN.format(new Date(r.at))}</td>
                    <td className="py-2.5">
                      <span className="flex items-center gap-2">
                        <StoreMark store={r.store} size={26} />
                        <span>
                          {r.storeName}
                          {r.storeLocation && <span className="block text-xs text-muted">{r.storeLocation}</span>}
                        </span>
                      </span>
                    </td>
                    <td className="py-2.5">{r.employee}</td>
                    <td className="py-2.5 text-right">{gyd(r.billAmount)}</td>
                    <td className="py-2.5 text-right">
                      {gyd(r.discountAmount)}
                      <span className="block text-xs text-muted">{r.percent != null ? `${r.percent}%` : ""}{r.partial ? " · part" : ""}</span>
                    </td>
                    <td className="py-2.5 text-right">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${r.status === "VOIDED" ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok"}`}>
                        {r.status === "VOIDED" ? "Voided" : "Used"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

/** Change against last month, as a word and an arrow: never colour alone, and no good/bad judgement. */
function Delta({ now, before }: { now: number; before: number }) {
  if (before === 0 && now === 0) return <span className="text-muted">No change on last month</span>;
  if (before === 0) return <span className="text-muted">New this month</span>;
  const change = Math.round(((now - before) / before) * 100);
  if (change === 0) return <span className="text-muted">Same as last month</span>;
  return (
    <span className="text-muted">
      <span aria-hidden="true">{change > 0 ? "▲" : "▼"}</span> {Math.abs(change)}% {change > 0 ? "up" : "down"} on last month
    </span>
  );
}

function Stat({ label, value, note, now, before, hero = false }: { label: string; value: string; note?: string; now: number; before: number; hero?: boolean }) {
  return (
    <div className={`rounded-2xl border p-5 ${hero ? "border-brand-deep bg-brand-deep text-white" : "border-line bg-card"}`}>
      <p className={`text-xs font-bold uppercase tracking-[0.12em] ${hero ? "text-white/70" : "text-muted"}`}>{label}</p>
      <p className="mt-2 font-display text-3xl font-extrabold">{value}</p>
      {note && <p className={`text-sm ${hero ? "text-white/75" : "text-muted"}`}>{note}</p>}
      <p className={`mt-2 text-sm ${hero ? "[&_*]:text-white/75" : ""}`}>
        <Delta now={now} before={before} />
      </p>
    </div>
  );
}

function Small({ label, value, note, now, before }: { label: string; value: string; note?: string; now?: number; before?: number }) {
  return (
    <div className="rounded-xl border border-line bg-card px-4 py-3">
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className="mt-1 text-xl font-bold tnum">{value}</p>
      <p className="text-xs text-muted">{note ?? (now != null && before != null ? <Delta now={now} before={before} /> : null)}</p>
    </div>
  );
}

function Panel({ title, sub, action, className = "", children }: { title: string; sub?: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`card min-w-0 p-5 sm:p-6 ${className}`} aria-label={title}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">{title}</h2>
          {sub && <p className="text-sm text-muted">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
