import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  hasPairedEmail,
  isBankSourcedRow,
  isEmailSourcedRow,
  readCaptureMarker,
  stripCaptureBookkeeping,
  stripCaptureMarker,
  withCaptureMarker,
  withEmailPairedMarker,
  captureNotifiedAt,
  isOtherAppSameTap,
  CROSS_APP_WINDOW_MS,
} from '../../../app/lib/capture/captureChannel';
import { amountsAgree, isSameCharge } from '../../../app/lib/transactions/duplicateCharge';
import { withFuelHoldMarker, readFuelHoldMarker, stripFuelHoldMarker } from '../../../app/lib/capture/fuelHold';

const PROCESSOR = readFileSync(resolve(__dirname, '../../../app/lib/capture/notificationProcessor.ts'), 'utf-8');

/**
 * One purchase, one row — however many ways the bank announces it.
 *
 * Most banks send both a push and an email for the same charge, and the two are
 * not remotely the same string, so every fingerprint check in the pipeline sees
 * two unrelated events. The near-duplicate check almost catches it and then
 * misses: it demands the same day and the same cent, while an email routinely
 * arrives the next morning and occasionally rounds differently.
 *
 * The rule that closes it has to be careful in both directions. Dropping too
 * eagerly loses a real purchase — which is the failure this app treats as
 * unacceptable — and dropping too little puts every charge on the dashboard
 * twice.
 */
describe('recording which route a capture arrived by', () => {
  it('round-trips, and reads back the app it came from', () => {
    const marked = withCaptureMarker('You spent $12.00 at CAFE', {
      channel: 'email',
      packageName: 'com.google.android.gm',
    });
    expect(readCaptureMarker(marked)).toEqual({
      channel: 'email',
      packageName: 'com.google.android.gm',
    });
    expect(stripCaptureMarker(marked)).toBe('You spent $12.00 at CAFE');
  });

  it('never leaves bookkeeping in text shown to the user', () => {
    const marked = withEmailPairedMarker(
      withCaptureMarker('You spent $12.00 at CAFE', { channel: 'bank' }),
    );
    expect(stripCaptureBookkeeping(marked)).toBe('You spent $12.00 at CAFE');
    expect(stripCaptureBookkeeping(marked)).not.toContain('covault:');
  });

  it('replaces rather than stacks when re-marked', () => {
    const once = withCaptureMarker('text', { channel: 'email' });
    const twice = withCaptureMarker(once, { channel: 'bank' });
    expect(readCaptureMarker(twice)?.channel).toBe('bank');
    expect(twice.match(/covault:capture/g)).toHaveLength(1);
  });

  it('coexists with the fuel-hold marker without disturbing it', () => {
    // Both markers live in the same column. Each must read and strip only its
    // own, or a fuel placeholder stops being recognised the moment email ships.
    const hold = { holdAmount: 150, placeholderAmount: 100, basis: 'default' as const };
    const both = withCaptureMarker(withFuelHoldMarker('SHELL $150.00', hold), {
      channel: 'bank',
      packageName: 'com.bmo.mobile',
    });
    expect(readFuelHoldMarker(both)).toEqual({ holdAmount: 150, placeholderAmount: 100 });
    expect(readCaptureMarker(both)?.channel).toBe('bank');
    expect(stripCaptureBookkeeping(stripFuelHoldMarker(both))).toBe('SHELL $150.00');
  });
});

describe('deciding what a stored row came from', () => {
  it('reads an unmarked automatic capture as bank-sourced', () => {
    // THE HISTORY CASE. Every row captured before this feature existed carries
    // no marker, and every one of them came from a bank app — email was not a
    // source at all. Read the other way, the app would ignore the entire
    // existing history when deciding whether an email is a duplicate, and file
    // a second copy of purchases the user already has.
    expect(isBankSourcedRow({ raw_notification: 'Purchase of $10', source: 'notification' }))
      .toBe(true);
    expect(isBankSourcedRow({ raw_notification: null, source: 'notification' })).toBe(true);
  });

  it('does not treat a typed-in row as a bank capture', () => {
    expect(isBankSourcedRow({ raw_notification: null, source: 'manual' })).toBe(false);
    expect(isBankSourcedRow({ raw_notification: null, source: 'executor' })).toBe(false);
  });

  it('tells a marked email row from a marked bank row', () => {
    const email = withCaptureMarker('x', { channel: 'email' });
    const bank = withCaptureMarker('x', { channel: 'bank' });
    expect(isEmailSourcedRow({ raw_notification: email })).toBe(true);
    expect(isBankSourcedRow({ raw_notification: email, source: 'notification' })).toBe(false);
    expect(isBankSourcedRow({ raw_notification: bank, source: 'notification' })).toBe(true);
  });

  it('marks a bank row as spent once it has absorbed an email', () => {
    const bank = withCaptureMarker('x', { channel: 'bank' });
    expect(hasPairedEmail(bank)).toBe(false);
    const paired = withEmailPairedMarker(bank);
    expect(hasPairedEmail(paired)).toBe(true);
    // Still recognisably a bank row afterwards.
    expect(isBankSourcedRow({ raw_notification: paired, source: 'notification' })).toBe(true);
  });
});

