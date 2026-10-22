import { afterEach, describe, expect, it } from "vitest";
import { cardEmail, couponEmail, escapeHtml, guyanaClock, otpEmail, otpSms } from "./emailTemplates";

const saved = process.env["ISSUER_NAME"];
afterEach(() => {
  if (saved === undefined) delete process.env["ISSUER_NAME"];
  else process.env["ISSUER_NAME"] = saved;
});

describe("otpEmail", () => {
  it("puts the code in the subject, the text and the HTML, for sign-in", () => {
    process.env["ISSUER_NAME"] = "Acme Life";
    const m = otpEmail("482913", 5, { kind: "LOGIN" });
    expect(m.subject).toBe("482913 is your Acme Life verification code");
    expect(m.text).toContain("482913");
    expect(m.text).toContain("expires in 5 minutes");
    expect(m.html).toContain("482913");
    expect(m.html).toContain("Acme Life");
  });

  it("says what a coupon code is for", () => {
    const m = otpEmail("102030", 5, { kind: "COUPON", brandName: "Pizza Hut" });
    expect(m.subject).toBe("102030 is your code for a Pizza Hut coupon");
    expect(m.text).toContain("generate your Pizza Hut discount coupon");
    expect(m.html).toContain("Confirm your Pizza Hut coupon");
  });

  it("names no insurer when none is configured", () => {
    delete process.env["ISSUER_NAME"];
    expect(otpEmail("111111", 5, { kind: "LOGIN" }).subject).toBe("111111 is your verification code");
  });
});

describe("otpSms", () => {
  it("is short and carries the code", () => {
    delete process.env["ISSUER_NAME"];
    const sms = otpSms("555000", 5, { kind: "COUPON", brandName: "KFC" });
    expect(sms).toContain("555000");
    expect(sms).toContain("KFC");
    expect(sms.length).toBeLessThan(160);
  });
});

describe("couponEmail", () => {
  const input = {
    memberName: "Uday <script>",
    brandName: "KFC",
    code: "VBKT-0Q39-D85R",
    discountPercent: 10,
    expiresAt: new Date("2026-10-22T19:30:00Z"),
    qrCid: "coupon-qr",
  };

  it("shows the code, the QR image and the expiry in Guyana time", () => {
    const m = couponEmail(input);
    expect(m.subject).toBe("Your KFC coupon: 10% off");
    expect(m.html).toContain('src="cid:coupon-qr"');
    expect(m.html).toContain("VBKT-0Q39-D85R");
    expect(m.text).toContain("VBKT-0Q39-D85R");
    expect(m.text).toContain(guyanaClock(input.expiresAt));
  });

  it("escapes what came from the member's record", () => {
    const m = couponEmail(input);
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("Uday &lt;script&gt;");
  });

  it("says when the message was redirected", () => {
    expect(couponEmail({ ...input, redirectedFrom: "real@example.com" }).text).toContain("real@example.com");
  });
});

describe("cardEmail", () => {
  it("names the policy", () => {
    const m = cardEmail({ memberName: "R. Datla", policyNumber: "POL-2026-TEST03" });
    expect(m.text).toContain("POL-2026-TEST03");
    expect(m.html).toContain("POL-2026-TEST03");
  });
});

describe("guyanaClock", () => {
  it("is UTC-4 whatever the server zone", () => {
    expect(guyanaClock(new Date("2026-10-22T19:30:00Z"))).toMatch(/3:30\s?pm/i);
  });
});

describe("escapeHtml", () => {
  it("escapes the five significant characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});
