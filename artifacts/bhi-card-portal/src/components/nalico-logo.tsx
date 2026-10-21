import { LOGO_SHAPES, LOGO_VIEWBOX, logoPathData } from '@workspace/card-design';

/** The NALICO logo, from the same artwork the card uses. Scales without distortion. */
export function NalicoLogo({ className = 'h-14' }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${LOGO_VIEWBOX.width} ${LOGO_VIEWBOX.height}`}
      preserveAspectRatio="xMidYMid meet"
      className={className}
      role="img"
      aria-label="NALICO"
    >
      {LOGO_SHAPES.map((shape, i) => (
        <path
          key={i}
          d={logoPathData(shape)}
          fill={shape.fill}
          fillRule={shape.evenOdd ? 'evenodd' : undefined}
        />
      ))}
    </svg>
  );
}
