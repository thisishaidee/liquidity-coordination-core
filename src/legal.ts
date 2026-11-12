// Public legal pages are static, script-free documents served with a restrictive CSP.
const shell = (title: string, intro: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0B0B0B">
<meta name="description" content="${intro}">
<title>${title} · NERITH</title>
<style>
:root{color-scheme:dark;--page:#0B0B0B;--panel:#151515;--paper:#F2F2EC;--muted:#A3A39B;--line:#303030;--lemon:#DFFF00}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--page);color:var(--paper);font:14px/1.7 Manrope,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit;text-decoration:none}a:hover{color:var(--lemon)}.wrap{width:min(900px,calc(100% - 40px));margin:auto}.top{height:76px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.brand{font-weight:850;letter-spacing:.16em;font-size:17px}.topnav{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
main{padding:64px 0 80px} .eyebrow{font:10px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--lemon)}h1{font-size:clamp(34px,7vw,54px);letter-spacing:-.055em;line-height:1.05;margin:14px 0} .intro{font-size:15px;color:var(--muted);max-width:700px;margin:0 0 34px}.updated{font-size:11px;color:var(--muted);margin-bottom:36px}.content{border-top:1px solid var(--line);padding-top:22px}.content h2{font-size:18px;letter-spacing:-.025em;margin:30px 0 8px}.content p,.content li{color:#C7C7BF;font-size:13px}.content ul{padding-left:20px}.content strong{color:var(--paper)}.callout{background:var(--panel);border:1px solid var(--line);padding:15px 17px;margin:24px 0;font-size:12px;color:var(--muted)}
footer{border-top:1px solid var(--line);padding:22px 0 30px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:11px}.footlinks{display:flex;gap:16px;flex-wrap:wrap}
@media(max-width:520px){.wrap{width:calc(100% - 30px)}.top{height:auto;min-height:68px;align-items:flex-start;padding:18px 0;gap:14px;flex-direction:column}.topnav{gap:12px}main{padding:42px 0 56px}footer{flex-direction:column}}
</style>
</head>
<body><div class="wrap">
<header class="top"><a class="brand" href="/">NERITH</a><nav class="topnav" aria-label="Main navigation"><a href="/">Product</a><a href="/app">Agent console</a><a href="/control">Business setup</a><a href="/health">Service status</a></nav></header>
<main><div class="eyebrow">NERITH · Legal</div><h1>${title}</h1><p class="intro">${intro}</p><div class="updated">Last updated: 12 November 2026</div><article class="content">${body}</article></main>
<footer><span>NERITH · Liquidity coordination for autonomous agents</span><nav class="footlinks" aria-label="Legal and product links"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/control">Business setup</a><a href="https://github.com/thisishaidee/liquidity-coordination-core" target="_blank" rel="noopener noreferrer">GitHub</a></nav></footer>
</div></body></html>`;

export const privacyHtml = shell("Privacy overview", "How NERITH handles workspace, agent, wallet and Telegram information.", `
<div class="callout">This is a plain-language overview of the current product. It is not a statement that NERITH has completed every legal or regulatory review. The service is evolving, and this page will be updated as its data practices change.</div>
<h2>Information processed</h2>
<p>Depending on the features a business uses, NERITH may process workspace and agent names, business and agent identifiers, agent API credentials, public Solana wallet addresses, balance snapshots, liquidity obligations, operation and reservation records, approval decisions, and Telegram account or chat identifiers.</p>
<p>Agent API credentials and operator session tokens are stored as cryptographic hashes for verification. Google Authenticator enrollment secrets used for Telegram self-approval are encrypted at rest with a dedicated Worker secret and are not stored in plaintext in the database. The business admin bootstrap token and authenticator encryption key are configured as Worker secrets. NERITH does not ask for or store wallet seed phrases or private signing keys.</p>
<h2>Why information is used</h2>
<ul><li>To authenticate agents and business operators and enforce configured access boundaries.</li><li>To read public wallet balances and coordinate liquidity assessments, reservations and operation records.</li><li>To support Telegram linking, role permissions, approval records and operational notifications.</li><li>To protect the service, investigate errors and maintain reliable operation.</li></ul>
<h2>Wallet and blockchain information</h2>
<p>Wallet addresses registered with NERITH are public addresses. Balance and transaction information may be retrieved from Solana infrastructure and is not treated as private wallet-key material. Blockchain transactions and addresses may be publicly visible independently of NERITH.</p>
<h2>Service providers</h2>
<p>NERITH relies on infrastructure providers to operate, including Cloudflare for application hosting and database services, Telegram for bot messaging, Solana RPC infrastructure for blockchain reads, and Swap.io for conversion quotes or related API workflows when those features are used. Those providers process information according to their own terms and privacy practices.</p>
<h2>Cookies and browser storage</h2>
<p>The business setup flow can establish an operator session using a Secure, HttpOnly, SameSite=Strict cookie scoped to the admin API. The current session lifetime is 12 hours. The agent console holds the entered agent API key in page memory for the active session and does not intentionally persist it in browser storage.</p>
<h2>Sharing and sale</h2>
<p>NERITH does not sell personal information. Information is shared with the service providers needed to deliver the features described above, when required by law, or to protect the service and its users. Telegram messages are sent to the chat accounts that a business has actively linked.</p>
<h2>Retention and requests</h2>
<p>Operational records are retained to support workspace history, security and service operation. Session credentials expire, Telegram invitations expire after 15 minutes, authenticator enrollment attempts expire after 10 minutes, and pending self-approval challenges expire after five minutes. A comprehensive retention schedule and self-service deletion workflow have not yet been published. For questions or requests, use the project repository linked below; do not include API keys, tokens, private keys or sensitive personal information in a public issue.</p>
<h2>Security</h2>
<p>NERITH is designed to keep custody and transaction signing under business control. This does not eliminate the risks of internet services, third-party infrastructure, compromised operator devices or incorrect business configuration. Keep credentials private and rotate them if exposure is suspected.</p>
<h2>Changes</h2>
<p>This overview may change as the product and its data practices evolve. The updated date at the top indicates the latest revision.</p>
`);

export const termsHtml = shell("Terms of use", "Conditions and important limitations for using the NERITH early-access service.", `
<div class="callout">NERITH is an evolving early-access software service. These plain-language terms are a product notice and should receive jurisdiction-specific legal review before commercial launch.</div>
<h2>Using the service</h2>
<p>By accessing NERITH, you agree to use it lawfully and only for business systems, agents, wallets and Telegram accounts that you own or are authorized to administer. You are responsible for the accuracy of information and permissions configured in your workspace.</p>
<h2>Early access and availability</h2>
<p>Features may change, be unavailable, or be withdrawn while the service is developed. NERITH does not guarantee uninterrupted availability, error-free operation, a particular liquidity outcome or compatibility with every wallet, agent or third-party service.</p>
<h2>No custody or signing service</h2>
<p>NERITH is designed as a coordination layer. It does not take custody of business funds, request wallet seed phrases, or hold private signing keys. Transactions prepared by the service require a business-controlled signer. You remain responsible for reviewing, authorizing and signing transactions, checking destination addresses and independently confirming settlement.</p>
<h2>No financial, investment or legal advice</h2>
<p>Liquidity assessments, forecasts, balances, conversion routes and estimates are operational information, not financial, investment, tax or legal advice. A forecast or quote is not a guarantee of execution, price, availability or settlement. Third-party fees, network fees, slippage and market conditions may apply.</p>
<h2>Your responsibilities</h2>
<ul><li>Protect admin tokens, agent API keys, Telegram accounts, authenticator apps and signing devices. Never share authenticator setup keys or one-time codes.</li><li>Grant only the wallet and agent permissions your business intends to grant.</li><li>Review every transaction through your own trusted signer and verify on-chain results.</li><li>Comply with applicable laws, sanctions, platform rules and third-party service terms.</li><li>Do not probe, disrupt, reverse engineer or abuse the service or attempt unauthorized access.</li></ul>
<h2>Third-party services and networks</h2>
<p>NERITH may rely on Cloudflare, Telegram, Solana RPC infrastructure, Swap.io, wallets and other external services. Their availability, terms, fees and policies are outside NERITH's control. Blockchain transactions may be irreversible once confirmed.</p>
<h2>Suspension and termination</h2>
<p>Access may be restricted where needed to protect the service, investigate misuse, respond to security concerns or comply with law. You should stop using the service if you no longer have authority over the relevant workspace, agents or wallets.</p>
<h2>Disclaimers and liability</h2>
<p>To the extent permitted by applicable law, the service is provided on an “as is” and “as available” basis, without warranties of merchantability, fitness for a particular purpose or non-infringement. To the extent permitted by law, NERITH and its contributors are not liable for indirect, incidental, special or consequential loss, loss of profits, digital assets, data or business interruption arising from use of the service. Nothing here excludes liability that cannot lawfully be excluded.</p>
<h2>Updates</h2>
<p>These terms may be revised as the service develops. Continued use after an updated version is published constitutes acceptance of the revised terms to the extent permitted by applicable law.</p>
`);
