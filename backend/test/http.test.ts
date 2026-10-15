import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { DEMO_USER_ID, readJson, setup } from './helpers.js';

const asCustomer = { 'content-type': 'application/json', 'x-demo-user': DEMO_USER_ID };

describe('HTTP API', () => {
  it('serves the publishable key and merchant details to the app', async () => {
    const t = setup();
    const body = await readJson(t.app.request('/config'));
    expect(body).toEqual({
      publishableKey: 'pk_test_placeholder',
      merchantDisplayName: 'Test Bookings',
      merchantCountryCode: 'US',
      currency: 'usd',
    });
  });

  it('lists providers and their open slots', async () => {
    const t = setup();
    const { providers } = await readJson(t.app.request('/providers'));
    expect(providers).toHaveLength(3);
    expect(providers[0]).toMatchObject({ acceptingBookings: true });
    expect(providers[0]).not.toHaveProperty('stripeAccountId');

    const { provider } = await readJson(t.app.request('/providers/prov_hair'));
    expect(provider.slots.length).toBe(9);
  });

  it('quotes the deposit and policy text for a slot', async () => {
    const t = setup();
    const response = await t.app.request('/quote?providerId=prov_hair&slotId=prov_hair_slot_27');
    const { quote } = await readJson(response);
    expect(quote).toMatchObject({ strategy: 'hold', depositAmount: 3000, noShowFeeAmount: 6000 });
    expect(quote.policyHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('books with a customer header and returns PaymentSheet params', async () => {
    const t = setup();
    const { quote } = await readJson(t.app.request('/quote?providerId=prov_massage&slotId=prov_massage_slot_75'));

    const anonymous = await t.app.request('/bookings', { method: 'POST', body: '{}' });
    expect(anonymous.status).toBe(401);

    const response = await t.app.request('/bookings', {
      method: 'POST',
      headers: asCustomer,
      body: JSON.stringify({ providerId: 'prov_massage', slotId: 'prov_massage_slot_75', policyAccepted: true, policyHash: quote.policyHash }),
    });
    expect(response.status).toBe(201);
    const body = await readJson(response);
    expect(body.booking.status).toBe('pending_payment');
    expect(body.paymentSheet).toMatchObject({ merchantDisplayName: 'Test Bookings', customerSessionClientSecret: 'cuss_secret_test' });

    const slots = (await readJson(t.app.request('/providers/prov_massage'))).provider.slots;
    expect(slots.map((s: { id: string }) => s.id)).not.toContain('prov_massage_slot_75');
  });

  it('keeps providers out of each other bookings', async () => {
    const t = setup();
    const response = await t.app.request('/providers/prov_hair/bookings', { headers: { 'x-demo-provider': 'prov_massage' } });
    expect(response.status).toBe(403);
  });

  it('runs the provider actions over HTTP', async () => {
    const t = setup({ allowEarlyOutcomes: true });
    const { id } = await t.bookAndPay('prov_trainer', 27);
    const headers = { 'x-demo-provider': 'prov_trainer' };

    const list = await readJson(t.app.request('/providers/prov_trainer/bookings', { headers }));
    expect(list.bookings).toHaveLength(1);

    const noShow = await t.app.request(`/providers/prov_trainer/bookings/${id}/no-show`, { method: 'POST', headers });
    expect((await readJson(noShow)).booking.status).toBe('no_show');

    const refund = await t.app.request(`/providers/prov_trainer/bookings/${id}/refund`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 1000 }),
    });
    expect((await readJson(refund)).booking.totals.refunded).toBe(1000);
  });

  it('turns Stripe failures into a 502 and frees the slot', async () => {
    const t = setup();
    t.stripe.createPaymentIntent.mockRejectedValueOnce(
      new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'Stripe is having a moment' }),
    );
    const { quote } = await readJson(t.app.request('/quote?providerId=prov_massage&slotId=prov_massage_slot_75'));
    const response = await t.app.request('/bookings', {
      method: 'POST',
      headers: asCustomer,
      body: JSON.stringify({ providerId: 'prov_massage', slotId: 'prov_massage_slot_75', policyAccepted: true, policyHash: quote.policyHash }),
    });
    expect(response.status).toBe(502);
    expect(await t.book('prov_massage', 75)).toBeDefined();
  });

  it('returns a clear error shape for unknown resources', async () => {
    const t = setup();
    const response = await t.app.request('/providers/nope');
    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: { code: 'not_found', message: 'Provider not found' } });
  });
});
