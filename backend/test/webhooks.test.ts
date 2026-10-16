import { describe, expect, it } from 'vitest';
import { CONNECT_WEBHOOK_SECRET, DEMO_USER_ID, THIN_WEBHOOK_SECRET, WEBHOOK_SECRET, readJson, setup } from './helpers.js';

type TestApp = ReturnType<typeof setup>;

let eventCounter = 0;

/** Posts a correctly signed event, the way Stripe or the Stripe CLI would. */
async function sendEvent(
  t: TestApp,
  type: string,
  object: Record<string, unknown>,
  options: { path?: string; secret?: string; id?: string; account?: string } = {},
) {
  eventCounter += 1;
  const payload = JSON.stringify({
    id: options.id ?? `evt_test_${eventCounter}`,
    object: 'event',
    type,
    account: options.account,
    created: 1_900_000_000,
    data: { object },
  });
  const secret = options.secret ?? WEBHOOK_SECRET;
  return t.app.request(options.path ?? '/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': t.stripe.signedHeader(payload, secret) },
    body: payload,
  });
}

describe('webhook endpoint', () => {
  it('confirms a booking when the hold is authorized', async () => {
    const t = setup();
    const { booking } = await t.book('prov_hair', 27);
    const intentId = booking.payments[0]!.paymentIntentId;
    t.stripe.customerPays(intentId);

    const response = await sendEvent(t, 'payment_intent.amount_capturable_updated', { id: intentId, object: 'payment_intent' });
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ received: true, result: 'processed' });
    expect(t.store.getBooking(booking.id)?.status).toBe('confirmed');
  });

  it('reads the intent from the API instead of trusting the payload', async () => {
    const t = setup();
    const { booking } = await t.book('prov_massage', 75);
    const intentId = booking.payments[0]!.paymentIntentId;

    // A forged or stale payload claiming success changes nothing while Stripe says otherwise.
    await sendEvent(t, 'payment_intent.succeeded', { id: intentId, object: 'payment_intent', status: 'succeeded' });
    expect(t.store.getBooking(booking.id)?.status).toBe('pending_payment');
    expect(t.stripe.retrievePaymentIntent).toHaveBeenCalledWith(intentId, { expand: ['latest_charge'] });
  });

  it('rejects a bad signature', async () => {
    const t = setup();
    const response = await sendEvent(t, 'payment_intent.succeeded', { id: 'pi_x' }, { secret: 'whsec_wrong' });
    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error: { code: 'invalid_signature' } });
  });

  it('rejects a request without a signature header', async () => {
    const t = setup();
    const response = await t.app.request('/webhooks/stripe', { method: 'POST', body: '{}' });
    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error: { code: 'missing_signature' } });
  });

  it('processes each event id once', async () => {
    const t = setup();
    const { booking } = await t.book('prov_massage', 75);
    const intentId = booking.payments[0]!.paymentIntentId;
    t.stripe.customerPays(intentId);

    await sendEvent(t, 'payment_intent.succeeded', { id: intentId }, { id: 'evt_dup' });
    const second = await sendEvent(t, 'payment_intent.succeeded', { id: intentId }, { id: 'evt_dup' });
    expect(await readJson(second)).toEqual({ received: true, result: 'duplicate' });
    expect(t.stripe.retrievePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('ignores intents that are not ours and event types it does not handle', async () => {
    const t = setup();
    expect(await readJson(sendEvent(t, 'payment_intent.succeeded', { id: 'pi_elsewhere' }))).toMatchObject({
      result: 'ignored',
    });
    expect(await readJson(sendEvent(t, 'customer.created', { id: 'cus_1' }))).toMatchObject({ result: 'ignored' });
  });

  it('confirms card-on-file bookings from setup_intent.succeeded', async () => {
    const t = setup();
    const { booking } = await t.book('prov_trainer', 27);
    t.stripe.customerSavesCard(booking.setupIntentId!);
    await sendEvent(t, 'setup_intent.succeeded', { id: booking.setupIntentId });
    expect(t.store.getBooking(booking.id)).toMatchObject({ status: 'confirmed', paymentMethodId: 'pm_card_visa' });
  });

  it('marks an expired hold as canceled but keeps the booking', async () => {
    const t = setup();
    const { id, payments } = await t.bookAndPay('prov_hair', 27);
    t.stripe.expireHold(payments[0]!.paymentIntentId);
    await sendEvent(t, 'payment_intent.canceled', { id: payments[0]!.paymentIntentId });

    const booking = t.bookings.getBookingForUser(DEMO_USER_ID, id);
    expect(booking.status).toBe('confirmed');
    expect(booking.payments[0]?.status).toBe('canceled');
  });

  it('picks up refunds made in the Stripe Dashboard', async () => {
    const t = setup();
    const { id, payments } = await t.bookAndPay('prov_massage', 75);
    await sendEvent(t, 'charge.refunded', { id: 'ch_1', object: 'charge', payment_intent: payments[0]!.paymentIntentId, amount_refunded: 700 });
    expect(t.bookings.getBookingForUser(DEMO_USER_ID, id).totals.refunded).toBe(700);
  });

  it('flags disputed bookings', async () => {
    const t = setup();
    const { id, payments } = await t.bookAndPay('prov_massage', 75);
    await sendEvent(t, 'charge.dispute.created', { id: 'dp_1', object: 'dispute', payment_intent: payments[0]!.paymentIntentId });
    expect(t.store.getBooking(id)?.disputed).toBe(true);
  });
});

/** A provider that started v2 onboarding and then finished it at Stripe. */
async function onboardedAtStripe(t: TestApp) {
  t.store.updateProviderConnect('prov_hair', { stripeAccountId: null, transfersActive: false, payoutsActive: false });
  await t.connect.createOnboardingLink('prov_hair');
  const accountId = t.store.getProvider('prov_hair')!.stripeAccountId!;
  t.stripe.finishOnboarding(accountId);
  return accountId;
}

/** Posts a signed thin event (Accounts v2 events only carry a pointer to the object). */
async function sendThinEvent(t: TestApp, type: string, accountId: string, options: { id?: string; secret?: string } = {}) {
  eventCounter += 1;
  const payload = JSON.stringify({
    id: options.id ?? `evt_thin_${eventCounter}`,
    object: 'v2.core.event',
    type,
    created: '2030-03-04T09:31:00.000Z',
    livemode: false,
    related_object: { id: accountId, type: 'v2.core.account', url: `/v2/core/accounts/${accountId}` },
  });
  const secret = options.secret ?? THIN_WEBHOOK_SECRET;
  return t.app.request('/webhooks/stripe-thin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': t.stripe.signedHeader(payload, secret) },
    body: payload,
  });
}

