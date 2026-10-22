import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core'; // Added safety check
import { App as CapApp } from '@capacitor/app';
import Auth from './app/components/Auth';
import Dashboard from './app/components/Dashboard';
import Onboarding from './app/components/Onboarding';
import FullScreenLoader from './app/components/common/FullScreenLoader';
import SubscriptionRequired from './app/components/subscription';
import { getEntitlementStatus } from './app/lib/auth/entitlement';
import { serverNow } from './app/lib/time/serverClock';
import ErrorBoundary from './app/components/common/ErrorBoundary';
import UpdateBanner from './app/components/updates';
import type { AppState, BudgetCategory, Transaction, Toast } from './app/types';
import { supabase } from './app/lib/api/supabase';
import { useAuthState, AuthStatus } from './app/hooks/useAuthState';
import { useDeepLinks } from './app/hooks/useDeepLinks';
import { useHardwareBack } from './app/hooks/useHardwareBack';
import { useNotificationListener } from './app/hooks/useNotificationListener';
import { useNotificationSetupCompletion } from './app/hooks/useNotificationSetupCompletion';
import { covaultNotification, autoDetectAndSaveMonitoredApps } from './app/lib/native/covaultNotification';
import { loadBankingAppsFromDB } from './app/lib/capture/bankingApps';
import { useAppTheme } from './app/hooks/useAppTheme';
import { useAppUpdate } from './app/hooks/useAppUpdate';
import { getInstalledVersionCode } from './app/lib/native/appUpdate';
import { setReportingBuild, setReportingUser } from './app/lib/observability/errorReporting';
import { useUserData } from './app/data/useUserData';
import { markOnboarded } from './app/hooks/onboardingState';
import { noteCaptureEnabled, noteCaptureDisabled } from './app/lib/capture/bankHeartbeat';
import { useFirstPaintCache } from './app/hooks/useFirstPaintCache';
import { preloadAIModel } from './app/lib/ai/aiExtractor';
import { setHapticsEnabled } from './app/lib/native/haptics';
import { log } from './app/lib/observability/log';
import { resolveToastMessage } from './app/lib/ui/toastSubject';
import { callRpc } from './app/lib/api/apiHelpers';
import { appErrorMessage } from './app/lib/ui/appErrorMessage';
import { deleteAccountErrorMessage } from './app/lib/auth/accountDeletion';
import { DEFAULT_SETTINGS } from './app/lib/settings/defaultSettings';
import { isCurrentAccountDataScope, type AccountDataScopeRef } from './app/lib/auth/accountScope';

// `Toast` lives in types.ts because Dashboard and the Review page raise their
// own (e.g. Undo after filing a captured transaction) and importing it from
// here would point them back at their own parent.

const SETTINGS_KEY = 'covault_settings';
const SCAN_PROCESSING_DELAY_MS = 2000;
const SCAN_INTERVAL_MS = 5 * 60 * 1000;

// Fixed: Added check for 'window' so Vercel doesn't crash during build
const loadSettingsFromStorage = () => {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) return JSON.parse(stored);
  } catch (e) {
    log.error('Error loading settings:', e);
  }
  return null;
};

const saveSettingsToStorage = (settings: AppState['settings']) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    log.error('Error saving settings:', e);
  }
};

