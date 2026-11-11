import { useEffect, useState } from 'react';
import { callRpc } from '../../lib/api/apiHelpers';
import { readPartnerSummary, type PartnerSummary } from '../../lib/budgets/householdSharing';

/**
 * What a linked partner spent in a month other than this one, when their
 * purchases are not readable here.
 *
 * A partner who shares only a total, or category totals, has no rows on this
 * phone; app state holds their summary for the month we are in and nothing
 * else. So browsing back a month showed a closing balance with only one
 * person's spending taken out of the household's income — too high by
 * everything the partner spent that month.
 *
 * Null until the answer for THIS month arrives, and null if it cannot be
 * read: the balance then shows what it showed before, rather than a figure
 * for some other month.
 *
 * @param monthKey The month to ask about, or null when there is nothing to
 *                 ask — the current month, a month still to come, or a
 *                 household whose partner's rows are on the phone already.
 */
export function usePartnerMonthSummary(monthKey: string | null): PartnerSummary | null {
  const [answer, setAnswer] = useState<{ monthKey: string; summary: PartnerSummary | null } | null>(null);

  useEffect(() => {
    if (!monthKey) return;
    let cancelled = false;
    void callRpc<unknown>('partner_month_summary', { p_month: monthKey })
      .then((result) => {
        if (cancelled) return;
        setAnswer({ monthKey, summary: result.ok ? readPartnerSummary(result.data) : null });
      })
      .catch(() => {
        /* Unreadable: leave the balance as it was. */
      });
    return () => {
      cancelled = true;
    };
  }, [monthKey]);

  return monthKey && answer?.monthKey === monthKey ? answer.summary : null;
}
