// Response shapes from the backend (backend/src/services/*.ts). Keep the two in step.

export type DepositStrategy = 'hold' | 'charge' | 'card_on_file';

export type BookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'completed'
  | 'no_show'
  | 'canceled'
  | 'canceled_late'
  | 'canceled_by_provider'
  | 'expired';

export interface AppConfig {
  publishableKey: string;
  merchantDisplayName: string;
  merchantCountryCode: string;
  currency: string;
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
  acceptingBookings: boolean;
  connect: { onboardingStarted: boolean; detailsSubmitted: boolean; chargesEnabled: boolean; payoutsEnabled: boolean };
}

export interface ProviderDetail extends Provider {
  slots: { id: string; startsAt: string }[];
}

export interface Quote {
  providerId: string;
  slotId: string;
  startsAt: string;
  strategy: DepositStrategy;
  currency: string;
  priceAmount: number;
  depositAmount: number;
  noShowFeeAmount: number;
  freeCancellationHours: number;
  freeCancellationUntil: string;
  policyLines: string[];
  policyHash: string;
}

export interface Payment {
  id: string;
  kind: 'deposit' | 'no_show_fee';
  paymentIntentId: string;
  amount: number;
  amountCaptured: number;
  amountRefunded: number;
  status: 'pending' | 'requires_action' | 'processing' | 'authorized' | 'succeeded' | 'canceled' | 'failed';
  captureBefore: string | null;
  lastError: string | null;
}

export interface Booking {
  id: string;
  providerId: string;
  providerName: string;
  serviceName: string;
  startsAt: string;
  strategy: DepositStrategy;
  status: BookingStatus;
  currency: string;
  priceAmount: number;
  depositAmount: number;
  noShowFeeAmount: number;
  freeCancellationUntil: string;
  policyLines: string[];
  policyAcceptedAt: string;
  amountDue: number;
  disputed: boolean;
  payments: Payment[];
  totals: { held: number; collected: number; refunded: number };
  canCancelForFree: boolean;
}

export interface PaymentSheetParams {
  customerId: string;
  customerSessionClientSecret: string;
  paymentIntentClientSecret?: string;
  setupIntentClientSecret?: string;
  merchantDisplayName: string;
  merchantCountryCode: string;
}

export interface ConnectStatus {
  providerId: string;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersActive: boolean;
  acceptingBookings: boolean;
}
