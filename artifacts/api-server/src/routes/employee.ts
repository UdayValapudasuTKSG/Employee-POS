/**
 * The public employee card flow: lookup, one-time code, card, card email, and
 * the member's own Requests For Modification.
 *
 * specs/002-per-company-schema/contracts/employee-lookup.md. The lookup
 * searches every active company in the shared BHI tables. A contact that
 * matches nobody is refused with CONTACT_NOT_FOUND (a product decision that
 * departs from Constitution Principle I). Otherwise, before the code is
 * verified, it gives one answer — CODE_SENT, same shape, at least the same
 * time — whether the contact matched one member, several in one company, or
 * members in several companies (spec FR-016). What happens next is decided
 * only after the code is verified.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  activityLogTable,
  bhiBeneficiaryTable,
  bhiCompanyTable,
  bhiDependentTable,
  bhiMemberTable,
  changeRequestsTable,
  policyMembershipsTable,
  employeeSessionsTable,
  withScope,
  type BhiCompany,
  type BhiMember,
  type LookupMatch,
  type Scope,
} from "@workspace/db";
import {
  LookupMemberBody,
  SelectVerifiedRecordBody,
  VerifyOtpBody,
  ResendOtpBody,
  CreateChangeRequestBody,
} from "@workspace/api-zod";
import { writeAudit } from "../lib/audit";
import { decodeDocument, sanitiseFileName } from "../lib/documentUpload";
import {
  effectiveChanges,
  subjectName,
  type DependentRelationship,
  type SubjectSnapshot,
} from "../lib/changeRequest";
import {
  generateOtpCode,
  generateOpaqueToken,
  sha256,
  signToken,
  verifyToken,
  isOtpDevMode,
  OTP_TTL_SECONDS,
  CARD_TTL_SECONDS,
  MAX_OTP_ATTEMPTS,
} from "../lib/auth";
import { maskIdentifier, disambiguationLabel } from "../lib/masking";
import { deliverOtp, DeliveryUnavailableError, resolveCardRecipient, sendCardEmail } from "../lib/otpDelivery";
import { MIN_MATCHABLE_DIGITS, phoneDigits, phoneMatches, phoneSuffix, phoneSuffixSql } from "../lib/phone";
import { hasReachedRetirementAge } from "../lib/retirement";
import { guyanaToday } from "../lib/guyanaTime";
import { renderCardPdf } from "../lib/cardPdf";
import { issuerDetails } from "../lib/issuer";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * The employee flow reads across every company — the company is not known
 * until the contact matches — and never writes the bhi tables, so it uses the
 * all-companies scope read-only. What a caller may see is narrowed by the
 * verification session and card session, not by an admin scope.
 */
const LOOKUP_SCOPE: Scope = { all: true, readOnly: true };

/** Every /v1/lookup answer takes at least this long, whatever it matched (FR-016). */
function lookupMinMs(): number {
  const raw = Number(process.env["LOOKUP_MIN_MS"]);
  return Number.isFinite(raw) && raw >= 0 ? raw : 800;
}

const MULTI_COMPANY_MESSAGE =
  "Your details were found in more than one company. Please contact your HR department.";

function normalizeIdentifier(raw: string): { value: string; channel: "EMAIL" | "PHONE" } {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) {
    return { value: trimmed.toLowerCase(), channel: "EMAIL" };
  }
  // Normalize phone: keep digits, preserve leading +
  const digits = trimmed.replace(/[^\d+]/g, "");
  return { value: digits, channel: "PHONE" };
}

/**
 * May this member be issued a card?
 *
 * Active in the BHI model and in an active company. Cover also ends on the 65th
 * birthday itself, not whenever the sweep next runs, so the age is checked here
 * too; a member with no date of birth on file cannot be aged out by this rule.
 */
function eligible(m: BhiMember): boolean {
  if (!m.active) return false;
  return !(m.dateOfBirth && hasReachedRetirementAge(m.dateOfBirth, guyanaToday()));
}

interface Match {
  member: BhiMember;
  company: BhiCompany;
}

/**
 * Every eligible member of an active company whose stored contact matches.
 *
 * Phone matching accepts a national form for an international one, so an
 * employee can type the digits they know. That is safe only because the code
 * goes to the member's STORED number, never the typed one (see
 * deliveryDestinations): typing a longer number one controls can match a
 * member, but cannot redirect their code.
 */
