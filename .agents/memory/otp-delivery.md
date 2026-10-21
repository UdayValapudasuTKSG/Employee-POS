---
name: OTP delivery design
description: Final design of member OTP delivery (SMTP/SMS webhook, explicit failure semantics)
---

Rule: OTP delivery lives in `otpDelivery.ts` — generic SMTP via nodemailer (SMTP_HOST/PORT/USER/PASS/FROM) for email and a configurable webhook (SMS_WEBHOOK_URL, optional SMS_WEBHOOK_TOKEN) for SMS. A failed or unconfigured send expires the verification session and returns 503 CODE_DELIVERY_UNAVAILABLE; unknown identifiers get an explicit 404 NOT_FOUND on lookup.

**Why:** The project deliberately chose explicit failure over silent "code sent" decoys — a member who never receives a code should not be told one was sent, and ops should see DELIVERY_UNAVAILABLE events. An earlier Resend/Twilio fire-and-forget implementation with decoy anti-enumeration was superseded by this design during merge; do not reintroduce it.

**How to apply:** New OTP paths must await `deliverOtp`, expire the session on failure, and route errors through `handleDeliveryError`. Sessions store the raw `destination` column for resends. Dev mode (`isOtpDevMode()`) still returns `devCode` for known members only; production never returns it. Note: the api-server `dev` script builds to dist before running — old dist means stale code.
