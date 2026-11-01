// app/lib/capture/notificationProcessor.ts
//
// Notification processing pipeline with AI-based extraction.
//
// Pipeline:
//   1. In-memory dedup (fast, prevents re-processing during scans)
//   2. Duplicate detection (against the transactions table)
//   3. AI extraction: vendor, amount, transaction classification
//   4. Non-transaction filtering (balance alerts, OTPs, etc.)
//   5. Duplicate detection (same vendor + amount pair)
//   6. Category assignment: vendor_overrides first, then AI guess
//   7. Insert into transactions table with 'AI' label

import { log } from '../observability/log';
import { djb2Base36 } from '../transactions/hash';
import { supabase } from '../api/supabase';
import { formatVendorName, fuzzyVendorMatch, normalizeVendorForDedup } from '../vendors/formatVendorName';
import {
  findUnpairedBankCaptureForEmail,
  findEmailCaptureForBank,
  findNotificationDuplicate,
  decideConcurrentCapture,
  NOTIFICATION_AMOUNT_TOLERANCE,
} from './notificationDuplicates';
import { parseNotificationText } from './deviceTransactionParser';
import {
  addToReviewQueue,
  getVendorMap,
  isNotificationProcessed,
  markNotificationProcessed,
  isNotificationRejected,
  markNotificationRejected,
  getCachedAIResult,
  setCachedAIResult,
  type CachedAIResult,
} from './localNotificationMemory';
import { createNotificationMarkers } from './notificationMarkers';
import { findMatchingExpense, REFUND_MATCH_WINDOW_DAYS } from '../transactions/refundMatching';
import { rememberHold, settleHold } from './pendingHold';
import { aiFindRefundMatch, aiLooksLikeIgnoredAlert } from '../ai/aiExtractor';
import type { LearnedVendorExample } from '../ai/aiExtractor';
import { checkNotificationRules, bumpRuleUseCount, listIgnoredPatterns } from './notificationRules';
import { candidatePatternsFor } from './notificationShape';
import { getLocalToday, parseLocalDate, toLocalIsoDay } from '../time/dateUtils';
import { extractWithAI, type AIExtractionResult } from '../ai/aiExtractor';
import { canAutoAcceptCapture } from './notificationAutoAccept';
import { insertNotificationTransaction } from './notificationPersistence';
import { lookupCommunityRule } from '../vendors/communityRules';
import type { Transaction } from '../../types';
import { amountsAgree } from '../transactions/duplicateCharge';
import {
  findRecurringScheduleMatch,
  isRecordedOccurrenceNearCapture,
  type RecurringChargeRow,
} from '../transactions/recurringSchedule';
import {
  allowedSourceKind,
  isCaptureSourceAllowed,
  type CaptureSourceKind,
} from './captureSources';
import { parseEmailAlert } from './emailNotification';
import {
  isOtherAppSameTap,
  withCaptureMarker,
  withEmailPairedMarker,
} from './captureChannel';
import { detectFuelHold, isFuelMerchant, isHoldAmount, pastFillAmounts, withFuelHoldMarker } from './fuelHold';
import { withCaptureNotificationMarker } from './captureNotificationMarker';
import {
  assignCaptureCategory,
  MAX_FREQUENCY_ROWS,
  type VendorRuleRow,
} from './notificationCategoryAssignment';

/**
 * Add the notif-id marker only when there is an id to add.
 *
 * Absent whenever the listener declined to post a notification at all — a
 * skip rule, a known recurring charge, an APK built before the native side
 * sent this — in which case there is nothing for a later "clear it" to find,
 * and the row is left exactly as every insert before this feature wrote it.
 */
function withNotificationIdIfKnown(rawText: string, captureNotificationId: number | undefined): string {
  if (captureNotificationId === undefined || !Number.isFinite(captureNotificationId)) return rawText;
  return withCaptureNotificationMarker(rawText, captureNotificationId);
}

// ─── Constants ───────────────────────────────────────────────────

/** Tolerance for comparing monetary amounts */
const AMOUNT_TOLERANCE = NOTIFICATION_AMOUNT_TOLERANCE;

/**
 * The local calendar day a purchase belongs to: the day its notification was
 * posted. A missing, invalid or future timestamp (a skewed clock, an older APK
 * that sent none) falls back to today, because a purchase cannot have happened
 * after it was processed.
 */
export function captureDayOf(notificationTimestamp: number | undefined, nowMs: number = Date.now()): string {
  if (
    typeof notificationTimestamp !== 'number'
    || !Number.isFinite(notificationTimestamp)
    || notificationTimestamp <= 0
    || notificationTimestamp > nowMs
  ) {
    return toLocalIsoDay(new Date(nowMs));
  }
  return toLocalIsoDay(new Date(notificationTimestamp));
}

/** Number of days tolerance for recurring transaction date matching */
const RECURRING_DATE_TOLERANCE_DAYS = 3;

/**
 * Ceiling on the learned vendor rules loaded when categorising a capture.
 *
 * Not a page size — every rule has to be considered or a rule the user wrote
 * silently stops applying. This is a runaway guard, set far above any real
 * household's rule count, so a corrupt table can't turn one capture into a
 * multi-megabyte download.
 */
const MAX_VENDOR_RULES = 2000;

/**
 * Ceiling on the recurring rows loaded when checking whether a capture is a
 * subscription the app already knows about.
 *
 * A runaway guard like MAX_VENDOR_RULES, not a page size. A household has a
 * handful of subscriptions, plus one executor-spawned row per month per
 * subscription — a few hundred rows after years of use. Newest first, so if
 * this ever truncates it drops the oldest history rather than the templates
 * still in force.
 */
const MAX_RECURRING_ROWS = 500;

/**
 * Below this confidence, the regex parser is considered a guess and the
 * pipeline falls back to the on-device AI model (extractWithAI). The AI
 * model is slower to load but produces better extractions on ambiguous
 * notifications. Above this threshold we trust the regex to keep things
 * fast for the common case.
 */
const AI_FALLBACK_CONFIDENCE_THRESHOLD = 0.65;

/**
 * Below this AI confidence, the capture still goes into the ledger but must
 * never be filed without the user seeing it.
 *
 * The row lands in Review like any other capture — that list exists precisely
 * for the ones the app is unsure about, and the review card renders the stored
 * confidence as a meter. What the threshold blocks is auto-accept: a learned
 * rule that says "Tim Hortons → Coffee" is no reason to file a charge whose
 * merchant name the model only half-read.
 */
const LOW_CONFIDENCE_REVIEW_THRESHOLD = 0.75;

/** Milliseconds per day */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * In-memory cache of recently processed notification keys.
 * Prevents the same notification from being processed multiple times
 * during a scan or when the same notification is re-broadcast.
 * Key: `${bankAppId}|h${djb2(rawNotification)}` — see `buildInMemoryDedupKey`.
 * Value: timestamp when the key was added (for cache expiry)
 */
const recentlyProcessedCache = new Map<string, number>();
const notificationMarkers = createNotificationMarkers(recentlyProcessedCache, {
  isProcessed: isNotificationProcessed,
  markProcessed: markNotificationProcessed,
  isRejected: isNotificationRejected,
  markRejected: markNotificationRejected,
  addToReviewQueue,
});

/**
 * Set of notification keys that are CURRENTLY being processed.
 *
 * This is the defense against the double-capture race: when a scan fires
 * the same notification twice in rapid succession (which happens at app
 * start because BOTH the native NotificationListener.onListenerConnected
 * and the JS useEffect's refreshMonitoredAppsAndScan trigger a scan),
 * both invocations reach processNotificationWithAI before the first one
 * finishes the async insert and marks recentlyProcessedCache.
 *
 * The in-flight set is claimed at the very top of processing (before any
 * await) and released in a finally block. This serializes concurrent
 * duplicates: the second caller sees the key in the set, returns the
 * "duplicate" skip, and the first caller continues to insert.
 */
const inFlightProcessingKeys = new Set<string>();

/**
 * In-flight claims on a PURCHASE, as opposed to a notification.
 *
 * inFlightProcessingKeys is keyed on bankAppId + raw text, so two apps
 * announcing the SAME purchase (the bank app and Google Wallet) never collide
 * there and can both reach the insert concurrently. Step 4's pre-insert DB
 * check does not help either: neither row exists yet when the other queries,
 * and the Step 6b race check has the same blind spot for the same reason.
 * Result: two identical rows, same vendor, same amount, same day.
 *
 * Claiming the purchase itself closes that window. Entries carry a timestamp
 * and expire, so a path that returns without releasing cannot wedge capture
 * for that purchase permanently.
 */
const inFlightPurchaseKeys = new Map<string, number>();
const PURCHASE_CLAIM_TTL_MS = 60_000;

function claimPurchase(key: string): boolean {
  const now = Date.now();
  for (const [k, at] of inFlightPurchaseKeys) {
    if (now - at > PURCHASE_CLAIM_TTL_MS) inFlightPurchaseKeys.delete(k);
  }
  if (inFlightPurchaseKeys.has(key)) return false;
  inFlightPurchaseKeys.set(key, now);
  return true;
}

function releasePurchase(key: string): void {
  inFlightPurchaseKeys.delete(key);
}

/**
 * How long to keep entries in the in-memory dedup cache (ms).
 * 2 hours balances preventing duplicate processing during rescans
 * while allowing legitimate repeat purchases (e.g., two coffees
 * from the same vendor on the same day). The DB-based dedup in
 * checkAlreadyProcessed() provides a separate, persistent layer.
 */
const DEDUP_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Build an in-memory dedup key from the raw notification fields.
 *
 * Key format: `bankAppId|<hash of raw text>`.
 *
 * Intentionally CONTENT-ONLY — no `notificationTimestamp`. The original
 * design included the timestamp because Android's `sbn.getPostTime()` is
 * supposed to be stable across re-broadcasts, but in practice the JS-side
 * `event.timestamp` can vary when:
 *   - The native broadcast doesn't include a timestamp and the plugin
 *     falls back to `System.currentTimeMillis()` (see
 *     native/android/CovaultNotificationPlugin.java).
 *   - The notification is re-fired by a `scanActiveNotifications()` call
 *     with a different JSON payload shape.
 *   - Two notification events for the same charge arrive within the
 *     same second but with sub-second clock differences.
 * Any of these would make the two invocations get different dedup keys
 * and BOTH proceed to insert — which is exactly the double-capture bug
 * the in-flight check was supposed to prevent.
 *
 * Same notification text from the same bank → same key, regardless of
 * how many times it's re-broadcast. Two different transactions that
 * happen to share the same amount (e.g. "Hyundai $458.69" and
 * "Costco $458.69") get distinct keys because their raw text differs
 * and the hash captures that.
 *
 * Hash is djb2 — matches the one `extractVendorSlug` uses as its
 * fallback so we don't pull in a new dependency just for this.
 */
