import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateProjectedTransactions } from '../../../app/lib/transactions/projectedTransactions';
import {
  collectRecurringCharges,
  findRecurringScheduleMatch,
  isRecurringRow,
  scheduleLandsNear,
} from '../../../app/lib/transactions/recurringSchedule';
import { recurringSeriesKey } from '../../../app/lib/transactions/recurringDelete';
import { normalizeRecurrence, occurrenceAfter } from '../../../app/lib/transactions/recurrence';
import { parseNotificationText } from '../../../app/lib/capture/deviceTransactionParser';
import { toSupabaseTransaction } from '../../../app/lib/api/transactionMappers';
import { Recurrence } from '../../../app/types';
import type { Transaction } from '../../../app/types';

/**
 * The yearly cadence, end to end.
 *
 * A yearly charge is the one cadence where the app's two halves can disagree
 * silently. `transactions.recur` is a Postgres ENUM, not free text: a label the
 * type has never heard of is not stored and quietly ignored, it is rejected —
 * and a SELECT that FILTERS on such a label fails the whole query rather than
 * matching nothing, which is how the recurring-charge lookup once spent months
 * returning a 400 and seeing no rows at all. So the tests below pin the app's
 * own list of cadences to the migration that teaches the database the same
 * word, alongside the behaviour.
 */

const MIGRATION = readFileSync(
  join(__dirname, '../../../supabase/migrations/2026_add_yearly_recurrence.sql'),
  'utf8',
);

const PROCESSOR = readFileSync(join(__dirname, '../../../app/lib/capture/notificationProcessor.ts'), 'utf8');

function makeTransaction(overrides: Partial<Transaction> & { recur?: string } = {}): Transaction {
  return {
    id: 'tx-1',
    user_id: 'user-1',
    vendor: 'Amazon Prime',
    amount: 139,
    date: '2026-03-11',
    budget_id: 'services-id',
    recurrence: 'Yearly',
    label: 'Manual',
    userName: 'me',
    is_projected: false,
    created_at: '2026-03-11T00:00:00.000Z',
    ...overrides,
  } as Transaction;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the database knows the word', () => {
  it('has a migration adding Yearly to the Recurrence enum', () => {
    expect(MIGRATION).toMatch(/ALTER TYPE public\."Recurrence"\s+ADD VALUE IF NOT EXISTS 'Yearly'/);
  });

  it('asks the recurring-charge lookup for every recurring label the app can write', () => {
    // Anything the app stores has to be asked for here, or a subscription is
    // captured and announced a second time. Anything asked for that the enum
    // lacks 400s the query and this check sees nothing at all.
    const asked = /\.in\('recur', \[([^\]]+)\]\)/.exec(PROCESSOR)?.[1] || '';
    const labels = asked.split(',').map((part) => part.trim().replace(/'/g, ''));
    const recurringLabels = Object.values(Recurrence).filter((r) => r !== Recurrence.ONE_TIME);
    expect([...labels].sort()).toEqual([...recurringLabels].sort());
  });

  it('accepts Yearly on the way into the database', () => {
    const row = toSupabaseTransaction(
      makeTransaction({ budget_id: 'services-id' }),
      [{ id: 'services-id', name: 'Services' }],
    );
    expect(row.recur).toBe('Yearly');
  });
});

describe('stepping a year', () => {
  it('reads the stored label in any casing', () => {
    expect(normalizeRecurrence(makeTransaction({ recurrence: 'Yearly' }))).toBe('yearly');
    expect(normalizeRecurrence(makeTransaction({ recurrence: undefined, recur: 'yearly' } as any)))
      .toBe('yearly');
  });

  it('moves twelve calendar months, keeping the day', () => {
    expect(occurrenceAfter(new Date(2026, 2, 11), 'Yearly', 1)).toEqual(new Date(2027, 2, 11));
  });

  it('holds a Feb 29 anchor to the end of February, and returns to the 29th', () => {
    // The same rule the monthly step applies to the 31st: the last day of a
    // month too short for the anchor, counted from the anchor each time.
    expect(occurrenceAfter(new Date(2028, 1, 29), 'yearly', 1)).toEqual(new Date(2029, 1, 28));
    expect(occurrenceAfter(new Date(2028, 1, 29), 'yearly', 4)).toEqual(new Date(2032, 1, 29));
  });
});

