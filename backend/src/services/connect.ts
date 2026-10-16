import type Stripe from 'stripe';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { Provider } from '../domain/types.js';
import { conflict, notFound } from '../errors.js';
import { ACCOUNT_INCLUDE, type StripePort } from '../stripe/port.js';

export interface ConnectStatus {
  providerId: string;
  stripeAccountId: string | null;
  transfersActive: boolean;
  payoutsActive: boolean;
  requirementsDue: boolean;
  acceptingBookings: boolean;
}

/**
 * Provider onboarding with Stripe Connect, Accounts v2.
 *
 * Each provider gets a v2 Account with the `recipient` configuration and the
 * `stripe_balance.stripe_transfers` capability, which is what destination charges need.
 * The platform is the merchant of record, so no `merchant` configuration is requested.
 * https://docs.stripe.com/connect/marketplace/tasks/create
 */
export class ConnectService {
  constructor(
    private readonly deps: { store: Store; stripe: StripePort; config: Config },
  ) {}

  /** Creates the connected account on first use, then a fresh single-use onboarding link. */
  async createOnboardingLink(providerId: string): Promise<{ url: string }> {
    const provider = this.requireProvider(providerId);
    const accountId = provider.stripeAccountId ?? (await this.createAccount(provider));
    const { publicUrl } = this.deps.config;
    const link = await this.deps.stripe.createAccountLink({
      account: accountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          // Live mode needs HTTPS URLs here. Test mode accepts http://localhost.
          refresh_url: `${publicUrl}/connect/refresh?provider=${encodeURIComponent(provider.id)}`,
          return_url: `${publicUrl}/connect/return?provider=${encodeURIComponent(provider.id)}`,
        },
      },
    });
    return { url: link.url };
  }

  /** Reads the account from Stripe and stores what matters for taking bookings. */
  async syncProvider(providerId: string): Promise<ConnectStatus> {
    const provider = this.requireProvider(providerId);
    if (!provider.stripeAccountId) return this.status(provider);
    const account = await this.deps.stripe.retrieveAccount(provider.stripeAccountId);
    this.applyAccount(provider.id, account);
    return this.status(this.requireProvider(provider.id));
  }

  /** Webhooks (v1 `account.updated` or v2 `v2.core.account[...]` thin events). False if not ours. */
  async syncAccount(accountId: string): Promise<boolean> {
    const provider = this.deps.store.getProviderByAccount(accountId);
    if (!provider) return false;
    const account = await this.deps.stripe.retrieveAccount(accountId);
    this.applyAccount(provider.id, account);
    return true;
  }

  /** A one-time link into the Express Dashboard, where providers see their balance and payouts. */
  async createDashboardLink(providerId: string): Promise<{ url: string }> {
    const provider = this.requireProvider(providerId);
    if (!provider.stripeAccountId || provider.requirementsDue) {
      throw conflict('onboarding_incomplete', 'Finish payout setup before opening the dashboard.');
    }
    const link = await this.deps.stripe.createLoginLink(provider.stripeAccountId);
    return { url: link.url };
  }

  getStatus(providerId: string): ConnectStatus {
    return this.status(this.requireProvider(providerId));
  }

  private async createAccount(provider: Provider): Promise<string> {
    const account = await this.deps.stripe.createAccount(
      {
        display_name: provider.name,
        // Stripe-hosted Express Dashboard for balance and payouts.
        dashboard: 'express',
        identity: { country: this.deps.config.merchantCountry.toLowerCase() },
        defaults: {
          // Stripe recommends both on `application` for destination charges. The platform pays
          // Stripe's fees and is liable for negative balances on the account.
          responsibilities: { fees_collector: 'application', losses_collector: 'application' },
        },
        configuration: {
          recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
        },
        include: ACCOUNT_INCLUDE,
        metadata: { provider_id: provider.id },
      },
      `provider:${provider.id}:account`,
    );
    this.deps.store.updateProviderConnect(provider.id, { stripeAccountId: account.id });
    this.applyAccount(provider.id, account);
    return account.id;
  }

  private applyAccount(providerId: string, account: Stripe.V2.Core.Account): void {
    const balance = account.configuration?.recipient?.capabilities?.stripe_balance;
    const entries = account.requirements?.entries ?? [];
    this.deps.store.updateProviderConnect(providerId, {
      transfersActive: balance?.stripe_transfers?.status === 'active',
      payoutsActive: balance?.payouts?.status === 'active',
      requirementsDue: entries.some(
        (entry) =>
          entry.awaiting_action_from === 'user' &&
          (entry.minimum_deadline.status === 'currently_due' || entry.minimum_deadline.status === 'past_due'),
      ),
    });
  }

  private requireProvider(providerId: string): Provider {
    const provider = this.deps.store.getProvider(providerId);
    if (!provider) throw notFound('Provider');
    return provider;
  }

  private status(provider: Provider): ConnectStatus {
    return {
      providerId: provider.id,
      stripeAccountId: provider.stripeAccountId,
      transfersActive: provider.transfersActive,
      payoutsActive: provider.payoutsActive,
      requirementsDue: provider.requirementsDue,
      acceptingBookings: Boolean(provider.stripeAccountId) && provider.transfersActive,
    };
  }
}