/**
 * Key for the PERSISTENT captured store.
 *
 * The in-memory key above is content-only, which is right for collapsing
 * re-broadcasts of one notification but wrong for a permanent record: two
 * genuinely separate purchases at the same vendor for the same amount produce
 * byte-identical text, so the second was silently dropped forever. A daily
 * coffee at the same price simply stopped being captured.
 *
 * Appending the notification's own local day fixes that, but ONLY when a real
 * post time is available. `sbn.getPostTime()` is stable across rescans, so the
 * key is stable; when the field is missing the caller falls back to Date.now(),
 * which would change across midnight and could re-capture something already in
 * the ledger. In that case we keep the content-only key, which can over-dedup
 * but can never double-insert.
 *
 * Same-day repeats still collapse here — Step 4's same-day/same-amount hard
 * skip is the intended guard for those.
 */
/**
 * The user's confirmed vendor -> category decisions, most recent first.
 *
 * Sourced from the local vendor map, which is written every time a capture is
 * accepted, recategorized or renamed — i.e. every time the user corrects or
 * confirms the pipeline. Recency ordering matters: a changed mind should
 * outweigh an old habit.
 */
function collectLearnedExamples(): LearnedVendorExample[] {
  try {
    return Object.values(getVendorMap())
      .filter((e) => e?.vendor_display && e?.budget)
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .map((e) => ({ vendor: e.vendor_display, category: e.budget }));
  } catch {
    return [];
  }
}

export function buildCapturedKey(
  bankAppId: string,
  rawNotification: string,
  postTimeMs?: number,
): string {
  const base = buildInMemoryDedupKey(bankAppId, rawNotification);
  if (!postTimeMs || !Number.isFinite(postTimeMs) || postTimeMs <= 0) return base;
  return `${base}|${toLocalIsoDay(new Date(postTimeMs))}`;
}

export function buildInMemoryDedupKey(
  bankAppId: string,
  rawNotification: string,
): string {
  // The bankAppId prefix prevents the same text from different banks from
  // being conflated (rare, but possible if a user has two banking apps that
  // both notify on the same transaction).
  return `${bankAppId || '?'}|h${djb2Base36(rawNotification)}`;
}

/**
 * Evict expired entries from the in-memory dedup cache.
 */
function evictExpiredCacheEntries(): void {
  const now = Date.now();
  for (const [key, addedAt] of recentlyProcessedCache) {
    if (now - addedAt > DEDUP_CACHE_TTL_MS) {
      recentlyProcessedCache.delete(key);
    }
  }
}

/** Exposed for testing: clear the in-memory dedup cache */
export function _clearDedupCacheForTesting(): void {
  recentlyProcessedCache.clear();
}

// ─── Types ───────────────────────────────────────────────────────

export interface NotificationInput {
  rawNotification: string;
  bankAppId: string;
  bankName: string;
  notificationTitle?: string;
  notificationTimestamp?: number;
  /** Fallback vendor from native plugin (used if AI fails) */
  fallbackVendor?: string;
  /** Fallback amount from native plugin (used if AI fails) */
  fallbackAmount?: number;
  /** True when user manually triggered a refresh scan of active notifications */
  forceReprocess?: boolean;
  /**
   * Opt-in: file a capture straight into its budget, skipping review, when a
   * learned vendor rule explains the incoming name well enough
   * (AUTO_ACCEPT_MIN_CONFIDENCE in app/lib/vendors/vendorMatchConfidence.ts).
   *
   * Only rules the user wrote can trigger this — see the auto-accept block in
   * Step 6. Defaults to off, and any missing information means review.
   */
  autoAcceptKnownVendors?: boolean;
  /**
   * Which route the alert arrived by. Absent means 'bank', which is what every
   * capture was before mail was a source — and the safe reading, because the
   * email rules only ever add restrictions.
   */
  channel?: CaptureSourceKind;
  /**
   * Notification body, kept apart from the title.
   *
   * For a mail app the title is the SENDER and the body is subject-plus-snippet.
   * The two have to arrive separately: the sender must be vetted before the body
   * is read at all, and a concatenated string cannot be split back apart.
   */
  notificationBody?: string;
  /**
   * Android id of the "$X at Y — captured" notification the native listener
   * posted for this alert, if one was posted.
   *
   * Carried through to the insert in Step 6 and written onto the row as a
   * marker (see app/lib/capture/captureNotificationMarker.ts), so the notification can be
   * found and cleared later — when the user accepts, edits, or deletes the
   * row from inside the app — without anything having to remember it in the
   * meantime. Absent when the listener declined to post at all (a skip rule,
   * a known recurring charge) or on an APK built before the native side sent
   * it, in which case the row simply carries no marker and there is nothing
   * later to clear.
   */
  captureNotificationId?: number;
  /**
   * Budget ids the user has switched OFF, which the offline merchant-signal
   * guess in Step 5c must not aim at.
   *
   * A hidden category is not drawn on the dashboard and is left out of the
   * allocation total, so filing a purchase into one puts it somewhere the
   * user cannot see it — worse than Other, because Other is at least on
   * screen. This list is what makes "I don't use that category" mean
   * "stop guessing at it".
   *
   * Deliberately applied to the GUESS only. A rule the user taught themselves
   * still fires even if they later hid its category: that is their own
   * instruction, and it outranks the app's inference. Nothing already filed
   * is ever moved.
   */
  hiddenCategoryIds?: string[];
}

// ─── Step 1: Duplicate Detection Against Tables ─────────────────


/**
 * Check if a notification has already been processed by looking at
 * the transactions table directly.
 *
 * A notification is considered a duplicate if a record with the same
 * vendor + amount exists within a ±1 minute window of the notification
 * timestamp.
 *
 * This replaces the old fingerprint-table approach, which required a
 * separate Supabase table and could silently drop notifications when
 * that table had issues.
 */
async function checkAlreadyProcessed(
  userId: string,
  amount: number | null,
  vendor: string | null,
  notificationTimestamp: number,
): Promise<boolean> {
  if (amount == null || vendor == null) return false;

  const normalizedVendor = normalizeVendorForDedup(vendor);

  // ── Check transactions table ──
  // Query by `date` using a ±3 day window so that recurring transactions
  // or slightly delayed notifications are caught across all budgets.
  //
  // Centred on the notification's own timestamp, not on today. Those are the
  // same thing for a notification arriving now, and different for the case
  // this exists to catch — a rescan of the shade picking up something from
  // several days ago, where a window around today can sit entirely past the
  // charge it should have matched.
  const anchor = notificationTimestamp > 0
    ? new Date(notificationTimestamp)
    : parseLocalDate(getLocalToday());
  const todayDate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const windowStartDate = new Date(todayDate.getTime() - RECURRING_DATE_TOLERANCE_DAYS * MS_PER_DAY);
  const windowEndDate = new Date(todayDate.getTime() + RECURRING_DATE_TOLERANCE_DAYS * MS_PER_DAY);
  // Local calendar days, like the anchor they are built from. The UTC slice
  // read a local midnight east of Greenwich as the day before.
  const startDateStr = toLocalIsoDay(windowStartDate);
  const endDateStr = toLocalIsoDay(windowEndDate);

  // One read, against the ledger.
  //
  // There used to be a second, against `pending_transactions` — a table that
  // does not exist. It was moved alongside this one rather than after it,
  // because a capture arriving with the app closed was waiting out its 404
  // before it could appear. It is gone now, which is the same saving without
  // the request: a table that is not there can hold no duplicate.
  const { data: txRows } = await supabase
    .from('transactions')
    .select('id, vendor, amount, date')
    .eq('user_id', userId)
    .gte('date', startDateStr)
    .lte('date', endDateStr);

  if (txRows && txRows.length > 0) {
    for (const tx of txRows) {
      if (Math.abs(Number(tx.amount) - amount) < AMOUNT_TOLERANCE) {
        const exactMatch = normalizeVendorForDedup(tx.vendor) === normalizedVendor;
        const fuzzyMatch = fuzzyVendorMatch(tx.vendor, vendor);
        if (exactMatch || fuzzyMatch) {
          log.debug(`[dedup] Duplicate found in transactions: ${tx.vendor} $${tx.amount} (fuzzy=${fuzzyMatch})`);
          return true;
        }
      }
    }
  }

  return false;
}

// Re-exported from formatVendorName.ts so existing call sites keep working.
// The canonical definition strips parenthetical suffixes like "(Tx. Incl.)"
// and trailing location codes, which the old version did not.
export { normalizeVendorForDedup } from '../vendors/formatVendorName';

/**
 * Check whether two vendor names match.
 * Returns true if:
 *   - They are an exact case-insensitive match, OR
 *   - One vendor name contains a significant word (3+ chars) from the other
 */
export function vendorMatches(existingVendor: string | null, newVendor: string | null): boolean {
  if (existingVendor == null || newVendor == null) return existingVendor == null && newVendor == null;

  const a = existingVendor.toLowerCase().trim();
  const b = newVendor.toLowerCase().trim();

  if (a === b) return true;
  if (!a || !b) return false;

  // Check if any significant word from one appears in the other
  const wordsA = a.split(/\s+/).filter(w => w.length >= 3);
  for (const word of wordsA) {
    if (b.includes(word)) return true;
  }
  const wordsB = b.split(/\s+/).filter(w => w.length >= 3);
  for (const word of wordsB) {
    if (a.includes(word)) return true;
  }

  return false;
}

// ─── Step 1b: (removed) pending-queue deduplication ─────────────
//
// This read the `pending_transactions` table, which does not exist. The read
// could never return a row, so the queue was permanently empty and everything
// built on it — the second-phase dedup that lived here, and the approve /
// reject / clear-filtered handlers — was unreachable rather than merely
// failing. The dedup that actually runs is steps 1, 2, 5 and the post-insert
// race recovery below, against `transactions`.




/**
 * The user's past settled fills at a station, for sizing a hold placeholder.
 *
 * Best-effort by design: if this query fails or returns nothing the caller
 * falls back to the flat $100 default, so a slow or unavailable database costs
 * accuracy on one row rather than blocking the capture.
 */
