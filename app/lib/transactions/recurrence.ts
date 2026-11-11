// app/lib/transactions/recurrence.ts
//
// Shared recurrence primitives. The display-only projection
// (projectedTransactions.ts) is the only consumer that generates occurrences;
// recurringSchedule.ts uses them to recognise a captured charge as one.
// Nothing writes recurring rows to the database — see the note in App.tsx.

import type { Transaction } from '../../types';

export type Recurrence = 'yearly' | 'monthly' | 'biweekly' | 'one-time';

/** Map a transaction's `recur`/`recurrence` field to a canonical value. */
export function normalizeRecurrence(tx: Transaction): Recurrence {
  const raw = ((tx as any).recur ?? tx.recurrence ?? '').toString().trim().toLowerCase();
  if (raw === 'monthly') return 'monthly';
  if (raw === 'biweekly') return 'biweekly';
  if (raw === 'yearly') return 'yearly';
  return 'one-time';
}

/** Add `months` calendar months to a Date. Returns a NEW Date. */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/**
 * The date `steps` intervals after `anchor`: biweekly = 14 days each, yearly =
 * 12 calendar months each, anything else (monthly) = 1 calendar month each.
 * Returns a NEW Date — the input is not mutated. Accepts a raw or normalized
 * recurrence string.
 *
 * Always counted from the ANCHOR, never from the previous occurrence, and held
 * to the last day of a month too short for the anchor's day. Chaining one step
 * onto the last used to let the calendar overflow carry: rent entered on
 * Jan 31 stepped to "Feb 31", which JavaScript reads as Mar 3 — so February
 * had no rent in it at all, and every month after expected it on the 3rd,
 * four weeks away from the real charge on the 31st. That is far outside the
 * few days within which a real charge cancels its expected one, so from March
 * on the dashboard counted the rent twice. Counting from the anchor gives
 * Jan 31, Feb 28, Mar 31, Apr 30: the day the charge actually lands.
 */
export function occurrenceAfter(anchor: Date, recurrence: string, steps: number): Date {
  const cadence = recurrence.toLowerCase();
  if (cadence === 'biweekly') {
    const next = new Date(anchor);
    next.setDate(next.getDate() + 14 * steps);
    return next;
  }
  const months = cadence === 'yearly' ? 12 * steps : steps;
  const firstOfTarget = new Date(anchor.getFullYear(), anchor.getMonth() + months, 1);
  const daysInTarget = new Date(
    firstOfTarget.getFullYear(),
    firstOfTarget.getMonth() + 1,
    0,
  ).getDate();
  const next = new Date(anchor);
  // Day first set to 1 so moving the month can never overflow on the way.
  next.setDate(1);
  next.setFullYear(firstOfTarget.getFullYear(), firstOfTarget.getMonth(), 1);
  next.setDate(Math.min(anchor.getDate(), daysInTarget));
  return next;
}
