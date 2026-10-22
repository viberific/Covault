import React, { useMemo } from 'react';
import { BudgetCategory, Transaction } from '../../../types';
import BudgetSection from './BudgetSection';
import { compareBudgets } from '../../../lib/budgets/budgetOrder';
import { shouldUseDenseRows } from '../../../lib/budgets/vialDensity';
import { isLeisureBudget, type ShieldBreakdown } from '../../../lib/budgets/discretionaryShield';

interface DashboardSettingsShape {
  useLeisureAsBuffer: boolean;
  hiddenCategories?: string[];
  [key: string]: any;
}

interface DashboardBudgetSectionsListProps {
  budgets: BudgetCategory[];
  transactions: Transaction[];
  expandedBudgets?: Set<string>;
  isFocusMode?: boolean;
  focusedBudgetId?: string | null;
  /** What the shield is absorbing this month, and which categories it came
   *  from. Only ever handed to the Leisure card. */
  leisureShield?: ShieldBreakdown;
  settings?: DashboardSettingsShape;
  currentUserName?: string;
  isSharedAccount?: boolean;
  /** Heading over an open card's purchases: whose they are. */
  activityLabel?: string;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** False while the user is reading another month on the chart's rail. */
  isCurrentMonth?: boolean;
  onToggleExpand?: (id: string) => void;
  onTransactionTap: (tx: Transaction) => void;
}

// Stable identities. memo(BudgetSection) can only short-circuit if every
// prop keeps its identity across renders, so a fresh `[]` / `new Set()` here
// would silently disable it for every card.
const NO_TRANSACTIONS: Transaction[] = [];
const EMPTY_EXPANDED = new Set<string>();
const NOOP_TOGGLE = (_id: string) => {};
const NO_SHIELD: ShieldBreakdown = { total: 0, contributors: [] };

