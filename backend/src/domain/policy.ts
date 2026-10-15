import type { CancellationPolicy, DepositStrategy, StrategySetting } from './types.js';

/**
 * Smallest charge Stripe accepts for USD, in cents. Other currencies have other minimums:
 * https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts
 */
export const MIN_CHARGE_AMOUNT = 50;

const HOUR_MS = 60 * 60 * 1000;

export class PolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

export function depositAmount(policy: CancellationPolicy, priceAmount: number, strategy: DepositStrategy): number {
  if (strategy === 'card_on_file') return 0;
  const rule = policy.deposit;
  return rule.type === 'fixed' ? rule.amount : Math.round((priceAmount * rule.percent) / 100);
}

/**
 * Picks how to take the deposit for one appointment.
 * A hold only makes sense if we can still capture it when the appointment happens, so
 * `auto` falls back to charging up front for appointments outside the hold window, and an
 * explicit `hold` refuses them.
 */
export function resolveStrategy(
  setting: StrategySetting,
  now: Date,
  startsAt: Date,
  holdWindowHours: number,
): DepositStrategy {
  const insideWindow = startsAt.getTime() - now.getTime() <= holdWindowHours * HOUR_MS;
  if (setting === 'auto') return insideWindow ? 'hold' : 'charge';
  if (setting === 'hold' && !insideWindow) {
    throw new PolicyError(
      'outside_hold_window',
      `This provider only takes bookings up to ${holdWindowHours} hours ahead, because a card hold expires after that.`,
    );
  }
  return setting;
}

export function freeCancellationUntil(startsAt: Date, freeCancellationHours: number): Date {
  return new Date(startsAt.getTime() - freeCancellationHours * HOUR_MS);
}

export function isFreeCancellation(now: Date, startsAt: Date, freeCancellationHours: number): boolean {
  return now.getTime() <= freeCancellationUntil(startsAt, freeCancellationHours).getTime();
}

/** Platform commission in minor units. Never the whole amount, so the provider always gets something. */
export function applicationFeeAmount(amount: number, percent: number): number {
  const fee = Math.round((amount * percent) / 100);
  return Math.min(Math.max(fee, 0), Math.max(amount - 1, 0));
}

/** What is still owed after a no-show, given what the deposit already collected. */
export function noShowRemainder(deposit: number, noShowFee: number, alreadyCollected: number): number {
  const total = Math.max(deposit, noShowFee);
  return Math.max(total - alreadyCollected, 0);
}

/** Returns human-readable problems with a policy, or an empty list. */
export function validatePolicy(policy: CancellationPolicy, priceAmount: number, strategy: DepositStrategy): string[] {
  const problems: string[] = [];
  const deposit = depositAmount(policy, priceAmount, strategy);
  if (policy.freeCancellationHours < 0) problems.push('freeCancellationHours cannot be negative');
  if (policy.noShowFee < 0) problems.push('noShowFee cannot be negative');

  if (strategy === 'card_on_file') {
    if (policy.noShowFee < MIN_CHARGE_AMOUNT) {
      problems.push(`card_on_file needs a noShowFee of at least ${MIN_CHARGE_AMOUNT}`);
    }
  } else {
    if (deposit < MIN_CHARGE_AMOUNT) problems.push(`deposit must be at least ${MIN_CHARGE_AMOUNT}`);
    if (deposit > priceAmount) problems.push('deposit cannot be more than the price');
    if (policy.noShowFee > 0 && policy.noShowFee < deposit) {
      problems.push('noShowFee must be 0 (keep the deposit) or at least the deposit');
    }
    const extra = policy.noShowFee - deposit;
    if (extra > 0 && extra < MIN_CHARGE_AMOUNT) {
      problems.push(`noShowFee must exceed the deposit by 0 or by at least ${MIN_CHARGE_AMOUNT}`);
    }
  }
  if (policy.noShowFee > priceAmount) problems.push('noShowFee cannot be more than the price');
  return problems;
}

export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100);
}

export interface PolicyTextInput {
  strategy: DepositStrategy;
  priceAmount: number;
  depositAmount: number;
  noShowFeeAmount: number;
  freeCancellationHours: number;
  currency: string;
  merchantName: string;
}

/**
 * The cancellation policy in plain words. The customer sees exactly these lines before paying,
 * and the booking stores them with the acceptance time.
 */
export function policyLines(input: PolicyTextInput): string[] {
  const money = (amount: number) => formatMoney(amount, input.currency);
  const hours = `${input.freeCancellationHours} hour${input.freeCancellationHours === 1 ? '' : 's'}`;
  const deposit = money(input.depositAmount);
  const total = Math.max(input.depositAmount, input.noShowFeeAmount);
  const extra = total - input.depositAmount;
  const lines: string[] = [];

  if (input.strategy === 'hold') {
    lines.push(`We put a hold of ${deposit} on your card now. Nothing is charged yet.`);
    lines.push(`Cancel at least ${hours} before your appointment and we release the hold.`);
    lines.push(
      extra > 0
        ? `If you cancel later or don't show up, we charge the ${deposit} deposit plus ${money(extra)} to the same card (${money(total)} in total).`
        : `If you cancel later or don't show up, we charge the ${deposit} deposit.`,
    );
    lines.push(`If you come, we charge the deposit and it counts toward the ${money(input.priceAmount)} price.`);
    lines.push('Your bank may show the hold as a pending charge until we charge or release it.');
  } else if (input.strategy === 'charge') {
    lines.push(`We charge a ${deposit} deposit now.`);
    lines.push(`Cancel at least ${hours} before your appointment and we refund the deposit in full.`);
    lines.push(
      extra > 0
        ? `If you cancel later or don't show up, we keep the deposit and charge ${money(extra)} more to the same card (${money(total)} in total).`
        : `If you cancel later or don't show up, we keep the deposit.`,
    );
    lines.push(`If you come, the deposit counts toward the ${money(input.priceAmount)} price.`);
  } else {
    lines.push('We charge nothing now. We save your card for this booking.');
    lines.push(`Cancel at least ${hours} before your appointment and we charge nothing.`);
    lines.push(`If you cancel later or don't show up, we charge a ${money(total)} fee to the saved card.`);
    lines.push(`You pay the ${money(input.priceAmount)} price at the appointment.`);
  }
  lines.push('If the provider cancels, you get back everything you paid.');
  lines.push(
    `By booking, you allow ${input.merchantName} to charge your saved card for the amounts above without asking you again.`,
  );
  return lines;
}
