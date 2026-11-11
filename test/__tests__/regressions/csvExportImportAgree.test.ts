import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseImportedAmount } from '../../../app/lib/money/importedAmount';

/**
 * A file the app exports is one the app can read back, on any phone.
 *
 * The export wrote each date in the phone's own format. On a phone set to a
 * day-first region that is 03/04/2026 for the 3rd of April, which the import
 * screen read back as March 4th — and refused outright from the 13th of any
 * month on. The import also took any amount that merely STARTED with a
 * number.
 */

const read = (path: string) => readFileSync(resolve(__dirname, '../../..', path), 'utf8');

describe('the exported date', () => {
  const source = read(
    'app/components/settings/DashboardSettingsModal/sections/ExportTransactionsSection.tsx',
  );

  it('is written as YYYY-MM-DD, never in the phone’s regional format', () => {
    expect(source).toContain('escapeCSV(tx.date.slice(0, 10))');
    expect(source).not.toMatch(/escapeCSV\([^)]*toLocaleDateString/);
  });
});

describe('an imported amount', () => {
  it('reads what the export writes, with or without a dollar sign and commas', () => {
    expect(parseImportedAmount('42.50')).toBe(42.5);
    expect(parseImportedAmount('$1,234.56')).toBe(1234.56);
    expect(parseImportedAmount(' 7 ')).toBe(7);
  });

  it('keeps a refund negative', () => {
    expect(parseImportedAmount('-60.00')).toBe(-60);
  });

  it('refuses a cell that only starts with a number', () => {
    expect(parseImportedAmount('12abc')).toBeNull();
    expect(parseImportedAmount('1.2.3')).toBeNull();
    expect(parseImportedAmount('')).toBeNull();
    expect(parseImportedAmount('twelve')).toBeNull();
  });
});
