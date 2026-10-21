import { describe, expect, it } from "vitest";
import {
  CARD_COLOURS,
  CARD_HEIGHT,
  CARD_LOGO_WIDTH,
  CARD_PADDING_X,
  CARD_PADDING_Y,
  CARD_WIDTH,
  LOGO_ASPECT_RATIO,
  LOGO_SHAPES,
  LOGO_VIEWBOX,
  layoutCard,
  legalNotice,
} from "@workspace/card-design";
import { PAGE_HEIGHT, PAGE_WIDTH, renderCardPdf, textWidth, type CardPdfData } from "./cardPdf";

const SCALE = PAGE_WIDTH / CARD_WIDTH;

interface TextRun {
  colour: string;
  font: string;
  size: number;
  x: number;
  y: number;
  text: string;
}

const RUN_RE =
  /BT ([\d.]+ [\d.]+ [\d.]+) rg \/(F\d) ([\d.]+) Tf 1 0 0 1 ([\d.-]+) ([\d.-]+) Tm \((.*?)\) Tj ET/g;

const unescapePdf = (s: string) => s.replace(/\\([()\\])/g, "$1");

function contentStream(pdf: string): string {
  const m = /<< \/Length (\d+) >>\nstream\n/.exec(pdf)!;
  return pdf.substr(m.index + m[0].length, Number(m[1]));
}

/** Every text run the PDF draws, with the geometry needed to check bounds and collisions. */
function textRuns(pdf: string): TextRun[] {
  return [...contentStream(pdf).matchAll(RUN_RE)].map((r) => ({
    colour: r[1]!,
    font: r[2]!,
    size: Number(r[3]),
    x: Number(r[4]),
    y: Number(r[5]),
    text: unescapePdf(r[6]!),
  }));
}

/** A run's width in points, measured exactly as the layout measured it. */
function runWidth(run: TextRun): number {
  const bold = run.font === "F2" || run.font === "F4";
  return textWidth(run.text, { size: run.size / SCALE, weight: bold ? 700 : 400 }) * SCALE;
}

const rgb = (hex: string) =>
  [0, 2, 4]
    .map((i) => String(Math.round((parseInt(hex.slice(1 + i, 3 + i), 16) / 255) * 1000) / 1000))
    .join(" ");

// Stand-in issuer details. The renderer takes every issuer-specific string as
// data (see lib/issuer.ts), so the tests assert that what was passed in is what
// came out.
const sample: CardPdfData = {
  insurerName: "North American Life Insurance Co. Ltd.",
  insurerAddress: "30/31 Regent & Hincks Sts, Georgetown",
  insurerPhone: "Tel No: 592-226-5885 - 8",
  signatoryName: "L. Singh",
  signatoryTitle: "Life Manager",
  planTitle: "MEDICAL INSURANCE PLAN",
  policyholder: "Edward B. Beharry & Company Ltd",
  policyNumber: "POL-2026-10303",
  employeeName: "Rohini Singh",
  identificationId: "SYN-10008701",
  idType: "NATIONAL ID",
  classCode: "C",
  dateOfBirth: "1976-08-07",
  effectiveDate: "2026-07-01",
  dependents: [
    { fullName: "Anita Singh", relationship: "SPOUSE", dateOfBirth: "1990-09-09" },
    { fullName: "Devon Singh", relationship: "CHILD", dateOfBirth: "2021-05-14" },
  ],
};

const longNames: CardPdfData = {
  ...sample,
  policyholder:
    "The Guyana National Industrial and Commercial Investments Consolidated Holdings Corporation Limited",
  employeeName: "Maximiliana Alexandrina Wilhelmina Featherstonehaugh-Montgomery-Rutherford",
  dependents: [
    {
      fullName: "Christopherson-Bartholomew Featherstonehaugh-Montgomery-Rutherford",
      relationship: "CHILD",
      dateOfBirth: "2019-02-02",
    },
  ],
};

const asText = (data: CardPdfData = sample) => renderCardPdf(data).toString("latin1");

/** All drawn text joined, whitespace-collapsed — for checking wrapped text survives whole. */
const joined = (pdf: string) => textRuns(pdf).map((r) => r.text).join(" ").replace(/\s+/g, " ");

/** Asserts every run lies inside the card's padded content area. */
function expectInsideContent(pdf: string) {
  const minX = CARD_PADDING_X * SCALE - 0.01;
  const maxX = (CARD_WIDTH - CARD_PADDING_X) * SCALE + 0.01;
  const minY = CARD_PADDING_Y * SCALE;
  const maxY = PAGE_HEIGHT - CARD_PADDING_Y * SCALE;
  for (const run of textRuns(pdf)) {
    expect(run.x, run.text).toBeGreaterThanOrEqual(minX);
    expect(run.x + runWidth(run), run.text).toBeLessThanOrEqual(maxX);
    expect(run.y - run.size * 0.25, run.text).toBeGreaterThanOrEqual(minY);
    expect(run.y + run.size * 0.8, run.text).toBeLessThanOrEqual(maxY);
  }
}

