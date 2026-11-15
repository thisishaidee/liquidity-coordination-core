# NERITH PR integration review — 15 November 2026

**Review base:** `main` at `a8307d4ba7742717b9d9893d1e66c8554f636501`  
**Candidates:** PR #51 `feat/autonomous-liquidity-foundation`; PR #52 `feat/solana-wallet-ownership-proof`  
**Scope:** ancestry, overlapping schema/core/UI changes, wallet adapters, devnet test readiness, payment release gates.  
**Actions:** read-only review. No PR merged, no production D1 writes, no production deploy, no wallet signatures or broadcasts.

## 1. Integration decision

**PR #52 is the superset candidate. Do not merge PR #51 and PR #52 independently.**

Evidence:
- Both branches contain byte-identical `migrations/0025_wallet_role_assignments.sql`.
- Both modify `src/core.ts`, `src/index.ts`, `src/admin-auth.ts`, `src/business-dashboard.ts`, `public/dashboard.html`, and the same tests.
- Comparing PR #51's head with PR #52's head reports PR #52 ahead by 469 commits and behind by one commit. The sole commit on PR #51 not present in PR #52 is `8d000acb2d75a5bd30ef07fbd36935a830f28771`, titled **“Fix wallet role API table formatting”**. Its only change is a README Markdown line-break/table formatting correction; it adds no runtime, schema, wallet or payment behavior.
- PR #52 therefore already contains the substantive wallet-role/planner foundation from PR #51 plus the ownership proof, payment intent, funding-leg and settlement work. PR #51 should be treated as superseded, not stacked or merged after #52.

Suggested repository housekeeping after the candidate has been fully validated: close PR #51 with a superseded-by-PR-52 explanation, or leave it open until the final PR #52 release review is complete. No need to cherry-pick the README-only formatting commit.

## 2. Wallet and payment code review

The candidate separates address ownership proof from spending authority and keeps the browser wallet as signer. The Worker verifies the signed legacy transaction against the immutable funding leg before broadcast. Settlement is separate and requires finalized RPC evidence. The implementation rejects extra instructions in the funding-leg transaction and checks the exact checked-USDC transfer, source/destination ATAs, mint, amount, decimals, fee payer and signatures.

The architecture document correctly states that:
- address proof is not beneficial-ownership proof or spending authority;
- the current Ed25519 message challenge does not support PDA/Squads vault ownership;
- USDC delegate authority is not arbitrary swap authority;
- conversion, final USDC payment and Hermes x402 API fees are distinct operations;
- no global NERITH hot signer or autonomous production signer is approved.

**No funded transaction is proven.** Passing tests, Worker dry-run, local D1 integration and an unpaid Hermes 402 challenge do not establish real wallet signing, broadcast, finality, paid x402 settlement or successful two-leg replenishment/payment. Keep the candidate unapproved for production funds until device signing and finalized devnet settlement are demonstrated.

## 3. Android/devnet blocker found

The remote devnet test setup is not currently ready for an Android wallet round-trip:

- Cloudflare lists D1 database `nerith-devnet-testing` (`e5d9ea84-e4f9-48fc-95c8-d78b19ffc13f`), but a read-only query confirms it has no application tables or migration ledger yet.
- Cloudflare's Worker list does not contain a `nerith-devnet-testing` Worker. The configured devnet test Worker has therefore not been deployed.
- `wrangler.devnet.remote.toml` points at `https://nerith-devnet-testing.workers.dev` and `https://nerith-devnet-testing.pages.dev`, but those routes have not been established in Cloudflare. The config does not set `workers_dev = true`; the worker hostname must not be assumed live.
- The current OKX connector hardcodes the Solana mainnet chain identifier. The Jupiter/Reown bridge also hardcodes mainnet chain metadata, the mainnet USDC mint and `https://api.mainnet-beta.solana.com`. Those adapters cannot be used as a genuine devnet signing test simply by pointing the Worker at devnet RPC.
- The mainnet-test Worker and database are separate and healthy, but they are explicitly mainnet testing resources, not a devnet substitute.

