# NERITH: product and system overview

**Positioning:** Liquidity coordination for autonomous agents.

NERITH is an API-first coordination layer for businesses that operate autonomous agents. It helps an agent determine whether the business has enough authorized liquidity for a task, reserve the required amount in an internal ledger, forecast upcoming obligations, and prepare a token conversion when the required asset is unavailable.

NERITH is not a wallet, a custody service, a trading terminal, or an autonomous funds executor. The business retains control of its wallets and signing keys.

## Agreed next architecture milestone

The next milestone is documented in [AUTONOMOUS_LIQUIDITY_ARCHITECTURE.md](AUTONOMOUS_LIQUIDITY_ARCHITECTURE.md). Draft PR #51 adds the additive multi-wallet role schema, business-scoped role APIs, a responsive dashboard role-management surface, and deterministic USDC replenishment planning. These changes are branch-only and are not current production functionality until reviewed, merged and deployed with the D1 migration. The planner does not reserve balances or execute inter-wallet replenishment. The Worker still does not autonomously sign or broadcast transactions.

## The problem

An autonomous agent can complete its reasoning and still fail because it does not have the right asset in the right wallet at the right time. A business may have enough value overall but have it split across wallets, held in the wrong token, or already committed to other work. A normal balance check does not answer whether a specific task can safely proceed.

NERITH adds a coordination layer between an agent's task and the business-controlled wallets that may fund it.

## Main building blocks

### 1. Business and agent identity

A business workspace owns agents, wallets, operations, balance snapshots, reservations, forecasts, and Telegram connections. Each agent has its own API credential. The Worker stores a SHA-256 hash of each agent key rather than the raw key. Agent requests are scoped to the authenticated agent and its business.

A business can explicitly allow an agent to use an eligible business-scope operating wallet. Otherwise, the agent is limited to its own assigned operating wallet.

### 2. Wallet registry and balance snapshots

NERITH's production registry currently classifies Solana wallets by scope and legacy purpose. Draft PR #51 adds a separate business-scoped role-assignment layer without changing that legacy purpose column:

- **Operating wallet:** liquidity available for business tasks and possible conversion.
- **API-payment wallet:** a separate business wallet used by the x402 client to pay the Swap.io API. It is excluded from operating liquidity and forecasts.

Balance sync reads SOL and the canonical Solana USDC mint from the configured Solana RPC at confirmed commitment. Snapshots older than five minutes are not eligible for liquidity decisions. The manual balance endpoint is an admin-only testing tool and is not on-chain verification.

### 3. Liquidity decision and reservation ledger

An agent submits a task identifier, amount, token, network and purpose. V1 accepts Solana USDC requests.

NERITH evaluates fresh, authorized wallet snapshots and returns one of three broad outcomes:

- **Reserved:** enough USDC is available in one eligible wallet. NERITH creates an internal reservation and reduces the amount available to other decisions.
- **Awaiting conversion:** USDC is short, but an eligible SOL source may be converted to cover the shortfall.
- **Blocked:** the request cannot be safely covered by the currently eligible liquidity.

Reservations are ledger holds, not blockchain transfers, escrow, or proof of payment. The V1 allocator intentionally does not combine balances from multiple wallets. This avoids pretending that separate reservations are atomic when they are not.

Reservations expire automatically through a one-minute Worker cron. Agents can also release or complete an operation. An agent-reported completion is not proof that an external payment occurred.

### 4. Forecasting

Agents can publish upcoming obligations up to 30 days ahead. NERITH simulates due-date order against eligible wallet balances and estimates which obligations are covered, may need conversion, or are blocked.

A forecast is advisory. It does not reserve funds, execute swaps, or guarantee future coverage. It is designed to make funding shortfalls visible before an agent reaches the point of failure.

### 5. Swap.io through Hermes and x402

The current integration uses the fixed upstream host `https://hermes.swap.io`. The product-facing provider is Swap.io; Hermes is the API host used by this implementation.

There are two separate payment/funding flows:

1. **Operating liquidity:** SOL in a registered operating wallet may be converted into USDC for the task.
2. **API payment:** a separate registered `api_payment` wallet holds USDC for the x402 fee charged by the Swap.io/Hermes API.

The API-payment wallet must have a fresh balance snapshot of at least 0.01 USDC before quote/build requests are allowed. This is a minimum-balance gate, not a configured spending cap.

#### Quote flow

1. The agent authenticates with its NERITH API key and submits an operation ID, registered operating wallet address, registered API-payment wallet address, SOL source amount and optional slippage.
2. NERITH verifies that the operation belongs to that agent, the source wallet is authorized, the balance snapshot is fresh and sufficient, and the separate API-payment wallet is eligible.
3. NERITH sends a SOL-to-USDC quote request to Hermes.
4. If Hermes responds with HTTP 402, the x402-compatible client handles the USDC API payment using the business-controlled API-payment wallet. It signs the payment authorization client-side and retries with the x402 payment proof.
5. NERITH forwards the x402 payment proof to Hermes. The Worker does not receive or store the wallet's private key.
6. NERITH accepts a successful paid response only when Hermes returns a successful x402 settlement receipt. It stores the provider quote server-side for 15 minutes and returns a server-issued quote ID and compact route summaries.

#### Prepare flow

