# NERITH autonomous liquidity architecture

**Status:** Working implementation specification, 14 November 2026  
**Scope:** Multi-wallet liquidity coordination, autonomous execution authority, Swap.io fallback, website and Telegram transaction experiences.

This document records the product contract that implementation must preserve. It does not claim that autonomous signing, wallet-to-wallet transfers, or transaction execution are already live.

## 1. Product objective

NERITH coordinates business-owned liquidity so an authorised agent can satisfy a business payment obligation even when the owner is offline. It first uses available payment-asset liquidity, replenishes the designated payment wallet from authorised reserve wallets when required, and uses Swap.io/Hermes to convert approved alternative assets when permitted USDC liquidity is insufficient.

NERITH is not a custodial wallet. The business controls ownership and revocation of every wallet and every execution authority. The AI model may propose an action; deterministic policy enforcement must decide whether the action is permitted.

## 2. Wallet model

A business may register multiple Solana wallets. Each record has a verified owner/business association, network, address, status, permitted assets, and one or more explicit purposes:

- `payment`: preferred source for an outgoing payment.
- `reserve`: eligible to replenish another registered business wallet.
- `operating`: general business operating liquidity; usable only under explicit policy.
- `receiving`: approved destination for incoming payments.
- `api_payment`: dedicated USDC wallet for Hermes x402 API access fees. Never count it as business payment liquidity.

A wallet can have multiple purposes only where the business explicitly configures that combination. A receiving address is not automatically an authorised source. An API-payment wallet is never an operating or reserve wallet by default.

Wallet registration must prove control of the address using a domain/network-bound, short-lived challenge. The challenge signature proves address control only; it does not grant spending authority. Wallet ownership, business membership, wallet role, and agent execution authority are separate concepts.

## 3. Liquidity decision order

For a payment denominated in USDC:

1. Read fresh confirmed balances for the business's active, eligible wallets.
2. Exclude API-payment wallets, stale snapshots, disabled wallets, reserved amounts, and balances outside the agent's business scope.
3. Use the designated payment wallet's available USDC first.
4. If it is short, calculate the exact USDC replenishment required.
5. Select one or more eligible reserve/operating wallets with spendable USDC, preserving each wallet's configured minimum reserve balance and per-transfer limit.
6. If USDC reserves cannot cover the shortfall, evaluate approved alternative assets. For SOL, obtain a live Swap.io/Hermes quote and verify expected net output, price impact, slippage, fees, quote expiry and all business limits before preparing an unsigned transaction.
7. Never start the original payment until required replenishment/conversion is confirmed on-chain and the payment wallet's balance is refreshed.
8. Do not partially execute the original payment unless the business has explicitly enabled partial settlement.

A deterministic allocator may produce a proposed funding plan. A plan is not a reservation, transfer, signature, or settlement. Funds must be atomically reserved in the ledger before execution, with idempotency and concurrency controls.

## 4. Autonomous execution authority

Owner-offline execution is a core capability, but it must not be implemented by placing an unrestricted private key in the Worker or AI context.

Before enabling autonomy, the architecture must select and security-review an execution authority model. Candidates include a program-controlled treasury with business-owned upgrade/owner/recovery controls, or a narrowly scoped delegated authority where the underlying Solana programs and token-account semantics support the exact operation. Ordinary SPL token delegate authority does not automatically authorise native SOL transfers, arbitrary swaps, or every transaction instruction.

The selected model must prove:
- Business retains ultimate ownership and recovery control.
- Agent authority is limited by business, wallet, asset, destination, amount, time and operation.
- Policy enforcement is deterministic and independent of model output.
- Revocation and emergency pause are available and have defined finality.
- The executor cannot substitute transaction instructions after approval.
- All transaction intents and outcomes are auditable.
- Key material is isolated in an appropriate signer boundary, never exposed to browser JavaScript, Telegram, model prompts, logs or ordinary Worker environment variables.

Do not enable production autonomous signing until this decision and threat model are approved and tested.

## 5. Policy controls

