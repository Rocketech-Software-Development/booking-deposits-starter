# Booking deposits with Stripe: Expo + Node starter

Take a deposit when someone books, keep it when they don't show up, refund it when they cancel in time, and pay the provider through Stripe Connect. This repo is a working starter for that flow in a marketplace or booking app: an Expo (React Native) app and a small Node backend.

It fits any app where people book a time with someone: salons, barbers, tattoo studios, massage, tutors, trainers, clinics.

What you get:

- An Expo app. Customers browse providers, pick a slot, read the cancellation policy, and pay the deposit in Stripe's PaymentSheet. A demo screen covers the provider side.
- A Node + TypeScript backend (Hono, SQLite through `node:sqlite`). It creates the Stripe intents, captures or cancels holds, charges no-show fees off-session, refunds, onboards providers to Connect, and handles webhooks.
- Three deposit strategies: hold the deposit, charge it now, or only save the card.
- 78 backend tests with Stripe mocked. No keys needed to run them.

Everything runs in Stripe test mode. The backend refuses to start with a live key unless you set `ALLOW_LIVE_KEYS=true`.

## How it fits together

```
+------------------------------- Expo app (app/) ---------------------------------+
|  Providers -> Slots -> Checkout (policy + PaymentSheet) -> Booking -> Cancel    |
|  Provider tools (demo): Connect onboarding, attended / no-show, refunds         |
+---------------+---------------------------------------------^-------------------+
                | REST, demo identity headers                 | client secrets only,
                v                                             | never amounts
+------------------------------ Backend (backend/) -----------+-------------------+
|  BookingService   quote, book, cancel, attended, no-show, refund, fees owed     |
|  ConnectService   connected accounts, onboarding links, account status          |
|  WebhookService   verify signature, skip repeated events, re-read the object    |
|  SQLite           providers, slots, users, bookings, payments, webhook events   |
+---------------+---------------------------------------------^-------------------+
                | stripe-node                                 | webhooks
                v                                             |
+---------------------------------- Stripe -------------------+-------------------+
|  PaymentIntents (manual or automatic capture), SetupIntents, Refunds,           |
|  CustomerSessions, connected accounts, Account Links, destination charges       |
+---------------+-----------------------------------------------------------------+
                | each charge is a destination charge: the provider's account
                | gets the amount minus your platform fee
                v
      Provider's connected account --(payouts on the account's schedule)--> bank
```

The app never decides how much to charge. It asks the backend for a quote, shows the policy text from the quote, and sends back a hash of that text with the booking. If the policy changed in between, the backend refuses the booking and the app shows the new text.

## Deposit strategies

Each provider picks one in its policy (`backend/src/seed-data.ts`).

| Strategy | At booking | Cancels in time | Cancels late or doesn't show | Shows up |
| --- | --- | --- | --- | --- |
| `hold` | PaymentIntent with `capture_method: 'manual'`. The card is authorized, not charged. | Cancel the PaymentIntent. The hold is released. | Capture the deposit, then charge any extra fee off-session. | Capture the deposit. It counts toward the price. |
| `charge` | PaymentIntent, charged now. | Full refund. | Keep the deposit, then charge any extra fee off-session. | Keep the deposit. |
| `card_on_file` | SetupIntent with `usage: 'off_session'`. Nothing is charged. | Nothing to do. | Charge the fee off-session. | Nothing to do. The customer pays at the appointment. |
| `auto` | `hold` if the appointment starts within `HOLD_WINDOW_HOURS` (144 by default), `charge` otherwise. | | | |

In `hold` and `charge` the PaymentIntent sets `setup_future_usage: 'off_session'`, so the same card can be charged for a no-show fee later.

