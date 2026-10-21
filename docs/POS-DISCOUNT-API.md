# Employee discount coupons — POS integration

For developers integrating a KFC or Pizza Hut till with the NALICO employee
discount. The till scans an employee's QR coupon, asks this API what discount
it is worth on the current bill, and records the redemption.

## The rule

- **10% off the bill** for any eligible employee, at KFC and Pizza Hut.
- **At most GYD 15,000 of discount per employee per calendar month**, both
  brands together. Months run from 00:00 on the 1st, Guyana time.
- When the remaining allowance is smaller than 10% of the bill, the discount is
  the remaining allowance (`capApplied: true`) — **and the cashier must confirm
  it first**, because the employee gets less than they expect. The API always
  works out the amount — the till never calculates it.

| | Allowance left | Bill | 10% | Discount given | Customer pays | Confirmation |
| --- | --- | --- | --- | --- | --- | --- |
| Scenario 1 | 15,000 | 20,000 | 2,000 | **2,000** | 18,000 | none |
| Scenario 2 | 800 | 10,000 | 1,000 | **800** | 9,200 | cashier confirms |

Percentage and cap are server configuration (`DISCOUNT_PERCENT`,
`DISCOUNT_MONTHLY_CAP_GYD`); integrate against the amounts the API returns,
not against 10% and 15,000.

## The coupon

The employee generates a coupon in the member portal and shows it as a QR code.
The QR encodes only the code, for example:

```
VBKT-0Q39-D85R
```

Twelve characters from `0-9 A-Z` without `I L O U`, grouped in fours. Send it
as scanned — case, spaces and hyphens are ignored, so a code typed by hand from
the screen also works. A scanner in keyboard mode types exactly this text.

Each coupon is for **one brand**, **single use**, and **expires** 30 minutes
after it is generated (`DISCOUNT_COUPON_TTL_MINUTES`). Generating a new coupon
for the same brand cancels the previous unused one.

## Authentication

Each brand has its own key, issued by NALICO. Send it on every request:

```
Authorization: Bearer <POS key>
```

A KFC key can only check, redeem and void KFC coupons, and likewise for Pizza
Hut. Keep the key on the till's back end, never in a browser or app bundle.

Base URL: `https://<portal domain>/api`. Bodies are JSON. Amounts are GYD
numbers with at most two decimals.

## Flow at the counter

```
scan QR ──▶ POST /v1/pos/coupons/check  {code, billAmount}   (optional preview)
             show quote.message; if quote.capApplied, ask the cashier to confirm
         ──▶ POST /v1/pos/coupons/redeem {code, billAmount, posReference,
                                          confirmPartialDiscount: true if confirmed}
             apply discountAmount to the bill, print it on the receipt
sale cancelled / refunded later
         ──▶ POST /v1/pos/coupons/{couponId}/void {reason}
```

### 1. Check (optional, changes nothing)

```http
POST /api/v1/pos/coupons/check
{ "code": "VBKT-0Q39-D85R", "billAmount": 4850 }
```

```json
{
  "couponId": "5b0c…",
  "brand": "KFC",
  "discountPercent": 10,
  "expiresAt": "2026-10-12T11:08:38.087Z",
  "remainingAllowance": 15000,
  "quote": {
    "billAmount": 4850,
    "fullDiscountAmount": 485,
    "discountAmount": 485,
    "amountPayable": 4365,
    "capApplied": false,
    "message": "10% off: GYD 485.00. Customer pays GYD 4,365.00."
  }
}
```

When the allowance cannot cover the full 10% (scenario 2: GYD 800 left, GYD
10,000 bill), `capApplied` is `true` and the message asks the question:

```json
"quote": {
  "billAmount": 10000,
  "fullDiscountAmount": 1000,
  "discountAmount": 800,
  "amountPayable": 9200,
  "capApplied": true,
  "message": "This employee has only GYD 800.00 of discount left this month (10% would be GYD 1,000.00). Apply GYD 800.00? Customer pays GYD 9,200.00."
}
```

Show `message` with **Apply** and **Cancel**. On Apply, redeem with
`confirmPartialDiscount: true`; on Cancel, do nothing — the coupon stays unused.

`billAmount` is optional; without it `quote` is `null`. The quote can differ from
the eventual redemption if the employee redeems another coupon in between.

### 2. Redeem