async function fetchPriorFuelFills(userId: string, vendor: string): Promise<number[]> {
  try {
    const { data } = await supabase
      .from('transactions')
      .select('id, vendor, amount, date, raw_notification, is_projected')
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .limit(200);
    if (!data || data.length === 0) return [];
    return pastFillAmounts(vendor, data as unknown as Transaction[]);
  } catch (e) {
    log.debug('[AI pipeline] Could not load fill history for placeholder sizing:', e);
    return [];
  }
}

/**
 * The user's recurring templates, with no date window on them.
 *
 * Every other lookup in this file is windowed to +/-3 days, which is right for
 * "have we already written this charge down" and wrong for "is this charge one
 * we are expecting". A monthly subscription's only real row can be a month old
 * — its next occurrence is not written until its due date arrives — so a window
 * around today cannot see the schedule it belongs to.
 *
 * Cached for a few seconds, for the same reason the notification rules are: a
 * `scanActiveNotifications()` burst runs every banking notification in the shade
 * back-to-back, and without this that is one identical query per notification.
 * Short enough that a subscription the user added a moment ago is recognised on
 * the next capture rather than the next launch.
 *
 * Best-effort: a failure here means the charge is captured as an ordinary one,
 * which is the recoverable direction. A duplicate row the user can delete beats
 * a purchase that was silently dropped because a query timed out.
 */
const RECURRING_CACHE_TTL_MS = 30_000;
let recurringCache: { userId: string; rows: RecurringChargeRow[]; at: number } | null = null;

/** Exposed for testing: forget the cached recurring templates. */
export function _clearRecurringCacheForTesting(): void {
  recurringCache = null;
}

async function fetchRecurringCharges(userId: string): Promise<RecurringChargeRow[]> {
  const now = Date.now();
  if (recurringCache && recurringCache.userId === userId && now - recurringCache.at < RECURRING_CACHE_TTL_MS) {
    return recurringCache.rows;
  }
  try {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, vendor, amount, date, recur, source')
      .eq('user_id', userId)
      // The recurring labels the enum actually has, and no lowercase "just in
      // case" spellings. `recur` is a Postgres enum: a value outside its labels
      // does not match nothing, it fails the query — so asking for 'monthly' as
      // well returned a 400 every time and this check, which is what stops a
      // subscription being captured and announced a second time, has never
      // seen a single row. 'Yearly' is only safe here because the enum was
      // given that label first (2026_add_yearly_recurrence.sql).
      .in('recur', ['Monthly', 'Biweekly', 'Yearly'])
      .order('date', { ascending: false })
      .limit(MAX_RECURRING_ROWS);
    if (error) {
      log.warn('[AI pipeline] Could not load recurring charges:', error);
      return [];
    }
    const rows = (data || []) as RecurringChargeRow[];
    // Only a successful read is cached. Caching a failure would mean one bad
    // query silenced the check for the whole burst that follows it.
    recurringCache = { userId, rows, at: now };
    return rows;
  } catch (e) {
    log.warn('[AI pipeline] Could not load recurring charges:', e);
    return [];
  }
}

/**
 * The partner's rules — the household layer of the category lookup.
 *
 * Read only when the user's own rules have nothing to say about a merchant, and
 * used ONLY to suggest: a partner match leaves `overrideMatchConfidence` at 0,
 * so it can never clear the auto-accept threshold and file money the user has
 * not seen. Accepting the suggestion once in Review copies the rule into their
 * own list, and from then on it is theirs and behaves like any other.
 *
 * Two reads rather than one because the partner id lives on the settings row.
 * Both are cached together for a few minutes, for the same reason the recurring
 * templates are: a shade rescan runs every banking notification back to back,
 * and this would otherwise be two identical queries per notification.
 *
 * Degrades to nothing at all. On a project where the partner-visible policy has
 * not been applied the read simply returns no rows, which is exactly the
 * behaviour the app had before this layer existed.
 */
const PARTNER_RULES_CACHE_TTL_MS = 5 * 60_000;
let partnerRulesCache: { userId: string; rows: VendorRuleRow[]; at: number } | null = null;

/** Exposed for testing: forget the cached partner rules. */
export function _clearPartnerRulesCacheForTesting(): void {
  partnerRulesCache = null;
}

