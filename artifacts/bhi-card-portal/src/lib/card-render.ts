/**
 * Browser rendering of the NALICO card: the shared layout from
 * @workspace/card-design drawn as SVG. The same SVG is shown on screen and
 * rasterised for the PNG exports, so what a member downloads is exactly what
 * they see.
 */

import {
  CARD_FONT_FAMILY,
  CARD_HEIGHT,
  CARD_WIDTH,
  LOGO_SHAPES,
  LOGO_VIEWBOX,
  layoutCard,
  logoPathData,
  type CardElement,
  type CardLayoutData,
  type CardTextStyle,
  type MeasureText,
} from '@workspace/card-design';

export type { CardLayoutData };

let measureContext: CanvasRenderingContext2D | null = null;

const cssFont = (style: CardTextStyle) =>
  `${style.italic ? 'italic ' : ''}${style.weight} ${style.size}px ${CARD_FONT_FAMILY}`;

/** Measures with the browser's own font, the same one the SVG draws with. */
const measureText: MeasureText = (text, style) => {
  measureContext ??= document.createElement('canvas').getContext('2d');
  if (!measureContext) return text.length * style.size * 0.6;
  measureContext.font = cssFont(style);
  return measureContext.measureText(text).width;
};

const escapeXml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const n = (v: number) => String(Math.round(v * 100) / 100);

function drawElement(e: CardElement): string {
  switch (e.kind) {
    case 'rect':
      return `<rect x="${n(e.x)}" y="${n(e.y)}" width="${n(e.width)}" height="${n(e.height)}" rx="${n(e.radius)}" fill="${e.fill}"/>`;
    case 'line':
      return `<line x1="${n(e.x1)}" y1="${n(e.y1)}" x2="${n(e.x2)}" y2="${n(e.y2)}" stroke="${e.stroke}" stroke-width="${n(e.strokeWidth)}"/>`;
    case 'text':
      return (
        `<text x="${n(e.x)}" y="${n(e.y)}" fill="${e.colour}" font-size="${n(e.style.size)}" ` +
        `font-weight="${e.style.weight}"${e.style.italic ? ' font-style="italic"' : ''}>${escapeXml(e.text)}</text>`
      );
    case 'logo': {
      // Uniform scale from the logo's own viewBox: never stretched.
      const s = e.width / LOGO_VIEWBOX.width;
      const paths = LOGO_SHAPES.map(
        (shape) =>
          `<path d="${logoPathData(shape)}" fill="${shape.fill}"${shape.evenOdd ? ' fill-rule="evenodd"' : ''}/>`,
      ).join('');
      return `<g transform="translate(${n(e.x)} ${n(e.y)}) scale(${s})">${paths}</g>`;
    }
  }
}

/**
 * The card as an SVG document. Without a size it fills its container's width
 * (on screen); with one it has fixed pixel dimensions (for export).
 */
export function renderCardSvg(
  data: CardLayoutData,
  size?: { width: number; height: number },
): string {
  const layout = layoutCard(data, measureText);
  const dims = size
    ? `width="${size.width}" height="${size.height}"`
    : 'width="100%" style="display:block;height:auto"';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" ${dims} ` +
    `font-family="${escapeXml(CARD_FONT_FAMILY)}" text-rendering="geometricPrecision" ` +
    `role="img" aria-label="${escapeXml(`Health insurance card for ${data.employeeName}`)}">` +
    layout.elements.map(drawElement).join('') +
    `</svg>`
  );
}

/** Rasterises the card to a PNG of exactly `size` pixels. */
export async function exportCardPng(
  data: CardLayoutData,
  size: { width: number; height: number },
): Promise<Blob> {
  const svg = renderCardSvg(data, size);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The card image could not be rendered.'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is not available in this browser.');
    context.drawImage(image, 0, 0, size.width, size.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed.'))),
        'image/png',
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