async function findMatches(value: string, channel: "EMAIL" | "PHONE"): Promise<Match[]> {
  if (channel === "PHONE" && phoneDigits(value).length < MIN_MATCHABLE_DIGITS) return [];
  const rows = await withScope(LOOKUP_SCOPE, (tx) =>
    tx
      .select({ member: bhiMemberTable, company: bhiCompanyTable })
      .from(bhiMemberTable)
      .innerJoin(bhiCompanyTable, eq(bhiCompanyTable.companyNumber, bhiMemberTable.companyNumber))
      .where(
        and(
          eq(bhiCompanyTable.active, true),
          eq(bhiMemberTable.active, true),
          // Stored emails keep whatever case they were entered in; the typed
          // one is lower-cased, so compare case-insensitively.
          channel === "EMAIL"
            ? sql`lower(btrim(${bhiMemberTable.email})) = ${value}`
            : eq(phoneSuffixSql(bhiMemberTable.phone), phoneSuffix(value)),
        ),
      ),
  );
  return rows
    .filter((r) => channel === "EMAIL" || phoneMatches(r.member.phone, value))
    .filter((r) => eligible(r.member));
}

/** The matches, re-read now: a member deactivated since the lookup no longer counts. */
async function currentMatches(matched: LookupMatch[]): Promise<Match[]> {
  if (matched.length === 0) return [];
  const rows = await withScope(LOOKUP_SCOPE, (tx) =>
    tx
      .select({ member: bhiMemberTable, company: bhiCompanyTable })
      .from(bhiMemberTable)
      .innerJoin(bhiCompanyTable, eq(bhiCompanyTable.companyNumber, bhiMemberTable.companyNumber))
      .where(
        and(
          inArray(
            bhiMemberTable.memberId,
            matched.map((m) => m.memberId),
          ),
          eq(bhiCompanyTable.active, true),
        ),
      ),
  );
  return rows.filter((r) => eligible(r.member));
}

/** Each distinct stored contact of the matched members on this channel. */
function deliveryDestinations(channel: "EMAIL" | "PHONE", matches: Match[]): string[] {
  const out = new Set<string>();
  for (const { member } of matches) {
    const own = (channel === "PHONE" ? member.phone : member.email)?.trim();
    if (own) out.add(own);
  }
  return [...out];
}

async function logEvent(identifier: string, eventType: string, result: string, errorCode?: string): Promise<void> {
  await db.insert(activityLogTable).values({
    kind: "EVENT",
    actor: sha256(identifier).slice(0, 16),
    action: eventType,
    result,
    errorCode: errorCode ?? null,
  });
}

/**
 * Sends the code to each destination after the response has gone. A failure is
 * logged against the session — HR sees it on the verifications screen — and
 * never changes what the caller was told, because only a real match can reach
 * a provider and a different answer would reveal that one existed.
 */
function deliverLater(sessionId: string, channel: "EMAIL" | "PHONE", destinations: string[], code: string): void {
  if (destinations.length === 0) return;
  setImmediate(() => {
    void (async () => {
      for (const destination of destinations) {
        try {
          await deliverOtp(channel, destination, code);
        } catch (err) {
          const code_ = err instanceof DeliveryUnavailableError ? "DELIVERY_UNAVAILABLE" : "DELIVERY_FAILED";
          logger.warn({ err, verificationId: sessionId, channel }, "Verification code delivery failed");
          await logEvent(sessionId, "OTP_DELIVERY", "FAILED", code_).catch(() => undefined);
        }
      }
    })();
  });
}

