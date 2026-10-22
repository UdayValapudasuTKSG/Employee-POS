/**
 * The member emails: subject, plain text and HTML for each, built on one layout.
 *
 * HTML email is not the web: tables for layout, inline styles only, no web
 * fonts, no external images (the coupon's QR code travels as an inline CID
 * attachment). Every message has a plain-text part saying the same thing, for
 * clients that show no HTML. Nothing here sends anything — otpDelivery.ts does.
 *
 * The sender is named from ISSUER_NAME like everything else the member sees;
 * unset, the emails name no insurer at all.
 */
import { issuerDetails } from "./issuer";

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const COLOR = {
  brand: "#5b25cf",
  brandSoft: "#f1ecfd",
  ink: "#1d1b26",
  muted: "#6b6880",
  line: "#e6e3ef",
  page: "#f4f3f8",
  card: "#ffffff",
};
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "Consolas, 'SF Mono', Menlo, 'Courier New', monospace";

export function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const h = escapeHtml;

/** Who the email is from, as the member knows them. */
function senderName(): string | null {
  return issuerDetails().name;
}

/** "3:42 pm, 22 Oct 2026" in Guyana time, whatever the server's own zone. */
export function guyanaClock(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Guyana",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(at);
}

interface LayoutInput {
  /** Shown by most inboxes beside the subject, before the message is opened. */
  preheader: string;
  heading: string;
  /** Already-escaped HTML for the body. */
  body: string;
  /** Already-escaped HTML for the small print under the card. */
  footnote?: string;
}