const DashboardBudgetSectionsList: React.FC<DashboardBudgetSectionsListProps> = ({
  budgets,
  transactions,
  expandedBudgets = EMPTY_EXPANDED,
  isFocusMode = false,
  focusedBudgetId = null,
  leisureShield = NO_SHIELD,
  settings,
  currentUserName = '',
  isSharedAccount = false,
  activityLabel,
  scrollContainerRef,
  isCurrentMonth = true,
  onToggleExpand,
  onTransactionTap,
}) => {
  // The settings prop is optional, so we fall back to an empty shape.
  // (Default values on destructured params cause TS to infer the param
  // type as the default's type, ignoring the declared prop type — so
  // we handle the fallback in the body instead.)
  const safeSettings: DashboardSettingsShape = settings || { useLeisureAsBuffer: true };

  const visibleBudgets = useMemo(() => {
    const hiddenCategories: string[] = safeSettings.hiddenCategories || [];

    // `compareBudgets` rather than a local "Other last" rule. The list that
    // arrives here is already in that order (loadUserBudgets sorts it), so
    // this is belt-and-braces for any path that sets budgets some other way —
    // but it has to be the SAME order, or the vials would sit in one order on
    // the dashboard and another in the chart above them.
    return budgets
      .filter((budget) => !isFocusMode || budget.id === focusedBudgetId)
      .filter((budget) => !hiddenCategories.includes(budget.id))
      .sort(compareBudgets);
  }, [budgets, isFocusMode, focusedBudgetId, safeSettings.hiddenCategories]);

  const transactionsByBudgetId = useMemo(() => {
    const grouped = new Map<string | null, Transaction[]>();

    for (const transaction of transactions) {
      const bucket = grouped.get(transaction.budget_id);
      if (bucket) {
        bucket.push(transaction);
      } else {
        grouped.set(transaction.budget_id, [transaction]);
      }
    }

    return grouped;
  }, [transactions]);

  const expandedBudgetId = expandedBudgets.size > 0 ? Array.from(expandedBudgets)[0] : null;
  const allCollapsed = expandedBudgets.size === 0;

  return (
    <div
      ref={scrollContainerRef}
      data-tour="vials"
      // `overflow-hidden` is now constant instead of flipping to
      // `overflow-y-auto` when everything collapses. The old version tore down
      // and rebuilt this element's scrolling/compositing structure on the very
      // frame the 320ms transition started, which is a guaranteed hitch.
      //
      // Nothing is lost: on mobile every collapsed row is `flex-basis: 0%` +
      // `flex-grow: 1` inside a fixed-height `flex-col`, so the content always
      // fits exactly and this never actually scrolled. `scrollContainerRef` is
      // passed down from Dashboard but never read. Desktop keeps its scroller
      // via `lg:overflow-y-auto`, where `lg:auto-rows-fr` genuinely can
      // overflow.
      //
      // `gap` moves onto the same 320ms clock rather than snapping 12px -> 0
      // at frame 0.
      className={`relative flex-1 min-h-0 px-4 no-scrollbar flex flex-col overflow-hidden motion-safe:transition-[gap] motion-safe:duration-[320ms] motion-safe:ease-[cubic-bezier(0.32,0.72,0.24,1)] pt-3 pb-3 ${
        expandedBudgetId
          ? 'gap-0'
          : 'gap-3 lg:grid lg:grid-cols-2 lg:auto-rows-fr lg:overflow-y-auto lg:scroll-smooth'
      }`}
    >
      {visibleBudgets.map((budget, index) => {
          const budgetTxs = transactionsByBudgetId.get(budget.id) ?? NO_TRANSACTIONS;
          // Where the walkthrough's simulated finger lands for "let's open
          // one" — this is the card it then opens. Only while everything is
          // collapsed, which is both when the tap happens and the only time
          // the attribute could be unique.
          const isTourFirstVial = index === 0 && allCollapsed;

          const isExpanded = expandedBudgets.has(budget.id);
          // One definition of "which vault is the shield", shared with the
          // code that works out how much it is absorbing.
          const isLeisure = isLeisureBudget(budget);

          // The shield absorbs INTO Leisure and nowhere else. The overspent
          // category is deliberately left reading "Over by $80": the shield is
          // a way of reading the month, not a transfer, and a vial that stopped
          // reporting its own overspend the moment the shield came on would
          // hide the one fact the user most needs from it.
          const shielded = isLeisure && safeSettings.useLeisureAsBuffer;

          const displayBudget = shielded
            ? { ...budget, externalDeduction: leisureShield.total }
            : budget;

          const shouldAutoFitClosedCards = allCollapsed && !isFocusMode;
          // Past seven visible vials the two-line row has run out of column
          // to be itself in, so it drops to one line. Driven by the COUNT
          // rather than a measurement so it cannot flip mid-expand — see
          // App/Lib/Budgets/vialDensity.ts.
          const shouldUseDenseClosedCards =
            shouldAutoFitClosedCards && shouldUseDenseRows(visibleBudgets.length);

          // When a vial is the currently-expanded one it must take the
          // full available height of the list (i.e. everything between
          // the chart and the bottom toolbar). Any other row must shrink
          // out of the way. When everything is collapsed each row takes
          // an equal share of the available space.
          //
          // We set the flex longhand properties individually instead of
          // the `flex` shorthand so the browser transitions `flex-basis`
          // smoothly even when the other two flex properties also flip.
          // (`flex: 1 1 0%` ↔ `flex: 0 0 0%` is fine, but mixing the
          // shorthand with a different basis like `1 1 100%` can fail to
          // animate in some engines; the longhand form is bulletproof.)
          const rowFlexBasis = expandedBudgetId && isExpanded ? '100%' : '0%';
          const rowFlexGrow = expandedBudgetId && !isExpanded ? 0 : 1;
          const rowFlexShrink = expandedBudgetId && !isExpanded ? 0 : 1;

          return (
            <div
              key={budget.id}
              id={index === 0 ? 'first-budget-card' : undefined}
              data-tour={isTourFirstVial ? 'vial-first' : undefined}
              // Layout strategy
              // ---------------
              // Outer container is `flex flex-col` (or a 2-col grid on
              // desktop when everything is collapsed). Each row is a
              // flex item whose `flex` basis/grow we toggle:
              //   - all collapsed → `1 1 0%` (equal share, preserves the
              //     "evenly distribute closed vials" behavior).
              //   - one expanded  → that row `1 1 100%` (fills every
              //     remaining pixel of vertical space between chart and
              //     toolbar); the other rows go to `0 0 0%` (zero size
              //     so they don't push the expanded row down).
              //
              // Inside each row we keep the `grid-template-rows: 0fr ↔
              // 1fr` interpolation trick to animate the height of the
              // row's content. The trick is a modern, well-supported
              // way to animate to/from an `auto`/content height without
              // measuring it manually and without using a guessed
              // `max-height` — the browser interpolates the fractional
              // track size, so the animation stops cleanly at the
              // natural content height.
              //
              // Animation tuning
              // -----------------
              //  - Duration 0.32s — snappy enough to feel responsive,
              //    long enough to read as a deliberate motion.
              //  - Easing `cubic-bezier(0.32, 0.72, 0.24, 1)` — a
              //    standard "ease-out" shape. We deliberately avoid any
              //    curve with a y value > 1 ("overshoot") because the
              //    interpolated property here is a discrete track size;
              //    overshoot easing produces visible "snapping" at the
              //    end of the animation when the browser clamps to the
              //    final value.
              //  - The transition (defined in index.css on
              //    `.budget-row-anim`) covers `flex-basis`,
              //    `grid-template-rows`, and `opacity` on the same
              //    320ms clock so the row and the inner content bloom
              //    stay in sync.
              //  - We deliberately do NOT set `will-change` here. The
              //    transition is short (320ms) and modern browsers
              //    handle a 5–7 element list's worth of compositor
              //    promotion automatically; an explicit `will-change`
              //    would keep every row's compositor layer alive
              //    forever and waste GPU memory.
              className="min-h-0 grid budget-row-anim"
              style={{
                flexGrow: rowFlexGrow,
                flexShrink: rowFlexShrink,
                flexBasis: rowFlexBasis,
                // `flex-basis` and `grid-template-rows` are both pure-layout
                // properties, so every frame of the expand forces a layout
                // pass. `contain: layout paint` walls each row off: a row's
                // internal relayout cannot dirty its siblings or the d3 chart
                // above it, so the per-frame cost stops scaling with the
                // number of budgets.
                contain: 'layout paint',
                // `0fr` for the rows being closed away from view, `1fr`
                // for the row that is staying (or has just become) the
                // open one — the grid-template-rows CSS animation
                // interpolates between the two.
                gridTemplateRows:
                  expandedBudgetId && !isExpanded ? '0fr' : '1fr',
                opacity: expandedBudgetId && !isExpanded ? 0 : 1,
                pointerEvents:
                  expandedBudgetId && !isExpanded ? 'none' : undefined,
              }}
            >
              <div className="min-h-0 overflow-hidden flex flex-col">
              <BudgetSection
                budget={displayBudget}
                shieldContributors={shielded ? leisureShield.contributors : undefined}
                transactions={budgetTxs}
                isExpanded={isExpanded}
                onToggle={onToggleExpand ?? NOOP_TOGGLE}
                onTransactionTap={onTransactionTap}
                currentUserName={currentUserName}
                isSharedView={isSharedAccount}
                activityLabel={activityLabel}
                allBudgets={budgets}
                isCurrentMonth={isCurrentMonth}
                useCompactCollapsedStyles={shouldAutoFitClosedCards}
                useDenseCollapsedStyles={shouldUseDenseClosedCards}
              />
              </div>
            </div>
          );
        })}

    </div>
  );
};

export default DashboardBudgetSectionsList;
