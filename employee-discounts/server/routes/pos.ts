/**
 * The tills. Each store authenticates with its own key; the key says which
 * store is redeeming. A code is good at any one store, once.
 *
 *   check   validate a scanned code and quote the discount on a bill. Writes nothing.
 *   redeem  apply it: the code is used up and the discount recorded.
 *   void    the sale was cancelled or refunded: the allowance comes back.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { availableAt, lockEmployee, remainingCents, type Available } from "../allowance";
import { getTerms, type Terms } from "../settings";
import { fail } from "../auth";
import { config } from "../config";
import { audit, pool, tx, type Db } from "../db";
import {
  STORE_NAMES,
  codeHash,
  currentMonth,
  fromCents,
  normalizeCode,
  quote,
  quoteMessage,
  storeForKey,
  toCents,
  type Quote,
  type Store,
} from "../rules";

export const posRouter = Router();

function storeOf(req: Request, res: Response): Store | null {
  const header = req.headers.authorization;
  const store = header?.startsWith("Bearer ") ? storeForKey(header.slice(7).trim(), config.posKeys) : null;
  if (!store) fail(res, 401, "POS_UNAUTHORIZED", "Missing or unknown store key.");
  return store;
}

interface Row {
  id: string;
  employee_id: number;
  status: string;
  discount_percent: string | null;
  expires_at: Date;
  store: Store | null;
  pos_reference: string | null;
  redeemed_at: Date | null;
  bill_amount: string | null;
  full_discount_amount: string | null;
  discount_amount: string | null;
  first_name: string;
  last_name: string;
  employee_number: string | null;
  active: boolean;
}

async function findCode(db: Db, raw: string, lock = false): Promise<Row | null> {
  const canonical = normalizeCode(raw);
  if (!canonical) return null;
  const r = await db.query<Row>(
    `SELECT d.*, e.first_name, e.last_name, e.employee_number, e.active
       FROM discount_codes d JOIN employees e ON e.id = d.employee_id
      WHERE d.code_hash = $1 ${lock ? "FOR UPDATE OF d" : ""}`,
    [codeHash(canonical)],
  );
  return r.rows[0] ?? null;
}

interface Refusal {
  status: number;
  code: string;
  message: string;
}

const NOT_FOUND: Refusal = { status: 404, code: "CODE_NOT_FOUND", message: "This is not a valid staff discount code." };
const EXHAUSTED: Refusal = {
  status: 409,
  code: "ALLOWANCE_EXHAUSTED",
  message: "This employee has used this month's discount allowance. Charge the full price.",
};

function refusal(c: Row): Refusal | null {
  if (!c.active) return { status: 409, code: "EMPLOYEE_NOT_ELIGIBLE", message: "This employee is no longer eligible for the discount." };
  switch (c.status) {
    case "REDEEMED":
      return { status: 409, code: "CODE_ALREADY_USED", message: `This code was already used${c.store ? ` at ${STORE_NAMES[c.store]}` : ""}.` };
    case "VOIDED":
      return { status: 409, code: "CODE_VOIDED", message: "This code's sale was voided. Ask the employee for a new code." };
    case "REPLACED":
      return { status: 409, code: "CODE_REPLACED", message: "This code was replaced by a newer one. Ask the employee for their current code." };
    case "EXPIRED":
      return { status: 409, code: "CODE_EXPIRED", message: "This code has expired. Ask the employee for a new code." };
  }
  if (c.expires_at.getTime() <= Date.now()) {
    return { status: 409, code: "CODE_EXPIRED", message: "This code has expired. Ask the employee for a new code." };
  }
  return null;
}

/** "Uday Kumar V." — enough for the cashier to check against ID, not a full name on every screen. */
const holderName = (c: Row) => `${c.first_name} ${c.last_name.slice(0, 1)}.`;

function quoteJson(q: Quote, percent: number, atStore?: string) {
  return {
    billAmount: fromCents(q.billCents),
    fullDiscountAmount: fromCents(q.fullDiscountCents),
    discountAmount: fromCents(q.discountCents),
    amountPayable: fromCents(q.payableCents),
    capApplied: q.capApplied,
    message: quoteMessage(q, percent, atStore),
  };
}

/** A store an admin has switched off takes no codes. */
const notParticipating = (store: Store): Refusal => ({
  status: 409,
  code: "STORE_NOT_PARTICIPATING",
  message: `${STORE_NAMES[store]} is not taking staff discount codes at the moment.`,
});

