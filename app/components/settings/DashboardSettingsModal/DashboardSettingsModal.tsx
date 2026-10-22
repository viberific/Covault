import React, { useEffect, useRef, useState } from 'react';
import IncomeSection from './sections/IncomeSection';
import FAQModal from './FAQModal';
import ThemeToggleSection from './sections/ThemeToggleSection';
import RolloverSection from './sections/RolloverSection';
import DiscretionaryShieldSection from './sections/DiscretionaryShieldSection';
import VaultSharingSection from './sections/VaultSharingSection';
import SupportFeedbackSection from './sections/SupportFeedbackSection';
import SignOutSection from './sections/SignOutSection';
import DeleteAccountSection from './sections/DeleteAccountSection';
import NotificationSettingsSection from './sections/NotificationSettingsSection';
import HomeScreenWidgetSection from './sections/HomeScreenWidgetSection';
import SharedRulesSection from './sections/SharedRulesSection';
import BudgetLimitsSection from './sections/BudgetLimitsSection';
import ExportTransactionsSection from './sections/ExportTransactionsSection';
import ImportTransactionsSection from './sections/ImportTransactionsSection';
import SmartNotificationsSection from './sections/SmartNotificationsSection';
import OnDeviceAISection from './sections/OnDeviceAISection';
import ReportSection from './sections/ReportSection';
import AppTourSection from './sections/AppTourSection';
import { BudgetCategory, Transaction } from '../../../types';
import PremiumGate from '../../subscription/PremiumGate';
import CloseButton from '../../common/CloseButton';
import { useDialogInteraction } from '../../../hooks/useDialogInteraction';
import { useDialogExit } from '../../../hooks/useDialogExit';
import type { AIModelOnDevice } from '../../Dashboard/useAIModelOnDevice';

export interface DashboardSettings {
  theme: string;
  rolloverEnabled: boolean;
  useLeisureAsBuffer: boolean;
  notificationsEnabled?: boolean;
  app_notifications_enabled?: boolean;
  smart_notifications_enabled?: boolean;
  auto_accept_known_vendors?: boolean;
  community_rules_enabled?: boolean;
  community_rules_contribute?: boolean;
  haptics_enabled?: boolean;

  [key: string]: any;
}

export interface DashboardUser {
  id?: string;
  name?: string;
  monthlyIncome?: number;
  partnerEmail?: string;
  [key: string]: any;
}

export interface DashboardSettingsModalProps {
  /** The reading model's state on this phone. Owned by Dashboard so the
   *  download runs while the app is open, not only while this modal is. */
  aiModel: AIModelOnDevice;
  isSharedAccount: boolean;
  settings: DashboardSettings;
  user: DashboardUser | null | undefined;
  onGenerateLinkCode: () => Promise<string | null>;
  onJoinWithCode: (code: string) => Promise<{ ok: boolean; message?: string; partnerName?: string }>;
  onCheckForPartner?: () => Promise<{ linked: boolean; partnerName?: string }>;
  onChangeShareLevel: (level: 'transactions' | 'categories' | 'totals') => void;
  onChangeBudgetMode: (mode: 'separate' | 'combined') => void;
  budgets: BudgetCategory[];
  transactions: Transaction[];
  onClose: () => void;
  onUpdateSettings: (key: string, value: any) => void;
  onUpdateUserIncome: (income: number) => void;
  onDisconnectPartner: () => void;
  onSignOut: () => void;
  onDeleteAccount: () => Promise<void>;
  onSaveBudgetLimit: (categoryId: string, newLimit: number) => void;
  saveBudgetVisibility: (categoryId: string, visible: boolean) => void;
  hasPremium: boolean;
  onSubscribe: () => void;
  onImportComplete?: () => void;
  /** Scroll straight to this section's container id when the modal opens. */
  scrollToSectionId?: string;
  /** Reopen the walkthrough. Closes this modal on the way — the tour covers
   *  the screen, and leaving settings open underneath it means coming back to
   *  a modal the user has forgotten they opened. */
  onReplayTour: () => void;
}

