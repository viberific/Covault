// app/lib/native/appNotifications.ts
import { log } from '../observability/log';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { BudgetCategory, Transaction } from '../../types';
import { countedAmount } from '../transactions/refundMatching';
import { spendingAgainstMyBudgets, type BudgetMode } from '../budgets/householdSharing';

export interface NotificationSettingsShape {
  app_notifications_enabled?: boolean;
  smart_notifications_enabled?: boolean;
  /** Read by the notification listener, not by this module. */
  auto_accept_known_vendors?: boolean;
  /**
   * Budget ids the user switched off. Read by the notification listener and
   * handed to the capture pipeline, so the offline category guess never aims
   * at a category the dashboard does not draw. Not used by this module.
   */
  hiddenCategories?: string[];
}

// LocalStorage keys to avoid spamming notifications
/** Current YYYY-MM. Alert keys embed it so the user is re-notified in a
 *  later month. Computed once per check rather than once per budget. */
function currentAlertMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function makeBudgetAlertKey(userId: string, budgetId: string, month: string) {
  return `covault_alert_budget_${userId}_${budgetId}_${month}`;
}

function makeBalanceAlertKey(userId: string, month: string) {
  return `covault_alert_balance_${userId}_${month}`;
}

async function ensurePermission() {
  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      await LocalNotifications.requestPermissions();
    }
  } catch (e) {
    log.error('[appNotifications] permission error', e);
  }
}

/**
 * Ask Android for permission to post notifications, if it hasn't been granted.
 *
 * The same request the budget alerts make, exposed on its own because the
 * notification listener needs it too and nothing was ever asking on its
 * behalf. Posting a capture notification is a precondition of hiding the
 * bank's alert, so a user who never triggered a budget alert had the
 * permission silently missing and tray suppression silently off.
 *
 * On Android 13+ this is POST_NOTIFICATIONS, denied until asked, and reset by
 * a reinstall. Android only shows the prompt once — after a denial this
 * resolves without showing anything, which is why the caller checks the result
 * and offers the settings page instead.
 */
export async function requestPostNotifications(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await ensurePermission();
}

// Android notification icon config.
// `smallIcon` is a monochrome drawable (white on transparent) — the
// system tints it with `iconColor` at render time. Without these, the
// status bar shows a generic "(!)" placeholder and the notification
// looks like it came from an unbranded system app.
const NOTIF_SMALL_ICON = 'ic_stat_dollar';
const NOTIF_ICON_COLOR = '#10B981'; // Covault emerald

async function sendNotification(title: string, body: string) {
  if (!Capacitor.isNativePlatform()) return;

  try {
    await ensurePermission();

    await LocalNotifications.schedule({
      notifications: [
        {
          id: Date.now() % 2147483647,
          title,
          body,
          schedule: { at: new Date(Date.now() + 1000) },
          // Android-only fields — ignored on iOS.
          // See native/android/res/drawable/ic_stat_covault_mono.xml
          // (the new monochrome status-bar vector) and
          // native/android/res/drawable/ic_stat_covault.xml (legacy
          // raster fallback synced by scripts/sync-android.sh).
          smallIcon: NOTIF_SMALL_ICON,
          iconColor: NOTIF_ICON_COLOR,
        },
      ],
    });
  } catch (e) {
    log.error('[appNotifications] schedule error', e);
  }
}

interface CheckArgs {
  userId: string;
  /** The limits the vials draw — the household's, in combined mode. */
  budgets: BudgetCategory[];
  transactions: Transaction[]; // current month transactions
  /**
   * Whose spending counts against those limits. Separate (the default) counts
   * only the signed-in person's rows, exactly as the vials do; without it a
   * partner's groceries set off "Groceries is over its limit" on a phone whose
   * Groceries vial was half full.
   */
  budgetMode?: BudgetMode;
  remainingMoney: number;
  settings: NotificationSettingsShape;
}

/**
 * What has already been said about one budget this month. Stored as the value
 * of its alert key so a warning and an overrun are remembered separately.
 *
 * `'1'` is what every build before this one wrote, for whichever of the two it
 * sent. It is read as the stronger of them so that nobody is told a budget is
 * over twice in the month this ships; from the next month on, a warning no
 * longer silences the overrun that follows it.
 */
type BudgetAlertLevel = 'warn' | 'over';

function alreadyAlerted(stored: string | null, level: BudgetAlertLevel): boolean {
  if (stored === '1' || stored === 'over') return true;
  return level === 'warn' && stored === 'warn';
}

