import { useMemo } from 'react';
import { renderCardSvg, type CardLayoutData } from '@/lib/card-render';

/**
 * The NALICO portrait card. Rendered from the same SVG the PNG exports use.
 * Every string in it is XML-escaped by renderCardSvg, so injecting it is safe.
 */
export function HealthCard({ data }: { data: CardLayoutData }) {
  const svg = useMemo(() => renderCardSvg(data), [data]);
  return (
    <div
      className="mx-auto w-full max-w-[380px] drop-shadow-xl"
      data-testid="health-card"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
