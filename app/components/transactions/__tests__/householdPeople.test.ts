import { describe, expect, it } from 'vitest';
import { initialOf, partnerLabelFrom } from '../householdPeople';

describe('the letter on a person’s disc', () => {
  it('is the first letter, capitalised', () => {
    expect(initialOf('Sam Rivera')).toBe('S');
    expect(initialOf('  alex')).toBe('A');
    expect(initialOf('émile')).toBe('É');
  });

  it('keeps a whole character when the name opens with an emoji', () => {
    expect(initialOf('🌻 Sunny')).toBe('🌻');
  });

  it('is empty when nobody is named', () => {
    expect(initialOf('')).toBe('');
    expect(initialOf(undefined)).toBe('');
    expect(initialOf(' '.repeat(3))).toBe('');
  });

  it('follows the partner label, which says Partner when no name is known', () => {
    expect(initialOf(partnerLabelFrom('Sam Rivera'))).toBe('S');
    expect(initialOf(partnerLabelFrom(null))).toBe('P');
  });
});
