import { useEffect, useState, type FormEvent } from "react";
import { ApiError, gyd } from "../api";
import { Alert } from "../ui";
import { AdminHead, AdminLayout } from "./AdminLayout";
import { adminApi, type EmployeePage } from "./adminApi";

const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function AdminEmployees() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"" | "active" | "inactive">("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<EmployeePage | null>(null);
  const [error, setError] = useState(false);
  const [adding, setAdding] = useState(false);
  const [reload, setReload] = useState(0);

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let live = true;
    adminApi
      .employees({ search: query || undefined, status: status || undefined, page })
      .then((d) => live && (setData(d), setError(false)))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [query, status, page, reload]);

  const toggle = async (id: number, active: boolean) => {
    await adminApi.setActive(id, active).catch(() => undefined);
    setReload((r) => r + 1);
  };

  const totalPages = Math.max(1, data?.totalPages ?? 1);

  return (
    <AdminLayout>
      <AdminHead
        title="Employees"
        sub="Who can sign in and get a code. A deactivated employee is signed out and their code stops working at the till."
        action={
          <button type="button" className="btn-primary" onClick={() => setAdding((a) => !a)} data-testid="add-employee">
            {adding ? "Close" : "Add an employee"}
          </button>
        }
      />
      {adding && <AddEmployee onAdded={() => { setAdding(false); setReload((r) => r + 1); }} />}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input className="field sm:max-w-sm" placeholder="Search by name, email or number" aria-label="Search employees" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="field sm:w-44" aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setPage(1); }}>
          <option value="">Everyone</option>
          <option value="active">Active</option>
          <option value="inactive">Deactivated</option>
        </select>
      </div>

      {error && <Alert>We could not load the employees. Refresh to try again.</Alert>}
      {data && (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm tnum">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-5 py-3 font-semibold">Employee</th>
                <th className="px-3 py-3 font-semibold">Number</th>
                <th className="px-3 py-3 text-right font-semibold">Saved this month</th>
                <th className="px-3 py-3 text-right font-semibold">Codes used</th>
                <th className="px-3 py-3 font-semibold">Last used</th>
                <th className="px-5 py-3 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-muted">{query || status ? "No employees match." : "No employees yet. Add the first one."}</td>
                </tr>
              )}
              {data.items.map((e) => (
                <tr key={e.id} className={e.active ? "" : "text-muted"}>
                  <td className="px-5 py-3">
                    <span className="font-semibold text-ink">{e.firstName} {e.lastName}</span>
                    <span className="block text-xs text-muted">{e.email}</span>
                  </td>
                  <td className="px-3 py-3">{e.employeeNumber ?? "–"}</td>
                  <td className="px-3 py-3 text-right font-semibold">{gyd(e.savedThisMonth)}</td>
                  <td className="px-3 py-3 text-right">{e.codesUsedThisMonth}</td>
                  <td className="px-3 py-3">{e.lastUsedAt ? WHEN.format(new Date(e.lastUsedAt)) : "Never"}</td>
                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => toggle(e.id, !e.active)}
                      className={`rounded-full px-3 py-1 text-xs font-bold ${e.active ? "bg-ok-soft text-ok hover:bg-danger-soft hover:text-danger" : "bg-paper text-muted ring-1 ring-line hover:bg-ok-soft hover:text-ok"}`}
                      title={e.active ? "Deactivate" : "Reactivate"}
                    >
                      {e.active ? "Active" : "Deactivated"}
                      <span className="sr-only">{e.active ? ", deactivate" : ", reactivate"}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">Page {Math.min(page, totalPages)} of {totalPages} · {data.totalItems} employee{data.totalItems === 1 ? "" : "s"}</p>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost min-h-10 px-4 text-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Previous</button>
            <button type="button" className="btn-ghost min-h-10 px-4 text-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next →</button>
          </div>
        </nav>
      )}
    </AdminLayout>
  );
}

function AddEmployee({ onAdded }: { onAdded: () => void }) {
  const [f, setF] = useState({ email: "", firstName: "", lastName: "", employeeNumber: "", company: "Edward B. Beharry & Company Ltd" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.addEmployee({ ...f, employeeNumber: f.employeeNumber || undefined });
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the employee.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card grid gap-4 p-6 md:grid-cols-2" aria-label="Add an employee">
      <label className="flex flex-col gap-1.5 md:col-span-2" htmlFor="new-email">
        <span className="text-sm font-semibold">Work email</span>
        <input id="new-email" type="email" className="field" value={f.email} onChange={set("email")} required />
      </label>
      <label className="flex flex-col gap-1.5" htmlFor="new-first">
        <span className="text-sm font-semibold">First name</span>
        <input id="new-first" className="field" value={f.firstName} onChange={set("firstName")} required />
      </label>
      <label className="flex flex-col gap-1.5" htmlFor="new-last">
        <span className="text-sm font-semibold">Last name</span>
        <input id="new-last" className="field" value={f.lastName} onChange={set("lastName")} required />
      </label>
      <label className="flex flex-col gap-1.5" htmlFor="new-number">
        <span className="text-sm font-semibold">Employee number <span className="font-normal text-muted">(optional)</span></span>
        <input id="new-number" className="field" value={f.employeeNumber} onChange={set("employeeNumber")} />
      </label>
      <label className="flex flex-col gap-1.5" htmlFor="new-company">
        <span className="text-sm font-semibold">Company</span>
        <input id="new-company" className="field" value={f.company} onChange={set("company")} />
      </label>
      {error && <div className="md:col-span-2"><Alert>{error}</Alert></div>}
      <div className="md:col-span-2">
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Adding…" : "Add employee"}</button>
      </div>
    </form>
  );
}
