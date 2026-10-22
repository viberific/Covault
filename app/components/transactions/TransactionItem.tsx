import React, { memo, useMemo } from 'react';
import { Transaction, BudgetCategory } from '../../types';
import { parseLocalDate } from '../../lib/time/dateUtils';

import { getBudgetIcon } from '../common/getBudgetIcon';
import OwnerDisc from '../common/OwnerDisc';
import { useHouseholdPeople, initialOf } from './householdPeople';

// Hoisted: `Date.prototype.toLocaleDateString` builds a fresh
// Intl.DateTimeFormat on every call, which is one of the more expensive
// things a render can do. These rows are the leaf of both the expanded
// budget list and the search results, so the cost was paid twice per row
// per render.
const SHORT_DATE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const FULL_DATE_FMT = new Intl.DateTimeFormat();

interface TransactionItemProps {
  transaction: Transaction;
  onTap: (tx: Transaction) => void;
  currentUserName: string;
  isSharedView: boolean;
  budgets?: BudgetCategory[];
  showBudgetIcon?: boolean;
  /** When true, render this transaction as refunded — strikethrough the
   *  amount and dim the row. The matched refund itself is NOT inserted as
   *  a separate row; instead the original expense gets refunded=true and
   *  the budget reduce() excludes the row from the spent total. */
  isRefunded?: boolean;
}

