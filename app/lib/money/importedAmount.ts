/**
 * Read one amount cell from an imported CSV, or null when it is not a number.
 *
 * The whole cell has to be the number. `parseFloat` reads a prefix and stops,
 * so "12abc" imported as $12 and "1.2.3" as $1.20 without a word — a purchase
 * recorded at an amount nobody typed. A leading minus is kept: a negative row
 * is how a hand-entered refund is stored.
 */
export function parseImportedAmount(raw: string): number | null {
  const text = String(raw ?? '').replace(/[$,\s]/g, '');
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}
