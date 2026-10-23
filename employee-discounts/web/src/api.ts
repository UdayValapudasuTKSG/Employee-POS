/** The API, from the browser. Same origin; the session is an HttpOnly cookie. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? "ERROR", data?.error?.message ?? "Something went wrong. Try again shortly.");
  }
  return data as T;
}

export type StoreId = "KFC" | "PIZZA_HUT" | "STERLING" | "BEHARRY";
export interface StoreInfo {
  id: StoreId;
  name: string;
  /** This store's percentage off. */
  percent: number;
  /** The store's own monthly limit per employee, when it has one. */
  monthlyCap?: number | null;
  /** On /api/me: what is left at this store this month, when it has a limit. */
  remaining?: number | null;
}

export interface Terms {
  /** The best percentage any store gives. */
  percent: number;
  /** Every store gives the same percentage. */
  samePercent: boolean;
  currency: string;
  monthlyCap: number;
  codeTtlMinutes: number;
  stores: StoreInfo[];
}

export interface SentOtp {
  challengeId: string;
  maskedEmail: string;
  expiresAt: string;
  resendAfterSeconds: number;
  devCode: string | null;
}

export type CodeStatus = "ACTIVE" | "REDEEMED" | "EXPIRED" | "VOIDED" | "REPLACED";

export interface HistoryItem {
  id: string;
  status: CodeStatus;
  /** The percentage the store applied; null until used. */
  discountPercent: number | null;
  createdAt: string;
  expiresAt: string;
  store: StoreId | null;
  storeName: string | null;
  storeLocation: string | null;
  redeemedAt: string | null;
  billAmount: number | null;
  fullDiscountAmount: number | null;
  discountAmount: number | null;
}

export interface ActiveCode {
  id: string;
  code: string;
  expiresAt: string;
}

export interface Me {
  employee: { firstName: string; lastName: string; email: string; company: string; employeeNumber: string | null };
  allowance: { percent: number; samePercent: boolean; currency: string; month: string; monthlyCap: number; used: number; remaining: number };
  activeCode: ActiveCode | null;
  latestCode: HistoryItem | null;
  stores: StoreInfo[];
  codeTtlMinutes: number;
}

export interface HistoryPage {
  items: HistoryItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface HistoryFilters {
  store?: StoreId;
  status?: CodeStatus;
  month?: string;
  page: number;
  pageSize: number;
}

export const api = {
  terms: () => call<Terms>("GET", "/api/public/terms"),
  startSignIn: (email: string) => call<SentOtp>("POST", "/api/auth/start", { email }),
  verifySignIn: (challengeId: string, code: string) => call<{ ok: true }>("POST", "/api/auth/verify", { challengeId, code }),
  signOut: () => call<{ ok: true }>("POST", "/api/auth/logout"),
  me: () => call<Me>("GET", "/api/me"),
  requestCodeOtp: () => call<SentOtp>("POST", "/api/codes/otp"),
  generateCode: (challengeId: string, code: string) =>
    call<{ activeCode: ActiveCode; emailedTo: string | null }>("POST", "/api/codes", { challengeId, code }),
  history: (f: HistoryFilters) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") q.set(k, String(v));
    return call<HistoryPage>("GET", `/api/codes?${q}`);
  },
};

const MONEY = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const gyd = (amount: number) => `GYD ${MONEY.format(amount)}`;
/** Whole dollars where the cents are zero, for headlines: "GYD 15,000". */
export const gydShort = (amount: number) =>
  `GYD ${new Intl.NumberFormat("en-US", { maximumFractionDigits: Number.isInteger(amount) ? 0 : 2, minimumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount)}`;
