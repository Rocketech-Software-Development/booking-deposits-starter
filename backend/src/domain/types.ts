/**
 * How the deposit is taken at booking time.
 * - `hold`: authorize the deposit now, capture it later (PaymentIntent with capture_method=manual).
 * - `charge`: charge the deposit now, refund it if the customer cancels in time.
 * - `card_on_file`: charge nothing now, save the card (SetupIntent) and charge a fee only on a no-show.
 */
export type DepositStrategy = 'hold' | 'charge' | 'card_on_file';

/** `auto` picks `hold` when the appointment is inside the authorization window, `charge` otherwise. */
export type StrategySetting = DepositStrategy | 'auto';

export type DepositRule = { type: 'fixed'; amount: number } | { type: 'percent'; percent: number };

export interface CancellationPolicy {
  strategy: StrategySetting;
  /** Ignored for `card_on_file`. */
  deposit: DepositRule;
  /** Cancel at least this many hours before the start for a full release or refund. */
  freeCancellationHours: number;
  /**
   * Total owed for a no-show or a late cancellation, in minor units (cents).
   * The deposit counts toward it. 0 means "keep the deposit and charge nothing more".
   */
  noShowFee: number;
}

export interface Provider {
  id: string;
  name: string;
  category: string;
  description: string;
  serviceName: string;
  priceAmount: number;
  durationMinutes: number;
  currency: string;
  policy: CancellationPolicy;
  /** Accounts v2 connected account id (acct_...). */
  stripeAccountId: string | null;
  /** Recipient configuration: `stripe_balance.stripe_transfers` is active, so destination charges can pay this provider. */
  transfersActive: boolean;
  /** Recipient configuration: `stripe_balance.payouts` is active, so money can reach the provider's bank. */
  payoutsActive: boolean;
  /** Stripe is waiting on the provider for information that is currently due or past due. */
  requirementsDue: boolean;
}

export interface Slot {
  id: string;
  providerId: string;
  startsAt: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  stripeCustomerId: string | null;
}

export type BookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'completed'
  | 'no_show'
  | 'canceled'
  | 'canceled_late'
  | 'canceled_by_provider'
  | 'expired';

export interface Booking {
  id: string;
  providerId: string;
  slotId: string;
  userId: string;
  startsAt: string;
  strategy: DepositStrategy;
  status: BookingStatus;
  currency: string;
  priceAmount: number;
  depositAmount: number;
  noShowFeeAmount: number;
  freeCancellationUntil: string;
  /** The exact policy text the customer agreed to. Keep it: it is your evidence in a dispute. */
  policyLines: string[];
  policyAcceptedAt: string;
  setupIntentId: string | null;
  paymentMethodId: string | null;
  /** Fee the customer still owes after an off-session charge failed. */
  amountDue: number;
  disputed: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PaymentKind = 'deposit' | 'no_show_fee';

export type PaymentStatus =
  | 'pending'
  | 'requires_action'
  | 'processing'
  | 'authorized'
  | 'succeeded'
  | 'canceled'
  | 'failed';

export interface Payment {
  id: string;
  bookingId: string;
  kind: PaymentKind;
  paymentIntentId: string;
  amount: number;
  amountCaptured: number;
  amountRefunded: number;
  applicationFeeAmount: number;
  status: PaymentStatus;
  /** When an authorized hold expires (from the charge's capture_before). */
  captureBefore: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
