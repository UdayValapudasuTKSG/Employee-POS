/**
 * PDF rendering of the member insurance card: one 65 × 130 mm page holding the
 * NALICO portrait card.
 *
 * The layout itself is not decided here. @workspace/card-design lays the card
 * out once on its 540 × 1080 canvas and this module only draws the result,
 * scaled to the page — the same layout the portal draws on screen and exports
 * as PNG, so the renderings cannot drift apart.
 *
 * Every issuer-specific string arrives in `CardPdfData` rather than being
 * written here. See lib/issuer.ts. Anything absent is simply not drawn.
 *
 * Deliberately dependency-free. A PDF library would drag font binaries into the
 * esbuild bundle, and this document needs only base-14 fonts that every reader
 * ships with. Segoe UI cannot be embedded (its licence does not allow
 * redistribution), so the PDF uses Helvetica — the base-14 sans-serif, and the
 * spec's system sans-serif fallback. Its glyph widths are tabulated below and
 * handed to the layout, so text wraps to what is actually drawn.
 */

import {
  CARD_HEIGHT,
  CARD_WIDTH,
  LOGO_SHAPES,
  LOGO_VIEWBOX,
  PDF_EXPORT_MM,
  layoutCard,
  type CardElement,
  type CardLayoutData,
  type CardTextStyle,
} from "@workspace/card-design";

export type CardPdfData = CardLayoutData;

const PT_PER_MM = 72 / 25.4;
/** 65 × 130 mm in PDF points. */
export const PAGE_WIDTH = PDF_EXPORT_MM.width * PT_PER_MM;
export const PAGE_HEIGHT = PDF_EXPORT_MM.height * PT_PER_MM;
/** Canvas px → points. The canvas and the page share the 1:2 ratio. */
const SCALE = PAGE_WIDTH / CARD_WIDTH;

const FONT_REGULAR = "F1";
const FONT_BOLD = "F2";
const FONT_ITALIC = "F3";
const FONT_BOLD_ITALIC = "F4";
const BASE_FONTS: [string, string][] = [
  [FONT_REGULAR, "Helvetica"],
  [FONT_BOLD, "Helvetica-Bold"],
  [FONT_ITALIC, "Helvetica-Oblique"],
  [FONT_BOLD_ITALIC, "Helvetica-BoldOblique"],
];

// ---------------------------------------------------------------------------
// Glyph metrics (AFM widths per 1000 units, ASCII 32-126). The oblique faces
// share their upright face's widths.
// ---------------------------------------------------------------------------

const parseWidths = (csv: string): number[] => csv.split(",").map(Number);

const HELVETICA = parseWidths(
  "278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278," +
    "556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556," +
    "1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778," +
    "667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556," +
    "333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556," +
    "556,556,333,500,278,556,500,722,500,500,500,334,260,334,584",
);

const HELVETICA_BOLD = parseWidths(
  "278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278," +
    "556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611," +
    "975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778," +
    "667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556," +
    "333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611," +
    "611,611,389,556,333,611,556,778,556,556,500,389,280,389,584",
);

/** Wider than any Latin-1 glyph, so an unmapped character can only wrap early, never overhang. */
const FALLBACK_WIDTH = 1000;

const isBold = (style: CardTextStyle) => style.weight >= 600;

function fontFor(style: CardTextStyle): string {
  if (isBold(style)) return style.italic ? FONT_BOLD_ITALIC : FONT_BOLD;
  return style.italic ? FONT_ITALIC : FONT_REGULAR;
}

/**
 * Width of `text` in canvas px when drawn in `style` — the measure the layout
 * wraps with. Exported so the layout tests can rebuild each run's bounding box.
 */
export function textWidth(text: string, style: CardTextStyle): number {
  const table = isBold(style) ? HELVETICA_BOLD : HELVETICA;
  let total = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.charCodeAt(0);
    total += code >= 32 && code <= 126 ? table[code - 32]! : FALLBACK_WIDTH;
  }
  return (total * style.size) / 1000;
}

