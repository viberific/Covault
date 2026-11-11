export interface User {
  id: string;
  name: string;
  email: string;
  partnerId?: string;
  partnerEmail?: string;
  partnerName?: string;
  hasJointAccounts: boolean;
  budgetingSolo: boolean;
  monthlyIncome: number;
  trial_started_at?: string | null;
  trial_ends_at?: string | null;
  trial_consumed?: boolean;
  subscription_status?: 'none' | 'active' | 'expired';
  /** Manually flipped in the database for accounts that never pay. */
  is_tester?: boolean;
}

export interface BudgetCategory {
  id: string;
  name: string;
  totalLimit: number;
  externalDeduction?: number;
  /**
   * How much of `totalLimit` was carried over from last month by Budget
   * Rollover. Display-only: set on the list the vials draw, never saved.
   */
  carriedOver?: number;
}

// (Removed: PendingTransaction and AppState.pendingTransactions.)
//
// They described a `pending_transactions` table that does not exist in the
// database, so the read that filled the queue could never return a row and
// everything built on it was unreachable rather than merely failing. Captured
// purchases land in `transactions` and the review list reads them from there.


// Ignored transaction rule type removed — table deleted from backend

export enum Recurrence {
  ONE_TIME = 'One-time',
  BIWEEKLY = 'Biweekly',
  MONTHLY = 'Monthly',
  YEARLY = 'Yearly',
}

export enum TransactionLabel {
  AUTOMATIC = 'Automatic',
  MANUAL = 'Manual',
}

/** Where a transaction came from. Used by the dedup logic to distinguish
 *  "two real charges in the same month" from "same charge, different day". */
export type TransactionSource = 'executor' | 'notification' | 'manual' | 'import';

export interface Transaction {
  id: string;
  user_id: string;
  vendor: string;
  amount: number;
  date: string;
  budget_id: string | null;
  recurrence?: Recurrence | 'One-time' | 'Biweekly' | 'Monthly' | 'Yearly';
  label?: 'Automatic' | 'Manual';
  is_projected: boolean;
  is_income?: boolean;
  caught_cleared?: boolean;
  /**
   * True when the capture pipeline filed this row on arrival, because
   * "file known vendors automatically" is on and a learned rule explained the
   * merchant well enough. Such a row is stored already cleared and never
   * enters the review list, so this is the only record that the user was
   * never shown it — the "Filed automatically" card on the capture page reads
   * it. False for everything filed by hand, and for rows written before the
   * `transactions.auto_filed` column existed.
   */
  auto_filed?: boolean;
  /**
   * AI extraction confidence (0..1) captured by the notification pipeline.
   * Null for manually-entered rows and legacy rows from before the
   * `transactions.confidence` column existed. Surfaced in the capture-review
   * UI as the AI-match confidence meter.
   */
  confidence?: number | null;
  /**
   * True when this expense was refunded by a matched refund notification.
   * The renderer applies strikethrough; the budget reduce excludes the
   * amount from the spent total. No separate refund row is inserted.
   */
  refunded?: boolean;
  /**
   * The original raw notification text that produced this transaction.
   * Populated by the notification pipeline at insert time. Powers the
   * "<>" page reviewer's "View original notification" expander, which
   * is the source of truth for the parser's vendor correction flow.
   * Legacy rows (pre-migration) and rows created manually may be null.
   */
  raw_notification?: string | null;
  userName?: string;
  created_at: string;
  /** Origin of this row. Populated by the writer (executor/AI/manual/import).
   *  Not persisted on the in-memory type for projected/legacy rows. */
  source?: TransactionSource;
  /** Set by the AI pipeline when the new transaction looks like a soft duplicate
   *  of an existing one (same vendor, different amount). The UI shows a badge.
   *  This is an in-memory only field — never persisted to DB. */
  softDuplicateOf?: {
    id: string;
    vendor: string;
    amount: number;
    date: string;
  };

}

export interface Settings {
  userId: string;
  name: string;
  email: string;
  partnerId?: string;
  partnerEmail?: string;
  partnerName?: string;
  hasJointAccounts?: boolean;
  budgetingSolo?: boolean;
  monthlyIncome?: number;
  rolloverEnabled?: boolean;
  rolloverOverspend?: boolean;
  useLeisureAsBuffer?: boolean;
  showSavingsInsight?: boolean;
  theme?: 'light' | 'dark';
}

export interface AppState {
  user: User | null;
  budgets: BudgetCategory[];
  transactions: Transaction[];
  settings: {
    rolloverEnabled: boolean;
    rolloverOverspend: boolean;
    useLeisureAsBuffer: boolean;
    showSavingsInsight: boolean;
    theme: 'light' | 'dark';
    notificationsEnabled: boolean;
    hiddenCategories: string[]; // IDs of hidden budget categories
    app_notifications_enabled: boolean;
    smart_notifications_enabled: boolean;
    /** Skip review for captures a learned vendor rule confidently matches. */
    auto_accept_known_vendors: boolean;
    /** Light vibration on file/delete. Device-level; respects reduced motion. */
    haptics_enabled: boolean;
    /**
     * Use the community pool's suggestions. On by default: the pack is
     * downloaded and matched on the device, so nothing about this household
     * leaves in order to receive one.
     */
    community_rules_enabled: boolean;
    /**
     * Volunteer this household's own (merchant → category) pairs to the pool.
     * Off until deliberately turned on, and turning it back off withdraws
     * everything already contributed.
     */
    community_rules_contribute: boolean;
    /**
     * How much of your spending a linked partner sees. Yours alone to set and
     * deliberately not symmetric — it is your data. Enforced in the database,
     * not by the screen: below 'transactions' your rows are refused to them
     * outright. See App/Lib/Budgets/householdSharing.ts.
     */
    shareLevel: 'transactions' | 'categories' | 'totals';
    /**
     * Whose budget lines the vials draw. A property of the HOUSEHOLD, so
     * changing it writes both rows — two people looking at differently-shaped
     * dashboards for the same money is the confusion this ends.
     */
    budgetMode: 'separate' | 'combined';
  };
  /**
   * What a linked partner spent this month, when their rows are not readable.
   * Null when there is no partner, or when they share their rows outright and
   * the rows themselves are the answer.
   */
  partnerSummary?: {
    level: 'transactions' | 'categories' | 'totals';
    total: number;
    byCategory: Record<string, number>;
  } | null;
  /** The partner's monthly income, for the household figure. Null if unknown. */
  partnerIncome?: number | null;
  /** The partner's budget limits, read only for the combined mode. */
  partnerBudgets?: BudgetCategory[] | null;
}



/**
 * A transient toast: an error, or an info message with an optional action
 * (e.g. "Undo"). Owned and rendered by App; passed down to screens that need
 * to raise one.
 */
export interface Toast {
  message: string;
  tone: 'error' | 'info';
  action?: { label: string; run: () => void };
  /**
   * The row this message is about, when it names one.
   *
   * `message` is written once, at the moment the action happened, so the
   * vendor name baked into it is the name as it was then. Renaming the row
   * while the strip is still up left the bottom of the screen insisting on the
   * old name — which reads as the rename not having saved. With this set, the
   * name is re-read from live state on every render; see
   * App/Lib/Ui/toastSubject.ts.
   */
  subject?: { transactionId: string; vendor: string };
}
