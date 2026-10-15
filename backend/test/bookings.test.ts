import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { DEMO_USER_ID, HOUR, setup } from './helpers.js';

// Seeded slots (see seed-data.ts) relative to T0:
//   *_slot_27  starts 26.5 h after T0  -> inside the 144 h hold window
//   *_slot_75  starts 74.5 h after T0
//   *_slot_171 starts 170.5 h after T0 -> outside the hold window
// prov_hair:    auto, 25% deposit ($30), free cancel 24 h, no-show total $60
// prov_massage: charge, $20 deposit, free cancel 48 h, no-show keeps the deposit
// prov_trainer: card_on_file, free cancel 12 h, no-show fee $35

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).status).toBe(status);
  expect((error as AppError).code).toBe(code);
}

describe('creating a booking', () => {
  it('holds the deposit with a manual-capture PaymentIntent sent to the provider', async () => {
    const t = setup();
    const { booking, paymentSheet } = await t.book('prov_hair', 27);

    expect(booking.status).toBe('pending_payment');
    expect(booking.strategy).toBe('hold');
    expect(booking.depositAmount).toBe(3000);
    expect(booking.policyLines.length).toBeGreaterThan(3);
    expect(booking.policyAcceptedAt).toBe('2030-03-04T09:30:00.000Z');

    expect(t.stripe.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 3000,
        currency: 'usd',
        capture_method: 'manual',
        setup_future_usage: 'off_session',
        allowed_payment_method_types: ['card'],
        application_fee_amount: 300,
        transfer_data: { destination: 'acct_prov_hair' },
        metadata: expect.objectContaining({ booking_id: booking.id, kind: 'deposit' }),
      }),
      `booking:${booking.id}:deposit`,
    );
    expect(paymentSheet.paymentIntentClientSecret).toMatch(/_secret_test$/);
    expect(paymentSheet.customerSessionClientSecret).toBe('cuss_secret_test');
    expect(paymentSheet.customerId).toMatch(/^cus_/);
    expect(t.stripe.createCustomerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        components: { mobile_payment_element: expect.objectContaining({ enabled: true }) },
      }),
    );
  });

  it('confirms the booking once the hold is authorized and records when it expires', async () => {
    const t = setup();
    const booking = await t.bookAndPay('prov_hair', 27);

    expect(booking.status).toBe('confirmed');
    expect(booking.paymentMethodId).toBe('pm_card_visa');
    expect(booking.payments[0]?.status).toBe('authorized');
    expect(booking.payments[0]?.captureBefore).toBe(new Date(1_900_000_000 * 1000).toISOString());
    expect(booking.totals).toEqual({ held: 3000, collected: 0, refunded: 0 });
  });

  it('charges the deposit up front when the appointment is outside the hold window', async () => {
    const t = setup();
    const booking = await t.bookAndPay('prov_hair', 171);

    expect(booking.strategy).toBe('charge');
    expect(t.stripe.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ capture_method: 'automatic' }),
      expect.any(String),
    );
    expect(booking.totals.collected).toBe(3000);
  });

  it('only saves the card with a SetupIntent for card-on-file providers', async () => {
    const t = setup();
    const { booking, paymentSheet } = await t.book('prov_trainer', 27);

    expect(t.stripe.createPaymentIntent).not.toHaveBeenCalled();
    expect(t.stripe.createSetupIntent).toHaveBeenCalledWith(
      expect.objectContaining({ usage: 'off_session', allowed_payment_method_types: ['card'] }),
      `booking:${booking.id}:setup`,
    );
    expect(paymentSheet.setupIntentClientSecret).toMatch(/^seti_/);

    t.stripe.customerSavesCard(booking.setupIntentId!);
    const confirmed = await t.bookings.refreshForUser(DEMO_USER_ID, booking.id);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.paymentMethodId).toBe('pm_card_visa');
  });

  it('reuses the Stripe customer for later bookings', async () => {
    const t = setup();
    await t.book('prov_hair', 27);
    await t.book('prov_massage', 75);
    expect(t.stripe.createCustomer).toHaveBeenCalledTimes(1);
  });

  it('refuses to book without the policy being accepted', async () => {
    const t = setup();
    const quote = t.bookings.quote('prov_hair', 'prov_hair_slot_27');
    await expectAppError(
      t.bookings.createBooking(DEMO_USER_ID, { providerId: 'prov_hair', slotId: 'prov_hair_slot_27', policyHash: quote.policyHash }),
      400,
      'policy_not_accepted',
    );
  });

  it('refuses when the policy changed after the customer read it', async () => {
    const t = setup();
    await expectAppError(
      t.bookings.createBooking(DEMO_USER_ID, {
        providerId: 'prov_hair',
        slotId: 'prov_hair_slot_27',
        policyAccepted: true,
        policyHash: 'stale',
      }),
      409,
      'policy_changed',
    );
  });

  it('refuses providers that have not finished Connect onboarding', async () => {
    const t = setup();
    t.store.updateProviderConnect('prov_hair', { transfersActive: false });
    await expectAppError(t.book('prov_hair', 27), 409, 'provider_not_onboarded');
  });

  it('refuses a slot that is already booked', async () => {
    const t = setup();
    await t.bookAndPay('prov_hair', 27);
    await expectAppError(t.book('prov_hair', 27), 409, 'slot_taken');
  });

  it('refuses a slot that has already started', async () => {
    const t = setup();
    t.advance(3 * HOUR);
    await expectAppError(t.book('prov_hair', 3), 409, 'slot_in_past');
  });

  it('refuses holds that would expire before the appointment when the provider insists on holds', async () => {
    const t = setup();
    const provider = t.store.getProvider('prov_hair')!;
    t.store.upsertProvider({ ...provider, policy: { ...provider.policy, strategy: 'hold' } });

    await expectAppError(t.book('prov_hair', 171), 422, 'outside_hold_window');
    const slots = t.bookings.getProvider('prov_hair').slots.map((s) => s.id);
    expect(slots).toContain('prov_hair_slot_27');
    expect(slots).not.toContain('prov_hair_slot_171');
  });

  it('frees a slot whose booking was never paid, and cancels the abandoned intent', async () => {
    const t = setup();
    t.store.upsertUser({ id: 'user_other', name: 'Other', email: 'other@example.com', stripeCustomerId: null });
    const { booking: abandoned } = await t.book('prov_hair', 27);

    await expectAppError(t.book('prov_hair', 27, 'user_other'), 409, 'slot_taken');
    t.advance(16 * 60_000);
    const { booking } = await t.book('prov_hair', 27, 'user_other');

    expect(booking.status).toBe('pending_payment');
    expect(t.store.getBooking(abandoned.id)?.status).toBe('expired');
    expect(t.stripe.intents.get(abandoned.payments[0]!.paymentIntentId)?.status).toBe('canceled');
  });

  it('keeps a booking the customer paid for even if the payment window passed', async () => {
    const t = setup();
    t.store.upsertUser({ id: 'user_other', name: 'Other', email: 'other@example.com', stripeCustomerId: null });
    const { booking } = await t.book('prov_hair', 27);
    t.stripe.customerPays(booking.payments[0]!.paymentIntentId);
    t.advance(16 * 60_000);

    await expectAppError(t.book('prov_hair', 27, 'user_other'), 409, 'slot_taken');
    expect(t.store.getBooking(booking.id)?.status).toBe('confirmed');
  });

  it('hides other customers bookings', async () => {
    const t = setup();
    t.store.upsertUser({ id: 'user_other', name: 'Other', email: 'other@example.com', stripeCustomerId: null });
    const { booking } = await t.book('prov_hair', 27);
    expect(() => t.bookings.getBookingForUser('user_other', booking.id)).toThrow(AppError);
    await expectAppError(t.bookings.cancelByCustomer('user_other', booking.id), 404, 'not_found');
  });
});