/** Nothing left: overall, or at this store when it has its own limit. */
const exhaustedFor = (store: Store, a: Available): Refusal =>
  a.limitedBy === "STORE"
    ? { status: 409, code: "STORE_LIMIT_REACHED", message: `This employee has used this month's limit at ${STORE_NAMES[store]}. Charge the full price.` }
    : EXHAUSTED;

const CheckBody = z.object({ code: z.string().min(1).max(64), billAmount: z.number().positive().max(100_000_000).optional() });

posRouter.post("/api/pos/check", async (req, res) => {
  const store = storeOf(req, res);
  if (!store) return;
  const parsed = CheckBody.safeParse(req.body);
  const billCents = parsed.success && parsed.data.billAmount != null ? toCents(parsed.data.billAmount) : null;
  if (!parsed.success || (parsed.data.billAmount != null && billCents == null)) {
    return fail(res, 400, "INVALID_INPUT", "Send the scanned code, and optionally the bill total in GYD to two decimals.");
  }
  const c = await findCode(pool, parsed.data.code);
  if (!c) return fail(res, NOT_FOUND.status, NOT_FOUND.code, NOT_FOUND.message);
  const t = await getTerms();
  const why = refusal(c) ?? (t.stores[store].enabled ? null : notParticipating(store));
  if (why) return fail(res, why.status, why.code, why.message);
  const avail = await availableAt(pool, c.employee_id, store, t);
  if (avail.cents <= 0) {
    const r = exhaustedFor(store, avail);
    return fail(res, r.status, r.code, r.message);
  }
  const { percentBp } = t.stores[store];
  const percent = percentBp / 100;
  const atStore = avail.limitedBy === "STORE" ? STORE_NAMES[store] : undefined;
  res.json({
    codeId: c.id,
    store,
    storeName: STORE_NAMES[store],
    holderName: holderName(c),
    employeeNumber: c.employee_number,
    discountPercent: percent,
    expiresAt: c.expires_at.toISOString(),
    remainingAllowance: fromCents(avail.cents),
    quote: billCents == null ? null : quoteJson(quote(billCents, percentBp, avail.cents), percent, atStore),
  });
});

function redemptionJson(c: Row, remainingAfterCents: number) {
  const bill = Math.round(Number(c.bill_amount) * 100);
  const full = Math.round(Number(c.full_discount_amount) * 100);
  const disc = Math.round(Number(c.discount_amount) * 100);
  return {
    codeId: c.id,
    store: c.store,
    storeName: c.store ? STORE_NAMES[c.store] : null,
    holderName: holderName(c),
    discountPercent: Number(c.discount_percent),
    billAmount: fromCents(bill),
    fullDiscountAmount: fromCents(full),
    discountAmount: fromCents(disc),
    amountPayable: fromCents(bill - disc),
    capApplied: disc < full,
    posReference: c.pos_reference,
    redeemedAt: c.redeemed_at!.toISOString(),
    remainingAllowance: fromCents(Math.max(0, remainingAfterCents)),
  };
}

const RedeemBody = z.object({
  code: z.string().min(1).max(64),
  billAmount: z.number().positive().max(100_000_000),
  posReference: z.string().trim().min(1).max(100),
  storeLocation: z.string().trim().max(100).optional(),
  confirmPartialDiscount: z.boolean().optional(),
});

