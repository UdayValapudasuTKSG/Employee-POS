import { describe, expect, it } from "vitest";
import { MEMBER_REQUIRED_ON_CREATE, normaliseMemberFields } from "./memberCreate";

const complete = {
  idType: "national_id",
  idNumber: " 123456 ",
  firstName: " Ravi ",
  lastName: "Persaud",
  classCode: "a",
  dateOfBirth: "1988-04-12",
};

describe("normaliseMemberFields", () => {
  it("accepts a complete create and normalises it", () => {
    const r = normaliseMemberFields(complete, MEMBER_REQUIRED_ON_CREATE);
    expect(r).toEqual({
      ok: true,
      values: { idType: "NATIONAL_ID", idNumber: "123456", firstName: "Ravi", lastName: "Persaud", classCode: "A", dateOfBirth: "1988-04-12" },
    });
  });

  it("requires a date of birth on a create, and never lets an update clear one", () => {
    expect(MEMBER_REQUIRED_ON_CREATE).toContain("dateOfBirth");
    const { dateOfBirth: _dob, ...noDob } = complete;
    expect(normaliseMemberFields(noDob, MEMBER_REQUIRED_ON_CREATE)).toMatchObject({ ok: false, field: "dateOfBirth" });
    expect(normaliseMemberFields({ dateOfBirth: "" })).toMatchObject({ ok: false, field: "dateOfBirth" });
    expect(normaliseMemberFields({ dateOfBirth: "12-Apr-1988" })).toEqual({ ok: true, values: { dateOfBirth: "1988-04-12" } });
  });

  it("names the first missing required field on a create", () => {
    for (const field of MEMBER_REQUIRED_ON_CREATE) {
      const r = normaliseMemberFields({ ...complete, [field]: "  " }, MEMBER_REQUIRED_ON_CREATE);
      expect(r.ok, field).toBe(false);
      if (!r.ok) expect(r.field).toBe(field);
    }
  });

  it("refuses a value longer than its Access size, naming both lengths", () => {
    const r = normaliseMemberFields({ firstName: "x".repeat(81) });
    expect(r).toMatchObject({ ok: false, field: "firstName" });
    if (!r.ok) expect(r.message).toMatch(/81.*80/);
    expect(normaliseMemberFields({ classCode: "AB" })).toMatchObject({ ok: false, field: "classCode" });
    expect(normaliseMemberFields({ addressLine1: "y".repeat(151) })).toMatchObject({ ok: false, field: "addressLine1" });
  });

  it("does not let an update blank a required field", () => {
    expect(normaliseMemberFields({ idNumber: "" })).toMatchObject({ ok: false, field: "idNumber" });
  });

  it("leaves absent fields absent, so an update changes only what was sent", () => {
    expect(normaliseMemberFields({ occupation: "Driver" })).toEqual({ ok: true, values: { occupation: "Driver" } });
  });

  it("parses dates and rate of pay, and blanks optional fields to null", () => {
    const r = normaliseMemberFields({ dateOfBirth: "1990-04-05", rateOfPay: "1,234.5", middleInitials: " " });
    expect(r).toEqual({ ok: true, values: { dateOfBirth: "1990-04-05", rateOfPay: "1234.50", middleInitials: null } });
    expect(normaliseMemberFields({ dateOfBirth: "not a date" })).toMatchObject({ ok: false, field: "dateOfBirth" });
    expect(normaliseMemberFields({ rateOfPay: "12.345" })).toMatchObject({ ok: false, field: "rateOfPay" });
  });

  it("normalises a Guyana phone number and refuses one that cannot receive a code", () => {
    const r = normaliseMemberFields({ phone: "6454058" });
    expect(r.ok && r.values.phone).toBe("+5926454058");
    expect(normaliseMemberFields({ phone: "+1 212 555 0100" })).toMatchObject({ ok: false, field: "phone" });
  });

  it("requires an @ in an email", () => {
    expect(normaliseMemberFields({ email: "nobody" })).toMatchObject({ ok: false, field: "email" });
  });
});
