import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeCardEmailRedirect, resolveCardRecipient } from "./otpDelivery";

let saved: string | undefined;

beforeEach(() => {
  saved = process.env["CARD_EMAIL_OVERRIDE"];
  delete process.env["CARD_EMAIL_OVERRIDE"];
});

afterEach(() => {
  if (saved === undefined) delete process.env["CARD_EMAIL_OVERRIDE"];
  else process.env["CARD_EMAIL_OVERRIDE"] = saved;
});

describe("card email recipient", () => {
  // This is the property that matters. There used to be a hardcoded address
  // here, which meant a correctly configured production server still sent
  // every member's card to one private inbox. Redirecting is now opt-in.
  it("sends the card to the member when nothing is configured", () => {
    expect(activeCardEmailRedirect()).toBeNull();
    expect(resolveCardRecipient("member@bhi-demo.test")).toEqual({
      to: "member@bhi-demo.test",
      redirectedFrom: null,
    });
  });

  it("has no recipient when the member has no email on file", () => {
    // The route turns this into NO_EMAIL_ON_FILE rather than sending anywhere.
    expect(resolveCardRecipient(null)).toEqual({ to: null, redirectedFrom: null });
  });

  it.each(["off", "OFF", "false", "none", "no", "0"])(
    "treats CARD_EMAIL_OVERRIDE=%s as no redirect",
    (value) => {
      process.env["CARD_EMAIL_OVERRIDE"] = value;
      expect(activeCardEmailRedirect()).toBeNull();
      expect(resolveCardRecipient("member@example.com")).toEqual({
        to: "member@example.com",
        redirectedFrom: null,
      });
    },
  );

  it("can be pointed at a different address", () => {
    process.env["CARD_EMAIL_OVERRIDE"] = "qa@example.com";
    expect(resolveCardRecipient("member@example.com")).toEqual({
      to: "qa@example.com",
      redirectedFrom: "member@example.com",
    });
  });

  it("does not flag a redirect when it lands on the member's own address", () => {
    process.env["CARD_EMAIL_OVERRIDE"] = "member@example.com";
    expect(resolveCardRecipient("member@example.com")).toEqual({
      to: "member@example.com",
      redirectedFrom: null,
    });
  });

  it("ignores surrounding whitespace", () => {
    process.env["CARD_EMAIL_OVERRIDE"] = "  off  ";
    expect(activeCardEmailRedirect()).toBeNull();
  });

  it("treats an empty variable as no redirect", () => {
    process.env["CARD_EMAIL_OVERRIDE"] = "";
    expect(activeCardEmailRedirect()).toBeNull();
  });
});
