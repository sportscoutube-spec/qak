# QAK (v0.1 prototype)

Short working-capital loans to named shops on the XRP Ledger. Each retailer has one isolated pool. Lenders get a pool-share receipt for that shop only. **QAK** is the protocol token used for stakes, governance, fee discounts, queue priority and the default-cover pot. It is never the lent asset and never the lender receipt. **There is no buy tax.** Buys outside the app are untaxed. There is no guaranteed yield, and this code is **not audited**.

## Run
```
cd /workspace/trustline
npm install
npm run dev        # http://localhost:5173
npm run build && npm run preview   # http://localhost:4173
npm test           # mock state-machine tests
```
Optional: `cp .env.example .env.local` and add your Xaman API key from https://apps.xaman.dev. Whitelist the redirect URI there. If no key is set, "Connect" uses a mock connected state.

## Pages (hash routes)
`#/` home · `#/apply` retailer form · `#/pools` list · `#/pool/<id>` detail plus mock lifecycle · `#/lend` lender panel · `#/trust` QAK roles · `#/status` amendment status (includes a live re-check button)

## Real vs mocked
| Area | State |
|---|---|
| Xaman connect (Universal SDK `xumm`, OAuth2 PKCE in the browser) | Real when an API key is set, otherwise a mock |
| Show address + network | Real (from `xumm.user.account` / `networkType`) or a mock |
| Sign test payload | Real Xaman `SignIn` pseudo-transaction, which is never submitted to the ledger |
| Deposits, draws, repayments, defaults | **Custodial demo** stored in browser localStorage. No funds move |
| Stake seizure/burn on default | Mock state machine (`src/state.js`): listing + first-loss stake are seized, 50% is burned, 50% goes to the cover pot, and the loss is isolated to that pool |
| XLS-65/66 transactions | **Feature-flagged OFF**: "waiting on amendment" |
| Mainnet sends | Hard OFF |

Statuses: applied → listed → drawn → repaying/late → repaid/defaulted. Seed shops: Kostas Bakery (Athens), Marina Fit Studio (Thessaloniki), Lefkada Surf Shop, Psiri Records (Athens).

## Amendment gate (checked 2026-10-07 10:33 EEST)
Method: `ledger_entry` for the Amendments singleton (`7DB0788C…6EF4`) on a validated ledger.
| Amendment | Mainnet (xrplcluster.com) | Testnet (s.altnet) | Devnet (s.devnet) |
|---|---|---|---|
| SingleAssetVault (XLS-65) `81BD2619…240D8` | not enabled, no majority | not enabled, no majority | **enabled** |
| LendingProtocol (XLS-66) `565B90CA…99509` | not enabled, no majority | not enabled, no majority | **enabled** |

The known-amendments page lists both with "Default Vote (latest stable release): No". The live status widget on that page loads through JavaScript, so I used the ledger query instead. A devnet path is therefore allowed, but v1 does not wire one up. Gated transactions: VaultCreate/Set/Deposit/Withdraw/Delete/Clawback, LoanBrokerSet/Delete/CoverDeposit/CoverWithdraw/CoverClawback, LoanSet/Delete/Manage/Pay. Intended mapping: one Vault per shop (its shares are the receipt), one LoanBroker with first-loss cover, and one LoanSet per draw.

## RLUSD
Mainnet issuer `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`. Testnet issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`. Currency hex `524C555344000000000000000000000000000000`. Source: docs.ripple.com.

## Positioning notes
- The product reference is Clearpool: named borrower pools, lender deposits, share receipts and a protocol token. Clearpool's governance page and press coverage describe an RLUSD institutional credit fund for XRPL, announced 20 Aug 2026 with Ripple (as LP) and Cicada Partners. It is "coming soon" and in devnet testing until XLS-65/66 activate. This is not a claim that it is live.
- FirstLedger is a token launch venue. It cannot enforce a token tax and is not the credit venue.

## Sources
- https://xrpl.org/docs.html · https://xrpl.org/resources/known-amendments
- XLS-65: https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0065-single-asset-vault
- XLS-66: https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0066-lending-protocol
- Xaman: https://www.npmjs.com/package/xumm (Universal SDK) · https://github.com/XRPL-Labs/XummPkce · https://xumm.readme.io · https://apps.xaman.dev
- RLUSD: https://docs.ripple.com/products/stablecoin/overview/token-addresses · https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl
- Clearpool: https://clearpool.finance/ · https://clearpool.finance/governance · https://cryptobriefing.com/clearpool-xrpl-institutional-credit-rlusd/

## Xaman go-live (this build)
1. On https://apps.xaman.dev, create or open the app. Add `https://updating-distinguished-greeting-consulting.trycloudflare.com/` to the allowed Origin/Redirect URIs (also add `http://localhost:5173/` for dev). The SDK uses the current page URL (`document.location.href`) as the OAuth2 `redirect_uri`. The app uses hash routes, so that URL is the site root plus `#/...`.
2. Put the **API key only** in `/workspace/trustline/.env.local` as `VITE_XAMAN_API_KEY=<uuid>`. The API key is a public client id. The browser PKCE flow (`new Xumm(apiKey)`) never uses the API secret, so do not put the secret in any `VITE_` variable.
3. Vite inlines `VITE_*` values at build time, so you must rebuild: `npm run build`. The python server serves `dist/` and picks up the new build right away.
4. Once a valid key is present, the button reads "Connect Xaman" and only the real Xaman flow runs. The preview fallback refuses to run.
5. Test it: connect, check the address and network shown, then click "Sign test (SignIn)" and approve in Xaman.

## Whitepaper alignment (public/qak-whitepaper.pdf, Oct 2026)
The rules live in `RULES` and `TOKENOMICS` in `src/config.js`, and each one is marked as a WP (whitepaper) value or an app rule.
- Supply: 1,000,000,000 QAK, fixed. Listing lock: 250,000 QAK.
- Fee: 1.00% of interest paid, or 0.75% for an account holding at least 100,000 QAK, taken in RLUSD. Half of fees go to the cover pot.
- The cover pot pays the next default only up to its balance.
- First-loss QAK is posted by any holder before the draw, cannot be pulled while the loan is open, and is released on repayment. It takes a shortfall before lenders, valued at the snapshot.
- On default, the listing lock is treated as seized (app rule; the issuer is blackholed, so there is no clawback and nothing is burned).
- Votes: one QAK is one vote, on listing and on cap only.
- App rules where the WP is silent:
  - first-loss of at least 15% of the draw at the draw snapshot
  - a 1,000 QAK listing-vote threshold
  - a 2,000 RLUSD initial cap with +50% growth per on-time loan
  - a 30-day grace period before default

## Deployment
Pushes to `main` deploy to https://trustline-tan.vercel.app via Vercel Git integration. `VITE_XAMAN_API_KEY` is set in Vercel project settings, not in the repo.
