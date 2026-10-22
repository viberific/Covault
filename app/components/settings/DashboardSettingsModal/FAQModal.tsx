import React, { useRef, useState, useMemo } from 'react';
import CloseButton from '../../common/CloseButton';
import { useDialogInteraction } from '../../../hooks/useDialogInteraction';
import { useDialogExit } from '../../../hooks/useDialogExit';

interface FAQItem {
  question: string;
  answer: string;
}

interface FAQModalProps {
  onClose: () => void;
}

const FAQ_ITEMS: FAQItem[] = [
  {
    question: "How do I add a transaction?",
    answer: "Tap the + button in the center of the bottom bar. Fill in the amount, vendor name, and choose a budget category, then tap Save."
  },
  {
    question: "How do I delete a transaction?",
    answer: "Tap on any transaction in the budget list to open the action menu, then tap 'Delete.' You'll be asked to confirm before it's removed."
  },
  {
    question: "How do I edit a transaction?",
    answer: "Tap on the transaction in the budget list. An action modal will appear where you can edit the amount, vendor, category, or date."
  },
  {
    question: "Can I search for a specific transaction?",
    answer: "Tap the 'Find entry...' bar just below the balance number at the top of the dashboard. Type a vendor name to filter transactions. Tap outside the bar to close it."
  },
  {
    question: "How do I change my monthly income?",
    answer: "Open Vault Settings via the gear icon and find the 'Monthly Income' section at the top. Tap the amount to edit it."
  },
  {
    question: "How is my remaining balance calculated?",
    answer: "Your balance starts with your monthly income, then subtracts all actual spending and projected future expenses for the current month. It updates in real time as you add transactions."
  },
  {
    question: "How do I set budget limits?",
    answer: "In Vault Settings, find the 'Budget Limits' section. Tap on any category's limit to change how much you want to allocate."
  },
  {
    question: "How do I hide a budget category?",
    answer: "In Vault Settings under 'Budget Limits,' tap the eye icon next to any category to hide it from your dashboard and chart."
  },
  {
    question: "What do the budget cards on the dashboard represent?",
    answer: "Each budget card is a spending category. The coloured fill shows what you've actually spent this month. A dotted extension shows projected future expenses from recurring transactions. When the fill reaches the edge, you've hit that category's limit."
  },
  {
    question: "How do I read the Spending Flow chart?",
    answer: "The chart shows your spending across categories over time. Each coloured band is a category. Touch and drag to scrub through months and see breakdowns. Dashed threshold lines mark your total budget limit."
  },
  {
    question: "What are Insight Cards?",
    answer: "Insight Cards are smart summaries that appear when you open the app. They surface things like a budget nearing its limit, an upcoming recurring bill, or a notable spending trend. Swipe a card to dismiss it. Toggle them on or off under 'Smart Insights' in Vault Settings."
  },
  {
    question: "What are Smart Notifications?",
    answer: "Smart Notifications are push alerts that fire automatically when a budget hits 80% or exceeds its limit, or your remaining balance goes negative. Enable or disable them under 'Smart Insights' in Vault Settings."
  },
  {
    question: "How do I set up bank notification parsing?",
    answer: "In Vault Settings, open the 'Bank Notification Listener.' It walks you through the three screens Android needs, one button each, ticking them off as you come back. The first switch is expected to refuse — that refusal is what unlocks the next step. Once it is on, captured purchases appear on the Review tab (the inbox icon on the bottom bar)."
  },
  {
    question: "What is Budget Rollover?",
    answer: "When rollover is enabled, unspent money in a category carries over to the next month. This lets surplus accumulate across billing cycles."
  },
  {
    question: "What is the Discretionary Shield?",
    answer: "When enabled, your Leisure budget absorbs overflow from other overspent categories. It acts as a safety net to protect your essential budgets."
  },
  {
    question: "How do I enable dark mode?",
    answer: "Open Vault Settings and find the 'Dark Interface' toggle. Tap it to switch between light and dark themes."
  },
  {
    question: "How do I export my transactions?",
    answer: "In Vault Settings, find 'Export Transactions.' Choose a date range, then download your data as a CSV file you can open in any spreadsheet app."
  },
  {
    question: "How do I import transactions?",
    answer: "In Vault Settings, scroll to 'Import Transactions' and tap 'Choose CSV File.' Your CSV needs these columns: Date, Vendor, Amount, Category, and Recurrence. Category names must match your existing budget categories exactly."
  },
  {
    question: "What is the Review tab for?",
    answer: "It is where captured purchases land before they count. The inbox icon on the bottom bar opens it; anything under 'Needs a look' is waiting for you to confirm the category, and the badge on the icon is how many. Accepting one files it into that budget; there is also 'Accept known vendors' to clear the easy ones in a single tap."
  },
  {
    question: "What does 'Filed automatically' mean?",
    answer: "A purchase Covault was confident enough about to file without asking. It only happens for a vendor you have already categorised before, and only when 'Auto-file known vendors' is switched on in Vault Settings. Filed entries are listed separately in the Review tab so you can still see what it did, and change any of them."
  },
  {
    question: "How does Covault learn where a vendor belongs?",
    answer: "When you set a category on a captured purchase, tick 'Always use this category' and it remembers the pairing. Every later charge from that vendor goes the same way. The pairs it has learned are listed under 'Existing rules' in the Review tab, and you can remove any of them."
  },
  {
    question: "Something that isn't a purchase keeps getting captured. How do I stop it?",
    answer: "Open the entry in the Review tab and choose 'Not a transaction.' Covault deletes it and remembers the wording, so alerts like it are captured quietly from then on — no notification, and nothing added to the widget. Money coming in, declined or failed charges, balance alerts and statement reminders are already ignored without you having to say so."
  },
  {
    question: "Why does the same purchase appear twice?",
    answer: "Some banks send more than one alert for one charge, and a card that was declined and then retried produces two as well. Covault marks the pair as a 'Possible duplicate' and lets you keep both or delete the older one. If it happens with a vendor repeatedly, it is worth reporting — the matching rules can be tightened."
  },
  {
    question: "The gas station charged a different amount than Covault shows.",
    answer: "Pumps authorise a round placeholder amount first and only send the real total later. Covault marks those entries as a hold and asks for the amount actually paid, and when the settled charge arrives it pairs the two rather than leaving you with a hold and a duplicate."
  },
  {
    question: "How are refunds handled?",
    answer: "A refund alert is captured as a negative entry and matched against the original purchase where Covault can find it, so the category it came out of gets the money back rather than the total simply going down."
  },
  {
    question: "Why don't my subscriptions show up as entries?",
    answer: "Recurring charges are projected, not recorded. Covault already counts the current month's occurrences in your total and draws them as the dotted extension on a budget card, so writing a row as well would count them twice. That is also why a captured subscription charge does not appear in Review — it was already accounted for."
  },
  {
    question: "How do I add the home-screen widget?",
    answer: "Long-press an empty spot on your Android home screen, choose Widgets, find Covault and drag it out. It shows the month's spending as a ring, what is left, the biggest categories, and how many entries are waiting to be reviewed. Tapping a part of it opens the matching part of the app."
  },
  {
    question: "The widget looks out of date.",
    answer: "It refreshes when a purchase is captured and again whenever you open the app. If a figure looks wrong, opening Covault always brings it back in step — the app is the source of truth and the widget catches up from it."
  },
  {
    question: "Can Covault hide my bank's own notification?",
    answer: "Yes. Turn on 'Hide bank alerts after capture' under the Bank Notification Listener. Covault only clears a bank alert once it has saved the purchase and posted its own notification in its place, so it can never take away the only notice of a charge. The recent-alerts list in that section says what happened to each one and why any were kept."
  },
  {
    question: "My bank isn't being captured.",
    answer: "Open the Bank Notification Listener in Vault Settings and look at 'Banking Apps.' Covault only reads alerts from apps on that list, and it offers any installed app that looks financial for you to approve. Adding yours there is all it takes — no update needed."
  },
  {
    question: "Does Covault capture money coming in?",
    answer: "No, deliberately. Covault tracks spending, so deposits, e-Transfers you receive and payroll credits are ignored, and so is anything where no money moved — a declined or failed charge, a balance alert, a statement or minimum-payment reminder. Your bank's own notification for those is left alone, since it is the only notice you get."
  },
  {
    question: "What is the Reading Model?",
    answer: "A small language model that runs on your phone to read notifications the pattern matching can't. It is downloaded once and used offline after that; you can see its state, and re-download it, under the Reading Model section in Vault Settings. Captures still work without it — that path just falls back to the patterns."
  },
  {
    question: "How does the app update itself?",
    answer: "Covault checks for a new build when it starts. Most updates apply themselves quietly and are there the next time you open the app. Anything that changes the Android side — the notification listener, the widget — needs the full install instead, and the app will offer it to you rather than doing it silently."
  },
  {
    question: "How do I link to a partner?",
    answer: "Open Vault Settings via the gear icon and scroll to 'Vault Sharing.' One of you taps 'Show my code' and reads it out; the other types it into 'Enter your partner's code' and taps 'Link with this code'. The code works once, for 30 minutes, and the first phone updates by itself once it has been used. They need a Covault account of their own first. Once linked you each see the other's entries and budgets; each of you still edits only your own."
  },
  {
    question: "How do I disconnect from a partner?",
    answer: "Open Vault Settings and scroll to 'Vault Sharing.' Tap 'Disconnect Partner' to unlink your partner. Your data stays safe — you'll just return to solo budgeting."
  },
  {
    question: "How do I report a problem?",
    answer: "In Vault Settings, scroll to the 'Support & Feedback' section and tap 'Report a Problem.' This opens an email to the development team."
  },
  {
    question: "How do I suggest a new feature?",
    answer: "Open Vault Settings via the gear icon and scroll to 'Support & Feedback.' Tap 'Request a Feature' to send an email directly to the development team."
  },
];

