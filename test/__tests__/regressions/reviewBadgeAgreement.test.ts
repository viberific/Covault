import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { countAwaitingReview, selectAwaitingReview } from '../../../app/lib/capture/reviewQueue';
import type { Transaction } from '../../../app/types';

/**
 * Four places show "how many captures are waiting", and they have to agree.
 *
 * The bottom bar draws a badge on the home screen and on the Review page; the
 * Review card draws a count of its own; the home-screen widget draws a pill.
 * app/lib/capture/reviewQueue.ts exists precisely so all four ask the same question — a
 * badge you cannot trust is worse than no badge, because its whole job is to be
 * the backstop when a capture notification gets dismissed by mistake.
 *
 * The home screen was the one caller still filtering by hand. Its version kept
 * refunds, so a captured refund made the home badge read one higher than the
 * list it pointed at — the exact disagreement the shared selector was written
 * to end, still live on the first screen anybody looks at.
 *
 * Pinned at the source level as well as behaviourally: the bug was not a wrong
 * predicate, it was a second copy of the predicate, and only reading the call
 * site catches a third one appearing.
 */

const root = resolve(__dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const tx = (over: Partial<Transaction> = {}): Transaction =>
  ({
    id: 'tx-1',
    user_id: 'u1',
    vendor: 'Tim Hortons',
    amount: 4.85,
    date: '2026-08-20T12:00:00.000Z',
    budget_id: 'groceries',
    is_projected: false,
    label: 'Automatic',
    caught_cleared: false,
    ...over,
  }) as Transaction;

describe('every count comes from the one selector', () => {
  const dashboard = read('app/components/Dashboard/Dashboard.tsx');
  const parsing = read('app/components/review/TransactionParsing/TransactionParsing.tsx');

  it('the home screen badge reads countAwaitingReview', () => {
    expect(dashboard).toContain('countAwaitingReview(myTransactions)');
  });

  it('the home screen no longer rolls its own filter', () => {
    // This is the shape that was wrong: it keeps refunds.
    expect(dashboard).not.toContain("label === 'Automatic' && !tx.caught_cleared");
  });

  it('the widget pill reads the same selector over the same list', () => {
    expect(dashboard).toContain('pendingReview: countAwaitingReview(myTransactions)');
  });

  it('all of them count only captures this person can file', () => {
    // A partner who shares every purchase has their waiting captures on this
    // phone too, but only their owner may change them. Counted here, they
    // left a badge nothing on this phone could clear.
    expect(dashboard).toContain("transactionsForView(normalizedTransactions, myUserId, 'me')");
    expect(dashboard).toContain('allTransactions={myTransactions}');
    expect(dashboard).not.toContain('countAwaitingReview(state.transactions)');
  });

  it('the Review page list and its badge read selectAwaitingReview', () => {
    expect(parsing).toContain('selectAwaitingReview(allTransactions)');
    expect(parsing).toContain('pendingCount={aiTransactions.length}');
  });
});

describe('what the selector answers', () => {
  it('a captured refund is not something waiting to be reviewed', () => {
    // The refund is real and still counts against the budget; it simply isn't
    // triage. refundMatching pairs it with its expense instead.
    const rows = [tx(), tx({ id: 'tx-2', amount: -4.85 })];
    expect(countAwaitingReview(rows)).toBe(1);
    expect(selectAwaitingReview(rows).map((t) => t.id)).toEqual(['tx-1']);
  });

  it('the number always equals the length of the list it points at', () => {
    const rows = [
      tx(),
      tx({ id: 'tx-2', amount: -12 }),
      tx({ id: 'tx-3', caught_cleared: true }),
      tx({ id: 'tx-4', label: 'Manual' }),
      tx({ id: 'tx-5' }),
    ];
    expect(countAwaitingReview(rows)).toBe(selectAwaitingReview(rows).length);
  });
});