describe('customer cancellation', () => {
  it('releases a hold when cancelled before the cutoff', async () => {
    const t = setup();
    const { id } = await t.bookAndPay('prov_hair', 27);
    const booking = await t.bookings.cancelByCustomer(DEMO_USER_ID, id);

    expect(booking.status).toBe('canceled');
    expect(t.stripe.cancelPaymentIntent).toHaveBeenCalledWith(
      booking.payments[0]!.paymentIntentId,
      { cancellation_reason: 'requested_by_customer' },
      expect.any(String),
    );
    expect(t.stripe.capturePaymentIntent).not.toHaveBeenCalled();
    expect(booking.totals).toEqual({ held: 0, collected: 0, refunded: 0 });
  });

  it('refunds a charged deposit in full, pulling back the transfer and the platform fee', async () => {
    const t = setup();
    const { id } = await t.bookAndPay('prov_massage', 75);
    const booking = await t.bookings.cancelByCustomer(DEMO_USER_ID, id);

    expect(booking.status).toBe('canceled');
    expect(t.stripe.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: booking.payments[0]!.paymentIntentId,
        amount: 2000,
        reverse_transfer: true,
        refund_application_fee: true,
      }),
      expect.any(String),
    );
    expect(booking.totals.refunded).toBe(2000);
  });

  it('applies the no-show rule to a late cancellation: capture the hold, charge the rest off-session', async () => {
    const t = setup();
    const { id } = await t.bookAndPay('prov_hair', 27);
    t.advance(3 * HOUR); // free cancellation ended 2.5 h after T0
    const booking = await t.bookings.cancelByCustomer(DEMO_USER_ID, id);

    expect(booking.status).toBe('canceled_late');
    expect(t.stripe.capturePaymentIntent).toHaveBeenCalledTimes(1);
    expect(t.stripe.createPaymentIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        amount: 3000,
        off_session: true,
        confirm: true,
        payment_method: 'pm_card_visa',
        transfer_data: { destination: 'acct_prov_hair' },
        application_fee_amount: 300,
        metadata: expect.objectContaining({ kind: 'no_show_fee' }),
      }),
      `booking:${id}:no_show_fee:0`,
    );
    expect(booking.totals.collected).toBe(6000);
    expect(booking.amountDue).toBe(0);
  });

  it('cancels an unpaid booking without charging anything', async () => {
    const t = setup();
    const { booking } = await t.book('prov_hair', 27);
    const canceled = await t.bookings.cancelByCustomer(DEMO_USER_ID, booking.id);
    expect(canceled.status).toBe('canceled');
    expect(canceled.payments[0]?.status).toBe('canceled');
  });

  it('cannot cancel twice', async () => {
    const t = setup();
    const { id } = await t.bookAndPay('prov_hair', 27);
    await t.bookings.cancelByCustomer(DEMO_USER_ID, id);
    await expectAppError(t.bookings.cancelByCustomer(DEMO_USER_ID, id), 409, 'invalid_status');
  });
});

