// app/lib/budgets/householdSharing.ts
//
// The two questions a couple actually has, which linking used to answer with
// one word.
//
//   1. WHOSE BUDGETS?  Most couples keep their own lines — his $300 of fuel,
//      her $200 of personal — drawn against one household income. Some pool
//      everything into one set. Linking used to assume the second and deliver
//      neither: each phone showed its own limits measured against the
//      household's combined spending, so the same grocery total ran against a
//      different line on each screen and one person saw a full vial while the
//      other saw it overflowing.
//
//   2. HOW MUCH DETAIL?  Seeing that a partner spent $95 on Personal is a
//      different thing from seeing that it was a lash bar. Sharing a budget
//      should not require sharing every merchant, and a couple who want the
//      first should not have to decline the whole feature to avoid the second.
//
// The two are independent: you can pool budgets and still keep your merchants
// to yourself, or keep separate lines and share every purchase.
//
// The income question is NOT a third setting. A linked household has one
// income — both figures added — in either mode, because "Our Remaining
// Balance" is a claim about the household's money and there is no reading of
// it where one person's salary is the whole of it.

import type { AppState, Transaction, BudgetCategory } from '../../types';
import { countedAmount } from '../transactions/refundMatching';

/** Whose budget lines the vials show. A property of the household, not a phone. */
export type BudgetMode = 'separate' | 'combined';

/**
 * How much of your spending your partner sees. Yours alone to set, and
 * deliberately not symmetric — it is your data, and a setting that only worked
 * if both of you agreed would be a negotiation rather than a choice.
 */
export type ShareLevel = 'transactions' | 'categories' | 'totals';

export const SHARE_LEVELS: ShareLevel[] = ['totals', 'categories', 'transactions'];

/** What each level lets the other person see, in their words. */
export const SHARE_LEVEL_COPY: Record<ShareLevel, { title: string; blurb: string }> = {
  totals: {
    title: 'Just the total',
    blurb: 'They see what you spent this month as one figure, and nothing about where.',
  },
  categories: {
    title: 'Category totals',
    blurb: 'They see $95 went to Personal. They do not see the merchant, the day or the amount of any one purchase.',
  },
  transactions: {
    title: 'Every purchase',
    blurb: 'They see each purchase the way you do — merchant, amount, day and category.',
  },
};

export const BUDGET_MODE_COPY: Record<BudgetMode, { title: string; blurb: string }> = {
  separate: {
    title: 'Our own budgets',
    blurb: 'You each keep your own limits, drawn against the household income. You can see each other spend without sharing a line.',
  },
  combined: {
    title: 'One set of budgets',
    blurb: 'Your limits are added together and both of you spend against the same vials.',
  },
};

/** A partner's month, at whatever detail they allow. */
export interface PartnerSummary {
  level: ShareLevel;
  /** Their month's total. Known at every level. */
  total: number;
  /** Budget name → their total. Empty unless they share categories or more. */
  byCategory: Record<string, number>;
}

export function emptySummary(level: ShareLevel = 'transactions'): PartnerSummary {
  return { level, total: 0, byCategory: {} };
}

/** Read the rows `partner_month_summary` returns into something usable. */
export function readPartnerSummary(rows: unknown): PartnerSummary | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0] as { share_level?: unknown };
  const level = typeof first?.share_level === 'string' ? first.share_level : '';
  if (level !== 'categories' && level !== 'totals') return null;

  const summary = emptySummary(level);
  for (const raw of rows) {
    const row = raw as { budget?: unknown; total?: unknown };
    const amount = Number(row?.total);
    if (!Number.isFinite(amount)) continue;
    summary.total += amount;
    if (typeof row?.budget === 'string' && row.budget) {
      summary.byCategory[row.budget] = (summary.byCategory[row.budget] || 0) + amount;
    }
  }
  return summary;
}

