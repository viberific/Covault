// @vitest-environment happy-dom
/**
 * A linked partner's purchases are readable on this phone, and only theirs to
 * change.
 *
 * The database refuses an edit or a delete of somebody else's row, and answers
 * that refusal with success. So a delete took the partner's purchase off the
 * screen until the next load put it back, and an edit closed its form as
 * though it had saved. Ending your own subscription also took a partner's
 * identical one off the screen, because a recurring series is recognised by
 * vendor, amount and day and knows nothing about whose it is.
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, Transaction } from '../../../app/types';
import { appErrorMessage } from '../../../app/lib/ui/appErrorMessage';

const apiMocks = vi.hoisted(() => ({ restFetch: vi.fn() }));

vi.mock('../../../app/lib/api/apiHelpers', () => apiMocks);
vi.mock('../../../app/lib/capture/localNotificationMemory', () => ({
  markReviewQueueStatus: vi.fn(),
  upsertVendorMapEntry: vi.fn(),
}));
vi.mock('../../../app/lib/vendors/vendorOverrideWrite', () => ({ persistVendorOverride: vi.fn() }));
vi.mock('../../../app/lib/native/covaultNotification', () => ({ clearCaptureNotificationForRows: vi.fn() }));

import { useTransactionOps } from '../../../app/data/useTransactionOps';

const row = (over: Partial<Transaction>): Transaction => ({
  id: 'mine-1',
  user_id: 'me',
  vendor: 'Netflix',
  amount: 16.49,
  date: '2026-09-10T12:00:00.000Z',
  budget_id: 'budget:leisure',
  recurrence: 'Monthly',
  is_projected: false,
  label: 'Manual',
  userName: 'Avery',
  created_at: '2026-09-10T12:00:00.000Z',
  ...over,
}) as Transaction;

const MINE = row({});
const THEIRS = row({ id: 'theirs-1', user_id: 'partner', userName: 'Sam' });
const THEIR_ONE_OFF = row({
  id: 'theirs-2', user_id: 'partner', vendor: 'Safeway', amount: 42, recurrence: 'One-time',
});

let container: HTMLDivElement;
let root: Root;
let state: AppState;
let ops: ReturnType<typeof useTransactionOps>;
const setDbError = vi.fn<(message: string | null) => void>();

function Harness() {
  const [appState, setAppState] = useState<AppState>(() => ({
    user: {
      id: 'me',
      name: 'Avery',
      email: 'avery@example.com',
      partnerId: 'partner',
      hasJointAccounts: true,
      budgetingSolo: false,
      monthlyIncome: 5000,
    },
    budgets: [{ id: 'budget:leisure', name: 'Leisure', totalLimit: 500 }],
    transactions: [MINE, THEIRS, THEIR_ONE_OFF],
    settings: {} as AppState['settings'],
  }));
  state = appState;
  ops = useTransactionOps({ appState, setAppState, setDbError, categoriesLoaded: true });
  return null;
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const ids = () => state.transactions.map((t) => t.id).sort();

describe("a partner's purchase", () => {
  it('is not deleted, stays on screen, and the app says why', async () => {
    let plan: unknown = 'unset';
    await act(async () => {
      plan = await ops.handleDeleteTransaction('theirs-2');
    });

    expect(plan).toBeNull();
    expect(ids()).toEqual(['mine-1', 'theirs-1', 'theirs-2']);
    expect(apiMocks.restFetch).not.toHaveBeenCalled();
    expect(appErrorMessage(setDbError.mock.calls[0][0])).toBe(
      "That purchase is your partner's. Only they can change or delete it.",
    );
  });

  it('is not edited, and the app says why instead of closing in silence', async () => {
    let saved = true;
    await act(async () => {
      saved = await ops.handleUpdateTransaction({ ...THEIR_ONE_OFF, amount: 1 });
    });

    expect(saved).toBe(false);
    expect(state.transactions.find((t) => t.id === 'theirs-2')?.amount).toBe(42);
    expect(apiMocks.restFetch).not.toHaveBeenCalled();
    expect(appErrorMessage(setDbError.mock.calls[0][0])).toBe(
      "That purchase is your partner's. Only they can change or delete it.",
    );
  });

  it('survives the end of an identical subscription of your own', async () => {
    apiMocks.restFetch.mockResolvedValue(new Response(null, { status: 204 }));

    await act(async () => {
      await ops.handleDeleteTransaction('mine-1');
    });

    expect(ids()).toEqual(['theirs-1', 'theirs-2']);
    const deleteUrl = String(apiMocks.restFetch.mock.calls[0][0]);
    expect(deleteUrl).toContain('mine-1');
    expect(deleteUrl).not.toContain('theirs-1');
  });
});