/** Asserts no two runs' glyph boxes intersect. */
function expectNoCollisions(pdf: string) {
  const boxes = textRuns(pdf).map((r) => ({
    text: r.text,
    x1: r.x,
    x2: r.x + runWidth(r),
    y1: r.y - r.size * 0.22,
    y2: r.y + r.size * 0.72,
  }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const overlap = a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
      expect(overlap, `"${a.text}" overlaps "${b.text}"`).toBe(false);
    }
  }
}

describe("renderCardPdf", () => {
  it("produces a structurally complete PDF", () => {
    const pdf = asText();
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("trailer");
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).toContain("/Type /Catalog");
    expect(pdf).toContain("/Type /Pages");
  });

  it("is a single 65 × 130 mm page", () => {
    const pdf = asText();
    expect(pdf).toContain("/Count 1");
    expect([...pdf.matchAll(/\/Type \/Page[^s]/g)]).toHaveLength(1);
    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf)!;
    expect((Number(box[1]) * 25.4) / 72).toBeCloseTo(65, 2);
    expect((Number(box[2]) * 25.4) / 72).toBeCloseTo(130, 2);
  });

  it("uses the base-14 sans-serif, standing in for Segoe UI", () => {
    const pdf = asText();
    expect(pdf).toContain("/BaseFont /Helvetica ");
    expect(pdf).toContain("/BaseFont /Helvetica-Bold ");
    expect(pdf).not.toContain("Times");
  });

  // The cross-reference table is the easiest thing to get wrong by hand, and a
  // reader will reject the file outright if a single offset is off by a byte.
  it("records a byte offset for every object that actually points at it", () => {
    const pdf = asText();
    const xrefOffset = Number(/startxref\s+(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xrefOffset, xrefOffset + 4)).toBe("xref");
    const entries = [...pdf.slice(xrefOffset).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((offset, index) => {
      expect(pdf.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    });
    expect(Number(/\/Size (\d+)/.exec(pdf)![1])).toBe(entries.length + 1);
  });

  it("declares a stream length that matches the actual bytes", () => {
    const pdf = asText();
    const m = /<< \/Length (\d+) >>\nstream\n/.exec(pdf)!;
    const start = m.index + m[0].length;
    expect(pdf.slice(start + Number(m[1]), start + Number(m[1]) + 10)).toBe("\nendstream");
  });

  it("renders the member's details onto the card", () => {
    const text = joined(asText());
    for (const value of [
      "Rohini Singh",
      "POL-2026-10303",
      "SYN-10008701",
      "Edward B. Beharry & Company Ltd",
      "MEDICAL INSURANCE PLAN",
      "INSURED",
      "NATIONAL ID",
      "Policyholder",
      "Class",
      "Policy no.",
      "Date of Birth",
      "7 Aug 1976",
      "Effective",
      "Dependants",
      "Anita Singh",
      "Spouse · 9 Sep 1990",
    ]) {
      expect(text).toContain(value);
    }
  });

  it("follows the approved face: no insurer address, signature or phone", () => {
    const text = joined(asText());
    for (const gone of ["30/31 Regent & Hincks Sts, Georgetown", "L. Singh", "Life Manager", "Tel No: 592-226-5885 - 8"]) {
      expect(text).not.toContain(gone);
    }
  });

  it("labels the ID number with the member's ID type", () => {
    expect(joined(asText({ ...sample, idType: "PASSPORT" }))).toContain("PASSPORT");
  });

  it("leaves out the class and date-of-birth rows when they are unknown", () => {
    const text = joined(asText({ ...sample, classCode: null, dateOfBirth: null }));
    expect(text).not.toContain("Date of Birth");
    expect(text).not.toMatch(/Class/);
  });

  it("writes dates as day, short month and year", () => {
    expect(joined(asText())).toContain("1 Jul 2026");
  });

  it("prints the full legal notice, naming the policyholder twice", () => {
    const text = joined(asText());
    expect(text).toContain(legalNotice(sample.policyholder));
    expect(legalNotice(sample.policyholder).split(sample.policyholder)).toHaveLength(3);
  });

  it("prints the legal notice in the supporting text colour", () => {
    const pdf = asText();
    const noticeRuns = textRuns(pdf).filter((r) => r.text.includes("Presentation or use"));
    expect(noticeRuns.length).toBeGreaterThan(0);
    for (const run of noticeRuns) expect(run.colour).toBe(rgb(CARD_COLOURS.supportingText));
  });

  it("draws only palette colours, apart from the logo's own artwork", () => {
    const content = contentStream(asText());
    const allowed = new Set([
      ...Object.values(CARD_COLOURS).map(rgb),
      ...LOGO_SHAPES.map((s) => rgb(s.fill)),
    ]);
    for (const m of content.matchAll(/([\d.]+ [\d.]+ [\d.]+) (?:rg|RG)/g)) {
      expect(allowed, m[1]).toContain(m[1]);
    }
  });

  it.skip("draws no red of its own — superseded: the design has a red rule under the logo", () => {
    const content = contentStream(asText());
    const red = rgb(CARD_COLOURS.redAccent);
    expect(content).not.toContain(`${red} rg`);
    expect(content).not.toContain(`${red} RG`);
  });

  it("escapes characters that would terminate a PDF string", () => {
    const pdf = asText({ ...sample, policyholder: "Acme (Guyana) Ltd \\ Holdings" });
    expect(pdf).toContain("Acme \\(Guyana\\) Ltd \\\\ Holdings");
  });

  it("survives missing optional fields", () => {
    const pdf = asText({
      ...sample,
      insurerAddress: null,
      insurerPhone: null,
      signatoryName: null,
      signatoryTitle: null,
      planTitle: null,
      dependents: [],
    });
    const text = joined(pdf);
    expect(text).toContain("MEDICAL INSURANCE PLAN");
    expect(text).toContain("None listed");
    expect(text).not.toContain("L. Singh");
    expectInsideContent(pdf);
  });

  it("keeps every piece of text inside the padded card, with no collisions", () => {
    const pdf = asText();
    expectInsideContent(pdf);
    expectNoCollisions(pdf);
  });

  it("wraps long member and policyholder names without overflow or collision", () => {
    const pdf = asText(longNames);
    expectInsideContent(pdf);
    expectNoCollisions(pdf);
    const text = joined(pdf);
    expect(text).toContain(legalNotice(longNames.policyholder));
    expect(text).toContain("Featherstonehaugh-Montgomery-Rutherford");
  });

  it("never clips the legal notice, even for an absurdly long unbroken policyholder", () => {
    const policyholder = "X".repeat(90) + "Holdings" + "Y".repeat(90);
    const pdf = asText({ ...sample, policyholder });
    expectInsideContent(pdf);
    expectNoCollisions(pdf);
    // Unbroken words are split across lines, so compare with spaces removed.
    const compact = textRuns(pdf).map((r) => r.text).join("").replace(/\s+/g, "");
    expect(compact).toContain(legalNotice(policyholder).replace(/\s+/g, ""));
  });

  it("summarises dependants that do not fit instead of running off the card", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      fullName: `Child${i} Singh`,
      relationship: "CHILD",
      dateOfBirth: "2015-01-01",
    }));
    const pdf = asText({ ...sample, dependents: many });
    expectInsideContent(pdf);
    expectNoCollisions(pdf);
    expect(joined(pdf)).toMatch(/and \d+ more dependants/);
  });
});

