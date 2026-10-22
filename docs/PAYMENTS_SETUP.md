# Setting up Pro payments (Firebase + Stripe)

This guide is for the steps only you can do: creating accounts, adding billing, and pasting keys.
The code is already written. Until you finish these steps, **nothing in the game is locked**:
every player keeps getting the Pro TAS Studio and the full AI Lab for free, exactly like before.

## Read this first

- **Cloud Functions need Firebase's paid "Blaze" plan.** Blaze is pay-as-you-go and needs a
  credit or debit card on file. At this game's size the cost should be zero or a few cents a month
  (there is a generous free allowance), but it is a real billing account. Set a budget alert
  (Google Cloud console → Billing → Budgets & alerts) so you get an email if anything grows.
- **A Stripe account needs an adult account holder.** Stripe asks for the legal owner's identity
  (name, date of birth, address, sometimes an ID document) and a bank account for payouts. If
  you are under 18, a parent or guardian has to open and own the Stripe account.
- **Pro unlocks can be bypassed on a determined player's own computer.** The game is a static
  website and its code is public, so the lock is a "please support the game" lock, not real
  copy protection. The trustworthy record of who paid is the `users/{uid}` document in Firestore,
  which only the payment webhook can write. The game keeps a copy in the browser so Pro works
  offline; anyone can edit that copy, so never trust it for anything server-side (for example,
  don't hand out online rewards based on it).
- **Never put the Stripe secret key (`sk_…`) or webhook secret (`whsec_…`) in the game's files.**
  They go into Firebase's secret storage (step 6). The Firebase web config in step 2 is *not*
  secret; it is meant to be public.

## What you'll end up with

| Piece | Where it lives | What it does |
| --- | --- | --- |
| `js/services/config.js` | the game | your Firebase project's public web config |
| Firebase Auth | Firebase | anonymous and Google sign-in, so purchases have an owner |
| Firestore `users/{uid}` | Firebase | the real list of what each player bought |
| `createStripeCheckoutSession` | Cloud Function | makes a $3 (or $5) Stripe Checkout page |
| `stripeWebhook` | Cloud Function | Stripe calls it after a payment; it unlocks the item |

## 1. Create a Firebase project (free)

1. Go to https://console.firebase.google.com and click **Add project**. Any name works, for
   example `penguin-track`. Google Analytics is optional (you can turn it off).
2. Write down the **project ID** (shown under the name, like `penguin-track-1a2b3`).

## 2. Add a web app and copy its config into the game

1. In the project, click the **</>** (Web) icon to add a web app. Name it `Penguintrack`. You
   don't need Firebase Hosting (the game stays on GitHub Pages).
2. Firebase shows a `firebaseConfig = { apiKey: …, authDomain: …, … }` block.
3. Open `js/services/config.js` and replace each `YOUR_…` value in `FIREBASE_CONFIG` with the
   matching value. Keep the quotes.

## 3. Turn on sign-in

1. Firebase console → **Build → Authentication → Get started**.
2. **Sign-in method** tab: enable **Anonymous** and **Google** (Google asks for a support email).
3. **Settings → Authorized domains**: add `silverninja71.github.io`. (`localhost` is already there.)

Google sign-in opens a small Google pop-up window; if the browser blocks pop-ups the game falls
back to a full-page redirect.

## 4. Create the Firestore database

1. **Build → Firestore Database → Create database**. Pick **production mode** and a location near
   your players (for example `us-central`). The location can't be changed later.
2. The security rules come from this repo's `firestore.rules` file in step 6, so you don't need to
   type any rules by hand.

## 5. Switch to the Blaze plan

Firebase console → the **Spark** plan badge (bottom left) → **Upgrade** → **Blaze**. This is the
billing step from "Read this first". Add the budget alert while you're there.

## 6. Install the tools and deploy the Cloud Functions

You'll type these in Terminal. Each line is one command.

1. Install Node.js 20 or newer if you don't have it (https://nodejs.org). Check with `node -v`.
2. Install the Firebase command-line tool and sign in (this opens your browser once):

   ```bash
   npm install -g firebase-tools
   ```

   ```bash
   firebase login
   ```

3. Go to the game's folder and pick your project (choose the project from step 1, alias `default`):

   ```bash
   cd ~/Downloads/mace-split/Penguin-Track
   ```

   ```bash
   firebase use --add
   ```

4. Install the functions' libraries:

   ```bash
   npm --prefix functions install
   ```

5. Store the Stripe secret key (from step 7 below; you can do step 7 first). The command asks you
   to paste it; it is stored encrypted in Google Cloud, not in any file:

   ```bash
   firebase functions:secrets:set STRIPE_SECRET_KEY
   ```

   For now also set a temporary webhook secret (type `whsec_placeholder`); you'll replace it in
   step 8 once Stripe gives you the real one:

   ```bash
   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
   ```

6. Deploy the functions and the Firestore rules:

   ```bash
   firebase deploy --only functions,firestore:rules
   ```

   The first deploy asks for `APP_URLS`: press Enter to accept
   `https://silverninja71.github.io/Penguin-Track/`. That's where Stripe sends players back after
   paying. To test on your own computer too, give a comma-separated list, for example
   `https://silverninja71.github.io/Penguin-Track/,http://localhost:8080/Penguin-Track/`.
   (Your answer is saved in `functions/.env.<project-id>`, which is fine to keep: it isn't secret.)

7. At the end the deploy prints a URL for **stripeWebhook**, like
   `https://us-central1-penguin-track-1a2b3.cloudfunctions.net/stripeWebhook`. Copy it.

## 7. Create the Stripe account (test mode first)

1. Sign up at https://dashboard.stripe.com/register (the adult account holder from "Read this
   first"). You can use **test mode** right away, before Stripe has checked the identity details.
2. Make sure the **Test mode** switch (top right) is on.
3. **Developers → API keys**: copy the **Secret key** (`sk_test_…`). That's the value for
   `STRIPE_SECRET_KEY` in step 6.5. Don't paste it anywhere else.

You don't need to create products or prices in Stripe: the Cloud Function sets the item name and
the price ($3.00, or $5.00 for the bundle) itself.

## 8. Connect Stripe's webhook

1. Stripe dashboard (test mode) → **Developers → Webhooks → Add endpoint**.
2. **Endpoint URL**: the `stripeWebhook` URL from step 6.7.
3. **Events**: `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
4. Save, then click **Reveal** under **Signing secret** and copy it (`whsec_…`).
5. Store it and redeploy:

   ```bash
   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
   ```

   ```bash
   firebase deploy --only functions
   ```

## 9. Publish and test

1. Commit the filled-in `js/services/config.js` and push it so GitHub Pages serves it.
2. Open the game, go to TAS → **Pro TAS Studio**. The paywall appears.
3. Click **Unlock for $3**. On Stripe's test checkout use card `4242 4242 4242 4242`, any future
   expiry date, any 3-digit CVC and any postcode.
4. You land back in the game with a "Payment received" message, and a moment later "Pro TAS
   Studio unlocked". In Firestore you'll see `users/<uid>` with `entitlements.pro_tas: true`.

If it doesn't unlock: Stripe dashboard → Webhooks → your endpoint shows each delivery and its
response, and `firebase functions:log` shows what the functions printed.

## 10. Going live with real money

1. Finish Stripe's account activation (identity and bank details).
2. Switch the dashboard to **live mode** and repeat steps 7.3 and 8 with the live keys: set
   `STRIPE_SECRET_KEY` to the `sk_live_…` key, add a live webhook endpoint (same URL) and set
   `STRIPE_WEBHOOK_SECRET` to its `whsec_…`, then `firebase deploy --only functions`.
3. Buy something yourself once to check, then refund it from the Stripe dashboard if you like.

Stripe takes a small fee per payment (about 30¢ + 2.9% in the US, so roughly $2.61 of each $3
reaches you). You are responsible for any sales tax or income tax rules where you live; Stripe Tax
can help with sales tax.

## Good to know

- **Restore purchase / Sign in** (in the paywall and on the menu) signs in with Google. If a
  player bought as an anonymous guest, signing in links Google to that same account, so the
  purchase carries over. If they clear their browser data *before* signing in, an anonymous
  purchase can't be recovered by the game; you can still look it up in Stripe (the payment's
  metadata has the `uid`) and set `entitlements` in Firestore by hand.
- **Lock on/off switch** (`PRO_GATING` in `js/services/config.js`): `'auto'` (default) locks Pro only
  once Firebase is configured; `'on'` always locks; `'off'` never locks.
- **Testing locally** (only on `localhost`): add `?pro=locked` to the address to see the paywall
  without Firebase, `?pro=dev` to unlock everything, `?pro=off` to go back to normal.
- **The hub account**: the game still uses the Empire hub's shared account (gold for medals) when
  `../Empire/shared/accounts.js` is there, but now loads it on demand and plays as a guest when it
  is missing. Set `SITE_ACCOUNTS_URL` to `null` in `config.js` to stop loading it.
