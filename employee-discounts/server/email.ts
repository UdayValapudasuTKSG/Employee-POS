/**
 * The three emails this app sends, and the sending.
 *
 * HTML email is not the web: tables for layout, inline styles, no web fonts,
 * no remote images (the QR code travels as an inline CID attachment). Each
 * message also has a plain-text part that says the same thing.
 */
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { config } from "./config";
import { logger } from "./log";
import { guyanaClock, STORE_NAMES, STORES, type Store } from "./rules";

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

// The Beharry palette: the logo's red and black on white.
const C = {
  brand: "#ed2c25",
  brandSoft: "#fdecea",
  ink: "#17120f",
  muted: "#625a57",
  line: "#e7e1df",
  page: "#f5f3f2",
};
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "Consolas, 'SF Mono', Menlo, 'Courier New', monospace";
const APP_NAME = "Beharry Staff Discounts";


// ---------------------------------------------------------------------------
// Logos, attached inline (cid:) so they show without "load images"
// ---------------------------------------------------------------------------

const LOGO_CID = "beharry-logo";
const STORE_LOGO_FILE: Record<Store, string> = {
  KFC: "kfc.png",
  PIZZA_HUT: "pizza-hut.png",
  STERLING: "sterling-mark.png",
  BEHARRY: "beharry-mark.png",
};
const storeCid = (s: Store) => `store-${s.toLowerCase().replace("_", "-")}`;

/** web/dist/logos once built, web/public/logos in development. */
function logosDir(): string | null {
  const dirs = ["web/dist/logos", "web/public/logos"].map((d) => path.resolve(process.cwd(), d));
  return dirs.find((d) => fs.existsSync(path.join(d, "beharry.png"))) ?? null;
}

type Attachment = { filename: string; content: Buffer; contentType: string; cid?: string };

function logoAttachment(file: string, cid: string): Attachment | null {
  const dir = logosDir();
  if (!dir || !fs.existsSync(path.join(dir, file))) return null;
  return { filename: file, content: fs.readFileSync(path.join(dir, file)), contentType: "image/png", cid };
}

/** The logos of these stores, for the discount code email. */
export function storeLogoAttachments(stores: Store[] = [...STORES]): Attachment[] {
  return stores.map((s) => logoAttachment(STORE_LOGO_FILE[s], storeCid(s))).filter((a): a is Attachment => a !== null);
}

export interface EmailStore {
  store: Store;
  name: string;
  percent: number;
}

/** The stores as a row of logos, each with its name and percentage beneath. */
function storeRow(stores: EmailStore[]): string {
  const width = `${Math.floor(100 / Math.max(1, stores.length))}%`;
  const cells = stores.map(
    (s) => `<td align="center" valign="top" style="width:${width};padding:0 4px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="width:56px;height:56px;border:1px solid ${C.line};border-radius:10px;background:#ffffff;"><img src="cid:${storeCid(s.store)}" width="40" height="40" alt="${h(s.name)}" style="display:block;width:40px;height:40px;border:0;object-fit:contain;margin:0 auto;"></td></tr></table>
      <div style="margin-top:6px;font-size:12px;line-height:1.3;color:${C.muted};">${h(s.name)}</div>
      <div style="font-size:13px;font-weight:700;color:${C.brand};">${s.percent}% off</div>
    </td>`,
  ).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr>${cells}</tr></table>`;
}

export const escapeHtml = (v: string): string =>
  v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const h = escapeHtml;
const p = (html: string, style = "") => `<p style="margin:0 0 14px;${style}">${html}</p>`;

function layout(o: { preheader: string; heading: string; body: string; footnote?: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${h(o.heading)}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};">${h(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
    <tr><td style="padding:0 4px 14px;font-family:${FONT};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:12px;border-right:1px solid ${C.line};"><img src="cid:${LOGO_CID}" width="105" height="40" alt="Beharry" style="display:block;width:105px;height:40px;border:0;"></td>
        <td style="padding-left:12px;font-family:${FONT};font-size:15px;line-height:1.15;font-weight:700;color:${C.ink};">Staff<br>Discounts</td>
      </tr></table>
    </td></tr>
    <tr><td style="background:#ffffff;border:1px solid ${C.line};border-top:4px solid ${C.brand};border-radius:10px;padding:32px 32px 28px;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.ink};">
      <h1 style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:${C.ink};">${h(o.heading)}</h1>
      ${o.body}
    </td></tr>
    <tr><td style="padding:18px 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">
      ${o.footnote ? `${o.footnote}<br><br>` : ""}${APP_NAME} for Beharry Group employees. This is an automated message; please do not reply to it.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function codeBox(code: string, size: number): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px;">
<tr><td align="center" style="background:${C.brandSoft};border-radius:8px;padding:18px 12px;font-family:${MONO};font-size:${size}px;font-weight:700;letter-spacing:${size >= 30 ? 8 : 4}px;color:${C.ink};">${h(code)}</td></tr></table>`;
}

