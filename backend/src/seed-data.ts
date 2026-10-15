import type { Store } from './db.js';
import type { Provider } from './domain/types.js';

export const DEMO_USER_ID = 'user_demo';

type ProviderSeed = Omit<
  Provider,
  'stripeAccountId' | 'chargesEnabled' | 'payoutsEnabled' | 'detailsSubmitted' | 'transfersActive'
>;

/** One provider per deposit strategy, so every flow can be tried from the app. */
export const DEMO_PROVIDERS: ProviderSeed[] = [
  {
    id: 'prov_hair',
    name: 'Northside Hair Studio',
    category: 'Hair salon',
    description: 'Cuts and color in a two-chair studio.',
    serviceName: 'Cut and color',
    priceAmount: 12000,
    durationMinutes: 90,
    currency: 'usd',
    // Hold the deposit if the appointment is within the hold window, charge it otherwise.
    policy: { strategy: 'auto', deposit: { type: 'percent', percent: 25 }, freeCancellationHours: 24, noShowFee: 6000 },
  },
  {
    id: 'prov_massage',
    name: 'Calm Hands Massage',
    category: 'Massage',
    description: 'Deep tissue and relaxation massage.',
    serviceName: '60-minute massage',
    priceAmount: 9000,
    durationMinutes: 60,
    currency: 'usd',
    // Charge a fixed deposit now. A no-show just loses the deposit.
    policy: { strategy: 'charge', deposit: { type: 'fixed', amount: 2000 }, freeCancellationHours: 48, noShowFee: 0 },
  },
  {
    id: 'prov_trainer',
    name: 'Peak Form Training',
    category: 'Personal training',
    description: 'One-to-one strength sessions.',
    serviceName: '1:1 training session',
    priceAmount: 7000,
    durationMinutes: 60,
    currency: 'usd',
    // Nothing up front. Card saved, fee charged only on a no-show or late cancellation.
    policy: {
      strategy: 'card_on_file',
      deposit: { type: 'fixed', amount: 0 },
      freeCancellationHours: 12,
      noShowFee: 3500,
    },
  },
];

/** Hours from now. A few slots fall inside the free-cancellation window so late cancels can be tried. */
const SLOT_OFFSETS_HOURS = [3, 6, 27, 51, 75, 123, 171, 219, 315];

export function seedDemoData(store: Store, now = new Date()): { providers: number; slots: number } {
  const nextHour = new Date(now);
  nextHour.setUTCMinutes(0, 0, 0);

  return store.transaction(() => {
    store.clearBookingsAndSlots();
    store.upsertUser({ id: DEMO_USER_ID, name: 'Demo Customer', email: 'demo.customer@example.com', stripeCustomerId: null });

    let slots = 0;
    for (const seed of DEMO_PROVIDERS) {
      const existing = store.getProvider(seed.id);
      store.upsertProvider({
        ...seed,
        // Keep Connect onboarding across re-seeds.
        stripeAccountId: existing?.stripeAccountId ?? null,
        chargesEnabled: existing?.chargesEnabled ?? false,
        payoutsEnabled: existing?.payoutsEnabled ?? false,
        detailsSubmitted: existing?.detailsSubmitted ?? false,
        transfersActive: existing?.transfersActive ?? false,
      });
      for (const offset of SLOT_OFFSETS_HOURS) {
        const startsAt = new Date(nextHour.getTime() + offset * 3_600_000);
        store.insertSlot({ id: `${seed.id}_slot_${offset}`, providerId: seed.id, startsAt: startsAt.toISOString() });
        slots += 1;
      }
    }
    return { providers: DEMO_PROVIDERS.length, slots };
  });
}
