import { createHash, randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import {
  MIN_CHARGE_AMOUNT,
  PolicyError,
  applicationFeeAmount,
  depositAmount,
  freeCancellationUntil,
  noShowRemainder,
  policyLines,
  resolveStrategy,
  validatePolicy,
} from '../domain/policy.js';
import type {
  Booking,
  BookingStatus,
  DepositStrategy,
  Payment,
  PaymentKind,
  PaymentStatus,
  Provider,
  User,
} from '../domain/types.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { idOf, isCardError, type StripePort } from '../stripe/port.js';

export interface ServiceDeps {
  store: Store;
  stripe: StripePort;
  config: Config;
  now?: () => Date;
}

/** Everything the app needs to call `initPaymentSheet`. */
export interface PaymentSheetParams {
  customerId: string;
  customerSessionClientSecret: string;
  paymentIntentClientSecret?: string;
  setupIntentClientSecret?: string;
  merchantDisplayName: string;
  merchantCountryCode: string;
}

export interface Quote {
  providerId: string;
  slotId: string;
  startsAt: string;
  strategy: DepositStrategy;
  currency: string;
  priceAmount: number;
  depositAmount: number;
  noShowFeeAmount: number;
  freeCancellationHours: number;
  freeCancellationUntil: string;
  policyLines: string[];
  /** Send this back when booking. If the policy changed in between, the booking is refused. */
  policyHash: string;
}

export interface BookingView extends Booking {
  providerName: string;
  serviceName: string;
  payments: Payment[];
  totals: { held: number; collected: number; refunded: number };
  canCancelForFree: boolean;
}

export interface ProviderView {
  id: string;
  name: string;
  category: string;
  description: string;
  serviceName: string;
  priceAmount: number;
  durationMinutes: number;
  currency: string;
  policy: Provider['policy'];
  acceptingBookings: boolean;
  connect: { onboardingStarted: boolean; detailsSubmitted: boolean; chargesEnabled: boolean; payoutsEnabled: boolean };
}

const LIVE_STATUSES: BookingStatus[] = ['pending_payment', 'confirmed', 'completed', 'no_show'];
const CANCELABLE_PAYMENT: PaymentStatus[] = ['pending', 'requires_action', 'failed', 'authorized'];

export function paymentStatusFromIntent(intent: Stripe.PaymentIntent): PaymentStatus {
  switch (intent.status) {
    case 'requires_capture':
      return 'authorized';
    case 'succeeded':
      return 'succeeded';
    case 'canceled':
      return 'canceled';
    case 'processing':
      return 'processing';
    case 'requires_action':
    case 'requires_confirmation':
      return 'requires_action';
    default:
      return intent.last_payment_error ? 'failed' : 'pending';
  }
}

export function toProviderView(p: Provider): ProviderView {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    description: p.description,
    serviceName: p.serviceName,
    priceAmount: p.priceAmount,
    durationMinutes: p.durationMinutes,
    currency: p.currency,
    policy: p.policy,
    acceptingBookings: Boolean(p.stripeAccountId) && p.transfersActive,
    connect: {
      onboardingStarted: Boolean(p.stripeAccountId),
      detailsSubmitted: p.detailsSubmitted,
      chargesEnabled: p.chargesEnabled,
      payoutsEnabled: p.payoutsEnabled,
    },
  };
}

const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const hashLines = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);

