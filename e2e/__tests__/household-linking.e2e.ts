import { test, expect, type HouseholdMember } from '../fixtures';

// Screenshots for review are written only when a directory is named.
// Two phones, two restarts each: longer than one screen's check.
test.describe.configure({ timeout: 90_000 });

const shots = process.env.COVAULT_HOUSEHOLD_SHOTS;
const snap = async (member: HouseholdMember, name: string) => {
  if (!shots) return;
  // Let entrance fades finish so the picture shows the settled screen.
  await member.page.evaluate(() => Promise.all(document.getAnimations()
    .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => undefined))));
  await member.page.screenshot({ path: `${shots}/${name}.png` });
};

const openSharing = async (member: HouseholdMember) => {
  await member.page.getByRole('button', { name: 'Open settings' }).click();
  const sharing = member.page.locator('#settings-sharing-container');
  await sharing.scrollIntoViewIfNeeded();
  return sharing;
};

const findEntry = async (member: HouseholdMember, vendor: string) => {
  await member.page.getByRole('button', { name: 'Find entry...' }).click();
  await member.page.getByPlaceholder('Find entry...').fill(vendor);
  return member.page.getByText(vendor, { exact: true });
};

test('two phones link from Vault Sharing, stay linked, and unlink together', async ({ household }) => {
  const { alex, sam } = household;
  for (const member of [alex, sam]) {
    await member.page.goto('/');
    await expect(member.page.getByText('Remaining Balance', { exact: true })).toBeVisible();
  }
  await snap(alex, '01-alex-dashboard-before');

  // Alex shows a code and is told the phone is waiting for it to be used.
  const alexSharing = await openSharing(alex);
  await snap(alex, '02-alex-sharing-unlinked');
  await alexSharing.getByRole('button', { name: 'Show my code' }).click();
  const code = (await alexSharing.locator('p.tracking-\\[0\\.2em\\]').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
  await expect(alexSharing.getByText('Waiting for your partner to enter it')).toBeVisible();
  await snap(alex, '03-alex-showing-code');

  // A mistyped code is refused in place, with the reason.
  const samSharing = await openSharing(sam);
  const codeInput = samSharing.getByRole('textbox', { name: "Your partner's code" });
  await codeInput.fill('WRONGCDE');
  await samSharing.getByRole('button', { name: 'Link with this code' }).click();
  await expect(samSharing.getByText(/That code didn’t work, so you aren’t linked/)).toBeVisible();
  await expect(sam.page.getByText(/couldn't confirm/i)).toHaveCount(0);
  await snap(sam, '04-sam-wrong-code');

  // Sam enters the real code and sees the link confirmed.
  await codeInput.fill(code.toLowerCase());
  await snap(sam, '05-sam-entering-code');
  await samSharing.getByRole('button', { name: 'Link with this code' }).click();
  await expect(samSharing.getByRole('status')).toContainText('You’re linked with Alex');
  await expect(samSharing.getByText('Linked with', { exact: true })).toBeVisible();
  await snap(sam, '06-sam-linked');

  // Alex's phone notices on its own, without a restart.
  await expect(alexSharing.getByRole('status')).toContainText('You’re linked with Sam');
  await expect(alexSharing.getByRole('button', { name: 'Show my code' })).toHaveCount(0);
  await snap(alex, '07-alex-linked-automatically');

  // Restarting both phones keeps the link and shares the money.
  for (const [member, partner] of [[alex, sam], [sam, alex]] as const) {
    await member.page.reload();
    await expect(member.page.getByText('Our Remaining Balance')).toBeVisible();
    // 4000 + 3000 income, less 42.50 + 18.75 spent.
    await expect(member.page.getByText('6,938', { exact: false })).toBeVisible();
    await snap(member, `08-${member.name.toLowerCase()}-dashboard-linked`);
    await expect(await findEntry(member, partner.vendor)).toBeVisible();
    await snap(member, `09-${member.name.toLowerCase()}-sees-partner-purchase`);
    await member.page.reload();
    const sharing = await openSharing(member);
    await expect(sharing.getByText(partner.name, { exact: true })).toBeVisible();
    await expect(sharing.getByRole('button', { name: 'Disconnect Partner' })).toBeVisible();
    await expect(sharing.getByRole('button', { name: 'Show my code' })).toHaveCount(0);
    await snap(member, `10-${member.name.toLowerCase()}-sharing-after-restart`);
  }

  // Disconnecting from one phone unlinks both.
  const samAfter = sam.page.locator('#settings-sharing-container');
  await samAfter.getByRole('button', { name: 'Disconnect Partner' }).click();
  await snap(sam, '11-sam-confirm-disconnect');
  await sam.page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(samAfter.getByRole('button', { name: 'Show my code' })).toBeVisible();
  for (const [member, partner] of [[alex, sam], [sam, alex]] as const) {
    await member.page.reload();
    await expect(member.page.getByText('Remaining Balance', { exact: true })).toBeVisible();
    await expect(await findEntry(member, partner.vendor)).toHaveCount(0);
  }
  await snap(alex, '12-alex-after-disconnect');
});

test('the intro links a partner and says so on both phones', async ({ household }) => {
  const { alex, sam } = household;
  // Sam is brand new and goes through the intro; Alex already uses the app.
  await sam.page.addInitScript((userId) => {
    localStorage.removeItem(`covault_onboarded_v1:${userId}`);
    localStorage.setItem(`covault_onboarding_required_v1:${userId}`, '1');
  }, sam.userId);
  await alex.page.goto('/');
  await sam.page.goto('/');

  const next = sam.page.locator('button:has(svg path[d="M9 5l7 7-7 7"])');
  for (let slide = 0; slide < 3; slide++) await next.click();
  await sam.page.getByRole('button', { name: /Couples/ }).click();
  await expect(sam.page.getByRole('heading', { name: 'Link Partner' })).toBeVisible();
  await snap(sam, '20-intro-link-partner');

  // Sam shows a code this time, and Alex types it in from Vault Sharing.
  await sam.page.getByRole('button', { name: 'Or show them my code instead' }).click();
  await expect(sam.page.getByText('Waiting for your partner to enter it')).toBeVisible();
  const code = (await sam.page.locator('p.tracking-\\[0\\.2em\\]').textContent())?.trim() ?? '';
  await snap(sam, '21-intro-showing-code');

  const alexSharing = await openSharing(alex);
  await alexSharing.getByRole('textbox', { name: "Your partner's code" }).fill(code);
  await alexSharing.getByRole('button', { name: 'Link with this code' }).click();
  await expect(alexSharing.getByRole('status')).toContainText('You’re linked with Sam');

  await expect(sam.page.getByRole('status')).toHaveText('Linked with Alex');
  await snap(sam, '22-intro-linked');
  await sam.page.getByRole('button', { name: 'Continue' }).click();
  await expect(sam.page.getByRole('heading', { name: 'Link Partner' })).toHaveCount(0);
});

test('a linked dashboard cycles me, us and them, and tags whose purchase each is', async ({ household }) => {
  const { alex, sam } = household;
  for (const member of [alex, sam]) await member.page.goto('/');
  const alexSharing = await openSharing(alex);
  await alexSharing.getByRole('button', { name: 'Show my code' }).click();
  const code = (await alexSharing.locator('p.tracking-\\[0\\.2em\\]').textContent())?.trim() ?? '';
  const samSharing = await openSharing(sam);
  await samSharing.getByRole('textbox', { name: "Your partner's code" }).fill(code);
  await samSharing.getByRole('button', { name: 'Link with this code' }).click();
  await expect(samSharing.getByRole('status')).toContainText('You’re linked with Alex');

  const page = alex.page;
  await page.reload();
  // One button at the left end of the header, opposite the settings cog. It
  // opens on Us whatever the budget setting says.
  const viewButton = page.locator('#household-view-button');
  await expect(viewButton).toBeVisible();
  await expect(viewButton).toHaveAccessibleName(/Showing both of you/);
  // Each person's disc wears their own first letter, so the button says what it
  // is showing without a caption: Alex's A, Sam's S.
  const youDisc = viewButton.locator('[data-disc="you"]');
  const themDisc = viewButton.locator('[data-disc="them"]');
  await expect(youDisc).toHaveText('A');
  await expect(themDisc).toHaveText('S');
  await expect(youDisc).toHaveCSS('opacity', '1');
  await expect(themDisc).toHaveCSS('opacity', '1');
  const cog = await page.locator('#settings-button').boundingBox();
  const toggle = await viewButton.boundingBox();
  expect(toggle?.width).toBeCloseTo(cog?.width ?? 0, 0);
  expect(toggle?.height).toBeCloseTo(cog?.height ?? 0, 0);
  expect(toggle?.y).toBeCloseTo(cog?.y ?? 0, 0);
  expect(toggle?.x ?? 99).toBeLessThan(cog?.x ?? 0);
  await snap(alex, '40-view-button-us-dashboard');

  const food = page.getByRole('heading', { name: 'Food' });
  const purchase = (member: typeof alex) => page.getByText(member.vendor, { exact: true });
  const activity = (label: string) => page.getByText(label).filter({ visible: true });

  // Us: both purchases, each wearing its owner's tag, against both limits.
  await food.click();
  await expect(activity('Our Activity')).toBeVisible();
  await expect(purchase(alex)).toBeVisible();
  await expect(purchase(sam)).toBeVisible();
  // Each purchase starts with its owner's disc, the header button's own symbol:
  // an A on Alex's, an S on Sam's. The title is just the shop, with no name or
  // pill beside it.
  const alexRow = page.getByRole('button', { name: new RegExp(`${alex.vendor}.*yours`) });
  const samRow = page.getByRole('button', { name: new RegExp(`${sam.vendor}.*Sam's`) });
  await expect(alexRow.locator('[data-disc="you"]')).toHaveText('A');
  await expect(samRow.locator('[data-disc="them"]')).toHaveText('S');
  await expect(alexRow.getByText('You', { exact: true })).toHaveCount(0);
  await expect(samRow.getByText('Sam', { exact: true })).toHaveCount(0);
  // The chart and the vial agree on the limit: both people's, added.
  await expect(page.locator('#spending-flow-chart').getByText('$1000', { exact: true })).toBeVisible();
  await expect(page.getByText('$1000', { exact: true })).toHaveCount(2);
  await snap(alex, '41-view-us-food-open');

  // Tap: Us → Sam. Only Sam's purchase, and the new view is named.
  await viewButton.click();
  await expect(viewButton).toHaveAccessibleName(/Showing just Sam/);
  await expect(youDisc).toHaveCSS('opacity', '0');
  await expect(themDisc).toHaveCSS('opacity', '1');
  await expect(activity('Sam’s Activity')).toBeVisible();
  await expect(purchase(sam)).toBeVisible();
  await expect(purchase(alex)).toHaveCount(0);
  await snap(alex, '42-view-them-food-open');

  // Tap: Sam → Me. Only Alex's purchase, against Alex's own limit.
  await viewButton.click();
  await expect(viewButton).toHaveAccessibleName(/Showing just you/);
  await expect(youDisc).toHaveCSS('opacity', '1');
  await expect(themDisc).toHaveCSS('opacity', '0');
  await expect(activity('My Activity')).toBeVisible();
  await expect(purchase(alex)).toBeVisible();
  await expect(purchase(sam)).toHaveCount(0);
  await expect(page.locator('#spending-flow-chart').getByText('$500', { exact: true })).toBeVisible();
  await snap(alex, '43-view-me-food-open');

  // The balance at the top is the household's in every view.
  await expect(page.getByText('6,938', { exact: false })).toBeVisible();

  // Leaving the app and coming back puts it on Us again, so nobody is left
  // reading half the household's money under the household's balance.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(viewButton).toHaveAccessibleName(/Showing both of you/);
  await expect(activity('Our Activity')).toBeVisible();

  // A third tap from Me comes back round to Us.
  await viewButton.click();
  await viewButton.click();
  await viewButton.click();
  await expect(viewButton).toHaveAccessibleName(/Showing both of you/);
});