Required before mobile devnet QA:
1. Make the wallet adapter cluster-aware (network, chain identifier, RPC and USDC mint all selected from a validated environment configuration; no silent mainnet fallback).
2. Provision/deploy the dedicated devnet Worker and apply migrations only to its dedicated D1 database.
3. Set the exact devnet test origin and allowed-origin configuration, verify the public health endpoint, and confirm the deployed Worker is bound to the devnet D1 UUID.
4. Test Android connect, ownership message signing, transaction signing, signed-byte return, Worker verification, broadcast and finalized settlement with devnet test tokens.
5. Test reserve replenishment and final payment as two distinct finalized transactions. Record each signature and reconcile both from finalized RPC.

Do not use the mainnet-test Worker for this devnet sequence, and do not send real funds to the test environment.

## 4. Cloudflare D1 evidence

A direct read-only query to the isolated mainnet-test D1 succeeds:
- Migration ledger contains `0001_initial.sql` through `0032_funding_leg_fee_ledger.sql`.
- Current test data: 1 business, 1 agent, 2 wallets, 0 operations and 0 business payment intents.

The devnet D1 exists but is empty/unmigrated.

The production D1 UUID was initially mistyped in the first query, causing the 404. Cloudflare's exact-name listing returned `1b3d32d5-6e1c-490d-a550-c06baf8b918e`; read-only queries against that database now succeed. Production has migrations `0001–0024` only; migrations `0025–0032` are not applied. Current production data is 1 business, 1 agent, 2 active business wallets, 4 zero-value balance snapshots, 1 blocked operation with no transaction hash, and 0 reservation rows. The new payment-intent and funding-leg tables are absent, as expected before candidate release.

A read-only preview of the exact `0025_wallet_role_assignments.sql` backfill mapping against the two existing production wallets yields:
- the existing `api_payment` wallet maps to enabled role `api_payment`;
- the existing `operating` wallet maps to enabled role `operating`.

This is the expected migration outcome for the current production records. The isolated mainnet-test database's two wallet rows were seeded after its migration ledger had already reached 0032, so its role-assignment table is empty; that isolated fixture does not exercise the existing-wallet backfill path. Add an explicit migration test that inserts legacy wallets before applying migration 0025, then verifies both role rows are backfilled.

## 5. Deployment safety

The current CI workflow deploy job runs on pushes to `main`, applies pending production D1 migrations remotely, and then deploys the Worker. Merging PR #52 would therefore trigger a production schema/deploy path after CI passes. Production migration state is now verified, and the reservation table is empty. This removes the earlier unknown-ledger/active-hold blocker, but does not make the candidate production-ready: the existing blocked operation must be preserved, the candidate migrations still need a reviewed preflight against the live schema, and real Android wallet signing/finalized payment settlement remain unproven. Do not merge or deploy this candidate until those release gates pass.

Before release, add a production migration preflight/snapshot and explicit review of active, submitted, failed and ambiguous reservations. Preserve all ambiguous holds. Keep migration application and Worker deployment as separately observable steps with a tested rollback/forward-recovery plan.

The candidate CI still uses mutable GitHub Action major tags and `npm install`; the branch's own security audit correctly records supply-chain hardening as an open medium-priority item. This is not the immediate blocker to isolated devnet testing, but should be addressed before production funds are enabled.

## 6. Next implementation sequence

1. Keep PR #52 as the sole integration candidate; do not merge PR #51 separately.
2. Refactor wallet adapters to support an explicit devnet configuration without changing the existing mainnet defaults for production.
3. Provision the remote devnet Worker against the already-created empty devnet D1 database; apply candidate migrations only there.
4. Run the full Android signing and finalized-settlement test matrix.
5. Verify the Telegram webhook/approval/notification round-trip separately; current health configuration is not proof of webhook registration or delivery.
6. Re-check production D1 migration and reservation state through an authorized working path.
7. Only then prepare a production release plan and decide whether PR #52 can be marked ready and merged.

**Current release status: production health is green; candidate code is testable in isolation; Android devnet wallet execution is not yet ready; real payment execution remains unproven.**


### Additional finding — OKX/Jupiter funding signer gap addressed in PR #52

The first source-level review found that the payment funding-leg signer only iterated Wallet Standard providers, even though the page separately initialized OKX and Jupiter adapters. That could allow wallet connection/ownership proof to succeed while the funding transaction could not be signed by that same adapter.