function facts(rows: [string, string][]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-top:1px solid ${C.line};">
${rows.map(([k, v]) => `<tr><td style="padding:9px 0;border-bottom:1px solid ${C.line};font-size:14px;color:${C.muted};width:38%;">${h(k)}</td><td style="padding:9px 0;border-bottom:1px solid ${C.line};font-size:14px;font-weight:600;color:${C.ink};">${h(v)}</td></tr>`).join("\n")}
</table>`;
}

export type OtpPurpose = "LOGIN" | "CODE" | "ADMIN";

export function otpEmail(otp: string, minutes: number, purpose: OtpPurpose): EmailContent {
  const login = purpose !== "CODE";
  const what =
    purpose === "ADMIN" ? `sign in to the ${APP_NAME} admin portal` : login ? `sign in to ${APP_NAME}` : "confirm your new discount code";
  const heading = purpose === "ADMIN" ? "Your admin sign-in code" : login ? "Your sign-in code" : "Confirm your new discount code";
  return {
    subject:
      purpose === "ADMIN"
        ? `${otp} is your ${APP_NAME} admin sign-in code`
        : login
          ? `${otp} is your ${APP_NAME} sign-in code`
          : `${otp} confirms your new discount code`,
    html: layout({
      preheader: `Use ${otp} to ${what}. It expires in ${minutes} minutes.`,
      heading,
      body:
        p(`Use this code to ${h(what)}:`) +
        codeBox(otp, 32) +
        p(`It expires in <b>${minutes} minutes</b> and works once. Never share it: nobody from Beharry will ever ask you for it.`),
      footnote: login
        ? "If you did not try to sign in, you can ignore this email. Nobody can get in without this code."
        : "If you did not ask for a new code, someone may be signed in as you. Sign out and tell your HR department.",
    }),
    text: [heading, "", `Use this code to ${what}: ${otp}`, `It expires in ${minutes} minutes and works once. Never share it.`].join("\n"),
  };
}

export interface CodeEmailInput {
  firstName: string;
  code: string;
  /** The stores taking codes, each with its own percentage. */
  stores: EmailStore[];
  expiresAt: Date;
  qrCid: string;
}

/** "10% off" when every store gives the same, else "up to 15% off". */
export function percentHeadline(stores: EmailStore[]): string {
  const ps = stores.map((s) => s.percent);
  const max = Math.max(0, ...ps);
  return new Set(ps).size <= 1 ? `${max}% off` : `up to ${max}% off`;
}

export function discountCodeEmail(i: CodeEmailInput): EmailContent {
  const until = guyanaClock(i.expiresAt);
  const headline = percentHeadline(i.stores);
  const where = i.stores.map((s) => `${s.name} (${s.percent}%)`).join(", ");
  return {
    subject: `Your staff discount code: ${headline}`,
    html: layout({
      preheader: `${i.code}: ${headline} at ${i.stores.map((s) => s.name).join(" · ")}. Valid until ${until}.`,
      heading: "Your discount code",
      body:
        p(`Hi ${h(i.firstName)},`) +
        p(`Here is your staff discount code. Show the QR code at the counter of any participating store.`) +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px;"><tr><td align="center"><img src="cid:${h(i.qrCid)}" width="200" height="200" alt="QR code for ${h(i.code)}" style="display:block;width:200px;height:200px;border:0;background:#ffffff;"></td></tr></table>` +
        codeBox(i.code, 24) +
        p(`<b>Use it at any one of:</b>`, "margin-bottom:10px;") +
        storeRow(i.stores) +
        facts([
          ["Discount", `${headline[0]!.toUpperCase()}${headline.slice(1)} your bill, depending on the store`],
          ["Valid until", `${until} (Guyana time)`],
          ["Uses", "Once, at one store"],
        ]) +
        p(
          `The discount comes out of your monthly allowance. If not enough is left for the full percentage, the cashier will tell you what you can get before applying it.`,
          `font-size:14px;color:${C.muted};`,
        ),
      footnote: `If you did not generate this code, sign in at ${h(config.appUrl)} and tell your HR department.`,
    }),
    text: [
      `Hi ${i.firstName},`,
      "",
      "Here is your staff discount code.",
      "",
      `Code:         ${i.code}`,
      `Discount:     ${headline} your bill`,
      `Use at:       ${where}`,
      `Valid until:  ${until} (Guyana time)`,
      "Uses:         once, at one store",
      "",
      "Show the QR code in this email, or read out the code, at the counter.",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export class EmailUnavailableError extends Error {}

export const emailConfigured = (): boolean => Boolean(config.smtp.host);

export async function sendEmail(to: string, content: EmailContent, extra: Attachment[] = []): Promise<void> {
  // Every email carries the Beharry logo its header points at.
  const header = logoAttachment("beharry.png", LOGO_CID);
  const attachments = header ? [header, ...extra] : extra;
  if (!emailConfigured()) throw new EmailUnavailableError("SMTP_HOST is not set");
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass ?? "" } : undefined,
  });
  try {
    await transport.sendMail({ from: config.smtp.from, to, subject: content.subject, text: content.text, html: content.html, attachments });
  } catch (err) {
    logger.error("Email send failed", { err, subject: content.subject });
    throw new EmailUnavailableError("Email delivery failed");
  }
}