async function holdUntil(startedAt: number): Promise<void> {
  const wait = lookupMinMs() - (Date.now() - startedAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function codeSentResponse(verificationId: string, maskedDestination: string, devCode: string | null) {
  return {
    status: "CODE_SENT" as const,
    message: "If this contact is on file, a 6-digit code has been sent.",
    verificationId,
    maskedDestination,
    lookupRef: null,
    options: null,
    devCode,
  };
}

router.post("/v1/lookup", async (req, res): Promise<void> => {
  const startedAt = Date.now();
  const parsed = LookupMemberBody.safeParse(req.body);
  if (!parsed.success) {
    // Depends only on the input's format, never on whether anyone matched.
    res.status(400).json({ error: { code: "INVALID_INPUT", message: "Enter an email address or phone number." } });
    return;
  }
  const { value, channel } = normalizeIdentifier(parsed.data.identifier);
  const matches = await findMatches(value, channel);
  if (matches.length === 0) {
    // A deliberate exception to the uniform answer (Constitution Principle I):
    // an unknown contact is told so, rather than sent to a code that can never
    // arrive. No session is created and nothing is delivered.
    await logEvent(value, "LOOKUP", "NOT_FOUND", "CONTACT_NOT_FOUND");
    await holdUntil(startedAt);
    res.status(404).json({
      error: {
        code: "CONTACT_NOT_FOUND",
        message:
          channel === "EMAIL"
            ? "We couldn't find that email. Use the correct email your employer has on file."
            : "We couldn't find that phone number. Use the correct mobile number your employer has on file.",
      },
    });
    return;
  }
  const destinations = deliveryDestinations(channel, matches);
  // Masked from the stored contact when there is one, so the member sees where
  // the code actually went; from the typed value for a decoy, so both look alike.
  const masked = maskIdentifier(destinations[0] ?? value);
  const code = generateOtpCode();
  const [session] = await db
    .insert(employeeSessionsTable)
    .values({
      lookupChannel: channel,
      maskedDestination: masked,
      destination: destinations[0] ?? value,
      otpHash: sha256(code),
      companyCode: null,
      matchedMembers: matches.map((m) => ({ companyNumber: m.company.companyNumber, memberId: m.member.memberId })),
      expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
    })
    .returning();

  const devMode = isOtpDevMode();
  if (devMode && matches.length > 0) {
    // Dev mode surfaces the code instead of sending it. Decoy sessions get none:
    // their codes can never verify, so showing one would only mislead.
    logger.info({ destination: masked, code }, "[OTP] dev-mode delivery");
  }
  await logEvent(value, "LOOKUP", "CODE_SENT");
  await holdUntil(startedAt);
  res.json(codeSentResponse(session!.id, masked, devMode && matches.length > 0 ? code : null));
  if (!devMode) deliverLater(session!.id, channel, destinations, code);
});

router.post("/v1/otp/resend", async (req, res): Promise<void> => {
  const parsed = ResendOtpBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "INVALID_INPUT", message: "Start the lookup again." } });
    return;
  }
  const [session] = await db
    .select()
    .from(employeeSessionsTable)
    .where(eq(employeeSessionsTable.id, parsed.data.verificationId));
  if (!session || session.status !== "PENDING") {
    res.status(400).json({ error: { code: "SESSION_INVALID", message: "This code request is no longer active. Start the lookup again." } });
    return;
  }
  if (Date.now() - session.lastSentAt.getTime() < 60_000) {
    res.status(429).json({ error: { code: "RESEND_TOO_SOON", message: "Wait a minute before requesting another code." } });
    return;
  }
  if (session.resendCount >= 3) {
    res.status(429).json({ error: { code: "RESEND_LIMIT", message: "Code limit reached. Start the lookup again later." } });
    return;
  }
  const code = generateOtpCode();
  await db
    .update(employeeSessionsTable)
    .set({
      otpHash: sha256(code),
      resendCount: session.resendCount + 1,
      lastSentAt: new Date(),
      attempts: 0,
      expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
    })
    .where(eq(employeeSessionsTable.id, session.id));
  const matches = await currentMatches(session.matchedMembers);
  const devMode = isOtpDevMode();
  if (devMode && matches.length > 0) {
    logger.info({ destination: session.maskedDestination, code }, "[OTP] dev-mode delivery (resend)");
  }
  res.json({
    status: "CODE_SENT",
    message: "A new code has been sent.",
    verificationId: session.id,
    maskedDestination: session.maskedDestination,
    lookupRef: null,
    options: null,
    devCode: devMode && matches.length > 0 ? code : null,
  });
  if (!devMode) deliverLater(session.id, session.lookupChannel, deliveryDestinations(session.lookupChannel, matches), code);
});

type VerificationSession = typeof employeeSessionsTable.$inferSelect;

/** A signed choice between records, valid only for the verification that produced it. */
const OPTION_TTL_SECONDS = 10 * 60;

function verifyResult(over: {
  status: "CARD" | "SELECT" | "MULTI_COMPANY";
  cardToken?: string;
  expiresAt?: string;
  confirm?: { firstName: string; maskedIdentifier: string; companyName: string };
  options?: { ref: string; label: string }[];
  message?: string;
}) {
  return {
    status: over.status,
    cardToken: over.cardToken ?? null,
    expiresAt: over.expiresAt ?? null,
    confirm: over.confirm ?? null,
    options: over.options ?? null,
    message: over.message ?? null,
  };
}

