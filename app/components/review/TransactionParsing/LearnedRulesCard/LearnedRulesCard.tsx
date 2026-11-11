import React, { useState, useCallback, useMemo } from 'react';
import ParsingCard from '../../../common/ParsingCard';
import { readRecentUses, ruleSourceText } from '../../../../lib/capture/notificationRules';
import SkipPhrasePicker from './SkipPhrasePicker';
import CategoryPickerSheet from '../../CategoryPickerSheet';
import Portal from '../../../common/Portal';
import ConfirmModal from '../../../common/ConfirmModal';
import type { NotificationRule, PatternType } from '../../../../lib/capture/notificationRules';
import type { VendorOverride, MatchType } from '../../../../lib/vendors/useVendorOverrides';
import { toVendorKey } from '../../../../lib/capture/deviceTransactionParser';
import { formatCurrency } from '../../../../lib/money/formatCurrency';
import { parseLocalDate } from '../../../../lib/time/dateUtils';
import { findStaleOtherRules, findChainMergeGroups, StaleOtherGroup, ChainMergeGroup } from '../../../../lib/vendors/ruleCleanup';
import { BudgetCategory, Toast, Transaction } from '../../../../types';
import {
  searchTerms,
  filterBySearch,
  learnedRuleHaystack,
  skipRuleHaystack,
} from '../../../../lib/vendors/ruleSearch';

// --- Static Definitions Moved Outside Component to Prevent Re-allocation ---
const matchTypeStyles: Record<MatchType, string> = {
  exact: 'bg-slate-100 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700/50',
  prefix: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700/50',
  contains: 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-700/50',
};

const categoryColorMap: Record<string, string> = {
  'Groceries': 'text-emerald-600 dark:text-emerald-400',
  'Gas': 'text-amber-600 dark:text-amber-400',
  'Dining': 'text-rose-600 dark:text-rose-400',
  'Shopping': 'text-violet-600 dark:text-violet-400',
  'Entertainment': 'text-pink-600 dark:text-pink-400',
  'Bills': 'text-blue-600 dark:text-blue-400',
  'Transport': 'text-cyan-600 dark:text-cyan-400',
  'Health': 'text-teal-600 dark:text-teal-400',
  'Other': 'text-slate-600 dark:text-slate-400',
};


interface LearnedRule {
  properName: string;
  categoryId: string;
  categoryName: string;
  patterns: VendorOverride[];
  transactions: Transaction[];
}

// Stable identities for omitted props. A fresh `[]` / `new Map()` per render
// would invalidate the memos below on every single render.
const EMPTY_RULES: NotificationRule[] = [];
const EMPTY_BUDGETS: BudgetCategory[] = [];
const EMPTY_TRANSACTIONS: Transaction[] = [];
const EMPTY_CATEGORY_NAMES = new Map<string, string>();

/**
 * What the two skip-pattern match types actually do, in words.
 *
 * Neither is obvious from its name, and getting them wrong is not symmetrical
 * — "contains" silences alerts the user never sees, with the app closed — so
 * the explanation belongs where the choice is made rather than in a help page
 * nobody opens.
 *
 * Both ignore numbers and dates: a rule is created from the whole text of one
 * alert, and that text carries that alert's own figure, so comparing the
 * figures too would mean a rule made from a balance or a price alert could
 * never fire again. See App/Lib/Capture/notificationShape.ts.
 */
const MATCH_TYPE_COPY: Record<PatternType, { title: string; blurb: string }> = {
  exact: {
    title: 'Exact',
    blurb: 'The whole alert, start to finish, same words in the same order — nothing before or after it.',
  },
  contains: {
    title: 'Contains',
    blurb: 'A phrase you pick out of the alert, matched anywhere inside a longer one — in that order, with nothing spliced in.',
  },
};

/** A destructive action, held until the user confirms it. */
interface PendingConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  run: () => void | Promise<void>;
}

/**
 * What deleting a skip pattern actually costs, in the user's terms.
 *
 * Two things worth saying and one worth not overstating. The alerts it was
 * hiding start arriving again — which is the reversible half. And the rule
 * cannot be put back on demand: it is written from the text of one alert, so
 * recreating it means waiting for another of those alerts to turn up and
 * marking it again. The count is quoted when there is one, because a rule that
 * has silenced twenty alerts is a different thing to lose than one that has
 * never fired.
 */
function describeSkipRuleDeletion(rule: NotificationRule): string {
  // The pattern comes first, and short. The modal covers the row that was
  // tapped, so without it there is nothing on screen saying WHICH rule is
  // about to go — which is the mistake this confirmation exists to catch.
  const words = rule.pattern.trim();
  const quoted = words.length > 52 ? `${words.slice(0, 52).trimEnd()}…` : words;
  const uses = rule.use_count ?? 0;
  const worked = uses > 0
    ? `It has hidden ${uses} ${uses === 1 ? 'alert' : 'alerts'}, which would start arriving in Review again.`
    : 'Alerts matching it would start arriving in Review again.';
  return `“${quoted}” — ${worked} Covault cannot put it back: it was written from one alert, so you would have to wait for another like it and mark it again.`;
}

