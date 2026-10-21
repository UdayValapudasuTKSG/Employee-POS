/**
 * Lays the card out once, as positioned elements on the 540 × 1080 canvas.
 *
 * Renderers only draw what this returns: the portal turns it into SVG (on
 * screen and for the PNG exports), the API server into a PDF. Text is measured
 * through a function the renderer supplies, because each draws with its own
 * font — the browser with Segoe UI, the PDF with a base-14 sans — and wrapping
 * and right-aligning with the real widths is what guarantees nothing overflows
 * in either.
 *
 * The face follows the approved card design (2026-09-30), top to bottom:
 *
 *   logo ............................ MEDICAL INSURANCE PLAN
 *   ▬ (short red rule)
 *   INSURED
 *   Member Name                       (large; shrinks to fit one line)
 *   NATIONAL ID                       (the member's ID type)
 *   125316726                         (large, light)
 *   ─────────────────────────────────────────────
 *   Policyholder ............ value   (label left, value right,
 *   Class ................... value    a rule between rows)
 *   Policy no. .............. value
 *   Date of Birth ........... value
 *   Effective ............... value
 *   ─────────────────────────────────────────────
 *   Dependants
 *   Name ........ Relationship · 26 Jul 1986   (one line each)
 *   ─────────────────────────────────────────────
 *   legal notice (steps down in size until it fits)
 *
 * Coordinates are y-down, in canvas px. A text element's `y` is its baseline.
 */

import { LOGO_ASPECT_RATIO } from "./logo";
import { legalNotice } from "./legalNotice";
import {
  CARD_COLOURS,
  CARD_CORNER_RADIUS,
  CARD_HEIGHT,
  CARD_LOGO_GAP,
  CARD_LOGO_WIDTH,
  CARD_PADDING_X,
  CARD_PADDING_Y,
  CARD_WIDTH,
} from "./tokens";

export type CardFontWeight = 400 | 600 | 700;

export interface CardTextStyle {
  size: number;
  weight: CardFontWeight;
  italic?: boolean;
}

/** Width of `text` in canvas px when drawn in `style`. */
export type MeasureText = (text: string, style: CardTextStyle) => number;

export type CardElement =
  | { kind: "rect"; x: number; y: number; width: number; height: number; radius: number; fill: string }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; stroke: string; strokeWidth: number }
  | { kind: "text"; x: number; y: number; text: string; style: CardTextStyle; colour: string }
  | { kind: "logo"; x: number; y: number; width: number; height: number };

export interface CardLayout {
  width: number;
  height: number;
  elements: CardElement[];
}

export interface CardLayoutData {
  insurerName: string;
  /** Accepted for compatibility; the current card face does not print them. */
  insurerAddress?: string | null;
  insurerPhone?: string | null;
  signatoryName?: string | null;
  signatoryTitle?: string | null;
  planTitle?: string | null;
  policyholder: string;
  policyNumber: string;
  employeeName: string;
  identificationId: string;
  /** The member's ID type ("NATIONAL ID", "PASSPORT", "E-ID"); labels the ID number. */
  idType?: string | null;
  /** The member's class, e.g. "A". The row is left out when absent. */
  classCode?: string | null;
  /** The member's date of birth, ISO YYYY-MM-DD. The row is left out when absent. */
  dateOfBirth?: string | null;
  /** ISO date, YYYY-MM-DD. */
  effectiveDate: string;
  dependents: {
    /**
     * DependentFullName. The BHI model keeps one name field; a migrated
     * dependant's is its old first and last name joined with a space, so the
     * card line reads exactly as before.
     */
    fullName: string;
    relationship: string;
    dateOfBirth?: string | null;
  }[];
}

const DEFAULT_PLAN_TITLE = "MEDICAL INSURANCE PLAN";

interface Typeset extends CardTextStyle {
  lineHeight: number;
}

