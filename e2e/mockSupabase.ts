import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

interface Vault {
  userId: string;
  token: string;
  vendor: string;
  transactionId: string;
  /** Optional so the original single-vault fixtures stay valid. */
  name?: string;
  amount?: number;
  income?: number;
}

/**
 * The settings fields partner linking reads and writes. Mirrors the columns
 * the real link functions in supabase/schema.sql touch.
 */
interface VaultSettings {
  partner_id: string | null;
  partner_name: string | null;
  partner_email: string | null;
  link_code: string | null;
  link_code_expires_at: number | null;
  budgeting_solo: boolean;
  share_level: string;
  budget_mode: string;
}

const vaults = new Map<string, Vault>();
const settings = new Map<string, VaultSettings>();

const emailOf = (vault: Vault) => `${vault.userId}@example.test`;
const nameOf = (vault: Vault) => vault.name ?? 'Browser Test';

/** The real linked_partner_id(): a one-sided partner_id is not a link. */
function linkedPartnerId(userId: string): string | null {
  const mine = settings.get(userId);
  const partnerId = mine?.partner_id;
  if (!partnerId) return null;
  return settings.get(partnerId)?.partner_id === userId ? partnerId : null;
}

/** Same alphabet as generate_link_code: no 0/O or 1/I/L to misread. */
function mintLinkCode(): string {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function transactionFor(vault: Vault) {
  return {
    id: vault.transactionId,
    user_id: vault.userId,
    vendor: vault.vendor,
    amount: vault.amount ?? 14.25,
    date: new Date().toISOString().slice(0, 10),
    created_at: new Date().toISOString(),
    budget: 'Food',
    recurrence: 'One-time',
    label: 'Manual',
    is_projected: false,
  };
}

function reply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return JSON.parse(body);
}

