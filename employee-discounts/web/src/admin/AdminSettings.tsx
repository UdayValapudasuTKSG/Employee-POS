import { useEffect, useState } from "react";
import { ApiError, gyd } from "../api";
import { Alert, StoreLogo } from "../ui";
import { AdminHead, AdminLayout } from "./AdminLayout";
import { adminApi, type Settings, type StoreSetting } from "./adminApi";

const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

/** What the form holds: numbers as typed, so a half-typed value is not lost. */
interface Draft {
  monthlyCap: string;
  codeTtlMinutes: string;
  stores: (Omit<StoreSetting, "percent" | "monthlyCap"> & { percent: string; monthlyCap: string })[];
}

const toDraft = (s: Settings): Draft => ({
  monthlyCap: String(s.monthlyCap),
  codeTtlMinutes: String(s.codeTtlMinutes),
  stores: s.stores.map((x) => ({ ...x, percent: String(x.percent), monthlyCap: x.monthlyCap == null ? "" : String(x.monthlyCap) })),
});

const twoDecimals = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim());

/** Every problem with the draft, by field; empty when it can be saved. */
function problems(d: Draft): Record<string, string> {
  const p: Record<string, string> = {};
  if (!twoDecimals(d.monthlyCap)) p["monthlyCap"] = "Enter an amount in GYD, like 15000.";
  if (!/^\d+$/.test(d.codeTtlMinutes) || +d.codeTtlMinutes < 1 || +d.codeTtlMinutes > 1440) p["codeTtlMinutes"] = "Between 1 and 1440 minutes.";
  for (const s of d.stores) {
    if (!twoDecimals(s.percent) || +s.percent <= 0 || +s.percent > 100) p[`${s.store}.percent`] = "Between 0.01 and 100.";
    if (s.monthlyCap.trim() !== "" && !twoDecimals(s.monthlyCap)) p[`${s.store}.monthlyCap`] = "An amount in GYD, or leave it empty.";
  }
  return p;
}