describe('connect webhook endpoint (v1 account.updated, also sent for v2 accounts)', () => {
  it('updates provider onboarding state', async () => {
    const t = setup();
    const accountId = await onboardedAtStripe(t);

    const response = await sendEvent(
      t,
      'account.updated',
      { id: accountId, object: 'account' },
      { path: '/webhooks/stripe-connect', secret: CONNECT_WEBHOOK_SECRET, account: accountId },
    );
    expect(await readJson(response)).toEqual({ received: true, result: 'processed' });
    expect(t.store.getProvider('prov_hair')).toMatchObject({ transfersActive: true, payoutsActive: true, requirementsDue: false });
  });

  it('uses its own signing secret', async () => {
    const t = setup();
    const response = await sendEvent(t, 'account.updated', { id: 'acct_1' }, { path: '/webhooks/stripe-connect' });
    expect(response.status).toBe(400);
  });
});

describe('thin event endpoint (Accounts v2 events)', () => {
  it('re-reads the account on a recipient capability change', async () => {
    const t = setup();
    const accountId = await onboardedAtStripe(t);

    const response = await sendThinEvent(t, 'v2.core.account[configuration.recipient].capability_status_updated', accountId);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ received: true, result: 'processed' });
    expect(t.stripe.retrieveAccount).toHaveBeenLastCalledWith(accountId);
    expect(t.store.getProvider('prov_hair')).toMatchObject({ transfersActive: true, requirementsDue: false });
  });

  it('handles requirement updates once per event id', async () => {
    const t = setup();
    const accountId = await onboardedAtStripe(t);
    const calls = t.stripe.retrieveAccount.mock.calls.length;

    await sendThinEvent(t, 'v2.core.account[requirements].updated', accountId, { id: 'evt_thin_dup' });
    const second = await sendThinEvent(t, 'v2.core.account[requirements].updated', accountId, { id: 'evt_thin_dup' });
    expect(await readJson(second)).toEqual({ received: true, result: 'duplicate' });
    expect(t.stripe.retrieveAccount.mock.calls.length).toBe(calls + 1);
  });

  it('ignores accounts that are not ours and rejects bad signatures', async () => {
    const t = setup();
    expect(await readJson(await sendThinEvent(t, 'v2.core.account.updated', 'acct_unknown'))).toMatchObject({ result: 'ignored' });
    const forged = await sendThinEvent(t, 'v2.core.account.updated', 'acct_unknown', { secret: 'whsec_wrong' });
    expect(forged.status).toBe(400);
  });
});