/** Escapes the three characters that terminate or nest a PDF literal string. */
function pdfString(text: string): string {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    // Base-14 fonts are single-byte; drop anything outside Latin-1 rather than
    // emit bytes a reader would render as mojibake.
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Fixed-precision number without exponent notation. */
const num = (v: number): string => String(Math.round(v * 1000) / 1000);

/** "#RRGGBB" → "r g b" in 0-1. */
function rgb(hex: string): string {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => num(parseInt(h.slice(i, i + 2), 16) / 255)).join(" ");
}

/** Canvas point (y-down px) → page point (y-up pt). */
const px = (x: number) => x * SCALE;
const py = (y: number) => (CARD_HEIGHT - y) * SCALE;

/** Bezier constant for a quarter circle. */
const KAPPA = 0.5523;

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const k = r * KAPPA;
  const P = (cx: number, cy: number) => `${num(px(cx))} ${num(py(cy))}`;
  return [
    `${P(x + r, y)} m`,
    `${P(x + w - r, y)} l`,
    `${P(x + w - r + k, y)} ${P(x + w, y + r - k)} ${P(x + w, y + r)} c`,
    `${P(x + w, y + h - r)} l`,
    `${P(x + w, y + h - r + k)} ${P(x + w - r + k, y + h)} ${P(x + w - r, y + h)} c`,
    `${P(x + r, y + h)} l`,
    `${P(x + r - k, y + h)} ${P(x, y + h - r + k)} ${P(x, y + h - r)} c`,
    `${P(x, y + r)} l`,
    `${P(x, y + r - k)} ${P(x + r - k, y)} ${P(x + r, y)} c`,
    "h",
  ].join(" ");
}

function drawElement(e: CardElement): string {
  switch (e.kind) {
    case "rect":
      return `${rgb(e.fill)} rg ${roundedRectPath(e.x, e.y, e.width, e.height, e.radius)} f`;
    case "line":
      return (
        `${rgb(e.stroke)} RG ${num(e.strokeWidth * SCALE)} w ` +
        `${num(px(e.x1))} ${num(py(e.y1))} m ${num(px(e.x2))} ${num(py(e.y2))} l S`
      );
    case "text":
      return (
        `BT ${rgb(e.colour)} rg /${fontFor(e.style)} ${num(e.style.size * SCALE)} Tf ` +
        `1 0 0 1 ${num(px(e.x))} ${num(py(e.y))} Tm (${pdfString(e.text)}) Tj ET`
      );
    case "logo": {
      // Scaled uniformly from the logo's own viewBox, so it keeps its aspect.
      const s = e.width / LOGO_VIEWBOX.width;
      return LOGO_SHAPES.map((shape) => {
        const path = shape.subpaths
          .map((sub) =>
            sub
              .map(([lx, ly], i) => `${num(px(e.x + lx * s))} ${num(py(e.y + ly * s))} ${i === 0 ? "m" : "l"}`)
              .join(" ") + " h",
          )
          .join(" ");
        return `${rgb(shape.fill)} rg ${path} ${shape.evenOdd ? "f*" : "f"}`;
      }).join("\n");
    }
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Assembles the PDF. Objects are written in order and their byte offsets
 * recorded for the cross-reference table, which is what makes the file valid.
 */
export function renderCardPdf(data: CardPdfData): Buffer {
  const layout = layoutCard(data, textWidth);
  const content = layout.elements.map(drawElement).join("\n");

  const objects: string[] = [];
  const add = (body: string) => objects.push(body);

  // 1 catalog, 2 pages tree, 3 page, 4 content stream, 5-8 fonts.
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Count 1 /Kids [3 0 R] >>");
  const fontRefs = BASE_FONTS.map(([name], i) => `/${name} ${5 + i} 0 R`).join(" ");
  add(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PAGE_WIDTH)} ${num(PAGE_HEIGHT)}] ` +
      `/Resources << /Font << ${fontRefs} >> >> /Contents 4 0 R >>`,
  );
  add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
  for (const [, baseFont] of BASE_FONTS) {
    add(`<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} /Encoding /WinAnsiEncoding >>`);
  }

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}