/**
 * The income the balance is measured against.
 *
 * Both figures, added, once there is a partner — in either budget mode. A
 * household that has linked is looking at one pot, and taking only the
 * signed-in person's salary is what made two phones disagree about the same
 * money by exactly the other person's income.
 *
 * A partner income that could not be read (an older database, a failed call)
 * falls back to your own figure alone, which is what the app did before this
 * existed. Understating the money available is the safe direction to be wrong
 * in: it makes the user cautious rather than confident.
 */
export function householdIncome(
  ownIncome: number,
  partnerIncome: number | null | undefined,
): number {
  const own = Number(ownIncome) || 0;
  const theirs = Number(partnerIncome);
  return Number.isFinite(theirs) && theirs > 0 ? own + theirs : own;
}

/**
 * The limits the vials draw, for the mode the household chose.
 *
 * Combined adds the two sides' limits per category, which is the only
 * definition that needs no owner: both phones compute the same number from the
 * same two rows, so neither has to be told whose budget won. A category only
 * one of them has keeps that one's figure.
 */
export function householdBudgets(
  own: BudgetCategory[],
  partner: BudgetCategory[] | null | undefined,
  mode: BudgetMode,
): BudgetCategory[] {
  if (mode !== 'combined' || !partner || partner.length === 0) return own;

  const theirs = new Map<string, number>();
  for (const budget of partner) {
    const name = (budget?.name || '').trim();
    if (name) theirs.set(name.toLowerCase(), Number(budget.totalLimit) || 0);
  }

  return own.map((budget) => {
    const extra = theirs.get((budget.name || '').trim().toLowerCase());
    return extra ? { ...budget, totalLimit: (Number(budget.totalLimit) || 0) + extra } : budget;
  });
}

/**
 * The spending that counts against YOUR vials.
 *
 * In combined mode both people's purchases do; in separate mode only your own,
 * because the whole point of separate lines is that their fuel does not eat
 * your fuel. Their spending is still on the dashboard either way — it is in
 * the household balance at the top, and in the transaction list if they share
 * that far.
 */
export function spendingAgainstMyBudgets(
  transactions: Transaction[],
  myUserId: string,
  mode: BudgetMode,
): Transaction[] {
  if (mode === 'combined') return transactions;
  return transactions.filter((tx) => !tx.user_id || tx.user_id === myUserId);
}

/**
 * Everything the household spent this month, including a partner whose rows
 * you cannot see.
 *
 * Which is the case this function exists for: at 'categories' or 'totals' the
 * partner's transactions are refused by the database, so summing the list on
 * screen would quietly leave them out and the balance would say the household
 * had more money than it does. Their summary is added instead.
 */
export function householdSpend(
  visibleTransactions: Transaction[],
  myUserId: string,
  partnerSummary: PartnerSummary | null,
): number {
  // countedAmount, not the raw amount: a purchase the pipeline marked refunded
  // has already dropped out of its vial and must drop out of the balance too.
  const visible = visibleTransactions.reduce((sum, tx) => sum + countedAmount(tx), 0);
  if (!partnerSummary) return visible;
  // At 'transactions' the rows are already in the list above; anything else and
  // they are not, so the summary is the only record of them.
  if (partnerSummary.level === 'transactions') return visible;
  const mine = visibleTransactions
    .filter((tx) => !tx.user_id || tx.user_id === myUserId)
    .reduce((sum, tx) => sum + countedAmount(tx), 0);
  return mine + partnerSummary.total;
}

/**
 * App state with every trace of a partner taken out.
 *
 * Unlinking used to clear the partner's NAME and nothing that was derived from
 * them: their income stayed in the household figure, their month summary kept
 * being subtracted from it, their limits stayed in the combined vials and
 * their purchases stayed in the list — so "Remaining Balance" went on counting
 * an ex-partner's salary until the app was next closed. The same happened on
 * the other phone when a partner unlinked from theirs, because the reload that
 * found no partner cleared nothing.
 *
 * `budgetingSolo` is only flipped back when there WAS a partner to lose. A
 * person with no partner yet who chose "together" during setup keeps that
 * choice; this is about a link that ended, not about who they are.
 *
 * Returns the same object when there is nothing to remove, so a reload that
 * finds no partner, for someone who never had one, does not re-render the app.
 */
