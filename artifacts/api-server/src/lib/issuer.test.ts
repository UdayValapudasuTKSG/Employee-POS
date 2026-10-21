import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issuerDetails } from "./issuer";

const KEYS = [
  "ISSUER_NAME",
  "ISSUER_ADDRESS",
  "ISSUER_PHONE",
  "ISSUER_SIGNATORY_NAME",
  "ISSUER_SIGNATORY_TITLE",
  "ISSUER_PLAN_TITLE",
  "CARD_PROPERTY_NOTICE",
  "CARD_BACK_NOTICE",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("issuerDetails", () => {
  it("names no insurer when nothing is configured", () => {
    // The whole point of moving these out of the source: an unconfigured
    // deployment must not print the previous deployment's insurer.
    const issuer = issuerDetails();
    expect(issuer.name).toBeNull();
    expect(issuer.address).toBeNull();
    expect(issuer.phone).toBeNull();
    expect(issuer.signatoryName).toBeNull();
    expect(issuer.signatoryTitle).toBeNull();
    expect(issuer.propertyNotice).toBeNull();
  });

  it("still supplies generic wording that names nobody", () => {
    const issuer = issuerDetails();
    expect(issuer.planTitle).toBe("MEDICAL INSURANCE PLAN");
    expect(issuer.backNotice).toContain("identification only");
    // A default is only acceptable because it names no organisation.
    expect(issuer.backNotice).not.toMatch(/NALICO|North American/i);
  });

  it("reads every field from the environment", () => {
    process.env["ISSUER_NAME"] = "Second Assurance PLC";
    process.env["ISSUER_ADDRESS"] = "1 Example Road";
    process.env["ISSUER_PHONE"] = "Tel: 555-0100";
    process.env["ISSUER_SIGNATORY_NAME"] = "A. Other";
    process.env["ISSUER_SIGNATORY_TITLE"] = "Chief Underwriter";
    process.env["ISSUER_PLAN_TITLE"] = "Health Cover";
    process.env["CARD_BACK_NOTICE"] = "Custom notice.";

    expect(issuerDetails()).toMatchObject({
      name: "Second Assurance PLC",
      address: "1 Example Road",
      phone: "Tel: 555-0100",
      signatoryName: "A. Other",
      signatoryTitle: "Chief Underwriter",
      planTitle: "Health Cover",
      backNotice: "Custom notice.",
    });
  });

  it("treats a blank variable as unset", () => {
    process.env["ISSUER_ADDRESS"] = "   ";
    expect(issuerDetails().address).toBeNull();
  });

  it("composes the property notice from the name and address", () => {
    process.env["ISSUER_NAME"] = "Second Assurance PLC";
    process.env["ISSUER_ADDRESS"] = "1 Example Road, Springfield";
    expect(issuerDetails().propertyNotice).toBe(
      "This card is the property of Second Assurance PLC. If found please return to Second Assurance PLC, 1 Example Road, Springfield.",
    );
  });

  it("does not double the full stop after a name ending in Ltd.", () => {
    process.env["ISSUER_NAME"] = "North American Life Insurance Co. Ltd.";
    process.env["ISSUER_ADDRESS"] = "30/31 Regent & Hincks Sts";
    const notice = issuerDetails().propertyNotice!;
    expect(notice).not.toContain("Ltd.. If found");
    expect(notice).toContain("Ltd. If found please return to");
    // The name is left intact where a comma follows it.
    expect(notice).toContain("Co. Ltd., 30/31 Regent & Hincks Sts");
  });

  it("composes nothing when there is no name to compose from", () => {
    process.env["ISSUER_ADDRESS"] = "1 Example Road";
    expect(issuerDetails().propertyNotice).toBeNull();
  });

  it("prefers an explicit property notice over the composed one", () => {
    // The real card uses a short form of the name, which no composition rule
    // could derive from the registered one.
    process.env["ISSUER_NAME"] = "North American Life Insurance Co. Ltd.";
    process.env["ISSUER_ADDRESS"] = "30/31 Regent & Hincks Sts, Georgetown";
    process.env["CARD_PROPERTY_NOTICE"] = "This Card is the Property of NALICO.";
    expect(issuerDetails().propertyNotice).toBe("This Card is the Property of NALICO.");
  });

  it("is re-read per call, so a restart is enough to correct a value", () => {
    process.env["ISSUER_NAME"] = "First";
    expect(issuerDetails().name).toBe("First");
    process.env["ISSUER_NAME"] = "Second";
    expect(issuerDetails().name).toBe("Second");
  });
});