function layout({ preheader, heading, body, footnote }: LayoutInput): string {
  const sender = senderName();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${h(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${COLOR.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${COLOR.page};">${h(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.page};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
      <tr><td style="padding:0 4px 14px;font-family:${FONT};font-size:13px;color:${COLOR.muted};">
        <span style="font-weight:700;color:${COLOR.brand};font-size:15px;">${h(sender ?? "Health Card")}</span>
        <span style="color:${COLOR.line};">&nbsp;|&nbsp;</span>Member portal
      </td></tr>
      <tr><td style="background:${COLOR.card};border:1px solid ${COLOR.line};border-top:4px solid ${COLOR.brand};border-radius:10px;padding:32px 32px 28px;font-family:${FONT};font-size:15px;line-height:1.6;color:${COLOR.ink};">
        <h1 style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:${COLOR.ink};">${h(heading)}</h1>
        ${body}
      </td></tr>
      <tr><td style="padding:18px 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${COLOR.muted};">
        ${footnote ? `${footnote}<br><br>` : ""}This is an automated message${sender ? ` from ${h(sender.replace(/\.$/, ""))}` : ""}. Please do not reply to it.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

const p = (html: string, style = "") => `<p style="margin:0 0 14px;${style}">${html}</p>`;

/** The code in a tinted box, large, spaced and selectable. */
function codeBlock(code: string, size = 32): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px;">
  <tr><td align="center" style="background:${COLOR.brandSoft};border-radius:8px;padding:18px 12px;font-family:${MONO};font-size:${size}px;font-weight:700;letter-spacing:${size >= 30 ? 8 : 4}px;color:${COLOR.ink};">${h(code)}</td></tr>
</table>`;
}

/** Label / value rows, for the coupon's details. */
function facts(rows: [string, string][]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-top:1px solid ${COLOR.line};">
${rows
  .map(
    ([k, v]) =>
      `  <tr><td style="padding:9px 0;border-bottom:1px solid ${COLOR.line};font-size:14px;color:${COLOR.muted};width:40%;">${h(k)}</td><td style="padding:9px 0;border-bottom:1px solid ${COLOR.line};font-size:14px;font-weight:600;color:${COLOR.ink};">${h(v)}</td></tr>`,
  )
  .join("\n")}
</table>`;
}

function redirectNote(redirectedFrom: string | null | undefined): { html: string; text: string[] } {
  if (!redirectedFrom) return { html: "", text: [] };
  const line = `Prototype notice: this message was redirected here. In production it would be sent to ${redirectedFrom}.`;
  return { html: h(line), text: ["", "---", line] };
}

// ---------------------------------------------------------------------------
// One-time codes
// ---------------------------------------------------------------------------

export type OtpPurpose = { kind: "LOGIN" } | { kind: "COUPON"; brandName: string };

export function otpEmail(code: string, minutes: number, purpose: OtpPurpose): EmailContent {
  const sender = senderName();
  const forLogin = purpose.kind === "LOGIN";
  const what = forLogin ? "sign in to the member portal" : `generate your ${purpose.brandName} discount coupon`;
  const subject = forLogin
    ? `${code} is your ${sender ? `${sender} ` : ""}verification code`
    : `${code} is your code for a ${purpose.brandName} coupon`;
  const heading = forLogin ? "Your verification code" : `Confirm your ${purpose.brandName} coupon`;

  const html = layout({
    preheader: `Use ${code} to ${what}. It expires in ${minutes} minutes.`,
    heading,
    body:
      p(`Use this code to ${h(what)}:`) +
      codeBlock(code) +
      p(`It expires in <b>${minutes} minutes</b> and works once. Never share it: we will never ask you for it by phone or message.`, `color:${COLOR.ink};`),
    footnote: forLogin
      ? "If you did not try to sign in, you can ignore this email. Nobody can get in without this code."
      : "If you did not ask for a coupon, someone may be signed in as you. Sign out of the member portal and contact your HR department.",
  });
  const text = [
    heading,
    "",
    `Use this code to ${what}: ${code}`,
    `It expires in ${minutes} minutes and works once. Never share it.`,
    "",
    forLogin
      ? "If you did not try to sign in, you can ignore this email."
      : "If you did not ask for a coupon, contact your HR department.",
  ].join("\n");
  return { subject, text, html };
}

/** The same code as an SMS: short, no markup. */
export function otpSms(code: string, minutes: number, purpose: OtpPurpose): string {
  const sender = senderName();
  const prefix = sender ? `${sender}: ` : "";
  return purpose.kind === "LOGIN"
    ? `${prefix}${code} is your verification code. It expires in ${minutes} minutes. Never share it.`
    : `${prefix}${code} is your code to generate a ${purpose.brandName} discount coupon. It expires in ${minutes} minutes.`;
}

// ---------------------------------------------------------------------------
// A discount coupon
// ---------------------------------------------------------------------------

export interface CouponEmailInput {
  memberName: string;
  brandName: string;
  /** As shown on screen and encoded in the QR: K7PQ-3MZX-9TRA. */
  code: string;
  discountPercent: number;
  expiresAt: Date;
  /** The content id the QR image is attached under. */
  qrCid: string;
  redirectedFrom?: string | null;
}

export function couponEmail(input: CouponEmailInput): EmailContent {
  const until = guyanaClock(input.expiresAt);
  const subject = `Your ${input.brandName} coupon: ${input.discountPercent}% off`;
  const redirect = redirectNote(input.redirectedFrom);

  const html = layout({
    preheader: `${input.discountPercent}% off at ${input.brandName}. Code ${input.code}, valid until ${until}.`,
    heading: `Your ${input.brandName} coupon`,
    body:
      p(`Dear ${h(input.memberName)},`) +
      p(`Here is your employee discount coupon. Show the QR code at the counter for the cashier to scan.`) +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px;">
  <tr><td align="center"><img src="cid:${h(input.qrCid)}" width="200" height="200" alt="QR code for coupon ${h(input.code)}" style="display:block;width:200px;height:200px;border:0;background:#ffffff;"></td></tr>
</table>` +
      codeBlock(input.code, 24) +
      facts([
        ["Discount", `${input.discountPercent}% off your bill`],
        ["Valid until", `${until} (Guyana time)`],
        ["Use", "Once, at " + input.brandName],
      ]) +
      p(
        `The discount comes out of your monthly allowance. If less than ${input.discountPercent}% is left, the cashier will tell you how much you can get before applying it.`,
        `font-size:14px;color:${COLOR.muted};`,
      ),
    footnote: [
      "If you did not generate this coupon, contact your HR department.",
      redirect.html,
    ]
      .filter(Boolean)
      .join("<br>"),
  });
  const text = [
    `Dear ${input.memberName},`,
    "",
    `Here is your ${input.brandName} employee discount coupon.`,
    "",
    `Coupon code:  ${input.code}`,
    `Discount:     ${input.discountPercent}% off your bill`,
    `Valid until:  ${until} (Guyana time)`,
    `Use:          once, at ${input.brandName}`,
    "",
    "Show the QR code in this email, or read out the code, at the counter.",
    `The discount comes out of your monthly allowance. If less than ${input.discountPercent}% is left, the cashier will tell you how much you can get before applying it.`,
    "",
    "If you did not generate this coupon, contact your HR department.",
    ...redirect.text,
  ].join("\n");
  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// The insurance card
// ---------------------------------------------------------------------------

export interface CardEmailInput {
  memberName: string;
  policyNumber: string;
  redirectedFrom?: string | null;
}

export function cardEmail(input: CardEmailInput): EmailContent {
  const sender = senderName();
  const subject = `Your ${sender ? `${sender} ` : ""}medical insurance card`;
  const redirect = redirectNote(input.redirectedFrom);
  const html = layout({
    preheader: `Your insurance card for policy ${input.policyNumber} is attached as a PDF.`,
    heading: "Your insurance card",
    body:
      p(`Dear ${h(input.memberName)},`) +
      p(`Your medical insurance card is attached to this email as a PDF.`) +
      facts([["Policy number", input.policyNumber]]) +
      p("Keep it on your phone or print it, and present it together with valid photo identification at the point of service.") +
      p(
        "The card is for identification only and does not guarantee eligibility. Report a lost or stolen card to your HR department immediately.",
        `font-size:14px;color:${COLOR.muted};`,
      ),
    footnote: redirect.html || undefined,
  });
  const text = [
    `Dear ${input.memberName},`,
    "",
    `Your medical insurance card (policy ${input.policyNumber}) is attached as a PDF.`,
    "",
    "Present it together with valid photo identification at the point of service.",
    "The card is for identification only and does not guarantee eligibility.",
    "Report a lost or stolen card to your HR department immediately.",
    ...redirect.text,
  ].join("\n");
  return { subject, text, html };
}
