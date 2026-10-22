import { createContext, useContext } from 'react';

/**
 * Who "you" and "them" are, for the owner tag on each purchase.
 *
 * Rows carry only a user id: `transactions` has no name column, so the tag
 * used to read a name that was never there and came out as an empty pill on
 * every row, mine and theirs alike. The dashboard knows both people and
 * provides them here, rather than every list between it and the row passing
 * them down.
 */
export interface HouseholdPeople {
  myUserId: string;
  /** Said in words for the partner's purchases. Their first name when known. */
  partnerLabel: string;
  /** The letters on the two people's discs. */
  myInitial: string;
  partnerInitial: string;
}

export const HouseholdPeopleContext = createContext<HouseholdPeople | null>(null);

export const useHouseholdPeople = (): HouseholdPeople | null => useContext(HouseholdPeopleContext);

/** "Sam Rivera" → "Sam"; nothing known → "Partner". */
export function partnerLabelFrom(name: string | null | undefined): string {
  const first = (name || '').trim().split(/\s+/, 1)[0];
  return first || 'Partner';
}

/**
 * The first letter of a name, for the disc that stands for that person.
 *
 * Taken by code point rather than by index, so a name that opens with an emoji
 * or an accented capital is not cut in half. Empty when there is no name,
 * which the disc draws as a plain dot.
 */
export function initialOf(name: string | null | undefined): string {
  const first = Array.from((name || '').trim())[0];
  return first ? first.toLocaleUpperCase() : '';
}
