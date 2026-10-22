// app/data/useHouseholdLinking.ts
import { log } from '../lib/observability/log';
import { useCallback } from 'react';
import { restFetch, callRpc } from '../lib/api/apiHelpers';
import { withoutPartner } from '../lib/budgets/householdSharing';
import type { UseUserDataParams } from './types';
import {
  captureAccountDataScope,
  isCurrentAccountDataScope,
  type AccountDataScope,
  type AccountDataScopeRef,
} from '../lib/auth/accountScope';

const isLinkScopeCurrent = (
  accountScopeRef: AccountDataScopeRef | undefined,
  scope: AccountDataScope | null,
  userId: string,
): boolean => !accountScopeRef || (
  scope?.userId === userId && isCurrentAccountDataScope(accountScopeRef, scope)
);

/**
 * Partner linking goes through SECURITY DEFINER functions, not plain REST.
 *
 * It has to. `settings` is RLS-gated to `auth.uid() = user_id`, but linking
 * touches the OTHER person's row — read it by link code or email, then write
 * partner_id onto it. Both are invisible to the client: the lookup returns zero
 * rows and the write reports `UPDATE 0` with no error, which is why linking
 * used to fail with "invalid or expired link code" no matter what you typed.
 *
 * Loosening the policies can't fix it — RLS decides row by row and can't see
 * the client's WHERE clause, so any policy permissive enough for a code lookup
 * would let any signed-in user read every account's name and email. The
 * handshake therefore lives in the database:
 * supabase/migrations/2026_08_01_sync_schema_to_app.sql.
 *
 * `callRpc` itself now lives in app/lib/api/apiHelpers.ts — account deletion needs the
 * exact same PostgREST-error unwrapping this always did, for the same reason.
 */

/**
 * What the caller is told about a link attempt.
 *
 * The settings screen reports failures through the app-wide error toast and
 * ignores this; the intro cannot — it is a full-screen step with its own place
 * to put "no Covault account for that address", and a toast behind a modal is
 * a message nobody reads.
 */
export interface LinkOutcome {
  ok: boolean;
  /** Present only when ok is false; already written for the user. */
  message?: string;
  /** Who the account is now linked with, when ok is true and the name is known. */
  partnerName?: string;
}

/** Whether the person who was shown this account's code has used it yet. */
export interface PartnerCheck {
  linked: boolean;
  partnerName?: string;
}

/**
 * Reloads everything for the signed-in account. A new link changes the
 * household balance, the purchases list and the partner's budgets, and only
 * the full load knows how to read all three.
 */
type ReloadUserData = (userId: string, scope: AccountDataScope) => Promise<void>;

/** Shape returned by link_partner_by_code. */
interface LinkedPartner {
  partner_id: string;
  partner_name: string | null;
  partner_email: string | null;
}

const CODE_DID_NOT_WORK =
  'That code didn’t work, so you aren’t linked. Check it with your partner, or ask them '
  + 'for a fresh one: each code works once, for 30 minutes.';

/** What a failed link attempt tells the person, in the app's own words. */
function linkFailureMessage(failureKind: string | undefined, detail?: string): string {
  if (failureKind === 'rejected' && /invalid or expired/i.test(detail ?? '')) return CODE_DID_NOT_WORK;
  if (failureKind === 'rejected') return 'Covault couldn’t link you. Nothing changed. Please try again.';
  return 'Covault couldn’t reach the server, so you aren’t linked yet. '
    + 'Check your connection and try again.';
}

