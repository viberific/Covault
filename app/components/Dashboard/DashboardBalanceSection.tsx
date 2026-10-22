import React from 'react';
import { useAnimatedNumber } from '../../hooks/useAnimatedNumber';
import { splitCurrency } from '../../lib/money/formatCurrency';

interface DashboardBalanceSectionProps {
  isSharedAccount: boolean;
  remainingMoney: number;
  /**
   * What this figure is: the remaining balance, or a month that is finished or
   * has not started. The number itself looks identical in all three cases, so
   * this label is the only thing standing between "you have $412 left" and a
   * closing balance from March.
   */
  balanceLabel?: string;
  monthlyIncome: number;
  isIncomeLoaded?: boolean;
  searchQuery: string;
  isSearchOpen: boolean;
  onSearchQueryChange: (value: string) => void;
  onSearchOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
  /** Sits at the left end of the header row, mirroring the settings cog. */
  leading?: React.ReactNode;
}

const DashboardBalanceSection: React.FC<DashboardBalanceSectionProps> = ({
  isSharedAccount,
  remainingMoney,
  balanceLabel,
  monthlyIncome,
  isIncomeLoaded = true,
  searchQuery,
  isSearchOpen,
  onSearchQueryChange,
  onSearchOpenChange,
  onOpenSettings,
  leading,
}) => {
  const isNegative = remainingMoney < 0;
  const hasNoIncome = monthlyIncome === 0;

  // Count toward the new balance rather than snapping to it. This is the
  // number that moves when a transaction lands, so it's the one place a tween
  // does the most work. Snaps on first render and under reduced motion.
  //
  // The 50c floor this used to pass is gone with the rounding it existed for:
  // while only whole dollars showed, a 30c change moved nothing on screen and
  // tweening it was 600ms of work for no visible result. Now that the cents are
  // printed, the same 30c is two digits changing, so the default one-cent floor
  // is the right one — anything that shows, counts.
  const animatedRemaining = useAnimatedNumber(remainingMoney);
  const balance = splitCurrency(animatedRemaining);

  if (!isIncomeLoaded) {
    return (
      <div
        id="balance-header"
        className="flex flex-col items-center justify-center pb-3 shrink-0 relative"
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
      >
        <div className="w-full flex items-center justify-between px-4 z-10 animate-nest mb-0.5 relative">
          <span className="absolute left-0 right-0 text-center text-[10px] font-semibold tracking-widest uppercase transition-colors duration-700 text-slate-400 dark:text-slate-500 pointer-events-none">
            {balanceLabel ?? (isSharedAccount ? 'Our Remaining Balance' : 'Remaining Balance')}
          </span>
          {leading ?? <span></span>}
          <button
            id="settings-button"
            onClick={onOpenSettings}
            aria-label="Open settings"
            className="p-2 transition-all duration-200 active:scale-[0.97] bg-white/50 dark:bg-slate-800/50 backdrop-blur-md rounded-xl text-slate-400 hover:text-emerald-600 ring-1 ring-inset ring-white/10 dark:ring-white/[0.04] shadow-sm"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l-.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
        <div className="text-center z-10 animate-nest">
          <div className="flex items-baseline justify-center space-x-1 transition-colors duration-700">
            <span className="text-xl font-bold leading-none text-slate-300 dark:text-slate-600">$</span>
            {/* Same two-part shape as the real figure, so the row does not
                change width or alignment the moment income arrives. */}
            <span className="flex items-baseline text-slate-300 dark:text-slate-600">
              <span className="text-3xl font-extrabold font-mono tracking-tighter leading-none">---</span>
              <span className="text-xl font-extrabold font-mono tracking-tighter leading-none">.--</span>
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      id="balance-header"
      className="flex flex-col items-center justify-center pb-3 shrink-0 relative"
      style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
    >
      {/* Soft glow behind balance number */}
      <div
        className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-36 h-16 rounded-full blur-3xl opacity-20 transition-colors duration-700 pointer-events-none ${
          isNegative ? 'bg-rose-400' : 'bg-emerald-400'
        }`}
      />

      {/* Balance label + settings cog on one row */}
      {/* The home screen's vertical rhythm, which is easy to break one class
          at a time. Three equal 12px breaks stack down the page: balance →
          search (mt-3), search → chart (this section's pb-3), and chart →
          vials (mb-1 on BudgetFlowChart's root plus mb-2 on its wrapper in
          Dashboard.tsx). The month label keeps its 2px mb-0.5 because it is a
          label ON the number, not a block of its own. It read as wrong before
          because the search-to-chart break was pb-1 — 4px against the chart's
          12px, so the search bar all but touched the chart while the chart sat
          comfortably clear of the vials. dashboardTopRhythm.test.ts pins it. */}
      <div className="w-full flex items-center justify-between px-4 z-10 animate-nest mb-0.5 relative">
        <span className="absolute left-0 right-0 text-center text-[10px] font-semibold tracking-widest uppercase transition-colors duration-700 text-slate-400 dark:text-slate-500 pointer-events-none">
          {/* The inner span is what the walkthrough measures. The outer one is
              stretched edge to edge so the text can centre on the screen while
              the cog sits to its right, so measuring it would give a
              full-width band; this one is the width of the words. The
              highlight takes the union of everything marked `balance`, so the
              label and the figure below it end up inside one rounded
              rectangle. */}
          <span data-tour="balance">
            {balanceLabel ?? (isSharedAccount ? 'Our Remaining Balance' : 'Remaining Balance')}
          </span>
        </span>
        {leading ?? <span></span>}
        <button
          id="settings-button"
          data-tour="settings"
          onClick={onOpenSettings}
          aria-label="Open settings"
          className="p-2 transition-all duration-200 active:scale-[0.97] bg-white/50 dark:bg-slate-800/50 backdrop-blur-md rounded-xl text-slate-400 hover:text-emerald-600 ring-1 ring-inset ring-white/10 dark:ring-white/[0.04] shadow-sm"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l-.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>

      {hasNoIncome && (
        <button
          onClick={onOpenSettings}
          className="mb-1 z-10 text-[10px] font-semibold text-slate-400 dark:text-slate-500 tracking-wide hover:text-emerald-500 dark:hover:text-emerald-400 transition-colors"
        >
          Set monthly income in Settings →
        </button>
      )}

      <div data-tour="balance" className="text-center z-10 animate-nest">
        <div className="flex items-baseline justify-center space-x-1">
          <span
            className={`text-xl font-bold leading-none ${
              isNegative
                ? 'text-rose-500 dark:text-rose-400'
                : 'text-emerald-500 dark:text-emerald-400'
            }`}
          >
            $
          </span>
          {/*
            Dollars and cents sit in their own baseline row with no gap between
            them: the `space-x-1` above is the breathing room the `$` needs, and
            the cents must butt against the figure they belong to.

            They are printed at the size the dollar sign already uses here.
            Full size would give ".48" the same weight as the number it trails
            and stretch the numeral by a third; this way the eye still lands on
            the dollars and the cents are simply present — which is the point,
            since the widget has always printed them and the two disagreeing is
            what prompted this. font-mono on both halves keeps the digits on one
            grid, so nothing shifts sideways while the tween counts.
          */}
          <span
            className={`flex items-baseline ${
              isNegative
                ? 'text-rose-500 dark:text-rose-400'
                : 'text-emerald-500 dark:text-emerald-400'
            }`}
          >
            <span className="text-3xl font-extrabold font-mono tracking-tighter leading-none">
              {balance.sign}
              {balance.dollars}
            </span>
            <span className="text-xl font-extrabold font-mono tracking-tighter leading-none">
              .{balance.cents}
            </span>
          </span>
        </div>
      </div>

      {/* The closed button and the open field are one control in two states, so
          they share a height, a text size and an edge: tapping must not make the
          bar jump, and the field must not replay an entrance as it appears. The
          open one used to be 42px against the button's 38px, drew the browser's
          own amber focus ring (it never carried `outline-none`), and its emerald
          focus ring was overridden in dark mode by the glass edge below it, so it
          never showed at all. Focus is now the border turning emerald. */}
      {isSearchOpen ? (
        <div
          id="search-field"
          className="relative mt-3 w-2/3 lg:w-1/3 z-10"
        >
          <input
            type="text"
            placeholder="Find entry..."
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            onFocus={() => onSearchOpenChange(true)}
            autoFocus
            className="w-full bg-white/70 dark:bg-slate-900/70 backdrop-blur-md border-2 rounded-2xl py-2 px-10 text-[13px] font-medium outline-none transition-[border-color,background-color] duration-200 placeholder-slate-400 shadow-sm text-center text-slate-600 dark:text-slate-100 border-slate-100 dark:border-slate-800 focus:border-emerald-500/50 dark:focus:border-emerald-400/40 ring-1 ring-inset ring-white/10 dark:ring-white/[0.04]"
          />
          <svg
            className="w-3.5 h-3.5 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={3}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          {searchQuery && (
            <button
              type="button"
              onClick={() => onSearchQueryChange('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          id="search-field"
          onClick={() => onSearchOpenChange(true)}
          className="mt-3 w-2/3 lg:w-1/3 inline-flex items-center justify-center gap-2 rounded-2xl border-2 border-slate-100 dark:border-slate-800 px-4 py-2 text-[13px] font-medium text-slate-400 dark:text-slate-500 bg-white/70 dark:bg-slate-900/70 hover:bg-white dark:hover:bg-slate-900 shadow-sm ring-1 ring-inset ring-white/10 dark:ring-white/[0.04] transition-all duration-200 active:scale-[0.97]"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={3}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          Find entry...
        </button>
      )}
    </div>
  );
};

export default DashboardBalanceSection;