export function AdminSettings() {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  useEffect(() => {
    adminApi
      .settings()
      .then((s) => {
        setSaved(s);
        setDraft(toDraft(s));
      })
      .catch(() => setNotice({ tone: "danger", text: "We could not load the settings. Refresh to try again." }));
  }, []);

  const errors = draft ? problems(draft) : {};
  const dirty = draft && saved ? JSON.stringify(draft) !== JSON.stringify(toDraft(saved)) : false;

  const setStore = (store: string, patch: Partial<Draft["stores"][number]>) =>
    setDraft((d) => d && { ...d, stores: d.stores.map((s) => (s.store === store ? { ...s, ...patch } : s)) });

  const save = async () => {
    if (!draft || Object.keys(errors).length) return;
    setBusy(true);
    setNotice(null);
    try {
      const s = await adminApi.saveSettings({
        monthlyCap: +draft.monthlyCap,
        codeTtlMinutes: +draft.codeTtlMinutes,
        stores: draft.stores.map((x) => ({ store: x.store, name: x.name, enabled: x.enabled, percent: +x.percent, monthlyCap: x.monthlyCap.trim() === "" ? null : +x.monthlyCap })),
      });
      setSaved(s);
      setDraft(toDraft(s));
      setNotice({ tone: "ok", text: "Saved. The new discounts apply to the next code used at the till." });
    } catch (err) {
      setNotice({ tone: "danger", text: err instanceof ApiError ? err.message : "Could not save. Try again." });
    } finally {
      setBusy(false);
    }
  };

  const enabledCount = draft?.stores.filter((s) => s.enabled).length ?? 0;

  return (
    <AdminLayout>
      <AdminHead
        title="Discounts"
        sub="What each partner gives, and how much an employee can save in a month. Changes apply straight away."
        action={
          <div className="flex items-center gap-3">
            {dirty && <span className="text-sm text-muted">Unsaved changes</span>}
            <button type="button" className="btn-ghost" disabled={!dirty || busy} onClick={() => saved && setDraft(toDraft(saved))}>
              Undo
            </button>
            <button type="button" className="btn-primary" disabled={!dirty || busy || Object.keys(errors).length > 0} onClick={save} data-testid="save-settings">
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        }
      />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {!draft && !notice && <div className="h-80 animate-pulse rounded-2xl bg-line/60" />}

      {draft && (
        <>
          <section className="card grid gap-6 p-6 md:grid-cols-2" aria-label="Every store">
            <Field
              id="monthlyCap"
              label="Monthly allowance per employee"
              hint="The most one employee can save in a calendar month, all partners together. Renews on the 1st, Guyana time."
              prefix="GYD"
              value={draft.monthlyCap}
              error={errors["monthlyCap"]}
              onChange={(v) => setDraft({ ...draft, monthlyCap: v })}
            />
            <Field
              id="codeTtlMinutes"
              label="How long a code lasts"
              hint="From when the employee gets it. An unused code expires and nothing is taken from the allowance."
              suffix="minutes"
              value={draft.codeTtlMinutes}
              error={errors["codeTtlMinutes"]}
              onChange={(v) => setDraft({ ...draft, codeTtlMinutes: v })}
            />
          </section>

          {enabledCount === 0 && <Alert>Every partner is switched off: employees cannot get or use codes until one is switched on.</Alert>}

          <section aria-label="Partners" className="grid gap-4 lg:grid-cols-2">
            {draft.stores.map((s) => {
              const example = 10000;
              const pctOk = !errors[`${s.store}.percent`];
              return (
                <div key={s.store} className={`card flex flex-col gap-5 p-6 ${s.enabled ? "" : "bg-paper"}`} data-testid={`store-${s.store}`}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-4">
                      <div className="grid h-14 w-24 shrink-0 place-items-center rounded-xl border border-line bg-white px-2">
                        <StoreLogo store={s.store} name={s.name} height={s.store === "STERLING" ? 22 : 36} />
                      </div>
                      <h2 className="truncate text-xl font-bold">{s.name}</h2>
                    </div>
                    <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm font-semibold">
                      <span>{s.enabled ? "Taking codes" : "Switched off"}</span>
                      <input
                        type="checkbox"
                        role="switch"
                        className="peer sr-only"
                        checked={s.enabled}
                        onChange={(e) => setStore(s.store, { enabled: e.target.checked })}
                        aria-label={`${s.name} takes codes`}
                      />
                      <span aria-hidden="true" className={`relative h-6 w-11 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand ${s.enabled ? "bg-ok" : "bg-line"}`}>
                        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${s.enabled ? "left-[22px]" : "left-0.5"}`} />
                      </span>
                    </label>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      id={`${s.store}-percent`}
                      label="Discount"
                      suffix="%"
                      value={s.percent}
                      error={errors[`${s.store}.percent`]}
                      onChange={(v) => setStore(s.store, { percent: v })}
                    />
                    <Field
                      id={`${s.store}-cap`}
                      label="Own monthly limit"
                      prefix="GYD"
                      placeholder="None"
                      hint="Optional. Inside the overall allowance."
                      value={s.monthlyCap}
                      error={errors[`${s.store}.monthlyCap`]}
                      onChange={(v) => setStore(s.store, { monthlyCap: v })}
                    />
                  </div>
                  <p className="text-sm text-muted">
                    {s.enabled && pctOk
                      ? <>On a {gyd(example)} bill an employee saves <b className="text-ink">{gyd((example * +s.percent) / 100)}</b>{s.monthlyCap.trim() !== "" ? <>, up to {gyd(+s.monthlyCap || 0)} a month here</> : null}.</>
                      : s.enabled ? "Enter a percentage to see an example." : "Codes are refused at this store's tills while it is switched off."}
                  </p>
                </div>
              );
            })}
          </section>

          {saved?.updatedAt && (
            <p className="text-sm text-muted">
              Last changed {WHEN.format(new Date(saved.updatedAt))}{saved.updatedBy ? ` by ${saved.updatedBy}` : ""}.
            </p>
          )}
        </>
      )}
    </AdminLayout>
  );
}

function Field({
  id, label, hint, prefix, suffix, placeholder, value, error, onChange,
}: {
  id: string; label: string; hint?: string; prefix?: string; suffix?: string; placeholder?: string; value: string; error?: string; onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">{label}</label>
      <div className={`flex items-center rounded-xl border bg-card focus-within:border-ink ${error ? "border-danger" : "border-line"}`}>
        {prefix && <span className="pl-4 text-sm font-semibold text-muted">{prefix}</span>}
        <input
          id={id}
          inputMode="decimal"
          className="min-h-12 w-full min-w-0 rounded-xl bg-transparent px-3 text-ink outline-none tnum"
          value={value}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && <span className="pr-4 text-sm font-semibold text-muted">{suffix}</span>}
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger">{error}</p>
      ) : (
        hint && <p id={`${id}-hint`} className="text-sm text-muted">{hint}</p>
      )}
    </div>
  );
}
