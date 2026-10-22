import { describe, it, expect } from 'vitest';
import {
  householdIncome,
  householdBudgets,
  spendingAgainstMyBudgets,
  householdSpend,
  readPartnerSummary,
  emptySummary,
  defaultHouseholdView,
  transactionsForView,
  budgetsForView,
  incomeForView,
} from '../householdSharing';
import type { Transaction, BudgetCategory } from '../../../types';

/**
 * Linking used to answer two questions with one word, and got both wrong for
 * most couples.
 *
 * Whose budgets: each phone showed its OWN limits measured against the
 * HOUSEHOLD's spending, so the same grocery total ran against a different line
 * on each screen — one person saw a full vial while the other saw it
 * overflowing. And whose income: each phone used only its own, so two people
 * looking at one pot disagreed about it by exactly the other's salary.
 */

const ME = 'me';
const THEM = 'them';

const tx = (user_id: string, amount: number, budget = 'Groceries'): Transaction =>
  ({ id: `${user_id}-${amount}`, user_id, vendor: 'X', amount, date: '2026-09-04', budget } as unknown as Transaction);

const budget = (name: string, totalLimit: number): BudgetCategory =>
  ({ id: name, name, totalLimit } as BudgetCategory);

describe('the income the balance is measured against', () => {
  it('adds both when there is a partner', () => {
    // The fix for two phones disagreeing about one pot.
    expect(householdIncome(5000, 4000)).toBe(9000);
  });

  it('is the same figure on both phones', () => {
    expect(householdIncome(5000, 4000)).toBe(householdIncome(4000, 5000));
  });

  it('falls back to your own when the partner figure cannot be read', () => {
    // An older database, or a call that failed. Understating the money is the
    // safe direction: it makes the user cautious rather than confident.
    expect(householdIncome(5000, null)).toBe(5000);
    expect(householdIncome(5000, undefined)).toBe(5000);
    expect(householdIncome(5000, 0)).toBe(5000);
    expect(householdIncome(5000, Number.NaN)).toBe(5000);
  });
});

describe('whose budgets the vials show', () => {
  const mine = [budget('Groceries', 600), budget('Transport', 300)];
  const theirs = [budget('Groceries', 400), budget('Personal', 200)];

  it('leaves your own alone when budgets are separate', () => {
    expect(householdBudgets(mine, theirs, 'separate')).toEqual(mine);
  });

  it('adds the two sides together when they are combined', () => {
    const combined = householdBudgets(mine, theirs, 'combined');
    expect(combined.find((b) => b.name === 'Groceries')!.totalLimit).toBe(1000);
  });

  it('computes the same number on both phones', () => {
    // No owner to decide, which is the point: neither side has to be told
    // whose budget won.
    const a = householdBudgets(mine, theirs, 'combined').find((b) => b.name === 'Groceries')!;
    const b = householdBudgets(theirs, mine, 'combined').find((x) => x.name === 'Groceries')!;
    expect(a.totalLimit).toBe(b.totalLimit);
  });

  it('keeps a category only one of them has at that one figure', () => {
    const combined = householdBudgets(mine, theirs, 'combined');
    expect(combined.find((b) => b.name === 'Transport')!.totalLimit).toBe(300);
  });

  it('leaves yours alone when the partner budgets could not be read', () => {
    expect(householdBudgets(mine, null, 'combined')).toEqual(mine);
    expect(householdBudgets(mine, [], 'combined')).toEqual(mine);
  });
});

describe('whose spending fills them', () => {
  const rows = [tx(ME, 84.21), tx(THEM, 122.9), tx(ME, 20)];

  it('counts only yours when budgets are separate', () => {
    // The whole point of separate lines: their fuel does not eat your fuel.
    expect(spendingAgainstMyBudgets(rows, ME, 'separate')).toHaveLength(2);
  });

  it('counts both when they are combined', () => {
    expect(spendingAgainstMyBudgets(rows, ME, 'combined')).toHaveLength(3);
  });

  it('keeps a row with no owner, rather than dropping a purchase', () => {
    // Older rows and anything the mapper could not stamp. Losing a real
    // purchase is far worse than counting one that might be the partner's.
    const orphan = [{ id: 'o', amount: 5, vendor: 'X', date: '2026-09-04' } as unknown as Transaction];
    expect(spendingAgainstMyBudgets(orphan, ME, 'separate')).toHaveLength(1);
  });
});