1. The agent sends the operation ID, quote ID, selected quote index and registered API-payment wallet address.
2. NERITH reloads the cached provider quote. The agent cannot replace the quote with arbitrary provider JSON.
3. NERITH checks that the quote's minimum USDC output covers the operation's required shortfall.
4. NERITH revalidates the operation, wallet, amount and quote context, then creates an internal SOL reservation.
5. NERITH asks Hermes to build the swap transaction. The result is an unsigned transaction; the Worker does not sign or broadcast it.
6. The business-controlled signer/runtime must inspect and sign the returned transaction locally, then broadcast it to Solana.

#### Track and settlement verification

After broadcast, the agent submits the Solana transaction signature to NERITH. NERITH records it and exposes a status endpoint. Status polling uses Solana RPC, not another paid Hermes request.

When the transaction is finalized, NERITH checks transaction metadata, verifies that the registered operating wallet was a signer, and measures the net increase in USDC owned by that wallet. It classifies the operation as settled, settled-shortfall, unverified or failed, then reconciles the internal reservation and marks balance snapshots stale.

**Important verification limit:** the current settlement verifier checks the registered wallet's signature and received USDC, but does not yet independently prove that the wallet's SOL debit matched the intended source amount plus legitimate network costs. That gap must be closed before describing settlement verification as complete or enabling unattended signing.

**Integration status:** the code path is implemented, but the repository records that no paid Swap.io/x402 API request has yet been made by this implementation. It therefore remains unverified in a live paid end-to-end transaction.

### 6. Telegram business companion

Telegram is a private, business-linked operations interface. An authorized operator can inspect liquidity, forecasts, agents and operations, create requests, and review prepared requests.

A newly linked private Telegram identity receives Operator access (internally `approver`). Existing Requester connections are not silently elevated. The business can update permissions in Business Setup.

A single Telegram identity can create and review requests. If it tries to approve or reject its own request, Google Authenticator TOTP is required. TOTP secrets are encrypted at rest using a Worker-only encryption key. Enrollment is limited to five incorrect verification attempts, codes are one-use per time step, and the approval challenge is bound to the exact operation snapshot and expires after five minutes.

Telegram records a business decision only. It cannot sign, broadcast or move funds.

## End-to-end example

A business has an agent responsible for paying a contributor 100 USDC.

1. The agent calls NERITH with a unique task ID and the 100 USDC requirement.
2. NERITH checks fresh snapshots from the agent's authorized operating wallets.
3. If one eligible wallet has 100 USDC available, NERITH reserves 100 USDC internally and returns the operation state. It has not paid the contributor.
4. If the wallet instead has 40 USDC and enough SOL to cover the remaining 60 USDC, NERITH creates an `awaiting_conversion` operation.
5. The agent obtains a Swap.io quote through x402. The API fee is paid separately from the dedicated API-payment wallet.
6. NERITH validates the route's minimum USDC output and prepares an unsigned transaction.
7. The business-controlled signer reviews and signs the transaction. The agent broadcasts it and reports the transaction signature.
8. NERITH waits for finalization, verifies the available settlement evidence, reconciles reservations and marks the balance snapshot stale.
9. The business's own payout system or authorized execution flow still performs the contributor payment. NERITH's internal reservation is not that payment.

## What makes NERITH different

- **Coordination before execution:** it reasons about whether a task can be funded before the agent gets blocked.
- **Forecasting, not just balances:** upcoming obligations are simulated against shared liquidity.
- **Business-controlled custody:** agent credentials are scoped API access, not unrestricted wallet keys.
- **Separate economic roles:** operating funds and x402 API-payment funds are accounted for independently.
- **Explicit reservation states:** available, reserved, awaiting conversion, submitted and settled are not treated as interchangeable.
- **Server-held quote integrity:** provider quotes are cached server-side and selected by an opaque quote ID rather than caller-supplied route JSON.
- **Independent settlement checks:** the Worker checks finalized Solana transaction metadata instead of treating a submitted signature as proof of settlement.
- **Human operational control:** Telegram gives operators a familiar interface without giving the bot transaction-signing authority.

## Current scope and limitations

- V1 is Solana and USDC-focused.
- Liquidity allocation uses one eligible wallet at a time; it does not pool multiple wallets.
- Reservations are internal accounting holds, not transfers or escrow.
- The Worker does not hold private keys, sign swaps, or broadcast transactions.
- Forecasts are advisory and are not reservations.
- Admin sessions are bound to one business, and resource-ID admin actions verify the owning business in D1. The shared platform bootstrap token remains an operator-level root credential; individual human identities and role-based membership are not implemented.
- Per-agent rate limits cover selected sensitive API routes, not every route or abuse surface. Per-agent and per-business x402 daily USDC budgets are implemented for paid Hermes calls routed through NERITH.
- The paid Swap.io/x402 path has not yet passed a live end-to-end paid transaction test.
- Settlement verification reconciles the finalized source SOL net debit and challenged USDC transfer, but it is not a full instruction-by-instruction policy audit of every swap route.

## Deployment and code map

- Worker API and orchestration: `src/index.ts`
- Liquidity decision primitives: `src/core.ts`
- Telegram request parsing/permission helpers: `src/telegram-request.ts`
- TOTP cryptography: `src/telegram-totp.ts`
- Browser pages: `public/landing.html`, `public/index.html`, `public/control.html`, `public/dashboard.html`
- D1 schema and migrations: `migrations/`
- Production service: Cloudflare Workers + D1
- Public pages: Cloudflare Pages