describe('the tolerance a push-versus-email match needs', () => {
  const push = { vendor: 'LOBLAWS', amount: 42.10, date: '2026-09-01' };

  it('matches the same charge reported a day later and a cent apart', () => {
    // The exact drift that previously left a phantom row on the dashboard.
    expect(isSameCharge(push, { vendor: 'Loblaws #1234', amount: 42.11, date: '2026-09-02' }))
      .toBe(true);
  });

  it('does not match a different purchase at the same shop', () => {
    expect(isSameCharge(push, { vendor: 'LOBLAWS', amount: 71.55, date: '2026-09-02' }))
      .toBe(false);
  });

  it('does not match a refund of the same amount', () => {
    expect(isSameCharge(push, { vendor: 'LOBLAWS', amount: -42.10, date: '2026-09-01' }))
      .toBe(false);
  });

  it('does not reach beyond the window', () => {
    expect(isSameCharge(push, { vendor: 'LOBLAWS', amount: 42.10, date: '2026-09-09' }))
      .toBe(false);
  });
});

/**
 * The rule itself runs deep inside the pipeline, against Supabase. What can be
 * pinned here is its shape — and every one of these guards is load-bearing.
 */
describe('the rule is wired the way it has to be', () => {
  it('only an email defers, so a bank alert is never the one dropped', () => {
    expect(PROCESSOR).toMatch(/input\.channel === 'email' && existingTx/);
  });

  it('an email only ever defers to a bank-sourced row', () => {
    // The pure selector excludes other emails and typed entries; the pipeline
    // calls it only on the email route.
    expect(PROCESSOR).toMatch(/findUnpairedBankCaptureForEmail\(existingTx/);
  });

  it('one email cancels at most one bank row', () => {
    // Without the pairing mark, a second genuine purchase at the same merchant
    // for the same amount inside the window would vanish into the same row —
    // the trap two Fizz charges three days apart already sprang once.
    expect(PROCESSOR).toMatch(/withEmailPairedMarker\(/);
  });

  it('uses the looser same-charge test, not the same-day same-cent one', () => {
    expect(PROCESSOR).toMatch(/findUnpairedBankCaptureForEmail\(existingTx, \{ vendor, amount, date: captureDay \}\)/);
  });

  it('a later bank alert upgrades the email row instead of duplicating it', () => {
    expect(PROCESSOR).toMatch(/input\.channel !== 'email' && existingTx/);
    expect(PROCESSOR).toMatch(/findEmailCaptureForBank\(existingTx/);
  });

  it('every capture records the route it came by', () => {
    expect(PROCESSOR).toMatch(/raw_notification: withCaptureMarker\(/);
  });

  it('the email sender is vetted before anything else is read', () => {
    expect(PROCESSOR).toMatch(/parseEmailAlert\(\{/);
  });
});

/**
 * Two apps, one tap.
 *
 * A wallet and the card's own bank app announce the same tap-to-pay purchase
 * within seconds, in completely different words. Google Wallet was refused
 * outright for years because of it, and the reason the earlier fix failed is the
 * thing this rule is built around: it compared MERCHANT NAMES, and a wallet is
 * exactly the source that parses the merchant badly.
 *
 * So this looks at the amount and the clock, and never at the merchant.
 */
describe('the first app to report a tap wins', () => {
  const TAP = 1_760_000_000_000;
  const walletRow = (amount: number, at: number, vendor = 'GOOGLE WALLET') => ({
    vendor,
    amount,
    raw_notification: withCaptureMarker('paid', {
      channel: 'bank' as const,
      packageName: 'com.google.android.apps.walletnfcrel',
      notifiedAt: at,
    }),
  });
  const fromBankApp = (amount: number, at: number) => ({
    packageName: 'com.bmo.mobile',
    amount,
    notifiedAt: at,
  });

  it('drops the second report even when the merchants look nothing alike', () => {
    // THE CASE THAT BEAT THE OLD APPROACH. One side says "GOOGLE WALLET", the
    // other says "TIM HORTONS #422". No name-based check can pair these.
    expect(isOtherAppSameTap(
      walletRow(12.45, TAP),
      fromBankApp(12.45, TAP + 4_000),
      amountsAgree,
    )).toBe(true);
  });

  it('allows the cent of drift the two sides sometimes disagree by', () => {
    expect(isOtherAppSameTap(walletRow(42.10, TAP), fromBankApp(42.11, TAP + 2_000), amountsAgree))
      .toBe(true);
  });

  it('keeps both when the amounts are genuinely different', () => {
    expect(isOtherAppSameTap(walletRow(12.45, TAP), fromBankApp(19.99, TAP + 4_000), amountsAgree))
      .toBe(false);
  });

  it('keeps both when the two purchases are far enough apart in time', () => {
    // Two coffees for the same price later in the day are two purchases. This is
    // why the window is minutes: widened, this rule starts eating real spending.
    expect(isOtherAppSameTap(
      walletRow(5.00, TAP),
      fromBankApp(5.00, TAP + CROSS_APP_WINDOW_MS + 1_000),
      amountsAgree,
    )).toBe(false);
  });

  it('never claims a report from the SAME app', () => {
    // Two identical charges from one bank in five minutes are the bank's
    // business, not this rule's — and a re-broadcast is caught upstream.
    const row = walletRow(5.00, TAP);
    expect(isOtherAppSameTap(
      row,
      { packageName: 'com.google.android.apps.walletnfcrel', amount: 5.00, notifiedAt: TAP + 1_000 },
      amountsAgree,
    )).toBe(false);
  });

  it('never claims a row whose app is unknown', () => {
    // Anything captured before this shipped has no package recorded. Guessing
    // would let an ordinary re-broadcast swallow a real second purchase.
    expect(isOtherAppSameTap(
      { amount: 5.00, raw_notification: 'You spent $5.00', created_at: new Date(TAP).toISOString() },
      fromBankApp(5.00, TAP + 1_000),
      amountsAgree,
    )).toBe(false);
  });

  it('dates a row by when the alert was posted, not when the row was written', () => {
    // Both alerts sit in the native queue while the phone sleeps and are written
    // milliseconds apart hours later. Insert time would call them simultaneous;
    // post time says how far apart the announcements really were.
    const marked = withCaptureMarker('paid', {
      channel: 'bank', packageName: 'com.bmo.mobile', notifiedAt: TAP,
    });
    expect(captureNotifiedAt({ raw_notification: marked, created_at: new Date(TAP + 9_000_000).toISOString() }))
      .toBe(TAP);
    // Falls back to the write time when there is no marker to go on.
    expect(captureNotifiedAt({ raw_notification: 'plain', created_at: new Date(TAP).toISOString() }))
      .toBe(TAP);
    expect(captureNotifiedAt({ raw_notification: 'plain', created_at: null })).toBeNull();
  });

  it('survives a marker round trip with the timestamp attached', () => {
    const marked = withCaptureMarker('x', {
      channel: 'bank', packageName: 'com.google.android.apps.walletnfcrel', notifiedAt: TAP,
    });
    expect(readCaptureMarker(marked)).toEqual({
      channel: 'bank',
      packageName: 'com.google.android.apps.walletnfcrel',
      notifiedAt: TAP,
    });
    expect(stripCaptureBookkeeping(marked)).toBe('x');
  });

  it('is wired into the pipeline ahead of the email rules', () => {
    // It is the tighter, more certain match, and it applies to every channel.
    expect(PROCESSOR).toMatch(/isOtherAppSameTap\(/);
    expect(PROCESSOR.indexOf('isOtherAppSameTap'))
      .toBeLessThan(PROCESSOR.indexOf("input.channel === 'email' && existingTx"));
    // And the row has to carry the post time, or nothing can be measured.
    expect(PROCESSOR).toMatch(/notifiedAt: notifTimestamp/);
  });
});
