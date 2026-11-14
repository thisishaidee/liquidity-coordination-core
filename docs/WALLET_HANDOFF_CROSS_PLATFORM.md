# Cross-Platform Solana Wallet Handoff

## Status

The current branch implements Wallet Standard discovery for the dashboard's off-chain ownership challenge, with legacy injected-provider fallback. This is not transaction signing. The branch has server-side payment settlement endpoints, but it does not yet build an unsigned funding transaction or implement a complete sign-and-return transaction flow on Android, iOS, desktop or Telegram Mini Apps. Do not advertise any wallet/platform combination as transaction-signing supported until its full sign-and-return flow has passed a device test.

## Platform requirement

Wallet handoff is platform-neutral. Android is an early test target because the project is being developed and validated on an Android device; it is not the product's platform boundary.

| Surface | Connection strategy | Required return path |
|---|---|---|
| Desktop browser | Solana Wallet Standard / injected extension providers; WalletConnect-compatible session with QR fallback where the chosen Solana connector supports it | Browser session receives the signed transaction or signature, then posts only the signature to the business-scoped settlement endpoint |
| Android browser | Injected wallet provider when available; otherwise a wallet-app adapter using verified app/universal links or a compatible WalletConnect session | Return to the originating browser/session and verify the returned signature on the server |
| iOS browser | Do not assume extension injection. Use tested wallet-app universal links or a compatible WalletConnect session | Return through universal link/session restoration; verify the returned signature on the server |
| Telegram Mini App | Same connector abstraction as the browser, with Telegram-aware deep-link/open-link handling and a safe browser fallback | Restore the Mini App/session, then submit the signature through the authenticated owner/admin flow |

## Adapter contract

The UI should depend on one small provider interface rather than wallet-brand-specific page logic:

- Discover providers available in the current runtime.
- Connect and return the public key plus network/cluster.
- Request signing of an explicitly reviewed unsigned transaction.
- Never broadcast automatically unless a separately approved execution design explicitly requires it.
- Return the signed transaction/signature to the originating NERITH session.
- Disconnect, expire and restore sessions safely.

Vendor integrations belong behind adapters. Initial candidates for device testing are OKX, Phantom, Solflare and Backpack, but availability and Solana transaction-signing support must be confirmed per platform and SDK version. A provider appearing in a detection list is not evidence of a working handoff.

## Transaction trust boundary

- NERITH must show the exact source wallet, destination, asset, amount, network, network-fee cap and operation reference before the wallet opens.
- Wallet message-signature ownership proof and transaction signing are separate actions. Ownership proof does not grant spending authority.
- The wallet remains the signer. NERITH does not receive, store or proxy private keys or seed phrases.
- A returned transaction signature is untrusted until the Worker retrieves the transaction at finalized commitment and validates it against the immutable funding leg and business policy.
- Expired, replayed, mismatched or ambiguous handoffs must not release reservations automatically.
- Browser storage must not contain agent API keys or platform bootstrap credentials.

## Responsive and device acceptance tests

Before marking a wallet/platform combination supported, verify:

1. Connect from the target browser/app and show the expected public key and Solana network.
2. Review a transaction with readable destination, token, amount and fee information on a narrow mobile viewport.
3. Open the wallet app, reject once, return to NERITH and confirm the operation remains safely unsigned.
4. Approve a test transaction, return to the same browser/Mini App session, and submit the resulting signature.
5. Confirm the server independently reconciles the finalized transaction; a wallet success toast alone is not settlement.
6. Test app switching, browser refresh, expired session, duplicate callback and interrupted return.
7. Confirm the layout remains usable at mobile, tablet and desktop widths.

No Android-only API should be required by the core signing flow. Platform-specific deep links are optional adapter implementations around the same reviewed transaction and server-verification contract.
