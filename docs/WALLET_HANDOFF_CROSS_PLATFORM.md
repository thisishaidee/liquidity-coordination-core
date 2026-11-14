# Cross-Platform Solana Wallet Handoff

## Status

The current branch implements Wallet Standard discovery for ownership challenges and the business Payments dashboard. The dashboard now prepares unsigned checked-USDC transfers, sequentially requests `solana:signTransaction` signatures from each required mainnet account, and submits the signed bytes plus the prepared message digest to the Worker. The Worker verifies the exact transaction and broadcasts only after validation. The finalized RPC reconciliation remains separate. No Android, iOS, desktop or Telegram Mini App device test has passed. Do not advertise any wallet/platform combination as device-verified until its full sign-and-return flow has passed a device test.

## Platform requirement

Wallet handoff is platform-neutral. Android is an early test target because the project is being developed and validated on an Android device; it is not the product's platform boundary.

| Surface | Connection strategy | Required return path |
|---|---|---|
| Desktop browser | Solana Wallet Standard / injected extension providers; WalletConnect-compatible session with QR fallback where the chosen Solana connector supports it | Browser session receives the fully signed transaction, then posts its bytes and prepared-message digest to the business-scoped signed-submit endpoint; the Worker verifies and broadcasts |
| Android browser | Injected wallet provider when available; otherwise a wallet-app adapter using verified app/universal links or a compatible WalletConnect session | Return to the originating browser/session and submit the fully signed transaction for Worker verification and broadcast |
| iOS browser | Do not assume extension injection. Use tested wallet-app universal links or a compatible WalletConnect session | Return through universal link/session restoration; submit the fully signed transaction for Worker verification and broadcast |
| Telegram Mini App | Same connector abstraction as the browser, with Telegram-aware deep-link/open-link handling and a safe browser fallback | Restore the Mini App/session, then submit the fully signed transaction through the authenticated owner/admin flow |

## Adapter contract

The UI currently uses the Wallet Standard interface rather than wallet-brand-specific page logic. Additional WalletConnect and platform deep-link adapters remain future work:

- Discover providers available in the current runtime.
- Connect and return the public key plus network/cluster.
- Request signing of an explicitly reviewed unsigned transaction.
- Never broadcast automatically unless a separately approved execution design explicitly requires it.
- Return the signed transaction/signature to the originating NERITH session.
- Disconnect, expire and restore sessions safely.

Vendor integrations belong behind adapters. Initial candidates for device testing are OKX, Phantom, Solflare and Backpack, but availability and Solana transaction-signing support must be confirmed per platform and SDK version. A provider appearing in a detection list is not evidence of a working handoff.

## Multiple required signers

A funding transaction may require two different business wallets: the registered SOL fee payer and the USDC source-token owner. They are separate roles and must not be treated as one wallet merely because the UI has connected one provider.

The implemented builder returns an unsigned legacy transaction and an SHA-256 digest of its message. The signing adapter must:

- Set the approved fee-payer wallet as the transaction's first account and fee payer.
- Derive the complete required-signer set from the compiled message; require both the registered fee payer and source-token owner when they are distinct.
- Request the Wallet Standard `solana:signTransaction` feature from each required wallet independently and sequentially. Each wallet signs only for its own public key.
- Preserve signatures already collected when passing the partially signed transaction to the next wallet. Reject any wallet response that changes the message bytes, fee payer, account keys, instructions, recent blockhash or required-signer set.
- After every wallet response, extract the message bytes and compare their SHA-256 digest with the prepared digest. Treat cancellation, provider switching, stale blockhashes and partial signature collection as incomplete. Do not submit until every required signature is present.
- Never ask one wallet to sign on behalf of another, and never interpret a connected session or ownership challenge as transaction authorization.

The `POST /v1/admin/payment-intents/:intentId/funding-legs/:legId/submit-signed` endpoint receives the fully signed bytes and prepared digest. Before broadcast, the Worker verifies the message digest, exact fee payer/source-owner signer set, cryptographic signatures, one checked USDC transfer, exact accounts, amount and decimals, blockhash validity and fee cap. It records the signature before broadcast and supports retrying the same signed payload. Finalized on-chain reconciliation remains a separate required step. The fee payer signature is not interchangeable with the source owner's SPL-token authority signature. The UI and device handoff are not implemented yet.

## Transaction trust boundary

- NERITH must show the exact source wallet, destination, asset, amount, network, network-fee cap and operation reference before the wallet opens.
- Wallet message-signature ownership proof and transaction signing are separate actions. Ownership proof does not grant spending authority.
- The wallet remains the signer. NERITH does not receive, store or proxy private keys or seed phrases.
- A signed transaction is not broadcast until the Worker validates it against the immutable funding leg and business policy. A returned broadcast signature remains untrusted until finalized reconciliation verifies the on-chain transaction and actual fee.
- Expired, replayed, mismatched or ambiguous handoffs must not release reservations automatically.
- Browser storage must not contain agent API keys or platform bootstrap credentials.

## Responsive and device acceptance tests

Before marking a wallet/platform combination supported, verify:

1. Connect from the target browser/app and show the expected public key and Solana network.
2. Review a transaction with readable destination, token, amount and fee information on a narrow mobile viewport.
3. Open the wallet app, reject once, return to NERITH and confirm the operation remains safely unsigned.
4. Approve a test transaction with each required wallet, return to the same browser/Mini App session, and submit the fully signed transaction bytes plus the prepared message digest.
5. Confirm the Worker verifies and broadcasts the exact transaction, then independently reconciles finalized settlement; a wallet success toast alone is not settlement.
6. Test app switching, browser refresh, expired session, duplicate callback and interrupted return.
7. Confirm the layout remains usable at mobile, tablet and desktop widths.

No Android-only API should be required by the core signing flow. Platform-specific deep links are optional adapter implementations around the same reviewed transaction and server-verification contract.
