import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateProjectedTransactions } from '../../../app/lib/transactions/projectedTransactions';
import { buildWidgetSnapshot } from '../../../app/lib/native/widgetSnapshot';
import type { Transaction } from '../../../app/types';

/**
 * A subscription whose day has come is spending, wherever spending is shown.
 *
 * Recurring charges are never saved as rows; the projection emits this
 * month's elapsed occurrences as spent and the vials and the balance count
 * them. The home-screen widget and the budget report were handed the saved
 * rows alone, so both left every subscription out and showed less spending
 * than the dashboard they summarise.
 */

const read = (path: string) => readFileSync(resolve(__dirname, '../../..', path), 'utf8');

const netflix: Transaction = {
  id: 'netflix',
  user_id: 'u1',
  vendor: 'Netflix',
  amount: 16.49,
  date: '2026-07-05T12:00:00.000Z',
  budget_id: 'b-leisure',
  recurrence: 'Monthly',
  is_projected: false,
  label: 'Manual',
  created_at: '2026-07-05T12:00:00.000Z',
} as Transaction;

describe('the widget', () => {
  it('counts an elapsed occurrence when it is handed one', () => {
    const elapsed = generateProjectedTransactions([netflix], '2026-09-20').filter(
      (tx) => !tx.is_projected && tx.date.startsWith('2026-09'),
    );
    expect(elapsed.map((tx) => tx.date)).toEqual(['2026-09-05']);

    const snapshot = buildWidgetSnapshot({
      budgets: [{ id: 'b-leisure', name: 'Leisure', totalLimit: 500 }],
      currentMonthTransactions: elapsed,
      remaining: 0,
      income: 0,
      theme: null,
      pendingReview: 0,
      monthKey: '2026-09',
      nowMs: 0,
    });
    expect(snapshot.totalSpent).toBe(16.49);
    expect(snapshot.slices.map((s) => s.name)).toEqual(['Leisure']);
  });

  it('is handed them by the dashboard, still for the month we are in', () => {
    const dashboard = read('app/components/Dashboard/Dashboard.tsx');
    expect(dashboard).toContain('currentMonthTransactions: widgetMonthTransactions');
    expect(dashboard).toContain(
      'projectedTransactions.filter((t) => !t.is_projected && isInMonth(t, monthKey))',
    );
  });
});

describe('the budget report', () => {
  it('adds the elapsed occurrences to the saved rows', () => {
    const report = read(
      'app/components/settings/DashboardSettingsModal/sections/ReportSection.tsx',
    );
    expect(report).toContain('...generateProjectedTransactions(transactions, todayIso)');
  });

  it('totals every purchase, not only the categories that have a limit', () => {
    const report = read(
      'app/components/settings/DashboardSettingsModal/sections/ReportSection.tsx',
    );
    expect(report).toContain('currentMonthTxs.reduce((acc, tx) => acc + countedAmount(tx), 0)');
    expect(report).not.toContain('budgetRows.reduce((acc, b) => acc + b.spent, 0)');
  });
});
