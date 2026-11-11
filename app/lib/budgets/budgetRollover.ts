// app/lib/budgets/budgetRollover.ts
//
// Budget Rollover: what a category did not spend last month is added to its
// limit this month.
//
// The switch for this sat in Settings, on by default, saved to the database
// and explained in the walkthrough — and nothing read it. Every category
// started each month at the limit the user set whichever way it was flipped.
//
// The rules, each chosen so the carried figure is one the user can check:
//
//  - **One month, not a running total.** The carry is last month's limit less
//    last month's spending, and last month's limit is the one the user set —
//    not that limit plus whatever was carried into it. A surplus that
//    compounded would grow without anybody deciding it should, and after a
//    quiet year a vial would show a limit several times the figure in
//    Settings.
//  - **Only a surplus.** An overspent category carries nothing; it does not
//    start the next month in debt. Whole dollars, rounded down, so the limit
//    on the vial stays a whole figure and is never overstated.
//  - **Nothing from before the vault was in use.** A month with no spending
//    in it or before it is not a month of perfect restraint — it is a month
//    the app was not being used, and carrying it would double every limit on
//    a new user's first day.
//  - **Recurring charges count.** They are never saved as rows, so last
//    month's are read from the schedule, as the dashboard reads this month's.
//  - **Leisure's surplus is what was left after the shield.** With the
//    Discretionary Shield on, Leisure covered other categories' overspending
//    last month; that money is spent and does not come forward.

import type { BudgetCategory, Transaction } from '../../types';
import { isInMonth } from '../transactions/transactionOrdering';
import { generateProjectedTransactions } from '../transactions/projectedTransactions';
import { countedAmount } from '../transactions/refundMatching';
import { isMonthKey, shiftMonthKey } from '../time/monthWindow';
import { computeShieldedOverflow, isLeisureBudget } from './discretionaryShield';

export interface RolloverOptions {
  /** The Discretionary Shield setting. */
  useLeisureAsBuffer?: boolean;
  /** Categories the user has hidden; the shield leaves them out. */
  hiddenCategories?: readonly string[];
}

const NO_CARRY: ReadonlyMap<string, number> = new Map();

/** Last calendar day of a YYYY-MM month, as YYYY-MM-DD. */
function lastDayOfMonth(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  const day = new Date(year, month, 0).getDate();
  return `${monthKey}-${String(day).padStart(2, '0')}`;
}

/**
 * Budget id → dollars carried into `monthKey` from the month before it.
 *
 * @param budgets      The limits being drawn, before any carry.
 * @param transactions Saved rows for whoever those limits belong to — every
 *                     month, not only the one before. Projections are ignored.
 */
export function rolloverCarry(
  budgets: readonly BudgetCategory[],
  transactions: readonly Transaction[],
  monthKey: string,
  options: RolloverOptions = {},
): ReadonlyMap<string, number> {
  if (!isMonthKey(monthKey) || !budgets || budgets.length === 0) return NO_CARRY;

  const previousKey = shiftMonthKey(monthKey, -1);
  const saved = (transactions || []).filter(
    (tx) => !String(tx.id || '').startsWith('projected-') && typeof tx.date === 'string',
  );
  // Nothing on the books up to the end of last month: the vault was not in
  // use yet, so there is no month to carry from.
  if (!saved.some((tx) => tx.date.slice(0, 7) <= previousKey)) return NO_CARRY;

  // Last month as it finished: its saved rows, plus the recurring charges
  // that fell in it and were never saved as rows of their own.
  const recurring = generateProjectedTransactions(saved, lastDayOfMonth(previousKey));
  const lastMonth = [...saved, ...recurring].filter(
    (tx) => !tx.is_projected && isInMonth(tx, previousKey),
  );

  const spentById = new Map<string, number>();
  for (const tx of lastMonth) {
    if (!tx.budget_id) continue;
    spentById.set(tx.budget_id, (spentById.get(tx.budget_id) ?? 0) + countedAmount(tx));
  }

  const shielded = options.useLeisureAsBuffer
    ? computeShieldedOverflow(budgets, lastMonth, { hiddenCategories: options.hiddenCategories })
    : 0;

  const carry = new Map<string, number>();
  for (const budget of budgets) {
    const limit = Number(budget.totalLimit) || 0;
    if (limit <= 0) continue;
    const spent = spentById.get(budget.id) ?? 0;
    const absorbed = isLeisureBudget(budget) ? shielded : 0;
    // Never more than the limit itself: a month of refunds is not a windfall.
    const surplus = Math.min(limit, limit - Math.max(0, spent) - absorbed);
    const dollars = Math.floor(surplus + 1e-9);
    if (dollars > 0) carry.set(budget.id, dollars);
  }
  return carry.size > 0 ? carry : NO_CARRY;
}

/**
 * The limits with their carry added, each marked with how much of it was
 * carried so the vial can say so. Returns the same list when nothing carries.
 */
export function withRollover(
  budgets: BudgetCategory[],
  carry: ReadonlyMap<string, number>,
): BudgetCategory[] {
  if (carry.size === 0) return budgets;
  return budgets.map((budget) => {
    const extra = carry.get(budget.id);
    return extra
      ? { ...budget, totalLimit: (Number(budget.totalLimit) || 0) + extra, carriedOver: extra }
      : budget;
  });
}
