import type Stripe from 'stripe';
import type { Store } from '../db.js';
import { badRequest } from '../errors.js';
import { idOf, type StripePort, type ThinEvent } from '../stripe/port.js';
import type { BookingService } from './bookings.js';
import type { ConnectService } from './connect.js';

export type WebhookResult = 'processed' | 'duplicate' | 'ignored';

/**
 * Stripe webhook handling.
 * - Verifies the signature against the raw body.
 * - Skips event ids it has already processed (Stripe can deliver an event more than once).
 * - Re-reads the object from the API instead of trusting the payload, because events can
 *   arrive out of order. Every handler is safe to run twice.
 */
export class WebhookService {
  constructor(
    private readonly deps: {
      store: Store;
      stripe: StripePort;
      bookings: BookingService;
      connect: ConnectService;
      now?: () => Date;
    },
  ) {}

  verify(payload: string, signature: string | undefined, secret: string): Stripe.Event {
    if (!signature) throw badRequest('missing_signature', 'Missing Stripe-Signature header');
    try {
      return this.deps.stripe.constructEvent(payload, signature, secret);
    } catch {
      throw badRequest('invalid_signature', 'Webhook signature verification failed');
    }
  }

  verifyThin(payload: string, signature: string | undefined, secret: string): ThinEvent {
    if (!signature) throw badRequest('missing_signature', 'Missing Stripe-Signature header');
    try {
      return this.deps.stripe.parseThinEvent(payload, signature, secret);
    } catch {
      throw badRequest('invalid_signature', 'Webhook signature verification failed');
    }
  }

  /**
   * Thin events from Accounts v2, e.g. `v2.core.account[requirements].updated` or
   * `v2.core.account[configuration.recipient].capability_status_updated`. They only carry the
   * account id, so we read the account and store its state.
   */
  async handleThin(event: ThinEvent): Promise<WebhookResult> {
    const { store, connect } = this.deps;
    if (store.hasProcessedEvent(event.id)) return 'duplicate';
    let handled = false;
    if (event.type.startsWith('v2.core.account') && !event.type.startsWith('v2.core.account_link') && event.relatedObjectId) {
      handled = await connect.syncAccount(event.relatedObjectId);
    }
    store.recordEvent(event.id, event.type, (this.deps.now?.() ?? new Date()).toISOString());
    return handled ? 'processed' : 'ignored';
  }

  async handle(event: Stripe.Event): Promise<WebhookResult> {
    const { store, bookings, connect } = this.deps;
    if (store.hasProcessedEvent(event.id)) return 'duplicate';

    let handled = true;
    switch (event.type) {
      case 'payment_intent.amount_capturable_updated': // hold authorized
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': // includes holds that expired before capture
      case 'payment_intent.processing':
      case 'payment_intent.requires_action':
        handled = (await bookings.syncPaymentIntentById(event.data.object.id)) !== undefined;
        break;
      case 'setup_intent.succeeded':
      case 'setup_intent.setup_failed':
        await bookings.syncSetupIntentById(event.data.object.id);
        break;
      case 'charge.refunded':
        bookings.syncChargeRefunds(event.data.object);
        break;
      case 'charge.dispute.created':
        bookings.markDisputed(event.data.object);
        break;
      case 'account.updated': // Stripe also sends this v1 event for v2 accounts (Connect scope)
        handled = await connect.syncAccount(idOf(event.data.object) ?? event.account ?? '');
        break;
      default:
        handled = false;
    }

    store.recordEvent(event.id, event.type, (this.deps.now?.() ?? new Date()).toISOString());
    return handled ? 'processed' : 'ignored';
  }
}
