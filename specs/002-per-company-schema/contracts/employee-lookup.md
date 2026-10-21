# Contract: Employee Card Lookup (changed)

These are the public, unauthenticated endpoints in `artifacts/api-server/src/routes/employee.ts`.

- Requirement: FR-016.
- Design: [research.md R10](../research.md#r10-employee-card-lookup-across-companies-fr-016).
- These queries run in `ALL` scope, because the company is not known yet.

## POST /v1/lookup

The request is unchanged: `{ "identifier": "<email or phone>" }`.

**The response is always `200`, with the same shape**, whether there are no matches, one, several in one company, or several across companies:

```json
{
  "status": "CODE_SENT",
  "message": "If this contact is on file, a 6-digit code has been sent.",
  "verificationId": "<uuid>",
  "maskedDestination": "j***@e***.com",
  "lookupRef": null,
  "options": null,
  "devCode": null
}
```

| Case | Before | After |
|---|---|---|
| No match | `404 NOT_FOUND` "No record found…" | `200 CODE_SENT`. A decoy session is created and nothing is delivered. |
| Several matches | `200 SELECT` with name/DOB labels, before any code | `200 CODE_SENT`. The choice moves to verify. |
| Delivery provider failure | `503 CODE_DELIVERY_UNAVAILABLE`, which only a real match could trigger | `200 CODE_SENT`. The failure is logged on the session and shown to admins on the verifications screen. |
| Timing | Varies with delivery | Held to a minimum of **800 ms**. Delivery happens after the response. |
| `400 INVALID_INPUT` | unchanged | unchanged |

Only `active = true` members of active companies count as matches. The code goes to each distinct stored contact of the matches, never to the typed value.

`POST /v1/lookup/select` is **withdrawn**. `POST /v1/otp/resend` is unchanged, except that it no longer returns 503.

## POST /v1/otp/verify

Wrong, expired and locked codes behave as today. A correct code returns one of:

| Case | Body |
|---|---|
| One member | `status: "CARD"` with the card token, as today |
| Several members, one company | `status: "SELECT"`, `options: [{ref, label}]`, using the existing `disambiguationLabel`. Then `POST /v1/otp/select { verificationId, optionRef }` returns the card token. |
| Two or more companies | `status: "MULTI_COMPANY"`, `message: "Your details were found in more than one company. Please contact your HR department."`. No token and no company names. A `lookup_alerts` row is written. |
| Decoy session | The code can never verify: `400 CODE_INVALID`, the same as a wrong code |

Matches are checked again at verify time, so a member deactivated in the meantime no longer counts.

## GET /v1/card and other card routes

- The card session carries `member_ref`, an integer `bhi.member.member_id`.
- The card is built from `bhi.member`, `bhi.dependent` and `bhi.beneficiary`. The policy comes from `public.policy_memberships` by `member_ref`.
- The card's fields are **unchanged**:
  - `memberId` is still `policy.member_number`.
  - `identificationId` is now read from `member.id_number`.
  - Dependents and beneficiaries were shown as "first last" on one line (`card.tsx:184, 355`). They are now shown as the full name, which looks the same for migrated records. The API field becomes `fullName`.
- There is no visible layout change, so NALICO card approval is not triggered.
- Change requests raised from the card: the audit actor becomes `member:<memberId>` instead of the employee number (`employee.ts:953, 967`).

## Error text

No message may reveal, before verification, whether a contact or member exists (Principle I).
