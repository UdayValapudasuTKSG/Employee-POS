---
name: OTP decoy sessions & test flows
description: Why OTP verification "fails" for some seeded members in tests, and how validation suites depend on dev codes
---

- The employee lookup endpoint returns an indistinguishable decoy session (CODE_SENT with a devCode that can never verify) for any ineligible member — not just unknown identifiers. Eligibility requires BOTH `memberStatus === "ACTIVE"` AND `employmentStatus === "ACTIVE"`.
  **Why:** uniform responses prevent enumeration; a test that picks a member only by `memberStatus` gets a decoy and OTP verification fails with CODE_INVALID even with the "correct" code.
  **How to apply:** any test or demo driving the employee OTP flow must select a member with both statuses ACTIVE.
- The registered validation steps `rbac` and `ui-smoke` both depend on `devCode` being present in dev-mode API responses (the UI smoke reads it from the `dev` query param on the verify page). If dev codes are removed or gated when real email/SMS delivery lands, these suites need a test hook (e.g. dev-only code echo behind NODE_ENV) or they will fail.
- Validation scripts start their own api-server/vite instances on ports 573x/574x with a tiny local proxy mimicking the preview proxy (frontend at `/`, API at `/api`), so they never depend on the shared workflows being up.
