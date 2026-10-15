import { serve } from '@hono/node-server';
import Stripe from 'stripe';
import { loadConfig, loadDotEnv } from './config.js';
import { buildContainer } from './container.js';
import { createStripePort } from './stripe/port.js';

loadDotEnv();
const config = loadConfig();

// No apiVersion: the SDK pins the API version it was generated for.
const stripe = new Stripe(config.stripeSecretKey, {
  appInfo: { name: 'stripe-booking-deposits', version: '0.1.0' },
});

const { app, store } = buildContainer({ config, stripe: createStripePort(stripe) });

if (store.listProviders().length === 0) {
  console.warn('No providers yet. Run `npm run seed` to load demo data.');
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Booking deposits API on http://localhost:${info.port}`);
  console.log(`Forward webhooks with: stripe listen --forward-to localhost:${info.port}/webhooks/stripe \\`);
  console.log(`  --forward-connect-to localhost:${info.port}/webhooks/stripe-connect`);
});
