import { describe, expect, it } from "vitest";
import { discountCodeEmail, escapeHtml, otpEmail } from "./email";
import { guyanaClock } from "./rules";

describe("otpEmail", () => {
  it("carries the code in subject, text and HTML", () => {
    const m = otpEmail("482913", 5, "LOGIN");
    expect(m.subject).toBe("482913 is your Beharry Staff Discounts sign-in code");
    for (const part of [m.text, m.html]) expect(part).toContain("482913");
  });

  it("says what a confirmation code is for", () => {
    const m = otpEmail("102030", 5, "CODE");
    expect(m.subject).toBe("102030 confirms your new discount code");
    expect(m.html).toContain("Confirm your new discount code");
  });
});

describe("discountCodeEmail", () => {
  const input = {
    firstName: "Uday <b>",
    code: "VBKT-0Q39-D85R",
    stores: [
      { store: "KFC" as const, name: "KFC", percent: 10 },
      { store: "PIZZA_HUT" as const, name: "Pizza Hut", percent: 10 },
      { store: "STERLING" as const, name: "Sterling", percent: 15 },
      { store: "BEHARRY" as const, name: "Edward B. Beharry & Co.", percent: 5 },
    ],
    expiresAt: new Date("2026-10-22T19:30:00Z"),
    qrCid: "code-qr",
  };

  it("shows the code, the QR, every store and the expiry in Guyana time", () => {
    const m = discountCodeEmail(input);
    expect(m.html).toContain('src="cid:code-qr"');
    expect(m.html).toContain("VBKT-0Q39-D85R");
    for (const store of ["KFC", "Pizza Hut", "Sterling", "Edward B. Beharry &amp; Co."]) expect(m.html).toContain(store);
    expect(m.text).toContain(guyanaClock(input.expiresAt));
  });

  it("gives each store its own percentage, and the headline the best of them", () => {
    const m = discountCodeEmail(input);
    expect(m.subject).toBe("Your staff discount code: up to 15% off");
    expect(m.html).toContain("15% off");
    expect(m.text).toContain("Sterling (15%)");
    const same = discountCodeEmail({ ...input, stores: input.stores.map((s) => ({ ...s, percent: 10 })) });
    expect(same.subject).toBe("Your staff discount code: 10% off");
  });

  it("escapes the employee's name", () => {
    expect(discountCodeEmail(input).html).toContain("Uday &lt;b&gt;");
  });
});

describe("escapeHtml", () => {
  it("escapes the five significant characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});