Every charge is a [destination charge](https://docs.stripe.com/connect/destination-charges): `transfer_data.destination` is the provider's connected account and `application_fee_amount` is your cut (`PLATFORM_FEE_PERCENT`, 10 by default). Refunds set `reverse_transfer` and `refund_application_fee`, so the provider's share and your fee both go back to the customer.

A policy has three more settings: the deposit (fixed or a percentage of the price), how many hours before the start the customer can cancel for free, and `noShowFee`, the total owed for a no-show or a late cancellation. The deposit counts toward it. `noShowFee: 0` means "keep the deposit and charge nothing more".

## Quick start

You need Node 22.13 or newer, a Stripe account (test mode is enough), the [Stripe CLI](https://docs.stripe.com/stripe-cli), and an iOS simulator, an Android emulator, or a phone with Expo Go.

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
```

Put your test keys from [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys) into `.env` (`sk_test_...` and `pk_test_...`). Then, in a second terminal, forward webhooks:

```bash
stripe listen --forward-to localhost:4242/webhooks/stripe \
  --forward-connect-to localhost:4242/webhooks/stripe-connect
```

Copy the `whsec_...` secret it prints into `.env` as `STRIPE_WEBHOOK_SECRET`. Then:

```bash
npm run seed   # three demo providers with slots over the next two weeks
npm run dev    # http://localhost:4242
```

### 2. Connect

Before the first provider can onboard, finish the Connect setup in the Stripe Dashboard (test mode): the platform profile and the branding in Connect settings. Stripe needs both before onboarding works.

Each provider has to finish onboarding before it can take deposits. You'll do that from the app in the next step.

### 3. App

```bash
cd app
npm install
cp .env.example .env   # point EXPO_PUBLIC_API_URL at the backend
npx expo start
```

Press `i` for the iOS simulator or `a` for Android. On the Android emulator use `http://10.0.2.2:4242`; on a real phone use your computer's LAN IP.

In the app, open **Provider tools (demo)** at the bottom of the first screen, pick a provider and tap **Set up payouts**. Stripe's hosted onboarding opens. In test mode you can fill it with [test data](https://docs.stripe.com/connect/testing). When you come back, the provider can take bookings. Do it for each of the three providers.

The PaymentSheet works in Expo Go with cards. Apple Pay and Google Pay need a [development build](https://docs.expo.dev/versions/latest/sdk/stripe/) (`npx expo run:ios`) and a merchant id; change `merchant.com.example.bookingdeposits` in `app.json` and `app/src/app/_layout.tsx`.

### Test cards

From Stripe's [save-during-payment guide](https://docs.stripe.com/payments/save-during-payment?payment-ui=elements):

| Card | What happens |
| --- | --- |
| `4242 4242 4242 4242` | Works, no authentication. |
| `4000 0025 0000 3155` | Asks for authentication once at booking. Later off-session charges go through. |
| `4000 0027 6000 3184` | Asks for authentication every time, so the off-session no-show fee fails. Use it to see the "still owed" flow. |
| `4000 0000 0000 9995` | Declined. |

Any future expiry date, any CVC, any postal code.

## Try each flow

`.env.example` sets `DEMO_ALLOW_EARLY_OUTCOMES=true`, so you can mark a no-show or attendance without waiting for the slot to start. Turn it off in production.

1. Hold, then no-show: Book Northside Hair Studio within the next six days. The button says "Hold $30.00". In the Stripe Dashboard the payment shows as uncaptured. In Provider tools tap **Mark no-show**: the $30 hold is captured and $30 more is charged to the saved card ($60 total, as the policy says).
2. Charge, then cancel in time: Book Calm Hands Massage more than 48 hours out and pay the $20 deposit. Cancel from the booking screen. The deposit is refunded, and so is the platform fee.
3. Late cancellation: Book a slot that starts in the next few hours (the seed creates some) and cancel. You're past the free-cancellation time, so the policy is applied like a no-show.
4. Card on file and a failed fee: Book Peak Form Training with `4000 0027 6000 3184`. Nothing is charged. Mark a no-show: the $35 off-session charge needs authentication, so it fails. The booking screen then shows "$35.00 still owed" and a Pay button that opens the PaymentSheet on-session.
5. Attended: Book the hair studio again and tap **Customer came**. The hold is captured.
6. Refund: In Provider tools, refund anything that was charged. Partial refunds go through the API (`POST /providers/:id/bookings/:bookingId/refund` with `{ "amount": 500 }`).
7. Payouts: Tap **Open Express Dashboard** to see the provider's balance and payouts.

## API

| Method and path | Who | What it does |
| --- | --- | --- |
| `GET /config` | app | Publishable key and merchant name for `StripeProvider`. |
| `GET /providers`, `GET /providers/:id` | anyone | Providers and their open slots. |
| `GET /quote?providerId&slotId` | anyone | Strategy, amounts, policy text and its hash. |
| `POST /bookings` | customer | Creates the booking and the intent. Returns PaymentSheet params. Needs `policyAccepted: true` and `policyHash`. |
| `GET /bookings`, `GET /bookings/:id` | customer | The customer's bookings. |
| `POST /bookings/:id/refresh` | customer | Re-reads the intents from Stripe. The app calls it when the PaymentSheet closes. |
| `POST /bookings/:id/cancel` | customer | Free release or refund before the cutoff, the policy after it. |
| `POST /bookings/:id/pay-outstanding` | customer | New on-session PaymentIntent for a fee that failed off-session. |
| `GET /providers/:id/bookings` | provider | The provider's bookings. |
| `POST /providers/:id/bookings/:bookingId/complete` | provider | Customer came. Captures a hold. |
| `POST /providers/:id/bookings/:bookingId/no-show` | provider | Applies the no-show policy. |
| `POST /providers/:id/bookings/:bookingId/cancel` | provider | Releases and refunds everything. |
| `POST /providers/:id/bookings/:bookingId/refund` | provider | Refunds charged money, all of it or `amount` cents. |
| `POST /providers/:id/connect/onboarding-link` | provider | Creates the connected account on first use and returns an onboarding link. |
| `GET /providers/:id/connect/status` | provider | Reads the account from Stripe. |
| `POST /providers/:id/connect/dashboard-link` | provider | Login link to the Express Dashboard. |
| `GET /connect/return`, `GET /connect/refresh` | Stripe redirect | Where onboarding sends the provider back. `refresh` makes a new link. |
| `POST /webhooks/stripe` | Stripe | Platform events. |
| `POST /webhooks/stripe-connect` | Stripe | Connect events (`account.updated`). |

**Auth is a demo.** The app sends `x-demo-user` and `x-demo-provider` headers and the backend believes them. Replace `customerId()` and `providerId()` in `backend/src/http/app.ts` with your real session check before you put this anywhere public.

## Webhooks

The handler verifies the signature against the raw body, skips event ids it has already seen, and re-reads the object from the API instead of trusting the payload, because Stripe [doesn't guarantee event order](https://docs.stripe.com/webhooks#event-ordering). Each handler is safe to run twice.

| Event | What the backend does |
| --- | --- |
| `payment_intent.amount_capturable_updated` | Hold authorized: confirms the booking and stores when the hold expires (`capture_before`). |
| `payment_intent.succeeded` | Deposit or fee charged. |
| `payment_intent.payment_failed`, `.requires_action`, `.processing` | Updates the payment. |
| `payment_intent.canceled` | Covers holds that expired before you captured them. |
| `setup_intent.succeeded`, `.setup_failed` | Card on file saved, or not. |
| `charge.refunded` | Keeps refund totals right, including refunds made in the Dashboard. |
| `charge.dispute.created` | Flags the booking. |
| `account.updated` (Connect) | Stores whether the provider can receive transfers and payouts. |

In production you register two endpoints: one for your account's events and one for connected accounts' events. Each has its own signing secret (`STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`). The Stripe CLI uses one secret for both, which is why the second one is optional locally.

## Read this before going live

These are the limits that bite booking apps. Check them against your own Stripe account, your country and your card mix. None of this is legal advice.

### Holds expire

An authorization for an online card payment lasts about 7 days. From Stripe's [hold guide](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method):

| Card brand | Customer-initiated | Merchant-initiated |
| --- | --- | --- |
| Visa | 7 days | 5 days (exactly 4 days 18 hours) |
| Mastercard | 7 days | 7 days |
| American Express | 7 days | 7 days |
| Discover | 7 days | 7 days |

If you don't capture in time, Stripe cancels the PaymentIntent and the money is released. That's why `auto` only holds when the appointment is within 144 hours, and why the backend stores `capture_before` from the charge instead of guessing. If a hold expires anyway, the no-show logic charges the saved card off-session, and that charge can fail.

[Extended authorizations](https://docs.stripe.com/payments/extended-authorization) go up to 30 days, but only on IC+ pricing. On Visa, outside hotels, lodging, vehicle rental and cruises, Stripe adds 0.08% per transaction and the longer window only covers customer-initiated payments. Stripe also notes that many networks mean extended windows for cases where the final amount isn't known yet. A fixed deposit usually isn't that case.

### You capture once

For most card payments you get one capture. Capturing less than the hold releases the rest, and you can't capture the difference later. For more money later, charge the saved card.

### A hold looks like a charge

Some banks show an authorization the same way as a real charge, which confuses customers. Say so in the policy (the starter does).

### A no-show fee is a merchant-initiated charge on a saved card

Stripe's [rules for saving cards](https://docs.stripe.com/payments/cits-and-mits) ask you to put terms in your app that say when and how much you'll charge, to get explicit consent, and to keep a record of it. The starter shows the exact policy text before payment, needs a checkbox, and stores the text with the acceptance time on the booking (`policyLines`, `policyAcceptedAt`). If Stripe's card updater changes a card's brand, you need a new agreement before charging it off-session again.

### Card network rules

Visa's no-show rules for "guaranteed reservations" were written for hotels and a list of rental businesses ([Visa merchant guide, 2015](https://usa.visa.com/content/dam/VCOM/download/merchants/Guaranteed%20Reservations%20for%20Merchants%20VBS%2018.AUG.15.pdf)). We didn't find a special no-show transaction type for salons, studios or tutors. In a dispute, what protects you is a policy the customer saw and agreed to before paying. Ask Stripe or your acquirer how this applies to your merchant category.

### Off-session charges fail sometimes

The bank can decline, or ask the customer to authenticate (`authentication_required`). The backend records the amount as owed, and the app lets the customer pay it on-session.

### Refunds cost you

Stripe [doesn't return its processing fees](https://support.stripe.com/questions/understanding-fees-for-refunded-payments) when you refund. The starter also gives back your platform fee on every refund (`refund_application_fee: true`). Change that in `bookings.ts` if your terms keep it.

### Disputes land on the platform

With destination charges, Stripe takes disputed amounts and dispute fees from your balance. You can try to get the money back from the provider by reversing the transfer ([Stripe docs](https://docs.stripe.com/connect/destination-charges)). The starter only flags the booking.

### Connect account type

Stripe's docs now call Standard, Express and Custom legacy types and point new platforms to the Accounts v2 API or to v1 [controller properties](https://docs.stripe.com/connect/migrate-to-controller-properties). The starter uses v1 with the controller properties that match Express: Stripe-hosted onboarding, the Express Dashboard, your platform pays Stripe's fees, and your platform covers negative balances. That last one means fraud losses on provider accounts are yours, so vet who you onboard. Moving to Accounts v2 means changing `backend/src/services/connect.ts`.

### Connect details

Account links work once and expire after a few minutes, which is what `/connect/refresh` is for. HTTP return URLs only work in test mode, so set an HTTPS `PUBLIC_URL` for live. If your platform and a provider are in different regions, destination charges need `on_behalf_of` with some exceptions; see the [destination charges guide](https://docs.stripe.com/connect/destination-charges).

### App stores

Apps that sell real-world services have to take payment outside in-app purchase, which is why Stripe works here. Apple covers this in App Review Guideline 3.1.3(e), "Goods and Services Outside of the App" ([guidelines](https://developer.apple.com/app-store/review/guidelines/)).

### Minimum amounts

Stripe won't charge less than $0.50 in USD. [Other currencies](https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts) have their own minimums. Policy validation checks the USD one.

## Project layout

```
backend/
  src/domain/policy.ts      deposit math, strategy choice, cancellation window, policy text
  src/services/bookings.ts  booking lifecycle and every Stripe money movement
  src/services/connect.ts   connected accounts and onboarding
  src/services/webhooks.ts  signature check, dedupe, dispatch
  src/stripe/port.ts        the only file that calls stripe-node
  src/db.ts                 SQLite storage (swap for Postgres in a real app)
  src/http/app.ts           routes and the demo auth
  test/                     vitest suites and an in-memory fake Stripe
app/
  src/app/                  Expo Router screens
  src/lib/api.ts            backend client
  src/lib/usePaymentSheet.ts  PaymentSheet for PaymentIntents and SetupIntents
```

## Tests

```bash
cd backend
npm test         # 78 tests, no network
npm run typecheck
cd ../app
npm run typecheck
```

Stripe is replaced by `backend/test/fake-stripe.ts`, which keeps intents in memory and moves them through Stripe's statuses. The webhook tests sign payloads with stripe-node's own test helper, so signature checks run for real.

## Versions

Built and checked in October 2026 with Expo SDK 57 (React Native 0.86), `@stripe/stripe-react-native` 0.64 (the version Expo pins for SDK 57), stripe-node 23 (API version `2026-09-30`), Hono 4 and Node 22. In API version 2026-09-30, PaymentIntents take `allowed_payment_method_types`. Older examples use `payment_method_types`.

## Built by Rocketech

Built by [Rocketech](https://rocketech.it/marketplace-app-development). We build booking and marketplace apps, including the deposit and payout side. If you'd rather have us build yours, start at [rocketech.it/marketplace-app-development](https://rocketech.it/marketplace-app-development).

## License

MIT. See [LICENSE](LICENSE).