/**
 * How many rules there have to be before a search box is worth its space.
 *
 * A household three weeks in has a handful and can see all of them at once; a
 * search field above six rows is a control that answers a question nobody has
 * yet. It appears when the list has genuinely got away from them.
 */
const MIN_RULES_FOR_SEARCH = 8;

interface LearnedRulesCardProps {
  vendorOverrides: VendorOverride[];
  /** Skip-pattern rules, owned by TransactionParsing. Passed in rather than
   *  fetched here so the two consumers share one fetch and one copy of the
   *  state — previously each mounted its own hook, so a rule created from the
   *  "not a transaction" flow never appeared in this list. */
  rules?: NotificationRule[];
  onRemoveRule?: (ruleId: string) => Promise<boolean>;
  /** Widen or narrow a skip pattern in place. Without it the match type is
   *  shown but not offered as a choice — a switch that cannot move is worse
   *  than a label. */
  onSetRulePatternType?: (ruleId: string, patternType: PatternType) => Promise<boolean>;
  /** Narrow a `contains` rule to a few words of the alert it came from. */
  onSetRulePattern?: (ruleId: string, pattern: string) => Promise<boolean>;
  categoryNameById?: Map<string, string>;
  budgets?: BudgetCategory[];
  /**
   * The categories the user has turned off in settings. The "Change Category"
   * menu files a vendor into one, so it offers only the enabled ones — plus
   * whichever category the rule already sits in, so the menu still shows where
   * the rule currently points. See App/Lib/Budgets/budgetVisibility.ts.
   */
  hiddenCategories?: string[];
  allTransactions?: Transaction[];
  onDeleteVendorOverride: (overrideId: string) => void;
  onSetVendorCategory?: (vendorName: string, categoryId: string) => void;
  onSetProperName?: (vendorName: string, properName: string) => void;
  onCombineChainRules?: (params: {
    keepId: string;
    removeIds: string[];
    chainRoot: string;
    alreadyCanonical: boolean;
  }) => Promise<boolean>;
  onSetExpandedVendorCategory?: (vendorName: string | null) => void;
  expandedVendorCategory?: string | null;
  isExpanded?: boolean;
  onToggleExpanded?: () => void;
  /** Confirms a cleanup action. Shown with no Undo — same as this card's
   *  existing Delete Rule / remove-pattern buttons, which have never had one. */
  onToast?: (toast: Toast) => void;
}

