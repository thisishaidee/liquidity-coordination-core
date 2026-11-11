# Deployment and verification checklist

## Required setup

1. Create a Cloudflare D1 database named `liquidity-coordination`.
2. Replace the placeholder `database_id` in `wrangler.toml`.
3. Apply migrations 0001 through 0007 to the intended database.
4. Set `ADMIN_BOOTSTRAP_TOKEN` as a Worker secret.
5. Configure a dedicated Solana RPC endpoint if the public endpoint is rate-limited.
6. Configure Telegram bot token, username and webhook secret only if Telegram alerts are enabled.

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

## Deployment

Do not deploy while the D1 database ID is still a placeholder. Apply migrations remotely before enabling traffic, then deploy with Wrangler. Confirm `GET /health`, `GET /`, the D1 binding and the Cron Trigger in the Cloudflare dashboard.

## Financial safety

- Never put wallet private keys in Worker secrets or agent API keys.
- Use a separate business-scope `api_payment` wallet for x402 charges.
- Keep operating wallets distinct from API-payment reserve wallets.
- Quotes and unsigned transactions require a business-controlled signer.
- Verify final on-chain settlement and refresh balances before allowing dependent tasks to proceed.
