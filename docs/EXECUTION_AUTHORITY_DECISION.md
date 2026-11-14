# NERITH execution authority decision

## Decision status

**No production signer or autonomous transaction execution is approved by this document.** This is an architecture review for the next implementation stage. Address verification, business role assignment, and authority to move funds remain separate capabilities.

## Requirements

An execution authority for NERITH must:

- Keep the business in control of its treasury and allow the business to revoke NERITH.
- Enforce limits outside the AI model, at a deterministic policy boundary.
- Scope authority by business, wallet, asset, amount, period, recipient and operation.
- Support audit trails, replay protection, emergency pause and recovery.
- Keep raw private keys out of the browser, Telegram, Worker source, D1 and ordinary environment variables.
- Make the authority's actual on-chain permissions observable and testable.
- Distinguish a USDC payment from an SOL-to-USDC swap and from the Hermes x402 API fee.

## Options considered

### 1. Owner signs every transaction in a browser wallet

NERITH prepares and validates a transaction; the owner reviews and signs it in their wallet.

**Advantages**
- The private key remains with the business.
- No backend signing key or unattended authority is needed.
- Works as the initial safe execution mode.

**Limitations**
- The owner must be available for every transaction.
- It does not meet the fully autonomous/offline requirement.

**Role in NERITH:** keep this as the manual fallback and the first live transaction path.

### 2. SPL Token Program delegate

