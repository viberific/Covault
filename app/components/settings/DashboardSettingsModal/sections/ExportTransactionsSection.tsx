import { log } from '../../../../lib/observability/log';
import React, { useState, useMemo } from 'react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Transaction, BudgetCategory } from '../../../../types';
import { parseLocalDate, getLocalToday, toLocalIsoDay } from '../../../../lib/time/dateUtils';
import { isRefund } from '../../../../lib/transactions/refundMatching';
import CalendarPicker from '../../../common/CalendarPicker';
import SettingsCard from '../../../common/SettingsCard';
import SectionHeader from '../../../common/SectionHeader';

interface ExportTransactionsSectionProps {
  transactions: Transaction[];
  budgets: BudgetCategory[];
}

const ExportTransactionsSection: React.FC<ExportTransactionsSectionProps> = ({
  transactions,
  budgets,
}) => {
  // Use local date — `new Date().toISOString()` returns the UTC date
  // which can be off by one day for users in negative-offset timezones
  // (e.g. America/Chicago after ~6 PM local). This made the default
  // export range end on "tomorrow" UTC while the user's local clock
  // still said "today".
  const today = getLocalToday();
  const localToday = parseLocalDate(today);
  const thirtyDaysAgo = toLocalIsoDay(
    new Date(localToday.getTime() - 30 * 24 * 60 * 60 * 1000)
  );

  const [startDate, setStartDate] = useState(thirtyDaysAgo);
  const [endDate, setEndDate] = useState(today);
  const [exported, setExported] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState<'start' | 'end' | null>(null);

  const handleExport = async () => {
    const start = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T23:59:59');

    const filtered = transactions.filter((tx) => {
      const txDate = parseLocalDate(tx.date);
      return txDate >= start && txDate <= end && !tx.is_projected && !isRefund(tx);
    });

    if (filtered.length === 0) {
      return;
    }

    // Sort by date ascending
    filtered.sort(
      (a, b) => parseLocalDate(a.date).getTime() - parseLocalDate(b.date).getTime(),
    );

    const escapeCSV = (value: string): string => {
      if (
        value.includes(',') ||
        value.includes('"') ||
        value.includes('\n')
      ) {
        return '"' + value.replace(/"/g, '""') + '"';
      }
      return value;
    };

    const budgetMap = new Map(budgets.map((b) => [b.id, b.name]));

    const headers = ['Date', 'Vendor', 'Amount', 'Category', 'Recurrence', 'Label'];
    const rows = filtered.map((tx) => [
      // YYYY-MM-DD, not the phone's own date format. A locale date is
      // ambiguous the moment the file leaves the phone — 03/04/2026 is March
      // in one country and April in the next — and the import screen read a
      // day-first file back with the day and month swapped, or refused it.
      escapeCSV(tx.date.slice(0, 10)),
      escapeCSV(tx.vendor),
      escapeCSV(tx.amount.toFixed(2)),
      escapeCSV(tx.budget_id ? (budgetMap.get(tx.budget_id) || tx.budget_id) : ''),
      escapeCSV(tx.recurrence || 'One-time'),
      escapeCSV(tx.label || ''),
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join(
      '\r\n',
    );

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const fileName = `covault-transactions-${startDate}-to-${endDate}.csv`;

    // On native platforms, save the CSV directly to the Documents folder so
    // the user can find it in their device's file manager without going
    // through the share sheet.  Falls back to the cache + share approach
    // if the direct write fails (e.g. on devices where Documents is
    // unavailable).
    if (Capacitor.isNativePlatform()) {
      try {
        await Filesystem.writeFile({
          path: fileName,
          data: csvContent,
          directory: Directory.Documents,
          encoding: Encoding.UTF8,
        });
      } catch (docErr) {
        // Directory.Documents may not be available on all devices – fall
        // back to writing to Cache and opening the system share sheet.
        log.warn('[ExportCSV] Documents write failed, falling back to share:', docErr);
        try {
          await Filesystem.writeFile({
            path: fileName,
            data: csvContent,
            directory: Directory.Cache,
            encoding: Encoding.UTF8,
          });

          const uriResult = await Filesystem.getUri({
            path: fileName,
            directory: Directory.Cache,
          });

          await Share.share({
            title: 'Covault Transactions',
            files: [uriResult.uri],
            dialogTitle: 'Save or share CSV',
          });
        } catch (shareErr) {
          // User cancelled share or an unexpected error
          log.warn('[ExportCSV] Share fallback failed:', shareErr);
        }
      }
      setExported(true);
      setTimeout(() => setExported(false), 2000);
      return;
    }

    // Fallback: standard blob download for desktop/web browsers
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', fileName);
    link.style.visibility = 'hidden';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    setExported(true);
    setTimeout(() => setExported(false), 2000);
  };

  const filteredCount = useMemo(() => {
    const start = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T23:59:59');
    return transactions.filter((tx) => {
      const txDate = parseLocalDate(tx.date);
      return txDate >= start && txDate <= end && !tx.is_projected && !isRefund(tx);
    }).length;
  }, [transactions, startDate, endDate]);

  return (
    <SettingsCard id="settings-export-container">
      <SectionHeader title="Export Transactions" subtitle="Download a CSV report for a date range." className="mb-4" />

      <div className="flex gap-3 mb-4">
        <div className="flex-1">
          <label htmlFor="export-start-date" className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 tracking-wide block mb-1">
            From
          </label>
          <button
            id="export-start-date"
            type="button"
            onClick={() => setCalendarOpen('start')}
            className="w-full px-3 py-2.5 text-xs text-left bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-700 dark:text-slate-200 active:scale-[0.98] transition-all"
          >
            {new Date(startDate + 'T00:00:00').toLocaleDateString()}
          </button>
        </div>
        <div className="flex-1">
          <label htmlFor="export-end-date" className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 tracking-wide block mb-1">
            To
          </label>
          <button
            id="export-end-date"
            type="button"
            onClick={() => setCalendarOpen('end')}
            className="w-full px-3 py-2.5 text-xs text-left bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-700 dark:text-slate-200 active:scale-[0.98] transition-all"
          >
            {new Date(endDate + 'T00:00:00').toLocaleDateString()}
          </button>
        </div>
      </div>

      {calendarOpen === 'start' && (
        <CalendarPicker
          value={startDate}
          onChange={(date) => setStartDate(date)}
          onClose={() => setCalendarOpen(null)}
        />
      )}
      {calendarOpen === 'end' && (
        <CalendarPicker
          value={endDate}
          onChange={(date) => setEndDate(date)}
          onClose={() => setCalendarOpen(null)}
        />
      )}

      <button
        onClick={handleExport}
        disabled={filteredCount === 0}
        className={`w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl text-xs font-semibold tracking-wide transition-all duration-200 active:scale-[0.97] ${
          exported
            ? 'bg-emerald-500 text-white'
            : filteredCount === 0
              ? 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed'
              : 'bg-emerald-50 dark:bg-emerald-900/20 border-2 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30'
        }`}
      >
        {exported && (
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        )}
        {exported
          ? 'Downloaded!'
          : filteredCount === 0
            ? 'No Transactions'
            : `Export ${filteredCount} Transaction${filteredCount !== 1 ? 's' : ''}`}
      </button>
    </SettingsCard>
  );
};

export default ExportTransactionsSection;
