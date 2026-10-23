/**
 * The discount terms, as an admin last set them.
 *
 * Read from the database on every use, so a change in the admin portal applies
 * to the next request without a restart. On first start (empty tables) they
 * are filled from .env: DISCOUNT_PERCENT for every store, DISCOUNT_MONTHLY_CAP_GYD
 * and CODE_TTL_MINUTES.
 */
import { config } from "./config";
import { pool, type Db } from "./db";
import { logger } from "./log";
import { STORE_NAMES, STORES, centsOf, type Store } from "./rules";

export interface StoreTerms {
  store: Store;
  name: string;
  /** Basis points: 10% is 1000. */
  percentBp: number;
  /** This store's own monthly limit per employee, or null for none (only the overall one applies). */
  monthlyCapCents: number | null;
  enabled: boolean;
}

export interface Terms {
  monthlyCapCents: number;
  codeTtlMinutes: number;
  stores: Record<Store, StoreTerms>;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** Fills the settings from .env when they have never been set. Safe on every start. */
export async function seedSettings(): Promise<void> {
  const r = await pool.query(
    `INSERT INTO program_settings (id, monthly_cap, code_ttl_minutes, updated_by)
     VALUES (1, $1, $2, 'initial .env') ON CONFLICT (id) DO NOTHING`,
    [(config.discount.monthlyCapCents / 100).toFixed(2), config.discount.codeTtlMinutes],
  );
  let added = r.rowCount ?? 0;
  for (const s of STORES) {
    const x = await pool.query(
      `INSERT INTO store_settings (store, discount_percent, updated_by) VALUES ($1, $2, 'initial .env')
       ON CONFLICT (store) DO NOTHING`,
      [s, (config.discount.percentBp / 100).toFixed(2)],
    );
    added += x.rowCount ?? 0;
  }
  if (added) logger.info("Discount settings filled from .env (change them in the admin portal from now on)");
}

export async function getTerms(db: Db = pool): Promise<Terms> {
  const p = await db.query<{ monthly_cap: string; code_ttl_minutes: number; updated_at: Date; updated_by: string | null }>(
    "SELECT monthly_cap, code_ttl_minutes, updated_at, updated_by FROM program_settings WHERE id = 1",
  );
  const rows = await db.query<{ store: Store; discount_percent: string; monthly_cap: string | null; enabled: boolean; updated_at: Date; updated_by: string | null }>(
    "SELECT store, discount_percent, monthly_cap, enabled, updated_at, updated_by FROM store_settings",
  );
  const byStore = new Map(rows.rows.map((r) => [r.store, r]));
  const stores = Object.fromEntries(
    STORES.map((s) => {
      const r = byStore.get(s);
      return [
        s,
        {
          store: s,
          name: STORE_NAMES[s],
          percentBp: r ? Math.round(Number(r.discount_percent) * 100) : config.discount.percentBp,
          monthlyCapCents: r?.monthly_cap == null ? null : centsOf(r.monthly_cap),
          enabled: r?.enabled ?? true,
        } satisfies StoreTerms,
      ];
    }),
  ) as Record<Store, StoreTerms>;

  // The latest change anywhere, for "last changed by" in the portal.
  const changes = [p.rows[0], ...rows.rows].filter(Boolean) as { updated_at: Date; updated_by: string | null }[];
  const latest = changes.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())[0];
  return {
    monthlyCapCents: p.rows[0] ? centsOf(p.rows[0].monthly_cap) : config.discount.monthlyCapCents,
    codeTtlMinutes: p.rows[0]?.code_ttl_minutes ?? config.discount.codeTtlMinutes,
    stores,
    updatedAt: latest?.updated_at ?? null,
    updatedBy: latest?.updated_by ?? null,
  };
}

/** The stores taking codes right now, in display order. */
export const enabledStores = (t: Terms): StoreTerms[] => STORES.map((s) => t.stores[s]).filter((s) => s.enabled);

/** The headline percentage: the best any participating store gives. */
export const bestPercentBp = (t: Terms): number => Math.max(0, ...enabledStores(t).map((s) => s.percentBp));
