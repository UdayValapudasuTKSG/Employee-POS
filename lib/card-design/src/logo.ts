/**
 * The NALICO logo: a red roof over the heavy purple "NAlico" wordmark.
 *
 * Only the NALICO line of the NALICO/NAFICO group mark — the health card is a
 * NALICO product. A vector reconstruction of the official artwork, defined
 * once as plain polygons so the SVG renderer and the hand-built PDF draw the
 * identical shape — no font, no image decoding. Its colours are the logo's own
 * artwork colours, not card palette tokens: the logo is never recoloured.
 *
 * To use a traced original instead, replace LOGO_SHAPES and LOGO_VIEWBOX;
 * every renderer scales from the viewBox and preserves its aspect ratio.
 */

type Point = readonly [number, number];

export interface LogoShape {
  fill: string;
  /** Each entry is one closed subpath. */
  subpaths: readonly (readonly Point[])[];
  /** Even-odd fill, so an inner subpath punches a hole (the "A", "c", "o"). */
  evenOdd?: boolean;
}

export const LOGO_VIEWBOX = { width: 280, height: 104 } as const;
export const LOGO_ASPECT_RATIO = LOGO_VIEWBOX.width / LOGO_VIEWBOX.height;

const ROOF_RED = "#E3151F";
const WORDMARK_PURPLE = "#5B25CF";

const round = (n: number) => Math.round(n * 100) / 100;

/** Points on an ellipse from `from` to `to` degrees (0° = right, clockwise in y-down). */
function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps = 32): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    out.push([round(cx + rx * Math.cos(a)), round(cy + ry * Math.sin(a))]);
  }
  return out;
}

/** SVG path data for one shape, in viewBox units. */
export function logoPathData(shape: LogoShape): string {
  return shape.subpaths
    .map((sub) => `M${sub.map(([x, y]) => `${x} ${y}`).join(" L")} Z`)
    .join(" ");
}

// Wordmark geometry: every letter sits between TOP and BOTTOM, strokes are
// STROKE wide, and the whole word is nudged right by DX to centre under the roof.
const TOP = 60;
const BOTTOM = 104;
const MID = (TOP + BOTTOM) / 2;
const STROKE = 13;
const DX = 5;

const shift = (points: Point[]): Point[] => points.map(([x, y]) => [round(x + DX), y] as const);

// N: two stems joined by a diagonal from top-left to bottom-right.
const N: Point[] = shift([
  [17, BOTTOM], [17, TOP], [31, TOP], [47, 88], [47, TOP], [60, TOP],
  [60, BOTTOM], [46, BOTTOM], [30, 76], [30, BOTTOM],
]);

// A: flat-topped, with a triangular counter above the crossbar.
const A_OUTER: Point[] = shift([
  [68, BOTTOM], [83, TOP], [98, TOP], [113, BOTTOM], [100, BOTTOM],
  [97.5, 96], [83.5, 96], [81, BOTTOM],
]);
const A_COUNTER: Point[] = shift([[86, 87], [95, 87], [90.5, 72]]);

// l and i: plain stems, the i with a square dot.
const L: Point[] = shift([[121, TOP], [134, TOP], [134, BOTTOM], [121, BOTTOM]]);
const I_STEM: Point[] = shift([[142, 75], [155, 75], [155, BOTTOM], [142, BOTTOM]]);
const I_DOT: Point[] = shift([[142, TOP], [155, TOP], [155, 70], [142, 70]]);

// c: a thick elliptical band opening to the right.
const C_X = 183;
const C: Point[] = shift([
  ...arc(C_X, MID, 20, BOTTOM - MID, 38, 322),
  ...arc(C_X, MID, 20 - STROKE, BOTTOM - MID - STROKE, 322, 38),
]);

// o: an elliptical ring.
const O_X = 231;
const O_OUTER = shift(arc(O_X, MID, 22, BOTTOM - MID, 0, 360, 48));
const O_INNER = shift(arc(O_X, MID, 22 - STROKE, BOTTOM - MID - STROKE, 0, 360, 48));

export const LOGO_SHAPES: readonly LogoShape[] = [
  // Roof: a thick red chevron spanning the full width, above the wordmark.
  {
    fill: ROOF_RED,
    subpaths: [[[140, 0], [280, 48], [246, 48], [140, 13], [34, 48], [0, 48]]],
  },
  { fill: WORDMARK_PURPLE, subpaths: [N, L, I_STEM, I_DOT, C] },
  { fill: WORDMARK_PURPLE, evenOdd: true, subpaths: [A_OUTER, A_COUNTER] },
  { fill: WORDMARK_PURPLE, evenOdd: true, subpaths: [O_OUTER, O_INNER] },
];
