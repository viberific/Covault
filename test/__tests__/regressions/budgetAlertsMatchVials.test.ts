/**
 * The over-budget alerts say what the vials say.
 *
 * Three ways they used to disagree:
 *
 *   1. In separate mode a partner's purchases do not count against your lines
 *      — the vials leave them out — but the alerts counted them, so a partner's
 *      big shop announced that YOUR Groceries was over its limit while your
 *      Groceries vial sat half full.
 *   2. A purchase refunded by notification had dropped out of its vial and
 *      still counted towards the alert.
 *   3. The 80% warning and the overrun shared one flag, so once a budget had
 *      been warned about, going over it later that month was never mentioned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const schedule = vi.fn();

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: vi.fn(async () => ({ display: 'granted' })),
    requestPermissions: vi.fn(),
    schedule: (...args: unknown[]) => schedule(...args),
  },
}));

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string) { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string) { this.store.set(k, String(v)); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}
const storage = new MemoryStorage();
vi.stubGlobal('localStorage', storage);

import { checkAndTriggerAppNotifications } from '../../../app/lib/native/appNotifications';
import type { BudgetCategory, Transaction } from '../../../app/types';

const ME = 'me';
const THEM = 'them';
const GROCERIES: BudgetCategory = { id: 'b-groceries', name: 'Groceries', totalLimit: 500 };
const SETTINGS = { app_notifications_enabled: true, smart_notifications_enabled: true };

let seq = 0;
const row = (user_id: string, amount: number, extra: Partial<Transaction> = {}): Transaction =>
  ({
    id: `tx-${++seq}`,
    user_id,
    vendor: 'Safeway',
    amount,
    date: '2026-09-10',
    budget_id: GROCERIES.id,
    is_projected: false,
    label: 'Manual',
    userName: user_id,
    ...extra,
  }) as Transaction;

function titlesSent(): string[] {
  return schedule.mock.calls.map(
    (call) => (call[0] as { notifications: Array<{ title: string }> }).notifications[0].title,
  );
}

async function check(transactions: Transaction[], budgetMode?: 'separate' | 'combined') {
  await checkAndTriggerAppNotifications({
    userId: ME,
    budgets: [GROCERIES],
    transactions,
    budgetMode,
    remainingMoney: 1000,
    settings: SETTINGS,
  });
}

beforeEach(() => {
  storage.clear();
  schedule.mockReset();
});

describe('whose spending sets off an alert', () => {
  it('ignores a partner in separate mode, as the vials do', async () => {
    await check([row(ME, 200), row(THEM, 450)], 'separate');
    expect(titlesSent()).toEqual([]);
  });

  it('counts both people in combined mode', async () => {
    await check([row(ME, 200), row(THEM, 450)], 'combined');
    expect(titlesSent()).toEqual(['Budget exceeded']);
  });

  it('does not count a purchase that was refunded', async () => {
    await check([row(ME, 450, { refunded: true }), row(ME, 100)]);
    expect(titlesSent()).toEqual([]);
  });
});

describe('what is said, and how often', () => {
  it('warns at 80%, then still says so when the budget goes over', async () => {
    await check([row(ME, 420)]);
    await check([row(ME, 420), row(ME, 30)]);
    await check([row(ME, 420), row(ME, 30), row(ME, 90)]);
    expect(titlesSent()).toEqual(['Budget warning', 'Budget exceeded']);
  });

  it('says each thing once a month', async () => {
    await check([row(ME, 600)]);
    await check([row(ME, 700)]);
    expect(titlesSent()).toEqual(['Budget exceeded']);
  });

  it('never warns about 80% after it has already said the budget is over', async () => {
    await check([row(ME, 600)]);
    // A refund brings it back under the line.
    await check([row(ME, 600), row(ME, -150)]);
    expect(titlesSent()).toEqual(['Budget exceeded']);
  });

  it('reads the flag older builds wrote as "already told", so nobody hears it twice', async () => {
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    storage.setItem(`covault_alert_budget_${ME}_${GROCERIES.id}_${month}`, '1');
    await check([row(ME, 600)]);
    expect(titlesSent()).toEqual([]);
  });
});

describe('the balance alert', () => {
  const balance = (remainingMoney: number) =>
    checkAndTriggerAppNotifications({
      userId: ME,
      budgets: [GROCERIES],
      transactions: [],
      remainingMoney,
      settings: SETTINGS,
    });
  const bodies = () =>
    schedule.mock.calls.map(
      (call) => (call[0] as { notifications: Array<{ body: string }> }).notifications[0].body,
    );

  it('stays quiet at exactly zero, which has not gone negative', async () => {
    await balance(0);
    expect(titlesSent()).toEqual([]);
  });

  it('is still available later in the month after a balance of zero', async () => {
    // The alert is remembered for the month, so sending it at $0 also meant
    // the real overdraft that followed was never mentioned.
    await balance(0);
    await balance(-42.4);
    expect(titlesSent()).toEqual(['Balance alert']);
    expect(bodies()).toEqual(['Your remaining balance (-$42) has gone negative.']);
  });
});

