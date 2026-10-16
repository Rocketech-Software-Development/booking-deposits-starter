import Stripe from 'stripe';

/**
 * The slice of the Stripe API this backend uses. Services depend on this interface, not on the
 * SDK, so tests can swap in a fake and you can see every Stripe call the starter makes in one place.
 */
export interface StripePort {
  createCustomer(params: Stripe.CustomerCreateParams, idempotencyKey: string): Promise<Stripe.Customer>;
  createCustomerSession(params: Stripe.CustomerSessionCreateParams): Promise<Stripe.CustomerSession>;

  createPaymentIntent(params: Stripe.PaymentIntentCreateParams, idempotencyKey: string): Promise<Stripe.PaymentIntent>;
  retrievePaymentIntent(id: string, params?: Stripe.PaymentIntentRetrieveParams): Promise<Stripe.PaymentIntent>;
  capturePaymentIntent(
    id: string,
    params: Stripe.PaymentIntentCaptureParams,
    idempotencyKey: string,
  ): Promise<Stripe.PaymentIntent>;
  cancelPaymentIntent(
    id: string,
    params: Stripe.PaymentIntentCancelParams,
    idempotencyKey: string,
  ): Promise<Stripe.PaymentIntent>;

  createSetupIntent(params: Stripe.SetupIntentCreateParams, idempotencyKey: string): Promise<Stripe.SetupIntent>;
  retrieveSetupIntent(id: string): Promise<Stripe.SetupIntent>;
  cancelSetupIntent(id: string): Promise<Stripe.SetupIntent>;

  createRefund(params: Stripe.RefundCreateParams, idempotencyKey: string): Promise<Stripe.Refund>;

  // Connect, Accounts v2: https://docs.stripe.com/connect/accounts-v2
  createAccount(params: Stripe.V2.Core.AccountCreateParams, idempotencyKey: string): Promise<Stripe.V2.Core.Account>;
  retrieveAccount(id: string): Promise<Stripe.V2.Core.Account>;
  createAccountLink(params: Stripe.V2.Core.AccountLinkCreateParams): Promise<Stripe.V2.Core.AccountLink>;
  /** Express Dashboard login link. A v1 endpoint, which accepts v2 account ids. */
  createLoginLink(accountId: string): Promise<Stripe.LoginLink>;

  /** Snapshot events (payments, refunds, disputes, v1 account.updated). */
  constructEvent(payload: string, signature: string, secret: string): Stripe.Event;
  /** Thin events (v2.core.account[...] updates). Only the fields this backend uses. */
  parseThinEvent(payload: string, signature: string, secret: string): ThinEvent;
}

export interface ThinEvent {
  id: string;
  type: string;
  relatedObjectId: string | null;
}

/** Fields we need from a v2 Account. Without `include`, v2 returns null for these. */
export const ACCOUNT_INCLUDE: Stripe.V2.Core.AccountRetrieveParams['include'] = ['configuration.recipient', 'requirements'];

export function createStripePort(stripe: Stripe): StripePort {
  return {
    createCustomer: (params, idempotencyKey) => stripe.customers.create(params, { idempotencyKey }),
    createCustomerSession: (params) => stripe.customerSessions.create(params),

    createPaymentIntent: (params, idempotencyKey) => stripe.paymentIntents.create(params, { idempotencyKey }),
    retrievePaymentIntent: (id, params) => stripe.paymentIntents.retrieve(id, params),
    capturePaymentIntent: (id, params, idempotencyKey) => stripe.paymentIntents.capture(id, params, { idempotencyKey }),
    cancelPaymentIntent: (id, params, idempotencyKey) => stripe.paymentIntents.cancel(id, params, { idempotencyKey }),

    createSetupIntent: (params, idempotencyKey) => stripe.setupIntents.create(params, { idempotencyKey }),
    retrieveSetupIntent: (id) => stripe.setupIntents.retrieve(id),
    cancelSetupIntent: (id) => stripe.setupIntents.cancel(id),

    createRefund: (params, idempotencyKey) => stripe.refunds.create(params, { idempotencyKey }),

    createAccount: (params, idempotencyKey) => stripe.v2.core.accounts.create(params, { idempotencyKey }),
    retrieveAccount: (id) => stripe.v2.core.accounts.retrieve(id, { include: ACCOUNT_INCLUDE }),
    createAccountLink: (params) => stripe.v2.core.accountLinks.create(params),
    createLoginLink: (accountId) => stripe.accounts.createLoginLink(accountId),

    constructEvent: (payload, signature, secret) => stripe.webhooks.constructEvent(payload, signature, secret),
    parseThinEvent: (payload, signature, secret) => toThinEvent(stripe.parseEventNotification(payload, signature, secret)),
  };
}

export function toThinEvent(notification: Stripe.V2.Core.EventNotification): ThinEvent {
  // Some event types point at singleton objects without an id; we only need account events.
  const related = ('related_object' in notification ? notification.related_object : null) as { id?: string } | null;
  return { id: notification.id, type: notification.type, relatedObjectId: related?.id ?? null };
}

/** Card declines and `authentication_required` come back as StripeCardError. */
export function isCardError(error: unknown): error is InstanceType<typeof Stripe.errors.StripeCardError> {
  return error instanceof Stripe.errors.StripeCardError;
}

export function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}