A candidate fix has now been committed directly to PR #52's branch:
- `scripts/okx-wallet-connector.js` now exposes `canSignFor` and `signFundingTransaction`, supporting both the injected OKX provider and OKX App Connect. It deserializes the exact prepared transaction, checks the expected signer slot, and preserves partial signatures.
- `wallet-connect/jupiter-mobile-connector.jsx` now exposes equivalent funding-leg signing methods for the currently connected Jupiter account.
- `public/dashboard.html` now calls those adapters for each required funding-leg signer after the Wallet Standard path, then re-checks the prepared message digest before submission.
- `test/responsive-layout.test.ts` now has regression assertions that the dashboard calls both adapters and that the generated bundles expose their signer methods.
- `docs/WALLET_HANDOFF_CROSS_PLATFORM.md` now distinguishes implementation support from device-verified support.

The change is on `feat/solana-wallet-ownership-proof` and is still candidate code. GitHub Actions run `43663894209` is currently validating it; the unpaid Hermes 402 probe passed, while typecheck, automated tests, Worker dry-run and local Worker/D1 replay are still running. No Android wallet signing or funded transaction has been tested yet. This is not a claim that OKX/Jupiter device handoff is now verified.


### Additional network-safety work — canonical mainnet/devnet separation

PR #52 now also contains:
- `SOLANA_CLUSTER` configuration with canonical CAIP-2 identifiers for mainnet and devnet and the matching USDC mint for each cluster.
- Migration 0033, which converts legacy ownership challenges from `solana:mainnet-beta` to the canonical mainnet chain ID and permits the devnet chain ID. It temporarily drops and restores the wallet identity-change trigger while rebuilding the constrained table.
- A dashboard preflight that reads `/health` before wallet connection/signing, selects the Worker-configured chain, and filters Wallet Standard accounts accordingly.
- An OKX adapter that uses the configured chain. Jupiter Mobile remains explicitly mainnet-only until devnet handoff is tested.
- Mainnet-only Hermes x402 gates in both UI and Worker.
- An RPC preflight that checks `getGenesisHash` against the configured chain and checks the USDC mint before balance sync, funding preparation, transaction submission and settlement reconciliation.

The first CI run exposed two real issues: a TypeScript narrowing error after the RPC preflight and a SQLite trigger dependency when rebuilding the ownership-challenge table. Both were corrected. A brittle x402 route test was replaced by a direct unit test of the explicit mainnet-only policy. CI run `43665281655` is now validating the revised branch; the unpaid Hermes 402 evidence has passed, while typecheck/tests and local D1 replay are still in progress. No remote devnet Worker deployment or wallet transaction has occurred.


**Latest CI status:** run `43665493544` has passed the verification job (typecheck, full automated tests and Wrangler dry-run) and the unpaid Hermes 402 evidence job. The isolated local Worker/D1 replay is still running; it has not yet reported a final result. No Worker deployment or signed/broadcast transaction has been performed.


### Isolated remote devnet deployment — 15 November 2026

- Dedicated D1 database `nerith-devnet-testing` (`e5d9ea84-e4f9-48fc-95c8-d78b19ffc13f`) was confirmed empty before migration.
- All migrations 0001–0033 were applied to that isolated database. A read-only query confirmed all 33 migration names in `d1_migrations`.
- Worker `nerith-devnet-testing` was deployed successfully to `https://nerith-devnet-testing.haideecoded-e0f.workers.dev`.
- Live `/health` returned `status=ok`, `database=connected`, `solanaCluster=devnet`, the canonical devnet CAIP-2 chain ID, and the devnet USDC mint.
- Public dashboard and workspace setup routes resolve. The dashboard correctly requires an authenticated business session.
- Telegram is intentionally unconfigured in this isolated environment. No production Telegram credentials or production D1 bindings were copied.
- The first automated post-deploy check received an HTML response immediately after deployment propagation; a subsequent deployment and live fetch returned the expected JSON health response. A retry loop was added to the deploy workflow to avoid false failures during propagation.
- `ADMIN_BOOTSTRAP_TOKEN` is not yet configured on the isolated Worker. This secret must be set by the account owner in Cloudflare before creating a devnet test workspace. No secret value has been generated, stored, or exposed.
- No wallet has been connected, no message signed, no transaction prepared/broadcast, and no funds moved.
