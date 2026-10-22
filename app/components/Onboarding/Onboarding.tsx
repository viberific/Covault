import React, { useEffect, useRef, useState } from 'react';
import { BudgetCategory } from '../../types';
import { SYSTEM_CATEGORIES } from '../../constants';
import {
  clearProgress,
  nextStep,
  previousStep,
  readProgress,
  resumeStep,
  writeProgress,
  type OnboardingStepId,
} from './onboardingProgress';
import { useWaitForPartner } from '../../hooks/useWaitForPartner';
import { useBackHandler } from '../../hooks/useBackHandler';
import IncomeStep from './steps/IncomeStep';
import BudgetLimitsStep from './steps/BudgetLimitsStep';
import CaptureStep from './steps/CaptureStep';
import SourcesStep from './steps/SourcesStep';
import TourStep from './steps/TourStep';
import OnboardingStepWrapper from './OnboardingStepWrapper';

/**
 * Everything the setup steps need to write what the user tells them.
 *
 * Each answer is saved as it is given rather than collected and committed at
 * the end: the capture step leaves the app for Android's settings, and the WebView
 * is routinely destroyed there, so an "end" is a moment the user may never
 * reach. See App/Components/Onboarding/onboardingProgress.ts.
 */
export interface OnboardingSetup {
  userId?: string;
  /** The user's real budget rows, once loaded. Never SYSTEM_CATEGORIES. */
  budgets: BudgetCategory[];
  hiddenCategories: string[];
  /** False while the first budgets read is still in flight. */
  budgetsReady: boolean;
  monthlyIncome: number;
  captureEnabled: boolean;
  onSaveIncome: (income: number) => void;
  onSaveBudgetLimit: (categoryId: string, limit: number) => void;
  onToggleHideCategory: (categoryId: string, visible: boolean) => void;
  onCaptureGranted: () => void;
}

interface OnboardingProps {
  onComplete: (isSolo: boolean, budgets: BudgetCategory[], partnerEmail?: string) => void;
  /** Absent in the web build and in tests; the intro then shows the slides alone. */
  setup?: OnboardingSetup;
  /**
   * Links the two accounts, right now.
   *
   * This step used to say "Send Invite" and send nothing: the address was kept
   * in memory, no email was ever composed, and the partner was never told
   * anything. Whoever used it believed their household was shared and it was
   * not. It now does exactly what Vault Sharing does — the same database
   * handshake — so the promise on the button is the thing that happens.
   */
  /**
   * Linking is code-only. An email route used to exist and linked both
   * accounts on one person's say-so, which meant anyone who knew a Covault
   * user's email address could attach themselves to it. The code lives on the
   * other person's screen, so asking for it IS the permission.
   */
  onGenerateLinkCode?: () => Promise<string | null>;
  onJoinWithCode?: (code: string) => Promise<{ ok: boolean; message?: string; partnerName?: string }>;
  /** Whether the partner has used the code this phone is showing. */
  onCheckForPartner?: () => Promise<{ linked: boolean; partnerName?: string }>;
}

const STEPS = [
  {
    title: "Spent vs. Projected",
    content: "Solid bars show current spending. Dashed bars project your future based on recurring bills.",
    icon: (
      <div className="relative">
        <div className="absolute inset-0 bg-emerald-500/10 blur-3xl rounded-full animate-pulse"></div>
        <svg className="w-32 h-32 text-emerald-600 dark:text-emerald-400 relative" viewBox="0 0 24 24" fill="currentColor">
          <rect x="2" y="20" width="20" height="1.5" rx="0.75" className="opacity-20" />
          <rect x="4" y="10" width="4" height="10" rx="1" className="animate-bar" style={{ animationDelay: '0.1s' }} />
          <rect x="10" y="6" width="4" height="14" rx="1" className="animate-bar opacity-60" style={{ animationDelay: '0.3s' }} />
          <rect x="16" y="14" width="4" height="6" rx="1" className="animate-bar opacity-30" style={{ animationDelay: '0.5s' }} />
        </svg>
      </div>
    )
  },
  {
    title: "Sync & Forget",
    content: "Covault listens for banking notifications to auto-file transactions. You just review and confirm.",
    icon: (
      <div className="relative">
        <div className="absolute inset-0 bg-blue-500/10 blur-3xl rounded-full animate-pulse"></div>
        <div className="animate-swing">
          <svg className="w-32 h-32 text-emerald-600 dark:text-emerald-400 relative" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17v1a3 3 0 11-6 0v-1h6z" />
          </svg>
        </div>
        <div className="absolute top-6 right-6 w-5 h-5 bg-emerald-500 rounded-full border-4 border-white dark:border-slate-950 animate-ping opacity-75"></div>
        <div className="absolute top-6 right-6 w-5 h-5 bg-emerald-500 rounded-full border-4 border-white dark:border-slate-950 shadow-sm"></div>
      </div>
    )
  },
  {
    title: "One switch to set",
    content: "Capture needs Android's permission to read your bank's alerts. There's a guided setup in Settings — three taps, and Covault does the rest with the app closed.",
    icon: (
      <div className="relative">
        <div className="absolute inset-0 bg-amber-500/10 blur-3xl rounded-full animate-pulse"></div>
        <svg className="w-32 h-32 text-emerald-600 dark:text-emerald-400 relative" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <rect x="2.5" y="7" width="19" height="10" rx="5" strokeWidth={1.5} />
          <circle cx="16.5" cy="12" r="3" fill="currentColor" stroke="none" className="animate-bar" />
        </svg>
      </div>
    )
  },
];