async function issueCard(res: Response, session: VerificationSession, match: Match): Promise<void> {
  const token = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + CARD_TTL_SECONDS * 1000);
  // The card lives on the same session row: one lookup, one card.
  await db
    .update(employeeSessionsTable)
    .set({
      status: "VERIFIED",
      cardTokenHash: sha256(token),
      cardMemberId: match.member.memberId,
      cardIssuedAt: new Date(),
      cardExpiresAt: expiresAt,
      cardRevoked: false,
    })
    .where(eq(employeeSessionsTable.id, session.id));
  await logEvent(session.id, "OTP_VERIFY", "VERIFIED");
  res.json(
    verifyResult({
      status: "CARD",
      cardToken: token,
      expiresAt: expiresAt.toISOString(),
      confirm: {
        firstName: match.member.firstName,
        maskedIdentifier: session.maskedDestination,
        companyName: match.company.companyName,
      },
    }),
  );
}

router.post("/v1/otp/verify", async (req, res): Promise<void> => {
  const parsed = VerifyOtpBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "INVALID_INPUT", message: "Enter the 6-digit code." } });
    return;
  }
  const [session] = await db
    .select()
    .from(employeeSessionsTable)
    .where(eq(employeeSessionsTable.id, parsed.data.verificationId));
  if (!session) {
    res.status(400).json({ error: { code: "SESSION_INVALID", message: "This code request is no longer active. Start the lookup again." } });
    return;
  }
  if (session.status === "LOCKED") {
    res.status(423).json({ error: { code: "SESSION_LOCKED", message: "Too many incorrect attempts. Start the lookup again in a few minutes." } });
    return;
  }
  if (session.status !== "PENDING" || session.expiresAt.getTime() < Date.now()) {
    if (session.status === "PENDING") {
      await db.update(employeeSessionsTable).set({ status: "EXPIRED" }).where(eq(employeeSessionsTable.id, session.id));
    }
    res.status(400).json({ error: { code: "CODE_EXPIRED", message: "This code has expired. Request a new one." } });
    return;
  }

  const codeMatches = sha256(parsed.data.code) === session.otpHash;

  // A decoy session (nothing matched) can never verify, and fails exactly like
  // a wrong code. There is deliberately no dev-mode exception: one used to
  // issue a real member's card for any code on a decoy, which is an
  // authentication bypass one environment variable from production.
  if (!codeMatches || session.matchedMembers.length === 0) {
    const attempts = session.attempts + 1;
    const locked = attempts >= MAX_OTP_ATTEMPTS;
    await db
      .update(employeeSessionsTable)
      .set({ attempts, status: locked ? "LOCKED" : "PENDING" })
      .where(eq(employeeSessionsTable.id, session.id));
    await logEvent(session.id, "OTP_VERIFY", locked ? "LOCKED" : "FAILED", "CODE_INVALID");
    if (locked) {
      res.status(423).json({ error: { code: "SESSION_LOCKED", message: "Too many incorrect attempts. Start the lookup again in a few minutes." } });
      return;
    }
    res.status(400).json({
      error: {
        code: "CODE_INVALID",
        message: `That code is not correct. ${MAX_OTP_ATTEMPTS - attempts} attempt${MAX_OTP_ATTEMPTS - attempts === 1 ? "" : "s"} left.`,
      },
    });
    return;
  }

  const matches = await currentMatches(session.matchedMembers);
  if (matches.length === 0) {
    res.status(400).json({ error: { code: "CODE_INVALID", message: "That code is not correct." } });
    return;
  }

  const companies = new Set(matches.map((m) => m.company.companyNumber));
  if (companies.size > 1) {
    // Found in more than one company: no card, no company named, and an alert
    // for NALICO's super admins (and the groups involved) to resolve.
    await db
      .update(employeeSessionsTable)
      .set({
        status: "VERIFIED",
        alertStatus: "OPEN",
        alertMatches: matches.map((m) => ({ companyNumber: m.company.companyNumber, memberId: m.member.memberId })),
        alertRaisedAt: new Date(),
      })
      .where(eq(employeeSessionsTable.id, session.id));
    await logEvent(session.id, "OTP_VERIFY", "MULTI_COMPANY");
    res.json(verifyResult({ status: "MULTI_COMPANY", message: MULTI_COMPANY_MESSAGE }));
    return;
  }

  if (matches.length === 1) {
    await issueCard(res, session, matches[0]!);
    return;
  }

  // Several records in one company share this contact — a household. The
  // choice is offered only now, to someone who has proved they control the
  // contact, with non-identifying labels.
  await db.update(employeeSessionsTable).set({ status: "VERIFIED" }).where(eq(employeeSessionsTable.id, session.id));
  await logEvent(session.id, "OTP_VERIFY", "SELECT_REQUIRED");
  res.json(
    verifyResult({
      status: "SELECT",
      options: matches.map((m) => ({
        ref: signToken({ kind: "verified-option", verificationId: session.id, memberId: m.member.memberId }, OPTION_TTL_SECONDS),
        label: disambiguationLabel(m.member.firstName, m.member.lastName, m.member.dateOfBirth),
      })),
    }),
  );
});