async function fetchPartnerRules(userId: string): Promise<VendorRuleRow[]> {
  const now = Date.now();
  if (partnerRulesCache && partnerRulesCache.userId === userId && now - partnerRulesCache.at < PARTNER_RULES_CACHE_TTL_MS) {
    return partnerRulesCache.rows;
  }
  try {
    const { data: settingsRows } = await supabase
      .from('settings')
      .select('partner_id')
      .eq('user_id', userId)
      .limit(1);
    const partnerId = (settingsRows || [])[0]?.partner_id as string | undefined;
    if (!partnerId || partnerId === userId) {
      partnerRulesCache = { userId, rows: [], at: now };
      return [];
    }

    const { data, error } = await supabase
      .from('overrides')
      .select('category_id, proper_name, match_key, match_type, updated_at')
      .eq('user_id', partnerId)
      .not('match_key', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(MAX_VENDOR_RULES);
    if (error) {
      log.warn('[AI pipeline] Could not load the partner rules:', error);
      return [];
    }
    const rows = (data || []) as VendorRuleRow[];
    // Only a successful read is cached, so one bad query cannot silence the
    // household layer for the whole burst that follows it.
    partnerRulesCache = { userId, rows, at: now };
    return rows;
  } catch (e) {
    log.warn('[AI pipeline] Could not load the partner rules:', e);
    return [];
  }
}

// ─── AI Processing Pipeline ─────────────────────────────────────

export interface AIProcessingResult {
  /** Whether the notification was processed */
  processed: boolean;
  /** Whether the AI determined this is a real transaction */
  isTransaction: boolean;
  /** The transaction ID if inserted into the transactions table */
  transactionId?: string;
  /** The vendor name extracted by AI */
  vendor?: string;
  /** The amount extracted by AI */
  amount?: number;
  /** The category ID assigned */
  categoryId?: string;
  /** The category name assigned */
  categoryName?: string;
  /**
   * True when a learned rule matched well enough that the row was filed
   * without review. The listener uses this to word the capture notification
   * differently — a transaction the user will never be shown should at least
   * say where it went.
   */
  autoAccepted?: boolean;
  /** Reason for rejection if not a transaction or duplicate */
  rejectionReason?: string;
  /** Skip reason */
  skipReason?: 'duplicate_fingerprint' | 'duplicate_vendor_amount' | 'duplicate_manual' | 'duplicate_ai' | 'duplicate_recurring' | 'not_transaction' | 'extraction_failed' | 'needs_review' | 'not_bank_app';
  /**
   * Set when the capture was a fuel pre-authorisation. The stored amount is a
   * placeholder, not what was pumped; `holdAmount` is the round figure the bank
   * announced. The UI asks the user for the real number.
   */
  fuelHold?: { holdAmount: number; placeholderAmount: number; basis: 'median-fill' | 'default' };
  /** The bank name */
  bankName?: string;
  /**
   * If the new transaction looks like a soft duplicate (same vendor after
   * normalization, but a different amount) the system still inserts it so
   * the user never misses a charge, and surfaces this warning instead.
   * The UI should show a "possible duplicate" badge.
   */
  softDuplicateOf?: {
    id: string;
    vendor: string;
    amount: number;
    date: string;
  };
  /**
   * If the notification was a refund and matched an existing expense, this
   * is the matched expense. The original row is marked refunded=true and
   * NO new transaction is inserted. The UI can show a success toast
   * "refund matched: <vendor> $<amount>".
   */
  refundMatched?: {
    id: string;
    vendor: string;
    amount: number;
    date: string;
  };
}

/**
 * Process a notification using the on-device parsing pipeline.
 *
 * Steps:
 *   1. In-memory dedup (fast, prevents re-processing during scans)
 *   2. Duplicate detection (check transactions + pending_transactions tables)
 *   3. Deterministic extraction (vendor, amount, transaction classification)
 *   4. Non-transaction filtering
 *   5. Duplicate detection (same vendor + amount pair in existing transactions)
 *   6. Category assignment from device-side vendor map (fallback: Other)
 *   7. Insert directly into transactions table with 'AI' label and mark for review
 */
export async function processNotificationWithAI(
  userId: string,
  input: NotificationInput,
  availableCategories: { id: string; name: string }[],
): Promise<AIProcessingResult> {
  // Normalize bank identifiers
  input = {
    ...input,
    bankAppId: (input.bankAppId || '').toLowerCase(),
    bankName: (input.bankName || '').toLowerCase(),
  };

  // ── Step 0: Sources the user picked, only ──
  // The last line of defence for "a transaction comes from an app the user
  // chose". The native listener drops everything else first and the hook drops
  // it again, but this is the one place EVERY path into the ledger passes
  // through, so it is the one that has to be right. Cheap: a set lookup on a
  // string already in hand.
  if (!isCaptureSourceAllowed(input.bankAppId)) {
    log.debug(`[AI pipeline] Ignoring notification from an app that is not a capture source: ${input.bankAppId || '(none)'}`);
    return {
      processed: false,
      isTransaction: false,
      skipReason: 'not_bank_app',
      rejectionReason: 'Notification did not come from a selected capture source',
      bankName: input.bankName,
    };
  }

  // ── Step 0a: Mail has to be from a bank ──
  //
  // The single rule that makes reading mail safe. A bank app essentially never
  // says anything but "you were charged"; an inbox is full of receipts, order
  // confirmations, invoices and newsletters that carry dollar amounts and would
  // otherwise all read as purchases.
  //
  // The sender is vetted first, and only then is a SHORT reconstructed
  // subject-and-snippet handed to the ordinary parser — which is not modified by
  // any of this, so every existing protection (deposits, declined cards,
  // statement notices, balance alerts) applies to mail unchanged, and no
  // bank-app capture behaves differently than it did.
  //
  // The channel is decided here rather than taken from the phone: an older APK
  // sends no channel at all, and a build that did could be wrong about an app
  // the user has since re-classified.
  const channel: CaptureSourceKind = allowedSourceKind(input.bankAppId) ?? 'bank';
  input = { ...input, channel };
  if (channel === 'email') {
    const alert = parseEmailAlert({
      title: input.notificationTitle,
      body: input.notificationBody,
      rawText: input.rawNotification,
    });
    if (!alert) {
      log.debug('[AI pipeline] Email is not a bank alert, or stands for several messages; ignoring');
      return {
        processed: false,
        isTransaction: false,
        skipReason: 'not_bank_app',
        rejectionReason: 'Email was not a single message from a bank',
        bankName: input.bankName,
      };
    }
    // Everything downstream — the dedup keys, the parser, the stored row — now
    // works from the vetted text rather than the whole notification.
    input = { ...input, rawNotification: alert.text };
  }

  const notifTimestamp = input.notificationTimestamp || Date.now();

  // Build the dedup key up-front so the in-flight check can run before
  // any of the expensive async work below.
  const inMemoryKey = buildInMemoryDedupKey(input.bankAppId, input.rawNotification);

  // ── Step 0 (pre): In-flight check ──
  // If another invocation is already processing this exact notification
  // (e.g. the native onListenerConnected scan and the JS useEffect scan
  // both fire at app start, or a scan is in flight when the user taps
  // the manual refresh button), drop the duplicate. This must run BEFORE
  // the TTL cache check below, otherwise the second caller still
  // participates in the work and we double-insert.
  if (!input.forceReprocess && inFlightProcessingKeys.has(inMemoryKey)) {
    log.debug('[AI pipeline] In-flight dedup hit, skipping duplicate invocation');
    return {
      processed: false,
      isTransaction: false,
      skipReason: 'duplicate_fingerprint',
      bankName: input.bankName,
    };
  }

  // Claim the key for the duration of this call. The try/finally below
  // guarantees the key is released on every exit path (success, error,
  // or any of the early returns). Concurrent invocations that arrive
  // while we're still processing will see the key in the set and bail
  // out at the check above.
  inFlightProcessingKeys.add(inMemoryKey);
  try {
    return await processNotificationWithAIImpl(
      userId,
      input,
      availableCategories,
      notifTimestamp,
      inMemoryKey,
    );
  } finally {
    inFlightProcessingKeys.delete(inMemoryKey);
  }
}

/**
 * Internal implementation of processNotificationWithAI. Lives in its own
 * function so the outer wrapper can claim/release the in-flight dedup key
 * around the entire processing pipeline — even though the body has many
 * early returns and a final await on the insert, the finally block in the
 * outer wrapper guarantees the key is released exactly once.
 */
async function processNotificationWithAIImpl(
  userId: string,
  input: NotificationInput,
  availableCategories: { id: string; name: string }[],
  notifTimestamp: number,
  inMemoryKey: string,
): Promise<AIProcessingResult> {
  // Written for every new capture. Reads must ALSO consult inMemoryKey, because
  // captures recorded before this key existed used that form — missing them
  // would re-import a transaction already in the ledger.
  const capturedKey = buildCapturedKey(
    input.bankAppId,
    input.rawNotification,
    input.notificationTimestamp,
  );

  // Tracks a soft-dup match found in Step 4 so the Step 6 insert can
  // surface the warning in the returned result. Cleared on every call.
  let softDupMatch: { id: string; vendor: string; amount: number; date: string } | null = null;

  // ── Step 0: In-memory dedup ──
  // Fast check to prevent the same notification from being processed
  // multiple times during a scan or rapid re-broadcast.
  evictExpiredCacheEntries();
  if (!input.forceReprocess && recentlyProcessedCache.has(inMemoryKey)) {
    log.debug('[AI pipeline] In-memory dedup hit, skipping');
    return {
      processed: false,
      isTransaction: false,
      skipReason: 'duplicate_fingerprint',
      bankName: input.bankName,
    };
  }

  // ── The first two lookups run together ──
  //
  // The rules lookup and the duplicate lookup below need nothing from each
  // other, but ran one after the other — and on a phone that has just woken
  // its radio, each one is most of a second. That wait is the whole reason a
  // purchase captured while the app was closed took a few seconds to appear
  // after opening it: nothing was slow, everything was just in a queue behind
  // something else.
  //
  // Starting the duplicate lookup here changes nothing about the decisions
  // below or the order they are made in — the rule still wins, and still wins
  // first. It only means the answer has arrived by the time Step 1 asks for
  // it. The cost is one wasted read when a rule matches, which is a rare path
  // and a read either way.
  const quickAmountMatch = input.rawNotification.match(/\$([\d,]+(?:\.\d{1,2})?)/);
  const quickAmount = quickAmountMatch
    ? parseFloat(quickAmountMatch[1].replace(/,/g, ''))
    : null;
  const duplicateCheck = checkAlreadyProcessed(
    userId,
    quickAmount,
    input.fallbackVendor || null,
    notifTimestamp,
  ).catch((e) => {
    // Never allowed to reject: this promise is created before the early exits
    // below and may end up with nobody awaiting it. Falling back to "not a
    // duplicate" is also what the function itself does on a failed read, so
    // the behaviour is unchanged.
    log.warn('[AI pipeline] Duplicate check failed; treating as not a duplicate:', e);
    return false;
  });

  // ── Step 0c: User-learned skip rules ──
  // The user can mark a captured item as "not a transaction" from the
  // <> page. That creates a rule in `notification_rules` and every
  // future notification matching the rule is dropped here, before any
  // parsing. We bump the rule's use_count best-effort (fire-and-forget).
  //
  // Applied even under forceReprocess, unlike every other early exit here. A
  // rescan is allowed to look again at things the app GUESSED were not
  // transactions — the rejection cache below is exactly that, a record of
  // guesses — but a rule is not a guess, it is a standing instruction from the
  // user, and rescanning is no reason to overrule it.
  //
  // That distinction was not being made, and it mattered far more than it
  // sounds: everything captured while the app is closed comes back through
  // drainPendingNotifications, which marks the whole batch as a scan. So the
  // skip rules were bypassed for precisely the captures the user never saw
  // happen — every alert they had already marked as noise was quietly
  // re-imported on the next launch.
  const matchedRule = await checkNotificationRules(userId, input.rawNotification);
  if (matchedRule) {
    log.debug(`[AI pipeline] Skipped by user rule #${matchedRule.id} (${matchedRule.pattern_type}: "${matchedRule.pattern.slice(0, 50)}...")`);
    // Best-effort: record the use without blocking the result. The alert goes
    // with it — this is the only place its wording is ever kept, since a
    // skipped notification becomes no row and no log the user can read.
    void bumpRuleUseCount(matchedRule.id, input.rawNotification);
    notificationMarkers.recordRejected(inMemoryKey);
    return {
      processed: true,
      isTransaction: false,
      skipReason: 'not_transaction',
      rejectionReason: `Skipped by user rule (${matchedRule.pattern_type} match)`,
      bankName: input.bankName,
    };
  }

  // ── Step 0b: Persistent dedup (survives app restarts) ──
  // The in-memory cache above is cleared every time the JS module re-loads
  // (app restart, hot reload). This localStorage-backed check ensures a
  // notification that was already processed is never re-inserted after the
  // user clears it from the <> page and the app is closed/reopened.
  // A CAPTURE is permanent: the row is in the ledger and must never be
  // inserted twice, so forceReprocess deliberately does not bypass this.
  if (notificationMarkers.isCaptured(capturedKey, inMemoryKey)) {
    log.debug('[AI pipeline] Persistent dedup hit (already captured), skipping');
    // Warm the in-memory cache so subsequent checks in this session are fast
    notificationMarkers.rememberRecent(inMemoryKey);
    return {
      processed: false,
      isTransaction: false,
      skipReason: 'duplicate_fingerprint',
      bankName: input.bankName,
    };
  }

  // A REJECTION is provisional. Its causes are often transient — the AI model
  // still loading, a refund whose expense has not arrived yet, a reworded bank
  // alert — so an explicit rescan (the scan button) is allowed to look again.
  // Rejections also expire on their own; see localNotificationMemory.
  if (!input.forceReprocess && notificationMarkers.isRejected(inMemoryKey)) {
    log.debug('[AI pipeline] Previously rejected, skipping (a rescan will retry)');
    return {
      processed: false,
      isTransaction: false,
      skipReason: 'duplicate_fingerprint',
      bankName: input.bankName,
    };
  }

  // ── Step 1: Duplicate Detection ──
  // Started above, so by now this is usually just reading an answer that has
  // already arrived rather than waiting for one.
  const isDuplicate = await duplicateCheck;

  if (isDuplicate) {
    log.debug('[AI pipeline] Duplicate detected, skipping');
    // Also add to in-memory cache to prevent re-processing
    notificationMarkers.rememberRecent(inMemoryKey);
    return {
      processed: false,
      isTransaction: false,
      skipReason: 'duplicate_fingerprint',
      bankName: input.bankName,
    };
  }

  // ── Step 2: Deterministic extraction ──
  let parsed = parseNotificationText(input.rawNotification);

  if (!parsed.isOutgoing) {
    const reason = parsed.rejectionReason || 'Not an outgoing transaction notification';

    // ── Money held, not spent ──
    //
    // The held figure is never recorded: it is the number the hotel or the
    // pump picked, not the one that was spent, and writing it down puts a
    // wrong amount in a budget where nobody will think to question it.
    //
    // But refusing in silence loses the other case. If the charge settles and
    // the bank says nothing the second time, that purchase is simply gone and
    // the month quietly fails to add up. So the hold is REMEMBERED — if a real
    // charge from that merchant lands within the week it was the same money
    // and this is forgotten; if nothing lands, Review asks one question. See
    // App/Lib/Capture/pendingHold.ts.
    //
    // The merchant comes from the listener's own reading when the parser has
    // none: the hold test runs before the parser extracts a vendor, which is
    // exactly why no row is ever created from one.
    if (parsed.isPreAuth) {
      rememberHold(
        parsed.vendorDisplay || input.fallbackVendor || '',
        parsed.amount ?? input.fallbackAmount ?? 0,
      );
    }

    notificationMarkers.recordRejected(inMemoryKey);
    return {
      processed: true,
      isTransaction: false,
      vendor: parsed.vendorDisplay || undefined,
      amount: parsed.amount || undefined,
      skipReason: 'not_transaction',
      rejectionReason: reason,
      bankName: input.bankName,
    };
  }

  // ── The three lookups the rest of this needs, started together ──
  //
  // Everything below this point is one purchase being checked against the
  // user's own history: nearby transactions (Step 4 and Step 5b), their vendor
  // rules (Step 5a) and their recurring charges (Step 5b). None of the three
  // reads depends on another, and none of them depends on the vendor or amount
  // this call is still working out — the transactions read is a date window,
  // the rules read fetches the whole small table and matches in memory, and
  // the recurring read is the user's recurring rows. They were nonetheless
  // issued one at a time, three round trips deep, which is most of the wait
  // between opening the app and seeing a capture appear.
  //
  // Started here rather than at the top of the function so an alert that is
  // not a purchase at all still costs nothing: the parser has just said this
  // one is. Each promise is made safe to abandon, because the paths below can
  // return before some of them are read.
  //
  // The purchase is dated by when the bank announced it, not by when this
  // pipeline got to it. Those differ whenever the app was closed: the native
  // queue holds the alert until the next launch, and dating it "today" filed
  // a Friday purchase on whatever day the user next opened Review — usually
  // the day they confirmed its category. Every window and pairing below
  // centres on that same day, so the duplicate checks look where the row is.
  const captureDay = captureDayOf(input.notificationTimestamp);
  const captureDayMs = parseLocalDate(captureDay).getTime();
  const step4WindowStart = toLocalIsoDay(new Date(captureDayMs - RECURRING_DATE_TOLERANCE_DAYS * MS_PER_DAY));
  const step4WindowEnd = toLocalIsoDay(new Date(captureDayMs + RECURRING_DATE_TOLERANCE_DAYS * MS_PER_DAY));

  // Promise.resolve rather than calling .then on the builder: a query builder
  // is thenable, so this issues the read immediately, and it also survives a
  // caller that hands back a plain object instead of a promise.
  const nearbyTransactions = Promise.resolve(
    supabase
      .from('transactions')
      // `raw_notification` rides along because it is where a row's capture
      // channel is recorded (see app/lib/capture/captureChannel.ts). Fetching it here means
      // the email-versus-bank duplicate rule below costs no extra round trip —
      // it reuses rows the pipeline was loading anyway.
      .select('id, vendor, amount, type, date, recur, source, raw_notification, created_at')
      .eq('user_id', userId)
      .gte('date', step4WindowStart)
      .lte('date', step4WindowEnd),
  ).catch((e) => {
    log.warn('[AI pipeline] Could not read nearby transactions:', e);
    return { data: null } as { data: null };
  });

  // ALL of the user's rules, not a recent slice of them — see the match_key
  // lookup in Step 5a for why, and note that the query itself mentions no
  // vendor, which is what makes it safe to start before one is settled on.
  const vendorRules = Promise.resolve(
    supabase
      .from('overrides')
      .select('category_id, proper_name, match_key, match_type, updated_at')
      .eq('user_id', userId)
      .not('match_key', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(MAX_VENDOR_RULES),
  ).catch((e) => {
    log.warn('[AI pipeline] Could not read the vendor rules:', e);
    return { data: null } as { data: null };
  });

  // Already caches its own result and never rejects, so it needs no guard.
  const recurringCharges = fetchRecurringCharges(userId);

  // ── Step 2d: the same alert, reworded ──
  //
  // The user's rules are matched two ways before this: the text as it was
  // written, and the text with its numbers masked, which is what makes "ignore
  // alerts like this one" survive tomorrow's price. Neither survives the alert
  // being REWORDED — a bank changing its phrasing, "Bitcoin price update"
  // where last week said "BTC price alert" — and to the user that is obviously
  // the same notification they have already dealt with once.
  //
  // So the model gets a second look, under two conditions that keep it off the
  // path of ordinary captures entirely:
  //
  //   - only for alerts already sharing most of their wording with something
  //     the user ignored (candidatePatternsFor), so a Loblaws charge is never
  //     compared against anything;
  //   - only once the parser has decided this IS a purchase, so nothing the
  //     app was going to reject anyway costs an inference.
  //
  // Placed after the three reads above are already in flight, so an inference
  // — which can take a second on a phone — overlaps with them rather than
  // holding them up. Returning from here abandons those reads, which is safe:
  // they are read-only and each one is guarded.
  //
  // And the verdict is recorded as a GUESS, not as a rule. A rule is the
  // user's standing instruction and is never revisited; this is the app's
  // opinion about a wording nobody has ruled on, so it goes in the rejection
  // memory that the scan button is allowed to overrule, and it shows up in the
  // processed list with its reason rather than disappearing.
  const ignoredPatterns = await listIgnoredPatterns(userId);
  const rewordCandidates = ignoredPatterns.length > 0
    ? candidatePatternsFor(ignoredPatterns, input.rawNotification)
    : [];
  if (rewordCandidates.length > 0) {
    // A model that throws — no runtime, no network, a WebView that killed the
    // worker — is not an opinion, and must never be the reason a purchase
    // fails to be captured. Same answer as a "no".
    const sameKind = await aiLooksLikeIgnoredAlert(input.rawNotification, rewordCandidates[0])
      .catch(() => false);
    if (sameKind) {
      log.debug('[AI pipeline] Reads as a reworded version of an alert the user ignores');
      notificationMarkers.recordRejected(inMemoryKey);
      return {
        processed: true,
        isTransaction: false,
        skipReason: 'not_transaction',
        rejectionReason: "Looks like the alerts you've marked as not a transaction",
        bankName: input.bankName,
      };
    }
  }

  // ── Step 2b: AI fallback for low-confidence extractions ──
  // The regex parser is fast but brittle. If it wasn't confident (e.g. no
  // strong go-phrase, no clear preposition-based vendor, multiple amount
  // candidates) we fall back to the on-device Flan-T5 model. The first
  // call loads the model (slow, ~60MB), subsequent calls are fast.
  // Results are cached in localStorage so we never re-infer the same text.
  // Declared at function scope so Step 2c (confidence gating) and Step 5c
  // (AI category fallback) below can read the AI result produced here.
  let aiResult: AIExtractionResult | CachedAIResult | null = null;
  const parserConfidence = parsed.confidence ?? 0.5;
  if (parserConfidence < AI_FALLBACK_CONFIDENCE_THRESHOLD) {
    // Check the cache first — same notification text is never re-inferred
    const cached = getCachedAIResult(input.rawNotification);
    if (cached) {
      log.debug(`[AI fallback] cache hit for "${input.rawNotification.slice(0, 40)}..."`);
      aiResult = cached;
    } else {
      try {
        // Feed the user's own confirmed vendor -> category decisions in as
        // few-shot examples. The deterministic override lookup (Step 5a) already
        // short-circuits vendors the user has taught, so the model only ever
        // sees NEW merchants — precedent from similar ones is exactly what it
        // lacks. This is how capture improves with use: flan-t5-small cannot be
        // fine-tuned on-device, but it can be shown how this household sorts
        // things.
        aiResult = await extractWithAI(
          input.rawNotification,
          availableCategories.map(c => c.name),
          collectLearnedExamples(),
        );
        // Persist for next time
        setCachedAIResult(input.rawNotification, {
          isTransaction: aiResult.isTransaction,
          vendor: aiResult.vendor,
          amount: aiResult.amount,
          suggestedCategory: aiResult.suggestedCategory,
          rejectionReason: aiResult.rejectionReason,
          confidence: aiResult.confidence,
          confidenceLabel: aiResult.confidenceLabel,
        });
      } catch (err) {
        // AI failed to load (network, WASM not supported, etc.) — fall
        // through and use the regex result anyway. Better a slightly-wrong
        // extraction than no extraction at all.
        log.warn('[AI fallback] failed, using regex result:', err);
        aiResult = null;
      }
    }
    if (aiResult) {
      if (aiResult.isTransaction && aiResult.vendor && aiResult.amount) {
        log.debug(
          `[AI fallback] parser=${parserConfidence.toFixed(2)} → using AI: ` +
          `${aiResult.vendor} $${aiResult.amount}` +
          (parsed.confidenceReasons ? ` (reasons: ${parsed.confidenceReasons.join(', ')})` : ''),
        );
        // Merge the AI result over the regex result. The AI's vendor
        // wins if the regex didn't find one or if the AI's vendor is
        // meaningfully different.
        parsed = {
          ...parsed,
          vendorDisplay: aiResult.vendor,
          vendorKey: aiResult.vendor.toLowerCase().replace(/[^a-z0-9]/g, ''),
          amount: aiResult.amount,
        };
      } else if (aiResult.rejectionReason) {
        // The AI thinks this isn't a transaction. Trust it over the regex.
        log.debug(`[AI fallback] parser=${parserConfidence.toFixed(2)} → AI rejected: ${aiResult.rejectionReason}`);
        notificationMarkers.recordRejected(inMemoryKey);
        return {
          processed: true,
          isTransaction: false,
          vendor: aiResult.vendor || undefined,
          amount: aiResult.amount || undefined,
          skipReason: 'not_transaction',
          rejectionReason: `AI: ${aiResult.rejectionReason}`,
          bankName: input.bankName,
        };
      }
    }
  }

  // ── Step 2c: Confidence gating ──
  //
  // An uncertain extraction is exactly what the review list is for, so it goes
  // down the same path as every other capture and lands there with its
  // confidence shown as a meter. The only thing low confidence changes is that
  // the row can never be auto-filed (see `lowConfidenceExtraction` at the
  // insert below) — the user has to look at it.
  //
  // This used to divert instead: it inserted a row into `pending_transactions`
  // and returned. That table does not exist in this database, so the insert
  // 404'd, supabase-js reported the failure in a return value nobody read, and
  // the purchase went nowhere. Worse, the diversion called
  // markNotificationProcessed first, which is permanent — so the capture could
  // never be recovered by a rescan either. The user was told "$X at Y
  // captured" by the notification and then found nothing in Review, with no
  // error anywhere. Every purchase the on-device model was unsure about was
  // silently destroyed.
  const lowConfidenceExtraction =
    !!aiResult && aiResult.isTransaction && (aiResult.confidence ?? 1) < LOW_CONFIDENCE_REVIEW_THRESHOLD;
  if (lowConfidenceExtraction) {
    log.debug(
      `[AI pipeline] Low confidence (${aiResult!.confidenceLabel}, ` +
      `${(aiResult!.confidence ?? 0).toFixed(2)}) — capturing for review rather than auto-filing`,
    );
  }

  // Use the deterministic extraction result unless it failed ('Unknown'), in which
  // case fall back to whatever the native plugin extracted from the notification title.
  const extractedVendor = (parsed.vendorDisplay && parsed.vendorDisplay !== 'Unknown')
    ? parsed.vendorDisplay
    : null;
  const vendor = extractedVendor || input.fallbackVendor || null;
  // Other names this same merchant answers to — today, the name with its
  // payment-processor prefix still attached ("Google Youtubepremium" for a
  // charge the parser reduced to "Youtubepremium"). Used for matching learned
  // rules and for recognising a charge already on the books; never displayed
  // and never stored. See ParsedNotification.vendorAliases.
  const vendorAliases = (parsed.vendorAliases || []).filter(
    (name): name is string => !!name && name !== vendor,
  );
  const rawAmount = parsed.amount ?? input.fallbackAmount ?? 0;
  // Refunds are NOT stored as separate negative-amount rows. They are
  // applied to the original expense via the refunded=true flag (see
  // Step 3a below). Income notifications are rejected entirely (no row).
  const amount = rawAmount;

  // ── Step 3a: Refund handling — strike through the original expense ──
  // If the parser detected a refund phrase and we have a vendor + amount,
  // we look for a matching expense in the same user's transaction history
  // (exact vendor + exact amount, same budget, within
  // REFUND_MATCH_WINDOW_DAYS). If a match is found we set refunded=true
  // on the original row and return without inserting a new transaction.
  // The original row's amount is unchanged; the UI applies strikethrough
  // and the budget reduce excludes the refunded row from the spent total.
  if (parsed.isRefund && vendor && rawAmount > 0) {
    const refundWindowStart = toLocalIsoDay(new Date(
      notifTimestamp - REFUND_MATCH_WINDOW_DAYS * MS_PER_DAY
    ));
    const refundWindowEnd = toLocalIsoDay(new Date(
      notifTimestamp + REFUND_MATCH_WINDOW_DAYS * MS_PER_DAY
    ));
    const { data: refundCandidates } = await supabase
      .from('transactions')
      .select('id, vendor, amount, date, budget, refunded')
      .eq('user_id', userId)
      .gte('date', refundWindowStart)
      .lte('date', refundWindowEnd)
      .eq('refunded', false)
      .gt('amount', 0)
      .eq('is_projected', false);

    if (refundCandidates && refundCandidates.length > 0) {
      const mapped: any[] = refundCandidates.map((row: any) => ({
        id: row.id,
        vendor: row.vendor,
        amount: Number(row.amount),
        date: row.date,
        budget_id: row.budget || '',
        is_projected: false,
        refunded: row.refunded === true,
      }));
      let match = findMatchingExpense(
        // The refund's own local day. The UTC slice put an evening refund in
        // the Americas on tomorrow's date.
        { vendor, amount: rawAmount, date: toLocalIsoDay(new Date(notifTimestamp)), budget_id: '' },
        mapped,
      );
      // AI fallback: try semantic vendor matching for refunds with different names
      if (!match && mapped.length > 0) {
        const aiMatchId = await aiFindRefundMatch(vendor, Math.abs(rawAmount), mapped.map(c => ({
          id: c.id,
          vendor: c.vendor,
          amount: Number(c.amount),
          date: String(c.date).slice(0, 10),
        })));
        if (aiMatchId) {
          match = mapped.find((c: any) => c.id === aiMatchId) || null;
          if (match) {
            log.debug(`[AI pipeline] Refund matched via AI: ${match.vendor} $${match.amount}`);
          }
        }
      }
      if (match) {
        const { error: refundUpdateError } = await supabase
          .from('transactions')
          .update({ refunded: true })
          .eq('id', match.id);
        if (refundUpdateError) {
          log.error('[AI pipeline] Failed to mark expense refunded:', refundUpdateError);
        } else {
          log.debug(
            `[AI pipeline] Refund matched: struck through ${match.vendor} $${match.amount} (${match.date})`,
          );
          notificationMarkers.recordCaptured(inMemoryKey, capturedKey);
          return {
            processed: true,
            isTransaction: true,
            vendor,
            amount: rawAmount,
            bankName: input.bankName,
            // Surfaced to the parsing UI as a successful refund match.
            refundMatched: {
              id: match.id,
              vendor: match.vendor,
              amount: Number(match.amount),
              date: String(match.date).slice(0, 10),
            },
          };
        }
        // Fall through to the regular insert path if the update failed
        // (rare; the user will see the refund twice but it won't block).
      } else {
        log.debug(
          `[AI pipeline] Refund ${vendor} $${rawAmount} has no matching expense in ${REFUND_MATCH_WINDOW_DAYS}-day window; skipping`,
        );
        notificationMarkers.recordRejected(inMemoryKey);
        return {
          processed: true,
          isTransaction: false,
          vendor,
          amount: rawAmount,
          bankName: input.bankName,
          skipReason: 'not_transaction',
          rejectionReason: `Refund has no matching expense within ${REFUND_MATCH_WINDOW_DAYS} days`,
        };
      }
    } else {
      log.debug(
        `[AI pipeline] Refund ${vendor} $${rawAmount} has no candidate expenses; skipping`,
      );
      notificationMarkers.recordRejected(inMemoryKey);
      return {
        processed: true,
        isTransaction: false,
        vendor,
        amount: rawAmount,
        bankName: input.bankName,
        skipReason: 'not_transaction',
        rejectionReason: `Refund has no matching expense within ${REFUND_MATCH_WINDOW_DAYS} days`,
      };
    }
  }

  // ── Step 3b: Reject if no vendor could be identified ──
  if (!vendor) {
    const reason = 'No vendor name found in notification';
    log.debug('[AI pipeline] Skipped: no vendor identified');
    notificationMarkers.recordRejected(inMemoryKey);
    return {
      processed: true,
      isTransaction: false,
      amount,
      skipReason: 'not_transaction',
      rejectionReason: reason,
      bankName: input.bankName,
    };
  }

  // ── Step 4: Duplicate detection (fuzzy vendor + amount ±3 days) ──
  // Projection is the superset of what step 4 and step 5b need, so step 5b
  // can reuse this result instead of re-issuing the identical query (same
  // user, same +/-3 day window). Nothing between the two steps writes to
  // `transactions`; the post-insert race check in step 6b deliberately stays
  // a fresh query.
  const { data: existingTx } = await nearbyTransactions;

  // A same-day near-exact report is a hard skip. Anything less certain is
  // preserved and surfaced as a possible duplicate so a real second purchase
  // is never silently lost. The pure classifier lives in
  // app/lib/capture/notificationDuplicates.ts; this pipeline owns the user-visible result.
  const duplicateDecision = findNotificationDuplicate(existingTx || [], {
    vendor,
    aliases: vendorAliases,
    amount,
    date: captureDay,
  });

  if (duplicateDecision.kind === 'hard') {
    const duplicate = duplicateDecision.transaction;
    log.debug(`[AI pipeline] Hard skip: same-day same-amount match ${duplicate.vendor} $${duplicate.amount} (${duplicate.date})`);
    notificationMarkers.recordCaptured(inMemoryKey, capturedKey);
    return {
      processed: true,
      isTransaction: true,
      vendor,
      amount,
      skipReason: 'duplicate_ai' as const,
      rejectionReason: 'Same notification reprocessed on the same day',
      bankName: input.bankName,
    };
  }

  if (duplicateDecision.kind === 'soft') {
    const closest = duplicateDecision.transaction;
    log.debug(`[AI pipeline] Soft-dup: similar ${closest.vendor} $${closest.amount} on ${closest.date} (source=${closest.source || 'unknown'}), but new charge is $${amount.toFixed(2)}`);
    softDupMatch = {
      id: closest.id,
      vendor: closest.vendor,
      amount: Number(closest.amount),
      date: closest.date,
    };
  }

  // ── Step 4d: Two apps, one tap — the first to report it wins ──
  //
  // A wallet and the card's own bank app both announce the same tap-to-pay
  // purchase, seconds apart, in completely different words. Nothing above can
  // see that they are one purchase: the fingerprints differ (different app,
  // different text) and the near-duplicate check needs the merchants to match,
  // which is exactly what fails here — a wallet often has only its own name or a
  // terminal id where the merchant should be.
  //
  // So this matches on what both sides always get right: the amount, and how far
  // apart the two announcements were. Whoever reported it first keeps the row;
  // this one is dropped. Deliberately blind to the merchant, and deliberately
  // narrow — five minutes, and only ever against a DIFFERENT app.
  //
  // This is what replaced refusing Google Wallet outright. The exclusion cost a
  // real capability (a card that only notifies through a wallet could not be
  // captured at all) and could only be undone in a release; this can be undone
  // by unticking the app.
  if (existingTx && existingTx.length > 0 && input.bankAppId) {
    const sameTap = existingTx.find((tx) => isOtherAppSameTap(
      tx,
      { packageName: input.bankAppId, amount, notifiedAt: notifTimestamp },
      amountsAgree,
    ));
    if (sameTap) {
      log.debug(
        `[AI pipeline] Another app already reported this tap: ${sameTap.vendor} $${sameTap.amount}; dropping the second report from ${input.bankAppId}`,
      );
      notificationMarkers.recordCaptured(inMemoryKey, capturedKey);
      return {
        processed: true,
        isTransaction: true,
        vendor,
        amount,
        skipReason: 'duplicate_ai' as const,
        rejectionReason: 'Another app reported this purchase first',
        bankName: input.bankName,
      };
    }
  }

  // ── Step 4e: An email defers to the bank's own alert ──
  //
  // Most banks announce a purchase twice — a push from their app and an email —
  // and the two are not remotely the same string, so none of the fingerprint
  // dedup above can see that they are one purchase. Step 4's hard skip nearly
  // catches it and then misses: it demands the same day and the same cent,
  // while an email routinely lands the following morning and occasionally
  // rounds differently.
  //
  // Four things make this safe rather than a way to lose purchases:
  //
  //   1. It only ever runs for a capture that came IN by email, so a bank
  //      alert can never be dropped in favour of anything.
  //   2. It only defers to a row that came from a bank app — including every
  //      row captured before this feature existed, which could not have come
  //      from anywhere else. An email is never dropped because of another
  //      email; two mails about two real purchases both survive.
  //   3. It uses the looser "looks like the same charge" test, the one written
  //      for exactly this drift (a premium reported at $477.45 and captured at
  //      $477.46 a day later).
  //   4. ONE email cancels ONE bank row. The row is marked as it is used, so a
  //      second genuine purchase at the same merchant for the same amount
  //      inside the window cannot vanish into the same row — the trap two Fizz
  //      charges three days apart already sprang once on the projection code.
  //
  // Closest first, so when several rows could match, the nearest in amount and
  // then in time is the one consumed.
  if (input.channel === 'email' && existingTx && existingTx.length > 0) {
    const claimed = findUnpairedBankCaptureForEmail(existingTx, { vendor, amount, date: captureDay });
    if (claimed) {
      log.debug(
        `[AI pipeline] Email repeats a bank capture: ${claimed.vendor} $${claimed.amount} on ${claimed.date}; dropping the email copy`,
      );
      // Spend the row so it cannot absorb a second email. Deliberately not
      // awaited for its success: if this write fails the only cost is the old
      // behaviour, where one row could swallow two emails, and that is not
      // worth failing a capture over.
      try {
        await supabase
          .from('transactions')
          .update({ raw_notification: withEmailPairedMarker(claimed.raw_notification).slice(0, 4000) })
          .eq('id', claimed.id);
      } catch (e) {
        log.warn('[AI pipeline] Could not mark the bank row as paired:', e);
      }

      notificationMarkers.recordCaptured(inMemoryKey, capturedKey);
      return {
        processed: true,
        isTransaction: true,
        vendor,
        amount,
        skipReason: 'duplicate_ai' as const,
        rejectionReason: 'The bank app already reported this purchase',
        bankName: input.bankName,
      };
    }
  }

  // ── Step 4f: The bank's alert upgrades an email that got here first ──
  //
  // The other order of arrival. Sometimes the email lands before the push, or
  // the push is delayed by hours, or that particular card only pushes
  // sometimes. By the time the bank's own alert arrives the email row is
  // already saved — and left alone, step 4 would discard the bank's version and
  // the dashboard would keep the weaker one: an email's merchant is dug out of
  // a truncated snippet, a bank's comes from fixed wording, and the amounts can
  // differ by a cent.
  //
  // So the bank's numbers are written over the email's row rather than beside
  // it. Nothing is deleted and no row appears or disappears — the entry the user
  // may already be looking at in Review simply becomes correct, and is marked as
  // bank-sourced so a later email defers to it like any other.
  //
  // If the update fails the capture is still reported as a duplicate rather than
  // retried as an insert: the money is already on the books with very nearly the
  // right figure, and a second row would be worse than a slightly stale one.
  if (input.channel !== 'email' && existingTx && existingTx.length > 0) {
    const stale = findEmailCaptureForBank(existingTx, { vendor, amount, date: captureDay });

    if (stale) {
      log.debug(
        `[AI pipeline] Bank alert supersedes an email capture: ${stale.vendor} $${stale.amount} → ${vendor} $${amount.toFixed(2)}`,
      );
      try {
        await supabase
          .from('transactions')
          .update({
            vendor: vendor || stale.vendor,
            amount,
            raw_notification: withCaptureMarker(
              (input.rawNotification || '').slice(0, 3900),
              { channel: 'bank', packageName: input.bankAppId, notifiedAt: notifTimestamp },
            ),
          })
          .eq('id', stale.id);
      } catch (e) {
        log.warn('[AI pipeline] Could not upgrade the email row with the bank alert:', e);
      }

      notificationMarkers.recordCaptured(inMemoryKey, capturedKey);
      return {
        processed: true,
        isTransaction: true,
        vendor,
        amount,
        skipReason: 'duplicate_ai' as const,
        rejectionReason: 'This purchase was already captured from the bank\'s email',
        bankName: input.bankName,
      };
    }
  }

  // ── Step 5: Category assignment ──
  const {
    categoryId,
    categoryName,
    displayVendor,
    overrideMatchConfidence,
  } = await assignCaptureCategory(
    {
      userId,
      vendor,
      vendorAliases,
      parsed,
      availableCategories,
      aiSuggestedCategory: aiResult?.suggestedCategory,
      rawNotification: input.rawNotification,
      hiddenCategoryIds: input.hiddenCategoryIds,
    },
    {
      vendorRules,
      readTransactionFrequencies: (readUserId, candidateNames) =>
        supabase
          .from('transactions')
          .select('vendor, budget')
          .eq('user_id', readUserId)
          .in('budget', candidateNames)
          .order('date', { ascending: false })
          .limit(MAX_FREQUENCY_ROWS),
      readProperNameRule: (readUserId, name) =>
        supabase
          .from('overrides')
          .select('category_id, proper_name, match_key')
          .eq('user_id', readUserId)
          .ilike('proper_name', name)
          .order('updated_at', { ascending: false })
          .limit(1),
      fetchPartnerRules,
      lookupCommunityRule,
      getVendorMap,
    },
  );

  if (!categoryId) {
    log.error('[AI pipeline] No category available for transaction');
    return {
      processed: true,
      isTransaction: true,
      vendor,
      amount,
      rejectionReason: 'No budget category available',
      bankName: input.bankName,
    };
  }

  // ── Step 5b: The charge is one Covault already knows about ──
  //
  // A subscription is accounted for twice, by two different mechanisms: the
  // recurring machinery has it on the books and posts the month's occurrence on
  // its due date, and then the bank announces the real charge a day or two
  // either side and the capture pipeline records it again. One subscription,
  // two rows, and the month is wrong by the amount — plus a review item and a
  // notification for money the user had already accounted for.
  //
  // Everything above this point failed to see it. The hard skip in step 4 only
  // fires on the SAME DAY, and a due date is a guess that lands a day or two
  // off; and until the alias matching added above, "Google" and
  // "GOOGLE *YOUTUBEPREMIUM" did not even look like the same merchant.
  //
  // So this is the one place that treats the recurring machinery as
  // authoritative: when the same charge is already recorded — or already
  // scheduled — as recurring, the capture does not become a second row. Where
  // the row IS this occurrence, the bank's own wording is kept on it, so the
  // charge can still be traced back to the notification that confirmed it.
  //
  // Deliberately narrower than the soft-dup above: only recurring rows, and
  // only an amount matching to the cent. Two ordinary purchases at one
  // merchant in the same week are real and both must survive; a subscription
  // billing twice in three days for the identical amount is not.
  //
  // Matched against the SCHEDULE, not just against rows sitting nearby.
  //
  // The window queried above is +/-3 days, which only ever contained a
  // subscription the executor had already posted. A subscription that has not
  // come due yet has no row at all — the executor writes occurrences up to
  // today and no further, and the future ones on the dashboard are display-only
  // projections — so its only real row is the previous month's, a month outside
  // that window. A Netflix charge announced today with the monthly Netflix due
  // tomorrow therefore matched nothing, and was captured a second time.
  //
  // So the recurring templates are fetched separately, without a date window,
  // and app/lib/transactions/recurringSchedule.ts asks whether an occurrence of each falls near
  // today rather than whether its row happens to.
  //
  // The rows already in hand are checked first, so the common case — the
  // executor posted this month's occurrence a day or two ago — costs nothing
  // extra. The unwindowed lookup only happens when that finds nothing.
  //
  // Every name this capture answers to, including the one the matched rule
  // renamed it to — that is usually the name the recurring row carries.
  const recurringCandidate = {
    vendors: [displayVendor, vendor, ...vendorAliases],
    amount,
    date: captureDay,
  };
  const recurringMatch =
    findRecurringScheduleMatch(recurringCandidate, existingTx || []) ??
    findRecurringScheduleMatch(recurringCandidate, await recurringCharges);

  if (recurringMatch) {
    log.debug(
      `[AI pipeline] Already known as a recurring charge: ${recurringMatch.vendor} ` +
      `$${recurringMatch.amount} on ${recurringMatch.date} (${recurringMatch.id}, ` +
      `recur=${recurringMatch.recur || 'none'}, source=${recurringMatch.source || 'unknown'}) ` +
      `— not capturing a second row`,
    );

    // Attach the bank's wording to the row, but only when the row IS this
    // occurrence. A template matched through its schedule is a different
    // month's charge, and writing today's notification onto it would rewrite
    // history for a row this capture is not.
    //
    // Best-effort either way. The point of the skip is that there is only one
    // row; failing to record where the confirmation came from costs
    // traceability, not correctness, so it must not turn into a duplicate
    // insert.
    if (isRecordedOccurrenceNearCapture(
      recurringMatch.date,
      captureDay,
      RECURRING_DATE_TOLERANCE_DAYS,
    )) {
      const { error: attachError } = await supabase
        .from('transactions')
        .update({ raw_notification: (input.rawNotification || '').slice(0, 4000) })
        .eq('id', recurringMatch.id);
      if (attachError) {
        log.warn('[AI pipeline] Could not attach the notification to the recurring row:', attachError);
      }
    }

    notificationMarkers.recordCaptured(inMemoryKey, capturedKey);
    return {
      processed: true,
      isTransaction: true,
      vendor: formatVendorName(displayVendor),
      amount,
      categoryId: categoryId || undefined,
      categoryName: categoryName || undefined,
      skipReason: 'duplicate_recurring',
      rejectionReason: 'Already recorded as a recurring charge',
      bankName: input.bankName,
      softDuplicateOf: {
        id: String(recurringMatch.id || ''),
        vendor: String(recurringMatch.vendor || ''),
        amount: Number(recurringMatch.amount),
        date: String(recurringMatch.date || ''),
      },
    };
  }

  // ── Step 6: Insert transaction with 'AI' label ──
  const transactionId = crypto.randomUUID();
  const finalVendorName = formatVendorName(displayVendor);

  // ── Fuel pre-authorisation ──
  // A station announces a round hold ($150, $250, sometimes a $1 ping) and
  // then, when the fill settles at $71.43, often sends nothing. Storing the
  // hold means the month is wrong by the difference, permanently and
  // invisibly. So the row carries a placeholder instead — the user's own median
  // fill at this station when we have the history for one — is never
  // auto-filed, and asks for the real number in Review.
  //
  // Detected here rather than earlier on purpose: every duplicate check above
  // compares against the amount the BANK sent, and substituting sooner would
  // make two separate fills at the same station on the same day look like one
  // notification arriving twice. See App/Lib/Capture/fuelHold.ts.
  //
  // The shape test runs first and costs two regex matches. Only a capture that
  // already looks like a hold is worth a round-trip for the user's fill history,
  // which keeps the added query off the path of every ordinary purchase.
  let priorFills: number[] = [];
  if (isHoldAmount(amount) && isFuelMerchant(`${finalVendorName} ${input.rawNotification || ''}`)) {
    priorFills = await fetchPriorFuelFills(userId, finalVendorName);
  }
  const fuelHold = detectFuelHold({
    vendor: finalVendorName,
    rawText: input.rawNotification,
    amount,
    priorFills,
  });
  const storedAmount = fuelHold ? fuelHold.placeholderAmount : amount;
  if (fuelHold) {
    log.debug(
      `[AI pipeline] Fuel hold at ${finalVendorName}: bank said $${fuelHold.holdAmount}, ` +
      `storing $${storedAmount} (${fuelHold.basis}) pending the real amount`,
    );
  }

  // Claim this purchase before inserting. Two apps reporting the same charge
  // arrive as different notifications, so every guard above lets both through;
  // this is the first point where we know enough to recognise them as one
  // purchase. Whoever claims it inserts, the other backs off.
  const purchaseKey = `${userId}|${captureDay}|${storedAmount.toFixed(2)}|${normalizeVendorForDedup(finalVendorName)}`;
  //
  // This one applies to a forced reprocess as well, unlike the dedup checks at
  // the top. Those ask "have we seen this before?", which a rescan is entitled
  // to answer again. This asks "is another invocation inserting this exact
  // purchase right now?", and the answer is no less true for a rescan — while
  // everything drained from the native queue is marked as a scan, so exempting
  // scans left the whole cold-start path with no concurrency guard at all.
  //
  // Deliberately does NOT mark the notification permanently processed. We are
  // backing off on the strength of another invocation's insert that has not
  // happened yet; if it fails or rolls back, the purchase has to stay
  // recoverable. The invocation that actually writes the row marks it.
  if (!claimPurchase(purchaseKey)) {
    log.debug(`[AI pipeline] Purchase already being inserted by a parallel capture: ${finalVendorName} $${storedAmount}`);
    notificationMarkers.rememberRecent(inMemoryKey);
    return {
      processed: false,
      isTransaction: false,
      vendor: finalVendorName,
      amount: storedAmount,
      bankName: input.bankName,
      skipReason: 'duplicate_fingerprint',
    };
  }
  // AI/parser confidence for this capture — how sure the extraction is, not
  // how sure the categorisation is. Stored on the row so the capture-review UI
  // can show it as a meter, which is the whole reason a low-confidence read is
  // worth keeping: the user can see the app was guessing and correct it.
  const captureConfidence = aiResult?.confidence ?? parsed.confidence ?? null;

  // Auto-filing is one safety decision: only a confident user-authored rule may
  // bypass Review, and uncertain or unusual captures must remain visible.
  const foreignCurrency = parsed.foreignCurrency || null;
  const autoAccepted = canAutoAcceptCapture({
    source: input.channel ?? 'bank',
    optedIn: input.autoAcceptKnownVendors === true,
    hasFuelHold: !!fuelHold,
    hasUncertainExtraction: lowConfidenceExtraction,
    hasPossibleDuplicate: !!softDupMatch,
    hasForeignCurrency: !!foreignCurrency,
    matchConfidence: overrideMatchConfidence,
    hasCategory: !!categoryId,
  });
  if (autoAccepted) {
    log.debug(
      `[AI pipeline] Auto-accepting ${finalVendorName} → ${categoryName} ` +
      `(rule confidence ${(overrideMatchConfidence * 100).toFixed(0)}%)`,
    );
  }

  const insertRow: Record<string, unknown> = {
    id: transactionId,
    user_id: userId,
    vendor: finalVendorName,
    // Placeholder rather than the announced figure when this is a fuel hold.
    // The raw notification below still carries what the bank actually said,
    // plus a marker recording the substitution, so nothing is lost.
    amount: storedAmount,
    date: captureDay,
    // Use the same column names as toSupabaseTransaction (the known-working manual insert path)
    budget: categoryName || 'Other',
    type: 'Automatic',
    // Mark notification-inserted rows so the dedup logic can distinguish
    // them from executor-spawned rows of the same vendor+amount.
    source: 'notification',
    recur: parsed.recurrence,
    is_projected: false,
    // Store the original raw notification text so the <> page reviewer
    // can show "what did the parser see?" — and the user can correct
    // the vendor from the source. Truncate to 4KB to avoid hitting
    // any text column limits.
    // Three markers ride here now. The fuel one records a substituted amount;
    // the capture one records which route the alert arrived by; the notif-id
    // one records which Android notification announced this row, so it can be
    // found and cleared once the user deals with the row in the app (see
    // app/lib/capture/captureNotificationMarker.ts). None needs a migration, and the
    // slice leaves room for all three.
    raw_notification: withNotificationIdIfKnown(
      withCaptureMarker(
        fuelHold
          // Record the substitution in the row itself. This is what lets the UI
          // recognise a placeholder later without a schema migration, and it
          // keeps the bank's original wording alongside what we stored instead.
          ? withFuelHoldMarker((input.rawNotification || '').slice(0, 3800), fuelHold)
          : (input.rawNotification || '').slice(0, 3900),
        { channel: input.channel ?? 'bank', packageName: input.bankAppId, notifiedAt: notifTimestamp },
      ),
      input.captureNotificationId,
    ),
    confidence: captureConfidence,
    // Only set when filing on arrival, so it never enters the review queue.
    // Omitted otherwise so a normal capture's insert keeps exactly the shape it
    // had before auto-accept existed — the column's own default is false, and
    // naming it unconditionally would make every insert depend on it.
    //
    // Not deleted or hidden: an auto-filed row lands in history and counts
    // toward the budget exactly like one the user accepted by hand.
    //
    // `auto_filed` rides along with it, and is the only thing that later
    // distinguishes a row the user never saw from one they reviewed and filed
    // themselves. Without it an auto-filed capture left no trace anywhere: the
    // review list said "All caught up" while purchases were being recorded, and
    // the user re-entered them by hand a minute later. The "Filed
    // automatically" card reads this.
    ...(autoAccepted ? { caught_cleared: true, auto_filed: true } : {}),
  };
  const txError = await insertNotificationTransaction(
    insertRow,
    async (row) => {
      const { error } = await supabase.from('transactions').insert(row);
      return { error };
    },
  );

  if (txError) {
    log.error('[AI pipeline] Error inserting transaction:', txError);
    return {
      processed: true,
      isTransaction: true,
      vendor: finalVendorName,
      amount,
      rejectionReason: 'Failed to save transaction',
      bankName: input.bankName,
    };
  }

  // ── Step 6b: Post-insert race-recovery ──
  // The in-memory key + in-flight set + pre-insert DB check above catch
  // most re-broadcasts, but there's still a race window: if two
  // notifications for the same charge arrive in the same instant (e.g.
  // both the native `onListenerConnected` scan and the JS useEffect's
  // `scanActiveNotifications` fire at app start), both invocations can
  // pass Step 1's pre-insert check BEFORE either has actually written
  // its row. They then both proceed to Step 6 and both insert — the
  // exact double-capture bug the user is hitting.
  //
  // Recovery: immediately after our insert completes, re-query the
  // transactions table for every row matching our vendor + amount + date,
  // ours included, and let exactly one of them win.
  //
  // Reading our own row back is the whole point. The original version asked
  // only "does another row like this exist?" and rolled itself back if one
  // did — which is correct when the other row was already there, and
  // catastrophic when both rows were inserted at the same moment: each
  // invocation saw the other as pre-existing, each deleted its own insert,
  // and the purchase disappeared completely with both sides believing they
  // had merely avoided a duplicate.
  //
  // So the winner is chosen by a rule both sides compute identically —
  // oldest `created_at`, ties broken on id — rather than by "the other one".
  // Every interleaving then leaves exactly one row: whoever queries early
  // enough to see only itself keeps its row, and anyone who sees the pair
  // agrees on which of them survives.
  //
  // We compare vendor after normalization so that two surface forms of the
  // same merchant (e.g. "AMZN MKTP" vs "Amazon Prime") are recognized as the
  // same charge.
  const { data: raceCheck } = await supabase
    .from('transactions')
    .select('id, vendor, amount, date, created_at')
    .eq('user_id', userId)
    .eq('date', captureDay)
    .eq('amount', storedAmount);

  if (raceCheck && raceCheck.length > 1) {
    const normalizedOur = normalizeVendorForDedup(finalVendorName);
    const sameCharge = raceCheck.filter(
      (row) => normalizeVendorForDedup(row.vendor) === normalizedOur,
    );
    // Our own row missing from a read taken after our own successful insert
    // means we cannot establish an order, so we keep it. A visible duplicate
    // is something the user can delete in one tap; a purchase deleted on a
    // guess is gone.
    const decision = decideConcurrentCapture(sameCharge, transactionId);
    if (decision.kind === 'rollback') {
      const winner = decision.survivor;
      log.warn(
        `[AI pipeline] ⚠️ Race-recovery: rolling back our insert of ${finalVendorName} $${storedAmount} ` +
        `(${transactionId}) — duplicate of ${winner.id} (${winner.vendor} $${winner.amount}, created ${winner.created_at})`,
      );
      const { error: rollbackError } = await supabase
        .from('transactions')
        .delete()
        .eq('id', transactionId);
      if (rollbackError) {
        log.error('[AI pipeline] Race-recovery rollback failed:', rollbackError);
        // We couldn't roll back, so the user will see both rows. Log
        // loudly so we know to investigate.
      }
      // The winning row is in the ledger, so this notification is captured
      // and must not be imported again.
      notificationMarkers.recordCaptured(inMemoryKey, capturedKey);
      releasePurchase(purchaseKey);
      return {
        processed: true,
        isTransaction: true,
        vendor: finalVendorName,
        amount: storedAmount,
        skipReason: 'duplicate_ai' as const,
        rejectionReason: 'Duplicate detected after insert (race-recovery rollback)',
        bankName: input.bankName,
        // Surface the winning row as the soft-dup so the UI can
        // show the "possible duplicate" badge.
        softDuplicateOf: {
          id: winner.id,
          vendor: winner.vendor,
          amount: Number(winner.amount),
          date: winner.date,
        },
      };
    }

    if (decision.kind === 'keep' && decision.reason === 'insert-survives') {
      log.warn(
        `[AI pipeline] Race-recovery: keeping our insert of ${finalVendorName} $${storedAmount} ` +
        `(${transactionId}); ${sameCharge.length - 1} concurrent duplicate(s) will roll themselves back`,
      );
    }
  }

  releasePurchase(purchaseKey);
  log.debug(`[AI pipeline] Transaction saved: ${finalVendorName} $${storedAmount} → ${categoryName}`);

  // A real charge from this merchant settles any hold it was standing in for,
  // so the question about that hold is never asked. Matched on the merchant
  // and the week and never on the amount — a hold whose figure equalled the
  // charge would be a coincidence, since the figure is the one the station
  // picked rather than the one that was spent.
  settleHold(finalVendorName);
  // An auto-accepted row is already filed, so flagging it "needs a look" would
  // be a contradiction — and the review-queue badge would count a row the list
  // never shows.
  // Persist the capture and queue it for review only when it was not filed
  // automatically; the queue badge must not contradict the saved row.
  notificationMarkers.recordInsertedTransaction(
    inMemoryKey,
    capturedKey,
    transactionId,
    autoAccepted,
  );

  return {
    processed: true,
    isTransaction: true,
    transactionId,
    vendor: finalVendorName,
    amount: storedAmount,
    categoryId,
    categoryName: categoryName || undefined,
    autoAccepted,
    fuelHold: fuelHold || undefined,
    bankName: input.bankName,
    // Surface the soft-dup warning from Step 4 so the UI can show a
    // "possible duplicate" badge. The transaction is still saved — the
    // user said they prefer seeing both rows over missing a charge.
    softDuplicateOf: softDupMatch || undefined,
  };
}
