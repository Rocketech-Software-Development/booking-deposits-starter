import type Stripe from 'stripe';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { Provider } from '../domain/types.js';
import { conflict, notFound } from '../errors.js';
import type { StripePort } from '../stripe/port.js';

export interface ConnectStatus {
  providerId: string;
  stripeAccountId: string | null;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersActive: boolean;
  acceptingBookings: boolean;
}

/**
 * Provider onboarding with Stripe Connect.
 *
 * Accounts are created with controller properties that match an Express account: Stripe hosts
 * onboarding and the Express Dashboard, the platform pays Stripe fees and is liable for negative
 * balances. https://docs.stripe.com/connect/migrate-to-controller-properties
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
      type: 'account_onboarding',
      // Live mode needs HTTPS URLs here. Test mode accepts http://localhost.
      refresh_url: `${publicUrl}/connect/refresh?provider=${encodeURIComponent(provider.id)}`,
      return_url: `${publicUrl}/connect/return?provider=${encodeURIComponent(provider.id)}`,
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

  /** account.updated webhook. Returns false if the account is not one of ours. */
  async syncAccount(accountId: string): Promise<boolean> {
    const provider = this.deps.store.getProviderByAccount(accountId);
    if (!provider) return false;
    const account = await this.deps.stripe.retrieveAccount(accountId);
    this.applyAccount(provider.id, account);
    return true;
  }

  /** A one-time link into the Express Dashboard, where providers see payouts. */
  async createDashboardLink(providerId: string): Promise<{ url: string }> {
    const provider = this.requireProvider(providerId);
    if (!provider.stripeAccountId || !provider.detailsSubmitted) {
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
        country: this.deps.config.merchantCountry,
        controller: {
          stripe_dashboard: { type: 'express' },
          fees: { payer: 'application' },
          losses: { payments: 'application' },
        },
        capabilities: {
          // Destination charges only need `transfers`. `card_payments` lets you switch to
          // on_behalf_of later without onboarding everyone again.
          transfers: { requested: true },
          card_payments: { requested: true },
        },
        business_profile: { name: provider.name, product_description: provider.description },
        metadata: { provider_id: provider.id },
      },
      `provider:${provider.id}:account`,
    );
    this.deps.store.updateProviderConnect(provider.id, { stripeAccountId: account.id });
    return account.id;
  }

  private applyAccount(providerId: string, account: Stripe.Account): void {
    this.deps.store.updateProviderConnect(providerId, {
      detailsSubmitted: account.details_submitted ?? false,
      chargesEnabled: account.charges_enabled ?? false,
      payoutsEnabled: account.payouts_enabled ?? false,
      transfersActive: account.capabilities?.transfers === 'active',
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
      detailsSubmitted: provider.detailsSubmitted,
      chargesEnabled: provider.chargesEnabled,
      payoutsEnabled: provider.payoutsEnabled,
      transfersActive: provider.transfersActive,
      acceptingBookings: Boolean(provider.stripeAccountId) && provider.transfersActive,
    };
  }
}