```http
POST /api/v1/pos/coupons/redeem
{ "code": "VBKT-0Q39-D85R", "billAmount": 4850, "posReference": "RCPT-000123", "posStore": "KFC Camp St" }
```

Scenario 2, after the cashier chose Apply:

```http
POST /api/v1/pos/coupons/redeem
{ "code": "VBKT-0Q39-D85R", "billAmount": 10000, "posReference": "RCPT-000124", "confirmPartialDiscount": true }
```

```json
{
  "couponId": "5b0c…",
  "brand": "KFC",
  "discountPercent": 10,
  "billAmount": 4850,
  "fullDiscountAmount": 485,
  "discountAmount": 485,
  "amountPayable": 4365,
  "capApplied": false,
  "posReference": "RCPT-000123",
  "redeemedAt": "2026-10-12T01:08:41.512Z",
  "remainingAllowance": 14515
}
```

- `billAmount` is the bill **before** discount.
- `posReference` is your receipt or order number (required). **Retrying with
  the same code and `posReference` returns the original redemption**, so after a
  timeout, send the identical request again rather than starting over.
- `posStore` is free text identifying the store or till (optional).
- `confirmPartialDiscount`: send `true` only after the cashier accepted a
  reduced discount. Redeeming a capped discount without it is refused with
  `409 PARTIAL_DISCOUNT_NOT_CONFIRMED` — nothing is recorded, and the response
  carries the same `quote` (with `message`) beside `error`, so a till that
  skipped `check` can ask the question then and redeem again.
- Keep `couponId`: you need it to void.

### 3. Void

When a discounted sale is cancelled or refunded, void it. The discount goes back
into the employee's allowance for the month it was redeemed in.

```http
POST /api/v1/pos/coupons/5b0c…/void
{ "reason": "Order cancelled by customer" }
```

```json
{ "couponId": "5b0c…", "status": "VOIDED", "voidedAt": "2026-10-12T01:20:03.004Z" }
```

Voiding twice returns the same answer. A voided coupon cannot be redeemed
again; the employee generates a new one.

## Errors

Every error has the same shape; branch on `error.code`, show `error.message` to
the cashier.

```json
{ "error": { "code": "COUPON_EXPIRED", "message": "This coupon has expired. Ask the employee to generate a new coupon." } }
```

| HTTP | `code` | Cashier action |
| --- | --- | --- |
| 400 | `INVALID_INPUT` | Bug in the request: missing field, or an amount with more than two decimals |
| 401 | `POS_UNAUTHORIZED` | Key missing or wrong — configuration problem, contact NALICO |
| 404 | `COUPON_NOT_FOUND` | Not a valid coupon (or, on void, not one of this brand's) |
| 409 | `COUPON_WRONG_BRAND` | Coupon is for the other brand |
| 409 | `COUPON_EXPIRED` | Employee generates a new coupon |
| 409 | `COUPON_ALREADY_REDEEMED` | Already used (with a different receipt number) |
| 409 | `COUPON_CANCELLED` | Employee generated a newer coupon — scan that one |
| 409 | `COUPON_VOIDED` | Its sale was voided — employee generates a new coupon |
| 409 | `MEMBER_NOT_ELIGIBLE` | Employee is no longer covered — charge full price |
| 409 | `ALLOWANCE_EXHAUSTED` | This month's allowance is used up — charge full price |
| 409 | `PARTIAL_DISCOUNT_NOT_CONFIRMED` | Redeem only: show `message`; on Apply, resend with `confirmPartialDiscount: true` |
| 409 | `COUPON_NOT_REDEEMED` | Void only: nothing to void |
| 429 | — | Rate limit (120 requests/minute per IP, with bursts) — back off and retry |

Any `409` on redeem means **no discount was recorded**: charge the full price.

## Trying it

With the local Docker stack running (README, "Run it with Docker"), keys are
`POS_API_KEY_KFC` / `POS_API_KEY_PIZZA_HUT` in `artifacts/api-server/.env`:

```bash
curl -s http://localhost:3000/api/v1/pos/coupons/redeem \
  -H "Authorization: Bearer $POS_API_KEY_KFC" -H "Content-Type: application/json" \
  -d '{"code":"VBKT-0Q39-D85R","billAmount":4850,"posReference":"TEST-1"}'
```

The machine-readable contract is `lib/api-spec/openapi.yaml`, tag `pos`.
