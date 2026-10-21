/**
 * Pure rules for the BHI Member fields an administrator enters by hand — the
 * create form and the edit form (spec FR-003, FR-007).
 *
 * The route does the database work; everything decidable without a query lives
 * here so it can be unit-tested. The sizes are the Access file's: a value longer
 * than its column is refused with the field named, never truncated.
 */

import { parseImportDate, normaliseSex } from "./memberImport";
import { normalizeMemberPhone } from "./phone";
import { toCents, centsToMoney } from "./rateBands";

/** The editable BHI Member fields as the API receives them (MemberFields). */
export interface MemberFieldsInput {
  idType?: string;
  idNumber?: string;
  firstName?: string;
  lastName?: string;
  middleInitials?: string | null;
  dateOfBirth?: string | null;
  sex?: string | null;
  classCode?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  email?: string | null;
  phone?: string | null;
  employmentDate?: string | null;
  planDate?: string | null;
  rateOfPay?: string | null;
  occupation?: string | null;
  notes?: string | null;
}

/** The same fields as bhi.member columns (Drizzle names), normalised. */
export interface MemberColumnValues {
  idType?: string;
  idNumber?: string;
  firstName?: string;
  lastName?: string;
  middleInitials?: string | null;
  dateOfBirth?: string | null;
  sex?: string | null;
  classCode?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  email?: string | null;
  phone?: string | null;
  employmentDate?: string | null;
  planDate?: string | null;
  rateOfPay?: string | null;
  occupation?: string | null;
  notes?: string | null;
}

export type MemberFieldsResult =
  | { ok: true; values: MemberColumnValues }
  | { ok: false; field: string; message: string };

/** Access sizes of the text fields (spec Key Entities, Member). */
export const MEMBER_FIELD_SIZES = {
  idType: 20,
  idNumber: 40,
  firstName: 80,
  lastName: 80,
  middleInitials: 20,
  sex: 10,
  classCode: 1,
  addressLine1: 150,
  addressLine2: 150,
  email: 100,
  phone: 50,
  occupation: 100,
} as const;

const LABELS: Record<string, string> = {
  idType: "ID type",
  idNumber: "ID number",
  firstName: "First name",
  lastName: "Last name",
  middleInitials: "Middle initials",
  sex: "Sex",
  classCode: "Class",
  addressLine1: "Address line 1",
  addressLine2: "Address line 2",
  email: "Email",
  phone: "Phone",
  occupation: "Occupation",
  dateOfBirth: "Date of birth",
  employmentDate: "Employment date",
  planDate: "Plan date",
  rateOfPay: "Rate of pay",
};

const blankToNull = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/**
 * Validates and normalises the fields present in `input`. Fields absent from
 * `input` stay absent from `values`, so the same function serves a create (all
 * required fields present) and a partial update.
 *
 * `required` lists the fields that must be present and non-blank: the create
 * form passes MEMBER_REQUIRED_ON_CREATE (the BHI required ones plus date of
 * birth); an update passes none.
 */
export function normaliseMemberFields(
  input: MemberFieldsInput,
  required: readonly (keyof MemberFieldsInput)[] = [],
): MemberFieldsResult {
  const values: MemberColumnValues = {};
  const fail = (field: string, message: string): MemberFieldsResult => ({ ok: false, field, message });

  for (const field of required) {
    const v = input[field];
    if (v == null || String(v).trim() === "") return fail(field, `${LABELS[field] ?? field} is required.`);
  }

  // Required-when-present text: may not be blanked on an update either.
  for (const field of ["idType", "idNumber", "firstName", "lastName", "classCode"] as const) {
    if (input[field] === undefined) continue;
    const v = String(input[field] ?? "").trim();
    if (v === "") return fail(field, `${LABELS[field]} cannot be blank.`);
    if (v.length > MEMBER_FIELD_SIZES[field]) {
      return fail(field, `${LABELS[field]} is ${v.length} characters; the most allowed is ${MEMBER_FIELD_SIZES[field]}.`);
    }
    values[field] = field === "classCode" || field === "idType" ? v.toUpperCase() : v;
  }

  // Optional text.
  for (const field of ["middleInitials", "addressLine1", "addressLine2", "occupation", "email"] as const) {
    if (input[field] === undefined) continue;
    const v = blankToNull(input[field]);
    if (v != null && v.length > MEMBER_FIELD_SIZES[field]) {
      return fail(field, `${LABELS[field]} is ${v.length} characters; the most allowed is ${MEMBER_FIELD_SIZES[field]}.`);
    }
    if (field === "email" && v != null && !v.includes("@")) return fail(field, "Email must contain @.");
    values[field] = v;
  }

  if (input.notes !== undefined) values.notes = blankToNull(input.notes);

  if (input.sex !== undefined) {
    const raw = blankToNull(input.sex);
    const v = raw == null ? null : normaliseSex(raw);
    if (v != null && v.length > MEMBER_FIELD_SIZES.sex) {
      return fail("sex", `Sex is ${v.length} characters; the most allowed is ${MEMBER_FIELD_SIZES.sex}.`);
    }
    values.sex = v;
  }

  // Guyana-only, stored E.164 — codes are delivered to +592 only. See lib/phone.ts.
  if (input.phone !== undefined) {
    const phone = normalizeMemberPhone(input.phone);
    if (!phone.ok) return fail("phone", phone.reason);
    if (phone.value != null && phone.value.length > MEMBER_FIELD_SIZES.phone) {
      return fail("phone", `Phone is too long; the most allowed is ${MEMBER_FIELD_SIZES.phone} characters.`);
    }
    values.phone = phone.value;
  }

  for (const field of ["dateOfBirth", "employmentDate", "planDate"] as const) {
    if (input[field] === undefined) continue;
    const raw = blankToNull(input[field]);
    // Cover ends at 65 (lib/retirement.ts), which needs the date of birth: once
    // recorded it may be corrected but not removed.
    if (raw == null && field === "dateOfBirth") return fail(field, "Date of birth cannot be cleared; correct it instead.");
    if (raw == null) {
      values[field] = null;
      continue;
    }
    const parsed = parseImportDate(raw);
    if (!parsed) return fail(field, `${LABELS[field]} "${raw}" is not a date we recognise.`);
    values[field] = parsed;
  }

  if (input.rateOfPay !== undefined) {
    const raw = blankToNull(input.rateOfPay);
    if (raw == null) values.rateOfPay = null;
    else {
      const cents = toCents(raw.replace(/,/g, ""));
      if (cents == null || cents < 0) return fail("rateOfPay", "Rate of pay must be an amount with at most two decimals.");
      values.rateOfPay = centsToMoney(cents);
    }
  }

  return { ok: true, values };
}

/**
 * Required of a new member: the BHI required fields, and the date of birth,
 * without which the member could never be retired at 65 and would be billed
 * indefinitely. Members created before this rule may lack one; the dashboard
 * and the members list flag them for HR.
 */
export const MEMBER_REQUIRED_ON_CREATE = ["idType", "idNumber", "firstName", "lastName", "classCode", "dateOfBirth"] as const;

/** Sizes of a dependant's text fields (spec Key Entities, Dependent). */
export const DEPENDENT_FIELD_SIZES = { fullName: 120, relationship: 30, idType: 20, idNumber: 40, sex: 10 } as const;