const FAQModal: React.FC<FAQModalProps> = ({ onClose }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { isClosing, close } = useDialogExit();
  const dismiss = () => close(onClose);
  const handleKeyDown = useDialogInteraction(dialogRef, dismiss, { disabled: isClosing });

  const [searchQuery, setSearchQuery] = useState('');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const filteredFAQs = useMemo(() => {
    if (!searchQuery.trim()) return FAQ_ITEMS;
    const q = searchQuery.toLowerCase();
    return FAQ_ITEMS.filter(
      (item) =>
        item.question.toLowerCase().includes(q) ||
        item.answer.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  return (
    <div className={`fixed inset-0 z-[120] bg-slate-900/50 backdrop-blur-lg flex items-center justify-center p-4 ${isClosing ? 'dialog-exiting dialog-exit-backdrop' : 'animate-in fade-in dialog-motion'}`}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="faq-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`w-full max-w-md bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl max-h-[85vh] flex flex-col border border-slate-100 dark:border-slate-800/60 overflow-hidden ${isClosing ? 'dialog-exiting dialog-exit-surface' : 'animate-in zoom-in-95 dialog-motion'}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 pb-4">
          <h2 id="faq-title" className="text-lg font-bold text-slate-700 dark:text-slate-100 tracking-tight">
            Frequently Asked
          </h2>
          <CloseButton onClick={dismiss} size="sm" />
        </div>

        {/* Search bar */}
        <div className="px-6 pb-4">
          <div className="relative">
            <svg
              className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 dark:text-slate-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search questions..."
              className="w-full pl-10 pr-4 py-3 text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-700 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500/50"
            />
          </div>
        </div>

        {/* FAQ list */}
        <div className="flex-1 overflow-y-auto px-6 pb-6 no-scrollbar">
          <div className="space-y-2">
            {filteredFAQs.length === 0 && (
              <p className="text-center text-xs text-slate-400 dark:text-slate-500 py-8">
                No matching questions found.
              </p>
            )}
            {filteredFAQs.map((item, index) => {
              const isExpanded = expandedIndex === index;
              return (
                <button
                  key={index}
                  onClick={() => setExpandedIndex(isExpanded ? null : index)}
                  className="w-full text-left p-4 bg-slate-50 dark:bg-slate-800/40 rounded-2xl border border-slate-100 dark:border-slate-700/50 transition-all active:scale-[0.98]"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-6 h-6 bg-emerald-50 dark:bg-emerald-900/30 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[10px] font-black text-emerald-500">?</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-slate-600 dark:text-slate-300 leading-snug">
                        {item.question}
                      </p>
                      {isExpanded && (
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-2 leading-relaxed animate-in fade-in slide-in-from-top-1 duration-200">
                          {item.answer}
                        </p>
                      )}
                    </div>
                    <svg
                      className={`w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0 mt-1 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      strokeWidth={3}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default FAQModal;