describe('what the household spent, including a partner you cannot see', () => {
  const visible = [tx(ME, 100), tx(THEM, 50)];

  it('sums the list when their rows are in it', () => {
    expect(householdSpend(visible, ME, emptySummary('transactions'))).toBe(150);
  });

  it('sums the list when there is no partner at all', () => {
    expect(householdSpend([tx(ME, 100)], ME, null)).toBe(100);
  });

  it('adds their summary when their rows are refused', () => {
    // At 'categories' or 'totals' the database refuses their rows, so summing
    // what is on screen would quietly leave them out and the balance would
    // claim the household had more money than it does.
    const summary = { level: 'totals' as const, total: 420, byCategory: {} };
    expect(householdSpend([tx(ME, 100)], ME, summary)).toBe(520);
  });

  it('never counts a partner twice', () => {
    // If a stale row of theirs is somehow still in the list, the summary is
    // the authority and their visible rows are dropped rather than added.
    const summary = { level: 'categories' as const, total: 50, byCategory: { Groceries: 50 } };
    expect(householdSpend(visible, ME, summary)).toBe(150);
  });
});

describe('reading what the database returned', () => {
  it('turns category rows into totals', () => {
    const summary = readPartnerSummary([
      { share_level: 'categories', budget: 'Groceries', total: 122.9 },
      { share_level: 'categories', budget: 'Personal', total: 95 },
    ])!;
    expect(summary.level).toBe('categories');
    expect(summary.total).toBeCloseTo(217.9, 2);
    expect(summary.byCategory.Personal).toBe(95);
  });

  it('reads a totals-only answer as one figure with no breakdown', () => {
    const summary = readPartnerSummary([{ share_level: 'totals', budget: null, total: 217.9 }])!;
    expect(summary.total).toBeCloseTo(217.9, 2);
    expect(Object.keys(summary.byCategory)).toHaveLength(0);
  });

  it('answers null when there is nothing to summarise', () => {
    // No partner, or one who shares their rows outright — in which case the
    // rows are the answer and a summary would double them.
    expect(readPartnerSummary([])).toBeNull();
    expect(readPartnerSummary(null)).toBeNull();
    expect(readPartnerSummary([{ share_level: 'transactions' }])).toBeNull();
  });
});

describe('the Me / Us / Them view', () => {
  const rows = [tx(ME, 40), tx(THEM, 15), { ...tx('', 5), user_id: undefined } as unknown as Transaction];
  const amounts = (list: Transaction[]) => list.map((row) => row.amount);

  it('opens on what the budget mode already showed', () => {
    expect(defaultHouseholdView('separate')).toBe('me');
    expect(defaultHouseholdView('combined')).toBe('us');
  });

  it('shows my purchases, theirs, or both — an unowned row is mine', () => {
    expect(amounts(transactionsForView(rows, ME, 'me'))).toEqual([40, 5]);
    expect(amounts(transactionsForView(rows, ME, 'them'))).toEqual([15]);
    expect(amounts(transactionsForView(rows, ME, 'us'))).toEqual([40, 15, 5]);
  });

  it('draws my limits, both added, or theirs on my categories', () => {
    const mine = [budget('Groceries', 500), budget('Fuel', 200)];
    const theirs = [budget('groceries', 300)];
    const limits = (list: BudgetCategory[]) => list.map((b) => [b.id, b.totalLimit]);
    expect(limits(budgetsForView(mine, theirs, 'me'))).toEqual([['Groceries', 500], ['Fuel', 200]]);
    expect(limits(budgetsForView(mine, theirs, 'us'))).toEqual([['Groceries', 800], ['Fuel', 200]]);
    expect(limits(budgetsForView(mine, theirs, 'them'))).toEqual([['Groceries', 300], ['Fuel', 200]]);
    expect(limits(budgetsForView(mine, null, 'them'))).toEqual([['Groceries', 500], ['Fuel', 200]]);
  });

  it('measures against my income, the household one, or theirs', () => {
    expect(incomeForView(4000, 3000, 'me')).toBe(4000);
    expect(incomeForView(4000, 3000, 'us')).toBe(7000);
    expect(incomeForView(4000, 3000, 'them')).toBe(3000);
    expect(incomeForView(4000, null, 'them')).toBe(0);
  });
});
