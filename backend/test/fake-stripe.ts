import Stripe from 'stripe';
import { vi } from 'vitest';
import { toThinEvent, type StripePort } from '../src/stripe/port.js';

/**
 * In-memory stand-in for the Stripe API. It keeps PaymentIntents, SetupIntents and accounts
 * in maps and moves them through the same statuses Stripe would. No network calls.
 */
export class FakeStripe implements StripePort {
  readonly intents = new Map<string, Stripe.PaymentIntent>();
  readonly setupIntents = new Map<string, Stripe.SetupIntent>();
  readonly accounts = new Map<string, Stripe.V2.Core.Account>();
  readonly refunds: Stripe.RefundCreateParams[] = [];
  /** The next off-session charge fails with this card error code. */
  failNextOffSession: string | null = null;
  /** Capture-before timestamp (unix seconds) reported for authorized holds. */
  captureBefore = 1_900_000_000;

  private counter = 0;
  private readonly webhookSigner = new Stripe('sk_test_fake_key_for_signatures');

  private nextId(prefix: string) {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  createCustomer = vi.fn(async (params: Stripe.CustomerCreateParams, _key: string) => {
    return { id: this.nextId('cus'), object: 'customer', email: params.email ?? null } as unknown as Stripe.Customer;
  });

  createCustomerSession = vi.fn(async (params: Stripe.CustomerSessionCreateParams) => {
    return { object: 'customer_session', customer: params.customer, client_secret: 'cuss_secret_test' } as unknown as Stripe.CustomerSession;
  });

  createPaymentIntent = vi.fn(async (params: Stripe.PaymentIntentCreateParams, _key: string) => {
    const id = this.nextId('pi');
    const intent = {
      id,
      object: 'payment_intent',
      amount: params.amount,
      amount_received: 0,
      amount_capturable: 0,
      currency: params.currency,
      capture_method: params.capture_method ?? 'automatic',
      customer: params.customer ?? null,
      payment_method: params.payment_method ?? null,
      status: 'requires_payment_method',
      client_secret: `${id}_secret_test`,
      last_payment_error: null,
      latest_charge: null,
      metadata: params.metadata ?? {},
    } as unknown as Stripe.PaymentIntent;

    if (params.off_session && params.confirm) {
      const code = this.failNextOffSession;
      if (code) {
        this.failNextOffSession = null;
        const failed = {
          ...intent,
          status: 'requires_payment_method',
          last_payment_error: { code, message: 'Your card was declined.' },
        } as unknown as Stripe.PaymentIntent;
        this.intents.set(id, failed);
        throw new Stripe.errors.StripeCardError({
          type: 'card_error',
          code,
          message: 'This payment needs the customer to authenticate.',
          payment_intent: failed,
        });
      }
      Object.assign(intent, { status: 'succeeded', amount_received: params.amount });
    }
    this.intents.set(id, intent);
    return { ...intent };
  });

  retrievePaymentIntent = vi.fn(async (id: string, _params?: Stripe.PaymentIntentRetrieveParams) => {
    const intent = this.requireIntent(id);
    const charge =
      intent.status === 'requires_capture'
        ? { id: `ch_${id}`, payment_method_details: { card: { capture_before: this.captureBefore } } }
        : null;
    return { ...intent, latest_charge: charge } as unknown as Stripe.PaymentIntent;
  });

  capturePaymentIntent = vi.fn(async (id: string, params: Stripe.PaymentIntentCaptureParams, _key: string) => {
    const intent = this.requireIntent(id);
    if (intent.status !== 'requires_capture') {
      throw new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: `Cannot capture ${intent.status}` });
    }
    const amount = params.amount_to_capture ?? intent.amount;
    Object.assign(intent, { status: 'succeeded', amount_received: amount, amount_capturable: 0 });
    return { ...intent };
  });

  cancelPaymentIntent = vi.fn(async (id: string, _params: Stripe.PaymentIntentCancelParams, _key: string) => {
    const intent = this.requireIntent(id);
    if (intent.status === 'succeeded' || intent.status === 'canceled') {
      throw new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: `Cannot cancel ${intent.status}` });
    }
    Object.assign(intent, { status: 'canceled', amount_capturable: 0 });
    return { ...intent };
  });

  createSetupIntent = vi.fn(async (params: Stripe.SetupIntentCreateParams, _key: string) => {
    const id = this.nextId('seti');
    const setupIntent = {
      id,
      object: 'setup_intent',
      customer: params.customer ?? null,
      status: 'requires_payment_method',
      payment_method: null,
      client_secret: `${id}_secret_test`,
      usage: params.usage,
    } as unknown as Stripe.SetupIntent;
    this.setupIntents.set(id, setupIntent);
    return { ...setupIntent };
  });

  retrieveSetupIntent = vi.fn(async (id: string) => ({ ...this.requireSetupIntent(id) }));

  cancelSetupIntent = vi.fn(async (id: string) => {
    const setupIntent = this.requireSetupIntent(id);
    Object.assign(setupIntent, { status: 'canceled' });
    return { ...setupIntent };
  });

  createRefund = vi.fn(async (params: Stripe.RefundCreateParams, _key: string) => {
    this.refunds.push(params);
    return { id: this.nextId('re'), object: 'refund', amount: params.amount, status: 'succeeded' } as unknown as Stripe.Refund;
  });

  createAccount = vi.fn(async (params: Stripe.V2.Core.AccountCreateParams, _key: string) => {
    const account = {
      id: this.nextId('acct'),
      object: 'v2.core.account',
      applied_configurations: ['recipient'],
      dashboard: params.dashboard,
      display_name: params.display_name,
      defaults: { responsibilities: params.defaults?.responsibilities },
      configuration: {
        recipient: {
          applied: true,
          capabilities: {
            stripe_balance: {
              stripe_transfers: { status: 'pending', status_details: [] },
              payouts: { status: 'pending', status_details: [] },
            },
          },
        },
      },
      requirements: {
        entries: [
          {
            awaiting_action_from: 'user',
            description: 'Provide bank account details',
            errors: [],
            impact: {},
            minimum_deadline: { status: 'currently_due' },
            requested_reasons: [],
          },
        ],
      },
      metadata: params.metadata ?? {},
      livemode: false,
      created: '2030-03-04T09:30:00.000Z',
    } as unknown as Stripe.V2.Core.Account;
    this.accounts.set(account.id, account);
    return structuredClone(account);
  });

  retrieveAccount = vi.fn(async (id: string) => {
    const account = this.accounts.get(id);
    if (!account) throw new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: 'No such account' });
    return structuredClone(account);
  });

  createAccountLink = vi.fn(async (params: Stripe.V2.Core.AccountLinkCreateParams) => {
    return {
      object: 'v2.core.account_link',
      account: params.account,
      url: `https://connect.stripe.com/setup/e/${params.account}/test`,
      expires_at: '2030-03-04T09:35:00.000Z',
    } as unknown as Stripe.V2.Core.AccountLink;
  });

  createLoginLink = vi.fn(async (accountId: string) => {
    return { object: 'login_link', url: `https://connect.stripe.com/express/${accountId}/test` } as unknown as Stripe.LoginLink;
  });

  /** Real signature verification, using the SDK's own code. */
  constructEvent = (payload: string, signature: string, secret: string) =>
    this.webhookSigner.webhooks.constructEvent(payload, signature, secret);

  /** Real thin-event parsing and signature verification, using the SDK's own code. */
  parseThinEvent = (payload: string, signature: string, secret: string) =>
    toThinEvent(this.webhookSigner.parseEventNotification(payload, signature, secret));

  // Test helpers: what the customer or Stripe would do.

  /** The customer completes the PaymentSheet. */
  customerPays(id: string, paymentMethod = 'pm_card_visa') {
    const intent = this.requireIntent(id);
    const manual = intent.capture_method === 'manual';
    Object.assign(intent, {
      payment_method: paymentMethod,
      status: manual ? 'requires_capture' : 'succeeded',
      amount_capturable: manual ? intent.amount : 0,
      amount_received: manual ? 0 : intent.amount,
    });
  }

  customerSavesCard(id: string, paymentMethod = 'pm_card_visa') {
    Object.assign(this.requireSetupIntent(id), { status: 'succeeded', payment_method: paymentMethod });
  }

  /** The authorization ran out before capture. Stripe cancels the PaymentIntent. */
  expireHold(id: string) {
    Object.assign(this.requireIntent(id), { status: 'canceled', amount_capturable: 0 });
  }

  /** The provider completes Stripe's hosted onboarding and Stripe activates the recipient capabilities. */
  finishOnboarding(accountId: string) {
    const account = this.accounts.get(accountId)!;
    Object.assign(account, {
      configuration: {
        recipient: {
          applied: true,
          capabilities: {
            stripe_balance: {
              stripe_transfers: { status: 'active', status_details: [] },
              payouts: { status: 'active', status_details: [] },
            },
          },
        },
      },
      requirements: { entries: [] },
    });
  }

  signedHeader(payload: string, secret: string) {
    return this.webhookSigner.webhooks.generateTestHeaderString({ payload, secret });
  }

  private requireIntent(id: string) {
    const intent = this.intents.get(id);
    if (!intent) throw new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: `No such payment_intent ${id}` });
    return intent;
  }

  private requireSetupIntent(id: string) {
    const setupIntent = this.setupIntents.get(id);
    if (!setupIntent) throw new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message: `No such setup_intent ${id}` });
    return setupIntent;
  }
}