/**
 * Evaluates budget thresholds and fires local notifications.
 * Uses localStorage flags to avoid firing the same alert repeatedly.
 *
 * A budget is warned about once when it reaches 80% of its limit, and told
 * once more if it then goes over. Both used to share a single flag, so the
 * warning at 80% was the last thing the user ever heard that month — however
 * far over the budget then went.
 */
export async function checkAndTriggerAppNotifications({
  userId,
  budgets,
  transactions,
  budgetMode = 'separate',
  remainingMoney,
  settings,
}: CheckArgs) {
  try {
    if (!Capacitor.isNativePlatform()) return;
    if (!settings?.app_notifications_enabled && !settings?.smart_notifications_enabled) return;
    if (!userId) return;

    const alertMonth = currentAlertMonth();

    // Pre-group spend in a single pass. This used to call getSpentForBudget
    // per budget, so the whole month's transaction list was walked once for
    // every budget on every transaction change.
    const spentByBudgetId = new Map<string, number>();
    for (const tx of spendingAgainstMyBudgets(transactions, userId, budgetMode)) {
      if (tx.is_projected) continue; // only real transactions
      if (!tx.budget_id) continue;
      spentByBudgetId.set(tx.budget_id, (spentByBudgetId.get(tx.budget_id) ?? 0) + countedAmount(tx));
    }

    // Check each budget for overspend
    for (const budget of budgets) {
      const limit = Number(budget.totalLimit ?? 0);
      if (!limit || limit <= 0) continue;

      const spent = spentByBudgetId.get(budget.id) ?? 0;
      const ratio = spent / limit;

      if (ratio >= 0.8) {
        const key = makeBudgetAlertKey(userId, budget.id, alertMonth);
        const level: BudgetAlertLevel = ratio >= 1 ? 'over' : 'warn';
        const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
        if (!alreadyAlerted(stored, level)) {
          const title = level === 'over' ? 'Budget exceeded' : 'Budget warning';
          const body = level === 'over'
            ? `${budget.name} is over its limit ($${spent.toFixed(0)} of $${limit.toFixed(0)}).`
            : `${budget.name} is at ${Math.round(ratio * 100)}% of its limit ($${spent.toFixed(0)} of $${limit.toFixed(0)}).`;
          await sendNotification(title, body);
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(key, level);
          }
        }
      }
    }

    // Check remaining balance
    // Strictly below zero: a balance of exactly $0 has not gone negative, and
    // the alert is remembered for the month, so firing it early also spent it.
    if (remainingMoney < 0) {
      const key = makeBalanceAlertKey(userId, alertMonth);
      const alreadySent =
        typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1';
      if (!alreadySent) {
        await sendNotification(
          'Balance alert',
          `Your remaining balance (-$${Math.abs(remainingMoney).toFixed(0)}) has gone negative.`,
        );
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(key, '1');
        }
      }
    }
  } catch (e) {
    log.error('[appNotifications] check error', e);
  }
}

/**
 * Send a push notification when a partner adds a transaction.
 */
export async function sendPartnerActivityNotification(
  partnerName: string,
  vendor: string,
  amount: number,
  settings: NotificationSettingsShape,
) {
  if (!Capacitor.isNativePlatform()) return;
  if (!settings?.smart_notifications_enabled) return;

  await sendNotification(
    'Partner Activity',
    `${partnerName} added $${Math.abs(amount).toFixed(2)} at ${vendor}.`,
  );
}


/**
 * Send a local notification when Covault AI auto-captures an expense
 * from a bank notification. Helps the user notice charges got logged
 * without them having to open the app.
 *
 * Gated on `app_notifications_enabled` so users who turned off
 * app-level notifications don't get surprised. The notification is
 * tagged with the transaction ID as its system notification ID so
 * that:
 *   - Re-firing for the same transaction (e.g. from a manual rescan
 *     that won the race-recovery) overwrites the existing
 *     notification instead of stacking.
 *   - Tapping the notification can be associated back to the
 *     transaction in future deep-linking work.
 */