router.post("/v1/otp/select", async (req, res): Promise<void> => {
  const parsed = SelectVerifiedRecordBody.safeParse(req.body);
  const expired = () =>
    res.status(400).json({ error: { code: "SELECTION_EXPIRED", message: "This selection has expired. Start the lookup again." } });
  if (!parsed.success) {
    expired();
    return;
  }
  const option = verifyToken(parsed.data.optionRef);
  if (!option || option["kind"] !== "verified-option" || option["verificationId"] !== parsed.data.verificationId) {
    expired();
    return;
  }
  const [session] = await db
    .select()
    .from(employeeSessionsTable)
    .where(eq(employeeSessionsTable.id, parsed.data.verificationId));
  if (!session || session.status !== "VERIFIED") {
    expired();
    return;
  }
  const memberId = Number(option["memberId"]);
  const matches = await currentMatches(session.matchedMembers.filter((m) => m.memberId === memberId));
  if (matches.length !== 1) {
    expired();
    return;
  }
  await issueCard(res, session, matches[0]!);
});

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

async function cardSessionFromRequest(req: Request) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const tokenHash = sha256(header.slice(7));
  const [session] = await db
    .select()
    .from(employeeSessionsTable)
    .where(
      and(
        eq(employeeSessionsTable.cardTokenHash, tokenHash),
        eq(employeeSessionsTable.cardRevoked, false),
        gt(employeeSessionsTable.cardExpiresAt, new Date()),
      ),
    );
  return session?.cardMemberId != null && session.cardExpiresAt
    ? { memberRef: session.cardMemberId, expiresAt: session.cardExpiresAt }
    : null;
}

type CardUnavailable = "SESSION" | "NO_POLICY";

/** The member, if still eligible and in an active company. Also used by the POS (routes/discounts.ts). */
export async function memberForSession(memberRef: number): Promise<Match | null> {
  const [row] = await withScope(LOOKUP_SCOPE, (tx) =>
    tx
      .select({ member: bhiMemberTable, company: bhiCompanyTable })
      .from(bhiMemberTable)
      .innerJoin(bhiCompanyTable, eq(bhiCompanyTable.companyNumber, bhiMemberTable.companyNumber))
      .where(and(eq(bhiMemberTable.memberId, memberRef), eq(bhiCompanyTable.active, true))),
  );
  return row && eligible(row.member) ? row : null;
}

/**
 * Loads everything the card needs for a live session, or the reason it cannot
 * be shown. Shared by GET /v1/card and POST /v1/card/email so the emailed PDF
 * can never drift from what the screen displays.
 */
async function loadCardContext(req: Request) {
  const session = await cardSessionFromRequest(req);
  if (!session) return { ok: false as const, error: "SESSION" as CardUnavailable };
  const match = await memberForSession(session.memberRef!);
  if (!match) return { ok: false as const, error: "SESSION" as CardUnavailable };
  const memberId = match.member.memberId;
  const [policy] = await db.select().from(policyMembershipsTable).where(eq(policyMembershipsTable.memberRef, memberId));
  if (!policy) return { ok: false as const, error: "NO_POLICY" as CardUnavailable };
  const { dependents, beneficiaries } = await withScope(LOOKUP_SCOPE, async (tx) => ({
    dependents: await tx
      .select()
      .from(bhiDependentTable)
      .where(and(eq(bhiDependentTable.memberId, memberId), eq(bhiDependentTable.active, true)))
      .orderBy(bhiDependentTable.dependentId),
    beneficiaries: await tx
      .select()
      .from(bhiBeneficiaryTable)
      .where(and(eq(bhiBeneficiaryTable.memberId, memberId), eq(bhiBeneficiaryTable.active, true)))
      .orderBy(bhiBeneficiaryTable.beneficiaryId),
  }));
  return { ok: true as const, session, member: match.member, company: match.company, policy, dependents, beneficiaries };
}

