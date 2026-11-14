# Controlled NERITH mainnet testing

**Purpose:** exercise the candidate website and payment engine against Solana mainnet without touching the production Worker or production D1 database.

## Isolation boundary

- Worker: `nerith-mainnet-testing`
- D1: `nerith-mainnet-testing` (`b6c15e88-5fb8-43b2-98b6-e2ee45338abd`)
- RPC: Solana mainnet
- USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- No scheduled trigger is configured.
- No production database binding, production Worker secret, or Telegram bot token is copied into this environment.
- The production Worker and database are not changed by this workflow.

The test Worker is deployed only by `.github/workflows/nerith-mainnet-test.yml` after typecheck and the full test suite pass. A successful deployment is not implied by the presence of this file; confirm the workflow and `/health` before testing.

## Wallet safety

- Use dedicated test wallets, not a primary treasury wallet.
- Never paste a seed phrase or private key into NERITH, Telegram, GitHub, or ChatGPT.
- Keep the x402 API-payment wallet separate from operating and payment-funding wallets.
- Wallet signatures must be reviewed and approved in the wallet application itself.
- Do not treat an internal reservation, quote, prepared transaction, or broadcast as settlement.
- Confirm finality and the resulting token balances before moving to the next leg.

## Suggested first test

1. Open the test Worker URL and create a test-only business workspace.
2. Register one operating wallet and one separate x402 API-payment wallet.
3. Verify ownership of each wallet by signing the one-time challenge shown by NERITH.
4. Assign the explicit reserve/payment roles and configure conservative limits.
5. Sync balances and confirm the UI marks snapshots fresh.
6. Create one low-value payment intent. Review the amount, mint, source and destination addresses, fee payer, signers, blockhash and fee cap before signing.
7. Sign from the wallet app. Confirm the Worker reports broadcast, then reconcile only after Solana finality.
8. For a two-wallet case, connect the exact required signers and sign the same immutable transaction message; do not edit or rebuild the message between signatures.
9. Verify that final payment preparation is unavailable until reserve replenishment has finalized and the payment wallet balance has been refreshed.

## Swap.io and x402 proof

The current candidate includes the Hermes proxy, x402 challenge parsing, payment-budget reservations, receipt parsing, and finalized receipt verification. The unpaid 402 capture in CI is not proof of a paid request.

A genuine proof requires:
1. Request a live quote without payment and inspect the returned 402 requirements.
2. Construct the exact USDC payment for the advertised amount, mint, recipient and facilitator.
3. Have the dedicated x402 wallet sign it in its wallet app; never expose its private key.
4. Retry the identical Hermes request with the documented V1 `X-PAYMENT` payload.
5. Confirm the response is HTTP 200 and includes a successful `X-PAYMENT-RESPONSE` receipt.
6. Verify the receipt transaction at finalized commitment and reconcile the x402 budget reservation.
7. Pay for `build-tx` separately if required, review the unsigned swap transaction, sign it with the operating wallet, broadcast it, and verify the actual finalized SOL debit and USDC credit.

The live challenge price is dynamic. Do not hardcode a fee from an example or exceed the configured business and agent limits. A quote payment and a build-tx payment are separate charges. A paid API call is not the same as a completed token swap.

## Required evidence before release

- One-wallet and two-wallet mainnet payment tests finalized and reconciled.
- Rejection, account-switch, wallet-disconnect, timeout, retry, duplicate-submit and stale-blockhash cases checked.
- A paid Hermes quote request and its on-chain x402 receipt verified.
- A paid Hermes build request and its receipt verified, if build-tx is part of the tested path.
- A signed Swap.io transaction finalized with the exact expected input debit and output credit.
- Android responsive QA at 320, 360 and 390 CSS-pixel widths, plus a desktop viewport.
- No production D1 migration or production deployment until a separate release review.

## Known boundary

This environment is for controlled testing, not public production use. Wallet availability and signing compatibility depend on the browser and wallet app. The Telegram Mini App is intentionally deferred until the same website payment engine has passed these gates.