export function withoutPartner(state: AppState, myUserId: string): AppState {
  const hadPartner = !!state.user?.partnerId;
  const hasPartnerFigures =
    state.partnerIncome != null || state.partnerSummary != null || state.partnerBudgets != null;
  const hasPartnerRows = state.transactions.some(
    (tx) => !!tx.user_id && tx.user_id !== myUserId,
  );
  if (!hadPartner && !hasPartnerFigures && !hasPartnerRows) return state;

  return {
    ...state,
    user: state.user && hadPartner
      ? {
          ...state.user,
          budgetingSolo: true,
          hasJointAccounts: false,
          partnerId: undefined,
          partnerName: undefined,
          partnerEmail: undefined,
        }
      : state.user,
    partnerIncome: null,
    partnerSummary: null,
    partnerBudgets: null,
    transactions: hasPartnerRows
      ? state.transactions.filter((tx) => !tx.user_id || tx.user_id === myUserId)
      : state.transactions,
  };
}

/**
 * Whose money the chart and the vials are showing: the signed-in person's,
 * both people's, or only the partner's.
 *
 * A viewing choice, not a setting. It changes nothing either phone stores,
 * and nothing that leaves this screen — the widget and the over-budget alerts
 * keep following `BudgetMode` — and the balance at the top stays the
 * household's whichever is picked, because it is a claim about the
 * household's money.
 */
export type HouseholdView = 'me' | 'us' | 'them';

/**
 * The view a dashboard opens on: what the household's budget mode already
 * shows. Separate lines are "mine", pooled lines are "ours", so a household
 * that never touches the switch sees exactly what it saw before it existed.
 */
export function defaultHouseholdView(mode: BudgetMode): HouseholdView {
  return mode === 'combined' ? 'us' : 'me';
}

/** One person's rows, the other's, or both. A row with no owner is the signed-in person's. */
export function transactionsForView(
  transactions: Transaction[],
  myUserId: string,
  view: HouseholdView,
): Transaction[] {
  if (view === 'us') return transactions;
  const mine = (tx: Transaction) => !tx.user_id || tx.user_id === myUserId;
  return transactions.filter(view === 'me' ? mine : (tx) => !mine(tx));
}

/**
 * The limits the vials and the chart draw for a view.
 *
 * "Us" is the two sides added per category, as in the combined mode. "Them"
 * puts the partner's limit on each of your categories by name, so the vials
 * keep their order, colours and ids. A category the partner has no line for
 * keeps yours, and an unreadable partner list leaves your own limits, rather
 * than a row of empty vials that would read as "they budgeted nothing".
 */
export function budgetsForView(
  own: BudgetCategory[],
  partner: BudgetCategory[] | null | undefined,
  view: HouseholdView,
): BudgetCategory[] {
  if (view === 'me') return own;
  if (view === 'us') return householdBudgets(own, partner, 'combined');
  if (!partner || partner.length === 0) return own;

  const theirs = new Map<string, number>();
  for (const budget of partner) {
    const name = (budget?.name || '').trim().toLowerCase();
    if (name) theirs.set(name, Number(budget.totalLimit) || 0);
  }
  return own.map((budget) => {
    const limit = theirs.get((budget.name || '').trim().toLowerCase());
    return limit === undefined ? budget : { ...budget, totalLimit: limit };
  });
}

/** The income line on the chart for a view. */
export function incomeForView(
  ownIncome: number,
  partnerIncome: number | null | undefined,
  view: HouseholdView,
): number {
  if (view === 'me') return Number(ownIncome) || 0;
  if (view === 'us') return householdIncome(ownIncome, partnerIncome);
  const theirs = Number(partnerIncome);
  return Number.isFinite(theirs) && theirs > 0 ? theirs : 0;
}
