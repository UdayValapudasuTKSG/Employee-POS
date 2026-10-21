import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Choice } from '@/lib/member-vocab';

// The Select cannot hold an empty value, so "not recorded" has its own token.
const NONE = '__none__';

/**
 * A dropdown over one of the Access reference lists (lib/member-vocab.ts).
 *
 * - `noneLabel` adds a "Not recorded" style first option for optional fields;
 *   choosing it gives ''. Without it the field shows `placeholder` until a
 *   value is picked.
 * - A stored value that is not in the list (an earlier value, or one an import
 *   kept) is offered as an extra option, labelled as such, so opening an old
 *   record does not appear to change it. Picking a listed value replaces it.
 */
export function ChoiceSelect({
  id,
  value,
  onChange,
  options,
  noneLabel,
  placeholder = 'Select…',
  label = (v) => v,
  className,
  testId,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: Choice[];
  noneLabel?: string;
  placeholder?: string;
  /** How to show a stored value that is not in the list. */
  label?: (value: string) => string;
  className?: string;
  testId?: string;
}) {
  const unlisted = value !== '' && !options.some((o) => o.value === value);
  const selectValue = value === '' ? (noneLabel ? NONE : undefined) : value;
  return (
    <Select value={selectValue} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger id={id} className={className} data-testid={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {noneLabel && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
        {unlisted && <SelectItem value={value}>{label(value)} (earlier value)</SelectItem>}
      </SelectContent>
    </Select>
  );
}