A business owner can approve a delegate for a limited amount from an individual token account. The owner retains token ownership and can revoke the delegation. Each token account has one current delegate and delegated allowance; a new approval replaces the previous one. See the official [Approve Delegate](https://solana.com/docs/tokens/basics/approve-delegate), [Spend Permissions](https://solana.com/docs/payments/advanced-payments/spend-permissions), and [Revoke Delegate](https://solana.com/docs/tokens/basics/revoke-delegate) guidance.

**Advantages**
- Non-custodial and natively enforced by the Token Program.
- Owner can set a hard token allowance and revoke it.
- Narrowly useful for USDC transfers from a specific token account.

**Limitations**
- Authority is per token account, not a business-wide treasury policy.
- It is not a native SOL delegate.
- It does not by itself enforce NERITH's per-recipient, time-window, multi-wallet reserve-floor, or operation-type rules.
- A delegate allowance is not permission to execute arbitrary swaps or arbitrary program instructions.

**Role in NERITH:** optional narrow capability, not the general execution model.

### 3. Squads Protocol v4 vault and spending limits

Squads v4 provides a business-controlled multisig vault, configurable approval threshold, time locks, roles, sub-accounts and spending limits. A spending limit is configured for a mint, amount and period, with optional member and destination restrictions. See the [Squads v4 SDK overview](https://docs.squads.so/main/development/typescript/overview), [Add Spending Limit](https://docs.squads.so/main/development/typescript/instructions/controlled-multisig-instructions/add-spending-limit), [Config Transaction actions](https://docs.squads.so/main/development/typescript/instructions/create-config-transaction), and [Vault Transactions](https://docs.squads.so/main/development/typescript/instructions/create-vault-transaction).

**Advantages**
- The business retains multisig control of the vault.
- Routine USDC transfers can be limited by mint, amount, period, member and destination.
- Owners can change the threshold, members, time lock and spending limits through multisig governance.
- A NERITH-specific agent public key can be given narrow spending-limit authority instead of broad vault control.

**Important security caveat**

Squads documentation and program definitions must be checked against the exact deployed program version before implementation. In particular, do not assume that removing an agent from the multisig member list also removes that key from every spending-limit membership list. Treat spending-limit membership as a separate permission that must be explicitly removed and verified on-chain. Always configure a non-empty destination allowlist for an automated payment limit.

**Limitations**
- The spending-limit path is for bounded token spending, not a general permission to execute arbitrary swap instructions.
- Swaps and other arbitrary program actions should remain owner-approved vault transactions until a separately reviewed policy mechanism exists.
- Squads introduces additional account setup, rent and transaction costs.

**Role in NERITH:** strongest candidate for the first business-owned treasury automation path, subject to a test deployment and on-chain permission/revocation audit.

### 4. Customer-controlled KMS, HSM or MPC signer

A business provisions a dedicated agent signer through its own KMS/HSM or an institutional MPC provider. NERITH requests signatures only after its deterministic policy engine approves a fully decoded transaction. The private key remains in the external signing infrastructure.

Solana's current [Signing in Production](https://solana.com/docs/core/transactions/signing-in-production), [Keychain](https://solana.com/docs/tools/keychain), and [Choosing a backend](https://solana.com/docs/tools/keychain/choosing-a-backend) guidance recommends dedicated key-management infrastructure for backend treasury signing and describes KMS/HSM, Vault, MPC and managed-wallet backends.

**Advantages**
- Suitable for unattended backend signing.
- Key material does not need to enter the Worker or D1.
- Keychain offers a common signer abstraction across supported backends.
- Institutional providers may add approval policies, audit logs and transaction controls.

**Limitations**
- Provider custody and policy semantics differ; a common SDK does not make their trust models identical.
- NERITH must still decode and validate every transaction before requesting a signature.
- A signer that can sign arbitrary transactions is still a powerful authority, even if its key is external.
- Each business needs separate provisioning, access control, billing, recovery and revocation procedures.

**Role in NERITH:** possible signing backend for a Squads agent member or a narrowly scoped business signer. Never use one global NERITH hot key for all businesses.

### 5. Custom NERITH Solana program / smart treasury

A custom program could hold or control treasury assets and expose narrow instructions such as execute_usdc_payment, with on-chain checks for business policy, agent authorization, destination, allowance, period, nonce and emergency pause.

**Advantages**
- Most precise on-chain enforcement of NERITH's multi-wallet policy.
- Can support deterministic authorization and replay protection at the program boundary.
- Can be extended to approved swap flows with strict program, account and slippage validation.

**Limitations**
- Requires a new audited Solana program, upgrade governance, security review and migration plan.
- Program bugs or upgrade-authority compromise could put treasury assets at risk.
- Swap integration is substantially more complex than a token transfer.
- This is not a safe shortcut to autonomous signing.

**Role in NERITH:** later product milestone only, after the bounded USDC flow is proven.

## Recommended staged architecture

### Stage A — manual execution remains available

- Keep the current registered-wallet workflow.
- Prepare and display exact transaction intent, source, destination, mint, amount, fees and expiry.
- The owner signs in their wallet.
- Verify the submitted signature and final on-chain state independently.

### Stage B — optional Squads business vault for USDC payments

For businesses that want bounded autonomy:

1. The business creates and controls its own Squads v4 multisig vault.
2. NERITH verifies the multisig and vault relationship using protocol-specific on-chain account checks. A Squads PDA cannot prove control by signing an ordinary Ed25519 message, so the current keypair-wallet message challenge is not sufficient for this wallet type.
3. The business configures a USDC spending limit with a non-empty destination allowlist, explicit period and amount, and a dedicated NERITH agent key.
4. The agent key is held by a customer-selected KMS/MPC signer, not in the Worker.
5. NERITH constructs only supported USDC transfer operations, checks policy locally, requests the external signature and verifies the confirmed transaction.
6. Owners retain the multisig authority to change or remove the spending limit and the agent key. NERITH must verify those changes on-chain before it treats authority as revoked or active.

### Stage C — swaps remain owner-approved

- SOL-to-USDC conversion is a separate operation from the final USDC payment and from x402 API fees.
- Until a swap-specific authority is independently proven, NERITH may prepare the swap but the business must approve the Squads vault transaction.
- Do not infer that a USDC spending limit authorizes a Jupiter, Swap.io or other arbitrary aggregator transaction.
- After conversion, independently verify the USDC settlement before preparing the final payment.

### Stage D — custom policy program only if needed

Consider a NERITH program only if Squads plus a bounded signer cannot meet verified customer requirements. Require an external audit, formal threat model, upgrade/recovery policy, devnet adversarial tests and explicit business migration before any mainnet deployment.

## Non-negotiable controls before enabling any autonomous payment

- Per-business signer identity; no shared hot signer.
- Asset and mint allowlist, beginning with the verified Solana USDC mint.
- Explicit source and destination allowlists.
- Per-transaction and per-period amount caps.
- Reserve floors and maximum source transfer amounts.
- Transaction decoding and instruction allowlisting before signing.
- Fee and slippage caps.
- Nonce/idempotency and replay protection.
- Short signer request expiry and exact message/transaction binding.
- On-chain confirmation and independent settlement verification.
- Owner pause, revoke and recovery path.
- Alerts for every proposed, signed, submitted, confirmed, failed and ambiguous operation.
- No partial payment unless the business has explicitly enabled it.
- A failed final payment after a successful replenishment must leave the replenished funds visible in the payment wallet; never claim atomicity.

## Current implementation boundary

The draft also includes a pure payment-intent policy evaluator in src/transaction-policy.ts. It checks wallet verification, role and business scope, balance freshness, amount and daily caps, destination and mint allowlists, idempotency state, reserve floors, transfer caps, approved SOL fee payers, conversion source assets and slippage. It returns plans only; atomic reservations and signer authorization are still separate work. The wallet ownership challenge in PR #52 verifies an Ed25519 keypair address only. It proves control of that address, not beneficial ownership or authority to spend. Program-derived vault addresses, including Squads vaults, are off the Ed25519 curve and have no private key, so they need a separate protocol-specific verification flow ([Solana PDA documentation](https://solana.com/docs/core/pda)). The current browser proof uses raw signMessage bytes; Solana recommends the off-chain message signing standard where wallets support it, with raw-message fallback where they do not ([message signing guidance](https://solana.com/docs/frontend/messages-and-auth)). That signing-format choice needs real-wallet validation before production. No signer backend, Squads integration, custom program, transaction execution or autonomous fund movement is included in this draft.
