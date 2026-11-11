// app/components/Dashboard/SearchResults/SearchResults.tsx
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import type { Transaction, BudgetCategory } from '../../../types';
import TransactionItem from '../../transactions/TransactionItem';
import CollapsibleSection from './CollapsibleSection';
import { generateProjectedTransactions } from '../../../lib/transactions/projectedTransactions';
import EmptyState from '../../common/EmptyState';
import { isRefund, matchRefundsToExpenses } from '../../../lib/transactions/refundMatching';

type SearchResultTransaction = Transaction & { category_id?: string };

interface SearchResultsProps {
  searchQuery: string;
  currentMonthTransactions: Transaction[];
  pastTransactions: Transaction[];
  futureTransactions: Transaction[];
  allTransactions: Transaction[];
  currentUserName: string;
  isSharedAccount: boolean;
  budgets: BudgetCategory[];
  onTransactionTap: (tx: Transaction) => void;
}

const getCurrentYearMonth = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
};

const SearchResults: React.FC<SearchResultsProps> = ({
  searchQuery,
  currentMonthTransactions,
  pastTransactions,
  futureTransactions,
  allTransactions,
  currentUserName,
  isSharedAccount,
  budgets,
  onTransactionTap,
}) => {
  const q = searchQuery.toLowerCase().trim();

  const filterFn = useCallback(
    (tx: Transaction) => tx.vendor.toLowerCase().includes(q) && !isRefund(tx),
    [q],
  );

  // Refund matching across the full transaction set so the search list
  // can show refunded expenses with a strikethrough.
  const { matchedExpenseIds } = useMemo(
    () => matchRefundsToExpenses(allTransactions),
    [allTransactions],
  );

  const projectedTransactions = useMemo(
    () => generateProjectedTransactions(allTransactions),
    [allTransactions],
  );

  const txYearMonth = (dateStr: string) => dateStr.slice(0, 7);

  const [currentYearMonth, setCurrentYearMonth] = useState(getCurrentYearMonth);

  useEffect(() => {
    const checkMonth = () => {
      setCurrentYearMonth((prev) => {
        const newYearMonth = getCurrentYearMonth();
        return prev !== newYearMonth ? newYearMonth : prev;
      });
    };

    checkMonth();
    const interval = setInterval(checkMonth, 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const projectedCurrentMonth = useMemo(
    () => projectedTransactions.filter((tx) => txYearMonth(tx.date) === currentYearMonth),
    [projectedTransactions, currentYearMonth],
  );

  const projectedFuture = useMemo(
    () => projectedTransactions.filter((tx) => txYearMonth(tx.date) > currentYearMonth),
    [projectedTransactions, currentYearMonth],
  );

  // Recurring charges that fell in earlier months. They belong with the past
  // entries, in date order, not under "future".
  const projectedPast = useMemo(
    () => projectedTransactions.filter((tx) => txYearMonth(tx.date) < currentYearMonth),
    [projectedTransactions, currentYearMonth],
  );

  const augmentedPast = useMemo(
    () => [...pastTransactions, ...projectedPast]
      .sort((a, b) => b.date.slice(0, 10).localeCompare(a.date.slice(0, 10))),
    [pastTransactions, projectedPast],
  );

  const augmentedCurrent = useMemo(
    () => [...currentMonthTransactions, ...projectedCurrentMonth],
    [currentMonthTransactions, projectedCurrentMonth],
  );

  const augmentedFuture = useMemo(
    () => [...futureTransactions, ...projectedFuture],
    [futureTransactions, projectedFuture],
  );

  const filteredCurrent = useMemo(() => augmentedCurrent.filter(filterFn), [augmentedCurrent, filterFn]);
  const filteredPast = useMemo(() => augmentedPast.filter(filterFn), [augmentedPast, filterFn]);
  const filteredFuture = useMemo(() => augmentedFuture.filter(filterFn), [augmentedFuture, filterFn]);
  const { futureActualTransactions, futureProjectedTransactions } = useMemo(() => {
    return filteredFuture.reduce(
      (groups, tx) => {
        if (tx.is_projected) {
          groups.futureProjectedTransactions.push(tx);
        } else {
          groups.futureActualTransactions.push(tx);
        }
        return groups;
      },
      {
        futureActualTransactions: [] as SearchResultTransaction[],
        futureProjectedTransactions: [] as SearchResultTransaction[],
      },
    );
  }, [filteredFuture]);

  const hasAnyResults = filteredCurrent.length > 0 || filteredPast.length > 0 || filteredFuture.length > 0;

  return (
    <div id="search-results-panel" className="flex-1 overflow-y-auto no-scrollbar mt-3">
      <div className="px-2 pb-8 space-y-4">
        <div className="flex items-center justify-between px-1">
          <span className="text-[10px] font-semibold tracking-wide text-slate-300 dark:text-slate-600">
            Search Results
          </span>
          <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500">
            “{searchQuery}”
          </span>
        </div>

        {filteredCurrent.length > 0 && (
          <div className="space-y-2">
            <div className="px-1">
              <span className="text-[9px] font-semibold tracking-wide text-slate-400 dark:text-slate-500">
                This Month
              </span>
            </div>

            <div className="space-y-2">
              {filteredCurrent.map((tx) => (
                <TransactionItem
                  key={tx.id}
                  transaction={tx}
                  onTap={onTransactionTap}
                  currentUserName={currentUserName}
                  isSharedView={isSharedAccount}
                  budgets={budgets}
                  showBudgetIcon={true}
                  isRefunded={matchedExpenseIds.has(tx.id)}
                />
              ))}
            </div>
          </div>
        )}

        <CollapsibleSection
          title="Past Transactions"
          subtitle="Before this month"
          transactions={filteredPast}
          currentUserName={currentUserName}
          isSharedAccount={isSharedAccount}
          budgets={budgets}
          onTransactionTap={onTransactionTap}
          matchedExpenseIds={matchedExpenseIds}
        />

        {futureActualTransactions.length > 0 && (
          <CollapsibleSection
            title="Future Transactions"
            subtitle="Scheduled future entries"
            transactions={futureActualTransactions}
            currentUserName={currentUserName}
            isSharedAccount={isSharedAccount}
            budgets={budgets}
            onTransactionTap={onTransactionTap}
            matchedExpenseIds={matchedExpenseIds}
          />
        )}

        {futureProjectedTransactions.length > 0 && (
          <CollapsibleSection
            title="Projected Transactions"
            subtitle="Based on recurring entries"
            transactions={futureProjectedTransactions}
            currentUserName={currentUserName}
            isSharedAccount={isSharedAccount}
            budgets={budgets}
            onTransactionTap={onTransactionTap}
            matchedExpenseIds={matchedExpenseIds}
          />
        )}

        {!hasAnyResults && (
          <EmptyState
            message="No entries found"
            description="Try a different vendor name or check another month."
          />
        )}
      </div>
    </div>
  );
};

export default SearchResults;