const DashboardSettingsModal: React.FC<DashboardSettingsModalProps> = ({
  aiModel,
  isSharedAccount,
  settings,
  user,
  onGenerateLinkCode,
  onJoinWithCode,
  onCheckForPartner,
  onChangeShareLevel,
  onChangeBudgetMode,
  budgets,
  transactions,
  onClose,
  onUpdateSettings,
  onUpdateUserIncome,
  onDisconnectPartner,
  onSignOut,
  onDeleteAccount,
  onSaveBudgetLimit,
  saveBudgetVisibility,
  hasPremium,
  onSubscribe,
  onImportComplete,
  scrollToSectionId,
  onReplayTour,
}) => {
  const settingsScrollRef = useRef<HTMLDivElement>(null);
  const [showFAQ, setShowFAQ] = useState(false);

  // Opened by something that had one section in mind — the dashboard's "not
  // capturing yet" line. Landing at the top of a fifteen-section modal and
  // being left to hunt for it is the friction that line exists to remove.
  useEffect(() => {
    if (!scrollToSectionId) return;
    const target = document.getElementById(scrollToSectionId);
    if (!target) return;
    // After the modal's own entrance, so the scroll is not undone by it.
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const timer = setTimeout(
      () => target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }),
      reduceMotion ? 0 : 320,
    );
    return () => clearTimeout(timer);
  }, [scrollToSectionId]);

  const { isClosing, close } = useDialogExit();
  const dismiss = () => close(onClose);
  const handleKeyDown = useDialogInteraction(settingsScrollRef, dismiss, { disabled: isClosing });

  return (
    <div className={`fixed inset-0 z-[110] bg-slate-900/40 backdrop-blur-lg flex items-center justify-center p-6 ${isClosing ? 'dialog-exiting dialog-exit-backdrop' : 'animate-in fade-in dialog-motion'}`}>
      <div
        ref={settingsScrollRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vault-settings-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`w-full max-w-lg lg:max-w-2xl bg-white dark:bg-slate-900 rounded-[3rem] px-5 py-10 space-y-8 shadow-2xl max-h-[85vh] overflow-y-auto no-scrollbar border ring-1 ring-inset ring-white/10 dark:ring-white/[0.04] border-slate-100 dark:border-slate-800/60 ${isClosing ? 'dialog-exiting dialog-exit-surface' : 'animate-in zoom-in-95 dialog-motion'}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 id="vault-settings-title" className="text-2xl font-bold text-slate-600 dark:text-slate-100 tracking-tight">
            Vault Settings
          </h2>
          <div className="flex items-center space-x-2">
            <CloseButton onClick={dismiss} />
          </div>
        </div>

        <div className="space-y-4">
          {/* Frequently Asked */}
          <button
            id="faq-button"
            data-tour="settings-faq"
            onClick={() => setShowFAQ(true)}
            className="w-full py-5 bg-slate-50 dark:bg-slate-800/30 border-2 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs font-semibold rounded-2xl hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-all duration-200 tracking-wide shadow-sm active:scale-[0.98]"
          >
            Frequently Asked
          </button>

          {/* The walkthrough, on demand */}
          <div data-tour="settings-walkthrough">
            <AppTourSection onReplayTour={() => close(onReplayTour)} />
          </div>

          {/* Income.

              The `data-tour` wrappers through this list are anchors for the
              walkthrough, which scrolls this modal section by section. They
              wrap rather than being passed into each section so the sections
              themselves stay unaware of it — and a wrapper is spacing-neutral
              here, because `space-y-4` above only cares how many children
              there are. */}
          <div data-tour="settings-income">
            <IncomeSection
              isSharedAccount={isSharedAccount}
              user={user}
              onUpdateUserIncome={onUpdateUserIncome}
            />
          </div>

          {/* Budget Limits */}
          <div data-tour="settings-limits">
          <BudgetLimitsSection
            budgets={budgets}
            onSaveBudgetLimit={onSaveBudgetLimit}
            hiddenCategories={settings.hiddenCategories || []}
            monthlyIncome={user?.monthlyIncome}
            onToggleHideCategory={(categoryId: string) => {
              const current: string[] = settings.hiddenCategories || [];
              const isCurrentlyHidden = current.includes(categoryId);
              // Persist visibility to Supabase
              saveBudgetVisibility(categoryId, isCurrentlyHidden);
            }}
          />
          </div>

          {/* Theme toggle */}
          <div data-tour="settings-theme">
            <ThemeToggleSection
              theme={settings.theme}
              onUpdateSettings={onUpdateSettings}
            />
          </div>

          {/* Bank Notification Listener — Premium */}
          <div data-tour="settings-capture">
          <PremiumGate hasPremium={hasPremium} onSubscribe={onSubscribe}>
            <NotificationSettingsSection
              enabled={!!settings.notificationsEnabled}
              onToggle={(v) => onUpdateSettings('notificationsEnabled', v)}
              autoAcceptKnownVendors={settings.auto_accept_known_vendors === true}
              onToggleAutoAccept={() =>
                onUpdateSettings('auto_accept_known_vendors', !settings.auto_accept_known_vendors)
              }
              hapticsEnabled={settings.haptics_enabled !== false}
              onToggleHaptics={() =>
                onUpdateSettings('haptics_enabled', settings.haptics_enabled === false)
              }
            />
          </PremiumGate>
          </div>

          {/* Shared vendor rules — the household's and everyone's */}
          <div data-tour="settings-rules">
          <SharedRulesSection
            useCommunityRules={settings.community_rules_enabled !== false}
            onToggleUseCommunityRules={() =>
              onUpdateSettings('community_rules_enabled', settings.community_rules_enabled === false)
            }
            contributeCommunityRules={settings.community_rules_contribute === true}
            onToggleContributeCommunityRules={() =>
              onUpdateSettings('community_rules_contribute', !settings.community_rules_contribute)
            }
          />
          </div>

          {/* Home screen widget */}
          <div data-tour="settings-widget">
            <HomeScreenWidgetSection />
          </div>

          {/* Budget rollover */}
          <div data-tour="settings-rollover">
            <RolloverSection
              rolloverEnabled={settings.rolloverEnabled}
              onUpdateSettings={onUpdateSettings}
            />
          </div>

          {/* Reading model — where the AI lives */}
          <div data-tour="settings-ai">
            <OnDeviceAISection
              report={aiModel.report}
              downloading={aiModel.downloading}
              onDownload={() => { void aiModel.downloadNow(); }}
            />
          </div>

          {/* Smart Notifications */}
          <div data-tour="settings-smart">
            <SmartNotificationsSection
              smartNotificationsEnabled={settings.smart_notifications_enabled ?? true}
              onToggleSmartNotifications={() => onUpdateSettings('smart_notifications_enabled', !settings.smart_notifications_enabled)}
            />
          </div>

          {/* Discretionary Shield — Premium */}
          <div data-tour="settings-shield">
            <PremiumGate hasPremium={hasPremium} onSubscribe={onSubscribe}>
              <DiscretionaryShieldSection
                useLeisureAsBuffer={settings.useLeisureAsBuffer}
                onUpdateSettings={onUpdateSettings}
              />
            </PremiumGate>
          </div>

          {/* Vault sharing */}
          <div data-tour="settings-sharing">
          <VaultSharingSection
            user={user}
            onGenerateLinkCode={onGenerateLinkCode}
            onJoinWithCode={onJoinWithCode}
            onCheckForPartner={onCheckForPartner}
            shareLevel={settings.shareLevel ?? 'transactions'}
            onChangeShareLevel={onChangeShareLevel}
            budgetMode={settings.budgetMode ?? 'separate'}
            onChangeBudgetMode={onChangeBudgetMode}
            onDisconnectPartner={onDisconnectPartner}
          />
          </div>

          {/* Export and import — one walkthrough stop, because they are one
              idea: your history, in and out. */}
          <div data-tour="settings-data" className="space-y-4">
          {/* Export Transactions */}
          <ExportTransactionsSection transactions={transactions} budgets={budgets} />

          {/* Import Transactions */}
          <ImportTransactionsSection
            budgets={budgets}
            userId={user?.id}
            onImportComplete={onImportComplete || (() => {})}
          />
          </div>

          {/* Budget Report */}
          <div data-tour="settings-report">
          <ReportSection
            budgets={budgets}
            transactions={transactions}
            monthlyIncome={user?.monthlyIncome || 0}
            isSharedAccount={isSharedAccount}
          />
          </div>

          {/* Support & Feedback — only feature requests are premium */}
          <div data-tour="settings-support">
            <SupportFeedbackSection
              hasPremium={hasPremium}
              onSubscribe={onSubscribe}
              captureEnabled={!!settings.notificationsEnabled}
            />
          </div>

          {/* Leaving: the reversible way and the one below it with no undo.
              One walkthrough stop, because a step of its own about deleting
              everything is a strange note to end a menu on. */}
          <div data-tour="settings-account" className="space-y-4">
          {/* Sign out */}
          <SignOutSection onSignOut={onSignOut} />

          {/* The one row below Sign Out with no undo. */}
          <DeleteAccountSection onDeleteAccount={onDeleteAccount} />
          </div>

          {/* Version */}
          <div className="text-center pt-4">
            <p className="text-[10px] font-medium text-slate-400 dark:text-slate-700 tracking-wide">
              Version 3.0 · Covault
            </p>
          </div>
        </div>
      </div>

      {showFAQ && <FAQModal onClose={() => setShowFAQ(false)} />}
    </div>
  );
};

export default DashboardSettingsModal;
