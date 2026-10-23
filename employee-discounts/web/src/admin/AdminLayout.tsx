import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ApiError } from "../api";
import { adminApi } from "./adminApi";

const NAV = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/discounts", label: "Discounts" },
  { href: "/admin/employees", label: "Employees" },
];

/** The admin frame: the session check, the black bar with the sections, and the page. */
export function AdminLayout({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .me()
      .then((m) => setEmail(m.email))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) navigate("/admin/signin");
      });
  }, [navigate]);

  const signOut = async () => {
    await adminApi.logout().catch(() => undefined);
    navigate("/admin/signin");
  };

  return (
    <div className="min-h-screen">
      <header className="bg-brand-deep text-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 pt-3 sm:px-6">
          <Link href="/admin" className="flex items-center gap-3 rounded-lg" aria-label="Admin dashboard">
            <img src="/logos/beharry-white.png" alt="Beharry" className="h-9 w-auto" width={95} height={36} />
            <span aria-hidden="true" className="h-7 w-px bg-white/30" />
            <span className="font-display text-[15px] font-bold leading-[1.1]">
              Staff Discounts
              <br />
              <span className="text-brand">Admin</span>
            </span>
          </Link>
          <div className="flex items-center gap-3 text-sm">
            {email && <span className="hidden text-white/70 sm:inline">{email}</span>}
            <button type="button" onClick={signOut} className="rounded-lg border border-white/25 px-3 py-1.5 font-semibold hover:border-white">
              Sign out
            </button>
          </div>
        </div>
        <nav aria-label="Admin sections" className="mx-auto max-w-7xl overflow-x-auto px-4 sm:px-6">
          <ul className="flex gap-1">
            {NAV.map((n) => {
              const current = location === n.href;
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    aria-current={current ? "page" : undefined}
                    className={`inline-block whitespace-nowrap border-b-[3px] px-3 py-3 text-[15px] font-semibold ${current ? "border-brand text-white" : "border-transparent text-white/65 hover:text-white"}`}
                  >
                    {n.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      {email ? (
        <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6">{children}</main>
      ) : (
        <div role="status" className="mx-auto max-w-7xl px-6 py-10 text-muted">
          Checking your session…
        </div>
      )}
    </div>
  );
}

/** A page heading with an optional control on the right. */
export function AdminHead({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-3xl font-bold">{title}</h1>
        {sub && <p className="mt-1 max-w-2xl text-muted">{sub}</p>}
      </div>
      {action}
    </div>
  );
}