const LearnedRulesCard: React.FC<LearnedRulesCardProps> = ({
  vendorOverrides,
  rules = EMPTY_RULES,
  onRemoveRule,
  onSetRulePatternType,
  onSetRulePattern,
  categoryNameById = EMPTY_CATEGORY_NAMES,
  budgets = EMPTY_BUDGETS,
  hiddenCategories = [],
  allTransactions = EMPTY_TRANSACTIONS,
  onDeleteVendorOverride,
  onSetVendorCategory,
  onSetProperName,
  onCombineChainRules,
  onSetExpandedVendorCategory,
  expandedVendorCategory,
  isExpanded = true,
  onToggleExpanded,
  onToast,
}) => {
  const [query, setQuery] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [editingProperName, setEditingProperName] = useState<string | null>(null);
  const [properNameDraft, setProperNameDraft] = useState('');
  const [categoryRule, setCategoryRule] = useState<LearnedRule | null>(null);
  const [mergingRule, setMergingRule] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  const [expandedSkipRule, setExpandedSkipRule] = useState<string | null>(null);
  /**
   * The destructive action waiting to be confirmed, if any.
   *
   * One piece of state and one modal for every delete on this card, rather
   * than a flag per button. Every one of them removes something the user
   * taught the app, and none of them has an undo — so the rule is simply that
   * nothing here is destroyed on a single tap, and a new delete button cannot
   * be added without deciding what its confirmation says.
   */
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [retypingId, setRetypingId] = useState<string | null>(null);
  const [removingStaleKey, setRemovingStaleKey] = useState<string | null>(null);
  const [combiningChainKey, setCombiningChainKey] = useState<string | null>(null);

  // Group vendor overrides into learned rules by (proper_name, category_id)
  const learnedRules = useMemo((): LearnedRule[] => {
    const groups = new Map<string, LearnedRule>();

    for (const vo of vendorOverrides) {
      const key = `${vo.proper_name}::${vo.category_id || 'uncategorized'}`;
      if (!groups.has(key)) {
        groups.set(key, {
          properName: vo.proper_name,
          categoryId: vo.category_id || '',
          categoryName: vo.category_name || categoryNameById.get(vo.category_id || '') || vo.category_id || 'Uncategorized',
          patterns: [],
          transactions: [],
        });
      }
      groups.get(key)!.patterns.push(vo);
    }

    // Performance Optimization: Pre-compute transaction keys once
    const txCache = allTransactions.map(tx => ({
      tx,
      txKey: toVendorKey(tx.vendor)
    }));

    // Attach transactions that match each rule's patterns
    for (const rule of groups.values()) {
      // Performance Optimization: Pre-compute pattern keys once per rule
      const patternCache = rule.patterns.map(pattern => ({
        matchType: pattern.match_type || 'exact',
        patternKey: toVendorKey(pattern.match_key || pattern.proper_name)
      }));

      for (const { tx, txKey } of txCache) {
        for (const { matchType, patternKey } of patternCache) {
          let matches = false;
          if (matchType === 'exact') {
            matches = txKey === patternKey;
          } else if (matchType === 'prefix') {
            matches = txKey.startsWith(patternKey);
          } else if (matchType === 'contains') {
            matches = txKey.includes(patternKey);
          }

          if (matches) {
            rule.transactions.push(tx);
            break;
          }
        }
      }
    }

    return Array.from(groups.values()).sort((a, b) => a.properName.localeCompare(b.properName));
  }, [vendorOverrides, allTransactions, categoryNameById]);

  const totalRules = learnedRules.length + rules.length;

  // ── Finding one rule among hundreds ──
  // See app/lib/vendors/ruleSearch.ts for what a row is searched against and why it is a
  // plain substring filter rather than anything cleverer.
  const terms = useMemo(() => searchTerms(query), [query]);
  const isSearching = terms.length > 0;
  const showSearch = totalRules >= MIN_RULES_FOR_SEARCH;

  // The type arguments are explicit because the haystack builders take the
  // narrow "just the searchable bits" shapes, and inference would otherwise
  // pick THOSE as the element type and lose the rest of the rule.
  const visibleLearnedRules = useMemo(
    () => filterBySearch<LearnedRule>(learnedRules, terms, learnedRuleHaystack),
    [learnedRules, terms],
  );
  const visibleSkipRules = useMemo(
    () => filterBySearch<NotificationRule>(rules, terms, skipRuleHaystack),
    [rules, terms],
  );
  const matchCount = visibleLearnedRules.length + visibleSkipRules.length;

  // ── Needs attention: rules that are safe to tidy without re-deciding anything ──
  // Both checks mirror a rule the capture pipeline already applies elsewhere
  // (see app/lib/vendors/ruleCleanup.ts) — surfacing them changes nothing about what gets
  // categorised, it only offers to remove the leftover row.
  const staleOtherGroups = useMemo(() => findStaleOtherRules(vendorOverrides), [vendorOverrides]);
  // Never offered without a handler to carry it out — a Combine button that
  // quietly does nothing is worse than no button.
  const chainMergeGroups = useMemo(
    () => (onCombineChainRules ? findChainMergeGroups(vendorOverrides) : []),
    [vendorOverrides, onCombineChainRules],
  );

  const handleRemoveStaleGroup = useCallback(
    async (group: StaleOtherGroup) => {
      const key = group.properName;
      setRemovingStaleKey(key);
      try {
        for (const rule of group.staleRules) {
          await onDeleteVendorOverride(rule.id);
        }
        onToast?.({
          message:
            group.staleRules.length > 1
              ? `Removed ${group.staleRules.length} unused rules for ${group.properName}`
              : `Removed the unused rule for ${group.properName}`,
          tone: 'info',
        });
      } finally {
        setRemovingStaleKey(null);
      }
    },
    [onDeleteVendorOverride, onToast],
  );

  const handleCombineChainGroup = useCallback(
    async (group: ChainMergeGroup) => {
      if (!onCombineChainRules) return;
      const key = `${group.chainRoot}::${group.categoryName}`;
      setCombiningChainKey(key);
      try {
        const keepId = group.canonical?.id ?? group.branches[0].id;
        const removeIds = group.canonical
          ? group.branches.map((r) => r.id)
          : group.branches.slice(1).map((r) => r.id);
        const combined = await onCombineChainRules({
          keepId,
          removeIds,
          chainRoot: group.chainRoot,
          alreadyCanonical: Boolean(group.canonical),
        });
        const rowCount = group.branches.length + (group.canonical ? 1 : 0);
        onToast?.(
          combined
            ? {
                message: `Combined ${rowCount} ${group.properName} rules into one`,
                tone: 'info',
              }
            : {
                // Never confirm a combine that did not happen: the rules are
                // exactly as they were, and saying otherwise would send the
                // user looking for a change that isn't there.
                message: `Could not combine the ${group.properName} rules — nothing was changed`,
                tone: 'error',
              },
        );
      } finally {
        setCombiningChainKey(null);
      }
    },
    [onCombineChainRules, onToast],
  );

  const handleRemoveRule = useCallback(
    async (ruleId: string) => {
      setRemovingId(ruleId);
      try {
        await onRemoveRule?.(ruleId);
      } finally {
        setRemovingId(null);
      }
    },
    [onRemoveRule],
  );

  /**
   * Flip one skip pattern between "exact" and "contains".
   *
   * The rule keeps its use count either way — it is the same rule, told to
   * look more or less widely — so nothing about what it has already caught is
   * thrown away by changing its mind.
   */
  const handleSetRuleType = useCallback(
    async (ruleId: string, patternType: PatternType) => {
      if (!onSetRulePatternType) return;
      setRetypingId(ruleId);
      try {
        const ok = await onSetRulePatternType(ruleId, patternType);
        if (!ok) {
          onToast?.({
            message: 'Could not change that pattern',
            tone: 'error',
          });
        }
      } finally {
        setRetypingId(null);
      }
    },
    [onSetRulePatternType, onToast],
  );

  const handleSetRulePattern = useCallback(
    async (ruleId: string, pattern: string) => {
      if (!onSetRulePattern) return;
      setRetypingId(ruleId);
      try {
        const ok = await onSetRulePattern(ruleId, pattern);
        onToast?.(ok
          ? { message: 'Rule now matches those words', tone: 'info' }
          : { message: 'Could not change that pattern', tone: 'error' });
      } finally {
        setRetypingId(null);
      }
    },
    [onSetRulePattern, onToast],
  );

  const handleMerge = useCallback((ruleKey: string) => {
    setMergingRule(ruleKey);
    setMergeTarget(null);
  }, []);

  const confirmMerge = useCallback(() => {
    if (!mergingRule || !mergeTarget) return;
    const sourceRule = learnedRules.find(r => `${r.properName}::${r.categoryId}` === mergingRule);
    const targetRule = learnedRules.find(r => `${r.properName}::${r.categoryId}` === mergeTarget);
    if (!sourceRule || !targetRule) return;

    // Move all patterns from source to target by updating their proper_name and category_id
    for (const pattern of sourceRule.patterns) {
      onSetProperName?.(pattern.proper_name, targetRule.properName);
      if (targetRule.categoryId) {
        onSetVendorCategory?.(pattern.proper_name, targetRule.categoryId);
      }
    }

    setMergingRule(null);
    setMergeTarget(null);
  }, [mergingRule, mergeTarget, learnedRules, onSetProperName, onSetVendorCategory]);

  return (
    <ParsingCard
      id="parsing-learned-rules"
      colorScheme="violet"
      // A checked list, not the old robot head: this card is a list of
      // decisions the user has already signed off — "this vendor, that
      // category" — and the head read as a cloud at 20px, filled shape drawn
      // with a stroke-only pen.
      icon={
        <>
          <polyline points="3 6 4.5 7.5 7.5 4.5" />
          <polyline points="3 12 4.5 13.5 7.5 10.5" />
          <polyline points="3 18 4.5 19.5 7.5 16.5" />
          <line x1="11" y1="6" x2="21" y2="6" />
          <line x1="11" y1="12" x2="21" y2="12" />
          <line x1="11" y1="18" x2="21" y2="18" />
        </>
      }
      title="Existing Rules"
      subtitle="Vendor and category pairs, plus alerts it skips"
      count={totalRules}
      collapsible
      isExpanded={isExpanded}
      onToggleExpanded={onToggleExpanded}
    >
      {isExpanded && (
        <div className="space-y-3">
          {showSearch && (
            <div className="relative">
              <svg
                className="w-3.5 h-3.5 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 pointer-events-none"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                // Escape clears rather than closing anything: this input sits
                // inside a card on a page, not in a modal, so the nearest
                // meaning of "get out of this" is an empty box.
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setQuery('');
                  }
                }}
                placeholder="Search merchants or categories"
                aria-label="Search rules"
                // 16px. Anything smaller and the browser zooms the page to
                // reach the field, which on Android leaves the card sitting
                // off-centre for the rest of the search.
                className="w-full min-h-[44px] pl-9 pr-9 py-2.5 text-base font-medium rounded-2xl bg-white/70 dark:bg-slate-900/50 border-2 border-violet-100 dark:border-violet-900/40 text-slate-700 dark:text-slate-200 placeholder:text-[13px] placeholder:font-medium placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-violet-400/60 transition-colors"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-[0.95] transition-all"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                    <path d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          )}

          {/* Only when there ARE matches: the empty state below says it
              better, and both at once is the same news twice. */}
          {isSearching && matchCount > 0 && (
            <p className="px-1 text-[11px] font-bold tracking-wide text-slate-400 dark:text-slate-500">
              {matchCount} of {totalRules}
            </p>
          )}

          {/* Needs attention — safe, narrow cleanups, never a re-decision */}
          {!isSearching && (staleOtherGroups.length > 0 || chainMergeGroups.length > 0) && (
            <div className="space-y-2 pb-1">
              <div className="flex items-center justify-between px-1">
                <span className="text-[11px] font-bold tracking-wide uppercase text-slate-400 dark:text-slate-500">
                  Needs attention
                </span>
                <span className="text-[11px] font-extrabold bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 px-2 py-0.5 rounded-full">
                  {staleOtherGroups.reduce((n, g) => n + g.staleRules.length, 0) + chainMergeGroups.length}
                </span>
              </div>

              {staleOtherGroups.length > 0 && (
                <div className="bg-white/60 dark:bg-rose-900/10 backdrop-blur-sm rounded-2xl border border-rose-100 dark:border-rose-800/30 ring-1 ring-inset ring-white/10 dark:ring-white/[0.04] overflow-hidden">
                  <div className="px-3 pt-3 pb-1.5">
                    <p className="text-[11px] font-bold text-rose-700 dark:text-rose-300">
                      No longer doing anything ({staleOtherGroups.length})
                    </p>
                    <p className="text-[10.5px] text-rose-600/70 dark:text-rose-400/60 mt-0.5">
                      A branch was once filed as Other while the rest of that vendor already agrees on a
                      real category — this row hasn't mattered since. Removing it does not change how
                      anything has ever been filed.
                    </p>
                  </div>
                  <div className="px-2 pb-2 space-y-1">
                    {staleOtherGroups.map((group) => {
                      const isRemoving = removingStaleKey === group.properName;
                      return (
                        <div
                          key={group.properName}
                          className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl bg-white/70 dark:bg-slate-900/30"
                        >
                          <div className="min-w-0">
                            <span className="text-[12px] font-bold text-slate-600 dark:text-slate-300">
                              {group.properName}
                            </span>
                            <div className="flex items-center gap-1 mt-0.5 text-[10.5px]">
                              <span className="line-through text-slate-400 dark:text-slate-600">Other</span>
                              <span className="text-slate-300 dark:text-slate-600">&middot;</span>
                              <span className="font-bold text-slate-500 dark:text-slate-400">
                                real answer: {group.realCategoryName}
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setPendingConfirm({
                              title: `Remove the unused ${group.properName} rule?`,
                              message: `It files ${group.properName} under Other, which the rest of your ${group.properName} rules disagree with — they say ${group.realCategoryName}. Removing it changes nothing already filed, and the real rule takes over.`,
                              confirmLabel: 'Remove it',
                              run: () => handleRemoveStaleGroup(group),
                            })}
                            disabled={isRemoving}
                            aria-label={`Remove the unused Other rule for ${group.properName}`}
                            className="shrink-0 text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/40 text-rose-700 dark:text-rose-300 active:scale-95 transition-all disabled:opacity-50"
                          >
                            {isRemoving ? 'Removing…' : 'Remove'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {chainMergeGroups.length > 0 && (
                <div className="bg-white/60 dark:bg-amber-900/10 backdrop-blur-sm rounded-2xl border border-amber-100 dark:border-amber-800/30 ring-1 ring-inset ring-white/10 dark:ring-white/[0.04] overflow-hidden">
                  <div className="px-3 pt-3 pb-1.5">
                    <p className="text-[11px] font-bold text-amber-700 dark:text-amber-300">
                      One chain, several rules ({chainMergeGroups.length})
                    </p>
                    <p className="text-[10.5px] text-amber-600/70 dark:text-amber-400/60 mt-0.5">
                      Every branch already agrees on the same category — combining them into one rule
                      won't change how anything files, it just stops teaching the same lesson twice.
                    </p>
                  </div>
                  <div className="px-2 pb-2 space-y-1">
                    {chainMergeGroups.map((group) => {
                      const key = `${group.chainRoot}::${group.categoryName}`;
                      const isCombining = combiningChainKey === key;
                      const rowCount = group.branches.length + (group.canonical ? 1 : 0);
                      return (
                        <div
                          key={key}
                          className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl bg-white/70 dark:bg-slate-900/30"
                        >
                          <div className="min-w-0">
                            <span className="text-[12px] font-bold text-slate-600 dark:text-slate-300">
                              {group.properName}
                            </span>
                            <div className="text-[10.5px] text-slate-400 dark:text-slate-500 mt-0.5">
                              {rowCount} rules, all {group.categoryName}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleCombineChainGroup(group)}
                            disabled={isCombining}
                            aria-label={`Combine ${rowCount} ${group.properName} rules into one`}
                            className="shrink-0 text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 text-amber-700 dark:text-amber-300 active:scale-95 transition-all disabled:opacity-50"
                          >
                            {isCombining ? 'Combining…' : 'Combine'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Learned Rules List */}
          {learnedRules.length === 0 ? (
            <p className="text-xs text-slate-400 dark:text-slate-500 text-center py-4">
              No rules yet. Every time you categorize a caught transaction, that vendor and category become a rule.
            </p>
          ) : visibleLearnedRules.length === 0 && visibleSkipRules.length === 0 ? (
            // Says what was looked at, because a search that comes up empty is
            // otherwise indistinguishable from one that looked in the wrong
            // place — and the bank's own spelling being searchable is the part
            // nobody would guess.
            <div className="text-center py-6 px-4">
              <p className="text-xs font-bold text-slate-500 dark:text-slate-400">
                No rule matches “{query.trim()}”
              </p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1 leading-snug">
                Merchant names, categories and the names your bank sends are all
                searchable.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {visibleLearnedRules.map((rule) => {
                const ruleKey = `${rule.properName}::${rule.categoryId}`;
                const isExpanded = expandedVendorCategory === ruleKey;
                const categoryColor = categoryColorMap[rule.categoryName] || 'text-violet-600 dark:text-violet-400';

                return (
                  <div key={ruleKey} className="bg-white/60 dark:bg-violet-900/10 backdrop-blur-sm rounded-2xl border border-violet-100 dark:border-violet-800/30 ring-1 ring-inset ring-white/10 dark:ring-white/[0.04] overflow-hidden">
                    {/* Rule Header */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => onSetExpandedVendorCategory?.(isExpanded ? null : ruleKey)}
                      className="w-full flex items-center justify-between p-3 transition-all duration-200 active:scale-[0.99] cursor-pointer"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate">
                          {rule.properName}
                        </span>
                        <span className="text-[11px]">→</span>
                        <span className={`text-xs font-bold truncate ${categoryColor}`}>
                          {rule.categoryName}
                        </span>
                        <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800/60 px-1.5 py-0.5 rounded-full shrink-0">
                          {rule.transactions.length} tx
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {mergingRule === ruleKey && (
                          <span className="text-[11px] font-bold text-amber-500">merging</span>
                        )}
                        <svg className={`w-3 h-3 text-slate-300 dark:text-slate-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </div>
                    </div>

                    {/* Expanded Content */}
                    {isExpanded && (
                      <div className="px-3 pb-3 space-y-3 border-t border-violet-100 dark:border-violet-800/30 pt-2">
                        {/* Match Patterns */}
                        <div>
                          <p className="text-[11px] font-bold tracking-wide text-slate-400 dark:text-slate-500 uppercase mb-1.5">
                            Match Patterns ({rule.patterns.length})
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {rule.patterns.map((pattern) => (
                              <div key={pattern.id} className="flex items-center gap-1">
                                <span className={`text-[11px] font-bold px-2 py-1 rounded-lg border ${matchTypeStyles[pattern.match_type || 'exact']}`}>
                                  {pattern.match_type || 'exact'}: {pattern.match_key || pattern.proper_name}
                                </span>
                                <button
                                  onClick={() => setPendingConfirm({
                                    title: 'Remove this match pattern?',
                                    message: `Purchases announced as “${pattern.match_key || pattern.proper_name}” would stop filing themselves into ${rule.categoryName} and land in Review instead, until you categorise one and teach it again.`,
                                    confirmLabel: 'Remove it',
                                    run: () => onDeleteVendorOverride(pattern.id),
                                  })}
                                  className="p-0.5 rounded text-slate-400 hover:text-rose-500 transition-colors"
                                  title="Remove pattern"
                                >
                                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                                    <path d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Transactions under this rule */}
                        {rule.transactions.length > 0 && (
                          <div>
                            <p className="text-[11px] font-bold tracking-wide text-slate-400 dark:text-slate-500 uppercase mb-1.5">
                              Transactions ({rule.transactions.length})
                            </p>
                            <div className="space-y-1 max-h-40 overflow-y-auto no-scrollbar">
                              {rule.transactions.map((tx) => (
                                <div key={tx.id} className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-violet-50/50 dark:bg-violet-900/20">
                                  <span className="text-[11px] text-slate-600 dark:text-slate-300 truncate flex-1">{tx.vendor}</span>
                                  <span className="text-[11px] font-mono font-semibold text-slate-700 dark:text-slate-200 shrink-0">
                                    {formatCurrency(tx.amount)}
                                  </span>
                                  <span className="text-[11px] text-slate-400 dark:text-slate-500 ml-2 shrink-0">
                                    {parseLocalDate(tx.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {/* Change Category */}
                          <button
                            type="button"
                            onClick={() => setCategoryRule(rule)}
                            aria-haspopup="dialog"
                            aria-expanded={categoryRule?.properName === rule.properName && categoryRule.categoryId === rule.categoryId}
                            className="px-2 py-1 text-[11px] font-bold rounded-lg bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-800/40 text-violet-700 dark:text-violet-300 hover:bg-violet-100 dark:hover:bg-violet-900/40 transition-all"
                          >
                            Change Category
                          </button>

                          {/* Edit Name */}
                          {editingProperName === ruleKey ? (
                            <div className="flex items-center gap-1 flex-1">
                              <input
                                type="text"
                                value={properNameDraft}
                                onChange={(e) => setProperNameDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    for (const p of rule.patterns) {
                                      onSetProperName?.(p.proper_name, properNameDraft);
                                    }
                                    setEditingProperName(null);
                                  } else if (e.key === 'Escape') {
                                    setEditingProperName(null);
                                  }
                                }}
                                className="flex-1 px-2 py-1 text-[11px] rounded-lg border border-violet-200 dark:border-violet-800/40 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-400"
                                autoFocus
                              />
                              <button
                                onClick={() => {
                                  for (const p of rule.patterns) {
                                    onSetProperName?.(p.proper_name, properNameDraft);
                                  }
                                  setEditingProperName(null);
                                }}
                                className="px-2 py-1 text-[11px] font-bold rounded-lg bg-violet-500 text-white"
                              >
                                Save
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                setProperNameDraft(rule.properName);
                                setEditingProperName(ruleKey);
                              }}
                              className="px-2 py-1 text-[11px] font-bold rounded-lg bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-800/40 text-violet-700 dark:text-violet-300 hover:bg-violet-100 dark:hover:bg-violet-900/40 transition-all"
                            >
                              Edit Name
                            </button>
                          )}

                          {/* Merge */}
                          {mergingRule === ruleKey ? (
                            <div className="flex items-center gap-1">
                              <select
                                value={mergeTarget || ''}
                                onChange={(e) => setMergeTarget(e.target.value || null)}
                                className="text-[11px] rounded-lg border border-violet-200 dark:border-violet-800/40 bg-white dark:bg-slate-800 px-2 py-1"
                              >
                                <option value="">Select target...</option>
                                {learnedRules
                                  .filter(r => `${r.properName}::${r.categoryId}` !== ruleKey)
                                  .map(r => (
                                    <option key={`${r.properName}::${r.categoryId}`} value={`${r.properName}::${r.categoryId}`}>
                                      {r.properName} → {r.categoryName}
                                    </option>
                                  ))}
                              </select>
                              <button
                                onClick={confirmMerge}
                                disabled={!mergeTarget}
                                className="px-2 py-1 text-[11px] font-bold rounded-lg bg-amber-500 text-white disabled:opacity-50"
                              >
                                Merge
                              </button>
                              <button
                                onClick={() => { setMergingRule(null); setMergeTarget(null); }}
                                className="px-2 py-1 text-[11px] font-bold rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleMerge(ruleKey)}
                              className="px-2 py-1 text-[11px] font-bold rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-all"
                            >
                              Merge
                            </button>
                          )}

                          {/* Delete all patterns in this rule */}
                          <button
                            onClick={() => setPendingConfirm({
                              title: `Delete the ${rule.properName} rule?`,
                              message: rule.patterns.length === 1
                                ? `${rule.properName} purchases would stop filing themselves into ${rule.categoryName} and land in Review instead, until you categorise one and teach it again. Nothing already filed moves.`
                                : `All ${rule.patterns.length} of its match patterns go. ${rule.properName} purchases would stop filing themselves into ${rule.categoryName} and land in Review instead, until you categorise one and teach it again. Nothing already filed moves.`,
                              confirmLabel: rule.patterns.length === 1
                                ? 'Delete it'
                                : `Delete all ${rule.patterns.length}`,
                              run: () => {
                                for (const p of rule.patterns) {
                                  onDeleteVendorOverride(p.id);
                                }
                              },
                            })}
                            className="px-2 py-1 text-[11px] font-bold rounded-lg bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/40 text-rose-600 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/40 transition-all"
                          >
                            Delete Rule
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Skip Patterns (Notification Rules) */}
          {visibleSkipRules.length > 0 && (
            <div className="pt-2 border-t border-violet-100 dark:border-violet-800/30">
              <div className="flex items-center gap-1.5 mb-1.5">
                <p className="text-[11px] font-bold tracking-wide text-slate-400 dark:text-slate-500 uppercase">
                  Skip Patterns
                </p>
                <span className="text-[11px] font-bold text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800/60 px-1.5 py-0.5 rounded-full">
                  {visibleSkipRules.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {visibleSkipRules.map((rule) => {
                  const isSkipExpanded = expandedSkipRule === rule.id;
                  const uses = rule.use_count ?? 0;
                  const recentUses = readRecentUses(rule);
                  const currentType: PatternType =
                    rule.pattern_type === 'contains' ? 'contains' : 'exact';
                  return (
                  <div
                    key={rule.id}
                    className="rounded-xl bg-white/60 dark:bg-violet-900/10 backdrop-blur-sm border border-violet-100 dark:border-violet-800/30 overflow-hidden"
                  >
                    <div className="flex items-center justify-between gap-2 px-3 py-2">
                      {/* The row opens, the same way a vendor rule's does. The
                          pattern is the whole text of the alert the user
                          marked, so a truncated line is often every word of it
                          that matters cut off. */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setExpandedSkipRule(isSkipExpanded ? null : rule.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setExpandedSkipRule(isSkipExpanded ? null : rule.id);
                          }
                        }}
                        className="flex items-center gap-1.5 min-w-0 flex-1 cursor-pointer transition-all duration-200 active:scale-[0.99]"
                      >
                        <svg
                          className={`w-3 h-3 shrink-0 text-slate-300 dark:text-slate-600 transition-transform ${isSkipExpanded ? 'rotate-90' : ''}`}
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                        <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200 truncate">
                          {rule.pattern}
                        </p>
                        <span className={`text-[11px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border shrink-0 ${matchTypeStyles[currentType]}`}>
                          {currentType}
                        </span>
                        <span className="text-[11px] font-semibold text-violet-500 dark:text-violet-400 shrink-0">
                          {uses} {uses === 1 ? 'use' : 'uses'}
                        </span>
                      </div>
                      <button
                        onClick={() => setPendingConfirm({
                          title: 'Delete this skip pattern?',
                          message: describeSkipRuleDeletion(rule),
                          confirmLabel: 'Delete it',
                          run: () => handleRemoveRule(rule.id),
                        })}
                        disabled={removingId === rule.id}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 transition-all duration-200 active:scale-[0.97] disabled:opacity-50 shrink-0"
                        aria-label="Delete this skip pattern"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                          <path d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>

                    {isSkipExpanded && (
                      <div className="px-3 pb-3 space-y-3 border-t border-violet-100 dark:border-violet-800/30 pt-2">
                        {/* What this rule matches on. Under `exact` that is
                            the whole alert; under `contains` it is whichever
                            span of it the user picked. */}
                        <div>
                          <p className="text-[11px] font-bold tracking-wide text-slate-400 dark:text-slate-500 uppercase mb-1.5">
                            Matches on
                          </p>
                          <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-snug break-words bg-violet-50/50 dark:bg-violet-900/20 rounded-lg px-2 py-1.5">
                            {rule.pattern}
                          </p>
                        </div>

                        {/* ── How widely it looks ──
                            Two states, both spelled out in what they do rather
                            than named after the column they are stored in.
                            "Contains" is the one that can cost a purchase — it
                            silences every alert carrying this text, with the
                            app closed — so it says so where the choice is
                            made, not in a help page nobody opens. */}
                        {onSetRulePatternType && (
                          <div>
                            <p className="text-[11px] font-bold tracking-wide text-slate-400 dark:text-slate-500 uppercase mb-1.5">
                              Match
                            </p>
                            <div className="flex gap-1.5">
                              {(['exact', 'contains'] as PatternType[]).map((type) => {
                                const active = currentType === type;
                                return (
                                  <button
                                    key={type}
                                    onClick={() => { void handleSetRuleType(rule.id, type); }}
                                    disabled={retypingId === rule.id || active}
                                    aria-pressed={active}
                                    className={`flex-1 text-left px-2.5 py-1.5 rounded-lg border transition-all duration-200 active:scale-[0.98] disabled:active:scale-100 ${
                                      active
                                        ? matchTypeStyles[type]
                                        : 'bg-transparent border-slate-200 dark:border-slate-700/50 text-slate-400 dark:text-slate-500 hover:border-violet-200 dark:hover:border-violet-700/50'
                                    } ${retypingId === rule.id ? 'opacity-50' : ''}`}
                                  >
                                    <span className="block text-[11px] font-bold uppercase tracking-wide">
                                      {MATCH_TYPE_COPY[type].title}
                                    </span>
                                    <span className="block text-[10px] font-medium leading-snug mt-0.5 normal-case">
                                      {MATCH_TYPE_COPY[type].blurb}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                            {/* The half neither name hints at, and the half
                                every user assumes wrongly in one direction or
                                the other. */}
                            <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-1.5">
                              Either way, amounts and dates are ignored — the same alert
                              with a different dollar figure still matches.
                            </p>
                          </div>
                        )}

                        {/* ── Which words ──
                            Only under `contains`, because `exact` means the
                            whole alert by definition — and switching back to
                            exact restores it, so the choice is never lost. */}
                        {onSetRulePattern && currentType === 'contains' && (
                          <SkipPhrasePicker
                            sourceText={ruleSourceText(rule)}
                            pattern={rule.pattern}
                            transactions={allTransactions}
                            saving={retypingId === rule.id}
                            onSave={(phrase) => { void handleSetRulePattern(rule.id, phrase); }}
                          />
                        )}

                        {/* ── What it has actually done ──
                            The only evidence the user has about a rule that
                            works by making things disappear. A rule with no
                            uses is usually one written `exact` from an alert
                            whose next copy says a different number. */}
                        <div>
                          <p className="text-[11px] font-bold tracking-wide text-slate-400 dark:text-slate-500 uppercase mb-1.5">
                            {uses === 0
                              ? 'Uses'
                              : `Uses (${uses})`}
                          </p>
                          {recentUses.length > 0 ? (
                            <div className="space-y-1">
                              {recentUses.map((use, i) => (
                                <div
                                  key={`${use.at}-${i}`}
                                  className="px-2 py-1.5 rounded-lg bg-violet-50/50 dark:bg-violet-900/20"
                                >
                                  <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-snug break-words">
                                    {use.text}
                                  </p>
                                  <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                                    {new Date(use.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                    {' · '}
                                    {new Date(use.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                                  </p>
                                </div>
                              ))}
                              {uses > recentUses.length && (
                                <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug">
                                  {`Showing the last ${recentUses.length} of ${uses}`}
                                </p>
                              )}
                            </div>
                          ) : (
                            // Either it has never fired, or it fired before the
                            // app started keeping the wording. Both are honest
                            // as "nothing to show", but a rule with a count has
                            // to say why its alerts are not listed or the empty
                            // list reads as a rule that has done nothing.
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                              {uses === 0
                                ? 'Has not skipped anything yet'
                                : `Skipped ${uses} ${uses === 1 ? 'alert' : 'alerts'} before Covault started keeping their wording`}
                              {uses > 0 && rule.last_used_at
                                ? ` · last on ${new Date(rule.last_used_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                                : ''}
                            </p>
                          )}
                          <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-1.5">
                            Added {new Date(rule.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {categoryRule && (
        <CategoryPickerSheet
          vendor={categoryRule.properName}
          budgets={budgets}
          hiddenCategories={hiddenCategories}
          currentBudgetId={categoryRule.categoryId}
          onClose={() => setCategoryRule(null)}
          onPick={(budgetId) => {
            for (const pattern of categoryRule.patterns) {
              onSetVendorCategory?.(pattern.proper_name, budgetId);
            }
          }}
        />
      )}

      {/* ── Every destructive action on this card ──
          One modal, whichever button asked. Each of them removes something the
          user taught the app and none has an undo, so none of them happens on
          a single tap.

          Portal'd, because this card sits inside the Review page's <main>,
          which is `relative z-10` and would cap the overlay below the nav bar
          however large its own z-index was. See App/Components/Common/Portal.tsx. */}
      {pendingConfirm && (
        <Portal>
          <ConfirmModal
            title={pendingConfirm.title}
            message={pendingConfirm.message}
            confirmLabel={pendingConfirm.confirmLabel}
            cancelLabel="Keep it"
            variant="danger"
            onConfirm={() => {
              const action = pendingConfirm;
              setPendingConfirm(null);
              void action.run();
            }}
            onCancel={() => setPendingConfirm(null)}
          />
        </Portal>
      )}
    </ParsingCard>
  );
};

export default LearnedRulesCard;
