import { describe, expect, it } from 'vitest';
import { occurrenceAfter } from '../../../app/lib/transactions/recurrence';
import { generateProjectedTransactions } from '../../../app/lib/transactions/projectedTransactions';
import { scheduleLandsNear } from '../../../app/lib/transactions/recurringSchedule';
import type { Transaction } from '../../../app/types';

/**
 * A monthly charge on the 29th, 30th or 31st stays at the end of the month.
 *
 * Each occurrence used to be stepped from the one before it, and "one month
 * after Jan 31" is Feb 31, which JavaScript reads as Mar 3. So rent entered on
 * the 31st was missing from February altogether, and from March on it was
 * expected on the 3rd — four weeks from the real charge, far outside the few
 * days within which a real charge cancels the one that was expected. Every
 * month after that counted the rent twice.
 */

const rent = (over: Partial<Transaction> = {}): Transaction => ({
  id: 'rent',
  user_id: 'u1',
  vendor: 'Landlord',
  amount: 1500,
  date: '2026-01-31T12:00:00.000Z',
  budget_id: 'budget:housing',
  recurrence: 'Monthly',
  is_projected: false,
  label: 'Manual',
  created_at: '2026-01-31T12:00:00.000Z',
  ...over,
}) as Transaction;

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('a monthly charge anchored on the 31st', () => {
  it('lands on the last day of each shorter month and returns to the 31st', () => {
    const anchor = new Date(2026, 0, 31);
    expect([1, 2, 3, 4, 5].map((n) => iso(occurrenceAfter(anchor, 'monthly', n)))).toEqual([
      '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30',
    ]);
  });

  it('is expected in February, not skipped', () => {
    const projected = generateProjectedTransactions([rent()], '2026-02-10');
    expect(projected.map((tx) => tx.date)).toEqual([
      '2026-02-28', '2026-03-31', '2026-04-30',
    ]);
  });

  it('is counted once when the real March charge arrives on the 31st', () => {
    const marchCharge = rent({
      id: 'march', date: '2026-03-31T12:00:00.000Z', recurrence: 'One-time', label: 'Automatic',
    });
    const projected = generateProjectedTransactions([rent(), marchCharge], '2026-03-31');
    expect(projected.filter((tx) => tx.date.startsWith('2026-03'))).toEqual([]);
  });

  it('is recognised by the capture pipeline on Feb 28 and on Mar 31', () => {
    expect(scheduleLandsNear('2026-01-31', 'Monthly', '2026-02-28')).toBe(true);
    expect(scheduleLandsNear('2026-01-31', 'Monthly', '2026-03-31')).toBe(true);
    // And is not expected mid-month, where a second charge is a real one.
    expect(scheduleLandsNear('2026-01-31', 'Monthly', '2026-03-12')).toBe(false);
  });
});

describe('cadences that never touched the month end', () => {
  it('a mid-month charge keeps its day', () => {
    const anchor = new Date(2026, 0, 13);
    expect([1, 2, 12].map((n) => iso(occurrenceAfter(anchor, 'Monthly', n)))).toEqual([
      '2026-02-13', '2026-03-13', '2027-01-13',
    ]);
  });

  it('a fortnightly charge is fourteen days at a time', () => {
    const anchor = new Date(2026, 0, 31);
    expect([1, 2, 3].map((n) => iso(occurrenceAfter(anchor, 'biweekly', n)))).toEqual([
      '2026-02-14', '2026-02-28', '2026-03-14',
    ]);
  });
});
