/**
 * The Discretionary Shield actually takes a chunk out of Leisure.
 *
 * It shipped inert: the toggle saved, the vial knew how to draw a deduction,
 * and the dashboard passed a literal `0` between them — so switching the
 * shield on changed nothing on screen, which is exactly what a working feature
 * with nothing to absorb looks like. These tests pin the amount down, and pin
 * the two rules that keep it explainable: every dollar it removes from Leisure
 * is a dollar another vial ON SCREEN is over by, and the shield never rewrites
 * that other vial to look as though it came in under its limit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeShieldedOverflow,
  computeShieldBreakdown,
  computeBudgetTotals,
  isLeisureBudget,
} from '../discretionaryShield';
import type { BudgetCategory, Transaction } from '../../../types';

const LEISURE = '55555555-5555-5555-5555-555555555555';
const OTHER = '66666666-6666-6666-6666-666666666666';
const GROCERIES = '22222222-2222-2222-2222-222222222222';

const budgets = (overrides: Partial<Record<string, number>> = {}): BudgetCategory[] => [
  { id: GROCERIES, name: 'Groceries', totalLimit: overrides[GROCERIES] ?? 500 },
  { id: LEISURE, name: 'Leisure', totalLimit: overrides[LEISURE] ?? 500 },
  { id: OTHER, name: 'Other', totalLimit: overrides[OTHER] ?? 500 },
];

let seq = 0;
const tx = (budgetId: string, amount: number, extra: Partial<Transaction> = {}): Transaction =>
  ({
    id: `tx-${++seq}`,
    budget_id: budgetId,
    amount,
    vendor: `Vendor ${seq}`,
    date: '2026-09-03',
    label: 'Manual',
    ...extra,
  }) as Transaction;

describe('computeShieldedOverflow', () => {
  it('is zero when nothing is over its limit', () => {
    const rows = [tx(OTHER, 100), tx(GROCERIES, 250), tx(LEISURE, 400)];
    expect(computeShieldedOverflow(budgets(), rows)).toBe(0);
  });

  it('absorbs the amount another budget is over by', () => {
    // Other: $580 against a $500 limit.
    const rows = [tx(OTHER, 500), tx(OTHER, 80)];
    expect(computeShieldedOverflow(budgets(), rows)).toBe(80);
  });

  it('adds up every overspent budget, not just the first', () => {
    const rows = [tx(OTHER, 580), tx(GROCERIES, 545)];
    expect(computeShieldedOverflow(budgets(), rows)).toBe(125);
  });

  it('does not let an underspent budget cancel out an overspent one', () => {
    // Groceries came in $400 under. That surplus is not the shield's to spend
    // — the user is still over on Other, and the Leisure vault is what covers
    // it.
    const rows = [tx(OTHER, 580), tx(GROCERIES, 100)];
    expect(computeShieldedOverflow(budgets(), rows)).toBe(80);
  });

  it('never absorbs Leisure\'s own overspending', () => {
    // Otherwise the vault would be shielding itself: the deduction would grow
    // the overspend that produced it.
    const rows = [tx(LEISURE, 900)];
    expect(computeShieldedOverflow(budgets(), rows)).toBe(0);
  });

  it('counts this month\'s remaining recurring charges, like the vial does', () => {
    // The vial shows spent + projected against the limit, so a budget pushed
    // over by a subscription that has not landed yet is over on screen — and
    // has to be over here too, or the two disagree.
    const rows = [tx(OTHER, 450), tx(OTHER, 90, { is_projected: true })];
    expect(computeShieldedOverflow(budgets(), rows)).toBe(40);
  });

  it('leaves hidden categories out', () => {
    // A hidden category has no vial. Counting it would take a chunk out of
    // Leisure that nothing on screen accounts for — indistinguishable from the
    // bug this file exists to prevent.
    const rows = [tx(OTHER, 580), tx(GROCERIES, 545)];
    expect(
      computeShieldedOverflow(budgets(), rows, { hiddenCategories: [GROCERIES] }),
    ).toBe(80);
  });

  it('follows the refund, so a returned purchase stops being shielded', () => {
    const spend = tx(OTHER, 580, { vendor: 'Canadian Tire', date: '2026-09-02' });
    const refund = tx(OTHER, -580, { vendor: 'Canadian Tire', date: '2026-09-04' });
    expect(computeShieldedOverflow(budgets(), [spend, refund])).toBe(0);
  });

  it('reports whole cents rather than floating-point dust', () => {
    const rows = [tx(OTHER, 500.1), tx(GROCERIES, 500.2)];
    expect(computeShieldedOverflow(budgets(), rows)).toBe(0.3);
  });

  it('is zero before the budgets have loaded', () => {
    expect(computeShieldedOverflow([], [tx(OTHER, 900)])).toBe(0);
  });
});

describe('computeBudgetTotals', () => {
  it('is the arithmetic the vial itself draws with', () => {
    const rows = [tx(OTHER, 120), tx(OTHER, 80, { is_projected: true })];
    const totals = computeBudgetTotals(OTHER, rows);
    expect(totals.spent).toBe(120);
    expect(totals.projected).toBe(80);
  });

  it('keeps refunds out of the list of rows to show', () => {
    const spend = tx(OTHER, 60, { vendor: 'Indigo', date: '2026-09-02' });
    const refund = tx(OTHER, -60, { vendor: 'Indigo', date: '2026-09-05' });
    const totals = computeBudgetTotals(OTHER, [spend, refund]);
    expect(totals.visibleTransactions.map((t) => t.id)).toEqual([spend.id]);
    expect(totals.refundedExpenseIds.has(spend.id)).toBe(true);
    // A MATCHED refund used to count twice — the expense was dropped from the
    // total AND the refund's negative amount was subtracted — so a returned
    // $60 left the vial at -$60. The purchase and its refund now net to zero,
    // and the purchase is still struck through on screen.
    expect(totals.spent).toBe(0);
  });

  it('does not count a purchase the capture pipeline marked refunded', () => {
    // No negative row exists for these: the refund notification flags the
    // original purchase instead, so the purchase itself has to drop out.
    const spend = tx(OTHER, 75, { vendor: 'Indigo', refunded: true });
    const kept = tx(OTHER, 20, { vendor: 'Chapters' });
    const totals = computeBudgetTotals(OTHER, [spend, kept]);
    expect(totals.spent).toBe(20);
    expect(totals.refundedExpenseIds.has(spend.id)).toBe(true);
  });
});

describe('isLeisureBudget', () => {
  it('matches on the name, because the id is not stable', () => {
    // A budget loaded from the DB is keyed `budget:<name>`; the starter
    // constants carry fixed UUIDs. Only the name survives both.
    expect(isLeisureBudget({ name: 'Leisure' })).toBe(true);
    expect(isLeisureBudget({ name: 'leisure' })).toBe(true);
    expect(isLeisureBudget({ name: 'Other' })).toBe(false);
    expect(isLeisureBudget({ name: undefined })).toBe(false);
  });
});

describe('the wiring between the toggle and the vial', () => {
  const read = (relative: string) =>
    readFileSync(join(__dirname, '../../../../', relative), 'utf8');

  const dashboard = read('app/components/Dashboard/Dashboard.tsx');
  const list = read('app/components/Dashboard/DashboardBudgetSectionsList/DashboardBudgetSectionsList.tsx');

  it('passes a real figure down, not the literal 0 it shipped with', () => {
    expect(dashboard).toContain('computeShieldBreakdown');
    expect(dashboard).not.toContain('leisureAdjustments={0}');
    expect(dashboard).not.toContain('leisureShield={0}');
  });

  it('computes nothing while the shield is switched off', () => {
    expect(dashboard).toMatch(
      /if \(!state\.settings\.useLeisureAsBuffer\) return NO_SHIELD;/,
    );
  });

  it('reads the month on screen, so browsing back shields that month', () => {
    // `currentMonthBudgetTransactions` here would shield September's overspend
    // while the user was reading March.
    const call = dashboard
      .slice(dashboard.indexOf('computeShieldBreakdown(viewBudgetList'))
      .slice(0, 200);
    expect(call).toContain('viewMonthBudgetTransactions');
  });

  it('leaves the headline balance alone, so the overspend is not counted twice', () => {
    const remaining = dashboard
      .slice(dashboard.indexOf('const viewMonthRemaining'))
      .slice(0, 400);
    expect(remaining).not.toContain('leisureShield');
  });

  it('deducts from Leisure only, and only while the shield is on', () => {
    expect(list).toMatch(
      /const shielded = isLeisure && safeSettings\.useLeisureAsBuffer;/,
    );
    expect(list).toMatch(
      /shielded[\s\S]{0,120}externalDeduction: leisureShield\.total/,
    );
  });

  it('never rewrites the overspent budget to look as though it fitted', () => {
    // The shield absorbs the overflow into Leisure; it does not hand the
    // overspent category a bigger limit or a smaller total, or that vial would
    // stop saying "Over by $80" the moment the shield was switched on — hiding
    // the one fact the user most needs from it.
    expect(list).not.toMatch(/totalLimit:\s*[^}]*leisureShield/);
    expect(list).not.toMatch(/externalDeduction:\s*-/);
  });

  it('hands the breakdown to the Leisure card and to no other', () => {
    expect(list).toContain(
      'shieldContributors={shielded ? leisureShield.contributors : undefined}',
    );
  });
});

describe('the shielded chunk on screen', () => {
  const read = (relative: string) =>
    readFileSync(join(__dirname, '../../../../', relative), 'utf8');

  const vial = read('app/components/Dashboard/DashboardBudgetSectionsList/BudgetSection/BudgetSection.tsx');

  it('draws the borrowed money as its own band, not inside the spent fill', () => {
    // The whole point: folded into the solid fill, the shielded money is
    // indistinguishable from the user's own spending in this vault — the bar
    // is just fuller, which is what "the shield isn't working" looks like.
    expect(vial).toMatch(/const ownSpentWidth = asWidth\(spent\);/);
    expect(vial).toMatch(/const shieldWidth = Math\.min\(100 - ownSpentWidth, asWidth\(external\)\);/);
    // The solid gradient covers this vault's OWN spending only.
    expect(vial).toMatch(/scaleX\(\$\{Math\.max\(0, Math\.min\(100, ownSpentWidth\)\) \/ 100\}\)/);
  });

  it('uses the hatch the chart already draws, at its own 6px pitch', () => {
    // Same texture vocabulary as BudgetFlowChart's savings area and the vial's
    // 6px dots — a third pattern from somewhere else would read as another app.
    expect(vial).toContain('repeating-linear-gradient(45deg');
    expect(vial).toContain('transparent 6px');
    // Colour from the category, like the dots, so no light/dark branching.
    expect(vial).toMatch(/\$\{budgetColor\}45/);
  });

  it('renders nothing extra when the shield is carrying nothing', () => {
    // Every other vial, and Leisure on a month where nothing is over, must be
    // the bar that was there before.
    expect(vial).toMatch(/\{shieldWidth > 0 && \(/);
    expect(vial).toMatch(/\{external > 0 && <ShieldMark/);
  });

  it('keeps the three segments inside the bar', () => {
    // Each segment is clamped against what the ones before it already used, so
    // they cannot sum past the vial's width however far over budget the user is.
    expect(vial).toMatch(/const spentWidth = Math\.min\(100, ownSpentWidth \+ shieldWidth\);/);
    expect(vial).toMatch(/const projectedWidth = Math\.min\(100 - spentWidth, asWidth\(projected\)\);/);
  });

  it('lets the caption be tapped without shutting the card', () => {
    // The header underneath owns the tap and would collapse the very card the
    // notice was raised from.
    expect(vial).toMatch(/setShowShieldNotice\(true\)/);
    expect(vial).toMatch(/e\.stopPropagation\(\);[\s\S]{0,60}setShowShieldNotice/);
  });
});

describe('describeContributors, via the sentence the notice shows', () => {
  it('joins two or more with commas and an "and"', () => {
    const breakdown = computeShieldBreakdown(budgets(), [
      tx(OTHER, 550),
      tx(GROCERIES, 530),
    ]);
    expect(breakdown.contributors).toEqual([
      { name: 'Other', amount: 50 },
      { name: 'Groceries', amount: 30 },
    ]);
  });

  it('puts the biggest borrower first, whatever order the budgets are in', () => {
    const breakdown = computeShieldBreakdown(budgets(), [
      tx(GROCERIES, 590),
      tx(OTHER, 510),
    ]);
    expect(breakdown.contributors.map((c) => c.name)).toEqual(['Groceries', 'Other']);
  });

  it('agrees with the figure taken out of the vault, to the cent', () => {
    const rows = [tx(OTHER, 580), tx(GROCERIES, 545)];
    const breakdown = computeShieldBreakdown(budgets(), rows);
    const summed = breakdown.contributors.reduce((a, c) => a + c.amount, 0);
    expect(summed).toBe(breakdown.total);
    expect(breakdown.total).toBe(computeShieldedOverflow(budgets(), rows));
  });

  it('names nobody when nothing is over', () => {
    const breakdown = computeShieldBreakdown(budgets(), [tx(OTHER, 100)]);
    expect(breakdown).toEqual({ total: 0, contributors: [] });
  });

  it('leaves Leisure and hidden categories out of the list too', () => {
    const rows = [tx(LEISURE, 900), tx(OTHER, 580), tx(GROCERIES, 545)];
    const breakdown = computeShieldBreakdown(budgets(), rows, {
      hiddenCategories: [GROCERIES],
    });
    expect(breakdown.contributors).toEqual([{ name: 'Other', amount: 80 }]);
  });
});
