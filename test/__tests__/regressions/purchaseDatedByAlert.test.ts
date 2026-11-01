import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A captured purchase is dated by the day the bank announced it, not by the
 * day the app got round to it.
 *
 * With the app closed, the phone holds each bank alert in its own queue until
 * the next launch, and the pipeline used to date every row "today" — the day
 * it ran. So a Friday purchase that sat in the queue over the weekend landed
 * on Monday, which in practice was the day the user opened Review and
 * confirmed its category. The alert's own post time travels with it the whole
 * way; the row now uses it.
 */

vi.mock('../../../app/lib/ai/aiExtractor', () => ({
  extractWithAI: async () => {
    throw new Error('the AI is not consulted for a confidently parsed alert');
  },
  aiFindRefundMatch: async () => null,
}));

vi.mock('../../../app/lib/api/apiHelpers', () => ({
  restFetch: async () => ({ ok: true, status: 200, json: async () => [], text: async () => '[]' }),
  REST_BASE: 'https://example.test/rest/v1',
  getAuthHeaders: async () => ({}),
}));

const inserts: Record<string, unknown[]> = {};
const tableResults: Record<string, { data: unknown[]; error: unknown }> = {};

function tableChain(table: string) {
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'then') {
          return (resolvefn: (value: unknown) => unknown) =>
            resolvefn(tableResults[table] ?? { data: [], error: null });
        }
        if (prop === 'insert') {
          return (row: unknown) => {
            (inserts[table] ||= []).push(row);
            return chain;
          };
        }
        return () => chain;
      },
    },
  );
  return chain;
}

vi.mock('../../../app/lib/api/supabase', () => ({
  supabase: { from: (table: string) => tableChain(table) },
  supabaseUrl: 'https://example.test',
  supabaseAnonKey: 'anon',
}));

import { processNotificationWithAI, _clearDedupCacheForTesting } from '../../../app/lib/capture/notificationProcessor';
import { getLocalToday } from '../../../app/lib/time/dateUtils';

const CATEGORIES = [
  { id: 'cat-groceries', name: 'Groceries' },
  { id: 'cat-other', name: 'Other' },
];

const ALERT = 'SAFEWAY 🛒 You spent $42.18 with your credit card.';

/** Noon, local time, `days` days before today. */
function noonDaysAgo(days: number): { ms: number; day: string } {
  const [y, m, d] = getLocalToday().split('-').map(Number);
  const date = new Date(y, m - 1, d - days, 12, 0, 0);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
  return { ms: date.getTime(), day };
}

beforeEach(() => {
  for (const key of Object.keys(inserts)) delete inserts[key];
  for (const key of Object.keys(tableResults)) delete tableResults[key];
  _clearDedupCacheForTesting();
});

async function captureAt(notificationTimestamp: number | undefined) {
  await processNotificationWithAI(
    'user-1',
    {
      rawNotification: ALERT,
      bankAppId: 'com.bmo.mobile',
      bankName: 'BMO',
      notificationTimestamp,
    },
    CATEGORIES,
  );
  return inserts.transactions?.[0] as Record<string, unknown> | undefined;
}

describe('the date a captured purchase is filed under', () => {
  it('is the day the bank announced it, even when processed days later', async () => {
    const friday = noonDaysAgo(3);
    const row = await captureAt(friday.ms);
    expect(row?.date).toBe(friday.day);
  });

  it('is today for an alert that arrived today', async () => {
    const row = await captureAt(Date.now());
    expect(row?.date).toBe(getLocalToday());
  });

  it('falls back to today when the alert carries no time', async () => {
    const row = await captureAt(undefined);
    expect(row?.date).toBe(getLocalToday());
  });

  it('never files a purchase in the future, whatever the phone clock said', async () => {
    const row = await captureAt(Date.now() + 5 * 24 * 60 * 60 * 1000);
    expect(row?.date).toBe(getLocalToday());
  });
});
