# Setting up Pro payments (Firebase + Stripe + Cloudflare Worker)

This guide is for the steps only you can do: creating accounts and pasting keys. The code is
already written. Until you finish these steps, **nothing in the game is locked**: every player
keeps getting the Pro TAS Studio and the full AI Lab for free, exactly like before.

## Read this first

- **No paid plans needed.** Firebase stays on its free **Spark** plan (sign-in and the purchase
  database are free there), and the small payments server runs on Cloudflare Workers' free plan
  (100,000 requests a day, no card needed).
- **A Stripe account needs an adult account holder.** Stripe asks for the legal owner's identity
  (name, date of birth, address, sometimes an ID document) and a bank account for payouts. If
  you are under 18, a parent or guardian has to open and own the Stripe account.
- **Pro unlocks can be bypassed on a determined player's own computer.** The game is a static
  website and its code is public, so the lock is a "please support the game" lock, not real
  copy protection. The trustworthy record of who paid is the `users/{uid}` document in Firestore,
  which only the payments server can write. The game keeps a copy in the browser so Pro works
  offline; anyone can edit that copy, so never trust it for anything server-side (for example,
  don't hand out online rewards based on it).
- **Three secrets never go in the game's files or on GitHub:** the Stripe secret key (`sk_…`),
  the Stripe webhook secret (`whsec_…`) and the Google service account key (a `.json` file).
  They go only into Cloudflare's secret storage (step 8). The service account key can write to
  your whole database, so treat it like a password. The Firebase web config in step 2 is *not*
  secret; it is meant to be public.

## How the pieces fit

| Piece | Where it lives | What it does |
| --- | --- | --- |
| `js/services/config.js` | the game | your Firebase project's public config and the payments server's address |
| Firebase Auth | Firebase (free) | anonymous and Google sign-in, so purchases have an owner |
| Firestore `users/{uid}` | Firebase (free) | the real list of what each player bought |
| `worker/` | Cloudflare (free) | `/checkout` makes a $3 (or $5) Stripe Checkout page; `/webhook` hears from Stripe after a payment and unlocks the item |

When a player clicks **Unlock for $3**: the game asks the Worker for a Checkout page (proving who
the player is with their Firebase sign-in), the player pays on Stripe's page, Stripe tells the
Worker, the Worker writes `entitlements.pro_tas = true` into Firestore, and the game, which is
listening to that document, unlocks the feature.

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

## 4. Create the Firestore database and its rules

1. **Build → Firestore Database → Create database**. Pick **production mode** and a location near
   your players (for example `us-central`). The location can't be changed later.
2. Open the **Rules** tab, delete what's there, paste everything from this repo's
   `firestore.rules` file, and click **Publish**. These rules let each player read only their own
   purchases and stop anyone from writing them (the Worker writes as a service account, which the
   rules don't apply to).

## 5. Download a service account key (lets the Worker record purchases)

1. Firebase console → ⚙️ **Project settings → Service accounts**.
2. Click **Generate new private key** → **Generate key**. A `.json` file downloads (its name
   looks like `penguin-track-1a2b3-firebase-adminsdk-….json`).
3. Leave it in your Downloads folder. **Don't** move it into the game's folder or upload it
   anywhere. You'll hand it to Cloudflare in step 8 and can delete it afterwards.

## 6. Create the Stripe account (test mode first)

1. Sign up at https://dashboard.stripe.com/register (the adult account holder from "Read this
   first"). You can use **test mode** right away, before Stripe has checked the identity details.
2. Make sure the **Test mode** switch (top right) is on.
3. **Developers → API keys**: you'll need the **Secret key** (`sk_test_…`) in step 8.

You don't need to create products or prices in Stripe: the Worker sets the item name and the
price ($3.00, or $5.00 for the bundle) itself.

## 7. Create the Cloudflare account (free)

1. Sign up at https://dash.cloudflare.com/sign-up.
2. Open **Workers & Pages** once. Cloudflare asks you to pick a **workers.dev subdomain** (for
   example `silverninja`). Your server's address will be
   `https://penguintrack-payments.<subdomain>.workers.dev`.

## 8. Deploy the Worker

You'll type these in Terminal. Each block is one command. You need Node.js 18 or newer
(https://nodejs.org; check with `node -v`). These steps use your normal copy of the game, so
merge the pull request and pull it first.

1. Go to the Worker's folder and install its one tool (Wrangler, Cloudflare's command-line tool):

   ```bash
   cd ~/Downloads/mace-split/Penguin-Track/worker
   ```

   ```bash
   npm install
   ```

2. Open `worker/wrangler.toml` in a text editor and set `FIREBASE_PROJECT_ID` to your project ID
   from step 1. `APP_URLS` is where players come back after paying; it's already set to the
   GitHub Pages address. To also test on your own computer, add your local address after a comma,
   for example `"https://silverninja71.github.io/Penguin-Track/,http://localhost:8080/Penguin-Track/"`.

3. Sign in to Cloudflare (this opens your browser once):

   ```bash
   npx wrangler login
   ```

4. Deploy. At the end it prints the server's address; copy it:

   ```bash
   npx wrangler deploy
   ```

5. Store the secrets. The first command asks you to paste the Stripe secret key (`sk_test_…`):

   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY
   ```

   The service account key goes in straight from its file. Replace the file name with yours
   (typing `~/Downloads/penguin` and pressing Tab fills it in):

   ```bash
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT < ~/Downloads/YOUR-KEY-FILE.json
   ```

   You can now delete that `.json` file from Downloads.

6. Open the server's address in your browser. It should say
   "Penguintrack payments server is running."

7. Put the address into the game: in `js/services/config.js`, set `PAYMENTS_API_URL` to it
   (no slash at the end), for example `'https://penguintrack-payments.silverninja.workers.dev'`.

## 9. Connect Stripe's webhook

1. Stripe dashboard (test mode) → **Developers → Webhooks → Add endpoint**.
2. **Endpoint URL**: your server's address followed by `/webhook`, for example
   `https://penguintrack-payments.silverninja.workers.dev/webhook`.
3. **Events**: `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
4. Save, then click **Reveal** under **Signing secret** and copy it (`whsec_…`).
5. Store it (from the `worker` folder; it takes effect straight away):

   ```bash
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

## 10. Publish and test

1. Commit the filled-in `js/services/config.js` and `worker/wrangler.toml` and push them so
   GitHub Pages serves the new config. (They hold no secrets.)
2. Open the game, go to TAS → **Pro TAS Studio**. The paywall appears.
3. Click **Unlock for $3**. On Stripe's test checkout use card `4242 4242 4242 4242`, any future
   expiry date, any 3-digit CVC and any postcode.
4. You land back in the game with a "Payment received" message, and a moment later "Pro TAS
   Studio unlocked". In Firestore you'll see `users/<uid>` with `entitlements.pro_tas: true`.

If it doesn't unlock:
- Stripe dashboard → Webhooks → your endpoint lists each delivery and the Worker's answer.
- This shows the Worker's log live while you try again (run it in the `worker` folder):

  ```bash
  npx wrangler tail
  ```

- A message like "The payments server is missing GOOGLE_SERVICE_ACCOUNT" means that secret
  wasn't stored; repeat its step.

## 11. Going live with real money

1. Finish Stripe's account activation (identity and bank details).
2. Switch the dashboard to **live mode**. Store the live secret key (`sk_live_…`) with
   `npx wrangler secret put STRIPE_SECRET_KEY`, add a live webhook endpoint (same URL, same
   events) and store its signing secret with `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
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
- **A leaked key**: if a secret ever ends up somewhere public, replace it. In Stripe, roll the key
  (Developers → API keys); for the service account, delete the key in Google Cloud console → IAM →
  Service accounts and generate a new one; then store the new value with `npx wrangler secret put`.
- **The hub account**: the game still uses the Empire hub's shared account (gold for medals) when
  `../Empire/shared/accounts.js` is there, but now loads it on demand and plays as a guest when it
  is missing. Set `SITE_ACCOUNTS_URL` to `null` in `config.js` to stop loading it.
