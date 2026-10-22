import { log } from '../../lib/observability/log';
import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { useQueryClient } from '@tanstack/react-query';
import { AppState, Transaction } from '../../types';
import type { Toast } from '../../types';

import PageShell from '../common/PageShell';

// d3 is only needed for the chart, so it loads as its own chunk rather than
// as part of the entry bundle.
const BudgetFlowChart = React.lazy(() => import('./BudgetFlowChart'));
import TransactionParsing from '../review';
import TransactionActionModal from '../transactions/TransactionActionModal';
import TransactionForm from '../transactions';
import PremiumGate from '../subscription/PremiumGate';
import GuidedTour from '../tour';
import type { TourStage } from '../tour/tourSteps';
import { compareBudgets } from '../../lib/budgets/budgetOrder';
import FirstCaptureModal from '../notifications/FirstCaptureModal';
import { hasSeenFirstCapture, markFirstCaptureSeen, shouldShowFirstCapture } from '../../lib/capture/firstCapture';
import { useVendorOverrides } from '../../lib/vendors/useVendorOverrides';
import { refreshCommunityPack, setCommunityFlags, withdrawAllContributions } from '../../lib/vendors/communityRules';

import DashboardBalanceSection from './DashboardBalanceSection';
import DashboardBudgetSectionsList from './DashboardBudgetSectionsList';
import DashboardBottomBar from '../common/DashboardBottomBar';
import DashboardSettingsModal from '../settings';
import MonthViewBanner from './MonthViewBanner';
import EmptyMonthNote from './EmptyMonthNote';
import SearchResults from './SearchResults';

import useNormalizedTransactions from './useNormalizedTransactions';
import useDashboardTotals from './useDashboardTotals';
import { getLocalMonthKey, getLocalToday } from '../../lib/time/dateUtils';
import { callRpc } from '../../lib/api/apiHelpers';
import {
  householdIncome,
  householdBudgets,
  defaultHouseholdView,
  transactionsForView,
  budgetsForView,
  incomeForView,
  type HouseholdView,
  type PartnerSummary,
} from '../../lib/budgets/householdSharing';
import HouseholdViewButton from './HouseholdViewButton';
import { useHouseholdViewChoice } from '../../hooks/useHouseholdViewChoice';
import { HouseholdPeopleContext, partnerLabelFrom, initialOf } from '../transactions/householdPeople';
import { useCurrentDay } from '../../hooks/useCurrentDay';
import { useBackHandler } from '../../hooks/useBackHandler';
import { useMonthSelection } from './useMonthSelection';
import { balanceLabelForMonth, remainingForMonth } from '../../lib/time/monthWindow';
import { isInMonth } from '../../lib/transactions/transactionOrdering';
import { checkAndTriggerAppNotifications } from '../../lib/native/appNotifications';
import { supabase } from '../../lib/api/supabase';
import { resolveBudgetIdFromRow } from '../../lib/api/transactionMappers';
import { useNotificationRoute } from './useNotificationRoute';

/**
 * What the walkthrough puts in the add form, so its four controls can be
 * explained with none of them greyed out. Never saved: the tour's own step
 * says so, and its overlay swallows the tap on Confirm.
 */
const TOUR_EXAMPLE_ENTRY = { vendor: 'Second Cup', amount: 9.51 };
import { buildWidgetSnapshot } from '../../lib/native/widgetSnapshot';
import { pushWidgetSnapshot, pushRecurringCharges, type WidgetVendorRule } from '../../lib/native/covaultNotification';
import { countAwaitingReview } from '../../lib/capture/reviewQueue';
import { computeShieldBreakdown, type ShieldBreakdown } from '../../lib/budgets/discretionaryShield';
import { collectRecurringCharges } from '../../lib/transactions/recurringSchedule';
import { useAIModelOnDevice } from './useAIModelOnDevice';
import { SettingSaveQueue } from '../../lib/settings/settingSaveQueue';
import { prefetchNotificationRules } from '../../lib/capture/queries/notificationRules';

// Stable identity: a fresh `{ total: 0, contributors: [] }` every render would
// defeat memo(BudgetSection) for the Leisure card on every keystroke elsewhere.
const NO_SHIELD: ShieldBreakdown = { total: 0, contributors: [] };

interface VendorHistoryItem {
  vendor: string;
  budget_id: string;
}

interface Props {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  onAddTransaction: (t: Transaction) => void;
  /** Resolves false when the change could not be saved (and was undone). */
  onUpdateTransaction: (t: Transaction) => void | Promise<void | boolean>;
  onDeleteTransaction: (id: string) => void;
  onSignOut: () => Promise<void>;
  onDeleteAccount: () => Promise<void>;
  saveBudgetLimit: (categoryId: string, newLimit: number) => Promise<void>;
  saveUserIncome: (income: number) => Promise<void>;
  saveTheme: (theme: 'light' | 'dark') => Promise<void>;
  saveBudgetVisibility: (categoryId: string, visible: boolean) => Promise<void>;
  saveDashboardSetting: (key: string, value: boolean | string | number) => Promise<void>;
  /** Mints a fresh link code on this account. Linking is code-only — see
   *  VaultSharingSection for why an email route no longer exists. */
  onGenerateLinkCode: () => Promise<string | null>;
  onJoinWithCode: (code: string) => Promise<{ ok: boolean; message?: string; partnerName?: string }>;
  /** Whether the partner has used this phone's code yet. */
  onCheckForPartner?: () => Promise<{ linked: boolean; partnerName?: string }>;
  onUnlinkPartner: () => Promise<void>;
  onRefreshNotifications?: () => Promise<void>;
  onReloadTransactions?: (userId: string) => Promise<void>;
  /** Raise a transient toast (used for the Undo after filing a captured row). */
  onToast?: (toast: Toast) => void;
}

/**
 * The dashboard's "not capturing yet" line, dismissed for good.
 *
 * Device-local and not per-user: it is a nudge about this phone's Android
 * permissions, and re-raising it for the second person on a shared handset
 * would be nagging about something already done.
 */
const CAPTURE_NUDGE_KEY = 'covault_capture_nudge_dismissed_v1';

