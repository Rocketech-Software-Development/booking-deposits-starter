import type { Config } from '../src/config.js';
import { buildContainer } from '../src/container.js';
import { Store } from '../src/db.js';
import { DEMO_USER_ID, seedDemoData } from '../src/seed-data.js';
import { FakeStripe } from './fake-stripe.js';

export const WEBHOOK_SECRET = 'whsec_test_platform';
export const CONNECT_WEBHOOK_SECRET = 'whsec_test_connect';
export const T0 = new Date('2030-03-04T09:30:00.000Z');
export const HOUR = 3_600_000;

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 4242,
    publicUrl: 'http://localhost:4242',
    stripeSecretKey: 'sk_test_placeholder',
    stripePublishableKey: 'pk_test_placeholder',
    stripeWebhookSecret: WEBHOOK_SECRET,
    stripeConnectWebhookSecret: CONNECT_WEBHOOK_SECRET,
    merchantDisplayName: 'Test Bookings',
    merchantCountry: 'US',
    currency: 'usd',
    platformFeePercent: 10,
    holdWindowHours: 144,
    paymentWindowMinutes: 15,
    allowEarlyOutcomes: false,
    databasePath: ':memory:',
    ...overrides,
  };
}

/** A seeded in-memory backend with a controllable clock and a fake Stripe. */
export function setup(overrides: Partial<Config> = {}) {
  const clock = { now: new Date(T0) };
  const stripe = new FakeStripe();
  const store = new Store(':memory:');
  seedDemoData(store, T0);
  const container = buildContainer({ config: testConfig(overrides), stripe, store, now: () => clock.now });

  // Every demo provider has finished Connect onboarding unless a test says otherwise.
  for (const provider of store.listProviders()) {
    store.updateProviderConnect(provider.id, {
      stripeAccountId: `acct_${provider.id}`,
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      transfersActive: true,
    });
  }

  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };

  /** Books the slot `offsetHours` from T0 at a provider, accepting the quoted policy. */
  const book = async (providerId: string, offsetHours: number, userId = DEMO_USER_ID) => {
    const slotId = `${providerId}_slot_${offsetHours}`;
    const quote = container.bookings.quote(providerId, slotId);
    return container.bookings.createBooking(userId, { providerId, slotId, policyAccepted: true, policyHash: quote.policyHash });
  };

  /** Books and simulates the customer completing the PaymentSheet, then a refresh. */
  const bookAndPay = async (providerId: string, offsetHours: number) => {
    const { booking } = await book(providerId, offsetHours);
    const deposit = booking.payments[0];
    if (deposit) stripe.customerPays(deposit.paymentIntentId);
    if (booking.setupIntentId) stripe.customerSavesCard(booking.setupIntentId);
    return container.bookings.refreshForUser(DEMO_USER_ID, booking.id);
  };

  return { ...container, stripe, clock, advance, book, bookAndPay, config: testConfig(overrides) };
}

export { DEMO_USER_ID };

/** Response bodies in tests are loosely typed on purpose. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJson(response: Response | Promise<Response>): Promise<any> {
  return (await response).json();
}
