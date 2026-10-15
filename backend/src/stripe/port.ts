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

  createAccount(params: Stripe.AccountCreateParams, idempotencyKey: string): Promise<Stripe.Account>;
  retrieveAccount(id: string): Promise<Stripe.Account>;
  createAccountLink(params: Stripe.AccountLinkCreateParams): Promise<Stripe.AccountLink>;
  createLoginLink(accountId: string): Promise<Stripe.LoginLink>;

  constructEvent(payload: string, signature: string, secret: string): Stripe.Event;
}

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

    createAccount: (params, idempotencyKey) => stripe.accounts.create(params, { idempotencyKey }),
    retrieveAccount: (id) => stripe.accounts.retrieve(id),
    createAccountLink: (params) => stripe.accountLinks.create(params),
    createLoginLink: (accountId) => stripe.accounts.createLoginLink(accountId),

    constructEvent: (payload, signature, secret) => stripe.webhooks.constructEvent(payload, signature, secret),
  };
}

/** Card declines and `authentication_required` come back as StripeCardError. */
export function isCardError(error: unknown): error is InstanceType<typeof Stripe.errors.StripeCardError> {
  return error instanceof Stripe.errors.StripeCardError;
}

export function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}
