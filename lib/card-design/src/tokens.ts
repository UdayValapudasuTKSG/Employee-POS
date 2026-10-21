/**
 * The NALICO health card specification — the single source of every size,
 * colour and font the card uses. The portal's on-screen card, its PNG exports
 * and the server's PDF all read from here, so no renderer carries its own copy.
 */

/** The design canvas, in px. Every layout coordinate is in these units. */
export const CARD_WIDTH = 540;
export const CARD_HEIGHT = 1080;

/** Left/right internal padding. */
export const CARD_PADDING_X = 44;
/** Top/bottom internal padding. The spec fixes only left/right; this matches. */
export const CARD_PADDING_Y = 44;

export const CARD_CORNER_RADIUS = 36;

/** Output sizes. PNGs keep the 1:2 canvas ratio, at 2× and 3×. */
export const PNG_EXPORT = { width: 1080, height: 2160 } as const;
export const PNG_EXPORT_HIGH_RES = { width: 1620, height: 3240 } as const;
export const PDF_EXPORT_MM = { width: 65, height: 130 } as const;

export const CARD_COLOURS = {
  background: "#F7F7F6",
  primaryText: "#050505",
  secondaryText: "#4B5563",
  bodyText: "#374151",
  supportingText: "#6B7280",
  divider: "#E5E7EB",
  /** The short rule under the logo (card design of 2026-09-30). */
  redAccent: "#E8112D",
} as const;

/**
 * Segoe UI, then the platform's own sans-serif. Quoted for use in CSS, SVG
 * and canvas font strings alike.
 */
export const CARD_FONT_FAMILY =
  "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";

/** The logo sits top-left at this width; its height follows its aspect ratio. */
export const CARD_LOGO_WIDTH = 124;

/** Space between the logo and the red rule beneath it. */
export const CARD_LOGO_GAP = 20;
