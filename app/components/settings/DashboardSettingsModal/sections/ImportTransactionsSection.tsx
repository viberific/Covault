import React, { useState, useRef } from 'react';
import { restFetch } from '../../../../lib/api/apiHelpers';
import { parseImportedAmount } from '../../../../lib/money/importedAmount';
import type { BudgetCategory } from '../../../../types';
import SettingsCard from '../../../common/SettingsCard';
import SectionHeader from '../../../common/SectionHeader';

interface ImportTransactionsSectionProps {
  budgets: BudgetCategory[];
  userId: string | undefined;
  onImportComplete: () => void;
}

const EXPECTED_HEADERS = ['date', 'vendor', 'amount', 'category', 'recurrence'];

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

const ImportTransactionsSection: React.FC<ImportTransactionsSectionProps> = ({
  budgets,
  userId,
  onImportComplete,
}) => {
  const [status, setStatus] = useState<'idle' | 'error' | 'success'>('idle');
  const [message, setMessage] = useState('');
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (!userId) {
      setStatus('error');
      setMessage('Not signed in.');
      // Clear the input so the same file can be re-selected after sign-in.
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setImporting(true);
    setStatus('idle');
    setMessage('');

    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim());

      if (lines.length < 2) {
        setStatus('error');
        setMessage('CSV must have a header row and at least one data row.');
        return;
      }

      // Validate header
      const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
      const missingHeaders = EXPECTED_HEADERS.filter((h) => !headers.includes(h));
      if (missingHeaders.length > 0) {
        setStatus('error');
        setMessage(`Missing columns: ${missingHeaders.join(', ')}. Expected: Date, Vendor, Amount, Category, Recurrence.`);
        return;
      }

      const dateIdx = headers.indexOf('date');
      const vendorIdx = headers.indexOf('vendor');
      const amountIdx = headers.indexOf('amount');
      const categoryIdx = headers.indexOf('category');
      const recurrenceIdx = headers.indexOf('recurrence');

      const budgetMap = new Map<string, string>(budgets.map((b) => [b.name.toLowerCase(), b.name]));
      const validRecurrences = new Set(['one-time', 'biweekly', 'monthly', 'yearly']);

      const rows: Array<{
        user_id: string;
        vendor: string;
        amount: number;
        date: string;
        budget: string;
        recur: string;
        type: string;
        is_projected: boolean;
        source: string;
      }> = [];

      const errors: string[] = [];

      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        if (cols.length < 5) {
          errors.push(`Row ${i + 1}: not enough columns.`);
          continue;
        }

        const rawDate = cols[dateIdx];
        const vendor = cols[vendorIdx];
        const rawAmount = cols[amountIdx];
        const rawCategory = cols[categoryIdx];
        const rawRecurrence = cols[recurrenceIdx];

        // Parse date — accept YYYY-MM-DD or locale date strings
        let isoDate: string;
        if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
          isoDate = rawDate; // Already correct format, no timezone shift
        } else {
          const parsedDate = new Date(rawDate);
          if (isNaN(parsedDate.getTime())) {
            errors.push(`Row ${i + 1}: invalid date "${rawDate}".`);
            continue;
          }
          const y = parsedDate.getFullYear();
          const m = String(parsedDate.getMonth() + 1).padStart(2, '0');
          const d = String(parsedDate.getDate()).padStart(2, '0');
          isoDate = `${y}-${m}-${d}`;
        }

        // Parse amount
        const amount = parseImportedAmount(rawAmount);
        if (amount === null) {
          errors.push(`Row ${i + 1}: invalid amount "${rawAmount}".`);
          continue;
        }

        // Match category
        const budgetName = budgetMap.get(rawCategory.toLowerCase());
        if (!budgetName) {
          errors.push(`Row ${i + 1}: unknown category "${rawCategory}". Valid: ${budgets.map((b) => b.name).join(', ')}.`);
          continue;
        }

        // Recurrence
        const recurrence = rawRecurrence.toLowerCase();
        const recur = validRecurrences.has(recurrence)
          ? rawRecurrence.charAt(0).toUpperCase() + rawRecurrence.slice(1).toLowerCase()
          : 'One-time';

        if (!vendor.trim()) {
          errors.push(`Row ${i + 1}: empty vendor.`);
          continue;
        }

        rows.push({
          user_id: userId,
          vendor: vendor.trim(),
          amount,
          date: isoDate,
          budget: budgetName,
          recur,
          type: 'Manual',
          is_projected: false,
          // Mark imported rows so the dedup logic can distinguish them from
          // notification-inserted and executor-spawned rows of the same
          // vendor+amount.
          source: 'import',
        });
      }

      if (rows.length === 0) {
        setStatus('error');
        setMessage(errors.length > 0 ? errors.slice(0, 5).join(' ') : 'No valid rows found.');
        return;
      }

      // Insert in batches of 100
      let insertedCount = 0;
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        const res = await restFetch(`/transactions`, {
          method: 'POST',
          body: JSON.stringify(batch),
        });
        if (!res.ok) {
          const body = await res.text();
          setStatus('error');
          setMessage(`Database error at row ${i + 1}: ${body.slice(0, 120)}`);
          return;
        }
        insertedCount += batch.length;
      }

      const warnText = errors.length > 0
        ? ` (${errors.length} row${errors.length > 1 ? 's' : ''} skipped)`
        : '';

      setStatus('success');
      setMessage(`Imported ${insertedCount} transaction${insertedCount !== 1 ? 's' : ''}${warnText}.`);
      onImportComplete();
    } catch {
      setStatus('error');
      setMessage('Failed to read file.');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <SettingsCard>
      <SectionHeader title="Import Transactions" subtitle="Upload a CSV to bulk-add transactions." className="mb-4" />

      <p className="text-[10px] font-medium text-slate-400 dark:text-slate-500 mb-3">
        Required columns: <span className="font-bold text-slate-500 dark:text-slate-300">Date, Vendor, Amount, Category, Recurrence</span>
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />

      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={importing || !userId}
        className={`w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl text-xs font-semibold tracking-wide transition-all duration-200 active:scale-[0.97] ${
          importing
            ? 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-wait'
            : status === 'success'
              ? 'bg-emerald-500 text-white'
              : 'bg-blue-500 hover:bg-blue-600 text-white shadow-lg shadow-blue-500/20'
        }`}
      >
        {importing ? 'Importing…' : status === 'success' ? '✓ Done' : '↑ Choose CSV File'}
      </button>

      {message && (
        <p
          className={`mt-3 text-[11px] font-medium ${
            status === 'error'
              ? 'text-rose-500 dark:text-rose-400'
              : 'text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {message}
        </p>
      )}
    </SettingsCard>
  );
};

export default ImportTransactionsSection;
