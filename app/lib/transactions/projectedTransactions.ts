import type { Transaction } from '../../types';
import { parseLocalDate } from '../time/dateUtils';
import { daysApart, isSameCharge, SAME_CHARGE_DAY_TOLERANCE } from './duplicateCharge';
import { addMonths, normalizeRecurrence, occurrenceAfter } from './recurrence';

/**
 * Shape of the ids minted below: `projected-<source row id>-<YYYY-MM-DD>`.
 * Parsed in two places — the edit path and the delete path — so the pattern
 * lives next to the code that builds it rather than next to either reader.
 */
const PROJECTED_TRANSACTION_ID_REGEX = /^projected-(.+)-(\d{4}-\d{2}-\d{2})$/;

/** The real row a projected occurrence was generated from, or null. */
export function getSourceTransactionIdFromProjectedId(transactionId: string): string | null {
  const match = PROJECTED_TRANSACTION_ID_REGEX.exec(String(transactionId || ''));
  return match ? match[1] : null;
}

/** Source row id + occurrence date for a projected id, or null if not one. */
export function parseProjectedId(
  transactionId: string,
): { sourceId: string; date: string } | null {
  const match = PROJECTED_TRANSACTION_ID_REGEX.exec(String(transactionId || ''));
  return match ? { sourceId: match[1], date: match[2] } : null;
}

