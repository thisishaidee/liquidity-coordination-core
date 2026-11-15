# NERITH remote Solana devnet test plan

**Status:** configuration and code are prepared on `feat/solana-devnet-cluster-config`; the remote devnet Worker has not yet been deployed. This document is a test plan, not evidence of a completed wallet transaction.

## Isolated resources

- Worker: `nerith-devnet-testing`
- Expected Worker URL: `https://nerith-devnet-testing.haideecoded-e0f.workers.dev`
- D1 database: `nerith-devnet-testing`
- D1 UUID: `e5d9ea84-e4f9-48fc-95c8-d78b19ffc13f`
- Solana cluster: devnet
- CAIP-2 chain ID: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`
- Devnet USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- RPC: `https://api.devnet.solana.com`

These resources are isolated from the production Worker and production D1. Never replace the devnet D1 binding with the production UUID and never use production wallet funds for this test.

## Network safety controls

- The Worker reads `SOLANA_CLUSTER` and exposes its canonical chain ID and USDC mint from `/health`.
- The dashboard loads `/health` before connecting or signing and passes the configured chain to the OKX adapter.
- The OKX connector supports the configured mainnet or devnet chain. Wallet Standard account discovery and transaction signing are filtered to the active chain.
- Jupiter Mobile is deliberately mainnet-only until its devnet network handoff has been verified. It must not be presented as a working devnet signer.
- Hermes x402 quote and reconciliation endpoints are mainnet-only and reject devnet requests.
- Before balance sync, funding preparation, signed transaction submission or settlement reconciliation, the Worker calls `getGenesisHash` and verifies that the RPC endpoint matches the configured CAIP-2 chain. It also checks that the configured USDC mint matches the cluster.
- Migration 0033 converts legacy mainnet ownership-challenge labels to canonical CAIP-2 and permits only the mainnet and devnet chain IDs.

## Deployment prerequisites

1. Deploy the Worker from this branch using `wrangler.devnet.remote.toml`; verify that it binds only to the devnet D1 UUID.
2. Apply migrations 0001–0033 only to the devnet D1 database.
3. Configure a dedicated test-only `ADMIN_BOOTSTRAP_TOKEN` in Cloudflare. Do not copy production tokens, Telegram bot secrets, or other production credentials into this Worker.
4. Keep Telegram disabled on this isolated Worker unless a separate test bot is explicitly provisioned.
5. Confirm the deployed `/health` response reports `status=ok`, `solanaCluster=devnet`, the devnet CAIP-2 chain ID, and the devnet USDC mint.
6. Confirm a read-only D1 query shows migration 0033 applied.

## Android test sequence

1. Open the devnet Worker dashboard in the Android browser or OKX in-app browser.
2. Connect the intended OKX devnet account and verify that the ownership challenge text contains the devnet CAIP-2 chain ID.
3. Sign the ownership challenge; confirm the Worker accepts it and stores the verified address.
4. Assign the operating and fee-payer roles only after the wallet is verified.
5. Prepare a small devnet USDC funding leg. Inspect the amount, source wallet, destination wallet, fee payer and estimated SOL fee before signing.
6. Sign through the connected OKX or another compatible Wallet Standard devnet wallet.
7. Confirm the Worker validates the signed bytes and broadcasts to devnet; record the transaction signature.
8. Reconcile only after finalized RPC evidence. Confirm the funding leg, fee ledger and reservation state match the chain.
9. Test reserve replenishment and final payment as separate transactions, each with its own signature and finalized settlement.
10. Repeat with a mismatched cluster or USDC mint configuration and confirm the Worker rejects it before preparing or broadcasting a transaction.

## Acceptance criteria

- No mainnet wallet is accepted as a devnet signing account.
- No mainnet RPC or mainnet USDC mint can pass the devnet Worker configuration checks.
- A cancelled or mismatched signature does not submit a transaction.
- The Worker does not mark a leg confirmed before finalized RPC evidence is checked.
- Ambiguous or failed settlement never releases reservations automatically.
- Every tested transaction has a recorded signature and independently verified finalized status.

**Not yet proven:** Android OKX signing, Android Wallet Standard handoff, any devnet broadcast, finality, or the two-leg replenishment/payment sequence. No production transaction is part of this test plan.