describe('no-shows', () => {
  it('keeps a charged deposit and charges nothing more when the policy says so', async () => {
    const t = setup();
    const { id } = await t.bookAndPay('prov_massage', 75);
    t.advance(75 * HOUR);
    const callsBefore = t.stripe.createPaymentIntent.mock.calls.length;
    const booking = await t.bookings.markNoShow('prov_massage', id);

    expect(booking.status).toBe('no_show');
    expect(t.stripe.createPaymentIntent.mock.calls.length).toBe(callsBefore);
    expect(t.stripe.createRefund).not.toHaveBeenCalled();
    expect(booking.totals.collected).toBe(2000);
  });

  it('cannot be marked before the appointment starts', async () => {
    const t = setup();
    const { id } = await t.bookAndPay('prov_massage', 75);
    await expectAppError(t.bookings.markNoShow('prov_massage', id), 409, 'not_started');
  });

  it('can be marked early when the demo flag is on', async () => {
    const t = setup({ allowEarlyOutcomes: true });
    const { id } = await t.bookAndPay('prov_massage', 75);
    expect((await t.bookings.markNoShow('prov_massage', id)).status).toBe('no_show');
  });

  it('charges the fee off-session to the saved card for card-on-file bookings', async () => {
    const t = setup();
    const { id } = await t.bookAndPay('prov_trainer', 27);
    t.advance(27 * HOUR);
    const booking = await t.bookings.markNoShow('prov_trainer', id);

    expect(t.stripe.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 3500, off_session: true, confirm: true, application_fee_amount: 350 }),
      `booking:${id}:no_show_fee:0`,
    );
    expect(booking.totals.collected).toBe(3500);
  });

  it('records the fee as owed when the bank asks for authentication, then lets the customer pay in the app', async () => {
    const t = setup();
    const { id } = await t.bookAndPay('prov_trainer', 27);
    t.advance(27 * HOUR);
    t.stripe.failNextOffSession = 'authentication_required';

    const booking = await t.bookings.markNoShow('prov_trainer', id);
    expect(booking.status).toBe('no_show');
    expect(booking.amountDue).toBe(3500);
    const failed = booking.payments.find((p) => p.kind === 'no_show_fee')!;
    expect(failed.status).toBe('failed');

    const { paymentSheet } = await t.bookings.createFeePaymentSheet(DEMO_USER_ID, id);
    const onSession = t.stripe.createPaymentIntent.mock.lastCall![0];
    expect(onSession).toMatchObject({ amount: 3500, transfer_data: { destination: 'acct_prov_trainer' } });
    expect(onSession.off_session).toBeUndefined();
    expect(paymentSheet.paymentIntentClientSecret).toBeDefined();
    expect(t.stripe.intents.get(failed.paymentIntentId)?.status).toBe('canceled');

    const newIntentId = paymentSheet.paymentIntentClientSecret!.replace('_secret_test', '');
    t.stripe.customerPays(newIntentId);
    const settled = await t.bookings.refreshForUser(DEMO_USER_ID, id);
    expect(settled.amountDue).toBe(0);
    expect(settled.totals.collected).toBe(3500);
  });

  it('charges the whole amount off-session when the hold expired before the no-show', async () => {
    const t = setup();
    const { id, payments } = await t.bookAndPay('prov_hair', 27);
    t.stripe.expireHold(payments[0]!.paymentIntentId);
    t.advance(27 * HOUR);
    const booking = await t.bookings.markNoShow('prov_hair', id);

    expect(t.stripe.capturePaymentIntent).not.toHaveBeenCalled();
    expect(t.stripe.createPaymentIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({ amount: 6000, off_session: true }),
      expect.any(String),
    );
    expect(booking.payments[0]?.status).toBe('canceled');
    expect(booking.totals.collected).toBe(6000);
  });

  it('is limited to the provider of the booking', async () => {
    const t = setup({ allowEarlyOutcomes: true });
    const { id } = await t.bookAndPay('prov_massage', 75);
    await expectAppError(t.bookings.markNoShow('prov_hair', id), 404, 'not_found');
  });
});

