// app/lib/transactions/recurringSchedule.ts
//
// "Is this charge one the app already knows is coming?"
//
// The capture pipeline could already recognise a subscription it had ALREADY
// RECORDED — a row sitting in the ledger within a few days of the capture. It
// could not recognise one it had merely SCHEDULED, and for a subscription that
// is the normal case: a monthly template's next occurrence does not exist as a
// row until its due date arrives (the executor only ever writes occurrences up
// to today, and the dashboard's future ones are display-only projections).
//
// So a Netflix charge announced by the bank on the 15th, with the monthly
// Netflix due on the 16th, matched nothing: the only real row was last month's,
// a month outside the pipeline's +/-3 day window. The charge was captured a
// second time, put in Review, and announced with a notification — for money the
// app was already expecting.
//
// This module walks a recurring row's schedule instead of looking only at where
// its row happens to sit, so "due tomorrow" counts as much as "recorded
// yesterday".
//
// Deliberately strict, because the consequence of a match is that a real bank
// charge is NOT written down:
//   - the amount must agree, near enough (see `amountsAgree`),
//   - the vendor must match fuzzily (the same test the rest of the pipeline
//     uses, so "Netflix.com" and "Netflix*" are one merchant),
//   - and an occurrence of the schedule must fall within a few days of the
//     capture.
// Two ordinary purchases at one merchant in the same week are real and must
// both survive; a subscription billing twice for the identical amount is not.

import { fuzzyVendorMatch } from '../vendors/formatVendorName';
import { occurrenceAfter } from './recurrence';
import { amountsAgree, daysApart, SAME_CHARGE_DAY_TOLERANCE } from './duplicateCharge';

/**
 * Ceiling on how many occurrences are stepped through before giving up.
 *
 * A runaway guard, not a horizon: the walk stops as soon as it passes the
 * target date, so a monthly template needs one step per month between it and
 * the capture. 600 covers a biweekly template left in the ledger for twenty
 * years (and a yearly one for six centuries), and stops a corrupt date from
 * spinning forever.
 */
const MAX_OCCURRENCE_STEPS = 600;

/** The subset of a transaction row this module needs. */
export interface RecurringChargeRow {
  id?: string;
  vendor?: string | null;
  amount?: number | string | null;
  date?: string | null;
  /** `Monthly` / `Biweekly` / `Yearly` / `One-time`, in whatever casing the DB holds. */
  recur?: string | null;
  source?: string | null;
}

/**
 * Is this row part of the recurring machinery?
 *
 * Either it carries a recurrence itself (a template, or an occurrence the
 * executor spawned from one), or it was written by the executor — which only
 * ever writes recurring occurrences, and whose rows are the ones a capture is
 * most likely to arrive on top of.
 */
export function isRecurringRow(row: RecurringChargeRow): boolean {
  const recur = String(row?.recur || '').trim().toLowerCase();
  if (recur === 'monthly' || recur === 'biweekly' || recur === 'yearly') return true;
  return String(row?.source || '').trim().toLowerCase() === 'executor';
}

function toIsoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseIsoDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  // Local midnight, so stepping a month never lands on the previous day the
  // way `new Date("YYYY-MM-DD")` (parsed as UTC) does west of Greenwich.
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Does any occurrence of the schedule that starts at `anchorDate` fall within
 * `dayTolerance` days of `targetDate`?
 *
 * The anchor itself counts as the first occurrence, so a one-time row is simply
 * "is this row dated near the target" — which is what the pipeline asked before
 * this module existed, and keeps this a strict superset of that behaviour.
 */
export function scheduleLandsNear(
  anchorDate: string | null | undefined,
  recurrence: string | null | undefined,
  targetDate: string | null | undefined,
  dayTolerance: number = SAME_CHARGE_DAY_TOLERANCE,
): boolean {
  const target = String(targetDate || '').slice(0, 10);
  if (!parseIsoDay(target)) return false;

  const anchorIso = String(anchorDate || '').slice(0, 10);
  const firstGap = daysApart(anchorIso, target);
  if (firstGap === null) return false;
  if (firstGap <= dayTolerance) return true;

  const rec = String(recurrence || '').trim().toLowerCase();
  if (rec !== 'monthly' && rec !== 'biweekly' && rec !== 'yearly') return false;

  // Only forward. A recurring row's date is where the series starts, so a
  // template dated after the capture has no earlier occurrences to offer —
  // and the anchor check above already covered "the template is right here".
  const anchor = parseIsoDay(anchorIso);
  if (!anchor) return false;

  for (let i = 1; i <= MAX_OCCURRENCE_STEPS; i++) {
    const current = occurrenceAfter(anchor, rec, i);
    const gap = daysApart(toIsoDay(current), target);
    if (gap === null) return false;
    if (gap <= dayTolerance) return true;
    // Past the target and still too far away — every later occurrence is
    // further still.
    if (toIsoDay(current) > target) return false;
  }
  return false;
}