export class BookingService {
  private readonly store: Store;
  private readonly stripe: StripePort;
  private readonly config: Config;
  private readonly now: () => Date;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.stripe = deps.stripe;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
  }

  // Catalog

  listProviders(): ProviderView[] {
    return this.store.listProviders().map(toProviderView);
  }

  getProvider(id: string): ProviderView & { slots: { id: string; startsAt: string }[] } {
    const provider = this.store.getProvider(id);
    if (!provider) throw notFound('Provider');
    const now = this.now();
    const staleBefore = new Date(now.getTime() - this.config.paymentWindowMinutes * 60_000).toISOString();
    const holdLimit = now.getTime() + this.config.holdWindowHours * 3_600_000;
    const slots = this.store
      .listOpenSlots(id, now.toISOString(), staleBefore)
      // A provider set to `hold` only offers slots we can still capture a hold for.
      .filter((slot) => provider.policy.strategy !== 'hold' || new Date(slot.startsAt).getTime() <= holdLimit)
      .map((slot) => ({ id: slot.id, startsAt: slot.startsAt }));
    return { ...toProviderView(provider), slots };
  }

  /** What booking this slot would cost, and the exact policy text the customer must accept. */
  quote(providerId: string, slotId: string): Quote {
    const provider = this.store.getProvider(providerId);
    const slot = this.store.getSlot(slotId);
    if (!provider) throw notFound('Provider');
    if (!slot || slot.providerId !== provider.id) throw notFound('Slot');

    const startsAt = new Date(slot.startsAt);
    if (startsAt.getTime() <= this.now().getTime()) throw conflict('slot_in_past', 'This slot has already started.');

    let strategy: DepositStrategy;
    try {
      strategy = resolveStrategy(provider.policy.strategy, this.now(), startsAt, this.config.holdWindowHours);
    } catch (error) {
      if (error instanceof PolicyError) throw new AppError(422, error.code, error.message);
      throw error;
    }
    const problems = validatePolicy(provider.policy, provider.priceAmount, strategy);
    if (problems.length > 0) throw new AppError(422, 'invalid_policy', `Provider policy is invalid: ${problems.join('; ')}`);

    const deposit = depositAmount(provider.policy, provider.priceAmount, strategy);
    const lines = policyLines({
      strategy,
      priceAmount: provider.priceAmount,
      depositAmount: deposit,
      noShowFeeAmount: provider.policy.noShowFee,
      freeCancellationHours: provider.policy.freeCancellationHours,
      currency: provider.currency,
      merchantName: this.config.merchantDisplayName,
    });
    return {
      providerId: provider.id,
      slotId: slot.id,
      startsAt: slot.startsAt,
      strategy,
      currency: provider.currency,
      priceAmount: provider.priceAmount,
      depositAmount: deposit,
      noShowFeeAmount: provider.policy.noShowFee,
      freeCancellationHours: provider.policy.freeCancellationHours,
      freeCancellationUntil: freeCancellationUntil(startsAt, provider.policy.freeCancellationHours).toISOString(),
      policyLines: lines,
      policyHash: hashLines(lines),
    };
  }

  // Customer actions

  /**
   * Creates a booking that holds the slot, plus the Stripe intent for the deposit:
   * a manual-capture PaymentIntent (hold), an automatic one (charge), or a SetupIntent (card_on_file).
   * The booking becomes `confirmed` when Stripe reports the payment (webhook or refresh).
   */
  async createBooking(
    userId: string,
    input: { providerId?: unknown; slotId?: unknown; policyAccepted?: unknown; policyHash?: unknown },
  ): Promise<{ booking: BookingView; paymentSheet: PaymentSheetParams }> {
    const user = this.requireUser(userId);
    if (typeof input.providerId !== 'string' || typeof input.slotId !== 'string') {
      throw badRequest('invalid_request', 'providerId and slotId are required');
    }
    if (input.policyAccepted !== true) {
      throw badRequest('policy_not_accepted', 'The customer has to accept the cancellation policy before paying.');
    }

    const quote = this.quote(input.providerId, input.slotId);
    if (input.policyHash !== quote.policyHash) {
      throw conflict('policy_changed', 'The cancellation policy changed. Show the new policy and ask again.');
    }
    const provider = this.store.getProvider(quote.providerId)!;
    if (!provider.stripeAccountId || !provider.transfersActive) {
      throw conflict('provider_not_onboarded', 'This provider has not finished setting up payouts yet.');
    }

    await this.expireStalePending(quote.slotId);
    if (this.store.listBookingsForSlot(quote.slotId, LIVE_STATUSES).length > 0) {
      throw conflict('slot_taken', 'Someone else just booked this slot.');
    }

    const customerId = await this.ensureCustomer(user);
    const nowIso = this.now().toISOString();
    const booking: Booking = {
      id: newId('bk'),
      providerId: provider.id,
      slotId: quote.slotId,
      userId: user.id,
      startsAt: quote.startsAt,
      strategy: quote.strategy,
      status: 'pending_payment',
      currency: quote.currency,
      priceAmount: quote.priceAmount,
      depositAmount: quote.depositAmount,
      noShowFeeAmount: quote.noShowFeeAmount,
      freeCancellationUntil: quote.freeCancellationUntil,
      policyLines: quote.policyLines,
      policyAcceptedAt: nowIso,
      setupIntentId: null,
      paymentMethodId: null,
      amountDue: 0,
      disputed: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    try {
      this.store.insertBooking(booking);
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) {
        throw conflict('slot_taken', 'Someone else just booked this slot.');
      }
      throw error;
    }

    try {
      const sheet: Partial<PaymentSheetParams> = {};
      const metadata = { booking_id: booking.id, provider_id: provider.id };
      const description = `${provider.serviceName} with ${provider.name}`;

      if (booking.strategy === 'card_on_file') {
        const setupIntent = await this.stripe.createSetupIntent(
          {
            customer: customerId,
            allowed_payment_method_types: ['card'],
            usage: 'off_session',
            description: `Card on file: ${description}`,
            metadata,
          },
          `booking:${booking.id}:setup`,
        );
        this.store.updateBooking(booking.id, { setupIntentId: setupIntent.id }, nowIso);
        sheet.setupIntentClientSecret = setupIntent.client_secret ?? undefined;
      } else {
        const fee = applicationFeeAmount(booking.depositAmount, this.config.platformFeePercent);
        const intent = await this.stripe.createPaymentIntent(
          {
            amount: booking.depositAmount,
            currency: booking.currency,
            customer: customerId,
            allowed_payment_method_types: ['card'],
            capture_method: booking.strategy === 'hold' ? 'manual' : 'automatic',
            // Save the card so a no-show fee can be charged later without the customer present.
            setup_future_usage: 'off_session',
            ...destinationCharge(provider, fee),
            description: `Deposit: ${description}`,
            metadata: { ...metadata, kind: 'deposit', strategy: booking.strategy },
          },
          `booking:${booking.id}:deposit`,
        );
        this.recordPayment(booking.id, 'deposit', intent, fee);
        sheet.paymentIntentClientSecret = intent.client_secret ?? undefined;
      }

      return { booking: this.view(booking.id), paymentSheet: await this.paymentSheet(customerId, sheet) };
    } catch (error) {
      this.store.updateBooking(booking.id, { status: 'expired' }, this.now().toISOString());
      throw error;
    }
  }

  listBookingsForUser(userId: string): BookingView[] {
    this.requireUser(userId);
    return this.store.listBookingsForUser(userId).map((b) => this.view(b));
  }

  getBookingForUser(userId: string, bookingId: string): BookingView {
    return this.view(this.ownBooking(userId, bookingId));
  }

  /** Pulls the latest intent state from Stripe. The app calls this right after the PaymentSheet closes. */
  async refreshForUser(userId: string, bookingId: string): Promise<BookingView> {
    const booking = this.ownBooking(userId, bookingId);
    await this.refreshIntents(booking);
    return this.view(booking.id);
  }

  /**
   * Customer cancels. Before the free-cancellation cutoff everything is released or refunded.
   * After it, the policy applies exactly like a no-show.
   */
  async cancelByCustomer(userId: string, bookingId: string): Promise<BookingView> {
    const booking = this.ownBooking(userId, bookingId);
    if (booking.status === 'pending_payment') {
      await this.releaseAll(booking, 'abandoned');
      this.setStatus(booking.id, 'canceled');
      return this.view(booking.id);
    }
    this.requireStatus(booking, ['confirmed'], 'cancel');

    if (this.now().getTime() <= new Date(booking.freeCancellationUntil).getTime()) {
      await this.releaseAll(booking, 'requested_by_customer');
      this.setStatus(booking.id, 'canceled');
    } else {
      await this.collectFee(booking);
      this.setStatus(booking.id, 'canceled_late');
    }
    return this.view(booking.id);
  }

  /**
   * After an off-session fee charge failed (declined, or the bank wants 3D Secure), the customer
   * pays the outstanding amount in the app. We create a fresh on-session PaymentIntent for it.
   */
  async createFeePaymentSheet(
    userId: string,
    bookingId: string,
  ): Promise<{ booking: BookingView; paymentSheet: PaymentSheetParams }> {
    const booking = this.ownBooking(userId, bookingId);
    if (booking.amountDue <= 0) throw conflict('nothing_due', 'Nothing is owed on this booking.');
    const provider = this.store.getProvider(booking.providerId)!;
    const customerId = await this.ensureCustomer(this.requireUser(userId));

    for (const payment of this.store.listPayments(booking.id)) {
      if (payment.kind !== 'no_show_fee') continue;
      const fresh = await this.syncPaymentIntentById(payment.paymentIntentId);
      if (fresh && CANCELABLE_PAYMENT.includes(fresh.status)) {
        await this.stripe.cancelPaymentIntent(fresh.paymentIntentId, {}, `cancel:${fresh.paymentIntentId}`);
        this.store.updatePayment(fresh.id, { status: 'canceled' }, this.now().toISOString());
      }
    }

    const amount = booking.amountDue;
    const fee = applicationFeeAmount(amount, this.config.platformFeePercent);
    const attempt = this.store.listPayments(booking.id).filter((p) => p.kind === 'no_show_fee').length;
    const intent = await this.stripe.createPaymentIntent(
      {
        amount,
        currency: booking.currency,
        customer: customerId,
        allowed_payment_method_types: ['card'],
        ...destinationCharge(provider, fee),
        description: `Outstanding fee: ${provider.serviceName} with ${provider.name}`,
        metadata: { booking_id: booking.id, provider_id: provider.id, kind: 'no_show_fee' },
      },
      `booking:${booking.id}:no_show_fee:${attempt}`,
    );
    this.recordPayment(booking.id, 'no_show_fee', intent, fee);
    const paymentSheet = await this.paymentSheet(customerId, { paymentIntentClientSecret: intent.client_secret ?? undefined });
    return { booking: this.view(booking.id), paymentSheet };
  }

  // Provider actions

  listBookingsForProvider(providerId: string): BookingView[] {
    if (!this.store.getProvider(providerId)) throw notFound('Provider');
    return this.store.listBookingsForProvider(providerId).map((b) => this.view(b));
  }

  /** The customer came. A held deposit is captured and counts toward the price. */
  async markCompleted(providerId: string, bookingId: string): Promise<BookingView> {
    const booking = this.providerBooking(providerId, bookingId);
    this.requireStatus(booking, ['confirmed'], 'complete');
    this.requireStarted(booking);

    const deposit = this.depositPayment(booking.id);
    if (deposit) {
      const fresh = await this.syncPaymentIntentById(deposit.paymentIntentId);
      if (fresh?.status === 'authorized') {
        const intent = await this.stripe.capturePaymentIntent(fresh.paymentIntentId, {}, `capture:${fresh.paymentIntentId}`);
        this.applyIntent(fresh, intent);
      }
    }
    this.setStatus(booking.id, 'completed');
    return this.view(booking.id);
  }

  /** The customer did not come. Capture or keep the deposit, then charge any extra fee off-session. */
  async markNoShow(providerId: string, bookingId: string): Promise<BookingView> {
    const booking = this.providerBooking(providerId, bookingId);
    this.requireStatus(booking, ['confirmed'], 'mark as no-show');
    this.requireStarted(booking);
    await this.collectFee(booking);
    this.setStatus(booking.id, 'no_show');
    return this.view(booking.id);
  }

  /** The provider cancels. The customer always gets everything back. */
  async cancelByProvider(providerId: string, bookingId: string): Promise<BookingView> {
    const booking = this.providerBooking(providerId, bookingId);
    this.requireStatus(booking, ['pending_payment', 'confirmed'], 'cancel');
    await this.releaseAll(booking, 'requested_by_customer');
    this.setStatus(booking.id, 'canceled_by_provider');
    return this.view(booking.id);
  }

  /**
   * Refunds money that was actually charged, newest charge first. Pulls the provider's share back
   * (reverse_transfer) and returns the platform fee (refund_application_fee).
   */
  async refund(providerId: string, bookingId: string, amount?: unknown): Promise<BookingView> {
    const booking = this.providerBooking(providerId, bookingId);
    const refundable = this.store
      .listPayments(booking.id)
      .filter((p) => p.status === 'succeeded' && p.amountCaptured > p.amountRefunded)
      .reverse();
    const total = refundable.reduce((sum, p) => sum + p.amountCaptured - p.amountRefunded, 0);
    if (total === 0) {
      throw conflict('nothing_to_refund', 'Nothing has been charged on this booking. Cancel it to release a hold.');
    }
    const requested = amount === undefined || amount === null ? total : amount;
    if (typeof requested !== 'number' || !Number.isInteger(requested) || requested <= 0 || requested > total) {
      throw badRequest('invalid_amount', `amount must be a whole number of cents between 1 and ${total}`);
    }

    let remaining = requested;
    for (const payment of refundable) {
      if (remaining === 0) break;
      const take = Math.min(remaining, payment.amountCaptured - payment.amountRefunded);
      await this.stripe.createRefund(
        {
          payment_intent: payment.paymentIntentId,
          amount: take,
          reverse_transfer: true,
          refund_application_fee: true,
          reason: 'requested_by_customer',
          metadata: { booking_id: booking.id },
        },
        `refund:${payment.id}:${payment.amountRefunded}:${take}`,
      );
      this.store.updatePayment(payment.id, { amountRefunded: payment.amountRefunded + take }, this.now().toISOString());
      remaining -= take;
    }
    return this.view(booking.id);
  }

  // Stripe state sync (webhooks and refresh)

  /** Retrieves a PaymentIntent and applies its state. Returns the updated payment, or undefined if it is not ours. */
  async syncPaymentIntentById(paymentIntentId: string): Promise<Payment | undefined> {
    const payment = this.store.getPaymentByIntent(paymentIntentId);
    if (!payment) return undefined;
    if (payment.status === 'canceled') return payment;
    const intent = await this.stripe.retrievePaymentIntent(paymentIntentId, { expand: ['latest_charge'] });
    const updated = this.applyIntent(payment, intent);

    // Paid after the booking expired (rare race): give the money back.
    const booking = this.store.getBooking(payment.bookingId)!;
    if (booking.status === 'expired' && (updated.status === 'authorized' || updated.status === 'succeeded')) {
      await this.releasePayment(updated, 'abandoned');
      return this.store.getPaymentByIntent(paymentIntentId);
    }
    return updated;
  }

  async syncSetupIntentById(setupIntentId: string): Promise<void> {
    const booking = this.store.getBookingBySetupIntent(setupIntentId);
    if (!booking) return;
    const setupIntent = await this.stripe.retrieveSetupIntent(setupIntentId);
    if (setupIntent.status === 'succeeded' && booking.status === 'pending_payment') {
      this.store.updateBooking(
        booking.id,
        { status: 'confirmed', paymentMethodId: idOf(setupIntent.payment_method) },
        this.now().toISOString(),
      );
    }
  }

  /** charge.refunded: keep the refunded total in step with Stripe (refunds made in the Dashboard too). */
  syncChargeRefunds(charge: Stripe.Charge): void {
    const paymentIntentId = idOf(charge.payment_intent);
    const payment = paymentIntentId ? this.store.getPaymentByIntent(paymentIntentId) : undefined;
    if (!payment) return;
    if (charge.amount_refunded > payment.amountRefunded) {
      this.store.updatePayment(payment.id, { amountRefunded: charge.amount_refunded }, this.now().toISOString());
    }
  }

  /** charge.dispute.created: flag the booking. With destination charges the platform pays for disputes. */
  markDisputed(dispute: Stripe.Dispute): void {
    const paymentIntentId = idOf(dispute.payment_intent);
    const payment = paymentIntentId ? this.store.getPaymentByIntent(paymentIntentId) : undefined;
    if (payment) this.store.updateBooking(payment.bookingId, { disputed: true }, this.now().toISOString());
  }

  // Internals

  private view(bookingOrId: Booking | string): BookingView {
    const booking = typeof bookingOrId === 'string' ? this.store.getBooking(bookingOrId)! : this.store.getBooking(bookingOrId.id)!;
    const provider = this.store.getProvider(booking.providerId)!;
    const payments = this.store.listPayments(booking.id);
    const sum = (list: Payment[], pick: (p: Payment) => number) => list.reduce((total, p) => total + pick(p), 0);
    return {
      ...booking,
      providerName: provider.name,
      serviceName: provider.serviceName,
      payments,
      totals: {
        held: sum(payments.filter((p) => p.status === 'authorized'), (p) => p.amount),
        collected: sum(payments.filter((p) => p.status === 'succeeded'), (p) => p.amountCaptured),
        refunded: sum(payments, (p) => p.amountRefunded),
      },
      canCancelForFree:
        booking.status === 'confirmed' && this.now().getTime() <= new Date(booking.freeCancellationUntil).getTime(),
    };
  }

  private requireUser(userId: string): User {
    const user = this.store.getUser(userId);
    if (!user) throw new AppError(401, 'unknown_user', 'Unknown user');
    return user;
  }

  private ownBooking(userId: string, bookingId: string): Booking {
    const booking = this.store.getBooking(bookingId);
    // 404 rather than 403, so ids of other people's bookings are not confirmed.
    if (!booking || booking.userId !== userId) throw notFound('Booking');
    return booking;
  }

  private providerBooking(providerId: string, bookingId: string): Booking {
    const booking = this.store.getBooking(bookingId);
    if (!booking || booking.providerId !== providerId) throw notFound('Booking');
    return booking;
  }

  private requireStatus(booking: Booking, allowed: BookingStatus[], action: string): void {
    if (!allowed.includes(booking.status)) {
      throw conflict('invalid_status', `Cannot ${action} a booking that is ${booking.status.replaceAll('_', ' ')}.`);
    }
  }

  private requireStarted(booking: Booking): void {
    if (this.config.allowEarlyOutcomes) return;
    if (this.now().getTime() < new Date(booking.startsAt).getTime()) {
      throw conflict('not_started', 'The appointment has not started yet.');
    }
  }

  private setStatus(bookingId: string, status: BookingStatus): void {
    const patch = status === 'canceled' || status === 'canceled_by_provider' ? { status, amountDue: 0 } : { status };
    this.store.updateBooking(bookingId, patch, this.now().toISOString());
  }

  private depositPayment(bookingId: string): Payment | undefined {
    return this.store.listPayments(bookingId).find((p) => p.kind === 'deposit');
  }

  private async ensureCustomer(user: User): Promise<string> {
    if (user.stripeCustomerId) return user.stripeCustomerId;
    const customer = await this.stripe.createCustomer(
      { name: user.name, email: user.email, metadata: { user_id: user.id } },
      `user:${user.id}:customer`,
    );
    this.store.setStripeCustomer(user.id, customer.id);
    return customer.id;
  }

  private async paymentSheet(customerId: string, intent: Partial<PaymentSheetParams>): Promise<PaymentSheetParams> {
    const session = await this.stripe.createCustomerSession({
      customer: customerId,
      components: {
        mobile_payment_element: {
          enabled: true,
          features: {
            payment_method_redisplay: 'enabled',
            payment_method_remove: 'enabled',
            // The card is saved because the policy says so (setup_future_usage), not via a checkbox.
            payment_method_save: 'disabled',
          },
        },
      },
    });
    return {
      ...intent,
      customerId,
      customerSessionClientSecret: session.client_secret,
      merchantDisplayName: this.config.merchantDisplayName,
      merchantCountryCode: this.config.merchantCountry,
    };
  }

  private recordPayment(
    bookingId: string,
    kind: PaymentKind,
    intent: Stripe.PaymentIntent,
    applicationFee: number,
    lastError?: string,
  ): Payment {
    const existing = this.store.getPaymentByIntent(intent.id);
    if (existing) return this.applyIntent(existing, intent, lastError);
    const nowIso = this.now().toISOString();
    const payment: Payment = {
      id: newId('pay'),
      bookingId,
      kind,
      paymentIntentId: intent.id,
      amount: intent.amount,
      amountCaptured: 0,
      amountRefunded: 0,
      applicationFeeAmount: applicationFee,
      status: 'pending',
      captureBefore: null,
      lastError: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.store.insertPayment(payment);
    return this.applyIntent(payment, intent, lastError);
  }

  /** Writes a PaymentIntent's state to our payment row and moves the booking along. Database only. */
  private applyIntent(payment: Payment, intent: Stripe.PaymentIntent, lastError?: string): Payment {
    const nowIso = this.now().toISOString();
    const status = paymentStatusFromIntent(intent);
    const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
    const captureBefore = charge?.payment_method_details?.card?.capture_before;
    this.store.updatePayment(
      payment.id,
      {
        status,
        amountCaptured: intent.amount_received,
        captureBefore: captureBefore ? new Date(captureBefore * 1000).toISOString() : payment.captureBefore,
        lastError: lastError ?? intent.last_payment_error?.message ?? null,
      },
      nowIso,
    );

    const booking = this.store.getBooking(payment.bookingId)!;
    if (payment.kind === 'deposit' && booking.status === 'pending_payment' && (status === 'authorized' || status === 'succeeded')) {
      this.store.updateBooking(booking.id, { status: 'confirmed', paymentMethodId: idOf(intent.payment_method) }, nowIso);
    }
    if (payment.kind === 'no_show_fee' && status === 'succeeded' && payment.status !== 'succeeded' && booking.amountDue > 0) {
      this.store.updateBooking(booking.id, { amountDue: Math.max(booking.amountDue - intent.amount_received, 0) }, nowIso);
    }
    return this.store.getPaymentByIntent(intent.id)!;
  }

  private async refreshIntents(booking: Booking): Promise<void> {
    for (const payment of this.store.listPayments(booking.id)) {
      if (payment.status !== 'succeeded') await this.syncPaymentIntentById(payment.paymentIntentId);
    }
    if (booking.setupIntentId) await this.syncSetupIntentById(booking.setupIntentId);
  }

  /** Unpaid bookings stop holding the slot after the payment window. Release their intents first. */
  private async expireStalePending(slotId: string): Promise<void> {
    const cutoff = new Date(this.now().getTime() - this.config.paymentWindowMinutes * 60_000).toISOString();
    const stale = this.store.listBookingsForSlot(slotId, ['pending_payment']).filter((b) => b.createdAt < cutoff);
    for (const booking of stale) {
      await this.refreshIntents(booking); // the customer may have paid after all
      const current = this.store.getBooking(booking.id)!;
      if (current.status !== 'pending_payment') continue;
      await this.releaseAll(current, 'abandoned');
      this.setStatus(current.id, 'expired');
    }
  }

  /** Cancels every open intent and refunds every charge on the booking. */
  private async releaseAll(booking: Booking, reason: 'abandoned' | 'requested_by_customer'): Promise<void> {
    for (const payment of this.store.listPayments(booking.id)) {
      const fresh = payment.status === 'succeeded' ? payment : await this.syncPaymentIntentById(payment.paymentIntentId);
      if (fresh) await this.releasePayment(fresh, reason);
    }
    if (booking.setupIntentId && booking.status === 'pending_payment') {
      const setupIntent = await this.stripe.retrieveSetupIntent(booking.setupIntentId);
      if (setupIntent.status !== 'succeeded' && setupIntent.status !== 'canceled') {
        await this.stripe.cancelSetupIntent(booking.setupIntentId);
      }
    }
  }

  private async releasePayment(payment: Payment, reason: 'abandoned' | 'requested_by_customer'): Promise<void> {
    const nowIso = this.now().toISOString();
    if (CANCELABLE_PAYMENT.includes(payment.status)) {
      await this.stripe.cancelPaymentIntent(
        payment.paymentIntentId,
        { cancellation_reason: reason },
        `cancel:${payment.paymentIntentId}`,
      );
      this.store.updatePayment(payment.id, { status: 'canceled' }, nowIso);
      return;
    }
    const refundable = payment.amountCaptured - payment.amountRefunded;
    if (payment.status === 'succeeded' && refundable > 0) {
      await this.stripe.createRefund(
        {
          payment_intent: payment.paymentIntentId,
          amount: refundable,
          reverse_transfer: true,
          refund_application_fee: true,
          reason: 'requested_by_customer',
          metadata: { booking_id: payment.bookingId },
        },
        `refund:${payment.id}:${payment.amountRefunded}:${refundable}`,
      );
      this.store.updatePayment(payment.id, { amountRefunded: payment.amountRefunded + refundable }, nowIso);
    }
  }

  /**
   * Applies the no-show / late-cancellation policy:
   * 1. a held deposit is captured, a charged deposit is kept;
   * 2. whatever the policy says is still owed is charged off-session to the saved card.
   * If the hold already expired, the whole amount goes through step 2.
   */
  private async collectFee(booking: Booking): Promise<void> {
    let collected = 0;
    const deposit = this.depositPayment(booking.id);
    if (deposit) {
      const fresh = deposit.status === 'succeeded' ? deposit : await this.syncPaymentIntentById(deposit.paymentIntentId);
      if (fresh?.status === 'authorized') {
        const intent = await this.stripe.capturePaymentIntent(fresh.paymentIntentId, {}, `capture:${fresh.paymentIntentId}`);
        collected += this.applyIntent(fresh, intent).amountCaptured;
      } else if (fresh?.status === 'succeeded') {
        collected += fresh.amountCaptured - fresh.amountRefunded;
      }
    }

    const remainder = noShowRemainder(booking.depositAmount, booking.noShowFeeAmount, collected);
    if (remainder >= MIN_CHARGE_AMOUNT) await this.chargeOffSession(booking, remainder);
  }

  /**
   * Merchant-initiated charge on the saved card. This can fail: the card may be declined, or the
   * bank may ask for authentication (code `authentication_required`). Then the amount is recorded
   * as owed and the customer can pay it in the app.
   */
  private async chargeOffSession(booking: Booking, amount: number): Promise<void> {
    const nowIso = this.now().toISOString();
    const provider = this.store.getProvider(booking.providerId)!;
    const customerId = this.store.getUser(booking.userId)?.stripeCustomerId;
    const current = this.store.getBooking(booking.id)!;
    if (!current.paymentMethodId || !customerId) {
      this.store.updateBooking(booking.id, { amountDue: amount }, nowIso);
      return;
    }

    const fee = applicationFeeAmount(amount, this.config.platformFeePercent);
    const attempt = this.store.listPayments(booking.id).filter((p) => p.kind === 'no_show_fee').length;
    try {
      const intent = await this.stripe.createPaymentIntent(
        {
          amount,
          currency: booking.currency,
          customer: customerId,
          payment_method: current.paymentMethodId,
          off_session: true,
          confirm: true,
          allowed_payment_method_types: ['card'],
          ...destinationCharge(provider, fee),
          description: `No-show or late cancellation fee: ${provider.serviceName} with ${provider.name}`,
          metadata: { booking_id: booking.id, provider_id: provider.id, kind: 'no_show_fee' },
        },
        `booking:${booking.id}:no_show_fee:${attempt}`,
      );
      const payment = this.recordPayment(booking.id, 'no_show_fee', intent, fee);
      if (payment.status !== 'succeeded' && payment.status !== 'processing') {
        this.store.updateBooking(booking.id, { amountDue: amount }, nowIso);
      }
    } catch (error) {
      if (!isCardError(error)) throw error;
      if (error.payment_intent) this.recordPayment(booking.id, 'no_show_fee', error.payment_intent, fee, error.message);
      this.store.updateBooking(booking.id, { amountDue: amount }, nowIso);
    }
  }
}

/**
 * Destination charge: the platform is the merchant of record, the provider's connected account
 * receives the amount minus the platform fee. https://docs.stripe.com/connect/destination-charges
 */
function destinationCharge(provider: Provider, fee: number): Pick<Stripe.PaymentIntentCreateParams, 'transfer_data' | 'application_fee_amount'> {
  return {
    transfer_data: { destination: provider.stripeAccountId! },
    ...(fee > 0 ? { application_fee_amount: fee } : {}),
  };
}