posRouter.post("/api/pos/redeem", async (req, res) => {
  const store = storeOf(req, res);
  if (!store) return;
  const parsed = RedeemBody.safeParse(req.body);
  const billCents = parsed.success ? toCents(parsed.data.billAmount) : null;
  if (!parsed.success || billCents == null) {
    return fail(res, 400, "INVALID_INPUT", "Send the scanned code, the bill total in GYD to two decimals, and the receipt number.");
  }
  const { posReference, confirmPartialDiscount } = parsed.data;
  const storeLocation = parsed.data.storeLocation || null;

  const t = await getTerms();
  const outcome = await tx(async (client) => {
    const peek = await findCode(client, parsed.data.code);
    if (!peek) return { kind: "refused" as const, refused: NOT_FOUND };
    // Every spend of one employee's allowance runs one at a time.
    await lockEmployee(client, peek.employee_id);
    const c = (await findCode(client, parsed.data.code, true))!;
    // A retry of a sale already recorded answers with that sale.
    if (c.status === "REDEEMED" && c.store === store && c.pos_reference === posReference) {
      return { kind: "done" as const, done: c, remaining: await remainingCents(client, c.employee_id, t) };
    }
    const why = refusal(c) ?? (t.stores[store].enabled ? null : notParticipating(store));
    if (why) return { kind: "refused" as const, refused: why };
    const avail = await availableAt(client, c.employee_id, store, t, currentMonth());
    if (avail.cents <= 0) return { kind: "refused" as const, refused: exhaustedFor(store, avail) };
    // The store that redeems sets the percentage.
    const { percentBp } = t.stores[store];
    const q = quote(billCents, percentBp, avail.cents);
    const atStore = avail.limitedBy === "STORE" ? STORE_NAMES[store] : undefined;
    if (q.capApplied && confirmPartialDiscount !== true) {
      return { kind: "unconfirmed" as const, unconfirmed: q, percent: percentBp / 100, atStore };
    }

    const u = await client.query<Row>(
      `UPDATE discount_codes SET status = 'REDEEMED', store = $2, store_location = $3, pos_reference = $4, redeemed_at = now(),
              bill_amount = $5, full_discount_amount = $6, discount_amount = $7, discount_percent = $8, updated_at = now()
        WHERE id = $1 AND status = 'ACTIVE' RETURNING *`,
      [c.id, store, storeLocation, posReference, (q.billCents / 100).toFixed(2), (q.fullDiscountCents / 100).toFixed(2), (q.discountCents / 100).toFixed(2), (percentBp / 100).toFixed(2)],
    );
    await audit(client, `pos:${store}`, "CODE_REDEEMED", c.id, {
      billAmount: fromCents(q.billCents),
      discountAmount: fromCents(q.discountCents),
      capApplied: q.capApplied,
      percent: percentBp / 100,
      posReference,
      storeLocation,
    });
    return { kind: "done" as const, done: { ...c, ...u.rows[0]! }, remaining: avail.overallCents - q.discountCents };
  });

  if (outcome.kind === "refused") return fail(res, outcome.refused.status, outcome.refused.code, outcome.refused.message);
  if (outcome.kind === "unconfirmed") {
    // Nothing recorded. The amounts travel beside the error so the till can ask.
    return fail(res, 409, "PARTIAL_DISCOUNT_NOT_CONFIRMED", quoteMessage(outcome.unconfirmed, outcome.percent, outcome.atStore), {
      quote: quoteJson(outcome.unconfirmed, outcome.percent, outcome.atStore),
    });
  }
  res.json(redemptionJson(outcome.done, outcome.remaining));
});

const VoidBody = z.object({ reason: z.string().trim().min(3).max(500) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

posRouter.post("/api/pos/codes/:id/void", async (req, res) => {
  const store = storeOf(req, res);
  if (!store) return;
  const parsed = VoidBody.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "INVALID_INPUT", "Give a reason for voiding (3 to 500 characters).");
  const id = String(req.params["id"]);
  // Only the store that redeemed a code can void it; any other answers as not found.
  const r = UUID.test(id)
    ? await pool.query<{ id: string; status: string; voided_at: Date | null }>(
        "SELECT id, status, voided_at FROM discount_codes WHERE id = $1 AND store = $2",
        [id, store],
      )
    : { rows: [] };
  const c = r.rows[0];
  if (!c) return fail(res, 404, "CODE_NOT_FOUND", "No sale with this code id at this store.");
  if (c.status === "VOIDED") return res.json({ codeId: c.id, status: "VOIDED", voidedAt: c.voided_at!.toISOString() });
  if (c.status !== "REDEEMED") return fail(res, 409, "CODE_NOT_REDEEMED", "This code was never redeemed, so there is nothing to void.");
  const voided = await tx(async (client) => {
    const u = await client.query<{ voided_at: Date }>(
      "UPDATE discount_codes SET status = 'VOIDED', voided_at = now(), void_reason = $2, updated_at = now() WHERE id = $1 AND status = 'REDEEMED' RETURNING voided_at",
      [id, parsed.data.reason],
    );
    if (u.rows[0]) await audit(client, `pos:${store}`, "CODE_VOIDED", id, { reason: parsed.data.reason });
    return u.rows[0];
  });
  const at = voided?.voided_at ?? (await pool.query<{ voided_at: Date }>("SELECT voided_at FROM discount_codes WHERE id = $1", [id])).rows[0]!.voided_at;
  res.json({ codeId: id, status: "VOIDED", voidedAt: at.toISOString() });
});
