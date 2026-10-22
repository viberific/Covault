import React from 'react';
import type { HouseholdView } from '../../lib/budgets/householdSharing';
import OwnerDisc from '../common/OwnerDisc';

interface HouseholdViewButtonProps {
  view: HouseholdView;
  /** First letter of the signed-in person's name. Drawn on their disc. */
  myInitial: string;
  /** First letter of the partner's name. Drawn on theirs. */
  partnerInitial: string;
  /** The partner's first name. For screen readers; the discs carry only a letter. */
  partnerLabel: string;
  /** Receives the next view in the cycle Me → Us → Them → Me. */
  onChange: (view: HouseholdView) => void;
}

const NEXT: Record<HouseholdView, HouseholdView> = { me: 'us', us: 'them', them: 'me' };

// Where each disc sits in each view. Transform and opacity only, so a change
// is composited on the GPU and never lays anything out mid-animation.
//   me   — your disc alone, centred
//   us   — both, overlapping
//   them — their disc alone, centred
// The hidden disc shrinks as it fades, so it seems to tuck behind the other
// rather than blink out.
const YOU_DISC: Record<HouseholdView, string> = {
  me: 'translate-x-0 scale-100 opacity-100',
  us: '-translate-x-[0.375rem] scale-100 opacity-100',
  them: 'translate-x-[0.375rem] scale-50 opacity-0',
};
const THEIR_DISC: Record<HouseholdView, string> = {
  me: '-translate-x-[0.375rem] scale-50 opacity-0',
  us: 'translate-x-[0.375rem] scale-100 opacity-100',
  them: 'translate-x-0 scale-100 opacity-100',
};

// 16px discs centred in the 36px button.
const DISC =
  'absolute top-1/2 left-1/2 -mt-2 -ml-2 motion-safe:transition-[transform,opacity] motion-safe:duration-[320ms] motion-safe:ease-[cubic-bezier(0.32,0.72,0.24,1)]';

/**
 * Whose spending the dashboard shows, as one button the size of the settings
 * cog on the other side of the header.
 *
 * It costs no height: the header row already has an empty left end. Two discs
 * stand for the two people, each wearing its owner's first letter and the
 * colour of that person's tag on every purchase — emerald for you, sky for
 * them. One disc is "just me", both overlapping is "us", the other is "just
 * them", so the button says what it is showing without a caption. The discs
 * slide together and apart on the app's 320ms clock.
 */
const HouseholdViewButton: React.FC<HouseholdViewButtonProps> = ({
  view,
  myInitial,
  partnerInitial,
  partnerLabel,
  onChange,
}) => {
  const describe = (v: HouseholdView) =>
    v === 'me' ? 'just you' : v === 'us' ? 'both of you' : `just ${partnerLabel}`;

  return (
    <div className="relative">
      <button
        type="button"
        id="household-view-button"
        onClick={() => onChange(NEXT[view])}
        aria-label={`Showing ${describe(view)}. Tap to show ${describe(NEXT[view])}.`}
        className="relative block w-9 h-9 transition-all duration-200 active:scale-[0.97] bg-white/50 dark:bg-slate-800/50 backdrop-blur-md rounded-xl ring-1 ring-inset ring-white/10 dark:ring-white/[0.04] shadow-sm"
      >
        <OwnerDisc owner="you" initial={myInitial} data-disc="you" className={`${DISC} ${YOU_DISC[view]}`} />
        <OwnerDisc owner="them" initial={partnerInitial} data-disc="them" className={`${DISC} ${THEIR_DISC[view]}`} />
      </button>

      {/* Announced for screen readers whenever the view changes. */}
      <span className="sr-only" role="status">
        {`Showing ${describe(view)}`}
      </span>
    </div>
  );
};

export default HouseholdViewButton;