/** One server holds all browser workers' data, and every REST read checks its token. */
export function mockSupabase(): Plugin {
  return {
    name: 'covault-e2e-mock-supabase',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/mock-supabase', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');

        if (url.pathname === '/__test/vaults' && req.method === 'POST') {
          try {
            const data = await readBody(req) as Vault;
            if (!data.userId || !data.token || !data.vendor || !data.transactionId ||
                vaults.has(data.userId) || [...vaults.values()].some(v => v.token === data.token)) {
              reply(res, 400, { message: 'A unique, complete vault is required.' });
              return;
            }
            vaults.set(data.userId, data);
            settings.set(data.userId, {
              partner_id: null, partner_name: null, partner_email: null,
              link_code: null, link_code_expires_at: null,
              budgeting_solo: true, share_level: 'transactions', budget_mode: 'separate',
            });
            reply(res, 201, { userId: data.userId });
          } catch {
            reply(res, 400, { message: 'Invalid vault.' });
          }
          return;
        }

        if (url.pathname.startsWith('/__test/vaults/') && req.method === 'DELETE') {
          const removed = decodeURIComponent(url.pathname.slice('/__test/vaults/'.length));
          vaults.delete(removed);
          settings.delete(removed);
          reply(res, 200, { removed: true });
          return;
        }

        const token = req.headers.authorization?.replace(/^Bearer /, '');
        const vault = [...vaults.values()].find(v => v.token === token);
        if (!vault) {
          reply(res, 401, { message: 'Unknown test session.' });
          return;
        }

        const mine = settings.get(vault.userId)!;
        const requestedUser = url.searchParams.get('user_id') ?? url.searchParams.get('user_uuid');
        // The partner SELECT policies: a linked partner's budgets are readable,
        // and their purchases only while they share at the 'transactions' level.
        const partnerId = linkedPartnerId(vault.userId);
        const readsPartner = !!partnerId && requestedUser === `eq.${partnerId}` && req.method === 'GET' && (
          url.pathname === '/rest/v1/budgets' ||
          (url.pathname === '/rest/v1/transactions' && settings.get(partnerId)?.share_level === 'transactions')
        );
        if (requestedUser && requestedUser !== `eq.${vault.userId}` && !readsPartner) {
          reply(res, 403, { message: 'Another vault is not accessible.' });
          return;
        }
        const target = readsPartner ? vaults.get(partnerId!)! : vault;

        if (url.pathname === '/rest/v1/settings' && req.method === 'GET') {
          reply(res, 200, [{
            user_id: vault.userId,
            name: nameOf(vault),
            email: emailOf(vault),
            monthly_income: vault.income ?? 5000,
            theme_selected: 'dark',
            subscription_status: 'active',
            is_tester: true,
            budgeting_solo: mine.budgeting_solo,
            partner_id: mine.partner_id,
            partner_name: mine.partner_name,
            partner_email: mine.partner_email,
            share_level: mine.share_level,
            budget_mode: mine.budget_mode,
          }]);
          return;
        }

        if (url.pathname === '/rest/v1/settings' && req.method === 'PATCH') {
          const patch = await readBody(req) as Partial<VaultSettings>;
          for (const key of ['budgeting_solo', 'share_level', 'budget_mode'] as const) {
            if (key in patch) Object.assign(mine, { [key]: patch[key] });
          }
          reply(res, 200, []);
          return;
        }

        if (url.pathname === '/rest/v1/rpc/generate_link_code' && req.method === 'POST') {
          let code = mintLinkCode();
          while ([...settings.values()].some(s => s.link_code === code)) code = mintLinkCode();
          mine.link_code = code;
          mine.link_code_expires_at = Date.now() + 30 * 60 * 1000;
          reply(res, 200, code);
          return;
        }

        if (url.pathname === '/rest/v1/rpc/link_partner_by_code' && req.method === 'POST') {
          const { p_code } = await readBody(req) as { p_code?: string };
          const wanted = (p_code ?? '').trim().toUpperCase();
          const owner = [...vaults.values()].find(v => {
            const s = settings.get(v.userId);
            return v.userId !== vault.userId && !!wanted && s?.link_code?.toUpperCase() === wanted
              && (s.link_code_expires_at ?? 0) > Date.now();
          });
          if (!owner) {
            reply(res, 400, { code: 'P0001', message: 'Invalid or expired link code' });
            return;
          }
          const theirs = settings.get(owner.userId)!;
          Object.assign(theirs, {
            partner_id: vault.userId, partner_name: nameOf(vault), partner_email: emailOf(vault),
            link_code: null, link_code_expires_at: null,
          });
          Object.assign(mine, {
            partner_id: owner.userId, partner_name: nameOf(owner), partner_email: emailOf(owner),
          });
          reply(res, 200, [{ partner_id: owner.userId, partner_name: nameOf(owner), partner_email: emailOf(owner) }]);
          return;
        }

        if (url.pathname === '/rest/v1/rpc/unlink_partner' && req.method === 'POST') {
          const other = mine.partner_id ? settings.get(mine.partner_id) : undefined;
          if (other?.partner_id === vault.userId) {
            Object.assign(other, { partner_id: null, partner_name: null, partner_email: null });
          }
          Object.assign(mine, { partner_id: null, partner_name: null, partner_email: null });
          reply(res, 200, null);
          return;
        }

        if (url.pathname === '/rest/v1/rpc/partner_monthly_income' && req.method === 'POST') {
          reply(res, 200, partnerId ? (vaults.get(partnerId)?.income ?? 5000) : null);
          return;
        }

        if (url.pathname === '/rest/v1/rpc/partner_month_summary' && req.method === 'POST') {
          const level = partnerId ? settings.get(partnerId)?.share_level : null;
          const partner = partnerId ? vaults.get(partnerId) : undefined;
          if (!partner || !level || level === 'transactions') {
            reply(res, 200, []);
          } else if (level === 'categories') {
            reply(res, 200, [{ share_level: level, budget: 'Food', total: partner.amount ?? 14.25 }]);
          } else {
            reply(res, 200, [{ share_level: level, budget: null, total: partner.amount ?? 14.25 }]);
          }
          return;
        }

        if (url.pathname === '/rest/v1/rpc/set_household_budget_mode' && req.method === 'POST') {
          const { p_mode } = await readBody(req) as { p_mode?: string };
          mine.budget_mode = p_mode ?? mine.budget_mode;
          const other = partnerId ? settings.get(partnerId) : undefined;
          if (other) other.budget_mode = mine.budget_mode;
          reply(res, 200, null);
          return;
        }

        if (url.pathname === '/rest/v1/budgets' && req.method === 'GET') {
          reply(res, 200, [{ id: `budget-${target.userId}`, user_uuid: target.userId,
            budget: 'Food', amount: 500, Visible: true }]);
          return;
        }

        if (url.pathname === '/rest/v1/budgets' && req.method === 'POST') {
          reply(res, 201, []);
          return;
        }

        if (url.pathname === '/rest/v1/transactions' && req.method === 'GET') {
          reply(res, 200, [transactionFor(target)]);
          return;
        }

        if (url.pathname === '/rest/v1/rpc/server_now' && req.method === 'POST') {
          reply(res, 200, new Date().toISOString());
          return;
        }

        reply(res, 404, { message: `Unimplemented test endpoint: ${req.method} ${url.pathname}` });
      });
    },
  };
}