describe('projecting a yearly charge', () => {
  it('expects it in its own month and nowhere else', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-15T12:00:00Z'));

    const projected = generateProjectedTransactions([makeTransaction()]);

    // Inside the three-month horizon: the renewal a year on.
    expect(projected.map((tx) => tx.date)).toEqual(['2027-03-11']);
    expect(projected[0].is_projected).toBe(true);
  });

  it('says nothing in the eleven months between renewals', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00Z'));

    expect(generateProjectedTransactions([makeTransaction()])).toEqual([]);
  });

  it('counts the renewal in the month it is due, like any other occurrence', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-03-20T12:00:00Z'));

    const projected = generateProjectedTransactions([makeTransaction()]);
    const due = projected.find((tx) => tx.date === '2027-03-11');
    // On or before today, so it counts as money spent rather than expected.
    expect(due?.is_projected).toBe(false);
  });

  it('drops the guess once the real renewal is captured', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-03-20T12:00:00Z'));

    const projected = generateProjectedTransactions([
      makeTransaction(),
      // The bank's own wording, a day late and a cent off — still the same charge.
      makeTransaction({ id: 'captured', vendor: 'AMZN Prime', amount: 139.01, date: '2027-03-12' }),
    ]);

    expect(projected.map((tx) => tx.date)).toEqual([]);
  });

  it('keeps two annual charges of the same amount in different months apart', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-15T12:00:00Z'));

    const projected = generateProjectedTransactions([
      makeTransaction({ id: 'march', vendor: 'Blue Cross', amount: 420, date: '2026-03-11' }),
      makeTransaction({ id: 'september', vendor: 'Blue Cross', amount: 420, date: '2026-09-11' }),
    ]);

    // Only March's is inside the horizon, but September's must still exist as
    // its own series rather than having been collapsed into March's.
    expect(projected.map((tx) => tx.date)).toEqual(['2027-03-11']);

    vi.setSystemTime(new Date('2027-07-15T12:00:00Z'));
    const later = generateProjectedTransactions([
      makeTransaction({ id: 'march', vendor: 'Blue Cross', amount: 420, date: '2026-03-11' }),
      makeTransaction({ id: 'september', vendor: 'Blue Cross', amount: 420, date: '2026-09-11' }),
    ]);
    // March's renewal has happened by July: it is spent, in March. The one
    // still expected is September's.
    expect(later.map((tx) => [tx.date, tx.is_projected])).toEqual([
      ['2027-03-11', false],
      ['2027-09-11', true],
    ]);
  });
});

describe('recognising the annual charge when it lands', () => {
  it('counts a yearly row as part of the recurring machinery', () => {
    expect(isRecurringRow({ recur: 'Yearly' })).toBe(true);
    expect(isRecurringRow({ recur: 'yearly' })).toBe(true);
  });

  it('matches the occurrence a year after the template', () => {
    expect(scheduleLandsNear('2026-03-11', 'Yearly', '2027-03-12')).toBe(true);
    expect(scheduleLandsNear('2026-03-11', 'Yearly', '2029-03-10')).toBe(true);
  });

  it('leaves a purchase mid-year alone', () => {
    expect(scheduleLandsNear('2026-03-11', 'Yearly', '2026-09-11')).toBe(false);
    expect(scheduleLandsNear('2026-03-11', 'Yearly', '2027-04-11')).toBe(false);
  });

  it('does not capture the renewal a second time', () => {
    const match = findRecurringScheduleMatch(
      { vendors: ['AMZN Prime'], amount: 139, date: '2027-03-12' },
      [{
        id: 'prime-2026',
        vendor: 'Amazon Prime',
        amount: 139,
        date: '2026-03-11',
        recur: 'Yearly',
        source: 'manual',
      }],
    );
    expect(match?.id).toBe('prime-2026');
  });
});

describe('what the phone is told', () => {
  it('leaves yearly charges out of the native mirror', () => {
    // The native matcher compares vendor and amount and knows nothing about
    // dates. For an annual charge that would silence a matching purchase at
    // the same merchant on any of the other 364 days — and a silenced capture
    // writes no widget delta either.
    const charges = collectRecurringCharges([
      { vendor: 'Netflix', amount: 20.33, date: '2026-07-16', recur: 'Monthly' },
      { vendor: 'Amazon Prime', amount: 139, date: '2026-03-11', recur: 'Yearly' },
    ]);
    expect(charges).toEqual([{ vendor: 'Netflix', amount: 20.33 }]);
  });
});

describe('ending a yearly series', () => {
  it('groups the same annual charge across years', () => {
    expect(recurringSeriesKey(makeTransaction({ id: 'a', date: '2026-03-11' })))
      .toBe(recurringSeriesKey(makeTransaction({ id: 'b', date: '2028-03-11' })));
  });

  it('keeps two annual charges in different months apart', () => {
    const march = makeTransaction({ id: 'a', vendor: 'Blue Cross', amount: 420, date: '2026-03-11' });
    const september = makeTransaction({ id: 'b', vendor: 'Blue Cross', amount: 420, date: '2026-09-11' });
    expect(recurringSeriesKey(march)).not.toBe(recurringSeriesKey(september));
  });
});

describe('reading the cadence out of the bank', () => {
  it('reads an annual renewal as yearly', () => {
    const result = parseNotificationText('Payment to Amazon Prime annually for $139.00');
    expect(result.isOutgoing).toBe(true);
    expect(result.recurrence).toBe('Yearly');
    // The cadence word is read, not kept: it is not part of the merchant name.
    expect(result.vendorDisplay).toBe('Amazon Prime');
  });

  it('prefers the yearly wording when both cadences are quoted', () => {
    // Annual plans are routinely announced with their monthly equivalent.
    expect(parseNotificationText(
      'Payment to Spotify for $119.88 — billed annually, $9.99/mo',
    ).recurrence).toBe('Yearly');
  });

  it('refuses to call twice a year yearly', () => {
    expect(parseNotificationText(
      'Payment to Intact Insurance for $477.45 (semi-annual premium)',
    ).recurrence).not.toBe('Yearly');
  });

  it('still reads a monthly subscription as monthly', () => {
    expect(parseNotificationText('Payment to netflix monthly for $22.99').recurrence)
      .toBe('Monthly');
  });
});
