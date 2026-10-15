import type { BookingStatus, DepositStrategy } from './types';

export function money(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100);
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export const STATUS_LABEL: Record<BookingStatus, string> = {
  pending_payment: 'Waiting for payment',
  confirmed: 'Confirmed',
  completed: 'Completed',
  no_show: 'No-show',
  canceled: 'Cancelled',
  canceled_late: 'Cancelled late',
  canceled_by_provider: 'Cancelled by provider',
  expired: 'Expired',
};

export const STRATEGY_LABEL: Record<DepositStrategy, string> = {
  hold: 'Deposit held on your card',
  charge: 'Deposit charged now',
  card_on_file: 'Card saved, nothing charged now',
};