describe("layoutCard", () => {
  const layout = layoutCard(sample, textWidth);

  it("uses the 540 × 1080 design canvas with 36 px corners", () => {
    expect(layout.width).toBe(540);
    expect(layout.height).toBe(1080);
    const bg = layout.elements[0]!;
    expect(bg).toMatchObject({ kind: "rect", x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT, radius: 36 });
  });

  it("places the logo top-left, keeping its aspect ratio", () => {
    const logo = layout.elements.find((e) => e.kind === "logo")!;
    expect(logo).toMatchObject({ x: CARD_PADDING_X, y: CARD_PADDING_Y, width: CARD_LOGO_WIDTH });
    if (logo.kind !== "logo") throw new Error("unreachable");
    expect(logo.width / logo.height).toBeCloseTo(LOGO_ASPECT_RATIO, 6);
  });

  it("draws one short red rule under the logo, and no other red", () => {
    const logo = layout.elements.find((e) => e.kind === "logo")!;
    if (logo.kind !== "logo") throw new Error("unreachable");
    const reds = layout.elements.filter(
      (e) => (e.kind === "rect" && e.fill === CARD_COLOURS.redAccent) ||
        (e.kind === "text" && e.colour === CARD_COLOURS.redAccent),
    );
    expect(reds).toHaveLength(1);
    const rule = reds[0]!;
    if (rule.kind !== "rect") throw new Error("unreachable");
    expect(rule.x).toBe(CARD_PADDING_X);
    expect(rule.y).toBeGreaterThan(logo.y + logo.height);
    expect(rule.width).toBeLessThan(80);
  });

  it("puts the plan title on the right, level with the logo", () => {
    const title = layout.elements.find((e) => e.kind === "text" && e.text === "MEDICAL INSURANCE PLAN")!;
    if (title.kind !== "text") throw new Error("unreachable");
    expect(title.x + textWidth(title.text, title.style)).toBeCloseTo(CARD_WIDTH - CARD_PADDING_X, 1);
    expect(title.y).toBeLessThan(CARD_PADDING_Y + 40);
  });

  it("keeps only the NALICO wordmark — no NAFICO line", () => {
    const bottoms = LOGO_SHAPES.flatMap((s) => s.subpaths.flat().map(([, y]) => y));
    expect(Math.max(...bottoms)).toBeLessThanOrEqual(LOGO_VIEWBOX.height);
    expect(LOGO_ASPECT_RATIO).toBeGreaterThan(2);
  });
});