export function respondCardUnavailable(res: Response, error: CardUnavailable): void {
  if (error === "NO_POLICY") {
    res.status(404).json({ error: { code: "NO_POLICY", message: "No active policy is on file. Contact your HR department." } });
    return;
  }
  res.status(401).json({ error: { code: "SESSION_EXPIRED", message: "Your card session has ended. Verify again to view your card." } });
}

router.get("/v1/card", async (req, res): Promise<void> => {
  const ctx = await loadCardContext(req);
  if (!ctx.ok) {
    respondCardUnavailable(res, ctx.error);
    return;
  }
  const { session, member, company, policy, dependents, beneficiaries } = ctx;
  const issuer = issuerDetails();
  res.json({
    // The configured issuer name wins over the policy's, so a rebrand is one
    // environment variable rather than an UPDATE across every policy row.
    insurerName: issuer.name ?? policy.insurerName,
    planName: policy.planName,
    policyholder: policy.policyholder,
    policyNumber: policy.policyNumber,
    groupNumber: policy.groupNumber,
    memberId: policy.memberNumber,
    certificateNumber: policy.certificateNumber,
    employeeName: `${member.firstName} ${member.lastName}`,
    identificationId: member.idNumber,
    idType: member.idType,
    classCode: member.classCode,
    dateOfBirth: member.dateOfBirth,
    effectiveDate: policy.effectiveDate,
    expiryDate: policy.expiryDate,
    companyName: company.companyName,
    dependents: dependents.map((d) => ({
      // The id is what lets the member name this dependant in an RFM.
      id: String(d.dependentId),
      fullName: d.dependentFullName,
      relationship: d.relationship,
      dateOfBirth: d.dateOfBirth,
    })),
    beneficiaries: beneficiaries.map((b) => ({
      fullName: b.beneficiaryFullName,
      relationship: b.relationship,
      allocationPercent: b.sharePercent == null ? null : Number(b.sharePercent),
    })),
    // Everything the card face states about who issued it. Sent as data so the
    // screen and the PDF render the same configured values.
    issuer: {
      address: issuer.address,
      phone: issuer.phone,
      signatoryName: issuer.signatoryName,
      signatoryTitle: issuer.signatoryTitle,
      planTitle: issuer.planTitle,
      propertyNotice: issuer.propertyNotice,
    },
    backNotice: issuer.backNotice,
    sessionExpiresAt: session.expiresAt.toISOString(),
  });
});

/**
 * Emails the card to the member as a PDF. Authorised by the same card session
 * token as GET /v1/card, so only a member who has just passed OTP verification
 * can trigger it, and only for their own record.
 */
router.post("/v1/card/email", async (req, res): Promise<void> => {
  const ctx = await loadCardContext(req);
  if (!ctx.ok) {
    respondCardUnavailable(res, ctx.error);
    return;
  }
  const { member, policy, dependents } = ctx;

  const { to, redirectedFrom } = resolveCardRecipient(member.email);
  if (!to) {
    res.status(400).json({
      error: { code: "NO_EMAIL_ON_FILE", message: "No email address is on file for you. Contact your HR department." },
    });
    return;
  }

  const issuer = issuerDetails();
  const pdf = renderCardPdf({
    insurerName: issuer.name ?? policy.insurerName,
    insurerAddress: issuer.address,
    insurerPhone: issuer.phone,
    signatoryName: issuer.signatoryName,
    signatoryTitle: issuer.signatoryTitle,
    planTitle: issuer.planTitle,
    policyholder: policy.policyholder,
    policyNumber: policy.policyNumber,
    employeeName: `${member.firstName} ${member.lastName}`,
    identificationId: member.idNumber,
    idType: member.idType,
    classCode: member.classCode,
    dateOfBirth: member.dateOfBirth,
    effectiveDate: policy.effectiveDate,
    dependents: dependents.map((d) => ({
      fullName: d.dependentFullName,
      relationship: d.relationship,
      dateOfBirth: d.dateOfBirth,
    })),
  });

  try {
    await sendCardEmail({
      to,
      memberName: `${member.firstName} ${member.lastName}`,
      policyNumber: policy.policyNumber,
      pdf,
      redirectedFrom,
    });
  } catch (err) {
    // Same honesty rule as OTP delivery: never claim a send that did not happen.
    if (err instanceof DeliveryUnavailableError) {
      await logEvent(to, "CARD_EMAIL", "FAILED", "EMAIL_DELIVERY_UNAVAILABLE");
      res.status(503).json({
        error: { code: "EMAIL_DELIVERY_UNAVAILABLE", message: "The card could not be emailed right now. Try again later." },
      });
      return;
    }
    throw err;
  }

  await logEvent(to, "CARD_EMAIL", "SENT");
  res.json({ ok: true, maskedDestination: maskIdentifier(to) });
});

