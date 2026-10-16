import { existsSync } from 'node:fs';

export interface Config {
  port: number;
  /** Public base URL of this server. Stripe sends providers back here after Connect onboarding. */
  publicUrl: string;
  stripeSecretKey: string;
  stripePublishableKey: string;
  /** Signing secret for the platform webhook endpoint (payments, refunds, disputes). */
  stripeWebhookSecret: string;
  /** Signing secret for the Connect webhook endpoint (v1 account.updated). */
  stripeConnectWebhookSecret: string;
  /** Signing secret for the thin-event destination (Accounts v2 v2.core.account[...] events). */
  stripeThinWebhookSecret: string;
  /** Name shown in the PaymentSheet and in the cancellation policy text. */
  merchantDisplayName: string;
  /** Two-letter country of the platform. Used for new connected accounts and Apple Pay. */
  merchantCountry: string;
  currency: string;
  /** Platform commission taken from every charge, in percent. */
  platformFeePercent: number;
  /**
   * In `auto` mode a deposit is held (manual capture) only when the appointment starts within
   * this many hours. Card authorizations expire after about 7 days (5 for some Visa MITs).
   */
  holdWindowHours: number;
  /** How long an unpaid booking keeps its slot before someone else can take it. */
  paymentWindowMinutes: number;
  /** Demo only: let providers mark a no-show before the appointment starts. */
  allowEarlyOutcomes: boolean;
  databasePath: string;
}

/** Loads `.env` from the working directory if it exists. Real environment variables win. */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stripeSecretKey = required(env, 'STRIPE_SECRET_KEY');
  const isTestKey = stripeSecretKey.startsWith('sk_test_') || stripeSecretKey.startsWith('rk_test_');
  if (!isTestKey && env.ALLOW_LIVE_KEYS !== 'true') {
    throw new Error(
      'STRIPE_SECRET_KEY is not a test-mode key. This starter refuses live keys unless ALLOW_LIVE_KEYS=true.',
    );
  }
  const webhookSecret = required(env, 'STRIPE_WEBHOOK_SECRET');
  const port = toNumber(env.PORT, 4242, 'PORT');

  return {
    port,
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    stripeSecretKey,
    stripePublishableKey: required(env, 'STRIPE_PUBLISHABLE_KEY'),
    stripeWebhookSecret: webhookSecret,
    // The Stripe CLI signs platform and Connect events with the same secret.
    stripeConnectWebhookSecret: env.STRIPE_CONNECT_WEBHOOK_SECRET || webhookSecret,
    stripeThinWebhookSecret: env.STRIPE_THIN_WEBHOOK_SECRET || webhookSecret,
    merchantDisplayName: env.MERCHANT_DISPLAY_NAME ?? 'Booking Deposits Demo',
    merchantCountry: (env.MERCHANT_COUNTRY ?? 'US').toUpperCase(),
    currency: (env.CURRENCY ?? 'usd').toLowerCase(),
    platformFeePercent: toNumber(env.PLATFORM_FEE_PERCENT, 10, 'PLATFORM_FEE_PERCENT'),
    holdWindowHours: toNumber(env.HOLD_WINDOW_HOURS, 144, 'HOLD_WINDOW_HOURS'),
    paymentWindowMinutes: toNumber(env.PAYMENT_WINDOW_MINUTES, 15, 'PAYMENT_WINDOW_MINUTES'),
    allowEarlyOutcomes: env.DEMO_ALLOW_EARLY_OUTCOMES === 'true',
    databasePath: env.DATABASE_PATH ?? './data/dev.sqlite',
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

function toNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}
