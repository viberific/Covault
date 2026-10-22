import { useEffect, useRef } from 'react';

/** How often a phone showing its link code asks whether it has been used. */
export const PARTNER_CHECK_INTERVAL_MS = 3000;

type CheckForPartner = () => Promise<{ linked: boolean; partnerName?: string }>;

/**
 * Watches for the partner to use the code this phone is showing.
 *
 * The code is typed on the OTHER phone and nothing tells this one, so the
 * person who showed it used to be left looking at it after the link had
 * already happened. While `active`, this asks every few seconds — and straight
 * away when the app comes back to the foreground, since showing a code often
 * means switching to a messaging app to send it — and calls `onLinked` once.
 * Nothing is asked while the app is in the background.
 */
export function useWaitForPartner(
  active: boolean,
  check: CheckForPartner | undefined,
  onLinked: (partnerName?: string) => void,
): void {
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;

  useEffect(() => {
    if (!active || !check) return;
    let stopped = false;
    let inFlight = false;

    const ask = async () => {
      if (stopped || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const result = await check();
        if (!stopped && result.linked) {
          stopped = true;
          onLinkedRef.current(result.partnerName);
        }
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => { void ask(); }, PARTNER_CHECK_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void ask(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, check]);
}
