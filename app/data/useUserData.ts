// lib/useUserData.ts
// Facade hook that composes sub-hooks for data loading, transactions,
// household linking, and user settings.
import type { UseUserDataParams } from './types';
import { useDataLoading } from './useDataLoading';
import { useTransactionOps } from './useTransactionOps';
import { useHouseholdLinking } from './useHouseholdLinking';
import { useUserSettings } from './useUserSettings';
import { writeDashboardSetting } from '../lib/settings/dashboardSettingWrite';

export const useUserData = ({
  appState,
  setAppState,
  setDbError,
  accountScopeRef,
}: UseUserDataParams) => {
  const { categoriesLoaded, loadUserData, loadTransactions } = useDataLoading({
    setAppState,
    setDbError,
    accountScopeRef,
  });

  const {
    handleAddTransaction,
    handleUpdateTransaction,
    handleDeleteTransaction,
    handleClearApprovedTransactions,
  } = useTransactionOps({ appState, setAppState, setDbError, categoriesLoaded, accountScopeRef });

  const {
    handleGenerateLinkCode,
    handleJoinWithCode,
    handleCheckForPartner,
    handleUnlinkPartner,
  } = useHouseholdLinking({ appState, setAppState, setDbError, accountScopeRef }, loadUserData);

  const {
    saveBudgetLimit,
    saveUserIncome,
    saveTheme,
    saveBudgetVisibility,
    saveSettingToDb,
  } = useUserSettings({ appState, setAppState, setDbError, accountScopeRef });

  const saveDashboardSetting = async (key: string, value: boolean | string | number) => {
    try {
      await writeDashboardSetting(key, value, saveSettingToDb);
    } catch (error) {
      setDbError('Could not save this setting. Please try again.');
      throw error;
    }
  };

  return {
    categoriesLoaded,
    loadUserData,
    loadTransactions,
    handleAddTransaction,
    handleUpdateTransaction,
    handleDeleteTransaction,
    handleUnlinkPartner,
    handleGenerateLinkCode,
    handleJoinWithCode,
    handleCheckForPartner,
    handleClearApprovedTransactions,
    saveBudgetLimit,
    saveUserIncome,
    saveTheme,
    saveBudgetVisibility,
    saveSettingToDb,
    saveDashboardSetting,
  };
};
