// @vitest-environment happy-dom
/**
 * A past month's balance counts a partner whose purchases are not on this
 * phone.
 *
 * A partner sharing only a total has no rows here, and app state holds their
 * summary for the current month alone. Browsing back showed a closing balance
 * with only one person's spending taken out of the household's income.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PartnerSummary } from '../../../app/lib/budgets/householdSharing';

const apiMocks = vi.hoisted(() => ({ callRpc: vi.fn() }));
vi.mock('../../../app/lib/api/apiHelpers', () => apiMocks);

import { usePartnerMonthSummary } from '../../../app/components/Dashboard/usePartnerMonthSummary';
import { householdSpend } from '../../../app/lib/budgets/householdSharing';

let container: HTMLDivElement;
let root: Root;
let seen: PartnerSummary | null;

function Harness({ monthKey }: { monthKey: string | null }) {
  seen = usePartnerMonthSummary(monthKey);
  return null;
}

const show = (monthKey: string | null) => act(async () => root.render(<Harness monthKey={monthKey} />));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('the partner’s month, for a month being browsed', () => {
  it('is asked for by month and taken out of that month’s balance', async () => {
    apiMocks.callRpc.mockResolvedValue({ ok: true, data: [{ share_level: 'totals', budget: null, total: 640 }] });
    await show('2026-08');

    expect(apiMocks.callRpc).toHaveBeenCalledWith('partner_month_summary', { p_month: '2026-08' });
    expect(seen).toMatchObject({ level: 'totals', total: 640 });
    expect(5000 - householdSpend([], 'me', seen)).toBe(4360);
  });

  it('is not asked for when there is nothing to ask', async () => {
    await show(null);
    expect(apiMocks.callRpc).not.toHaveBeenCalled();
    expect(seen).toBeNull();
  });

  it('never shows one month’s figure against another month', async () => {
    apiMocks.callRpc.mockResolvedValueOnce({ ok: true, data: [{ share_level: 'totals', total: 640 }] });
    await show('2026-08');
    apiMocks.callRpc.mockReturnValueOnce(new Promise(() => {}));
    await show('2026-07');
    expect(seen).toBeNull();
  });

  it('leaves the balance as it was when the answer cannot be read', async () => {
    apiMocks.callRpc.mockResolvedValue({ ok: false, data: null });
    await show('2026-08');
    expect(seen).toBeNull();
  });
});

describe('the dashboard', () => {
  const dashboard = readFileSync(
    resolve(__dirname, '../../..', 'app/components/Dashboard/Dashboard.tsx'),
    'utf8',
  );

  it('asks only for a finished month, and only when the partner’s rows are withheld', () => {
    expect(dashboard).toContain(
      "state.partnerSummary && viewMonthRelation === 'past' ? viewMonthKey : null",
    );
    expect(dashboard).toContain(
      'householdSpend(viewMonthAllTransactions, myUserId, browsedPartnerSummary)',
    );
  });
});