describe('attended appointments', () => {
  it('captures a held deposit', async () => {
    const t = setup();
    const { id, payments } = await t.bookAndPay('prov_hair', 27);
    t.advance(27 * HOUR);
    const booking = await t.bookings.markCompleted('prov_hair', id);

    expect(booking.status).toBe('completed');
    expect(t.stripe.capturePaymentIntent).toHaveBeenCalledWith(payments[0]!.paymentIntentId, {}, `capture:${payments[0]!.paymentIntentId}`);
    expect(booking.totals).toEqual({ held: 0, collected: 3000, refunded: 0 });
  });

  it('leaves a charged deposit alone', async () => {
    const t = setup();
    const { id } = await t.bookAndPay('prov_massage', 75);
    t.advance(75 * HOUR);
    const booking = await t.bookings.markCompleted('prov_massage', id);
    expect(booking.status).toBe('completed');
    expect(t.stripe.capturePaymentIntent).not.toHaveBeenCalled();
  });
});

describe('provider cancellation and refunds', () => {
  it('gives everything back when the provider cancels', async () => {
    const t = setup();
    const charged = await t.bookAndPay('prov_massage', 75);
    const held = await t.bookAndPay('prov_hair', 27);

    expect((await t.bookings.cancelByProvider('prov_massage', charged.id)).totals.refunded).toBe(2000);
    expect((await t.bookings.cancelByProvider('prov_hair', held.id)).payments[0]?.status).toBe('canceled');
  });

  it('refunds part of a kept deposit, then the rest, then refuses', async () => {
    const t = setup();
    const { id } = await t.bookAndPay('prov_massage', 75);
    t.advance(75 * HOUR);
    await t.bookings.markNoShow('prov_massage', id);

    const partial = await t.bookings.refund('prov_massage', id, 500);
    expect(partial.totals.refunded).toBe(500);
    expect(t.stripe.createRefund).toHaveBeenLastCalledWith(
      expect.objectContaining({ amount: 500, reverse_transfer: true, refund_application_fee: true }),
      expect.any(String),
    );

    const rest = await t.bookings.refund('prov_massage', id);
    expect(rest.totals.refunded).toBe(2000);
    expect(t.stripe.createRefund).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 1500 }), expect.any(String));

    await expectAppError(t.bookings.refund('prov_massage', id), 409, 'nothing_to_refund');
  });

  it('rejects refund amounts that are not whole cents within what was charged', async () => {
    const t = setup();
    const { id } = await t.bookAndPay('prov_massage', 75);
    await expectAppError(t.bookings.refund('prov_massage', id, 2500), 400, 'invalid_amount');
    await expectAppError(t.bookings.refund('prov_massage', id, 10.5), 400, 'invalid_amount');
  });

  it('points to cancellation when only a hold exists', async () => {
    const t = setup();
    const { id } = await t.bookAndPay('prov_hair', 27);
    await expectAppError(t.bookings.refund('prov_hair', id), 409, 'nothing_to_refund');
  });
});