const TransactionItem: React.FC<TransactionItemProps> = ({
  transaction,
  onTap,
  currentUserName,
  isSharedView,
  budgets,
  showBudgetIcon = false,
  isRefunded = false,
}) => {

  const transactionDate = useMemo(() => parseLocalDate(transaction.date), [transaction.date]);

  const budget = useMemo(() => {
    if (!budgets || !showBudgetIcon) return null;
    return budgets.find(b => b.id === transaction.budget_id);
  }, [budgets, transaction.budget_id, showBudgetIcon]);

  const isFutureTransaction = useMemo(() => {
    if (transaction.is_projected) return false;
    return transactionDate > new Date();
  }, [transactionDate, transaction.is_projected]);

  // Ownership comes from the row's user id. A row with no owner is the
  // signed-in person's, as everywhere else in the household code.
  const people = useHouseholdPeople();
  const isOtherUser = isSharedView && (people
    ? !!transaction.user_id && transaction.user_id !== people.myUserId
    : transaction.userName !== currentUserName);
  const ownerLabel = isOtherUser
    ? people?.partnerLabel || transaction.userName?.split(' ', 1)[0] || 'Partner'
    : 'You';
  const ownerInitial = isOtherUser
    ? people?.partnerInitial ?? initialOf(ownerLabel)
    : people?.myInitial ?? initialOf(currentUserName);
  const txAmount = typeof transaction.amount === 'number' ? transaction.amount : Number(transaction.amount) || 0;
  const isRefund = txAmount < 0;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onTap(transaction);
    }
  };

  return (
    <div className="relative overflow-hidden rounded-[2rem]">
      {/* Foreground content - now clickable */}
      <button
        onClick={() => onTap(transaction)}
        onKeyDown={handleKeyDown}
        // NO `backdrop-blur` HERE — do not add it back.
        //
        // This used to be `backdrop-blur-xl` (a 24px backdrop-filter) clipped
        // by the parent's `overflow-hidden rounded-[2rem]`. Every row carrying
        // one is its own backdrop root: a separate render surface that must
        // re-sample and re-blur everything beneath it whenever that geometry
        // moves. BudgetSection keeps every budget's transaction list mounted,
        // so all of the month's rows were doing that simultaneously, on every
        // frame of the 320ms budget expand. On desktop that is free; on a
        // Pixel 9 (~2.8x the pixels, an 8.3ms frame budget at 120Hz, tiled
        // mobile GPU) it was the single largest cause of the choppy expand.
        //
        // What it blurred was PageShell's backdrop — soft radial glows plus a
        // 2.5%-opacity noise tile — so blurring it was very nearly invisible.
        // Going /80 -> /90 restores the same milky reading for free. The
        // `ring-1 ring-inset` + `border` + `shadow-sm` are what actually read
        // as "glass" on this row, and they are untouched.
        //
        // `transition-all` is narrowed too: it let a parent-driven style
        // change start an all-property transition on every row mid-expand.
        //
        // Guarded by Test/Tests/Regressions/budgetExpandHotPath.test.ts.
        className="relative z-10 p-4 rounded-[2rem] border shadow-sm ring-1 ring-inset ring-white/10 dark:ring-white/[0.03] bg-white/90 dark:bg-slate-900/90 border-slate-200/40 dark:border-slate-700/40 cursor-pointer hover:bg-white/95 dark:hover:bg-slate-900/95 active:scale-[0.98] transition-[background-color,transform,scale] duration-200 w-full text-left"
        aria-label={`Transaction: ${transaction.vendor}, ${Math.abs(txAmount).toFixed(2)} dollars on ${FULL_DATE_FMT.format(transactionDate)}${isSharedView ? `, ${isOtherUser ? `${ownerLabel}'s` : 'yours'}` : ''}`}
      >
        <div className="flex items-center justify-between">
          {/* Whose purchase: the same round symbol as the header button, at the
              front of the row. The name is not repeated in the title. */}
          {isSharedView && (
            <OwnerDisc
              owner={isOtherUser ? 'them' : 'you'}
              data-disc={isOtherUser ? 'them' : 'you'}
              initial={ownerInitial}
              size="md"
              className="shrink-0 mr-3"
            />
          )}

          {/* Budget icon on the left for search results */}
          {showBudgetIcon && budget && (
            <div className="flex-shrink-0 mr-3 p-2 rounded-xl bg-slate-100/80 dark:bg-slate-800/60 text-slate-400 dark:text-slate-500">
              {getBudgetIcon(budget.name)}
            </div>
          )}
          
          <div className="flex flex-col text-left flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`font-bold text-[14px] tracking-tight leading-none ${
                  isRefunded
                    ? 'text-slate-300 dark:text-slate-600 line-through'
                    : 'text-slate-600 dark:text-slate-100'
                }`}
              >
                {transaction.vendor}
              </span>
              <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 tracking-tight">
                {SHORT_DATE_FMT.format(transactionDate)}
              </span>

              {transaction.recurrence !== 'One-time' && (
                <span className="text-[8px] font-bold text-slate-500 dark:text-slate-400 flex items-center tracking-wide bg-slate-100/50 dark:bg-slate-800/80 px-2 py-0.5 rounded-md">
                  {transaction.recurrence}
                </span>
              )}

              {transaction.is_projected && (
                <span className="text-[8px] font-bold text-amber-500 dark:text-amber-400 tracking-wide bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 rounded-md">
                  Projected
                </span>
              )}

              {isFutureTransaction && (
                <span className="text-[8px] font-bold text-blue-500 dark:text-blue-400 tracking-wide bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded-md">
                  Future
                </span>
              )}

              {transaction.label === 'Automatic' && (
                <span className="text-[8px] font-bold text-violet-500 dark:text-violet-400 tracking-wide bg-violet-50 dark:bg-violet-900/20 px-2 py-0.5 rounded-md">
                  AI
                </span>
              )}

              {isRefund && (
                <span className="text-[8px] font-bold text-emerald-500 dark:text-emerald-400 tracking-wide bg-emerald-50 dark:bg-emerald-900/20 px-2 py-0.5 rounded-md">
                  {transaction.is_income ? 'Income' : 'Refund'}
                </span>
              )}
            </div>
          </div>

          <div className="text-right">
            <div
              className={`text-lg font-black tracking-tighter ${
                isRefunded
                  ? 'text-slate-300 dark:text-slate-600 line-through'
                  : isRefund
                    ? 'text-emerald-500 dark:text-emerald-400'
                    : transaction.is_projected
                      ? 'text-slate-300 dark:text-slate-700'
                      : 'text-slate-500 dark:text-slate-50'
              }`}
            >
              {isRefund ? '+' : ''}${Math.abs(txAmount).toFixed(2)}
            </div>
            {isRefunded && (
              <div className="text-[9px] font-semibold tracking-wide text-emerald-500 dark:text-emerald-400 mt-0.5">
                Refunded
              </div>
            )}
          </div>
        </div>
      </button>
    </div>
  );
};

// Memoized: this is the hottest leaf in the tree. Its props are stable now
// that the list call sites pass through handlers instead of wrapping them in
// fresh arrows each render.
export default memo(TransactionItem);
