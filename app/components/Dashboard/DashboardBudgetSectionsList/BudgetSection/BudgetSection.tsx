// app/components/Dashboard/DashboardBudgetSectionsList/BudgetSection/BudgetSection.tsx
import React, { useMemo, useCallback, useRef, useState, useEffect, useLayoutEffect, memo } from 'react';
import { BudgetCategory, Transaction } from '../../../../types';
import TransactionItem from '../../../transactions/TransactionItem';
import { getBudgetIcon } from '../../../common/getBudgetIcon';
import EmptyState from '../../../common/EmptyState';
import { getBudgetColor } from '../../../../lib/budgets/budgetColors';
import { getLocalToday } from '../../../../lib/time/dateUtils';
import { compareByDateOccurred, findTodayIndex, transactionDay } from '../../../../lib/transactions/transactionOrdering';
import { computeBudgetTotals, type ShieldContributor } from '../../../../lib/budgets/discretionaryShield';
import { useSpinHighlight, idsForDay } from '../../../../hooks/useSpinHighlight';
import NoticeModal from '../../../common/NoticeModal';
import ShieldMark from './ShieldMark';

interface ExtendedBudgetCategory extends BudgetCategory {
  externalDeduction?: number;
}


/** "$50 from Other, $30 from Groceries" — the sentence's second half. */
function describeContributors(contributors: ShieldContributor[]): string {
  const parts = contributors.map((c) => `$${c.amount.toFixed(0)} from ${c.name}`);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Must match `.budget-row-anim`'s transition-duration in index.css. */
const EXPAND_DURATION_MS = 320;

/**
 * The cascade the transactions arrive on when a budget opens, top row first.
 *
 * The step was 24ms first, which was too quick to read as a cascade at all —
 * the rows effectively arrived together. At 45ms the six or seven a phone can
 * show land over about 270ms, which is long enough to see them come down in
 * order without anyone waiting on it.
 *
 * Only the first `STACK_MAX_ROWS` get an animation: a budget can hold a month
 * of spending, and animating forty rows would mean forty composited layers for
 * the sake of thirty rows nobody can see below the fold.
 */
const STACK_STEP_MS = 45;
const STACK_MAX_ROWS = 12;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

interface BudgetSectionProps {
  budget: ExtendedBudgetCategory;
  /**
   * Which categories `budget.externalDeduction` was borrowed for, largest
   * first. Only the Leisure card is ever given this; every other vial leaves
   * it undefined and is drawn exactly as before.
   */
  shieldContributors?: ShieldContributor[];
  transactions: Transaction[];
  isExpanded: boolean;
  /** Receives this section's budget id, so the parent can pass a single
   *  stable handler instead of allocating a fresh arrow per card per render. */
  onToggle: (budgetId: string) => void;
  onTransactionTap: (tx: Transaction) => void;
  currentUserName: string;
  isSharedView: boolean;
  /** Whose purchases the open card lists. Defaults by sharing alone. */
  activityLabel?: string;
  allBudgets?: BudgetCategory[];
  /**
   * False while this vial is showing a month other than the current one, where
   * "Today" is not in the list at all — the button would either scroll to the
   * bottom of a finished month or to the top of one that has not started, and
   * then explain that nothing is dated today. Which is true, and useless.
   */
  isCurrentMonth?: boolean;
  useCompactCollapsedStyles?: boolean;
  /**
   * One line instead of two while collapsed: the name and the limit, without
   * the "$288 left" line between them.
   *
   * Switched on past seven visible vials, where the two-line row has run out
   * of column to be itself in — see app/lib/budgets/vialDensity.ts for the measurements.
   * Implies the compact styles; an EXPANDED card ignores this entirely, since
   * it has the whole column and is drawn at full size.
   */
  useDenseCollapsedStyles?: boolean;
}

const BudgetSection: React.FC<BudgetSectionProps> = ({
  budget,
  shieldContributors,
  transactions,
  isExpanded,
  onToggle,
  onTransactionTap,
  currentUserName,
  isSharedView,
  activityLabel,
  allBudgets,
  isCurrentMonth = true,
  useCompactCollapsedStyles = false,
  useDenseCollapsedStyles = false,
}) => {
  // The arithmetic itself lives in app/lib/budgets/discretionaryShield.ts, because the
  // shield deducts one vial's overspend from another's and the two figures
  // have to be the same number computed the same way.
  const { refundedExpenseIds, spent, projected, visibleTransactions } = useMemo(() => {
    const totals = computeBudgetTotals(budget.id, transactions);

    // Chronological, not insertion order — see App/Lib/Transactions/transactionOrdering.ts.
    totals.visibleTransactions.sort(compareByDateOccurred);

    return totals;
  }, [transactions, budget.id]);

  // First row dated today or later — the boundary between what has already
  // happened this month and what is still to come. -1 when everything in the
  // list is in the past, in which case "Today" lands at the bottom.
  const todayIndex = useMemo(
    () => findTodayIndex(visibleTransactions, getLocalToday()),
    [visibleTransactions],
  );

  // The light the "Today" button runs around the rows it scrolled to.
  const { spinning, spin } = useSpinHighlight();

  const external = budget.externalDeduction || 0;
  const spentWithExternal = spent + external;
  const total = spentWithExternal + projected;
  const isDanger = total > budget.totalLimit;

  // ── The bar, in three segments ──
  //
  // Solid gradient for what was spent in THIS vault, a hatched band for what
  // the Discretionary Shield borrowed from it to cover another category, then
  // the existing dotted band for charges still expected. Without the middle
  // one the shielded money is indistinguishable from the user's own spending:
  // the bar is simply fuller, which is what "the shield isn't working" looks
  // like even when it is.
  //
  // `shieldWidth` is 0 for every vial except Leisure, and for Leisure whenever
  // nothing is over — in which case `ownSpentWidth` is `spentWithExternal` and
  // the bar is pixel-for-pixel the one that was here before.
  const asWidth = (amount: number) =>
    budget.totalLimit > 0
      ? Math.min(100, (Math.max(0, amount) / budget.totalLimit) * 100)
      : 0;

  const ownSpentWidth = asWidth(spent);
  const shieldWidth = Math.min(100 - ownSpentWidth, asWidth(external));

  /** Where the money that is already committed ends — spent plus shielded. */
  const spentWidth = Math.min(100, ownSpentWidth + shieldWidth);

  const projectedWidth = Math.min(100 - spentWidth, asWidth(projected));

  // One line instead of two, and only while collapsed. An expanded card has
  // the whole column to itself, so it is always drawn at full size.
  const isDense = useDenseCollapsedStyles && !isExpanded;

  const budgetColor = getBudgetColor(budget.name);

  const spentPercent = budget.totalLimit > 0 ? (total / budget.totalLimit) * 100 : 0;
  const isWarning = spentPercent > 80 && spentPercent <= 100;
  const isOver = spentPercent > 100;

  // The transaction list is deliberately NOT laid out while the card is
  // growing.
  //
  // The expand interpolates `flex-basis` and `grid-template-rows` (see
  // index.css `.budget-row-anim`) — both pure layout, so the browser re-lays
  // out this card on every one of the ~38 frames. Whatever is inside it is
  // part of that cost, and an expanded budget can hold dozens of unvirtualized
  // TransactionItems. Worse, flipping `content-visibility` to `visible` on the
  // first frame forces the WHOLE subtree to lay out from scratch right as the
  // animation starts — a stall at frame 1 reads as jank exactly like a
  // per-frame cost does.
  //
  // So the card grows as essentially just its header (trivial to lay out), and
  // the list is revealed once the motion has finished. `budget-content-reveal`
  // then blooms it in. That class used to sit on the static part of the
  // className, which meant its keyframes only ever ran on mount and never on
  // expand — the "layered, not pop-in" effect index.css describes was not
  // actually happening. Now it is.
  const [revealed, setRevealed] = useState(isExpanded);

  useEffect(() => {
    if (!isExpanded) {
      // Collapse hides immediately. The card is shrinking to nothing over the
      // same 320ms, so a fade-out here would be both invisible and the single
      // most expensive thing on screen while it happened.
      setRevealed(false);
      return;
    }
    if (prefersReducedMotion()) {
      setRevealed(true);
      return;
    }
    const timer = setTimeout(() => setRevealed(true), EXPAND_DURATION_MS);
    return () => clearTimeout(timer);
  }, [isExpanded]);

  // The scroller and the first row dated today-or-later. `offsetTop` is read
  // against the scroller because it is the rows' offset parent (it carries
  // `relative`), so no per-row measuring is needed.
  const listRef = useRef<HTMLDivElement>(null);
  const todayAnchorRef = useRef<HTMLDivElement>(null);

  /**
   * Deal the transactions in, top row first, every time the budget opens.
   *
   * Driven from here rather than by putting a CSS class on the rows, which is
   * how it was written first and which played exactly once. Restarting a CSS
   * animation depends on the browser noticing the class go away and come back
   * — and these rows spend the whole collapsed period inside a
   * `content-visibility: hidden` subtree, where that change is not observed.
   * The second open found the rows already sitting at the animation's end
   * state with nothing to re-trigger. `animate()` sidesteps the question: each
   * open builds new animations, so there is no state to get stuck in.
   *
   * `fill: 'backwards'` is what holds a row invisible during its stagger delay
   * instead of showing it and then snatching it back. Nothing fills forwards —
   * the last keyframe is the row's natural state, so once it has played there
   * is nothing left to hold and no compositor layer kept alive.
   *
   * A layout effect, not an ordinary one: this has to be in place before the
   * browser paints the frame in which the rows first become visible.
   */
  useLayoutEffect(() => {
    if (!revealed || prefersReducedMotion()) return;
    const root = listRef.current;
    if (!root) return;

    const rows = root.querySelectorAll<HTMLElement>('[data-stack-row]');
    const running: Animation[] = [];
    const count = Math.min(rows.length, STACK_MAX_ROWS);
    for (let i = 0; i < count; i++) {
      const row = rows[i];
      if (typeof row.animate !== 'function') break;
      running.push(row.animate(
        [
          { opacity: 0, transform: 'translateY(-10px) scale(0.985)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' },
        ],
        {
          duration: EXPAND_DURATION_MS,
          delay: i * STACK_STEP_MS,
          easing: 'cubic-bezier(0.32, 0.72, 0.24, 1)',
          fill: 'backwards',
        },
      ));
    }

    // Collapsing mid-cascade must not leave rows pinned at a keyframe.
    return () => { for (const animation of running) animation.cancel(); };
  }, [revealed]);

  // Raised when the shielded caption is tapped, to name where the money went.
  const [showShieldNotice, setShowShieldNotice] = useState(false);

  // Raised when "Today" is tapped on a day this budget has nothing on.
  const [showNoTodayNotice, setShowNoTodayNotice] = useState(false);

  const scrollToToday = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const scroller = listRef.current;
    if (!scroller) return;

    // Nothing dated today: say so, and leave the list where it is.
    //
    // The button used to scroll to whatever sat nearest the date and light that
    // instead, which is a worse answer than no answer — a lit row is the app
    // saying "here it is", and pointing at last Thursday's groceries when the
    // question was about today reads as either a bug or a wrong date. Most days,
    // in most budgets, there is no spending, so this is the common case rather
    // than the edge one.
    const todaysIds = idsForDay(visibleTransactions, getLocalToday(), transactionDay);
    if (todaysIds.length === 0) {
      setShowNoTodayNotice(true);
      return;
    }

    const anchor = todayAnchorRef.current;
    const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';

    scroller.scrollTo({
      // A little headroom above the row so it doesn't sit flush against the
      // top edge.
      top: anchor ? Math.max(0, anchor.offsetTop - 12) : scroller.scrollHeight,
      behavior,
    });

    // Scrolling answers "where", not "which". With three purchases dated today
    // the arrival point alone says nothing about how many of the rows around
    // it are the ones meant, so every row dated today is lit — not only the
    // one the scroll lands on.
    spin(todaysIds);
  }, [spin, visibleTransactions]);

  const handleHeaderClick = useCallback(() => onToggle(budget.id), [onToggle, budget.id]);

  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        onToggle(budget.id);
      }
    },
    [onToggle, budget.id]
  );

  return (
    <div
      // Only the OPEN card is a walkthrough target, and only one card is ever
      // open, so the attribute is unique in the document whenever it exists.
      data-tour={isExpanded ? 'budget-card' : undefined}
      // `box-shadow` is deliberately NOT in this transition list.
      //
      // It is a paint property: the browser cannot composite it, so a blurred
      // shadow that is interpolating re-rasterises on every frame — around the
      // full perimeter of a card that is simultaneously growing to fill the
      // screen. It was the most expensive thing still animating here, to
      // crossfade a shadow that is nearly invisible against this background
      // (and completely invisible in dark mode). It now swaps in one step
      // while the size change carries the motion.
      className={`flex-1 min-h-0 overflow-hidden rounded-[2rem] relative flex flex-col motion-safe:transition-[background-color,border-color] motion-safe:duration-[320ms] motion-safe:ease-[cubic-bezier(0.32,0.72,0.24,1)] ${
        isExpanded
          ? 'bg-white dark:bg-slate-900 shadow-2xl border'
          : 'bg-white/70 dark:bg-slate-900/70 shadow-sm border border-slate-200/40 dark:border-slate-700/30'
      }`}
      style={{
        borderColor: isExpanded ? budgetColor : undefined,
      }}
    >
      {/* GRADIENT BACKGROUND BARS WITH GLOW EDGE
          ---------------------------------------------------------
          The spent fill animates `transform: scaleX()` rather than `width`.
          Width is a layout property, so animating it re-laid-out this flex row
          on every frame, for every visible vial — the main mechanical cause of
          the jank here. A transform runs on the compositor instead.

          For that to be safe the fill has to have no children: scaleX would
          squash them horizontally. So the glow edge is now a SIBLING positioned
          at the fill's right edge, and it translates rather than scaling. The
          gradient itself is fine — it's defined over the element's box, so it
          scales exactly as it would have stretched.

          The projected bar keeps `width`: it carries a 6px dot pattern that
          scaleX would visibly distort, and it's the quietest of the three. The
          shielded band below keeps `width` for the same reason — a sheared
          diagonal hatch is worse than a stretched one.

          Everything runs on the same 320ms curve as `.budget-row-anim` in
          index.css. These used to be 500ms against the row's 320ms and the
          card's 300ms — three clocks during a single expand, which is what
          read as "not smooth". */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <div
          style={{
            transform: `scaleX(${Math.max(0, Math.min(100, ownSpentWidth)) / 100})`,
            background: `linear-gradient(90deg, ${budgetColor}55 0%, ${budgetColor}70 100%)`,
          }}
          // No permanent `will-change`: the browser promotes for the duration
          // of a running transform transition and releases after. Pinning it
          // would keep a compositor layer alive for every vial forever — the
          // same reasoning as the note on `.budget-row-anim` in index.css.
          className="absolute inset-0 origin-left motion-safe:transition-transform motion-safe:duration-[320ms] motion-safe:ease-[cubic-bezier(0.32,0.72,0.24,1)]"
        />

        {/* THE SHIELDED CHUNK
            ---------------------------------------------------------
            Only ever rendered on the Leisure vial, and only while the shield
            is actually carrying something — so every other bar's DOM is what
            it always was.

            45-degree hatching on a 6px pitch is not a new idea here: it is the
            texture BudgetFlowChart already fills its savings area with, and it
            sits in the same family as the projected band's 6px dots. Read left
            to right the bar now goes solid -> hatched -> dotted, each quieter
            than the last: spent here, borrowed from here, still to come.

            The tint steps between the two neighbours (the fill's 55-70, the
            projected band's 12) so the three segments read as one object.
            Colour comes from the category rather than the theme, exactly as
            the dots do, so this needs no light/dark branching.

            Like the projected band it animates `left`/`width` rather than
            scaleX — the same trade for the same reason: scaling would shear
            the diagonals just as it would distort the dots. One extra element,
            on one card, only when there is something to show. */}
        {shieldWidth > 0 && (
          <div
            style={{
              left: `${ownSpentWidth}%`,
              width: `${shieldWidth}%`,
            }}
            className="absolute top-0 h-full motion-safe:transition-[left,width] motion-safe:duration-[320ms] motion-safe:ease-[cubic-bezier(0.32,0.72,0.24,1)]"
          >
            <div className="absolute inset-0" style={{ backgroundColor: `${budgetColor}22` }} />
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `repeating-linear-gradient(45deg, ${budgetColor}45 0px, ${budgetColor}45 1.5px, transparent 1.5px, transparent 6px)`,
              }}
            />
          </div>
        )}

        {spentWidth > 0 && spentWidth < 100 && (
          <div
            className="absolute top-0 h-full w-[3px] ml-[-3px] motion-safe:transition-[left] motion-safe:duration-[320ms] motion-safe:ease-[cubic-bezier(0.32,0.72,0.24,1)]"
            style={{
              left: `${spentWidth}%`,
              background: budgetColor,
              boxShadow: `0 0 6px ${budgetColor}50, 0 0 12px ${budgetColor}20`,
            }}
          />
        )}

        <div
          style={{
            left: `${spentWidth}%`,
            width: `${projectedWidth}%`,
          }}
          className="absolute top-0 h-full motion-safe:transition-[left,width] motion-safe:duration-[320ms] motion-safe:ease-[cubic-bezier(0.32,0.72,0.24,1)]"
        >
          <div className="absolute inset-0" style={{ backgroundColor: `${budgetColor}12` }} />
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `radial-gradient(circle, ${budgetColor}30 1px, transparent 1px)`,
              backgroundSize: '6px 6px',
            }}
          />
        </div>
      </div>

      {/* HEADER / SUMMARY */}
      <div
        onClick={handleHeaderClick}
        className={`relative z-10 flex items-center justify-between cursor-pointer active:scale-[0.99] motion-safe:transition-[transform,scale,padding] motion-safe:duration-[320ms] motion-safe:ease-[cubic-bezier(0.32,0.72,0.24,1)] ${
          isExpanded
            ? 'flex-none py-6 px-8'
            : isDense
              ? 'flex-1 py-0.5 px-3'
              : useCompactCollapsedStyles
                ? 'flex-1 py-1.5 px-3'
                : 'flex-1 py-2 px-4'
        }`}
      >
        <div className={`flex items-center ${useCompactCollapsedStyles && !isExpanded ? 'space-x-2' : 'space-x-3'}`}>
          <div
            // `padding`, not `width,height`: the classes below change `p-*`,
            // so the old list named two properties this element never animates
            // and omitted the one it does — the chip snapped to its new size
            // mid-expand while everything around it eased.
            className={`rounded-2xl flex items-center justify-center shrink-0 motion-safe:transition-[padding,background-color] motion-safe:duration-[320ms] motion-safe:ease-[cubic-bezier(0.32,0.72,0.24,1)] ${
              isExpanded
                ? 'text-white shadow-lg p-3.5'
                : isDense
                  ? 'p-0.5'
                  : useCompactCollapsedStyles
                    ? 'p-1'
                    : 'p-1.5'
            }`}
            style={{
              ...(isExpanded ? { backgroundColor: budgetColor } : { color: budgetColor }),
            }}
          >
            {getBudgetIcon(budget.name)}
          </div>

          <div className="flex flex-col text-left">
            {/* The name and the shield mark share a row rather than the mark
                sitting on its own line: the glyph is smaller than the text it
                sits beside, so a vault that starts shielding does not push
                anything down — which matters most at the compact collapsed
                size, where the two lines are already tight. */}
            <div className="flex items-center gap-1">
              <h3 className={`font-bold tracking-tight leading-none motion-safe:transition-colors motion-safe:duration-[320ms] text-slate-600 dark:text-slate-100 ${useCompactCollapsedStyles && !isExpanded ? 'text-[12px]' : 'text-sm'}`}>
                {budget.name}
              </h3>
              {external > 0 && <ShieldMark color={budgetColor} />}
            </div>

            {!isExpanded && !isDense && (
              <span
                className={`tracking-wide mt-1 motion-safe:transition-colors motion-safe:duration-[320ms] ${
                  isOver
                    ? 'text-slate-700 dark:text-slate-100 font-extrabold'
                    : isWarning
                      ? 'text-slate-500 dark:text-slate-300 font-bold'
                      : 'text-slate-400 dark:text-slate-500 font-bold'
                } ${useCompactCollapsedStyles ? 'text-[10px]' : 'text-[11px]'}`}
              >
                {isDanger
                  ? `Over by $${Math.max(0, total - budget.totalLimit).toFixed(0)}`
                  : `$${Math.max(0, budget.totalLimit - total).toFixed(0)} left`}
              </span>
            )}
          </div>
        </div>

        <div
          data-tour={isExpanded ? 'budget-total' : undefined}
          className="text-right flex flex-col items-end justify-center"
        >
          {isExpanded ? (
            <>
              <div className="flex items-baseline gap-1">
                <span className="text-sm font-bold font-mono mr-2 tracking-tight motion-safe:transition-colors motion-safe:duration-[320ms] text-slate-500">
                  ${total.toFixed(0)}
                  <span className="mx-1.5 opacity-30 font-medium text-slate-400">/</span>
                </span>

                <span className="text-xl font-extrabold font-mono tracking-tighter leading-none motion-safe:transition-colors motion-safe:duration-[320ms] text-slate-600 dark:text-slate-100">
                  ${budget.totalLimit}
                </span>
              </div>

              {/* The shield takes a chunk out of this vault that none of the
                  rows below it explain, so the open card says where it went —
                  and tapping it names the categories. Only here: the collapsed
                  card's two lines are already tight at the compact size, and a
                  third would break the rhythm of every vial to caption one of
                  them, while a 12px tap target on a phone is no target at all.

                  `stopPropagation`, or the header underneath would take the tap
                  and shut the card the notice was raised from. */}
              {external > 0 ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowShieldNotice(true);
                  }}
                  className="text-[11px] font-medium tracking-wide mt-0.5 -mr-1 py-1 px-1 rounded-lg motion-safe:transition-colors motion-safe:duration-[320ms] text-slate-400 dark:text-slate-500 active:scale-[0.97]"
                >
                  {`Vault Capacity · $${external.toFixed(0)} shielded`}
                </button>
              ) : (
                <span className="text-[11px] font-medium tracking-wide mt-0.5 motion-safe:transition-colors motion-safe:duration-[320ms] text-slate-400 dark:text-slate-500">
                  Vault Capacity
                </span>
              )}
            </>
          ) : (
            <span
              className={`font-black tracking-tight motion-safe:transition-colors motion-safe:duration-[320ms] text-slate-500 dark:text-slate-100 ${useCompactCollapsedStyles ? 'text-xs' : 'text-sm'}`}
              aria-label={`${budget.totalLimit} dollar budget`}
            >
              ${budget.totalLimit}
            </span>
          )}
        </div>
      </div>

      {/* TRANSACTIONS LIST (Now stays mounted, styled to smoothly collapse) */}
      <div
        ref={listRef}
        // Conditional because every budget's list stays mounted at all times
        // (see the note on the style below): an unconditional attribute would
        // put one on all ten cards at once.
        data-tour={isExpanded ? 'budget-list' : undefined}
        className={`min-h-0 overflow-y-auto no-scrollbar relative z-10 transform origin-top ${
          isExpanded
            ? 'flex-1 px-6 pb-2'
            : 'flex-none h-0 px-6 pb-0 overflow-hidden pointer-events-none'
        } ${revealed ? 'budget-content-reveal opacity-100' : 'opacity-0'}`}
        style={{
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'contain',
          overscrollBehaviorY: 'contain',
          overflowAnchor: 'none',
          touchAction: 'pan-y',
          // Keyed on `revealed`, NOT `isExpanded` — see the note beside the
          // state declaration. Every budget's list is in the DOM at all times,
          // so without this a single expand lays out and paints every
          // transaction row of every *other* budget too, on every frame. And
          // keying it on `isExpanded` merely moved that cost to frame 1 of the
          // animation instead of removing it.
          //
          // Unmounting (`{isExpanded && ...}`) would be cheaper still, but it
          // drops the content on the first frame of a collapse and loses the
          // list's scroll position.
          contentVisibility: revealed ? 'visible' : 'hidden',
        }}
        onClick={handleBackgroundClick}
      >
        <div className="pt-1 pb-6 space-y-4">
          <div className="flex items-center justify-between px-2">
            <span className="text-[11px] font-semibold tracking-wide motion-safe:transition-colors motion-safe:duration-[320ms] text-slate-400 dark:text-slate-500">
              {activityLabel ?? (isSharedView ? 'Our Activity' : 'Activity')}
            </span>

            {/* Jump to now. Wears the category's own colour, like the icon
                chip in the header above it, so it reads as part of this vault
                rather than as a generic control. */}
            {visibleTransactions.length > 0 && isCurrentMonth && (
              <button
                type="button"
                onClick={scrollToToday}
                style={{ backgroundColor: budgetColor }}
                className="flex items-center gap-1 rounded-full pl-2.5 pr-1.5 py-1 text-[10px] font-bold tracking-wide text-white shadow-sm active:scale-95 motion-safe:transition-transform motion-safe:duration-150"
                aria-label="Scroll to today"
              >
                Today
                <svg
                  className="w-3 h-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            )}
          </div>

          <div className="space-y-3">
            {visibleTransactions.length > 0 ? (
              visibleTransactions.map((tx, index) => (
                // The wrapper exists so the "Today" button has something to
                // measure: TransactionItem is memoised and takes no ref, and
                // wrapping every row (rather than only the anchor) keeps
                // `space-y-3`'s child spacing identical either way.
                // data-stack-row is how the cascade finds these. See the
                // layout effect above for why the animation is driven from
                // JavaScript rather than by toggling a CSS class.
                <div
                  key={tx.id}
                  data-stack-row=""
                  ref={index === todayIndex ? todayAnchorRef : undefined}
                  className={spinning.has(tx.id) ? 'covault-spin-highlight' : undefined}
                  // The light wears this vault's own colour, like the Today
                  // button and the header chip, so it reads as part of this
                  // budget rather than as a generic system highlight. The
                  // radius matches TransactionItem's card so it traces the
                  // row's real edge instead of cutting its corners.
                  style={
                    spinning.has(tx.id)
                      ? ({
                          '--covault-spin-color': budgetColor,
                          '--covault-spin-radius': '2rem',
                        } as React.CSSProperties)
                      : undefined
                  }
                >
                  <TransactionItem
                    transaction={tx}
                    onTap={onTransactionTap}
                    currentUserName={currentUserName}
                    isSharedView={isSharedView}
                    budgets={allBudgets}
                    isRefunded={refundedExpenseIds.has(tx.id)}
                  />
                </div>
              ))
            ) : (
              <EmptyState message="No entries found" size="md" />
            )}
          </div>
        </div>
      </div>

      {showShieldNotice && (
        <NoticeModal
          title="Discretionary Shield"
          message={
            shieldContributors && shieldContributors.length > 0
              ? `${budget.name} is covering $${external.toFixed(0)} of overspending this month — ${describeContributors(shieldContributors)}.`
              : `${budget.name} is covering $${external.toFixed(0)} of overspending from your other budgets this month.`
          }
          accentColor={budgetColor}
          icon={<ShieldMark color={budgetColor} inDisc />}
          onDismiss={() => setShowShieldNotice(false)}
        />
      )}

      {showNoTodayNotice && (
        <NoticeModal
          title="No expenses recorded today"
          message={`Nothing in ${budget.name} is dated today.`}
          accentColor={budgetColor}
          onDismiss={() => setShowNoTodayNotice(false)}
        />
      )}
    </div>
  );
};

export default memo(BudgetSection);