// ---------------------------------------------------------------------------
// Requests For Modification (RFM)
// ---------------------------------------------------------------------------

/**
 * One open request per PERSON, not per member.
 *
 * The subject is the member themselves or one specific dependant, so an
 * employee may have a correction in flight for their child and another for
 * their spouse. What they cannot do is stack two requests for the same person:
 * approving both in order would apply a correction to a value the first one
 * already changed.
 */
const MAX_PENDING_PER_SUBJECT = 1;

/** The member's audit and event key: company and MemberID, never contact details. */
export function memberKey(member: BhiMember): string {
  return `member:${member.companyNumber}:${member.memberId}`;
}

/**
 * The card session's member, like loadCardContext but WITHOUT the policy
 * requirement. A member with no policy cannot be shown a card, but must still
 * be able to correct their own name — indeed that is exactly when a correction
 * is most likely — and use their employee discounts (routes/discounts.ts).
 */
export async function sessionMember(req: Request) {
  const session = await cardSessionFromRequest(req);
  if (!session) return null;
  const match = await memberForSession(session.memberRef!);
  if (!match) return null;
  return { session, member: match.member, company: match.company };
}

function ownChangeRequestJson(r: typeof changeRequestsTable.$inferSelect, documentFileName: string | null) {
  return {
    id: r.id,
    subjectType: r.subjectType,
    subjectName: subjectName(r.currentFirstName, r.currentLastName),
    requestedFirstName: r.requestedFirstName,
    requestedLastName: r.requestedLastName,
    requestedDateOfBirth: r.requestedDateOfBirth,
    requestedRelationship: r.requestedRelationship,
    employeeNote: r.employeeNote,
    status: r.status,
    reviewNote: r.reviewNote,
    documentFileName,
    createdAt: r.createdAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    // reviewedBy is deliberately absent: an employee has no need for the
    // reviewing administrator's email address.
  };
}