/**
 * The dots on the setup steps, which are the only ones drawn in the shell —
 * the opening slides carry their own indicator, and the two questions before
 * these are full-bleed screens with none.
 */
const SETUP_STEP_NUMBERS: Partial<Record<OnboardingStepId, number>> = {
  income: 1,
  limits: 2,
  capture: 3,
  sources: 4,
  // `tour` is deliberately absent. It is no longer a shelled step with dots —
  // it is a full-screen walkthrough with its own progress — so counting it
  // here would make every step before it say "of 5" and then stop at 4.
};
const SETUP_STEP_COUNT = Object.keys(SETUP_STEP_NUMBERS).length;


const StepWrapper = OnboardingStepWrapper;

const Onboarding: React.FC<OnboardingProps> = ({
  onComplete, setup, onGenerateLinkCode, onJoinWithCode, onCheckForPartner,
}) => {
  // Which named step we are on. The three opening slides are all `intro`; which
  // slide is `slide` below, and is deliberately not persisted — resuming to
  // slide two of three is not worth a write per tap.
  const [step, setStep] = useState<OnboardingStepId>('intro');
  const [slide, setSlide] = useState(0);
  const [solo, setSolo] = useState(true);
  const [partnerCode, setPartnerCode] = useState('');
  const [myCode, setMyCode] = useState<string | null>(null);
  const [generatingCode, setGeneratingCode] = useState(false);
  // Only set when the link actually went through. An address typed and then
  // skipped past is not a partner, and recording it would tell the user their
  // vault was shared when it is not — the exact lie this step used to tell.
  const [linkedEmail, setLinkedEmail] = useState<string | undefined>(undefined);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  // Set once the link has gone through, by either route. The step then says
  // so and waits for a tap, rather than moving on as if nothing happened.
  const [linkedWith, setLinkedWith] = useState<{ name?: string } | null>(null);

  // Whoever showed their code learns it was used here; nothing else would tell them.
  useWaitForPartner(step === 'partner' && !!myCode && !linkedWith, onCheckForPartner, (name) => {
    setLinkedWith({ name });
  });

  const userId = setup?.userId;

  // ── Picking up where they left off ──
  //
  // The capture step sends the user to Android's settings, which routinely
  // destroys the WebView. Without this they would come back to slide one and
  // have to answer everything again.
  //
  // An effect rather than a lazy useState initialiser because the user id
  // arrives from the session a beat after this first renders. Guarded by a ref
  // so it seats the step once per user and never yanks somebody backwards
  // afterwards.
  const hydratedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || hydratedFor.current === userId) return;
    hydratedFor.current = userId;
    const stored = readProgress(userId);
    if (!stored) return;
    setSolo(stored.solo);
    setStep(resumeStep(stored));
  }, [userId]);

  /** Move on, writing it down first — see App/Components/Onboarding/onboardingProgress.ts. */
  const goTo = (next: OnboardingStepId | null, isSolo: boolean = solo) => {
    if (next === null) {
      finish(isSolo);
      return;
    }
    writeProgress(userId, { step: next, solo: isSolo });
    setStep(next);
  };

  const advance = (isSolo: boolean = solo) => goTo(nextStep(step, { solo: isSolo }), isSolo);

  // Defaults to the address that actually linked, so any route out of the intro
  // — including `goTo(null)` from the last step — carries the partner with it.
  const finish = (isSolo: boolean, email: string | undefined = linkedEmail) => {
    clearProgress(userId);
    onComplete(isSolo, SYSTEM_CATEGORIES, email);
  };

  // The phone's back button retraces the intro: a slide at a time, then a step
  // at a time. At the very first slide there is nothing behind it, so it is
  // declined and the app leaves, as it would from any first screen.
  useBackHandler(true, () => {
    if (step === 'intro') {
      if (slide === 0) return false;
      setSlide(slide - 1);
      return true;
    }
    const previous = previousStep(step, { solo });
    if (previous === null) return false;
    writeProgress(userId, { step: previous, solo });
    setStep(previous);
    return true;
  });

  const handleNextIntro = (e: React.MouseEvent) => {
    e.preventDefault();
    if (slide < STEPS.length - 1) {
      setSlide(slide + 1);
      return;
    }
    advance();
  };

  // Solo used to end the intro on the spot. It now answers the question and
  // moves on to the setup steps; `finish` is what ends it, from the last step.
  const handleFinishSolo = () => {
    setSolo(true);
    // No `setup` means nothing downstream could save an answer — the web build,
    // or a test. Ending here is what the intro has always done, and is better
    // than walking the user into steps that would quietly write nothing.
    if (!setup) {
      finish(true);
      return;
    }
    goTo(nextStep('who', { solo: true }), true);
  };

  const handleShowMyCode = async () => {
    if (!onGenerateLinkCode || generatingCode) return;
    setGeneratingCode(true);
    setLinkError(null);
    try {
      setMyCode(await onGenerateLinkCode());
    } finally {
      setGeneratingCode(false);
    }
  };

  const handleFinishCouples = async () => {
    if (linking) return;
    const code = partnerCode.trim().toUpperCase();
    if (!code) return;

    // No linker passed (the web build, or a test): carry on rather than block.
    // The intro is not the only route to this — Vault Sharing does the same
    // thing — so a step that cannot link must never be a step that traps.
    if (!onJoinWithCode) {
      if (!setup) {
        finish(false, undefined);
        return;
      }
      goTo(nextStep('partner', { solo: false }), false);
      return;
    }

    setLinking(true);
    setLinkError(null);
    const result = await onJoinWithCode(code);
    setLinking(false);

    if (!result.ok) {
      // Stay on the step. The common failure is a code that has been used or
      // mistyped, and the answer to that is to ask for a fresh one — or carry
      // on alone, which is what the button below says.
      setLinkError(result.message || 'That code is not valid.');
      return;
    }
    // The partner's own email comes back on the linked user object once the
    // next load lands; the intro does not need it to move on.
    setLinkedEmail(undefined);
    setLinkedWith({ name: result.partnerName });
  };

  const continueAfterLink = () => {
    if (!setup) {
      finish(false, undefined);
      return;
    }
    goTo(nextStep('partner', { solo: false }), false);
  };

  // ── The setup steps ──
  //
  // Only where the app can actually write the answers down. Without `setup`
  // (the web build, or a test) the intro is the slides and the two questions it
  // has always been, rather than steps that would silently save nothing.
  const numberOf = (id: OnboardingStepId) => SETUP_STEP_NUMBERS[id] ?? 1;

  if (setup) {
    if (step === 'income') {
      return (
        <IncomeStep
          isSharedAccount={!solo}
          stepNumber={numberOf('income')}
          stepCount={SETUP_STEP_COUNT}
          onSave={setup.onSaveIncome}
          onNext={() => advance()}
          onSkip={() => advance()}
        />
      );
    }

    if (step === 'limits') {
      return (
        <BudgetLimitsStep
          budgets={setup.budgets}
          hiddenCategories={setup.hiddenCategories}
          budgetsReady={setup.budgetsReady}
          monthlyIncome={setup.monthlyIncome}
          stepNumber={numberOf('limits')}
          stepCount={SETUP_STEP_COUNT}
          onSaveLimit={setup.onSaveBudgetLimit}
          onToggleHide={setup.onToggleHideCategory}
          onNext={() => advance()}
          onSkip={() => advance()}
        />
      );
    }

    if (step === 'capture') {
      return (
        <CaptureStep
          stepNumber={numberOf('capture')}
          stepCount={SETUP_STEP_COUNT}
          captureEnabled={setup.captureEnabled}
          onGranted={setup.onCaptureGranted}
          onNext={() => advance()}
          onSkip={() => advance()}
        />
      );
    }

    if (step === 'sources') {
      return (
        <SourcesStep
          stepNumber={numberOf('sources')}
          stepCount={SETUP_STEP_COUNT}
          captureEnabled={setup.captureEnabled}
          onNext={() => advance()}
          onSkip={() => advance()}
        />
      );
    }

    if (step === 'tour') {
      return (
        <TourStep onFinish={() => finish(solo, linkedEmail)} />
      );
    }
  }

  // STEP: WHO IS THIS FOR (after intro steps)
  if (step === 'who') {
    return (
      <StepWrapper className="justify-center text-center space-y-12">
        <div className="space-y-4 animate-nest">
          <h2 className="text-4xl font-bold text-slate-600 dark:text-slate-100 tracking-tight">Who is this for?</h2>
          <p className="text-slate-400 dark:text-slate-500 font-medium tracking-wide text-xs">Clarity for yourself or confidence together.</p>
        </div>

        <div className="space-y-6">
          <button
            type="button"
            onClick={handleFinishSolo}
            className="w-full p-8 rounded-[3rem] bg-white dark:bg-slate-900 border-2 border-transparent hover:border-emerald-500 transition-all duration-200 active:scale-[0.97] flex items-center space-x-6 text-left shadow-2xl shadow-slate-200/20 dark:shadow-none ring-1 ring-inset ring-white/10 dark:ring-white/[0.04]"
          >
            <div className="w-16 h-16 bg-slate-50 dark:bg-slate-800 rounded-2xl flex items-center justify-center shadow-sm">
              <svg className="w-8 h-8 text-slate-400 dark:text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </div>
            <div className="flex-1">
              <div className="font-bold text-xl text-slate-600 dark:text-slate-100 mb-1 tracking-tight">Just Me</div>
              <div className="text-xs text-slate-400 dark:text-slate-500 font-medium tracking-wide">Personal budget tracking.</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              setSolo(false);
              goTo('partner', false);
            }}
            className="w-full p-8 rounded-[3rem] bg-white dark:bg-slate-900 border-2 border-transparent hover:border-emerald-500 transition-all duration-200 active:scale-[0.97] flex items-center space-x-6 text-left shadow-2xl shadow-slate-200/20 dark:shadow-none ring-1 ring-inset ring-white/10 dark:ring-white/[0.04]"
          >
            <div className="w-16 h-16 bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl flex items-center justify-center shadow-sm">
              <svg className="w-8 h-8 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            </div>
            <div className="flex-1">
              <div className="font-bold text-xl text-slate-600 dark:text-slate-100 mb-1 tracking-tight">Couples</div>
              <div className="text-xs text-slate-400 dark:text-slate-500 font-medium tracking-wide">Combined budgeting together.</div>
            </div>
          </button>
        </div>
      </StepWrapper>
    );
  }

  // STEP: PARTNER CODE (for couples)
  //
  // A code, not an email. The code exists on the other person's screen, so
  // there is no way to get one without asking them for it — and the asking is
  // the consent. An email address is something you can know without their
  // knowing you know it.
  if (step === 'partner' && linkedWith) {
    return (
      <StepWrapper className="justify-center text-center space-y-10">
        <div className="space-y-6 animate-nest">
          <div className="w-20 h-20 mx-auto bg-emerald-50 dark:bg-emerald-900/20 rounded-[2rem] flex items-center justify-center">
            <svg className="w-10 h-10 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 role="status" className="text-4xl font-bold text-slate-600 dark:text-slate-100 tracking-tight">
            {linkedWith.name ? `Linked with ${linkedWith.name}` : 'You’re linked'}
          </h2>
          <p className="text-slate-400 dark:text-slate-500 font-medium tracking-wide text-xs leading-relaxed px-4">
            You now share one balance, and each of you sees the other’s purchases.
            You can choose how much they see under Vault Sharing.
          </p>
        </div>
        <button
          onClick={continueAfterLink}
          className="w-full py-6 bg-emerald-600 text-white rounded-[2rem] font-semibold text-lg shadow-2xl shadow-emerald-500/20 active:scale-[0.97] transition-all duration-200 tracking-wide"
        >
          Continue
        </button>
      </StepWrapper>
    );
  }

  if (step === 'partner') {
    return (
      <StepWrapper className="justify-center text-center space-y-10">
        <div className="space-y-4 animate-nest">
          <h2 className="text-4xl font-bold text-slate-600 dark:text-slate-100 tracking-tight">Link Partner</h2>
          <p className="text-slate-400 dark:text-slate-500 font-medium tracking-wide text-xs">
            One of you shows a code, the other types it in. Whoever already has
            Covault open can show theirs.
          </p>
        </div>

        <div className="space-y-8">
           <div className="relative flex flex-col items-center">
             <input
              autoFocus
              inputMode="text"
              autoCapitalize="characters"
              placeholder="THEIR CODE"
              value={partnerCode}
              onChange={e => { setPartnerCode(e.target.value.toUpperCase()); setLinkError(null); }}
              className="w-full bg-transparent border-b-2 border-slate-200 dark:border-slate-800 py-6 text-2xl font-black tracking-[0.25em] text-slate-500 dark:text-slate-100 placeholder-slate-200 dark:placeholder-slate-800 outline-none text-center focus:border-emerald-500 transition-all"
            />
           </div>

           {linkError && (
             <p className="text-xs font-medium text-rose-500 leading-relaxed px-2">
               {linkError}
             </p>
           )}

           <button
              disabled={partnerCode.trim().length === 0 || linking}
              onClick={handleFinishCouples}
              className="w-full py-6 bg-emerald-600 text-white rounded-[2rem] font-semibold text-lg shadow-2xl shadow-emerald-500/20 active:scale-[0.97] disabled:opacity-30 transition-all duration-200 tracking-wide"
            >
              {linking ? 'Linking…' : 'Link Partner'}
            </button>

           {/* The other side of the same exchange, for whoever got here first. */}
           {onGenerateLinkCode && (
             myCode ? (
               <div className="space-y-1.5 animate-in fade-in duration-300">
                 <p className="text-[10px] font-semibold tracking-widest uppercase text-slate-400 dark:text-slate-500">
                   Your code
                 </p>
                 <p className="text-3xl font-bold tracking-[0.2em] text-emerald-600 dark:text-emerald-400">
                   {myCode}
                 </p>
                 <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-snug px-4">
                   Read this to your partner instead. It works once, for 30 minutes.
                 </p>
                 {onCheckForPartner && (
                   <p className="flex items-center justify-center gap-2 pt-1 text-[10px] font-semibold text-slate-400 dark:text-slate-500">
                     <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
                     Waiting for your partner to enter it
                   </p>
                 )}
               </div>
             ) : (
               <button
                 onClick={handleShowMyCode}
                 disabled={generatingCode}
                 className="text-slate-400 dark:text-slate-600 font-medium text-[10px] tracking-wide hover:text-emerald-500 transition-colors disabled:opacity-50"
               >
                 {generatingCode ? 'Getting your code…' : 'Or show them my code instead'}
               </button>
             )
           )}
        </div>

        <button
          onClick={() =>
            setup ? goTo(nextStep('partner', { solo: false }), false) : finish(false)
          }
          className="text-slate-400 dark:text-slate-600 font-medium text-[10px] tracking-wide hover:text-emerald-500 transition-colors"
        >
          Skip for now — you can link any time under Vault Sharing
        </button>

        <button
          onClick={() => goTo('who')}
          className="text-slate-400 dark:text-slate-600 font-medium text-[10px] tracking-wide"
        >
          Go Back
        </button>
      </StepWrapper>
    );
  }

  // INTRO STEPS (0, 1)
  return (
    <StepWrapper>
      <div className="flex-1 flex flex-col items-center justify-center space-y-12">
        <div className="w-72 h-72 bg-white dark:bg-slate-900 rounded-[4rem] flex items-center justify-center shadow-2xl border border-slate-100 dark:border-slate-800/60 animate-nest overflow-hidden relative">
           <div className="absolute inset-0 bg-slate-50/50 dark:bg-slate-800/20" />
           {STEPS[slide].icon}
        </div>
        <div className="text-center space-y-6 max-w-xs animate-nest" style={{ animationDelay: '0.2s' }}>
          <h2 className="text-3xl font-bold text-slate-600 dark:text-slate-100 tracking-tighter leading-tight">{STEPS[slide].title}</h2>
          <p className="text-slate-400 dark:text-slate-500 font-medium text-sm tracking-wide leading-relaxed">{STEPS[slide].content}</p>
        </div>
      </div>

      <div className="flex items-center justify-between mt-auto pt-8">
        <div className="flex space-x-4">
          {STEPS.map((_, i) => (
            <div key={i} className={`h-2 rounded-full transition-all duration-700 ${i === slide ? 'w-10 bg-emerald-600' : 'w-2 bg-slate-200 dark:bg-slate-800'}`} />
          ))}
        </div>
        <button
          type="button"
          onClick={handleNextIntro}
          className="w-20 h-20 bg-emerald-600 rounded-[2.5rem] flex items-center justify-center text-white shadow-2xl active:scale-[0.97] transition-all duration-200"
        >
          <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </StepWrapper>
  );
};

export default Onboarding;
