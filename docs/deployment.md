# Deployment and verification checklist

## Provisioned infrastructure

- Cloudflare D1 database: `liquidity-coordination`
- Database ID is configured in `wrangler.toml`.
- Migrations `0001` through `0012` have been applied to the dedicated database and recorded in `d1_migrations`.
- The Worker name is `liquidity-coordination-api`.
- The read-only dashboard is embedded into the Worker module from `public/index.html` during build.
- A one-minute Cron Trigger is configured for reservation expiry.

## Required secrets before deployment

Set the admin bootstrap token:

```bash
npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN
```

Optional Telegram secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_BOT_USERNAME
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Use long, random values. Never commit secrets or wallet private keys.

## Local verification

```bash
npm install
npm run typecheck
npm test
npx wrangler dev
```

Test the scheduled expiry handler locally with:

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"
```

## Deployment checks

After the Worker is deployed, verify:

1. `GET /health` returns the API health response.
2. `GET /` serves the responsive read-only dashboard.
3. D1 reads and writes use the dedicated liquidity database.
4. The one-minute Cron Trigger is active.
5. Agent and admin endpoints reject missing or invalid credentials.
6. Telegram linking works only through a private chat and a one-time invitation.
7. Conversion quotes are cached and minimum output is checked before transaction building.
8. Finalized swaps are independently verified from Solana transaction metadata.

## Financial safety

- Never put wallet private keys in Worker secrets or agent API keys.
- Use a separate business-scope `api_payment` wallet for x402 charges.
- Keep operating wallets distinct from API-payment reserve wallets.
- Quotes and unsigned transactions require a business-controlled signer.
- Verify final on-chain settlement and refresh balances before allowing dependent tasks to proceed.
- Internal reservations do not themselves transfer or spend funds.
