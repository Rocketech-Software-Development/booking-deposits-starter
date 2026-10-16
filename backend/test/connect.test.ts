import { describe, expect, it } from 'vitest';
import { readJson, setup } from './helpers.js';

function freshProvider() {
  const t = setup();
  t.store.updateProviderConnect('prov_hair', {
    stripeAccountId: null,
    transfersActive: false,
    payoutsActive: false,
    requirementsDue: false,
  });
  return t;
}

const asProvider = { 'x-demo-provider': 'prov_hair' };

describe('Connect onboarding (Accounts v2)', () => {
  it('creates a v2 recipient account once and returns a single-use onboarding link', async () => {
    const t = freshProvider();
    const response = await t.app.request('/providers/prov_hair/connect/onboarding-link', { method: 'POST', headers: asProvider });
    const { url } = await readJson(response);

    expect(url).toMatch(/^https:\/\/connect\.stripe\.com\//);
    expect(t.stripe.createAccount).toHaveBeenCalledWith(
      {
        display_name: 'Northside Hair Studio',
        dashboard: 'express',
        identity: { country: 'us' },
        defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
        configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
        include: ['configuration.recipient', 'requirements'],
        metadata: { provider_id: 'prov_hair' },
      },
      'provider:prov_hair:account',
    );
    const accountId = t.store.getProvider('prov_hair')!.stripeAccountId;
    expect(t.stripe.createAccountLink).toHaveBeenCalledWith({
      account: accountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          refresh_url: 'http://localhost:4242/connect/refresh?provider=prov_hair',
          return_url: 'http://localhost:4242/connect/return?provider=prov_hair',
        },
      },
    });

    await t.connect.createOnboardingLink('prov_hair');
    expect(t.stripe.createAccount).toHaveBeenCalledTimes(1);
    expect(t.stripe.createAccountLink).toHaveBeenCalledTimes(2);
  });

  it('stores the new account as not ready, with requirements due', async () => {
    const t = freshProvider();
    await t.connect.createOnboardingLink('prov_hair');
    expect(t.connect.getStatus('prov_hair')).toMatchObject({
      transfersActive: false,
      payoutsActive: false,
      requirementsDue: true,
      acceptingBookings: false,
    });
  });

  it('starts taking bookings once stripe_balance.stripe_transfers is active', async () => {
    const t = freshProvider();
    await t.connect.createOnboardingLink('prov_hair');
    expect(t.bookings.listProviders().find((p) => p.id === 'prov_hair')?.acceptingBookings).toBe(false);

    t.stripe.finishOnboarding(t.store.getProvider('prov_hair')!.stripeAccountId!);
    const response = await t.app.request('/providers/prov_hair/connect/status', { headers: asProvider });
    expect((await readJson(response)).status).toMatchObject({
      acceptingBookings: true,
      transfersActive: true,
      payoutsActive: true,
      requirementsDue: false,
    });
    expect(t.bookings.listProviders().find((p) => p.id === 'prov_hair')?.acceptingBookings).toBe(true);
  });

  it('checks the account when the provider comes back from Stripe', async () => {
    const t = freshProvider();
    await t.connect.createOnboardingLink('prov_hair');

    const unfinished = await (await t.app.request('/connect/return?provider=prov_hair')).text();
    expect(unfinished).toContain('Stripe still needs some details');

    t.stripe.finishOnboarding(t.store.getProvider('prov_hair')!.stripeAccountId!);
    const finished = await (await t.app.request('/connect/return?provider=prov_hair')).text();
    expect(finished).toContain('Payouts are set up');
  });

  it('sends an expired link to a fresh one', async () => {
    const t = freshProvider();
    await t.connect.createOnboardingLink('prov_hair');
    const response = await t.app.request('/connect/refresh?provider=prov_hair');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(/^https:\/\/connect\.stripe\.com\//);
  });

  it('opens the Express Dashboard only after onboarding', async () => {
    const t = freshProvider();
    await t.connect.createOnboardingLink('prov_hair');
    const early = await t.app.request('/providers/prov_hair/connect/dashboard-link', { method: 'POST', headers: asProvider });
    expect(early.status).toBe(409);

    t.stripe.finishOnboarding(t.store.getProvider('prov_hair')!.stripeAccountId!);
    await t.connect.syncProvider('prov_hair');
    const ready = await t.app.request('/providers/prov_hair/connect/dashboard-link', { method: 'POST', headers: asProvider });
    expect((await readJson(ready)).url).toContain('/express/');
  });

  it('pays the provider through the v2 account with a destination charge', async () => {
    const t = freshProvider();
    await t.connect.createOnboardingLink('prov_hair');
    const accountId = t.store.getProvider('prov_hair')!.stripeAccountId!;
    t.stripe.finishOnboarding(accountId);
    await t.connect.syncProvider('prov_hair');

    await t.book('prov_hair', 27);
    expect(t.stripe.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ transfer_data: { destination: accountId }, application_fee_amount: 300 }),
      expect.any(String),
    );
  });
});