export async function sendExpenseCapturedNotification(
  transactionId: string,
  vendor: string,
  amount: number,
  categoryName: string | null,
  settings: NotificationSettingsShape,
  /**
   * True when auto-accept filed this row without review. Worth distinguishing:
   * an auto-filed transaction never appears in Review, so this notification is
   * the only place the user is told it happened.
   */
  autoAccepted = false,
  /**
   * Set when the amount is a fuel-hold placeholder rather than a real charge.
   * Worth its own wording: with the app closed this notification is the only
   * chance to say the number is provisional, and "Expense captured! $100" reads
   * as a fact.
   */
  fuelHold?: { holdAmount: number } | null,
): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  if (!settings?.app_notifications_enabled) return false;

  // Negative amounts are refunds/income — the user said they prefer
  // to be notified about "captured" expenses, which is the common
  // case. Refunds also get a notification but with a different title
  // so the user knows it's money coming back, not going out.
  const isIncome = amount < 0;
  const absAmount = Math.abs(amount);
  const categorySuffix = categoryName ? ` → ${categoryName}` : '';
  const body = fuelHold
    ? `${vendor} held $${fuelHold.holdAmount.toFixed(2)}. Saved $${absAmount.toFixed(2)} for now — open Covault to enter what you paid.`
    : isIncome
      ? `+$${absAmount.toFixed(2)} at ${vendor}${categorySuffix}.`
      : `$${absAmount.toFixed(2)} at ${vendor}${categorySuffix}.`;
  const title = fuelHold
    ? 'Gas hold captured'
    : isIncome
      ? 'Income captured!'
      : autoAccepted
        ? (categoryName ? `Filed to ${categoryName}` : 'Filed automatically')
        : 'Expense captured!';

  try {
    await ensurePermission();
    const id = captureNotificationId(transactionId);

    await LocalNotifications.schedule({
      notifications: [
        {
          id,
          title,
          body,
          schedule: { at: new Date(Date.now() + 1000) },
          smallIcon: NOTIF_SMALL_ICON,
          iconColor: NOTIF_ICON_COLOR,
          // Tapping a capture should land on the Review page, same as the
          // native listener's notification. Read back in
          // addNotificationTapListener.
          extra: { route: NOTIFICATION_ROUTE_REVIEW },
        },
      ],
    });
    return true;
  } catch (e) {
    log.error('[appNotifications] expense-captured schedule error', e);
    return false;
  }
}

/**
 * The system notification id for a captured transaction.
 *
 * Derived from the transaction's UUID rather than stored, so the notification
 * can be found again from nothing but the row — which is what lets the app
 * take it down when the user deals with that purchase. A LocalNotifications id
 * is a 32-bit int, so the UUID is hashed into the positive range. Reusing one
 * id per transaction also means a pipeline that runs twice (an app restart
 * with a stale listener) replaces its own notification rather than posting a
 * second.
 */
export function captureNotificationId(transactionId: string): number {
  let id = 0;
  for (let i = 0; i < transactionId.length; i++) {
    id = ((id * 31) + transactionId.charCodeAt(i)) | 0;
  }
  return Math.abs(id);
}

/**
 * Take down the "Expense captured!" notice for a transaction.
 *
 * Called when the user has dealt with that purchase inside the app — filed it,
 * renamed it, cleared it or deleted it. A notification whose whole message is
 * "tap to review" has nothing left to say once the reviewing is done, and one
 * that sits in the shade after the work is finished reads as an app that is
 * not paying attention.
 *
 * Best-effort and silent: the notification may already be gone (the user
 * swiped it, or tapped it, which dismisses it), and there is nothing to tell
 * them about that.
 */
export async function dismissCaptureNotification(transactionId: string): Promise<void> {
  if (!Capacitor.isNativePlatform() || !transactionId) return;
  try {
    await LocalNotifications.cancel({
      notifications: [{ id: captureNotificationId(transactionId) }],
    });
  } catch (e) {
    log.debug('[appNotifications] dismiss failed (already gone?)', e);
  }
}

/** Destination carried in a notification's `extra`, mirroring the native side. */
export const NOTIFICATION_ROUTE_REVIEW = 'review';

/**
 * Call `onRoute` when the user taps a notification that names a destination.
 *
 * Only covers notifications this module scheduled, and only while the WebView
 * is alive. The ones the native listener posts (which are the ones that arrive
 * with the app closed) carry their destination as an intent extra instead —
 * see `consumePendingRoute` in covaultNotification.ts. Both paths are needed:
 * this one for a tap while the app is running, that one for a cold start.
 *
 * Returns a cleanup function; safe to call on web, where it is a no-op.
 */
export function addNotificationTapListener(
  onRoute: (route: string) => void,
): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};
  let remove: (() => void) | null = null;
  let cancelled = false;

  LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
    const route = (event?.notification?.extra as { route?: unknown } | undefined)?.route;
    if (typeof route === 'string' && route) onRoute(route);
  })
    .then((handle) => {
      if (cancelled) handle.remove();
      else remove = () => handle.remove();
    })
    .catch((e) => log.warn('[appNotifications] tap listener setup failed', e));

  return () => {
    cancelled = true;
    remove?.();
  };
}