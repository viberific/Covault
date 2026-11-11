import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rolloverCarry, withRollover } from '../../../app/lib/budgets/budgetRollover';
import type { BudgetCategory, Transaction } from '../../../app/types';

/**
 * Budget Rollover does what its switch says.
 *
 * The switch was in Settings, on by default, saved and described in the
 * walkthrough — "whatever a category did not spend this month is added to its
 * limit next month" — and nothing read it. Flipping it changed nothing.
 */

const GROCERIES: BudgetCategory = { id: 'b-groceries', name: 'Groceries', totalLimit: 500 };
const LEISURE: BudgetCategory = { id: 'b-leisure', name: 'Leisure', totalLimit: 300 };
const TRANSPORT: BudgetCategory = { id: 'b-transport', name: 'Transport', totalLimit: 200 };
const BUDGETS = [GROCERIES, LEISURE, TRANSPORT];

let seq = 0;
const row = (date: string, amount: number, budget_id: string, over: Partial<Transaction> = {}) =>
  ({
    id: `tx-${++seq}`,
    user_id: 'me',
    vendor: `Shop ${seq}`,
    amount,
    date: `${date}T12:00:00.000Z`,
    budget_id,
    is_projected: false,
    label: 'Manual',
    created_at: `${date}T12:00:00.000Z`,
    ...over,
  }) as Transaction;

const carried = (rows: Transaction[], month = '2026-10', options = {}) =>
  Object.fromEntries(rolloverCarry(BUDGETS, rows, month, options));

describe('what carries into a month', () => {
  it('is what each category left unspent the month before, in whole dollars', () => {
    const rows = [row('2026-09-04', 420.6, GROCERIES.id), row('2026-09-09', 100, LEISURE.id)];
    expect(carried(rows)).toEqual({
      [GROCERIES.id]: 79,
      [LEISURE.id]: 200,
      [TRANSPORT.id]: 200,
    });
  });

  it('is nothing for a category that went over — no debt comes forward', () => {
    const rows = [row('2026-09-04', 640, GROCERIES.id)];
    expect(carried(rows)[GROCERIES.id]).toBeUndefined();
  });

  it('is one month only: a quiet August does not pile onto September’s', () => {
    const rows = [row('2026-08-04', 10, GROCERIES.id), row('2026-09-04', 450, GROCERIES.id)];
    expect(carried(rows)[GROCERIES.id]).toBe(50);
  });

  it('is nothing in a first month, when there was no month before', () => {
    expect(carried([row('2026-10-02', 30, GROCERIES.id)])).toEqual({});
    expect(carried([])).toEqual({});
  });

  it('counts a subscription that fell last month and was never saved as a row', () => {
    const netflix = row('2026-07-05', 20, LEISURE.id, { recurrence: 'Monthly' });
    expect(carried([netflix])[LEISURE.id]).toBe(280);
  });

  it('leaves out a purchase that was refunded', () => {
    const rows = [row('2026-09-04', 450, GROCERIES.id, { refunded: true })];
    expect(carried(rows)[GROCERIES.id]).toBe(500);
  });

  it('takes what the shield spent out of Leisure’s surplus', () => {
    const rows = [row('2026-09-04', 560, GROCERIES.id), row('2026-09-09', 100, LEISURE.id)];
    expect(carried(rows)[LEISURE.id]).toBe(200);
    expect(carried(rows, '2026-10', { useLeisureAsBuffer: true })[LEISURE.id]).toBe(140);
  });
});

describe('the limits the vials draw', () => {
  it('are the set limit plus the carry, marked with how much was carried', () => {
    const carry = rolloverCarry(BUDGETS, [row('2026-09-04', 420, GROCERIES.id)], '2026-10');
    const drawn = withRollover(BUDGETS, carry);
    expect(drawn[0]).toMatchObject({ totalLimit: 580, carriedOver: 80 });
    // The limit the user set is untouched for the settings screen to edit.
    expect(GROCERIES.totalLimit).toBe(500);
  });

  it('are the same list when nothing carries', () => {
    expect(withRollover(BUDGETS, rolloverCarry(BUDGETS, [], '2026-10'))).toBe(BUDGETS);
  });
});

describe('where the switch is read', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, '../../..', path), 'utf8');
  const dashboard = read('app/components/Dashboard/Dashboard.tsx');

  it('decides the vials, the shield and the over-budget alerts', () => {
    expect(dashboard).toContain('if (!state.settings.rolloverEnabled || viewMonthRelation ===');
    expect(dashboard).toContain('budgets={vialBudgetList}');
    expect(dashboard).toContain('computeShieldBreakdown(vialBudgetList');
    expect(dashboard).toContain('budgets: alertBudgetList');
  });

  it('leaves the chart on the limits as set', () => {
    expect(dashboard).toMatch(/<BudgetFlowChart\s+budgets=\{viewBudgetList\}/);
  });

  it('is explained on the open vial', () => {
    const vial = read(
      'app/components/Dashboard/DashboardBudgetSectionsList/BudgetSection/BudgetSection.tsx',
    );
    expect(vial).toContain('carried over');
  });
});