const PLAN_TITLE: Typeset = { size: 12.5, weight: 600, lineHeight: 16 };
const SMALL_LABEL: Typeset = { size: 12, weight: 600, lineHeight: 16 };
/** The insured's name starts here and steps down until it fits one line. */
const NAME_MAX = 38;
const NAME_MIN = 26;
/** A name that still does not fit wraps; its words may shrink this far to stay whole. */
const NAME_WRAP_MIN = 20;
const ID_VALUE: Typeset = { size: 34, weight: 400, lineHeight: 42 };
const ROW_LABEL: Typeset = { size: 16.5, weight: 400, lineHeight: 22 };
const ROW_VALUE: Typeset = { size: 16.5, weight: 700, lineHeight: 22 };
const ROW_VALUE_MIN = 13;
const SECTION_HEADING: Typeset = { size: 18, weight: 700, lineHeight: 24 };
const DEPENDANT_NAME: Typeset = { size: 15.5, weight: 400, lineHeight: 21 };
const DEPENDANT_DETAIL: Typeset = { size: 13.5, weight: 400, lineHeight: 19 };

/** The notice starts at this size and steps down until it fits its space. */
const NOTICE_MAX_SIZE = 10;
const NOTICE_MIN_SIZE = 6;
const NOTICE_LINE_HEIGHT = 1.45;

const RED_RULE = { width: 48, height: 3 };
const ROW_HEIGHT = 44;
const DEPENDANT_ROW_HEIGHT = 31;
/** Space kept between a row's label and its right-aligned value. */
const ROW_GUTTER = 18;
/** Wrap slightly inside the measured width so rounding can never overhang. */
const WRAP_SLACK = 1;

// ---------------------------------------------------------------------------
// Text fitting
// ---------------------------------------------------------------------------

/** Trims `text` until it fits with a trailing "...". */
export function ellipsise(text: string, maxWidth: number, style: CardTextStyle, measure: MeasureText): string {
  if (measure(text, style) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && measure(`${out.trimEnd()}...`, style) > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}...`;
}

/** Splits a single word too wide for the line into pieces that each fit. */
function breakWord(word: string, maxWidth: number, style: CardTextStyle, measure: MeasureText): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const ch of word) {
    if (current && measure(current + ch, style) > maxWidth) {
      pieces.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Greedy word wrap with real widths. A word wider than the line is broken
 * mid-word rather than allowed to overhang. Past `maxLines`, the last line is
 * ellipsised.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  style: CardTextStyle,
  measure: MeasureText,
  maxLines = Infinity,
): string[] {
  const width = maxWidth - WRAP_SLACK;
  const lines: string[] = [];
  let current = "";
  for (const word of String(text ?? "").split(/\s+/).filter(Boolean)) {
    if (measure(word, style) > width) {
      const pieces = breakWord(word, width, style, measure);
      if (current) {
        const joined = `${current} ${pieces[0]}`;
        if (measure(joined, style) <= width) pieces[0] = joined;
        else lines.push(current);
      }
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? "";
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (current && measure(candidate, style) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines - 1);
    kept.push(ellipsise(lines.slice(maxLines - 1).join(" "), width, style, measure));
    return kept;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07-01" → "1 Jul 2026". Read from the string, so no timezone can shift it. */
export function formatCardDate(value: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  if (!m) return value ? String(value) : "-";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ""} ${m[1]}`;
}

function titleCase(value: string): string {
  const v = String(value ?? "").trim();
  return v ? v.charAt(0).toUpperCase() + v.slice(1).toLowerCase() : "";
}