/** The charge as the capture pipeline knows it, under every name it answers to. */
export interface CandidateCharge {
  /** Every name for the merchant: the polished one, the raw one, aliases. */
  vendors: (string | null | undefined)[];
  amount: number;
  /** `YYYY-MM-DD` — the day the capture is being filed under. */
  date: string;
}

/**
 * Whether a matched recurring row is close enough to be the occurrence this
 * capture confirms, rather than an older template found by walking its
 * schedule. Only nearby rows should receive the notification text; otherwise
 * a current alert would rewrite the history of a different month's charge.
 */
export function isRecordedOccurrenceNearCapture(
  rowDate: string | null | undefined,
  captureDate: string | null | undefined,
  dayTolerance: number = SAME_CHARGE_DAY_TOLERANCE,
): boolean {
  const gap = daysApart(String(rowDate || ''), String(captureDate || ''));
  return gap !== null && gap <= dayTolerance;
}

/**
 * The recurring row this capture is a second copy of, or null.
 *
 * `rows` may contain anything; non-recurring rows are ignored, so callers can
 * pass a window of the ledger without filtering it first.
 */
export function findRecurringScheduleMatch<T extends RecurringChargeRow>(
  candidate: CandidateCharge,
  rows: readonly T[],
  dayTolerance: number = SAME_CHARGE_DAY_TOLERANCE,
): T | null {
  if (!Number.isFinite(candidate?.amount)) return null;
  const names = (candidate.vendors || []).filter(
    (name): name is string => typeof name === 'string' && name.trim().length > 0,
  );
  if (names.length === 0) return null;

  for (const row of rows || []) {
    if (!isRecurringRow(row)) continue;

    const rowAmount = Number(row.amount);
    // Near enough, not to the cent — a premium that arrives a rounding cent
    // apart from the one on the books is the same charge. `amountsAgree` also
    // refuses a sign mismatch, so a refund never matches the charge it undoes.
    if (!amountsAgree(rowAmount, candidate.amount)) continue;

    if (!names.some((name) => fuzzyVendorMatch(name, String(row.vendor || '')))) continue;

    if (!scheduleLandsNear(row.date, row.recur, candidate.date, dayTolerance)) continue;

    return row;
  }
  return null;
}

/**
 * The vendor/amount pairs the native listener needs to stay quiet about.
 *
 * The listener posts "$X at Y — captured" the instant a bank alert lands,
 * before any of the logic above has run, because with the app closed it is the
 * only part of Covault alive. Handing it this list is what lets it decline to
 * announce a subscription the user already has on the books. It is only ever
 * used to skip a notification — the alert is still captured and the pipeline
 * above remains the authority on what reaches the ledger — so a name in here
 * can cost a notice, never a purchase.
 *
 * De-duplicated on vendor+amount: a monthly template and the occurrences the
 * executor spawned from it are the same subscription many times over.
 *
 * Yearly charges are deliberately LEFT OUT. The native matcher knows nothing
 * about dates — vendor and amount are all it compares — which is honest for a
 * cadence that bills every month or every fortnight, where a charge matching
 * both is almost always the subscription itself. Applied to an annual charge it
 * would silence a matching purchase at that merchant on any of the other 364
 * days of the year, and a silenced capture also writes no widget delta. The
 * annual occurrence is still recognised in the app, by the date-aware walk
 * above; the only thing given up here is going quiet about it while the app is
 * closed, once a year.
 */
export function collectRecurringCharges(
  rows: readonly RecurringChargeRow[],
): Array<{ vendor: string; amount: number }> {
  const seen = new Set<string>();
  const out: Array<{ vendor: string; amount: number }> = [];
  for (const row of rows || []) {
    if (!isRecurringRow(row)) continue;
    if (String(row.recur || '').trim().toLowerCase() === 'yearly') continue;
    const vendor = String(row.vendor || '').trim();
    const amount = Number(row.amount);
    if (!vendor || !Number.isFinite(amount) || amount <= 0) continue;
    const key = `${vendor.toLowerCase()}|${amount.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ vendor, amount });
  }
  return out;
}
