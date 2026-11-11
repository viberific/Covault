import { log } from '../../../../lib/observability/log';
import React, { useState, useMemo } from 'react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { BudgetCategory, Transaction } from '../../../../types';
import SettingsCard from '../../../common/SettingsCard';
import SectionHeader from '../../../common/SectionHeader';
import { getLocalMonthKey } from '../../../../lib/time/dateUtils';
import { getBudgetColor } from '../../../../lib/budgets/budgetColors';
import { countedAmount } from '../../../../lib/transactions/refundMatching';
import { generateProjectedTransactions } from '../../../../lib/transactions/projectedTransactions';

interface ReportSectionProps {
  budgets: BudgetCategory[];
  transactions: Transaction[];
  monthlyIncome: number;
  isSharedAccount: boolean;
}

const ReportSection: React.FC<ReportSectionProps> = ({
  budgets,
  transactions,
  monthlyIncome,
  isSharedAccount,
}) => {
  const [sent, setSent] = useState(false);

  // Snapshot the clock once per mount. This ran on every render before,
  // rebuilding an Intl formatter each time and invalidating the memos below
  // that take monthKey as a dependency.
  const { monthKey, monthLabel, todayIso } = useMemo(() => {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return {
      monthKey: getLocalMonthKey(todayStr),
      todayIso: todayStr,
      monthLabel: now.toLocaleString('default', { month: 'long', year: 'numeric' }),
    };
  }, []);

  // This month's real rows, plus the recurring charges whose day has already
  // come. Those are never saved as rows — the dashboard draws them from the
  // schedule and counts them as spent — so the report used to leave every
  // subscription out and show less spending than the vials it summarises.
  const currentMonthTxs = useMemo(
    () => [
      ...transactions,
      ...generateProjectedTransactions(transactions, todayIso),
    ].filter(tx => !tx.is_projected && getLocalMonthKey(tx.date) === monthKey),
    [transactions, monthKey, todayIso],
  );

  const budgetRows = useMemo(() => {
    // Pre-group once instead of filtering the whole month per budget, which
    // walked the transaction list once for every visible budget.
    const spentById = new Map<string, number>();
    for (const tx of currentMonthTxs) {
      if (!tx.budget_id) continue;
      // The dashboard's own per-row rule, so the report agrees with the vials
      // about a refunded purchase. See countedAmount.
      spentById.set(tx.budget_id, (spentById.get(tx.budget_id) ?? 0) + countedAmount(tx));
    }
    return budgets
      // A category with no limit still appears once money has gone to it.
      // Leaving it out also left its spending out of the total below.
      .filter(b => b.totalLimit > 0 || (spentById.get(b.id) ?? 0) !== 0)
      .map((b, i) => ({
        name: b.name,
        spent: spentById.get(b.id) ?? 0,
        limit: b.totalLimit,
        color: getBudgetColor(b.name, i),
      }));
  }, [budgets, currentMonthTxs]);

  // Every purchase this month, by the dashboard's own per-row rule — not the
  // sum of the rows above. Summing the rows dropped whatever was filed under a
  // category with no limit, or under one that no longer exists, so "Total
  // Spent" and "Remaining" disagreed with the balance on the dashboard.
  const totalSpent = useMemo(
    () => currentMonthTxs.reduce((acc, tx) => acc + countedAmount(tx), 0),
    [currentMonthTxs],
  );
  const remaining = monthlyIncome - totalSpent;

  const buildReportHTML = (): string => {
    const ownerLabel = isSharedAccount ? 'Our' : 'My';
    // Read the clock at build time rather than capturing a render-time value.
    const now = new Date();
    const generatedDate = now.toLocaleDateString('default', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    const rowsHTML = budgetRows.map(b => {
      const pctRaw = b.limit > 0 ? Math.round((b.spent / b.limit) * 100) : 0;
      // No limit and money spent is over by definition; there is no
      // percentage to give, so the bar is full and the badge says the rest.
      const noLimit = b.limit <= 0;
      const isOver = noLimit ? b.spent > 0 : pctRaw >= 100;
      const pct = noLimit ? (isOver ? 100 : 0) : Math.min(100, pctRaw);
      const pctLabel = noLimit ? 'No limit' : `${pctRaw}%`;
      const isNear = pctRaw >= 80 && pctRaw < 100;
      const barColor = isOver ? '#ef4444' : b.color;
      const pctColor = isOver ? '#dc2626' : isNear ? '#d97706' : '#94a3b8';

      const badgeHTML = isOver
        ? `<span style="display:inline-flex;align-items:center;background:#fee2e2;color:#dc2626;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;margin-left:8px;letter-spacing:0.02em;">Over budget</span>`
        : isNear
        ? `<span style="display:inline-flex;align-items:center;background:#fef3c7;color:#d97706;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;margin-left:8px;letter-spacing:0.02em;">Near limit</span>`
        : '';

      return `
        <div style="padding:16px;background:#f8fafc;border-radius:16px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:0;">
              <div style="width:10px;height:10px;border-radius:50%;background:${b.color};margin-right:8px;flex-shrink:0;"></div>
              <span style="font-size:14px;font-weight:600;color:#1e293b;">${b.name}</span>
              ${badgeHTML}
            </div>
            <div style="text-align:right;flex-shrink:0;margin-left:8px;">
              <span style="font-size:14px;font-weight:700;color:#1e293b;">$${b.spent.toFixed(0)}</span>
              <span style="font-size:11px;color:#94a3b8;"> / $${b.limit.toFixed(0)}</span>
            </div>
          </div>
          <div style="height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${barColor};border-radius:999px;"></div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:5px;">
            <span style="font-size:10px;font-weight:700;color:${pctColor};">${pctLabel}</span>
          </div>
        </div>`;
    }).join('');

    const remainingColor = remaining >= 0 ? '#10b981' : '#ef4444';
    const remainingBarPct = monthlyIncome > 0
      ? Math.min(100, Math.max(0, Math.round((remaining / monthlyIncome) * 100)))
      : 0;
    const remainingDisplay = `${remaining < 0 ? '-' : ''}$${Math.abs(remaining).toFixed(0)}`;

    const totalsHTML = `
      <div style="margin:0 20px 20px;padding:18px;background:linear-gradient(135deg,#f0fdf4,#ecfdf5);border-radius:16px;border:1px solid #a7f3d0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:${monthlyIncome > 0 ? '12px' : '0'};">
          <span style="font-size:11px;font-weight:700;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;">Total Spent</span>
          <span style="font-size:20px;font-weight:800;color:#1e293b;">$${totalSpent.toFixed(0)}</span>
        </div>
        ${monthlyIncome > 0 ? `
        <div style="height:1px;background:#d1fae5;margin-bottom:12px;"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <span style="font-size:11px;font-weight:700;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;">Remaining</span>
          <span style="font-size:20px;font-weight:800;color:${remainingColor};">${remainingDisplay}</span>
        </div>
        <div style="height:8px;background:#d1fae5;border-radius:999px;overflow:hidden;">
          <div style="height:100%;width:${remainingBarPct}%;background:${remainingColor};border-radius:999px;"></div>
        </div>
        <div style="font-size:10px;color:#6ee7b7;margin-top:5px;text-align:right;font-weight:600;">of $${monthlyIncome.toFixed(0)} income</div>
        ` : ''}
      </div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${ownerLabel} Budget Report — ${monthLabel}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
      background: #f1f5f9;
      color: #1e293b;
      padding: 20px;
      min-height: 100vh;
    }
  </style>
</head>
<body>
  <div style="background:white;border-radius:28px;max-width:480px;margin:0 auto;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.10);">

    <!-- Gradient header -->
    <div style="background:linear-gradient(135deg,#34d399 0%,#14b8a6 100%);padding:28px 24px 24px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.14em;color:rgba(255,255,255,0.65);text-transform:uppercase;margin-bottom:6px;">Covault</div>
      <div style="font-size:24px;font-weight:800;color:white;line-height:1.15;letter-spacing:-0.02em;">${ownerLabel} Budget Report</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.75);margin-top:5px;font-weight:500;">${monthLabel}</div>
    </div>

    <!-- Budget rows -->
    <div style="padding:20px 20px 8px;">
      ${rowsHTML}
    </div>

    <!-- Totals -->
    ${totalsHTML}

    <!-- Footer -->
    <div style="padding:14px 24px 18px;border-top:1px solid #f1f5f9;display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-size:12px;font-weight:800;color:#10b981;letter-spacing:0.1em;">COVAULT</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:2px;">${generatedDate}</div>
      </div>
      <div style="font-size:10px;color:#cbd5e1;font-style:italic;">Budget Report</div>
    </div>

  </div>
</body>
</html>`;
  };

  const handleShare = async () => {
    const html = buildReportHTML();
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const fileName = `covault-report-${now.getFullYear()}-${month}.html`;

    if (Capacitor.isNativePlatform()) {
      try {
        await Filesystem.writeFile({
          path: fileName,
          data: html,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });

        const { uri } = await Filesystem.getUri({
          path: fileName,
          directory: Directory.Cache,
        });

        await Share.share({
          title: `Covault Budget Report — ${monthLabel}`,
          files: [uri],
          dialogTitle: 'Share your budget report',
        });
      } catch (err) {
        log.warn('[ReportSection] Share failed:', err);
        return;
      }

      setSent(true);
      setTimeout(() => setSent(false), 2500);
      return;
    }

    // Web: open rendered report in a new tab
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 30000);

    setSent(true);
    setTimeout(() => setSent(false), 2500);
  };

  const isNative = Capacitor.isNativePlatform();

  return (
    <SettingsCard id="settings-reports-container">
      <SectionHeader
        title="Budget Report"
        subtitle={`${isNative ? 'Share' : 'View'} your ${monthLabel} spending summary.`}
        className="mb-4"
      />

      <button
        onClick={handleShare}
        className={`w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl text-xs font-semibold tracking-wide transition-all duration-200 active:scale-[0.97] ${
          sent
            ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/20'
            : 'bg-violet-50 dark:bg-violet-900/20 border-2 border-violet-400/40 text-violet-600 dark:text-violet-400 hover:bg-violet-100 dark:hover:bg-violet-900/30'
        }`}
      >
        {sent ? (
          <>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            {isNative ? 'Shared!' : 'Opened!'}
          </>
        ) : (
          <>
            {isNative ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                <polyline points="16 6 12 2 8 6" />
                <line x1="12" y1="2" x2="12" y2="15" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            )}
            {isNative ? 'Share Report' : 'View Report'}
          </>
        )}
      </button>
    </SettingsCard>
  );
};

export default ReportSection;
