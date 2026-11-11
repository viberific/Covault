const GENERIC_APP_ERROR_MESSAGE =
  "Covault couldn't confirm whether that request completed. Check the screen before trying again.";

/**
 * Turn a technical or untrusted error into short, safe copy for the app.
 * Operation names are used only to choose fixed wording; the error itself is
 * never returned to the screen.
 */
export function appErrorMessage(error: unknown): string {
  const detail = typeof error === 'string'
    ? error.toLowerCase()
    : error instanceof Error
      ? error.message.toLowerCase()
      : '';

  // Nothing failed here and nothing is uncertain: the purchase is someone
  // else's. Says so, rather than suggesting the user check and try again.
  if (/belongs to your partner/.test(detail)) {
    return "That purchase is your partner's. Only they can change or delete it.";
  }

  // A bare "Failed to fetch" could come from a read or a write. Give read
  // guidance only when the message identifies both a read verb and its data.
  if (/(?:load(?:ing)?|read(?:ing)?|fetch(?:ing)?)\s*(?:transactions?|purchases?)\b/.test(detail)) {
    return "Covault couldn't load your purchases. Check your connection, then refresh Review.";
  }
  if (/(?:load(?:ing)?|read(?:ing)?|fetch(?:ing)?)\s*(?:budgets?|settings?|(?:monthly\s+)?income)\b/.test(detail)) {
    return "Covault couldn't load your settings and budgets. Check your connection, then refresh the screen.";
  }

  if (/monthly income|income/.test(detail)) {
    return "Covault couldn't confirm whether your monthly income changed. Check Settings before trying again.";
  }
  if (/theme/.test(detail)) {
    return "Covault couldn't confirm whether your theme changed. Check Settings before trying again.";
  }
  if (/budget|visibility/.test(detail)) {
    return "Covault couldn't confirm whether your budget changed. Check the budget before trying again.";
  }
  if (/transactions?|purchases?|\b(insert|update|delete)\b/.test(detail)) {
    return "Covault couldn't confirm whether your purchase changed. Check your purchases before trying again.";
  }
  if (/partner|household|link/.test(detail)) {
    return "Covault couldn't confirm whether household sharing changed. Check Settings before trying again.";
  }

  return GENERIC_APP_ERROR_MESSAGE;
}
