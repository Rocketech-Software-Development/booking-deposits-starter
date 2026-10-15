import type { Config } from './config.js';
import { Store } from './db.js';
import { createApp } from './http/app.js';
import { BookingService } from './services/bookings.js';
import { ConnectService } from './services/connect.js';
import { WebhookService } from './services/webhooks.js';
import type { StripePort } from './stripe/port.js';

/** Wires the services together. Used by the server and by the tests. */
export function buildContainer(options: { config: Config; stripe: StripePort; store?: Store; now?: () => Date }) {
  const { config, stripe, now } = options;
  const store = options.store ?? new Store(config.databasePath);
  const bookings = new BookingService({ store, stripe, config, now });
  const connect = new ConnectService({ store, stripe, config });
  const webhooks = new WebhookService({ store, stripe, bookings, connect, now });
  const app = createApp({ config, bookings, connect, webhooks });
  return { store, bookings, connect, webhooks, app };
}
