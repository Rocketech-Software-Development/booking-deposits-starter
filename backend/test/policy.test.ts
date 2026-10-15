import { describe, expect, it } from 'vitest';
import {
  PolicyError,
  applicationFeeAmount,
  depositAmount,
  freeCancellationUntil,
  isFreeCancellation,
  noShowRemainder,
  policyLines,
  resolveStrategy,
  validatePolicy,
} from '../src/domain/policy.js';
import type { CancellationPolicy } from '../src/domain/types.js';
import { DEMO_PROVIDERS } from '../src/seed-data.js';

const HOUR = 3_600_000;
const now = new Date('2030-01-01T10:00:00Z');
const inHours = (h: number) => new Date(now.getTime() + h * HOUR);

const policy = (overrides: Partial<CancellationPolicy> = {}): CancellationPolicy => ({
  strategy: 'charge',
  deposit: { type: 'fixed', amount: 2000 },
  freeCancellationHours: 24,
  noShowFee: 0,
  ...overrides,
});

describe('depositAmount', () => {
  it('takes a percentage of the price, rounded to the cent', () => {
    expect(depositAmount(policy({ deposit: { type: 'percent', percent: 25 } }), 12000, 'hold')).toBe(3000);
    expect(depositAmount(policy({ deposit: { type: 'percent', percent: 33 } }), 1001, 'charge')).toBe(330);
  });

  it('uses a fixed amount as is', () => {
    expect(depositAmount(policy(), 9000, 'charge')).toBe(2000);
  });

  it('is zero when only a card is saved', () => {
    expect(depositAmount(policy(), 9000, 'card_on_file')).toBe(0);
  });
});

describe('resolveStrategy', () => {
  it('auto holds the deposit when the appointment is inside the hold window', () => {
    expect(resolveStrategy('auto', now, inHours(144), 144)).toBe('hold');
  });

  it('auto charges up front when the hold would expire before the appointment', () => {
    expect(resolveStrategy('auto', now, inHours(145), 144)).toBe('charge');
  });

  it('refuses an explicit hold outside the window', () => {
    expect(() => resolveStrategy('hold', now, inHours(200), 144)).toThrow(PolicyError);
  });

  it('keeps explicit charge and card_on_file regardless of lead time', () => {
    expect(resolveStrategy('charge', now, inHours(1), 144)).toBe('charge');
    expect(resolveStrategy('card_on_file', now, inHours(500), 144)).toBe('card_on_file');
  });
});

describe('free cancellation window', () => {
  const startsAt = inHours(48);

  it('ends exactly freeCancellationHours before the start', () => {
    expect(freeCancellationUntil(startsAt, 24).toISOString()).toBe(inHours(24).toISOString());
  });

  it('includes the cutoff moment and excludes anything after it', () => {
    expect(isFreeCancellation(inHours(24), startsAt, 24)).toBe(true);
    expect(isFreeCancellation(new Date(inHours(24).getTime() + 1), startsAt, 24)).toBe(false);
  });
});

describe('applicationFeeAmount', () => {
  it('takes the platform percentage, rounded', () => {
    expect(applicationFeeAmount(3000, 10)).toBe(300);
    expect(applicationFeeAmount(1005, 10)).toBe(101);
  });

  it('never takes the whole amount and never goes negative', () => {
    expect(applicationFeeAmount(100, 100)).toBe(99);
    expect(applicationFeeAmount(3000, 0)).toBe(0);
  });
});

describe('noShowRemainder', () => {
  it('charges the difference when the fee is larger than the deposit', () => {
    expect(noShowRemainder(3000, 6000, 3000)).toBe(3000);
  });

  it('charges nothing more when the policy only keeps the deposit', () => {
    expect(noShowRemainder(2000, 0, 2000)).toBe(0);
  });

  it('charges the full fee when nothing was collected (card on file or an expired hold)', () => {
    expect(noShowRemainder(0, 3500, 0)).toBe(3500);
    expect(noShowRemainder(3000, 6000, 0)).toBe(6000);
    expect(noShowRemainder(3000, 0, 0)).toBe(3000);
  });
});

describe('validatePolicy', () => {
  it('accepts every demo provider policy', () => {
    for (const p of DEMO_PROVIDERS) {
      const strategy = p.policy.strategy === 'auto' ? 'hold' : p.policy.strategy;
      expect(validatePolicy(p.policy, p.priceAmount, strategy)).toEqual([]);
    }
  });

  it('rejects deposits under the Stripe minimum or above the price', () => {
    expect(validatePolicy(policy({ deposit: { type: 'fixed', amount: 30 } }), 9000, 'charge')).toContain(
      'deposit must be at least 50',
    );
    expect(validatePolicy(policy({ deposit: { type: 'fixed', amount: 9500 } }), 9000, 'charge')).toContain(
      'deposit cannot be more than the price',
    );
  });

  it('rejects a no-show fee below the deposit or only a few cents above it', () => {
    expect(validatePolicy(policy({ noShowFee: 1000 }), 9000, 'charge')).toHaveLength(1);
    expect(validatePolicy(policy({ noShowFee: 2020 }), 9000, 'charge')).toHaveLength(1);
  });

  it('requires a chargeable fee when only a card is saved', () => {
    expect(validatePolicy(policy({ strategy: 'card_on_file', noShowFee: 0 }), 9000, 'card_on_file')).toHaveLength(1);
  });
});

describe('policyLines', () => {
  const base = {
    priceAmount: 12000,
    depositAmount: 3000,
    noShowFeeAmount: 6000,
    freeCancellationHours: 24,
    currency: 'usd',
    merchantName: 'Test Bookings',
  };

  it('describes a hold with every amount the customer can be charged', () => {
    const text = policyLines({ ...base, strategy: 'hold' }).join(' ');
    expect(text).toContain('hold of $30.00');
    expect(text).toContain('at least 24 hours before');
    expect(text).toContain('plus $30.00');
    expect(text).toContain('$60.00 in total');
    expect(text).toContain('allow Test Bookings to charge your saved card');
  });

  it('describes a charged deposit and its refund', () => {
    const text = policyLines({ ...base, strategy: 'charge', noShowFeeAmount: 0 }).join(' ');
    expect(text).toContain('We charge a $30.00 deposit now.');
    expect(text).toContain('refund the deposit in full');
    expect(text).toContain("don't show up, we keep the deposit.");
  });

  it('says nothing is charged up front for card on file', () => {
    const text = policyLines({ ...base, strategy: 'card_on_file', depositAmount: 0, noShowFeeAmount: 3500 }).join(' ');
    expect(text).toContain('We charge nothing now.');
    expect(text).toContain('$35.00 fee');
  });
});