export const useHouseholdLinking = (
  { appState, setAppState, setDbError, accountScopeRef }: UseUserDataParams,
  reloadUserData?: ReloadUserData,
) => {

  // Best-effort and never awaited by the caller: the link itself has already
  // succeeded, and a failed reload only means the partner's purchases arrive
  // on the next load instead of now.
  const reloadAfterLink = useCallback((userId: string, scope: AccountDataScope | null) => {
    if (!reloadUserData || !scope) return;
    reloadUserData(userId, scope).catch((err: unknown) => {
      log.error('[householdLink] reload after link failed', err);
    });
  }, [reloadUserData]);

  // Generate a link code for household linking (stored in settings row)
  const handleGenerateLinkCode = useCallback(async (): Promise<string | null> => {
    const userId = appState.user?.id;
    const scope = userId && accountScopeRef
      ? captureAccountDataScope(accountScopeRef, userId)
      : null;
    try {
      if (!userId) {
        setDbError('User not logged in');
        return null;
      }
      if (!isLinkScopeCurrent(accountScopeRef, scope, userId)) return null;

      // Minted in the database, not here. The old version was
      // `Math.random().toString(36).substring(2, 8)`: not a cryptographic
      // generator, not reliably six characters (Math.random can return a
      // value whose base-36 form is short, and the code came out short with
      // it), never checked for uniqueness, and it sat on the row for ever
      // because nothing expired it. A link code is the ONLY thing standing
      // between a stranger and this household's spending, so it is now eight
      // characters of gen_random_bytes on an alphabet with no 0/O or 1/I/L to
      // misread, unique among live codes, and good for thirty minutes.
      const result = await callRpc<string>('generate_link_code', {});
      if (!isLinkScopeCurrent(accountScopeRef, scope, userId)) return null;
      if (!result.ok) {
        setDbError(`Failed to generate link code: ${result.message}`);
        return null;
      }

      const code = typeof result.data === 'string' ? result.data : null;
      if (!code) {
        setDbError('Failed to generate link code');
        return null;
      }

      log.debug('[generateLinkCode] Generated code');
      return code;
    } catch (err: any) {
      if (!userId || !isLinkScopeCurrent(accountScopeRef, scope, userId)) return null;
      setDbError(`Generate link code exception: ${err?.message || err}`);
      return null;
    }
  }, [accountScopeRef, appState.user, setDbError]);

  /**
   * Join a household with the code its owner gave you.
   *
   * The ONLY way two accounts are linked. There used to be a second — enter a
   * partner's email address and both rows were written on the spot — which
   * meant anyone who knew a Covault user's email could link themselves to that
   * account and read its transactions and budgets through the partner
   * policies. Nobody was asked and nobody was told. The code is the whole
   * point: it exists on the other person's screen, so handing it over IS the
   * permission, and there is no way to obtain one without asking.
   *
   * Returns an outcome rather than only raising a banner, because the intro
   * is a full-screen step that has somewhere to put the reason and a toast
   * behind a modal is a message nobody reads.
   */
  const handleJoinWithCode = useCallback(
    async (code: string): Promise<LinkOutcome> => {
      const userId = appState.user?.id;
      const userName = appState.user?.name;
      const scope = userId && accountScopeRef
        ? captureAccountDataScope(accountScopeRef, userId)
        : null;
      try {
        if (!userId || !userName) {
          setDbError('User not logged in');
          return { ok: false, message: 'User not logged in' };
        }
        if (!isLinkScopeCurrent(accountScopeRef, scope, userId)) return { ok: false };

        // One call does both halves: it claims the code and writes each row's
        // partner fields in a single statement, so two people racing on the
        // same code can't both win — the second finds no row with that code
        // still set. The old client-side "you can't link with yourself" check
        // is gone because it needed a lookup we're no longer allowed to do;
        // the function excludes the caller's own row, so your own code simply
        // reads as invalid.
        const result = await callRpc<LinkedPartner[]>('link_partner_by_code', {
          p_code: code,
        });
        if (!isLinkScopeCurrent(accountScopeRef, scope, userId)) return { ok: false };

        // Both screens that link show the reason under the code box, so no
        // app-wide error is raised as well: a mistyped code used to produce
        // the database's own wording there AND a red banner saying Covault
        // "couldn't confirm whether household sharing changed", which it had.
        if (!result.ok) {
          return { ok: false, message: linkFailureMessage(result.failureKind, result.message) };
        }

        const linked = result.data?.[0];
        if (!linked) {
          return { ok: false, message: CODE_DID_NOT_WORK };
        }

        // budgeting_solo isn't part of the handshake — it's a per-user display
        // preference, and each side owns its own row for it. The partner's app
        // derives it from partner_id on next load (useDataLoading), so only
        // ours needs writing here.
        await restFetch(`/settings?user_id=eq.${userId}`, {
          method: 'PATCH',
          body: JSON.stringify({ budgeting_solo: false }),
        });
        if (!isLinkScopeCurrent(accountScopeRef, scope, userId)) return { ok: false };

        setAppState(prev => {
          if (!isLinkScopeCurrent(accountScopeRef, scope, userId) || prev.user?.id !== userId) return prev;
          return {
            ...prev,
            user: prev.user
              ? {
                  ...prev.user,
                  budgetingSolo: false,
                  hasJointAccounts: true,
                  partnerId: linked.partner_id,
                  partnerName: linked.partner_name || undefined,
                  partnerEmail: linked.partner_email || undefined,
                }
              : null,
          };
        });

        log.debug('[joinWithCode] Successfully linked household');
        // Until now this phone knew only the partner's name. Their purchases,
        // income and budgets used to wait for the next app start.
        reloadAfterLink(userId, scope);
        return { ok: true, partnerName: linked.partner_name || undefined };
      } catch (err: any) {
        if (!userId || !isLinkScopeCurrent(accountScopeRef, scope, userId)) return { ok: false };
        log.error('[joinWithCode]', err?.message || err);
        return { ok: false, message: linkFailureMessage('unknown') };
      }
    },
    [accountScopeRef, appState.user, reloadAfterLink, setAppState, setDbError],
  );

  /**
   * Asked repeatedly while this phone is showing its code.
   *
   * The code is used on the OTHER phone, and nothing tells this one. Without
   * this, the person who showed the code was left looking at it after their
   * partner had joined, with no sign that anything had happened until they
   * restarted the app. A single row read; the full reload only runs once.
   */
  const handleCheckForPartner = useCallback(async (): Promise<PartnerCheck> => {
    const userId = appState.user?.id;
    const scope = userId && accountScopeRef
      ? captureAccountDataScope(accountScopeRef, userId)
      : null;
    if (!userId || !isLinkScopeCurrent(accountScopeRef, scope, userId)) return { linked: false };
    try {
      const res = await restFetch(
        `/settings?select=partner_id,partner_name&user_id=eq.${userId}&limit=1`,
        { cache: 'no-store' },
      );
      if (!res.ok || !isLinkScopeCurrent(accountScopeRef, scope, userId)) return { linked: false };
      const rows = await res.json();
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row?.partner_id) return { linked: false };
      reloadAfterLink(userId, scope);
      return { linked: true, partnerName: row.partner_name || undefined };
    } catch {
      return { linked: false };
    }
  }, [accountScopeRef, appState.user, reloadAfterLink]);


  // Disconnect household (clear partner fields in both users' settings)
  const handleUnlinkPartner = useCallback(async () => {
    const userId = appState.user?.id;
    const scope = userId && accountScopeRef
      ? captureAccountDataScope(accountScopeRef, userId)
      : null;
    try {
      if (!userId) return;
      if (!isLinkScopeCurrent(accountScopeRef, scope, userId)) return;

      // Clears BOTH rows. Previously this cleared its own and then PATCHed the
      // partner's, which RLS silently dropped — so the partner stayed linked to
      // you and kept seeing your transactions and budgets through the partner
      // SELECT policies. The function only clears the other row if it actually
      // points back at you.
      const result = await callRpc<null>('unlink_partner', {});
      if (!isLinkScopeCurrent(accountScopeRef, scope, userId)) return;
      if (!result.ok) {
        setDbError(result.message ?? 'Could not unlink your partner. Please try again.');
        return;
      }

      // Our own display preference; see the note in handleJoinWithCode.
      await restFetch(`/settings?user_id=eq.${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ budgeting_solo: true }),
      });
      if (!isLinkScopeCurrent(accountScopeRef, scope, userId)) return;

      // Everything derived from the partner goes too — their income in the
      // household figure, their month summary, their limits and their
      // purchases — not just their name. See withoutPartner.
      setAppState(prev => {
        if (!isLinkScopeCurrent(accountScopeRef, scope, userId)) return prev;
        if (prev.user?.id !== userId) return prev;
        const next = withoutPartner(prev, userId);
        if (!next.user || next.user.budgetingSolo) return next;
        return { ...next, user: { ...next.user, budgetingSolo: true, hasJointAccounts: false } };
      });
      log.debug('[unlinkPartner] OK');
    } catch (err: any) {
      if (!userId || !isLinkScopeCurrent(accountScopeRef, scope, userId)) return;
      setDbError(`Unlink exception: ${err?.message || err}`);
    }
  }, [accountScopeRef, appState.user, setAppState, setDbError]);

  return {
    handleGenerateLinkCode,
    handleJoinWithCode,
    handleCheckForPartner,
    handleUnlinkPartner,
  };
};