router.post("/v1/card/change-requests", async (req, res): Promise<void> => {
  const parsed = CreateChangeRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "INVALID_INPUT", message: "Choose what to change and attach a supporting document." } });
    return;
  }

  const actor = await sessionMember(req);
  if (!actor) {
    respondCardUnavailable(res, "SESSION");
    return;
  }
  const { member, company } = actor;
  const body = parsed.data;

  // Resolve the subject. A dependant must belong to the caller — this is the
  // whole authorisation check for the dependant path, so it filters on the
  // member rather than trusting the id alone.
  let subjectType: "MEMBER" | "DEPENDENT" = "MEMBER";
  let dependentId: number | null = null;
  let snapshot: SubjectSnapshot = {
    firstName: member.firstName,
    lastName: member.lastName,
    dateOfBirth: member.dateOfBirth,
    relationship: null,
  };

  if (body.dependentId) {
    const id = /^\d{1,9}$/.test(body.dependentId) ? Number(body.dependentId) : -1;
    const [dependent] = await withScope(LOOKUP_SCOPE, (tx) =>
      tx
        .select()
        .from(bhiDependentTable)
        .where(
          and(
            eq(bhiDependentTable.dependentId, id),
            eq(bhiDependentTable.memberId, member.memberId),
            eq(bhiDependentTable.active, true),
          ),
        ),
    );
    if (!dependent) {
      res.status(400).json({ error: { code: "UNKNOWN_DEPENDENT", message: "That dependant is not on your record." } });
      return;
    }
    subjectType = "DEPENDENT";
    dependentId = dependent.dependentId;
    // A BHI dependant has one full-name field; see SubjectSnapshot.
    snapshot = {
      firstName: dependent.dependentFullName,
      lastName: "",
      dateOfBirth: dependent.dateOfBirth,
      relationship: dependent.relationship,
    };
  }

  const changes = effectiveChanges(body, snapshot, subjectType);
  if (changes.length === 0) {
    res.status(400).json({ error: { code: "NO_CHANGES", message: "Enter at least one value that differs from what is on record." } });
    return;
  }

  // Scoped to the subject: dependent_ref IS NULL identifies a request about the
  // member themselves, so the member arm tests for null rather than omitting the
  // condition — omitting it would count the dependants' requests too.
  const [{ n: pendingCount } = { n: 0 }] = await db
    .select({ n: count() })
    .from(changeRequestsTable)
    .where(
      and(
        eq(changeRequestsTable.memberRef, member.memberId),
        eq(changeRequestsTable.status, "PENDING"),
        dependentId != null ? eq(changeRequestsTable.dependentRef, dependentId) : isNull(changeRequestsTable.dependentRef),
      ),
    );
  if (pendingCount >= MAX_PENDING_PER_SUBJECT) {
    const who = subjectType === "DEPENDENT" ? snapshot.firstName : "yourself";
    res.status(400).json({
      error: {
        code: "TOO_MANY_PENDING",
        message: `You already have a request awaiting review for ${who}. Wait for HR to decide it before raising another.`,
      },
    });
    return;
  }

  const decoded = decodeDocument(body.document.contentBase64, body.document.mimeType);
  if (!decoded.ok) {
    res.status(400).json({ error: { code: decoded.code, message: decoded.message } });
    return;
  }

  const byField = new Map(changes.map((c) => [c.field, c.requested]));
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(changeRequestsTable)
      .values({
        memberRef: member.memberId,
        subjectType,
        dependentRef: dependentId,
        currentFirstName: snapshot.firstName,
        currentLastName: snapshot.lastName,
        currentDateOfBirth: snapshot.dateOfBirth,
        currentRelationship: snapshot.relationship,
        // A dependant's requested full name is stored as its first name (see changeList).
        requestedFirstName: byField.get(subjectType === "DEPENDENT" ? "fullName" : "firstName") ?? null,
        requestedLastName: subjectType === "DEPENDENT" ? null : (byField.get("lastName") ?? null),
        requestedDateOfBirth: byField.get("dateOfBirth") ?? null,
        requestedRelationship: (byField.get("relationship") as DependentRelationship | undefined) ?? null,
        employeeNote: body.employeeNote?.trim() || null,
        documentType: body.document.documentType,
        documentFileName: sanitiseFileName(body.document.fileName),
        // The SNIFFED type, never the declared one.
        documentMimeType: decoded.document.mimeType,
        documentByteSize: decoded.document.byteSize,
        documentSha256: decoded.document.sha256,
        documentContent: decoded.document.bytes,
      })
      .returning();
    return row!;
  });

  await writeAudit({
    // Company and MemberID, not their email — traceable without copying PII
    // into the audit trail.
    actor: memberKey(member),
    actorRole: "ROLE_EMPLOYEE",
    action: "CHANGE_REQUEST_SUBMITTED",
    entityType: "CHANGE_REQUEST",
    entityId: created.id,
    afterValue: JSON.stringify({
      subjectType,
      changes: changes.map((c) => c.field),
      documentSha256: decoded.document.sha256,
    }),
    sourceIp: req.ip ?? null,
    companyCode: company.companyNumber,
  });

  await logEvent(memberKey(member), "CHANGE_REQUEST", "SUBMITTED");
  res.json(ownChangeRequestJson(created, sanitiseFileName(body.document.fileName)));
});

router.get("/v1/card/change-requests", async (req, res): Promise<void> => {
  const actor = await sessionMember(req);
  if (!actor) {
    respondCardUnavailable(res, "SESSION");
    return;
  }
  const rows = await db
    .select({ request: changeRequestsTable, documentFileName: changeRequestsTable.documentFileName })
    .from(changeRequestsTable)
    .where(eq(changeRequestsTable.memberRef, actor.member.memberId))
    .orderBy(desc(changeRequestsTable.createdAt));

  res.json(rows.map((r) => ownChangeRequestJson(r.request, r.documentFileName)));
});

router.post("/v1/session/logout", async (req, res): Promise<void> => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    await db
      .update(employeeSessionsTable)
      .set({ cardRevoked: true })
      .where(eq(employeeSessionsTable.cardTokenHash, sha256(header.slice(7))));
  }
  res.json({ ok: true });
});

export default router;
