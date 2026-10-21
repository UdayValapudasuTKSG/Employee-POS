import nodemailer from "nodemailer";
import { logger } from "./logger";
import { OTP_TTL_SECONDS } from "./constants";
import { issuerDetails } from "./issuer";

/**
 * How the insurer refers to itself in outbound messages. Comes from ISSUER_NAME
 * like everything else the member sees; when unset the messages read generically
 * rather than naming an insurer this deployment is not.
 */
function issuerLabel(): string | null {
  return issuerDetails().name;
}

/** "Your NALICO verification code" / "Your verification code". */
function branded(suffix: string): string {
  const name = issuerLabel();
  return name ? `${name} ${suffix}` : suffix;
}

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

export async function deliverOtp(
  channel: "EMAIL" | "PHONE",
  destination: string,
  code: string,
): Promise<void> {
  const minutes = Math.round(OTP_TTL_SECONDS / 60);
  const subject = `Your ${branded("verification code")}`;
  const body = `${subject} is ${code}. It expires in ${minutes} minutes.`;

  if (channel === "EMAIL") {
    if (!isEmailDeliveryConfigured()) throw new DeliveryNotConfiguredError(channel);
    const transporter = createSmtpTransport();
    try {
      await transporter.sendMail({
        from: smtpFrom(),
        to: destination,
        subject,
        text: body,
      });
    } catch (err) {
      logger.error({ err }, "SMTP OTP delivery failed");
      throw new DeliveryUnavailableError("Email delivery failed");
    }
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
      body: JSON.stringify({ to: destination, body }),
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
  if (!isEmailDeliveryConfigured()) throw new DeliveryNotConfiguredError("EMAIL");

  const safe = (v: string) => v.replace(/[^A-Za-z0-9._-]/g, "-");
  const prefix = issuerLabel() ? `${safe(issuerLabel()!)}-` : "";
  const filename = `${prefix}card-${safe(input.policyNumber)}.pdf`;

  const subject = `Your ${branded("medical insurance card")}`;
  const lines = [
    `Dear ${input.memberName},`,
    "",
    `${subject} is attached as a PDF.`,
    "",
    "The card is for identification only and does not guarantee eligibility.",
    "Present it together with valid photo identification at the point of service.",
    "Report a lost or stolen card to your HR department immediately.",
  ];
  if (input.redirectedFrom) {
    lines.push(
      "",
      "---",
      `Prototype notice: this message was redirected here. In production it would be sent to ${input.redirectedFrom}.`,
    );
  }

  const transporter = createSmtpTransport();
  try {
    await transporter.sendMail({
      from: smtpFrom(),
      to: input.to,
      subject,
      text: lines.join("\n"),
      attachments: [
        { filename, content: input.pdf, contentType: "application/pdf" },
      ],
    });
  } catch (err) {
    logger.error({ err }, "Card PDF email failed");
    throw new DeliveryUnavailableError("Email delivery failed");
  }
}
