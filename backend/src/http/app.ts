import { Hono, type Context } from 'hono';
import Stripe from 'stripe';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import type { BookingService } from '../services/bookings.js';
import type { ConnectService } from '../services/connect.js';
import type { WebhookService } from '../services/webhooks.js';

export interface AppDeps {
  config: Config;
  bookings: BookingService;
  connect: ConnectService;
  webhooks: WebhookService;
}

/**
 * DEMO AUTH. The app sends `x-demo-user` (customer) or `x-demo-provider` (provider) headers.
 * Anyone can set these. Replace `customerId` and `providerId` with your real session lookup
 * before this goes anywhere near production.
 */
function customerId(c: Context): string {
  const id = c.req.header('x-demo-user');
  if (!id) throw new AppError(401, 'unauthenticated', 'Missing x-demo-user header');
  return id;
}

function providerId(c: Context, expected: string): string {
  const id = c.req.header('x-demo-provider');
  if (!id) throw new AppError(401, 'unauthenticated', 'Missing x-demo-provider header');
  if (id !== expected) throw new AppError(403, 'forbidden', 'You can only manage your own bookings');
  return id;
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => ({}));
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

export function createApp({ config, bookings, connect, webhooks }: AppDeps): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof Stripe.errors.StripeError) {
      console.error('Stripe error', error.type, error.code, error.message);
      return c.json({ error: { code: error.code ?? 'stripe_error', message: error.message } }, 502);
    }
    console.error(error);
    return c.json({ error: { code: 'internal_error', message: 'Something went wrong' } }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  /** The app reads the publishable key from here, so it lives in one place (backend/.env). */
  app.get('/config', (c) =>
    c.json({
      publishableKey: config.stripePublishableKey,
      merchantDisplayName: config.merchantDisplayName,
      merchantCountryCode: config.merchantCountry,
      currency: config.currency,
    }),
  );

  // Catalog

  app.get('/providers', (c) => c.json({ providers: bookings.listProviders() }));
  app.get('/providers/:id', (c) => c.json({ provider: bookings.getProvider(c.req.param('id')) }));
  app.get('/quote', (c) => {
    const providerIdParam = c.req.query('providerId');
    const slotId = c.req.query('slotId');
    if (!providerIdParam || !slotId) throw new AppError(400, 'invalid_request', 'providerId and slotId are required');
    return c.json({ quote: bookings.quote(providerIdParam, slotId) });
  });

  // Customer

  app.post('/bookings', async (c) => {
    const result = await bookings.createBooking(customerId(c), await jsonBody(c));
    return c.json(result, 201);
  });
  app.get('/bookings', (c) => c.json({ bookings: bookings.listBookingsForUser(customerId(c)) }));
  app.get('/bookings/:id', (c) => c.json({ booking: bookings.getBookingForUser(customerId(c), c.req.param('id')) }));
  app.post('/bookings/:id/refresh', async (c) =>
    c.json({ booking: await bookings.refreshForUser(customerId(c), c.req.param('id')) }),
  );
  app.post('/bookings/:id/cancel', async (c) =>
    c.json({ booking: await bookings.cancelByCustomer(customerId(c), c.req.param('id')) }),
  );
  app.post('/bookings/:id/pay-outstanding', async (c) =>
    c.json(await bookings.createFeePaymentSheet(customerId(c), c.req.param('id'))),
  );

  // Provider

  app.get('/providers/:id/bookings', (c) => {
    const id = providerId(c, c.req.param('id'));
    return c.json({ bookings: bookings.listBookingsForProvider(id) });
  });
  app.post('/providers/:id/bookings/:bookingId/complete', async (c) => {
    const id = providerId(c, c.req.param('id'));
    return c.json({ booking: await bookings.markCompleted(id, c.req.param('bookingId')) });
  });
  app.post('/providers/:id/bookings/:bookingId/no-show', async (c) => {
    const id = providerId(c, c.req.param('id'));
    return c.json({ booking: await bookings.markNoShow(id, c.req.param('bookingId')) });
  });
  app.post('/providers/:id/bookings/:bookingId/cancel', async (c) => {
    const id = providerId(c, c.req.param('id'));
    return c.json({ booking: await bookings.cancelByProvider(id, c.req.param('bookingId')) });
  });
  app.post('/providers/:id/bookings/:bookingId/refund', async (c) => {
    const id = providerId(c, c.req.param('id'));
    const body = await jsonBody(c);
    return c.json({ booking: await bookings.refund(id, c.req.param('bookingId'), body.amount) });
  });

  // Connect onboarding

  app.post('/providers/:id/connect/onboarding-link', async (c) => {
    const id = providerId(c, c.req.param('id'));
    return c.json(await connect.createOnboardingLink(id));
  });
  app.get('/providers/:id/connect/status', async (c) => {
    const id = providerId(c, c.req.param('id'));
    return c.json({ status: await connect.syncProvider(id) });
  });
  app.post('/providers/:id/connect/dashboard-link', async (c) => {
    const id = providerId(c, c.req.param('id'));
    return c.json(await connect.createDashboardLink(id));
  });

  /** Stripe sends the provider here when they leave onboarding. It doesn't mean they finished. */
  app.get('/connect/return', async (c) => {
    const id = c.req.query('provider') ?? '';
    const status = await connect.syncProvider(id);
    const message = status.acceptingBookings
      ? 'Payouts are set up. You can go back to the app.'
      : 'Stripe still needs some details. Go back to the app and tap "Set up payouts" again to continue.';
    return c.html(page('Payout setup', message));
  });

  /** Stripe sends the provider here when the link expired or was already used. Make a new one. */
  app.get('/connect/refresh', async (c) => {
    const { url } = await connect.createOnboardingLink(c.req.query('provider') ?? '');
    return c.redirect(url, 302);
  });

  // Webhooks: read the raw body. Parsing JSON first would break signature verification.

  app.post('/webhooks/stripe', async (c) => {
    const event = webhooks.verify(await c.req.text(), c.req.header('stripe-signature'), config.stripeWebhookSecret);
    return c.json({ received: true, result: await webhooks.handle(event) });
  });
  app.post('/webhooks/stripe-connect', async (c) => {
    const event = webhooks.verify(
      await c.req.text(),
      c.req.header('stripe-signature'),
      config.stripeConnectWebhookSecret,
    );
    return c.json({ received: true, result: await webhooks.handle(event) });
  });

  return app;
}

function page(title: string, message: string): string {
  const escape = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.4rem">${escape(title)}</h1><p>${escape(message)}</p></body></html>`;
}
