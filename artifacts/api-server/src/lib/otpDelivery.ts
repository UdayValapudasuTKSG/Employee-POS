import nodemailer from "nodemailer";
import { logger } from "./logger";
import { OTP_TTL_SECONDS } from "./constants";
import { cardEmail, couponEmail, otpEmail, otpSms, type EmailContent, type OtpPurpose } from "./emailTemplates";

/**
 * Production OTP delivery.
 *
 * Email: generic SMTP via nodemailer, configured with env vars:
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS,
 *   SMTP_FROM (e.g. "NALICO <no-reply@yourdomain.com>")
 *
 * SMS: not bundled with a provider. Configure a webhook that forwards the
 * message to your SMS gateway with SMS_WEBHOOK_URL (POST JSON
 * { to, body }; optional bearer auth via SMS_WEBHOOK_TOKEN), e.g. a Twilio
 * function, MessageBird flow, or an in-house gateway.
 *
 * What each message says is in emailTemplates.ts.
 */

/** Base class: any reason a code could not be delivered (config or runtime). */
export class DeliveryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryUnavailableError";
  }
}

export class DeliveryNotConfiguredError extends DeliveryUnavailableError {
  constructor(channel: "EMAIL" | "PHONE") {
    super(`No ${channel === "EMAIL" ? "email (SMTP_*)" : "SMS (SMS_WEBHOOK_URL)"} delivery is configured`);
    this.name = "DeliveryNotConfiguredError";
  }
}

export function isEmailDeliveryConfigured(): boolean {
  return !!process.env["SMTP_HOST"];
}

export function isSmsDeliveryConfigured(): boolean {
  return !!process.env["SMS_WEBHOOK_URL"];
}

/** One place that knows how to reach the SMTP server. */
function createSmtpTransport() {
  const port = Number(process.env["SMTP_PORT"] ?? 587);
  return nodemailer.createTransport({
    host: process.env["SMTP_HOST"],
    port,
    secure: port === 465,
    auth: process.env["SMTP_USER"]
      ? { user: process.env["SMTP_USER"]!, pass: process.env["SMTP_PASS"] ?? "" }
      : undefined,
  });
}

function smtpFrom(): string {
  return (
    process.env["SMTP_FROM"] ?? process.env["SMTP_USER"] ?? "no-reply@localhost"
  );
}

type Attachment = { filename: string; content: Buffer; contentType: string; cid?: string };

/** Sends one templated email, or throws DeliveryUnavailableError. */
async function sendEmail(to: string, content: EmailContent, what: string, attachments: Attachment[] = []): Promise<void> {
  if (!isEmailDeliveryConfigured()) throw new DeliveryNotConfiguredError("EMAIL");
  try {
    await createSmtpTransport().sendMail({
      from: smtpFrom(),
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      attachments,
    });
  } catch (err) {
    logger.error({ err }, `SMTP ${what} delivery failed`);
    throw new DeliveryUnavailableError("Email delivery failed");
  }
}

/**
 * A one-time code, by email or SMS. `purpose` says what it unlocks: signing in
 * (the default) or generating a discount coupon.
 */
export async function deliverOtp(
  channel: "EMAIL" | "PHONE",
  destination: string,
  code: string,
  purpose: OtpPurpose = { kind: "LOGIN" },
): Promise<void> {
  const minutes = Math.round(OTP_TTL_SECONDS / 60);

  if (channel === "EMAIL") {
    await sendEmail(destination, otpEmail(code, minutes, purpose), "OTP");
    return;
  }

  if (!isSmsDeliveryConfigured()) throw new DeliveryNotConfiguredError(channel);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env["SMS_WEBHOOK_TOKEN"]) {
    headers["authorization"] = `Bearer ${process.env["SMS_WEBHOOK_TOKEN"]}`;
  }
  let resp: Response;
  try {
    resp = await fetch(process.env["SMS_WEBHOOK_URL"]!, {
      method: "POST",
      headers,
      body: JSON.stringify({ to: destination, body: otpSms(code, minutes, purpose) }),
    });
  } catch (err) {
    logger.error({ err }, "SMS webhook unreachable");
    throw new DeliveryUnavailableError("SMS delivery failed");
  }
  if (!resp.ok) {
    logger.error({ status: resp.status }, "SMS webhook delivery failed");
    throw new DeliveryUnavailableError(`SMS webhook responded with ${resp.status}`);
  }
}

// ---------------------------------------------------------------------------
// Emailing the card itself
// ---------------------------------------------------------------------------

/**
 * Card emails go to the member, always — unless a demo environment explicitly
 * asks for them to be diverted.
 *
 * `CARD_EMAIL_OVERRIDE=someone@example.com` sends every card to that address
 * instead of the member's own, which is how the feature is demonstrated against
 * seeded members whose fabricated addresses no mail server can deliver to.
 *
 * Unset — the default, and the only correct setting for a real deployment —
 * there is no redirect at all. This used to default to a hardcoded address,
 * which meant a correctly configured production server still sent every
 * member's card to one private inbox. Redirecting is now something an operator
 * has to ask for by name, and the API logs a warning on every start while it is
 * in force.
 */
const DISABLED = /^(off|false|none|no|0)$/i;

/** The address card emails are being redirected to, or null when there is none. */
export function activeCardEmailRedirect(): string | null {
  const configured = process.env["CARD_EMAIL_OVERRIDE"]?.trim();
  if (!configured || DISABLED.test(configured)) return null;
  return configured;
}

export function resolveCardRecipient(memberEmail: string | null): {
  to: string | null;
  redirectedFrom: string | null;
} {
  const redirect = activeCardEmailRedirect();
  if (!redirect) return { to: memberEmail, redirectedFrom: null };

  // Only call it a redirect when it actually goes somewhere else, so a member
  // whose own address matches does not get a confusing prototype notice.
  return {
    to: redirect,
    redirectedFrom: memberEmail && memberEmail !== redirect ? memberEmail : null,
  };
}

export interface CardEmailInput {
  to: string;
  memberName: string;
  policyNumber: string;
  pdf: Buffer;
  /** Set when the address differs from the member's, so the mail says so. */
  redirectedFrom?: string | null;
}

/** Sends the insurance card as a PDF attachment. */
export async function sendCardEmail(input: CardEmailInput): Promise<void> {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9._-]/g, "-");
  await sendEmail(
    input.to,
    cardEmail({ memberName: input.memberName, policyNumber: input.policyNumber, redirectedFrom: input.redirectedFrom }),
    "card PDF",
    [{ filename: `card-${safe(input.policyNumber)}.pdf`, content: input.pdf, contentType: "application/pdf" }],
  );
}

// ---------------------------------------------------------------------------
// Emailing a discount coupon
// ---------------------------------------------------------------------------

export interface CouponEmailSendInput {
  to: string;
  memberName: string;
  brandName: string;
  code: string;
  discountPercent: number;
  expiresAt: Date;
  /** The QR code as a PNG, shown inline in the message. */
  qrPng: Buffer;
  redirectedFrom?: string | null;
}

/**
 * Sends a just-generated coupon to the member, its QR code inline so it can be
 * scanned straight from the inbox. A copy for convenience — the coupon is
 * equally valid shown from the portal.
 */
export async function sendCouponEmail(input: CouponEmailSendInput): Promise<void> {
  const qrCid = "coupon-qr";
  await sendEmail(input.to, couponEmail({ ...input, qrCid }), "coupon", [
    { filename: "coupon-qr.png", content: input.qrPng, contentType: "image/png", cid: qrCid },
  ]);
}