/** The label above the ID number: the member's ID type, as the card prints it. */
export function idTypeLabel(idType: string | null | undefined): string {
  const v = String(idType ?? "").trim().toUpperCase().replace(/_/g, " ");
  return v || "NATIONAL ID/PP NO";
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function layoutCard(data: CardLayoutData, measure: MeasureText): CardLayout {
  const elements: CardElement[] = [];
  const left = CARD_PADDING_X;
  const right = CARD_WIDTH - CARD_PADDING_X;
  const contentWidth = right - left;
  const bottomLimit = CARD_HEIGHT - CARD_PADDING_Y;

  /** The baseline for text in a line box starting at `top`. */
  const baseline = (top: number, type: Typeset) => top + type.lineHeight / 2 + type.size * 0.35;

  /** Draws one line left-aligned at `x` in the box from `top`. */
  const textAt = (text: string, x: number, top: number, type: Typeset, colour: string) =>
    elements.push({
      kind: "text",
      x,
      y: baseline(top, type),
      text,
      style: { size: type.size, weight: type.weight, italic: type.italic },
      colour,
    });

  /** Draws one line ending at `rightX`. */
  const textRight = (text: string, rightX: number, top: number, type: Typeset, colour: string) =>
    textAt(text, rightX - measure(text, type), top, type, colour);

  /** Draws pre-wrapped lines from `top`; returns the height used. */
  const drawLines = (lines: string[], x: number, top: number, type: Typeset, colour: string): number => {
    lines.forEach((text, i) => textAt(text, x, top + i * type.lineHeight, type, colour));
    return lines.length * type.lineHeight;
  };

  const divider = (y: number) =>
    elements.push({ kind: "line", x1: left, y1: y, x2: right, y2: y, stroke: CARD_COLOURS.divider, strokeWidth: 1 });

  elements.push({
    kind: "rect",
    x: 0,
    y: 0,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    radius: CARD_CORNER_RADIUS,
    fill: CARD_COLOURS.background,
  });

  // --- Header: logo, plan title to its right, red rule beneath -------------
  const logoHeight = CARD_LOGO_WIDTH / LOGO_ASPECT_RATIO;
  elements.push({ kind: "logo", x: left, y: CARD_PADDING_Y, width: CARD_LOGO_WIDTH, height: logoHeight });

  const planTitle = (data.planTitle || DEFAULT_PLAN_TITLE).toUpperCase();
  const titleSpace = contentWidth - CARD_LOGO_WIDTH - 16;
  textRight(
    ellipsise(planTitle, titleSpace, PLAN_TITLE, measure),
    right,
    CARD_PADDING_Y + 4,
    PLAN_TITLE,
    CARD_COLOURS.secondaryText,
  );

  let y = CARD_PADDING_Y + logoHeight + CARD_LOGO_GAP;
  elements.push({ kind: "rect", x: left, y, width: RED_RULE.width, height: RED_RULE.height, radius: 0, fill: CARD_COLOURS.redAccent });
  y += RED_RULE.height + 40;

  // --- Insured: label and name -------------------------------------------
  textAt("INSURED", left, y, SMALL_LABEL, CARD_COLOURS.secondaryText);
  y += SMALL_LABEL.lineHeight + 4;

  const name = data.employeeName?.trim() || "-";
  let nameType: Typeset = { size: NAME_MAX, weight: 700, lineHeight: NAME_MAX * 1.2 };
  const fits = (t: Typeset) => measure(name, t) <= contentWidth - WRAP_SLACK;
  // Its longest word must fit a line, so a double-barrelled surname is never split.
  const wordsFit = (t: Typeset) => name.split(/\s+/).every((w) => measure(w, t) <= contentWidth - WRAP_SLACK);
  for (let size = NAME_MAX; size >= NAME_WRAP_MIN; size -= 1) {
    nameType = { size, weight: 700, lineHeight: size * 1.2 };
    if (fits(nameType) || (size <= NAME_MIN && wordsFit(nameType))) break;
  }
  // Past NAME_MIN a long name wraps (up to three lines) rather than being cut.
  y += drawLines(wrapText(name, contentWidth, nameType, measure, 3), left, y, nameType, CARD_COLOURS.primaryText);

  // --- ID type and number ------------------------------------------------
  y += 22;
  textAt(idTypeLabel(data.idType), left, y, SMALL_LABEL, CARD_COLOURS.secondaryText);
  y += SMALL_LABEL.lineHeight + 4;
  y += drawLines(
    [ellipsise(data.identificationId?.trim() || "-", contentWidth, ID_VALUE, measure)],
    left, y, ID_VALUE, CARD_COLOURS.primaryText,
  );

  // --- Detail rows: label left, value right ------------------------------
  y += 20;
  divider(y);
  const rows: [string, string | null | undefined][] = [
    ["Policyholder", data.policyholder],
    ["Class", data.classCode],
    ["Policy no.", data.policyNumber],
    ["Date of Birth", data.dateOfBirth ? formatCardDate(data.dateOfBirth) : null],
    ["Effective", formatCardDate(data.effectiveDate)],
  ];
  for (const [label, raw] of rows) {
    const value = raw?.trim();
    if (!value) continue;
    const labelWidth = measure(label, ROW_LABEL);
    const valueSpace = contentWidth - labelWidth - ROW_GUTTER;
    // The value shrinks a little before it is shortened, so a long
    // policyholder usually still reads in full.
    let valueType: Typeset = ROW_VALUE;
    for (let size = ROW_VALUE.size; size >= ROW_VALUE_MIN; size -= 0.5) {
      valueType = { ...ROW_VALUE, size };
      if (measure(value, valueType) <= valueSpace) break;
    }
    const top = y + (ROW_HEIGHT - ROW_LABEL.lineHeight) / 2;
    textAt(label, left, top, ROW_LABEL, CARD_COLOURS.secondaryText);
    textRight(ellipsise(value, valueSpace, valueType, measure), right, top, valueType, CARD_COLOURS.primaryText);
    y += ROW_HEIGHT;
    divider(y);
  }
  const rowsBottom = y;

  // --- Footer: the legal notice, measured first so it can claim its space ---
  const notice = legalNotice(data.policyholder);
  // Room for the dependants heading and at least one row.
  const middleReserve = 22 + SECTION_HEADING.lineHeight + 8 + DEPENDANT_ROW_HEIGHT + 22;
  const noticeSpace = bottomLimit - rowsBottom - middleReserve - 20;
  let noticeType: Typeset = { size: NOTICE_MAX_SIZE, weight: 400, lineHeight: NOTICE_MAX_SIZE * NOTICE_LINE_HEIGHT };
  let noticeLines = wrapText(notice, contentWidth, noticeType, measure);
  for (let size = NOTICE_MAX_SIZE; size >= NOTICE_MIN_SIZE; size -= 0.5) {
    noticeType = { size, weight: 400, lineHeight: size * NOTICE_LINE_HEIGHT };
    noticeLines = wrapText(notice, contentWidth, noticeType, measure);
    if (noticeLines.length * noticeType.lineHeight <= noticeSpace) break;
  }
  const noticeHeight = noticeLines.length * noticeType.lineHeight;
  const noticeTop = bottomLimit - noticeHeight;
  drawLines(noticeLines, left, noticeTop, noticeType, CARD_COLOURS.supportingText);
  const footerRule = noticeTop - 16;
  divider(footerRule);

  // --- Dependants, in whatever space remains -----------------------------
  let m = rowsBottom + 22;
  const middleBottom = footerRule - 16;
  textAt("Dependants", left, m, SECTION_HEADING, CARD_COLOURS.primaryText);
  m += SECTION_HEADING.lineHeight + 8;

  const dependents = data.dependents ?? [];
  if (dependents.length === 0) {
    textAt("None listed", left, m + (DEPENDANT_ROW_HEIGHT - DEPENDANT_DETAIL.lineHeight) / 2, DEPENDANT_DETAIL, CARD_COLOURS.supportingText);
  } else {
    const fit = Math.max(0, Math.floor((middleBottom - m) / DEPENDANT_ROW_HEIGHT));
    const overflow = dependents.length > fit;
    // The "and N more" summary takes one row of its own.
    const shown = overflow ? dependents.slice(0, Math.max(0, fit - 1)) : dependents;
    for (const dep of shown) {
      const detail = [titleCase(dep.relationship), dep.dateOfBirth ? formatCardDate(dep.dateOfBirth) : ""]
        .filter(Boolean)
        .join(" · ");
      const detailWidth = measure(detail, DEPENDANT_DETAIL);
      const nameSpace = contentWidth - detailWidth - ROW_GUTTER;
      const top = m + (DEPENDANT_ROW_HEIGHT - DEPENDANT_NAME.lineHeight) / 2;
      textAt(ellipsise((dep.fullName ?? "").trim() || "-", nameSpace, DEPENDANT_NAME, measure), left, top, DEPENDANT_NAME, CARD_COLOURS.primaryText);
      textRight(detail, right, m + (DEPENDANT_ROW_HEIGHT - DEPENDANT_DETAIL.lineHeight) / 2, DEPENDANT_DETAIL, CARD_COLOURS.supportingText);
      m += DEPENDANT_ROW_HEIGHT;
    }
    if (overflow) {
      const more = dependents.length - shown.length;
      textAt(
        `and ${more} more dependant${more === 1 ? "" : "s"}`,
        left, m + (DEPENDANT_ROW_HEIGHT - DEPENDANT_DETAIL.lineHeight) / 2, DEPENDANT_DETAIL, CARD_COLOURS.supportingText,
      );
    }
  }

  return { width: CARD_WIDTH, height: CARD_HEIGHT, elements };
}