const Dashboard: React.FC<Props> = ({
  state,
  setState,
  onAddTransaction,
  onUpdateTransaction,
  onDeleteTransaction,
  onSignOut,
  onDeleteAccount,
  saveBudgetLimit,
  saveUserIncome,
  saveTheme,
  saveBudgetVisibility,
  saveDashboardSetting,
  onGenerateLinkCode,
  onJoinWithCode,
  onCheckForPartner,
  onUnlinkPartner,
  onRefreshNotifications,
  onReloadTransactions,
  onToast,
}) => {
  const [showParsing, setShowParsing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const settingSaveQueue = useRef(new SettingSaveQueue());
  useEffect(() => {
    settingSaveQueue.current.clear();
  }, [state.user?.id]);
  // Set when the settings modal is opened with one section in mind, so the user
  // lands on it rather than at the top of a long modal.
  const [settingsTarget, setSettingsTarget] = useState<string | undefined>(undefined);
  // The "purchases aren't being captured yet" line, put away for good.
  const [captureNudgeDismissed, setCaptureNudgeDismissed] = useState(() => {
    try {
      return localStorage.getItem(CAPTURE_NUDGE_KEY) === '1';
    } catch {
      // Storage blocked: show it. A line the user can dismiss is a smaller
      // cost than a first user never finding capture at all.
      return false;
    }
  });

  // The reading model, kept on this phone rather than fetched mid-capture.
  // Held here rather than in the settings modal so the one download it needs
  // happens while the app is simply open, at a quiet moment on a connection
  // that is not metered — see useAIModelOnDevice.
  const aiModel = useAIModelOnDevice(true);
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [showTransactionForm, setShowTransactionForm] = useState(false);
  /** The walkthrough, reopened from Settings. */
  const [showTour, setShowTour] = useState(false);
  /** The one-time note when the first captured purchase lands. */
  const [showFirstCapture, setShowFirstCapture] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [remoteVendorHistory, setRemoteVendorHistory] = useState<VendorHistoryItem[]>([]);
  const [expandedBudgets, setExpandedBudgets] = useState<Set<string>>(new Set());
  // Bumped each time Review is opened from a notification or the widget pill.
  // A counter rather than a boolean so two taps in a row both replay the
  // light — a flag already true is not a change and nothing would happen.
  const [reviewHighlightNonce, setReviewHighlightNonce] = useState(0);

  // Leaving Review puts the nonce back to "nobody sent me here". Without this
  // the counter stays raised for the rest of the session, and the next time
  // the user opens Review themselves the page would scroll and light up as
  // though a notification had sent them — an arrival they didn't make.
  const closeParsing = useCallback(() => {
    setShowParsing(false);
    setReviewHighlightNonce(0);
  }, []);

  // Single source of truth for "now": ticks over at local midnight and on
  // resume, so every month-scoped derivation below moves together.
  const todayIso = useCurrentDay();
  const monthKey = todayIso.slice(0, 7);

  // Which of the seven months on the chart's rail is on screen. `monthKey` is
  // always the month we are really in; `viewMonthKey` is the one being read.
  // Everything the user looks at follows the second; everything that leaves
  // this screen — the widget, the notifications — stays on the first.
  const {
    viewMonthKey,
    isCurrentMonth: isViewingCurrentMonth,
    relation: viewMonthRelation,
    selectMonth,
    resetToCurrentMonth,
  } = useMonthSelection(monthKey);

  /**
   * The home button, from either screen.
   *
   * It used to be `closeParsing` alone, which on the home screen sets two
   * pieces of state to the values they already hold — so React bailed out of
   * both and the button did nothing at all. Pressed with a budget open, with a
   * search half typed, or with a sheet up, it was dead.
   *
   * Home now means what it looks like it means: put the screen back to how it
   * looks when you arrive. The vial collapses on the same 320ms clock a tap on
   * its own header uses, so the gesture reads identically however it was
   * started.
   */
  const goHome = useCallback(() => {
    closeParsing();
    setExpandedBudgets(new Set());
    setSearchQuery('');
    setIsSearchOpen(false);
    setShowSettings(false);
    setSelectedTx(null);
    setShowTransactionForm(false);
    // Including the month being browsed: home is "put the screen back to how
    // it looks when you arrive", and it arrives on this month.
    resetToCurrentMonth();
  }, [closeParsing, resetToCurrentMonth]);

  // The phone's back button, one step at a time. Registered in the order the
  // user usually gets into things, because the stack answers newest first: out
  // of a search before out of a vial, out of a vial before back to this month,
  // and out of all of it before leaving the page. Dialogs register themselves
  // (see useDialogInteraction) and always sit above these.
  const onHome = !showParsing;
  const searchActive = isSearchOpen || searchQuery.trim() !== '';
  useBackHandler(showParsing, closeParsing);
  useBackHandler(onHome && !isViewingCurrentMonth, resetToCurrentMonth);
  useBackHandler(onHome && expandedBudgets.size > 0, () => setExpandedBudgets(new Set()));
  useBackHandler(onHome && searchActive, () => {
    setSearchQuery('');
    setIsSearchOpen(false);
  });

  const scrollRef = useRef<HTMLDivElement>(null);

  // The widget hands over a budget by name, and the callback that receives it
  // is registered once. Reading budgets through a ref keeps that registration
  // stable — depending on `state.budgets` directly would tear down and
  // re-attach the native route listeners on every data load.
  const budgetsRef = useRef(state.budgets);
  useEffect(() => {
    budgetsRef.current = state.budgets;
  }, [state.budgets]);

  // A capture notification says "tap to review", so land the user there. Any
  // open modal is dismissed first, otherwise the Review page opens behind it
  // and the tap looks like it did nothing.
  useNotificationRoute(
    useCallback(() => {
      setShowSettings(false);
      setSelectedTx(null);
      setShowTransactionForm(false);
      setShowParsing(true);
      // Arriving here from outside means something specific is waiting. The
      // page alone doesn't say which rows those are once there is a mix of
      // filed and unfiled ones, so ask the list to run its light around them.
      setReviewHighlightNonce((n) => n + 1);
    }, []),
    // Tapping a category row on the home-screen widget lands on that budget,
    // open. Matched by name because that is all the widget has — it draws from
    // a snapshot of figures, not from budget rows, and has no ids in it.
    // Unknown names are ignored rather than opening something arbitrary: the
    // snapshot can outlive a renamed or deleted budget.
    useCallback((budgetName: string) => {
      setShowSettings(false);
      setSelectedTx(null);
      setShowTransactionForm(false);
      closeParsing();
      setExpandedBudgets((prev) => {
        const match = budgetsRef.current.find(
          (b) => b.name.trim().toLowerCase() === budgetName.trim().toLowerCase(),
        );
        return match ? new Set([match.id]) : prev;
      });
    }, [closeParsing]),
  );

  const normalizedTransactions = useNormalizedTransactions(state.transactions, state.budgets);

  // ── Vendor overrides (for the <VendorCategoryRulesCard> + <LearnedRulesCard>) ──
  const {
    vendorOverrides,
    partnerOverrides,
    handleDeleteVendorOverride,
    handleSetVendorCategory,
    handleSetProperName,
    handleCombineChainRules,
  } = useVendorOverrides({
    userId: state.user?.id,
    partnerId: state.user?.partnerId,
    budgets: state.budgets,
  });

  const {
    currentMonthTransactions,
    projectedTransactions,
    remainingMoney,
    effectiveIncome,
    isIncomeLoaded,
  } = useDashboardTotals(
    normalizedTransactions,
    // The household's income, not the signed-in person's. Two phones using one
    // salary each disagreed about the same pot by exactly the other's income.
    householdIncome(state.user?.monthlyIncome || 0, state.partnerIncome),
    todayIso,
    state.user?.id || '',
    (state.partnerSummary as PartnerSummary | null) ?? null,
  );

  // Whose limits the vials draw, and whose spending fills them. Separate is
  // the default and what most couples do: your own lines, drawn against the
  // household income, with their spending visible but not eating yours.
  const budgetMode = state.settings.budgetMode ?? 'separate';
  const householdBudgetList = useMemo(
    () => householdBudgets(state.budgets, state.partnerBudgets ?? null, budgetMode),
    [state.budgets, state.partnerBudgets, budgetMode],
  );

  // ── Me / Us / Them ──
  //
  // Whose money the chart, the vials and their lists show. Display only: the
  // widget and the over-budget alerts keep following `budgetMode` above, and
  // the balance at the top stays the household's whichever is picked.
  //
  // Offered only when the partner's purchases are actually on this phone. At
  // a sharing level below "every purchase" their rows are refused, so "Them"
  // would be an empty screen and "Us" would be only you; the dashboard then
  // stays on what the budget mode shows, exactly as before the switch existed.
  const myUserId = state.user?.id || '';
  const canChooseView = !!state.user?.partnerId && !state.partnerSummary;
  // Opens on Us, and goes back to it whenever the app is left and returned to.
  const [chosenView, setChosenView] = useHouseholdViewChoice();
  const householdView: HouseholdView = canChooseView
    ? chosenView ?? 'us'
    : defaultHouseholdView(budgetMode);
  const partnerLabel = partnerLabelFrom(state.user?.partnerName);
  const myInitial = initialOf(state.user?.name);
  const partnerInitial = initialOf(partnerLabel);
  const householdPeople = useMemo(
    () => ({ myUserId, partnerLabel, myInitial, partnerInitial }),
    [myUserId, partnerLabel, myInitial, partnerInitial],
  );
  const viewBudgetList = useMemo(
    () => budgetsForView(state.budgets, state.partnerBudgets ?? null, householdView),
    [state.budgets, state.partnerBudgets, householdView],
  );
  const viewIncome = incomeForView(
    state.user?.monthlyIncome || 0,
    state.partnerIncome,
    householdView,
  );
  const activityLabel = state.user?.budgetingSolo
    ? 'Activity'
    : householdView === 'me'
      ? 'My Activity'
      : householdView === 'them' ? `${partnerLabel}’s Activity` : 'Our Activity';

  // ── Home-screen widget ──
  // The widget runs in the native process with no Supabase session, so it can
  // only draw what we hand it. Push a fresh snapshot whenever the figures it
  // shows change — which covers app open, a reload after capture, a category
  // correction, and a theme switch.
  //
  // The vendor rules ride along so the native notification listener can
  // categorise a purchase captured while the app is closed and nudge the donut
  // without waiting for the next launch.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const snapshot = buildWidgetSnapshot({
      budgets: state.budgets,
      currentMonthTransactions,
      remaining: remainingMoney,
      income: state.user?.monthlyIncome || 0,
      theme: state.settings.theme ?? null,
      // Same selector the Review list and the bottom-bar badge use, so the
      // widget's pill can't disagree with either.
      pendingReview: countAwaitingReview(state.transactions),
    });
    // The user's OWN rules, and deliberately nothing else. The native matcher
    // (native/android/WidgetDeltaStore.java) carries its own auto-file
    // threshold and runs with the app closed — a borrowed rule pushed here
    // would file money with nobody watching, which is the one thing the shared
    // layers refuse to do. Borrowed rules become the user's own by being
    // accepted once in Review, and they arrive here on that same load.
    const rules: WidgetVendorRule[] = vendorOverrides.map((vo) => ({
      matchKey: vo.match_key || vo.proper_name,
      matchType: vo.match_type || 'exact',
      // category_id holds the category *name* in this table (see SETUP.md).
      category: vo.category_name || vo.category_id,
    }));
    void pushWidgetSnapshot(snapshot, rules, state.settings.auto_accept_known_vendors === true);
  }, [
    state.budgets,
    currentMonthTransactions,
    remainingMoney,
    state.user?.monthlyIncome,
    state.settings.theme,
    vendorOverrides,
    state.transactions,
    state.settings.auto_accept_known_vendors,
  ]);

  // ── The community pool: the two switches, mirrored where capture can see them ──
  //
  // The capture pipeline runs with the app closed and cannot read React state,
  // so both answers are mirrored to device storage whenever the settings row
  // loads or changes. A phone that has never seen the row falls back to the
  // safe defaults — receive, do not send.
  //
  // Turning contribution OFF withdraws everything already contributed, not just
  // future pairs. An opt-out that left the old contributions in the pool for
  // good would make the switch a lie.
  const contributedBefore = useRef<boolean | null>(null);
  useEffect(() => {
    const enabled = state.settings.community_rules_enabled !== false;
    const contribute = state.settings.community_rules_contribute === true;
    setCommunityFlags({ enabled, contribute });

    const was = contributedBefore.current;
    contributedBefore.current = contribute;
    if (was === true && !contribute) {
      void withdrawAllContributions(state.user?.id);
    }

    // Refresh the downloaded pack — at most daily, and never a per-purchase
    // lookup: a query at capture time would tell the server where this
    // household had just shopped, which is the one thing this layer must not
    // do. See App/Lib/Vendors/communityRules.ts.
    if (enabled) void refreshCommunityPack();
  }, [
    state.settings.community_rules_enabled,
    state.settings.community_rules_contribute,
    state.user?.id,
  ]);

  // ── Charges the listener should stay quiet about ──
  // A subscription is announced by the bank AND already on Covault's books, so
  // the capture notification tells the user about money they have accounted
  // for. The pipeline knows not to create a second row, but it only runs when
  // the app does — the notification is posted by the native listener the
  // instant the alert lands. Handing it the user's recurring charges is what
  // lets it decline to announce one.
  //
  // Read from the full transaction list rather than this month's: a monthly
  // template can sit in any month, and the point is to recognise the charge
  // whenever it arrives.
  //
  // Serialised into the effect's dependency so a write to native storage only
  // happens when the SET of subscriptions changes. The transaction list changes
  // on every capture and edit; the household's subscriptions change a few times
  // a year, and each push is a synchronous disk commit on the native side.
  const recurringChargesKey = useMemo(
    () =>
      JSON.stringify(
        collectRecurringCharges(
          state.transactions.map((tx) => ({
            vendor: tx.vendor,
            amount: tx.amount,
            date: tx.date,
            recur: (tx as any).recur ?? tx.recurrence ?? null,
            source: (tx as any).source ?? null,
          })),
        ),
      ),
    [state.transactions],
  );

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    void pushRecurringCharges(JSON.parse(recurringChargesKey));
  }, [recurringChargesKey]);

  // The vials show the current month and nothing else. Both halves of that
  // list — real transactions and projected occurrences — are filtered here
  // against the SAME month key, derived from the same `todayIso` that
  // useDashboardTotals uses.
  //
  // They used to come from two different clocks: the real half was filtered
  // inside useDashboardTotals against a month key recomputed during render,
  // the projected half against a `monthKey` held in state that only advanced
  // on resume. Any disagreement between the two put last month's rows in this
  // month's list — which is exactly what a Jul 31 entry sitting in an August
  // vial looks like.
  const currentMonthBudgetTransactions = useMemo(() => {
    const inCurrentMonth = (t: Transaction) => isInMonth(t, monthKey);

    return [
      ...currentMonthTransactions.filter(inCurrentMonth),
      ...projectedTransactions.filter(inCurrentMonth),
    ];
  }, [currentMonthTransactions, projectedTransactions, monthKey]);

  // The chart draws three months forward as well as three back, so it takes
  // EVERY projected occurrence rather than only this month's — otherwise the
  // right-hand half of the rail is a flat line at zero for months that already
  // have known subscriptions in them. The projection stops three months out on
  // its own, which is exactly the width of the rail.
  const chartTransactions = useMemo(() => {
    const existingIds = new Set(normalizedTransactions.map((t) => t.id));
    const projectedAhead = projectedTransactions.filter(
      (t) => typeof t.date === 'string' && !existingIds.has(t.id),
    );

    return [...normalizedTransactions, ...projectedAhead];
  }, [normalizedTransactions, projectedTransactions]);

  // ── The month on screen ──
  //
  // The vials and the headline figure follow the rail; everything that leaves
  // this screen does not. The widget effect above and the overrun
  // notifications below deliberately keep reading `currentMonthTransactions`
  // and `remainingMoney`: a home-screen widget showing March because the phone
  // was left on March, or a "you are over budget" notification about a month
  // that ended, would both be wrong in a way the user could not see from here.
  //
  // Everyone's rows for that month. The household balance is read from this
  // one, so a past month counts the partner's spending too; it used to read
  // the vials' list, which in separate mode had dropped the partner's rows and
  // overstated every browsed month's balance by what they spent.
  const viewMonthAllTransactions = useMemo(() => {
    if (isViewingCurrentMonth) return currentMonthBudgetTransactions;
    const inViewMonth = (t: Transaction) => isInMonth(t, viewMonthKey);
    return [
      ...normalizedTransactions.filter(inViewMonth),
      ...projectedTransactions.filter(inViewMonth),
    ];
  }, [
    isViewingCurrentMonth,
    currentMonthBudgetTransactions,
    normalizedTransactions,
    projectedTransactions,
    viewMonthKey,
  ]);

  // Whose spending fills the vials: the Me / Us / Them view. Its default is
  // what the budget mode always showed — with separate budgets a partner's
  // fuel does not eat yours, so "me"; pooled, "us".
  const viewMonthBudgetTransactions = useMemo(
    () => transactionsForView(viewMonthAllTransactions, myUserId, householdView),
    [viewMonthAllTransactions, myUserId, householdView],
  );

  // The chart draws the same person, or people, as the vials below it, against
  // the same limits and the matching income.
  const viewChartTransactions = useMemo(
    () => transactionsForView(chartTransactions, myUserId, householdView),
    [chartTransactions, myUserId, householdView],
  );

  // ── The Discretionary Shield ──
  //
  // How much of the month's overspending the Leisure vault is absorbing. Read
  // off the SAME list the vials are drawing, so browsing back to March shields
  // March's overspend and not this month's, and so the amount taken out of
  // Leisure is always the amount another vial on screen is over by.
  //
  // Display-only, and deliberately not folded into `viewMonthRemaining`: the
  // headline balance already counts every transaction once, whatever category
  // it landed in, so adding the shielded amount there would count the same
  // overspend twice. This used to be a literal `0`, which is why switching the
  // shield on did nothing at all.
  //
  // The contributors come back on the same pass as the figure, so the sentence
  // the open Leisure card shows and the chunk taken out of its bar cannot
  // disagree.
  const leisureShield = useMemo(() => {
    if (!state.settings.useLeisureAsBuffer) return NO_SHIELD;
    // The vials' own limits, so the shield covers an overspend the vials show.
    return computeShieldBreakdown(viewBudgetList, viewMonthBudgetTransactions, {
      hiddenCategories: state.settings.hiddenCategories,
    });
  }, [
    state.settings.useLeisureAsBuffer,
    state.settings.hiddenCategories,
    viewBudgetList,
    viewMonthBudgetTransactions,
  ]);

  // Same arithmetic as the current month's, over the same list the vials are
  // drawing, so the figure at the top can never disagree with the bars below.
  const viewMonthRemaining = useMemo(
    () => (isViewingCurrentMonth
      ? remainingMoney
      : remainingForMonth(viewMonthAllTransactions, effectiveIncome)),
    [isViewingCurrentMonth, remainingMoney, viewMonthAllTransactions, effectiveIncome],
  );

  // Stable key: changes only when a budget limit is added/removed/modified.
  // Prevents the notification effect from re-running on every array re-creation.
  // Read from the limits the vials actually draw, so a household in combined
  // mode is alerted against the combined line and not one person's half of it.
  const budgetLimitKey = useMemo(
    () => householdBudgetList.map(b => `${b.id}:${b.totalLimit}`).join(','),
    [householdBudgetList],
  );

  // Fire push notifications for budget overruns / low balance whenever the
  // transaction data changes. appNotifications.ts dedupes via localStorage so
  // the same alert won't fire more than once per budget per month.
  //
  // Same limits and same spending as the vials: in separate mode a partner's
  // purchases do not count against your lines (see spendingAgainstMyBudgets),
  // so they must not set off an alert about them either.
  useEffect(() => {
    if (!state.user?.id || !householdBudgetList.length) return;
    checkAndTriggerAppNotifications({
      userId: state.user.id,
      budgets: householdBudgetList,
      transactions: currentMonthBudgetTransactions,
      budgetMode,
      remainingMoney,
      settings: {
        app_notifications_enabled: state.settings.app_notifications_enabled,
        smart_notifications_enabled: state.settings.smart_notifications_enabled,
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.user?.id,
    budgetLimitKey,
    budgetMode,
    remainingMoney,
    state.settings.smart_notifications_enabled,
    state.settings.app_notifications_enabled,
  ]);

  // Badge count: captures still waiting in Review.
  //
  // Read through the shared selector (app/lib/capture/reviewQueue.ts) rather than filtered
  // here. This used to do its own `label === 'Automatic' && !caught_cleared`,
  // which keeps refunds — so a captured refund made this badge say 3 while the
  // Review page's own badge, its list, and the widget pill all said 2. That
  // disagreement is the whole reason the selector exists; the home screen was
  // the one caller still not using it.
  //
  // Still derived from app state, so it drops as soon as a row is deleted
  // (optimistic removal) or cleared (reload).
  const aiTransactionsCount = useMemo(
    () => countAwaitingReview(state.transactions),
    [state.transactions],
  );

  // The first capture, explained once.
  //
  // Evaluated from the badge count rather than from a capture event, because
  // the alert usually arrives while the app is closed — there is no moment to
  // observe, only a badge that is already at one when the user opens Covault.
  // See app/lib/capture/firstCapture.ts for why "exactly one" is the test.
  //
  // Marked as seen at the moment it is SHOWN, not when it is dismissed: an app
  // killed while the note is on screen has still shown it, and re-showing it
  // would be the app repeating itself about something that is no longer new.
  useEffect(() => {
    const userId = state.user?.id;
    if (!userId || showFirstCapture) return;
    const show = shouldShowFirstCapture({
      userId,
      waitingCount: aiTransactionsCount,
      seen: hasSeenFirstCapture(userId),
    });
    if (!show) return;
    markFirstCaptureSeen(userId);
    setShowFirstCapture(true);
  }, [state.user?.id, aiTransactionsCount, showFirstCapture]);

  // Single pass: the two filters below walked the whole list separately and
  // each called getLocalMonthKey (which allocates a Date) per transaction.
  const { pastTransactions, futureTransactions } = useMemo(() => {
    const past: Transaction[] = [];
    const future: Transaction[] = [];
    for (const t of normalizedTransactions) {
      if (typeof t.date !== 'string') continue;
      const key = getLocalMonthKey(t.date);
      if (key < monthKey) past.push(t);
      else if (key > monthKey) future.push(t);
    }
    return { pastTransactions: past, futureTransactions: future };
  }, [normalizedTransactions, monthKey]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedBudgets(prev => (prev.has(id) ? new Set() : new Set([id])));
  }, []);

  /**
   * Put the app where the walkthrough's next step is talking about.
   *
   * The tour describes four places, and it opens each of them for real rather
   * than drawing an impression of it: the vial it explains is opened through
   * the same `expandedBudgets` a tap sets, so the 320ms animation that plays
   * is the one the user will see every day, and the review page and settings
   * menu it walks through are theirs, with their banks and their switches in
   * them.
   *
   * Only ever called when the stage CHANGES, so a run of steps on one screen
   * does not keep reopening it — reasserting "home" on every home step would
   * close the vial two steps after opening it.
   */
  const handleTourStage = useCallback((stage: TourStage) => {
    setSelectedTx(null);
    setShowTransactionForm(stage === 'add');

    if (stage === 'add') {
      // The form sits over whatever is behind it, so the dashboard is left
      // as it was rather than rearranged underneath a modal nobody can see
      // past. Nothing here saves: the tour's own step says so, and the
      // overlay swallows the tap on Confirm either way.
      setShowSettings(false);
      setShowParsing(false);
      setExpandedBudgets(new Set());
      return;
    }

    if (stage === 'review') {
      setShowSettings(false);
      setExpandedBudgets(new Set());
      setShowParsing(true);
      return;
    }

    setShowParsing(false);
    setShowSettings(stage === 'settings');

    if (stage === 'budget') {
      // The first vial the dashboard actually draws, in the order it draws
      // them — `compareBudgets` is the same sort the list applies, and the
      // hidden ones are not on screen to be pointed at.
      const hidden: string[] = state.settings.hiddenCategories || [];
      const first = [...state.budgets]
        .filter((budget) => !hidden.includes(budget.id))
        .sort(compareBudgets)[0];
      setExpandedBudgets(first ? new Set([first.id]) : new Set());
    } else {
      setExpandedBudgets(new Set());
    }
  }, [state.budgets, state.settings.hiddenCategories]);

  // Which vault the walkthrough's example entry is filed into. Leisure if the
  // household kept it, otherwise whatever the first visible category is —
  // never nothing, or the grid in the form would be explained with no
  // selection in it.
  const tourExampleBudgetId = useMemo(() => {
    const hidden: string[] = state.settings.hiddenCategories || [];
    const visible = state.budgets.filter((budget) => !hidden.includes(budget.id));
    return (visible.find((budget) => budget.name === 'Leisure') ?? visible[0])?.id;
  }, [state.budgets, state.settings.hiddenCategories]);

  const handleUpdateSettings = (key: string, value: any) => {
    const previousValue = state.settings[key as keyof AppState['settings']];
    setState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        [key]: value,
      },
    }));

    if (key === 'theme' && (value === 'light' || value === 'dark')) {
      saveTheme(value).catch((e) => log.error('[Dashboard] saveTheme failed:', e));
    } else if (typeof previousValue === 'boolean' || typeof previousValue === 'string') {
      const userId = state.user?.id;
      void settingSaveQueue.current.enqueue({
        key,
        value,
        previousValue,
        save: saveDashboardSetting,
        onFailure: (lastSavedValue) => {
          setState(current => {
            if (current.user?.id !== userId || current.settings[key as keyof AppState['settings']] !== value) {
              return current;
            }
            return {
              ...current,
              settings: { ...current.settings, [key]: lastSavedValue },
            };
          });
        },
      });
    }
  };

  const vendorHistory = useMemo<VendorHistoryItem[]>(() => {
    const activeUserId = state.user?.id;
    const activeUserName = (state.user?.name || '').trim().toLowerCase();
    const latestByVendor = new Map<string, { vendor: string; budget_id: string; sortKey: number }>();

    normalizedTransactions.forEach((tx) => {
      const belongsToUser = activeUserId
        ? tx.user_id === activeUserId
        : (tx.userName || '').trim().toLowerCase() === activeUserName;
      const vendorName = (tx.vendor || '').trim();
      if (!belongsToUser || !vendorName || !tx.budget_id) return;

      const timestamp = new Date(tx.date || tx.created_at || 0).getTime();
      const normalizedVendor = vendorName.toLowerCase();
      const existing = latestByVendor.get(normalizedVendor);

      if (!existing || timestamp >= existing.sortKey) {
        latestByVendor.set(normalizedVendor, {
          vendor: vendorName,
          budget_id: tx.budget_id,
          sortKey: Number.isFinite(timestamp) ? timestamp : 0,
        });
      }
    });

    remoteVendorHistory.forEach((item) => {
      if (!item.vendor || !item.budget_id) return;
      const normalizedVendor = item.vendor.toLowerCase();
      const existing = latestByVendor.get(normalizedVendor);
      if (!existing) {
        latestByVendor.set(normalizedVendor, {
          vendor: item.vendor,
          budget_id: item.budget_id,
          sortKey: 0,
        });
      }
    });

    return Array.from(latestByVendor.values())
      .sort((a, b) => b.sortKey - a.sortKey)
      .map(({ vendor, budget_id }) => ({ vendor, budget_id }));
  }, [normalizedTransactions, remoteVendorHistory, state.user?.id, state.user?.name]);

  useEffect(() => {
    const userId = state.user?.id;
    if (!userId) {
      setRemoteVendorHistory([]);
      return;
    }

    let cancelled = false;

    const loadVendorHistory = async () => {
      const { data, error } = await supabase
        .from('transactions')
        .select('vendor, budget, date, created_at, user_id')
        .eq('user_id', userId)
        .order('date', { ascending: false })
        .limit(250);

      if (cancelled || error || !data) return;

      const byVendor = new Map<string, VendorHistoryItem>();
      for (const row of data) {
        const vendor = String(row.vendor || '').trim();
        if (!vendor) continue;

        const budgetId = resolveBudgetIdFromRow(row);
        if (!budgetId) continue;

        const key = vendor.toLowerCase();
        if (!byVendor.has(key)) {
          byVendor.set(key, { vendor, budget_id: budgetId });
        }
      }

      setRemoteVendorHistory(Array.from(byVendor.values()));
    };

    loadVendorHistory();

    return () => {
      cancelled = true;
    };
  }, [state.user?.id]);

  useEffect(() => {
    if (!isSearchOpen && !searchQuery.trim()) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const searchField = document.getElementById('search-field');
      const searchResults = document.getElementById('search-results-panel');

      if (searchField?.contains(target) || searchResults?.contains(target)) {
        return;
      }

      setSearchQuery('');
      setIsSearchOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isSearchOpen, searchQuery]);


  // ── Load Review before it is opened ──
  // Once the dashboard has had a few seconds to settle (so this never competes
  // with the launch load), and again the instant a finger lands on the Review
  // button. Either way Review usually opens onto its rules already loaded.
  const queryClient = useQueryClient();
  const prefetchReview = useCallback(
    () => prefetchNotificationRules(queryClient, state.user?.id),
    [queryClient, state.user?.id],
  );
  useEffect(() => {
    const timer = setTimeout(prefetchReview, 3000);
    return () => clearTimeout(timer);
  }, [prefetchReview]);

  // Both screens are built here rather than returned early, so the
  // walkthrough below can sit outside the branch. It drives the app between
  // the dashboard and Review, and an early return put it inside one of the
  // two arms — which unmounted the tour, and its place in the story, the
  // moment it opened the page it was about to describe.
  const parsingScreen = !showParsing ? null : (
      <>
        <TransactionParsing
          walkthrough={showTour}
          reviewHighlightNonce={reviewHighlightNonce}
          enabled={state.settings.notificationsEnabled}
          onToggle={(enabled) =>
            setState(prev => ({
              ...prev,
              settings: {
                ...prev.settings,
                notificationsEnabled: enabled,
              },
            }))
          }
          onBack={closeParsing}
          onGoHome={goHome}
          onOpenCaptureSources={() => {
            setSettingsTarget('settings-notifications-container');
            setShowSettings(true);
          }}
          onRecordSettledHold={(vendor, amount) => {
            // Files under Other and lands in Review like any capture the app
            // is unsure about: the user has told us the amount, not where it
            // belongs, and guessing the category on their behalf would be the
            // second wrong number in a row.
            onAddTransaction({
              id: crypto.randomUUID(),
              user_id: state.user?.id || '',
              vendor,
              amount,
              date: getLocalToday(),
              budget_id: state.budgets.find((b) => b.name === 'Other')?.id
                || state.budgets[0]?.id
                || null,
              is_projected: false,
              label: 'Manual',
              userName: state.user?.name || 'User',
              created_at: new Date().toISOString(),
            } as Transaction);
          }}
          onAddTransaction={() => setShowTransactionForm(true)}
          allTransactions={normalizedTransactions}
          onTransactionTap={setSelectedTx}
          budgets={state.budgets}
          hiddenCategories={state.settings.hiddenCategories}
          onDeleteTransaction={onDeleteTransaction}
          onUpdateTransaction={onUpdateTransaction}
          userId={state.user?.id}
          onRefreshNotifications={onRefreshNotifications}
          onReloadTransactions={onReloadTransactions}
          onToast={onToast}
          vendorOverrides={vendorOverrides}
          partnerOverrides={partnerOverrides}
          partnerName={state.user?.partnerName}
          onDeleteVendorOverride={handleDeleteVendorOverride}
          onSetVendorCategory={handleSetVendorCategory}
          onSetProperName={handleSetProperName}
          onCombineChainRules={handleCombineChainRules}
        />

        {selectedTx && (
          <TransactionActionModal
            transaction={selectedTx}
            budgets={state.budgets}
            hiddenCategories={state.settings.hiddenCategories}
            currentUserName={state.user?.name || ''}
            isSharedAccount={!state.user?.budgetingSolo}
            vendorHistory={vendorHistory}
            onClose={() => setSelectedTx(null)}
            onEdit={onUpdateTransaction}
            onDelete={() => onDeleteTransaction(selectedTx.id)}
          />
        )}

        {showTransactionForm && state.user?.id && (
          <TransactionForm
            onClose={() => setShowTransactionForm(false)}
            onSave={(tx) => {
              onAddTransaction(tx);
              setShowTransactionForm(false);
            }}
            budgets={state.budgets}
            hiddenCategories={state.settings.hiddenCategories}
            userId={state.user.id}
            userName={state.user?.name || ''}
            isSharedAccount={!state.user?.budgetingSolo}
            vendorHistory={vendorHistory}
          />
        )}
      </>
  );

  const homeScreen = showParsing ? null : (
    <>
      <HouseholdPeopleContext.Provider value={householdPeople}>
      <PageShell>
        {/* Balance + settings cog + search: combined in one section */}
        <DashboardBalanceSection
          isSharedAccount={!state.user?.budgetingSolo}
          remainingMoney={viewMonthRemaining}
          balanceLabel={balanceLabelForMonth(
            viewMonthKey,
            monthKey,
            !state.user?.budgetingSolo,
          )}
          monthlyIncome={state.user?.monthlyIncome || 0}
          isIncomeLoaded={isIncomeLoaded}
          searchQuery={searchQuery}
          isSearchOpen={isSearchOpen}
          onSearchQueryChange={(value) => {
            setSearchQuery(value);
            if (value.trim()) setIsSearchOpen(true);
          }}
          onSearchOpenChange={setIsSearchOpen}
          onOpenSettings={() => setShowSettings(true)}
          // Me / Us / Them, opposite the settings cog. It decides what the
          // chart and every vial below are showing; the balance beside it is
          // the household's either way.
          leading={canChooseView ? (
            <HouseholdViewButton
              view={householdView}
              myInitial={myInitial}
              partnerInitial={partnerInitial}
              partnerLabel={partnerLabel}
              onChange={setChosenView}
            />
          ) : undefined}
        />

        {/* Capture is the reason to use this app, and it starts off. A user
            who skipped it in the intro, or who was already here before the
            intro asked, had nothing anywhere telling them it existed — the
            setup lives inside a settings modal nobody had a reason to open.
            One line, dismissable for good, gone the moment capture is on. */}
        {!state.settings.notificationsEnabled && !captureNudgeDismissed && !searchQuery.trim() && (
          <div className="mx-4 lg:mx-6 mb-2 flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-emerald-50/70 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/40">
            <button
              type="button"
              onClick={() => {
                setSettingsTarget('settings-notifications-container');
                setShowSettings(true);
              }}
              className="flex-1 text-left text-[11px] font-bold text-emerald-700 dark:text-emerald-300 tracking-wide"
            >
              Purchases aren't being captured yet — set it up
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => {
                setCaptureNudgeDismissed(true);
                try {
                  localStorage.setItem(CAPTURE_NUDGE_KEY, '1');
                } catch {
                  /* Dismissed for this session at least. */
                }
              }}
              className="shrink-0 p-1 text-emerald-600/50 dark:text-emerald-400/50 active:scale-[0.97] transition-all duration-200"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}

        {searchQuery.trim() ? (
          <SearchResults
            searchQuery={searchQuery}
            currentMonthTransactions={currentMonthTransactions}
            pastTransactions={pastTransactions}
            futureTransactions={futureTransactions}
            allTransactions={normalizedTransactions}
            currentUserName={state.user?.name || ''}
            isSharedAccount={!state.user?.budgetingSolo}
            budgets={state.budgets}
            onTransactionTap={setSelectedTx}
          />
        ) : (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden lg:px-6">
            {/* Chart: full width on desktop.

                `data-tour` sits on this wrapper rather than on the chart
                itself because BudgetFlowChart has two returns — the chart and
                a "no spending data yet" card — and the walkthrough has to be
                able to point at whichever one is on screen. */}
            <div
              data-tour="months"
              className="transition-all duration-500 ease-in-out overflow-hidden shrink-0 max-h-[300px] opacity-100 translate-y-0 mb-2 lg:max-h-none lg:mb-3"
              aria-hidden={false}
            >
              <PremiumGate hasPremium={true}>
                <React.Suspense fallback={<div className="h-full w-full" />}>
                <BudgetFlowChart
                  budgets={viewBudgetList}
                  transactions={viewChartTransactions}
                  monthlyIncome={viewIncome}
                  theme={state.settings.theme}
                  highlightedBudgetId={expandedBudgets.size > 0 ? Array.from(expandedBudgets)[0] : null}
                  currentMonthKey={monthKey}
                  selectedMonthKey={viewMonthKey}
                  onSelectMonth={selectMonth}
                />
                </React.Suspense>
              </PremiumGate>
            </div>

            {/* Which month these vials are, when it is not this one. In the
                flow rather than floating over the list: it is the one thing on
                screen that says the numbers below belong to another month, so
                it must not be something a thumb can scroll past. */}
            {!isViewingCurrentMonth && (
              <MonthViewBanner
                monthKey={viewMonthKey}
                relation={viewMonthRelation}
                onReturnToCurrentMonth={resetToCurrentMonth}
              />
            )}

            {/* An empty current month explains itself rather than looking
                broken. See EmptyMonthNote for why it is this narrow. */}
            {isViewingCurrentMonth &&
              state.settings.notificationsEnabled &&
              viewMonthAllTransactions.length === 0 && <EmptyMonthNote />}

            {/* Budget bars: vertical list on mobile, 2-col grid on desktop */}
            <DashboardBudgetSectionsList
              budgets={viewBudgetList}
              activityLabel={activityLabel}
              transactions={viewMonthBudgetTransactions}
              isCurrentMonth={isViewingCurrentMonth}
              expandedBudgets={expandedBudgets}
              isFocusMode={false}
              focusedBudgetId={null}
              leisureShield={leisureShield}
              settings={state.settings}
              currentUserName={state.user?.name || ''}
              isSharedAccount={!state.user?.budgetingSolo}
              scrollContainerRef={scrollRef}
              onToggleExpand={toggleExpand}
              onTransactionTap={setSelectedTx}
            />
          </div>
        )}

        <div
          aria-hidden="true"
          // Match the fixed bottom bar's height (including the device safe-area
          // inset) so the last budget vial never slides underneath it, plus a
          // small 8px gap so the spacing matches the `gap-2` between vials.
          className="shrink-0 h-[calc(env(safe-area-inset-bottom,0px)+5rem+0.5rem)]"
        />

        <DashboardBottomBar
          onGoHome={goHome}
          onAddTransaction={() => setShowTransactionForm(true)}
          onOpenParsing={() => setShowParsing(true)}
          onPrefetchParsing={prefetchReview}
          activeView="home"
          pendingCount={aiTransactionsCount}
        />

      </PageShell>
      </HouseholdPeopleContext.Provider>

      {showSettings && (
        <DashboardSettingsModal
          aiModel={aiModel}
          isSharedAccount={!state.user?.budgetingSolo}
          settings={state.settings}
          user={state.user}
          onChangeShareLevel={(level) => handleUpdateSettings('shareLevel', level)}
          onChangeBudgetMode={(mode) => {
            // Optimistic on this phone, and written to BOTH rows by the
            // database: whose budgets the vials draw is a property of the
            // household, and two people looking at differently-shaped
            // dashboards for the same money is what this ends.
            const previous = state.settings.budgetMode ?? 'separate';
            setState((prev) => ({
              ...prev,
              settings: { ...prev.settings, budgetMode: mode },
            }));
            void callRpc('set_household_budget_mode', { p_mode: mode }).then((result) => {
              if (!result.ok) {
                log.error('[Dashboard] budget mode failed:', result.message);
                setState((prev) => ({
                  ...prev,
                  settings: { ...prev.settings, budgetMode: previous },
                }));
                // The switch flipping back on its own, with nothing said,
                // reads as a control that is broken rather than a save that
                // failed.
                onToast?.({
                  tone: 'error',
                  message: 'Couldn’t change how your budgets are shared. Please try again.',
                });
              }
            });
          }}
          onGenerateLinkCode={onGenerateLinkCode}
          onJoinWithCode={onJoinWithCode}
          onCheckForPartner={onCheckForPartner}
          budgets={state.budgets}
          transactions={normalizedTransactions}
          onClose={() => {
            setShowSettings(false);
            setSettingsTarget(undefined);
          }}
          scrollToSectionId={settingsTarget}
          onReplayTour={() => {
            setShowSettings(false);
            setSettingsTarget(undefined);
            setShowTour(true);
          }}
          onUpdateSettings={handleUpdateSettings}
          onUpdateUserIncome={(income) => saveUserIncome(income)}
          onDisconnectPartner={onUnlinkPartner}
          onSignOut={onSignOut}
          onDeleteAccount={onDeleteAccount}
          onSaveBudgetLimit={saveBudgetLimit}
          saveBudgetVisibility={saveBudgetVisibility}
          hasPremium={true}
          onSubscribe={() => {}}
          onImportComplete={() => {
            if (state.user?.id && onReloadTransactions) {
              onReloadTransactions(state.user.id);
            }
          }}
        />
      )}

      {selectedTx && (
        <TransactionActionModal
          transaction={selectedTx}
          budgets={state.budgets}
          hiddenCategories={state.settings.hiddenCategories}
          currentUserName={state.user?.name || ''}
          isSharedAccount={!state.user?.budgetingSolo}
          vendorHistory={vendorHistory}
          onClose={() => setSelectedTx(null)}
          onEdit={onUpdateTransaction}
          onDelete={() => onDeleteTransaction(selectedTx.id)}
        />
      )}

      {showTransactionForm && state.user?.id && (
        <TransactionForm
          onClose={() => setShowTransactionForm(false)}
          onSave={(tx) => {
            onAddTransaction(tx);
            setShowTransactionForm(false);
          }}
          budgets={state.budgets}
          hiddenCategories={state.settings.hiddenCategories}
          userId={state.user.id}
          userName={state.user?.name || ''}
          isSharedAccount={!state.user?.budgetingSolo}
          vendorHistory={vendorHistory}
          // During the walkthrough the form arrives filled in: the vault grid
          // and the confirm button are disabled until there is an amount and
          // a vendor, and four controls cannot be explained with three of
          // them greyed out. Nothing is saved — the tour swallows the tap.
          initialValues={
            showTour
              ? { ...TOUR_EXAMPLE_ENTRY, budgetId: tourExampleBudgetId }
              : undefined
          }
        />
      )}

      {showFirstCapture && (
        <FirstCaptureModal
          onShowMe={() => {
            setShowFirstCapture(false);
            setShowParsing(true);
          }}
          onDismiss={() => setShowFirstCapture(false)}
        />
      )}
    </>
  );

  return (
    <>
      {parsingScreen}
      {homeScreen}

      {/* The walkthrough, on its own full-screen layer, outside both screens.

          Outside them because it moves between them: `onStage` opens a vial,
          the review page and the settings menu as the story reaches each one,
          and a tour mounted inside either screen would be torn down the
          instant it navigated. Outside the settings modal for the older
          reason too — it is not clipped by, or stacked under, the modal that
          launched it.

          `surface="live"` because the app it describes is mounted right
          behind this: the spotlight is cut out of the user's own screen, with
          their own figures in it, rather than out of a drawing of one. The
          overlay swallows every tap, so nothing underneath can be triggered
          by accident. */}
      {showTour && (
        <GuidedTour
          surface="live"
          onStage={handleTourStage}
          onFinish={() => {
            setShowTour(false);
            // The tour left the app wherever its last step was — inside the
            // settings menu, as it happens. Home is where it started.
            goHome();
          }}
        />
      )}
    </>
  );
};

export default Dashboard;