function toIsoDay(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  // Use local date components, NOT toISOString(). The UTC slice
  // can roll over to the wrong day for users in negative-offset
  // timezones (e.g. America/Chicago after ~6 PM local), which would
  // push projected transactions into the wrong month.
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getTransactionBudgetId(tx: Transaction): string | undefined {
  return tx.budget_id ?? (tx as any).category_id;
}

/**
 * Generate projected recurring transactions from existing transactions.
 *
 * Rules:
 * - Monthly, Biweekly and Yearly recurrences are projected.
 * - Occurrences on or before today are included as spent (`is_projected:
 *   false`), in whichever month they fell — this one or an earlier one.
 * - Future occurrences stay projected until their date arrives.
 * - Project up to 3 months ahead as a rolling horizon.
 * - Display-only (never written to DB).
 *
 * IMPORTANT: Only the EARLIEST transaction per (vendor, amount) group is
 * used as a projection source. The recurring executor spawns new real
 * transactions from each template (e.g. a Jul 13 Fizz spawns Aug 13, Sep 13,
 * ...). Without this filter, the projection function would generate
 * duplicate Sep 13 / Oct 13 / ... entries from both the original Jul 13
 * template AND the executor-spawned Aug 13 row, causing the dashboard
 * "red block" (remainingMoney went hugely negative because projectedCurrentMonth
 * was summed twice per template). See commit ed14cc3 for the bug history.
 *
 * Executor-spawned rows are also skipped explicitly as a belt-and-suspenders:
 * if a future change ever stores the original template under source='executor',
 * the projection would still be correctly attributed to the manual/notification
 * source rather than chained.
 */
export function generateProjectedTransactions(
  base: Transaction[],
  /** Today as YYYY-MM-DD, in the user's local calendar. Callers on the
   *  dashboard pass `useCurrentDay()` so a set generated before midnight is
   *  regenerated after it; omitting it reads the clock. */
  todayIso?: string,
): Transaction[] {
  const parsedToday = todayIso ? parseLocalDate(todayIso) : null;
  const today = parsedToday && !Number.isNaN(parsedToday.getTime()) ? parsedToday : new Date();
  today.setHours(0, 0, 0, 0);

  const horizon = addMonths(today, 3);

  // The saved rows an occurrence could turn out to be. Anything already
  // carrying a projected id is one of these, not a charge that happened.
  const realRows = base.filter(
    (tx) => !(tx.is_projected && String(tx.id || '').startsWith('projected-')),
  );
  // Indexed by day, so the pairing below only ever looks at the handful of rows
  // dated near an occurrence rather than at the whole ledger once per
  // occurrence — this runs on every dashboard render.
  const realRowsByDay = new Map<string, number[]>();
  realRows.forEach((row, index) => {
    const isoDate = toIsoDay(row.date);
    const bucket = realRowsByDay.get(isoDate);
    if (bucket) bucket.push(index);
    else realRowsByDay.set(isoDate, [index]);
  });

  // Find the earliest transaction per (vendor, amount, recurrence, day) group.
  // Only these are used as projection sources.
  //
  // Why include day-of-month in the key:
  //   The user has two Fizz charges per month ($26.20 on the 13th and the
  //   16th) — these are LEGITIMATE separate charges, not a single template
  //   that was duplicated. Grouping by day-of-month keeps them as separate
  //   projection sources so both get their own future series.
  //
  // Why include recurrence in the key:
  //   A Monthly $50 Netflix and a separate Biweekly $50 Netflix (e.g. monthly
  //   subscription + biweekly purchases) must also stay separate.
  //
  // Why a yearly charge keys on the month as well as the day:
  //   Two annual charges of the same amount at the same merchant, one in March
  //   and one in September, are two series a year apart — keyed on the day
  //   alone they would collapse into one and the second would stop being
  //   expected at all.
  //
  // Executor-spawned rows share the same (vendor, amount, recurrence, day)
  // as their template, so they're automatically collapsed into the same group.
  const earliestByKey = new Map<string, Transaction>();
  for (const tx of base) {
    if (tx.is_projected && String(tx.id || '').startsWith('projected-')) continue;
    // Skip executor-spawned rows — they're already handled by the original
    // template. Using them as a second source would double-project.
    if (tx.source === 'executor') continue;
    const recurrence = normalizeRecurrence(tx);
    if (recurrence === 'one-time') continue;
    const isoDay = toIsoDay(tx.date);
    const dayKey = recurrence === 'yearly' ? isoDay.slice(5, 10) : isoDay.slice(8, 10);
    const key = `${tx.vendor.toLowerCase().trim()}|${Number(tx.amount).toFixed(2)}|${recurrence}|${dayKey}`;
    const existing = earliestByKey.get(key);
    if (!existing) {
      earliestByKey.set(key, tx);
      continue;
    }
    const existingDate = parseLocalDate(toIsoDay(existing.date)).getTime();
    const candidateDate = parseLocalDate(toIsoDay(tx.date)).getTime();
    if (Number.isFinite(candidateDate) && candidateDate < existingDate) {
      earliestByKey.set(key, tx);
    }
  }

  // Every occurrence the schedules produce, before asking which of them have
  // already happened — that question is answered against all of them at once,
  // in the pairing below.
  const candidates: Array<{ source: Transaction; date: string; isFuture: boolean }> = [];

  for (const tx of earliestByKey.values()) {
    const recurrence = normalizeRecurrence(tx);
    if (recurrence === 'one-time') continue;

    // Build the initial date in the user's local timezone. `new Date("YYYY-MM-DD")`
    // parses as UTC midnight, which lands on the previous local day for users
    // in negative-offset timezones and shifts the projected day-of-month after
    // the first addMonths().
    const anchor = parseLocalDate(toIsoDay(tx.date));
    if (Number.isNaN(anchor.getTime())) continue;

    // Counted from the anchor, not chained — see occurrenceAfter for what
    // chaining did to a charge that falls on the 29th, 30th or 31st.
    for (let step = 1; ; step++) {
      const current = occurrenceAfter(anchor, recurrence, step);

      if (current > horizon) break;

      // Every occurrence, including the ones in months already over. Those
      // used to be dropped the moment their month ended: a subscription was
      // counted all through September and then vanished from September on the
      // 1st of October, so a browsed month's closing balance was too high by
      // every recurring charge that had fallen in it. An occurrence whose day
      // has come is spent money whichever month it is being read from.
      candidates.push({ source: tx, date: toIsoDay(current), isFuture: current > today });
    }
  }

  // ── Which occurrences already happened ──
  //
  // An occurrence is a guess that a charge is coming. Once that charge lands as
  // a real row, showing the guess beside it counts the money twice.
  //
  // The test used to be exact: same vendor spelling, same amount to the cent,
  // same day, same category. A real charge that missed on any one of those left
  // the guess standing next to it and the month was over by the whole amount —
  // which is how a monthly insurance premium came to sit on the dashboard
  // twice, once on its due date at $477.45 and once as the captured charge a
  // day later at $477.46. So an occurrence is now cancelled by a real row that
  // merely looks like the same charge: the merchant fuzzily, the amount near
  // enough, the date within a few days.
  //
  // Paired off one-to-one, closest first, because a real row may only cancel
  // ONE occurrence. The household has two Fizz charges a month three days
  // apart; without the pairing, whichever arrived first would cancel both and
  // the other charge would drop out of the month until it too was captured.
  const pairings: Array<{ candidate: number; row: number; gap: number }> = [];
  candidates.forEach((candidate, candidateIndex) => {
    const anchor = parseLocalDate(candidate.date);
    if (Number.isNaN(anchor.getTime())) return;
    const occurrence = {
      vendor: candidate.source.vendor,
      amount: candidate.source.amount,
      date: candidate.date,
    };
    for (let offset = -SAME_CHARGE_DAY_TOLERANCE; offset <= SAME_CHARGE_DAY_TOLERANCE; offset++) {
      const day = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + offset);
      for (const rowIndex of realRowsByDay.get(toIsoDay(day)) || []) {
        const row = realRows[rowIndex];
        const rowDate = toIsoDay(row.date);
        if (!isSameCharge(occurrence, { vendor: row.vendor, amount: row.amount, date: rowDate })) {
          continue;
        }
        pairings.push({
          candidate: candidateIndex,
          row: rowIndex,
          gap: daysApart(candidate.date, rowDate) ?? SAME_CHARGE_DAY_TOLERANCE,
        });
      }
    }
  });

  // Closest pair first, then the earliest occurrence, so the result does not
  // depend on the order the ledger happened to arrive in.
  pairings.sort(
    (a, b) =>
      a.gap - b.gap ||
      candidates[a.candidate].date.localeCompare(candidates[b.candidate].date) ||
      a.row - b.row,
  );
  const cancelled = new Set<number>();
  const claimedRows = new Set<number>();
  for (const pairing of pairings) {
    if (cancelled.has(pairing.candidate) || claimedRows.has(pairing.row)) continue;
    cancelled.add(pairing.candidate);
    claimedRows.add(pairing.row);
  }

  const projected: Transaction[] = [];
  candidates.forEach((candidate, index) => {
    if (cancelled.has(index)) return;
    projected.push({
      ...candidate.source,
      // A refund belongs to the one charge it matched, not to the series. An
      // occurrence copied from a refunded source would otherwise inherit the
      // flag and be counted as nothing — every future month of that
      // subscription silently free. Only written when there is something to
      // undo, so every other occurrence keeps exactly the shape it had.
      ...(candidate.source.refunded ? { refunded: false } : {}),
      budget_id: getTransactionBudgetId(candidate.source) ?? null,
      id: `projected-${candidate.source.id}-${candidate.date}`,
      date: candidate.date,
      is_projected: candidate.isFuture,
    });
  });

  return projected;
}
