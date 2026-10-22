import { test as base, devices, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

interface SignedInVault {
  userId: string;
  vendor: string;
  rivalId: string;
  rivalVendor: string;
}

/** One of the two people in a household test, on their own phone. */
export interface HouseholdMember {
  page: Page;
  userId: string;
  name: string;
  email: string;
  vendor: string;
}

const tokenFor = (userId: string) =>
  `covault-e2e.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.${userId}`;

/** Keeps a context on the local server, as `localOnly` does for the default one. */
async function keepLocal(context: BrowserContext, localOrigin: string, unexpected: string[]) {
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (new URL(url).origin === localOrigin) {
      await route.continue();
    } else if (url.startsWith('https://fonts.googleapis.com/')) {
      await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    } else if (
      url.startsWith('https://huggingface.co/Xenova/flan-t5-small/') ||
      url.startsWith('https://cdn.jsdelivr.net/npm/@huggingface/transformers@')
    ) {
      await route.abort();
    } else {
      unexpected.push(url);
      await route.abort();
    }
  });
}

/** Signs a context in as one test account, past the intro. */
async function signInAs(context: BrowserContext, userId: string, token: string, name: string) {
  await context.addInitScript(({ userId, token, name }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: token,
      refresh_token: `refresh-${userId}`,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: {
        id: userId,
        email: `${userId}@example.test`,
        created_at: '2020-01-01T00:00:00Z',
        user_metadata: { full_name: name },
        app_metadata: { provider: 'email', providers: ['email'] },
        aud: 'authenticated',
        role: 'authenticated',
      },
    }));
    localStorage.setItem('covault_session_start', String(Date.now()));
    localStorage.setItem(`covault_onboarded_v1:${userId}`, '1');
  }, { userId, token, name });
}

export const test = base.extend<{
  localOnly: void;
  signedInVault: SignedInVault;
  household: { alex: HouseholdMember; sam: HouseholdMember };
}>({
  localOnly: [async ({ context, baseURL }, use) => {
    const unexpected: string[] = [];
    if (!baseURL) throw new Error('Playwright needs a local base URL.');
    const localOrigin = new URL(baseURL).origin;

    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (new URL(url).origin === localOrigin) {
        await route.continue();
      } else if (url.startsWith('https://fonts.googleapis.com/')) {
        // The login behavior check does not need a network font.
        await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      } else if (
        url.startsWith('https://huggingface.co/Xenova/flan-t5-small/') ||
        url.startsWith('https://cdn.jsdelivr.net/npm/@huggingface/transformers@')
      ) {
        // App startup warms the optional model. These checks exercise sign-in
        // only, so keep the model offline without hiding other network calls.
        await route.abort();
      } else {
        unexpected.push(url);
        await route.abort();
      }
    });

    await use();
    expect(unexpected, 'The browser suite must not contact outside services').toEqual([]);
  }, { auto: true }],
  signedInVault: async ({ page, request, baseURL }, applyFixture) => {
    if (!baseURL) throw new Error('Playwright needs a local base URL.');
    const userId = randomUUID();
    const rivalId = randomUUID();
    const token = tokenFor(userId);
    const vendor = `Vault ${userId.slice(0, 8)}`;
    const rivalVendor = `Vault ${rivalId.slice(0, 8)}`;
    const endpoint = `${baseURL}/mock-supabase/__test/vaults`;
    const seed = await request.post(endpoint, { data: { userId, token, vendor, transactionId: randomUUID() } });
    expect(seed.ok(), 'The local test account must be created').toBe(true);
    const rival = await request.post(endpoint, { data: {
      userId: rivalId, token: `rival-${rivalId}`, vendor: rivalVendor, transactionId: randomUUID(),
    } });
    expect(rival.ok(), 'The rival test account must be created').toBe(true);
    try {
      await page.addInitScript(({ userId, token }) => {
        localStorage.setItem('sb-127-auth-token', JSON.stringify({
          access_token: token,
          refresh_token: `refresh-${userId}`,
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: {
            id: userId,
            email: `${userId}@example.test`,
            created_at: '2020-01-01T00:00:00Z',
            user_metadata: { full_name: 'Browser Test' },
            app_metadata: { provider: 'email', providers: ['email'] },
            aud: 'authenticated',
            role: 'authenticated',
          },
        }));
        localStorage.setItem('covault_session_start', String(Date.now()));
        localStorage.setItem(`covault_onboarded_v1:${userId}`, '1');
      }, { userId, token });
      await applyFixture({ userId, vendor, rivalId, rivalVendor });
    } finally {
      const deleted = await Promise.all([
        request.delete(`${endpoint}/${userId}`),
        request.delete(`${endpoint}/${rivalId}`),
      ]);
      expect(deleted.every(response => response.ok()), 'Both local test accounts must be removed').toBe(true);
    }
  },
  // Two unlinked accounts on two separate phones. Each has one purchase of
  // its own, so a working link is visible as the other's purchase arriving.
  household: async ({ browser, request, baseURL }, applyFixture) => {
    if (!baseURL) throw new Error('Playwright needs a local base URL.');
    const localOrigin = new URL(baseURL).origin;
    const endpoint = `${baseURL}/mock-supabase/__test/vaults`;
    const unexpected: string[] = [];
    const people = [
      { name: 'Alex', shop: 'Corner Market', amount: 42.5, income: 4000 },
      { name: 'Sam', shop: 'Fresh Bakery', amount: 18.75, income: 3000 },
    ];
    const contexts: BrowserContext[] = [];
    const members: HouseholdMember[] = [];
    try {
      for (const person of people) {
        const userId = randomUUID();
        const token = tokenFor(userId);
        const vendor = person.shop;
        const seeded = await request.post(endpoint, { data: {
          userId, token, vendor, transactionId: randomUUID(),
          name: person.name, amount: person.amount, income: person.income,
        } });
        expect(seeded.ok(), `${person.name}'s test account must be created`).toBe(true);
        const context = await browser.newContext({
          ...devices['Pixel 7'], baseURL, reducedMotion: 'reduce',
        });
        contexts.push(context);
        await keepLocal(context, localOrigin, unexpected);
        await signInAs(context, userId, token, person.name);
        members.push({
          page: await context.newPage(), userId, name: person.name,
          email: `${userId}@example.test`, vendor,
        });
      }
      await applyFixture({ alex: members[0], sam: members[1] });
      expect(unexpected, 'The browser suite must not contact outside services').toEqual([]);
    } finally {
      await Promise.all(contexts.map(context => context.close()));
      await Promise.all(members.map(member => request.delete(`${endpoint}/${member.userId}`)));
    }
  },
});

export { expect } from '@playwright/test';