At minimum, a business policy must support:
- Per-operation and daily limits.
- Per-wallet and per-asset limits.
- Approved source and destination wallet allowlists.
- Reserve minimums.
- Fee, slippage and price-impact caps.
- Agent-specific scopes.
- Policy expiry and signer-authority expiry.
- Replay protection and idempotency.
- Emergency pause/revocation.
- Explicit handling of ambiguous submissions and RPC uncertainty.

AI selects among allowed actions. The policy engine validates exact transaction intent and rejects everything outside policy.

## 6. Swap.io / Hermes / x402

Swap.io remains a core conditional liquidity source, not a mandatory step for every payment.

- Existing USDC is preferred.
- Existing authorised USDC reserves are preferred over conversion where policy and cost permit.
- Approved SOL (and future explicitly supported assets) may be converted when the USDC shortfall remains.
- Hermes quote/build calls use the existing fixed upstream integration and x402 controls.
- x402 API access payment is separate from the SOL-to-USDC swap and from the final business payment.
- The dedicated `api_payment` wallet pays the x402 API fee. It must not be confused with the operating wallet or swap source wallet.
- A returned unsigned swap transaction must be validated against the server-issued quote and policy before the authorised signer accepts it.
- Paid end-to-end Hermes execution and autonomous swap settlement remain unverified until a controlled test demonstrates them.

## 7. Transaction state machine

Each replenishment, conversion and final payment is a distinct transaction intent with its own idempotency key and on-chain signature:

`draft → policy_checked → reserved → prepared → awaiting_signature` (manual/assisted) or `authorised_for_execution` (approved autonomous policy) `→ submitted → confirmed | failed | expired | ambiguous`.

For sequential replenishment:
1. Transfer USDC from reserve wallet(s) to payment wallet.
2. Verify finality and actual received amount.
3. Refresh payment-wallet balance.
4. Prepare and execute the original payment.
5. Verify receiver credit/settlement where observable.

If replenishment succeeds but payment fails, funds remain in the payment wallet. NERITH must report this accurately and support an explicitly authorised retry or return transfer. It must never pretend the two independent transactions are atomic.

## 8. Interfaces

### Website
Business workspace includes wallet registry and roles, policy configuration, payment/transaction centre, quote and transaction review, signer connection/handoff, execution history, receiver details and verified settlement state. The agent console remains scoped to the agent's permissions and must not expose business owner secrets.

### Telegram
The bot handles initiation, request management, approvals, alerts and status. A Telegram Mini App handles secure transaction review and wallet handoff. Telegram chat approval is a business decision, not a blockchain signature. Mini App identity must use verified Telegram `initData`, short-lived scoped sessions and business-role checks. Wallet signing occurs in the user's compatible wallet or approved delegated executor.

### Receiver
The receiving business sees sender, amount, asset, destination, operation reference and verified status. Receipt acknowledgement is distinct from blockchain signing. No receiving business can read another business's private treasury data.

## 9. Implementation and release gates

1. Audit current D1 schema, routes, policy and UI; preserve current production data and API compatibility.
2. Implement and test deterministic multi-wallet funding plans.
3. Add explicit wallet role and policy data model with safe migrations and business-scoped APIs.
4. Implement wallet ownership challenge verification.
5. Complete threat model and select execution authority before any real autonomous signer.
6. Implement transaction intents, reservations, idempotency and reconciliation.
7. Complete website transaction review and wallet handoff.
8. Complete Telegram Mini App authentication and the shared transaction experience.
9. Complete receiver-side views and verified notifications.
10. Test on controlled non-production wallets, including failures, retries, concurrency, stale balances, partial replenishment, quote expiry, fee changes, policy revocation and mobile layouts.
11. Require explicit owner approval before production migrations/deployment or any production funds execution.

## 10. Non-goals and invariants

- No seed phrase or private key collection.
- No unrestricted AI signer.
- No assumption that a wallet's public address proves business ownership.
- No x402 API payment counted as business payment liquidity.
- No treating an internal reservation or Telegram approval as an on-chain transfer.
- No marking submitted transactions confirmed without chain verification.
- No silent partial payments.
- No deployment or production database mutation without explicit approval.
