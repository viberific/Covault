import { describe, expect, it, vi, afterEach } from 'vitest';
import { generateProjectedTransactions } from '../projectedTransactions';
import type { Transaction } from '../../../types';

function makeTransaction(overrides: Partial<Transaction> & { recur?: string } = {}): Transaction {
  return {
    id: 'tx-1',
    user_id: 'user-1',
    vendor: 'Landlord',
    amount: 1800,
    date: '2026-02-01',
    budget_id: 'housing-id',
    recurrence: 'Monthly',
    label: 'Manual',
    userName: 'me',
    is_projected: false,
    created_at: '2026-02-01T00:00:00.000Z',
    ...overrides,
  } as Transaction;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('generateProjectedTransactions', () => {
  it('includes current-month recurring occurrences and solidifies ones on/before today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T12:00:00Z'));

    const projected = generateProjectedTransactions([
      makeTransaction({ date: '2026-02-20', recurrence: 'Monthly' }),
      makeTransaction({ id: 'tx-2', date: '2026-02-01', recurrence: 'Biweekly' }),
    ]);

    expect(projected.map((tx) => tx.date)).toContain('2026-03-20');
    expect(projected.map((tx) => tx.date)).toContain('2026-03-15');
    expect(projected.map((tx) => tx.date)).toContain('2026-04-20');

    expect(projected.find((tx) => tx.date === '2026-03-20')?.is_projected).toBe(false);
    expect(projected.find((tx) => tx.date === '2026-03-15')?.is_projected).toBe(false);
    expect(projected.find((tx) => tx.date === '2026-04-20')?.is_projected).toBe(true);
  });

  it('projects a rolling three-month monthly horizon and supports legacy recur field on projected DB rows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T12:00:00Z'));

    const projected = generateProjectedTransactions([
      makeTransaction({
        id: 'db-row',
        date: '2026-02-28',
        recurrence: undefined,
        recur: 'Monthly',
        is_projected: true,
      } as any),
    ]);

    expect(projected.map((tx) => tx.date)).toEqual([
      '2026-03-28',
      '2026-04-28',
      '2026-05-28',
    ]);
  });

  it('does not duplicate an occurrence when a real transaction already exists for that month', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T12:00:00Z'));

    const base = [
      makeTransaction({ id: 'seed-tx', date: '2026-02-01', recurrence: 'Monthly' }),
      makeTransaction({ id: 'real-march', date: '2026-03-01', recurrence: 'One-time' }),
    ];

    const projected = generateProjectedTransactions(base);

    expect(projected.map((tx) => tx.date)).not.toContain('2026-03-01');
  });

  it('preserves the day-of-month when projecting monthly recurrences (timezone regression)', () => {
    // Regression: `new Date("YYYY-MM-DD")` parses as UTC midnight, which in
    // negative-offset timezones (e.g. America/Chicago) lands on the previous
    // local day. After the first addMonths the local day-of-month is wrong,
    // so "monthly on the 15th" used to project as "monthly on the 14th" for
    // any user west of UTC. The fix builds the initial date in local time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T12:00:00Z'));

    const projected = generateProjectedTransactions([
      makeTransaction({ date: '2026-01-15', recurrence: 'Monthly' }),
    ]);

    for (const tx of projected) {
      expect(tx.date.slice(8, 10)).toBe('15');
    }
  });

  it('only projects from the earliest template per (vendor, amount) — does not double-project executor-spawned instances', () => {
    // Regression: the recurring executor spawns a real transaction for each
    // due date. The projection function used to loop through all real
    // transactions, so a Jul 13 Fizz + executor-spawned Aug 13 Fizz would
    // BOTH generate Sep 13, Oct 13, etc. — double-projecting every month.
    // The fix: pick the earliest per (vendor, amount) as the only source.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00Z'));

    const base = [
      // Original template
      makeTransaction({ id: 'fizz-jul', vendor: 'Fizz', amount: 26.20, date: '2026-07-13', recurrence: 'Monthly' }),
      // Executor-spawned real transaction (would have generated dupes)
      makeTransaction({ id: 'fizz-aug', vendor: 'Fizz', amount: 26.20, date: '2026-08-13', recurrence: 'Monthly', source: 'executor' as any }),
    ];

    const projected = generateProjectedTransactions(base);

    // Filter to Fizz projections to make the assertion readable
    const fizz = projected.filter((tx) => tx.vendor === 'Fizz');
    const dates = fizz.map((tx) => tx.date).sort();
    // Expect exactly one Sep, one Oct, one Nov (within the 3-month horizon).
    // The executor-spawned Aug 13 must NOT have generated its own projections.
    expect(dates).toEqual(['2026-09-13', '2026-10-13', '2026-11-13']);
  });

  it('handles two separate Fizz templates (different dates) without collapsing them', () => {
    // The user has two Fizz charges per month: $26.20 on the 13th AND the
    // 16th. These are different keys (different day-of-month) so the
    // earliest-per-group logic should keep BOTH and project from each.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00Z'));

    const base = [
      makeTransaction({ id: 'fizz-13', vendor: 'Fizz', amount: 26.20, date: '2026-07-13', recurrence: 'Monthly' }),
      makeTransaction({ id: 'fizz-16', vendor: 'Fizz', amount: 26.20, date: '2026-07-16', recurrence: 'Monthly' }),
    ];

    const projected = generateProjectedTransactions(base);
    const fizzDates = projected.filter((tx) => tx.vendor === 'Fizz').map((tx) => tx.date).sort();
    // Each template contributes its own series: 13th and 16th
    expect(fizzDates).toContain('2026-09-13');
    expect(fizzDates).toContain('2026-09-16');
    expect(fizzDates).toContain('2026-10-13');
    expect(fizzDates).toContain('2026-10-16');
    // No duplicates within a single date
    expect(new Set(fizzDates).size).toBe(fizzDates.length);
  });

  it('keeps Monthly and Biweekly templates separate even with same vendor+amount', () => {
    // A Monthly $50 Netflix and a separate Biweekly $50 Netflix (monthly
    // subscription + biweekly purchases) must stay separate — not collapse
    // into one series. The grouping key includes recurrence to handle this.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00Z'));

    const base = [
      makeTransaction({ id: 'netflix-monthly', vendor: 'Netflix', amount: 27.11, date: '2026-02-17', recurrence: 'Monthly' }),
      makeTransaction({ id: 'netflix-biweekly', vendor: 'Netflix', amount: 27.11, date: '2026-02-01', recurrence: 'Biweekly' }),
    ];

    const projected = generateProjectedTransactions(base);
    const netflix = projected.filter((tx) => tx.vendor === 'Netflix').map((tx) => tx.date).sort();
    // Monthly from Feb 17 contributes within the 3-month horizon:
    //   Aug 17, Sep 17, Oct 17, Nov 17
    expect(netflix).toContain('2026-08-17');
    expect(netflix).toContain('2026-09-17');
    expect(netflix).toContain('2026-10-17');
    // Biweekly from Feb 1 contributes:
    //   Aug 16, Aug 30, Sep 13, Sep 27, Oct 11, Oct 25, Nov 8
    expect(netflix).toContain('2026-08-16');
    expect(netflix).toContain('2026-09-13');
    expect(netflix).toContain('2026-10-11');
  });

  it('takes today from the caller so a set generated before midnight is not reused after it', () => {
    // The dashboard memoises this on (transactions, today). Held on the
    // transactions alone, a set generated on Jul 31 keeps answering with
    // July's idea of "the current month" and "already happened" — which is how
    // a Jul 31 occurrence ends up sitting in an August vial.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T23:59:00Z'));

    const base = [makeTransaction({ date: '2026-06-30', recurrence: 'Monthly' })];

    const asOfAug3 = generateProjectedTransactions(base, '2026-08-03');

    // July's occurrence has happened as of Aug 3, even though the system
    // clock still says July: it is spent money, and it stays dated in July
    // rather than moving into the month now being read.
    const july = asOfAug3.find((tx) => tx.date === '2026-07-30');
    expect(july?.is_projected).toBe(false);
    expect(asOfAug3.filter((tx) => tx.date.startsWith('2026-08')).map((tx) => tx.date))
      .toEqual(['2026-08-30']);
    expect(asOfAug3.map((tx) => tx.date)).toContain('2026-08-30');
    // Aug 30 is after Aug 3, so it is still a projection rather than solidified.
    expect(asOfAug3.find((tx) => tx.date === '2026-08-30')?.is_projected).toBe(true);
  });

  it('falls back to the clock when no day is passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00Z'));

    const withClock = generateProjectedTransactions([
      makeTransaction({ date: '2026-06-30', recurrence: 'Monthly' }),
    ]);
    const withExplicitDay = generateProjectedTransactions(
      [makeTransaction({ date: '2026-06-30', recurrence: 'Monthly' })],
      '2026-08-03',
    );

    expect(withClock.map((tx) => tx.date)).toEqual(withExplicitDay.map((tx) => tx.date));
  });
});
