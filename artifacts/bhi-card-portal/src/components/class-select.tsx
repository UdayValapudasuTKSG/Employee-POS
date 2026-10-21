import { useListClasses, getListClassesQueryKey } from '@workspace/api-client-react';
import { ChoiceSelect } from '@/components/choice-select';

/**
 * The member class picker: every class a member can be given today — active,
 * with all four tier rates in place (the server refuses anything else). A class
 * added under Classes appears here without a code change. A member's current
 * class that has since been retired stays shown as its earlier value.
 */
export function ClassSelect({
  id,
  value,
  onChange,
  className,
  testId,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  testId?: string;
}) {
  const { data, isLoading } = useListClasses(undefined, { query: { queryKey: getListClassesQueryKey() } });
  const options = (data?.classes ?? [])
    .filter((c) => c.active && c.rateComplete)
    .map((c) => ({ value: c.classCode, label: c.className && c.className !== c.classCode ? `${c.classCode} — ${c.className}` : c.classCode }));
  return (
    <ChoiceSelect
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={isLoading ? 'Loading classes…' : options.length ? 'Select a class' : 'No class has all its rates yet'}
      className={className}
      testId={testId}
    />
  );
}
