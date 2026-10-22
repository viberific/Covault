/**
 * The home screen's vertical rhythm, which is easy to break one class at a
 * time and hard to notice in a diff.
 *
 * Three blocks stack down the page — the balance header, the chart, the vials
 * — and the breaks between them have to be equal or the page reads as though
 * something has slipped. It did: the break between the search bar and the
 * chart was `pb-1`, 4px, while the chart left 12px above the vials (`mb-1` on
 * its own root plus `mb-2` on the wrapper). The search bar all but touched the
 * chart while the chart sat comfortably clear of the vials.
 *
 * These are class names, not measurements, so this cannot prove the screen
 * looks right — only that the four numbers still agree with each other. That
 * is the thing that drifted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const balance = read('app/components/Dashboard/DashboardBalanceSection.tsx');
const chart = read('app/components/Dashboard/BudgetFlowChart.tsx');
const dashboard = read('app/components/Dashboard/Dashboard.tsx');

describe('the three breaks down the home screen are equal', () => {
  it('balance to search is 12px, in both states of the search control', () => {
    // The open field and the closed button both sit in the same slot, so a
    // change to one and not the other makes the page jump on tap.
    expect(balance).toContain('className="relative mt-3 w-2/3 lg:w-1/3 z-10"');
    expect(balance).toContain('className="mt-3 w-2/3 lg:w-1/3 inline-flex');
    expect(balance).not.toContain('mt-2 w-2/3');
  });

  it('search to chart is 12px', () => {
    // The section's own bottom padding IS that gap. This was pb-1.
    const roots = balance.match(
      /className="flex flex-col items-center justify-center pb-3 shrink-0 relative"/g,
    );
    // Twice: the loaded header and the skeleton shown while income loads. If
    // they disagree the page shifts the moment the figure arrives.
    expect(roots?.length).toBe(2);
    expect(balance).not.toContain('justify-center pb-1 shrink-0');
  });

  it('chart to vials is 12px, and both chart states leave it', () => {
    // 4px from the chart's own root...
    expect(chart).toContain('id="spending-flow-chart" className="w-full mb-1 shrink-0 px-4"');
    // ...the same from the "no spending data yet" card that stands in its slot...
    expect(chart).toContain('id="spending-flow-chart" className="w-full mb-1"');
    // ...plus 8px from the wrapper Dashboard puts around whichever one renders.
    expect(dashboard).toContain('shrink-0 max-h-[300px] opacity-100 translate-y-0 mb-2');
  });

  it('the month label stays tight against the number it labels', () => {
    // Not a block break — a label ON the balance. Opening this one up would
    // read as the label belonging to nothing.
    expect(balance).toContain('animate-nest mb-0.5 relative');
  });
});
