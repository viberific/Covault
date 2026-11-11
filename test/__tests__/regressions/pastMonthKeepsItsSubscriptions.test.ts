import { describe, expect, it } from 'vitest';
import { generateProjectedTransactions } from '../../../app/lib/transactions/projectedTransactions';
import { isInMonth } from '../../../app/lib/transactions/transactionOrdering';
import { remainingForMonth } from '../../../app/lib/time/monthWindow';
import type { Transaction } from '../../../app/types';

/**
 * A month that has ended keeps the subscriptions that fell in it.
 *
 * Recurring charges are never saved as rows; they are read from the schedule.
 * Only the current month's and future ones were read, so a subscription
 * counted all through September disappeared from September on the 1st of
 * October — and a browsed month's closing balance was too high by every
 * recurring charge that had fallen in it.
 */

const row = (over: Partial<Transaction>): Transaction => ({
  id: 'netflix',
  user_id: 'me',
  vendor: 'Netflix',
  amount: 20,
  date: '2026-07-05T12:00:00.000Z',
  budget_id: 'b-leisure',
  recurrence: 'Monthly',
  is_projected: false,
  label: 'Manual',
  created_at: '2026-07-05T12:00:00.000Z',
  ...over,
}) as Transaction;

const monthOf = (rows: Transaction[], today: string, monthKey: string) =>
  [...rows, ...generateProjectedTransactions(rows, today)].filter((tx) => isInMonth(tx, monthKey));

describe('browsing back from October', () => {
  it('finds September’s charge in September, as spent', () => {
    const september = monthOf([row({})], '2026-10-20', '2026-09');
    expect(september.map((tx) => [tx.date, tx.is_projected])).toEqual([['2026-09-05', false]]);
    expect(remainingForMonth(september, 1000)).toBe(980);
  });

  it('gives the same September it gave while September was the current month', () => {
    const during = monthOf([row({})], '2026-09-30', '2026-09');
    const after = monthOf([row({})], '2026-10-20', '2026-09');
    expect(after.map((tx) => tx.id)).toEqual(during.map((tx) => tx.id));
  });

  it('does not count a past charge twice when the bank’s copy was captured', () => {
    const captured = row({
      id: 'captured', vendor: 'NETFLIX.COM', date: '2026-09-06T12:00:00.000Z',
      recurrence: 'One-time', label: 'Automatic',
    });
    const september = monthOf([row({}), captured], '2026-10-20', '2026-09');
    expect(september.map((tx) => tx.id)).toEqual(['captured']);
  });

  it('expects nothing before the series began', () => {
    expect(monthOf([row({})], '2026-10-20', '2026-06')).toEqual([]);
  });

  it('leaves a series that was ended out of the months after it ended', () => {
    // Ending a series turns its earlier rows into one-time entries.
    const ended = row({ recurrence: 'One-time' });
    expect(monthOf([ended], '2026-10-20', '2026-09')).toEqual([]);
  });
});