const App: React.FC = () => {
  const [authState, setAuthState] = useState<AuthStatus>('loading');
  const accountScopeRef = useRef<AccountDataScopeRef['current']>({ userId: null, generation: 0 });
  const renderedAccountScope = accountScopeRef.current;
  // A single toast surfaces transient messages: DB read/write failures
  // (previously discarded, so failures were silent and looked like "nothing
  // happened") and undoable actions like a transaction delete.
  const [toastEntry, setToastEntry] = useState<{
    toast: Toast;
    scope: AccountDataScopeRef['current'];
  } | null>(null);
  const toast = toastEntry && isCurrentAccountDataScope(accountScopeRef, toastEntry.scope)
    ? toastEntry.toast
    : null;
  const setToast = useCallback((nextToast: Toast | null) => {
    // Callbacks retained by an unmounted account must not raise a toast in the
    // next account's session.
    if (!isCurrentAccountDataScope(accountScopeRef, renderedAccountScope)) return;
    setToastEntry(nextToast ? { toast: nextToast, scope: renderedAccountScope } : null);
  }, [renderedAccountScope]);

  useEffect(() => {
    setToastEntry(current => (
      current && !isCurrentAccountDataScope(accountScopeRef, current.scope) ? null : current
    ));
  }, [renderedAccountScope]);

  // Back-compat shim: the data hooks report failures via setDbError(msg).
  const setDbError = useCallback(
    (msg: string | null) => {
      if (msg) console.error('[data] request failed', msg);
      setToast(msg ? { message: appErrorMessage(msg), tone: 'error' } : null);
    },
    [setToast],
  );

  // Auto-dismiss so a toast never lingers. The undo window is a touch
  // shorter than a plain error so the "Undo" doesn't hang around.
  //
  // Measured against the clock, not left to a bare timer. This app is
  // backgrounded rather than closed, and Android freezes the WebView's timers
  // while it is away — so the strip, and its live Undo, could still be sitting
  // there on return, reporting something the user did before they left.
  useEffect(() => {
    if (!toast) return;
    const deadline = Date.now() + (toast.action ? 6000 : 8000);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const arm = () => {
      if (timer !== undefined) clearTimeout(timer);
      const left = deadline - Date.now();
      if (left <= 0) {
        setToast(null);
        return;
      }
      timer = setTimeout(() => setToast(null), left);
    };
    arm();

    const onVisible = () => {
      if (document.visibilityState === 'visible') arm();
    };
    document.addEventListener('visibilitychange', onVisible);

    let removeResume: (() => void) | undefined;
    if (Capacitor.isNativePlatform()) {
      const handle = CapApp.addListener('resume', arm);
      removeResume = () => { void handle.then(h => h.remove()); };
    }

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      removeResume?.();
    };
  }, [toast, setToast]);

  const [appState, setAppState] = useState<AppState>(() => {
    const savedSettings = loadSettingsFromStorage();
    return {
      user: null,
      budgets: [],
      transactions: [],
      settings: { ...DEFAULT_SETTINGS, ...savedSettings },
    };
  });

  // Dashboard components can keep callbacks alive until an async operation
  // finishes, even after their keyed subtree has been removed. Do not let an
  // updater from the old account mutate the new account's root state.
  const setDashboardAppState = useCallback<React.Dispatch<React.SetStateAction<AppState>>>(
    nextState => {
      const scope = renderedAccountScope;
      if (!scope.userId || !isCurrentAccountDataScope(accountScopeRef, scope)) return;
      setAppState(prev => {
        if (!isCurrentAccountDataScope(accountScopeRef, scope) || prev.user?.id !== scope.userId) {
          return prev;
        }
        return typeof nextState === 'function' ? nextState(prev) : nextState;
      });
    },
    [renderedAccountScope],
  );

  const {
    categoriesLoaded,
    loadUserData,
    loadTransactions,
    handleAddTransaction,
    handleUpdateTransaction,
    handleDeleteTransaction,
    handleGenerateLinkCode,
    handleJoinWithCode,
    handleCheckForPartner,
    handleUnlinkPartner,
    saveBudgetLimit,
    saveUserIncome,
    saveTheme,
    saveBudgetVisibility,
    saveSettingToDb,
    saveDashboardSetting,
  } = useUserData({ appState, setAppState, setDbError, accountScopeRef });

  // Deleting raises nothing afterwards. The confirmation says what will go,
  // including the future repeats of a recurring charge, and the user agreed to
  // it a moment earlier — a strip repeating it back is one message too many.
  // The toast element below stays for the things the user did not ask for:
  // errors, and the Undo after a captured purchase files itself.
  const loadUserDataWithState = useCallback(
    async (userId: string, scope: AccountDataScopeRef['current']) => {
      try {
        await loadUserData(userId, scope);
      } catch (error) {
        log.error('[loadUserDataWithState] Error:', error);
      }
    },
    [loadUserData],
  );

  useAuthState({ setAppState, setAuthState, loadUserData: loadUserDataWithState, accountScopeRef });
  useDeepLinks();
  useHardwareBack();

  // Keep a copy of what is on screen so the next launch can draw it before the
  // network answers. See lib/firstPaintCache.ts.
  useFirstPaintCache(appState, accountScopeRef);

  // Pre-load the on-device AI model in the background so the first
  // notification doesn't pay the ~60MB download + WASM init cost. We
  // fire-and-forget; if it fails the AI fallback just won't be available
  // and the regex parser handles everything.
  // The haptics helpers are called from deep in the tree (row accept, bulk
  // accept, delete), so the preference lives in module state rather than being
  // threaded through every call site.
  useEffect(() => {
    setHapticsEnabled(appState.settings.haptics_enabled !== false);
  }, [appState.settings.haptics_enabled]);

  useEffect(() => {
    preloadAIModel().catch(() => {
      // Already logged inside preloadAIModel; no need to spam.
    });
  }, []);

  // Recurring charges are NOT written to the database.
  //
  // There used to be an executor here that inserted a real row for every due
  // date it thought was missing. It double-counted every subscription: the
  // dashboard already includes the current month's recurring occurrences via
  // `app/lib/transactions/projectedTransactions.ts` (they are solidified to is_projected:false
  // once their date has passed), so the executor's row was a second copy of a
  // charge already in the total. Its rows also landed in the review queue as
  // label 'Automatic', so the user deleted them by hand each day — and once
  // deleted they were no longer in the DB, so the next day's run inserted them
  // all over again. Projection is the single source of truth for recurring.

  const handleAutoAcceptedTransaction = useCallback((tx: Transaction) => {
    const scope = renderedAccountScope;
    if (
      !scope.userId
      || tx.user_id !== scope.userId
      || !isCurrentAccountDataScope(accountScopeRef, scope)
    ) return;

    setAppState(prev => {
      if (!isCurrentAccountDataScope(accountScopeRef, scope) || prev.user?.id !== scope.userId) {
        return prev;
      }
      if (prev.transactions.some(t => t.id === tx.id)) return prev;
      return { ...prev, transactions: [tx, ...prev.transactions] };
    });
  }, [renderedAccountScope]);

  // Tell the reporter who this is — the account id and nothing else, never the
  // name or the email that sit beside it on the same row. Without it, one user
  // hitting the same crash fifty times and fifty users hitting it once look
  // identical, and they need completely different responses.
  useEffect(() => {
    setReportingUser(appState.user?.id ?? null);
  }, [appState.user?.id]);

  // Which build this is, once the phone can say. Web builds have no
  // versionCode and simply skip it.
  useEffect(() => {
    let cancelled = false;
    getInstalledVersionCode().then((code) => {
      if (!cancelled) setReportingBuild(code);
    });
    return () => { cancelled = true; };
  }, []);

  const handleAIProcessingResult = useCallback(async () => {
    if (appState.user?.id) {
      await loadTransactions(appState.user.id);
    }
  }, [appState.user?.id, loadTransactions]);

  // Notices notification access being granted while the user was away in
  // Android's settings, and switches capture on. Has to live here rather than
  // on the settings screen: the WebView is routinely destroyed during that
  // trip, so the screen the user left from is often gone by the time they
  // return.
  const handleSetupGranted = useCallback(() => {
    const scope = renderedAccountScope;
    if (!scope.userId || !isCurrentAccountDataScope(accountScopeRef, scope)) return;

    setAppState(prev => {
      if (!isCurrentAccountDataScope(accountScopeRef, scope) || prev.user?.id !== scope.userId) {
        return prev;
      }
      if (prev.settings.notificationsEnabled) return prev;
      return { ...prev, settings: { ...prev.settings, notificationsEnabled: true } };
    });
  }, [renderedAccountScope]);

  useNotificationSetupCompletion({
    enabled: appState.settings.notificationsEnabled,
    onEnable: handleSetupGranted,
  });

  // When capture started listening — the clock the "we have heard nothing from
  // this bank" warning is measured against. Kept here rather than on the
  // settings toggle because capture can also be switched on from the intro and
  // by useNotificationSetupCompletion after Android sends the user back, and a
  // warning that depended on which route was taken would be wrong for the other
  // two. Stamping it is idempotent; switching capture off clears it, so the
  // grace period starts again rather than counting silence from a time nothing
  // was listening. See lib/bankHeartbeat.ts.
  useEffect(() => {
    if (appState.settings.notificationsEnabled) noteCaptureEnabled();
    else noteCaptureDisabled();
  }, [appState.settings.notificationsEnabled]);

  useNotificationListener({
    user: appState.user,
    budgets: appState.budgets,
    settings: appState.settings,
    onTransactionDetected: handleAddTransaction,
    onAutoAcceptedTransaction: handleAutoAcceptedTransaction,
    onAIProcessingResult: handleAIProcessingResult,
  });

  const refreshMonitoredAppsAndScan = useCallback(async () => {
    const bankingApps = await loadBankingAppsFromDB();
    await autoDetectAndSaveMonitoredApps(bankingApps);
    if (covaultNotification) {
      await covaultNotification.scanActiveNotifications();
    }
  }, []);

  const refreshNotifications = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) return; // Safety check
    await refreshMonitoredAppsAndScan();
  }, [refreshMonitoredAppsAndScan]);

  const prevNotificationsEnabled = useRef(appState.settings.notificationsEnabled);
  useEffect(() => {
    const wasEnabled = prevNotificationsEnabled.current;
    const isEnabled = appState.settings.notificationsEnabled;
    prevNotificationsEnabled.current = isEnabled;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    if (!wasEnabled && isEnabled && Capacitor.isNativePlatform()) {
      const userId = appState.user?.id;
      (async () => {
        await refreshMonitoredAppsAndScan();
        if (userId) {
          timeoutId = setTimeout(() => loadTransactions(userId), SCAN_PROCESSING_DELAY_MS);
        }
      })();
    }

    return () => {
      if (timeoutId != null) clearTimeout(timeoutId);
    };
  }, [appState.settings.notificationsEnabled, appState.user?.id, loadTransactions, refreshMonitoredAppsAndScan]);

  useEffect(() => {
    if (!appState.settings.notificationsEnabled || !covaultNotification || !Capacitor.isNativePlatform()) {
      return;
    }

    // Immediately process existing notifications when parsing is already enabled.
    refreshMonitoredAppsAndScan().catch(e => {
      log.warn('[initial periodic scan] Error:', e);
    });

    const intervalId = setInterval(async () => {
      try {
        await refreshMonitoredAppsAndScan();
      } catch (e) {
        log.warn('[periodic scan] Error:', e);
      }
    }, SCAN_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [appState.settings.notificationsEnabled, refreshMonitoredAppsAndScan]);

  useAppTheme(appState.settings.theme);

  // Checks GitHub for a newer build on launch and on resume. No-ops off-device.
  const appUpdate = useAppUpdate();

  useEffect(() => {
    saveSettingsToStorage(appState.settings);
  }, [appState.settings]);

  const handleOnboardingComplete = useCallback(
    (isSolo: boolean, budgets: BudgetCategory[], partnerEmail?: string) => {
      const scope = renderedAccountScope;
      if (!scope.userId || !isCurrentAccountDataScope(accountScopeRef, scope)) return;
      setAppState(prev => {
        if (!isCurrentAccountDataScope(accountScopeRef, scope) || prev.user?.id !== scope.userId) {
          return prev;
        }
        return {
          ...prev,
          // Only where nothing has loaded yet. These are the starter categories,
          // and this used to assign them unconditionally — so an existing account
          // that reached the intro a second time had its real limits and its
          // hidden categories replaced on screen by the defaults, one settings
          // tap away from being written back over them. An empty list is the only
          // state they are an answer to.
          budgets: prev.budgets.length > 0 ? prev.budgets : budgets,
          user: { ...prev.user, budgetingSolo: isSolo, partnerEmail },
        };
      });
      // Solo or not is a real preference the user just expressed, and it lived
      // in memory only — so it was gone by the next launch and the intro was
      // the only thing that ever asked. A failed save raises a visible error,
      // but the intro still ends so it cannot trap the user.
      void saveSettingToDb('budgeting_solo', isSolo).catch((error) => {
        log.error('[App] Could not save budgeting choice:', error);
        setDbError('Could not save your budgeting choice. Please try again.');
      });
      markOnboarded(scope.userId);
      setAuthState('authenticated');
    },
    [renderedAccountScope, saveSettingToDb, setDbError],
  );

  /**
   * What the intro's setup steps write with.
   *
   * The budgets handed over are the user's real rows, never SYSTEM_CATEGORIES:
   * the `budgets` table has no id column, so a loaded row is `budget:<name>`
   * while the constants carry fixed UUIDs, and `hiddenCategories` stores
   * whichever id was on screen when the eye was tapped. `budgetsReady` is what
   * keeps the step from offering the wrong ones — `loadUserData` is already in
   * flight when the intro opens, so it normally answers while the user is still
   * on the opening slides.
   */
  const onboardingSetup = useMemo(
    () => ({
      userId: appState.user?.id,
      budgets: appState.budgets,
      hiddenCategories: appState.settings.hiddenCategories || [],
      budgetsReady: categoriesLoaded,
      monthlyIncome: appState.user?.monthlyIncome || 0,
      captureEnabled: appState.settings.notificationsEnabled,
      onSaveIncome: (income: number) => { void saveUserIncome(income); },
      onSaveBudgetLimit: (categoryId: string, limit: number) => {
        void saveBudgetLimit(categoryId, limit);
      },
      onToggleHideCategory: (categoryId: string, visible: boolean) => {
        void saveBudgetVisibility(categoryId, visible);
      },
      onCaptureGranted: handleSetupGranted,
    }),
    [
      appState.user?.id,
      appState.user?.monthlyIncome,
      appState.budgets,
      appState.settings.hiddenCategories,
      appState.settings.notificationsEnabled,
      categoriesLoaded,
      saveUserIncome,
      saveBudgetLimit,
      saveBudgetVisibility,
      handleSetupGranted,
    ],
  );

  const handleSignOut = useCallback(async () => {
    const scope = renderedAccountScope;
    if (!scope.userId || !isCurrentAccountDataScope(accountScopeRef, scope)) return;
    await supabase.auth.signOut();
  }, [renderedAccountScope]);

  // No Play Billing purchase flow exists yet (see docs/ARCHITECTURE.md,
  // section 6) — this is the honest placeholder until that's built, rather
  // than a button that pretends to charge someone.
  const handleSubscribe = useCallback(() => {
    setToast({ tone: 'error', message: 'Subscriptions aren’t set up yet — check back soon.' });
  }, [setToast]);

  const handleDeleteAccount = useCallback(async () => {
    const scope = renderedAccountScope;
    if (!scope.userId || !isCurrentAccountDataScope(accountScopeRef, scope)) return;
    const result = await callRpc<null>('delete_own_account', {});
    if (!isCurrentAccountDataScope(accountScopeRef, scope)) return;
    if (!result.ok) {
      setToast({ tone: 'error', message: deleteAccountErrorMessage(result.message, result.failureKind) });
      return;
    }
    // The account and every row it owned are already gone at this point —
    // delete_own_account() has committed. This just clears the client's own
    // cached session, the same call handleSignOut makes, which is what sends
    // the app back to the sign-in screen.
    await supabase.auth.signOut();
  }, [renderedAccountScope, setToast]);

  // Render logic with extra safety
  if (authState === 'loading') {
    return <FullScreenLoader />;
  }

  // Against the database's clock, not the phone's. See lib/serverClock.ts.
  const entitlementStatus = getEntitlementStatus(appState.user, serverNow());

  return (
    <ErrorBoundary>
    <div
      // Not a contradiction: h-screen is the fallback for a WebView too old
      // for dvh, which drops the second rule and keeps the first.
      // eslint-disable-next-line tailwindcss/no-contradicting-classname
      className="h-screen h-[100dvh] w-full bg-slate-50 dark:bg-slate-950 overflow-hidden relative flex flex-col transition-colors duration-300">
      {toast && (
        <div
          role="alert"
          // Bottom, not top. `top-4` put this 16px from the top of the
          // viewport, which on a phone is behind the status bar and the notch —
          // so every toast the app has ever raised, including delete/undo and
          // every database error, has been partly or wholly unreadable on
          // device. Everything else in the app already offsets by the safe-area
          // inset; this was the one thing that didn't.
          //
          // It sits above the bottom bar using the same measurement UpdateBanner
          // uses, so the two never overlap the nav and never each other.
          className={`fixed bottom-[calc(env(safe-area-inset-bottom,0px)+5.75rem)] left-1/2 -translate-x-1/2 z-[200] max-w-[90%] px-4 py-2.5 rounded-2xl text-white text-xs font-semibold shadow-xl flex items-center gap-3 ${
            toast.tone === 'error' ? 'bg-rose-500' : 'bg-slate-800 dark:bg-slate-700'
          }`}
        >
          {toast.tone === 'error' && (
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          )}
          <span className="truncate">{resolveToastMessage(toast, appState.transactions)}</span>
          {toast.action ? (
            <button
              type="button"
              // Dismissed on the way out. Leaving it up meant the strip sat
              // there after an Undo had already run, still offering an Undo —
              // so the only way to tell whether the tap had registered was to
              // watch the list behind it, and tapping again "to be sure" fired
              // a second undo.
              onClick={() => {
                const toastScope = toastEntry?.scope;
                if (!toastScope || !isCurrentAccountDataScope(accountScopeRef, toastScope)) return;
                const run = toast.action?.run;
                setToast(null);
                if (isCurrentAccountDataScope(accountScopeRef, toastScope)) run?.();
              }}
              className="shrink-0 underline underline-offset-2 font-bold tracking-wide"
            >
              {toast.action.label}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="Dismiss"
              className="shrink-0 opacity-70 hover:opacity-100"
            >
              ✕
            </button>
          )}
        </div>
      )}
      {authState === 'unauthenticated' && <Auth onSignIn={() => setAuthState('authenticated')} />}
      {authState === 'onboarding' && (
        <Onboarding
          key={`${renderedAccountScope.userId ?? 'signed-out'}:${renderedAccountScope.generation}`}
          onComplete={handleOnboardingComplete}
          onGenerateLinkCode={handleGenerateLinkCode}
          onJoinWithCode={handleJoinWithCode}
          onCheckForPartner={handleCheckForPartner}
          setup={onboardingSetup}
        />
      )}
      {authState === 'authenticated' && entitlementStatus === 'checking' && <FullScreenLoader />}
      {authState === 'authenticated' && entitlementStatus === 'locked' && (
        <SubscriptionRequired
          reason={appState.user?.subscription_status === 'expired' ? 'subscription_ended' : 'trial_ended'}
          onSubscribe={handleSubscribe}
          onSignOut={handleSignOut}
        />
      )}
      {authState === 'authenticated' && entitlementStatus === 'active' && (
        <Dashboard
          key={`${renderedAccountScope.userId ?? 'signed-out'}:${renderedAccountScope.generation}`}
          state={appState}
          setState={setDashboardAppState}
          onSignOut={handleSignOut}
          onDeleteAccount={handleDeleteAccount}
          onAddTransaction={handleAddTransaction}
          onUpdateTransaction={handleUpdateTransaction}
          onDeleteTransaction={handleDeleteTransaction}
          saveBudgetLimit={saveBudgetLimit}
          saveUserIncome={saveUserIncome}
          saveTheme={saveTheme}
          saveBudgetVisibility={saveBudgetVisibility}
          saveDashboardSetting={saveDashboardSetting}
          onGenerateLinkCode={handleGenerateLinkCode}
          onJoinWithCode={handleJoinWithCode}
          onCheckForPartner={handleCheckForPartner}
          onUnlinkPartner={handleUnlinkPartner}
          onToast={setToast}
          onRefreshNotifications={refreshNotifications}
          onReloadTransactions={loadTransactions}
        />
      )}
      {/* Only once they're in. An update pill over the sign-in screen is noise
          in front of someone who is trying to do something else. */}
      {authState === 'authenticated' && <UpdateBanner {...appUpdate} />}
    </div>
    </ErrorBoundary>
  );
};

export default App;
