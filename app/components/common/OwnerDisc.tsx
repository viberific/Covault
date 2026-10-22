import type React from 'react';

export type DiscOwner = 'you' | 'them';

interface OwnerDiscProps {
  owner: DiscOwner;
  /** First letter of that person's name. Empty draws a plain disc. */
  initial: string;
  /** `sm` is the header button's; `md` fronts a purchase. */
  size?: 'sm' | 'md';
  /** Layout and motion from the caller; the disc brings only its look. */
  className?: string;
  'data-disc'?: string;
}

// Emerald is you and sky is them, the one pairing used everywhere a person is
// shown. Dark letters on the bright fill read in both themes; white on the
// same emerald or sky would not.
const OWNER_LOOK: Record<DiscOwner, string> = {
  you: 'bg-emerald-500 dark:bg-emerald-400 text-emerald-950',
  them: 'bg-sky-500 dark:bg-sky-400 text-sky-950',
};

const SIZE: Record<NonNullable<OwnerDiscProps['size']>, string> = {
  sm: 'w-4 h-4 text-[10px]',
  md: 'w-6 h-6 text-[12px]',
};

/**
 * The round symbol for one person: their colour and the first letter of their
 * name. It is the header's Me / Us / Them button and the front of every
 * purchase in a shared household, so a purchase's owner reads the same way the
 * view choice does.
 *
 * Decorative: whoever it stands for is also said in words wherever it is used.
 */
const OwnerDisc: React.FC<OwnerDiscProps> = ({
  owner,
  initial,
  size = 'sm',
  className = '',
  'data-disc': dataDisc,
}) => (
  <span
    aria-hidden="true"
    data-disc={dataDisc}
    className={`flex items-center justify-center rounded-full font-extrabold leading-none ring-1 ring-inset ring-black/15 ${SIZE[size]} ${OWNER_LOOK[owner]} ${className}`}
  >
    {initial}
  </span>
);

export default OwnerDisc;
