/** The admin portal's API. Its session is its own HttpOnly cookie. */
import { call, type SentOtp, type StoreId } from "../api";

export interface StoreSetting {
  store: StoreId;
  name: string;
  percent: number;
  monthlyCap: number | null;
  enabled: boolean;
}

export interface Settings {
  monthlyCap: number;
  codeTtlMinutes: number;
  stores: StoreSetting[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface Kpis {
  redemptions: number;
  saved: number;
  sales: number;
  voids: number;
  employeesSaving: number;
  partial: number;
  generated: number;
  expiredUnused: number;
  signedIn: number;
  atCap: number;
}

export interface Metrics {
  month: string;
  isCurrentMonth: boolean;
  terms: Settings;
  kpis: { current: Kpis; previous: Kpis };
  employees: { total: number; active: number };
  liveCodes: number;
  days: { day: string; redemptions: number; saved: number; sales: number }[];
  stores: { store: StoreId; name: string; enabled: boolean; percent: number; redemptions: number; saved: number; sales: number; employees: number; partial: number; averageBill: number }[];
  months: { month: string; redemptions: number; saved: number; sales: number }[];
  hours: { hour: number; redemptions: number }[];
  allowanceUse: { label: string; employees: number }[];
  topEmployees: { id: number; name: string; email: string; employeeNumber: string | null; redemptions: number; saved: number; sales: number }[];
  recent: {
    id: string;
    at: string;
    status: "REDEEMED" | "VOIDED";
    store: StoreId;
    storeName: string;
    storeLocation: string | null;
    employee: string;
    billAmount: number;
    discountAmount: number;
    percent: number | null;
    partial: boolean;
  }[];
}

export interface AdminEmployee {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  employeeNumber: string | null;
  company: string;
  active: boolean;
  savedThisMonth: number;
  codesUsedThisMonth: number;
  lastUsedAt: string | null;
}

export interface EmployeePage {
  items: AdminEmployee[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export const adminApi = {
  start: (email: string) => call<SentOtp>("POST", "/api/admin/auth/start", { email }),
  verify: (challengeId: string, code: string) => call<{ ok: true; email: string }>("POST", "/api/admin/auth/verify", { challengeId, code }),
  logout: () => call<{ ok: true }>("POST", "/api/admin/auth/logout"),
  me: () => call<{ email: string }>("GET", "/api/admin/me"),
  metrics: (month?: string) => call<Metrics>("GET", `/api/admin/metrics${month ? `?month=${month}` : ""}`),
  settings: () => call<Settings>("GET", "/api/admin/settings"),
  saveSettings: (s: Omit<Settings, "updatedAt" | "updatedBy">) =>
    call<Settings>("PUT", "/api/admin/settings", {
      monthlyCap: s.monthlyCap,
      codeTtlMinutes: s.codeTtlMinutes,
      stores: s.stores.map(({ store, percent, monthlyCap, enabled }) => ({ store, percent, monthlyCap, enabled })),
    }),
  employees: (q: { search?: string; status?: "active" | "inactive"; page: number }) => {
    const p = new URLSearchParams({ page: String(q.page), pageSize: "20" });
    if (q.search) p.set("search", q.search);
    if (q.status) p.set("status", q.status);
    return call<EmployeePage>("GET", `/api/admin/employees?${p}`);
  },
  addEmployee: (e: { email: string; firstName: string; lastName: string; employeeNumber?: string; company?: string }) =>
    call<{ id: number }>("POST", "/api/admin/employees", e),
  setActive: (id: number, active: boolean) => call<{ ok: true }>("POST", `/api/admin/employees/${id}/active`, { active }),
};
