import { BeneficiaryCreateRelationship, DependentRelationship, IdType } from '@workspace/api-client-react';

/**
 * The Access database's reference lists, as the member, dependant and
 * beneficiary forms offer them ("Reference values used by the dropdowns").
 * The stored values come from the API; only the labels live here.
 *
 * Records loaded before these lists (or by an import that met another word)
 * can hold other values. Those are shown as stored, and the pickers keep them
 * selectable, so opening an old record does not appear to change it.
 */
export interface Choice {
  value: string;
  label: string;
}

/** "SPOUSE" -> "Spouse", "E-ID" stays "E-ID". */
const titleCase = (value: string) =>
  value
    .toLowerCase()
    .split(/([\s_-]+)/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
    .replace(/_/g, ' ');

const ID_TYPE_LABELS: Record<string, string> = {
  [IdType.NATIONAL_ID]: 'National ID',
  [IdType.PASSPORT]: 'Passport',
  [IdType['E-ID']]: 'E-ID',
};

/** National ID, Passport, E-ID. */
export const ID_TYPE_OPTIONS: Choice[] = Object.values(IdType).map((value) => ({
  value,
  label: ID_TYPE_LABELS[value] ?? value,
}));

/** Male, Female — stored as M / F. */
export const SEX_OPTIONS: Choice[] = [
  { value: 'M', label: 'Male' },
  { value: 'F', label: 'Female' },
];

/** Spouse, Son, Daughter, Other. */
export const DEPENDANT_RELATIONSHIP_OPTIONS: Choice[] = Object.values(DependentRelationship).map((value) => ({
  value,
  label: titleCase(value),
}));

/**
 * Whether a dependant form asks for Sex. Son and Daughter already say it, and
 * Spouse does not need it, so only Other (or an older value outside the list,
 * which stays editable) shows the picker. Nothing is asked until a
 * relationship is chosen.
 */
export function dependantAsksSex(relationship: string): boolean {
  return relationship !== '' && !['SPOUSE', 'SON', 'DAUGHTER'].includes(relationship);
}

/**
 * The Sex a dependant form records when the admin picks a relationship: Male
 * for Son, Female for Daughter, none for Spouse, and blank for Other so the
 * admin chooses it.
 */
export function dependantSexFor(relationship: string): string {
  if (relationship === 'SON') return 'M';
  if (relationship === 'DAUGHTER') return 'F';
  return '';
}

/** Spouse, Child, Parent, Sibling, Estate, Other. */
export const BENEFICIARY_RELATIONSHIP_OPTIONS: Choice[] = Object.values(BeneficiaryCreateRelationship).map(
  (value) => ({ value, label: titleCase(value) }),
);

/** "NATIONAL ID" -> "National ID"; a value outside the list is shown as stored. */
export function idTypeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return ID_TYPE_LABELS[value] ?? value;
}

/** "SON" -> "Son", "CHILD" -> "Child" (an earlier value), for display. */
export function relationshipLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return titleCase(value);
}

/** True when the value is one the ID type picker offers. */
export const isListedIdType = (value: string) => value in ID_TYPE_LABELS;
