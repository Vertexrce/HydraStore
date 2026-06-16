# Vertex 6X — Stripe Webhook + Zip File Update

## What changed
- `server.js` — full replacement with Stripe Checkout Sessions, webhook, zip file support
- `checkout-success.html` — new success page shown after payment
- `package.json` — added `stripe` dependency

## Setup steps

### 1. Add environment variables
Add these to your `.env` file (or hosting platform env settings):

```
STRIPE_SECRET_KEY=sk_live_...         ← Your Stripe secret key (live mode)
STRIPE_WEBHOOK_SECRET=whsec_...       ← From step 3 below
BASE_URL=https://yourdomain.com       ← Your actual site URL (no trailing slash)
```

### 2. Install the new dependency
Run this in your project folder:
```
npm install
```

### 3. Set up the Stripe webhook
1. Go to https://dashboard.stripe.com/webhooks
2. Click **"Add endpoint"**
3. Endpoint URL: `https://yourdomain.com/stripe-webhook`
4. Select event: `checkout.session.completed`
5. Click **"Add endpoint"**
6. Copy the **Signing secret** (starts with `whsec_`) → paste as `STRIPE_WEBHOOK_SECRET`

### 4. Fix the stripe_link field for your items
In your admin panel, the **Stripe Link** field must now be a **Stripe Price ID**:
- Go to https://dashboard.stripe.com/products
- Click your product → find the Price → copy the ID (e.g. `price_1abc2def...`)
- Paste that into the **Stripe Link** field in your admin panel

### 5. (Optional) Add zip files to items
In your admin panel, a new **Zip URL** field will appear (once you update the admin.html too).
Paste a direct download link (Google Drive, Dropbox, etc.) and customers will get a download
button on the success page after paying.

### 6. Replace your files
- Copy `server.js` → replace your existing server.js
- Copy `checkout-success.html` → add to your project root
- Copy `package.json` → replace your existing package.json
- Run `npm install`
- Restart your server

## How it works now
1. Customer clicks "Pay with Card (Stripe)" 
2. Your server creates a real Stripe Checkout page using the Price ID
3. Customer enters their card on Stripe's secure hosted page
4. Stripe takes payment and fires a webhook to your server
5. Your server: records the purchase, assigns the Discord role (if they were logged in), logs to Discord
6. Customer lands on /checkout-success and sees their confirmation + download button (if set up)
