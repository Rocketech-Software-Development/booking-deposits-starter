import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Booking, BookingStatus, Payment, Provider, Slot, User } from './domain/types.js';

/**
 * SQLite storage through Node's built-in `node:sqlite` (no native addon to compile).
 * Pass ':memory:' for tests. Swap this class for Postgres or your ORM in a real app;
 * services only use the methods below.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  service_name TEXT NOT NULL,
  price_amount INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  currency TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  stripe_account_id TEXT UNIQUE,
  transfers_active INTEGER NOT NULL DEFAULT 0,
  payouts_active INTEGER NOT NULL DEFAULT 0,
  requirements_due INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS slots (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  starts_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  stripe_customer_id TEXT
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  slot_id TEXT NOT NULL REFERENCES slots(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  starts_at TEXT NOT NULL,
  strategy TEXT NOT NULL,
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  price_amount INTEGER NOT NULL,
  deposit_amount INTEGER NOT NULL,
  no_show_fee_amount INTEGER NOT NULL,
  free_cancellation_until TEXT NOT NULL,
  policy_lines_json TEXT NOT NULL,
  policy_accepted_at TEXT NOT NULL,
  setup_intent_id TEXT UNIQUE,
  payment_method_id TEXT,
  amount_due INTEGER NOT NULL DEFAULT 0,
  disputed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One live booking per slot, enforced by the database as well as the service.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_live_per_slot ON bookings(slot_id)
  WHERE status IN ('pending_payment', 'confirmed', 'completed', 'no_show');
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  kind TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  amount_captured INTEGER NOT NULL DEFAULT 0,
  amount_refunded INTEGER NOT NULL DEFAULT 0,
  application_fee_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  capture_before TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

const BOOKING_COLUMNS: Record<string, string> = {
  status: 'status',
  setupIntentId: 'setup_intent_id',
  paymentMethodId: 'payment_method_id',
  amountDue: 'amount_due',
  disputed: 'disputed',
};

const PAYMENT_COLUMNS: Record<string, string> = {
  amountCaptured: 'amount_captured',
  amountRefunded: 'amount_refunded',
  status: 'status',
  captureBefore: 'capture_before',
  lastError: 'last_error',
};

const PROVIDER_CONNECT_COLUMNS: Record<string, string> = {
  stripeAccountId: 'stripe_account_id',
  transfersActive: 'transfers_active',
  payoutsActive: 'payouts_active',
  requirementsDue: 'requirements_due',
};

export type BookingPatch = Partial<Pick<Booking, 'status' | 'setupIntentId' | 'paymentMethodId' | 'amountDue' | 'disputed'>>;
export type PaymentPatch = Partial<Pick<Payment, 'amountCaptured' | 'amountRefunded' | 'status' | 'captureBefore' | 'lastError'>>;
export type ProviderConnectPatch = Partial<
  Pick<Provider, 'stripeAccountId' | 'transfersActive' | 'payoutsActive' | 'requirementsDue'>
>;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` in a transaction. `fn` must be synchronous. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Providers

  upsertProvider(p: Provider): void {
    this.db
      .prepare(
        `INSERT INTO providers (id, name, category, description, service_name, price_amount, duration_minutes, currency,
           policy_json, stripe_account_id, transfers_active, payouts_active, requirements_due)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category,
           description = excluded.description, service_name = excluded.service_name,
           price_amount = excluded.price_amount, duration_minutes = excluded.duration_minutes,
           currency = excluded.currency, policy_json = excluded.policy_json`,
      )
      .run(
        p.id,
        p.name,
        p.category,
        p.description,
        p.serviceName,
        p.priceAmount,
        p.durationMinutes,
        p.currency,
        JSON.stringify(p.policy),
        p.stripeAccountId,
        bool(p.transfersActive),
        bool(p.payoutsActive),
        bool(p.requirementsDue),
      );
  }

  listProviders(): Provider[] {
    return this.db.prepare('SELECT * FROM providers ORDER BY name').all().map(toProvider);
  }

  getProvider(id: string): Provider | undefined {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    return row ? toProvider(row) : undefined;
  }

  getProviderByAccount(stripeAccountId: string): Provider | undefined {
    const row = this.db.prepare('SELECT * FROM providers WHERE stripe_account_id = ?').get(stripeAccountId);
    return row ? toProvider(row) : undefined;
  }

  updateProviderConnect(id: string, patch: ProviderConnectPatch): void {
    this.update('providers', PROVIDER_CONNECT_COLUMNS, id, patch, false);
  }

  // Slots

  insertSlot(slot: Slot): void {
    this.db.prepare('INSERT INTO slots (id, provider_id, starts_at) VALUES (?, ?, ?)').run(slot.id, slot.providerId, slot.startsAt);
  }

  getSlot(id: string): Slot | undefined {
    const row = this.db.prepare('SELECT * FROM slots WHERE id = ?').get(id);
    return row ? toSlot(row) : undefined;
  }

  /** Future slots without a live booking. Unpaid bookings older than `staleBefore` do not count. */
  listOpenSlots(providerId: string, fromIso: string, staleBefore: string): Slot[] {
    return this.db
      .prepare(
        `SELECT s.* FROM slots s
         WHERE s.provider_id = ? AND s.starts_at > ?
           AND NOT EXISTS (
             SELECT 1 FROM bookings b WHERE b.slot_id = s.id
               AND (b.status IN ('confirmed', 'completed', 'no_show')
                    OR (b.status = 'pending_payment' AND b.created_at >= ?)))
         ORDER BY s.starts_at`,
      )
      .all(providerId, fromIso, staleBefore)
      .map(toSlot);
  }

  // Users

  upsertUser(user: User): void {
    this.db
      .prepare(
        `INSERT INTO users (id, name, email, stripe_customer_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email`,
      )
      .run(user.id, user.name, user.email, user.stripeCustomerId);
  }

  getUser(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? toUser(row) : undefined;
  }

  setStripeCustomer(userId: string, stripeCustomerId: string): void {
    this.db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(stripeCustomerId, userId);
  }

  // Bookings

  insertBooking(b: Booking): void {
    this.db
      .prepare(
        `INSERT INTO bookings (id, provider_id, slot_id, user_id, starts_at, strategy, status, currency, price_amount,
           deposit_amount, no_show_fee_amount, free_cancellation_until, policy_lines_json, policy_accepted_at,
           setup_intent_id, payment_method_id, amount_due, disputed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.id,
        b.providerId,
        b.slotId,
        b.userId,
        b.startsAt,
        b.strategy,
        b.status,
        b.currency,
        b.priceAmount,
        b.depositAmount,
        b.noShowFeeAmount,
        b.freeCancellationUntil,
        JSON.stringify(b.policyLines),
        b.policyAcceptedAt,
        b.setupIntentId,
        b.paymentMethodId,
        b.amountDue,
        bool(b.disputed),
        b.createdAt,
        b.updatedAt,
      );
  }

  getBooking(id: string): Booking | undefined {
    const row = this.db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    return row ? toBooking(row) : undefined;
  }

  getBookingBySetupIntent(setupIntentId: string): Booking | undefined {
    const row = this.db.prepare('SELECT * FROM bookings WHERE setup_intent_id = ?').get(setupIntentId);
    return row ? toBooking(row) : undefined;
  }

  listBookingsForUser(userId: string): Booking[] {
    return this.db.prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY starts_at DESC').all(userId).map(toBooking);
  }

  listBookingsForProvider(providerId: string): Booking[] {
    return this.db
      .prepare(`SELECT * FROM bookings WHERE provider_id = ? AND status != 'expired' ORDER BY starts_at`)
      .all(providerId)
      .map(toBooking);
  }

  listBookingsForSlot(slotId: string, statuses: BookingStatus[]): Booking[] {
    const marks = statuses.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM bookings WHERE slot_id = ? AND status IN (${marks})`)
      .all(slotId, ...statuses)
      .map(toBooking);
  }

  updateBooking(id: string, patch: BookingPatch, now: string): void {
    this.update('bookings', BOOKING_COLUMNS, id, patch, true, now);
  }

  // Payments

  insertPayment(p: Payment): void {
    this.db
      .prepare(
        `INSERT INTO payments (id, booking_id, kind, payment_intent_id, amount, amount_captured, amount_refunded,
           application_fee_amount, status, capture_before, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.bookingId,
        p.kind,
        p.paymentIntentId,
        p.amount,
        p.amountCaptured,
        p.amountRefunded,
        p.applicationFeeAmount,
        p.status,
        p.captureBefore,
        p.lastError,
        p.createdAt,
        p.updatedAt,
      );
  }

  getPaymentByIntent(paymentIntentId: string): Payment | undefined {
    const row = this.db.prepare('SELECT * FROM payments WHERE payment_intent_id = ?').get(paymentIntentId);
    return row ? toPayment(row) : undefined;
  }

  listPayments(bookingId: string): Payment[] {
    return this.db
      .prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at, rowid')
      .all(bookingId)
      .map(toPayment);
  }

  updatePayment(id: string, patch: PaymentPatch, now: string): void {
    this.update('payments', PAYMENT_COLUMNS, id, patch, true, now);
  }

  // Webhook events

  hasProcessedEvent(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM webhook_events WHERE id = ?').get(id) !== undefined;
  }

  recordEvent(id: string, type: string, now: string): void {
    this.db.prepare('INSERT OR IGNORE INTO webhook_events (id, type, processed_at) VALUES (?, ?, ?)').run(id, type, now);
  }

  /** Deletes bookings, payments and slots. Keeps providers (and their Connect accounts) and users. */
  clearBookingsAndSlots(): void {
    this.db.exec('DELETE FROM payments; DELETE FROM bookings; DELETE FROM slots; DELETE FROM webhook_events;');
  }

  private update(
    table: string,
    columns: Record<string, string>,
    id: string,
    patch: object,
    touch: boolean,
    now?: string,
  ): void {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column) throw new Error(`Cannot update ${table}.${key}`);
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === 'boolean' ? bool(value) : (value as SQLInputValue));
    }
    if (touch && now) {
      sets.push('updated_at = ?');
      values.push(now);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }
}

const bool = (value: boolean) => (value ? 1 : 0);
const str = (row: Row, key: string) => row[key] as string;
const num = (row: Row, key: string) => Number(row[key]);
const nullableStr = (row: Row, key: string) => (row[key] === null ? null : (row[key] as string));
const flag = (row: Row, key: string) => Number(row[key]) === 1;

function toProvider(row: Row): Provider {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    category: str(row, 'category'),
    description: str(row, 'description'),
    serviceName: str(row, 'service_name'),
    priceAmount: num(row, 'price_amount'),
    durationMinutes: num(row, 'duration_minutes'),
    currency: str(row, 'currency'),
    policy: JSON.parse(str(row, 'policy_json')),
    stripeAccountId: nullableStr(row, 'stripe_account_id'),
    transfersActive: flag(row, 'transfers_active'),
    payoutsActive: flag(row, 'payouts_active'),
    requirementsDue: flag(row, 'requirements_due'),
  };
}

function toSlot(row: Row): Slot {
  return { id: str(row, 'id'), providerId: str(row, 'provider_id'), startsAt: str(row, 'starts_at') };
}

function toUser(row: Row): User {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    email: str(row, 'email'),
    stripeCustomerId: nullableStr(row, 'stripe_customer_id'),
  };
}

function toBooking(row: Row): Booking {
  return {
    id: str(row, 'id'),
    providerId: str(row, 'provider_id'),
    slotId: str(row, 'slot_id'),
    userId: str(row, 'user_id'),
    startsAt: str(row, 'starts_at'),
    strategy: str(row, 'strategy') as Booking['strategy'],
    status: str(row, 'status') as BookingStatus,
    currency: str(row, 'currency'),
    priceAmount: num(row, 'price_amount'),
    depositAmount: num(row, 'deposit_amount'),
    noShowFeeAmount: num(row, 'no_show_fee_amount'),
    freeCancellationUntil: str(row, 'free_cancellation_until'),
    policyLines: JSON.parse(str(row, 'policy_lines_json')),
    policyAcceptedAt: str(row, 'policy_accepted_at'),
    setupIntentId: nullableStr(row, 'setup_intent_id'),
    paymentMethodId: nullableStr(row, 'payment_method_id'),
    amountDue: num(row, 'amount_due'),
    disputed: flag(row, 'disputed'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function toPayment(row: Row): Payment {
  return {
    id: str(row, 'id'),
    bookingId: str(row, 'booking_id'),
    kind: str(row, 'kind') as Payment['kind'],
    paymentIntentId: str(row, 'payment_intent_id'),
    amount: num(row, 'amount'),
    amountCaptured: num(row, 'amount_captured'),
    amountRefunded: num(row, 'amount_refunded'),
    applicationFeeAmount: num(row, 'application_fee_amount'),
    status: str(row, 'status') as Payment['status'],
    captureBefore: nullableStr(row, 'capture_before'),
    lastError: nullableStr(row, 'last_error'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}
