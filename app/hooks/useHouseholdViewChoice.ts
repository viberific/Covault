import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import type { HouseholdView } from '../lib/budgets/householdSharing';

/**
 * The Me / Us / Them view the person picked, or null for "none picked", which
 * the dashboard reads as Us.
 *
 * Deliberately not durable, for the reason the month on the chart's rail is
 * not: looking at one person's spending is a question, not a setting. A
 * dashboard that opened on "just me" would show half the household's money
 * under a balance that is the whole of it, and nothing on screen would say
 * so until they noticed the button. So the choice lives only in memory and is
 * dropped the moment their attention leaves — the app going to the background
 * or coming back, or the tab being hidden or restored on the web — and a
 * fresh launch starts on Us because there is nothing stored to start from.
 */
export function useHouseholdViewChoice(): [HouseholdView | null, (view: HouseholdView) => void] {
  const [chosen, setChosen] = useState<HouseholdView | null>(null);

  const reset = useCallback(() => {
    // Functional, so a reset while already on the default is a no-op React can
    // bail out of rather than a render.
    setChosen((prev) => (prev === null ? prev : null));
  }, []);

  useEffect(() => {
    document.addEventListener('visibilitychange', reset);

    let removeNative: (() => void) | undefined;
    if (Capacitor.isNativePlatform()) {
      const pause = CapApp.addListener('pause', reset);
      const resume = CapApp.addListener('resume', reset);
      removeNative = () => {
        void pause.then((h) => h.remove());
        void resume.then((h) => h.remove());
      };
    }

    return () => {
      document.removeEventListener('visibilitychange', reset);
      removeNative?.();
    };
  }, [reset]);

  return [chosen, setChosen];
}
