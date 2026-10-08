# Duck Bank (v0.2 prototype)

Short loans to named shops on the XRP Ledger, built on XLS-65 (Single Asset Vault) and XLS-66 (Lending Protocol).
One shop gets one closed-ended vault in RLUSD and one loan broker on that vault. Lenders deposit during the subscription
window and hold **the vault MPT share**: the receipt for that shop only. **QAK** is the app token (listing lock, fee cut,
queue order, votes). The code is **not audited**.

Live: https://trustline-tan.vercel.app · Whitepaper: `public/qak-whitepaper.pdf` (served at `/qak-whitepaper.pdf`)

## Status of the amendments
XLS-65/66 need **SingleAssetVault, LendingProtocol and LendingProtocolV1_1**. A rippled release is not activation: an
amendment counts only once validators enable it. The Status page (`#/status`) runs the read-only `feature` RPC on each network.
Snapshot 2026-10-08 09:13 EEST: mainnet and testnet have none enabled; devnet has all three.

- **Mainnet:** hard-off in `src/config.js` (`NETWORKS.mainnet.vaultLending = false`). No env switch turns it on. No mainnet deposits.
- **Testnet:** status only.
- **Devnet:** may call the real transactions once all three amendments read enabled and a test issuer is configured.
  RLUSD does not exist on devnet, so the asset is a labelled test IOU from `VITE_DEVNET_TEST_ISSUER`. Unset, devnet actions stay disabled.

## Run
```
npm install
npm run dev        # http://localhost:5173
npm run build && npm run preview   # http://localhost:4173
npm test           # spec math, gating, payload shapes, ledger reads
```
Optional: `cp .env.example .env.local`, add your Xaman API key from https://apps.xaman.dev and whitelist the redirect URI.
Without a key, "Connect" uses a wallet labelled **mock** that signs nothing.

## Pages (hash routes)
`#/` home · `#/apply` shop application · `#/pools` list · `#/pool/<id>` ledger objects, cap math, transactions ·
`#/lend` lender panel · `#/qak` QAK roles, tokenomics, team, roadmap (`#/trust` redirects here) · `#/whitepaper` · `#/status` amendments

## Ledger model (per shop)
1. **VaultCreate** on RLUSD: `VaultKind` 1 (ClosedEnded), `SubscriptionDate`, `RedemptionDate`, `AssetsMaximum` = cap, `Scale` 6
   (IOU range 0-18), `tfVaultShareNonTransferable`. Shop name, city and purpose stay off-ledger.
2. **LoanBrokerSet** on that VaultID: `DebtMaximum` = cap, `CoverRateMinimum` 15000 (15%), `CoverRateLiquidation` 100000,
   `ManagementFeeRate` 1000 or 750 decided at creation (fixed afterwards).
3. **LoanBrokerCoverDeposit**: the shop's RLUSD first-loss cover.
4. **VaultDeposit**: only while now ≤ SubscriptionDate (later: `tecEXPIRED`).
5. **LoanSet**: only in the investment window, signed by broker and shop (`CounterpartySignature`), and
   StartDate + PaymentInterval × PaymentTotal + 60 s ≤ RedemptionDate. `GracePeriod` ≤ `PaymentInterval`.
6. **LoanPay**: fixed installments (a smaller payment fails `tecINSUFFICIENT_PAYMENT`); late payments carry `tfLoanLatePayment`.
7. **LoanManage**: `tfLoanImpair` once a payment is overdue; `tfLoanDefault` after NextPaymentDueDate + GracePeriod.
   Cover paid = min(DebtTotal × CRM × CRL, DefaultAmount, CoverAvailable); the rest is written down on that vault only.
8. **LoanDelete** once PaymentRemaining is 0. Never a second shop on one vault.

Builders: `src/payloads.js`. Gates and formulas: `src/state.js`. Ledger reads: `src/ledger.js`.

## Cap math (first pool)
AssetsMaximum = DebtMaximum = 10,000 RLUSD. XLS-66 counts expected interest toward both limits: LoanSet fails if
AssetsTotal ≥ AssetsMaximum, if AssetsTotal + InterestDue > AssetsMaximum or if DebtTotal + Principal + InterestDue > DebtMaximum.
At 10% APR, 3 payments of 30 days and the 750 fee rate (the lower tier gives the larger InterestDue, so the bound holds for both),
the maximum principal is **9,839.02 RLUSD** (InterestDue 160.96, total 9,999.98), rounded down to the cent with a 0.01 margin.
The app's deposit target equals that principal. The vault is public, so the ledger accepts deposits up to 10,000; if direct
deposits fill it, LoanSet fails and lenders wait for RedemptionDate.

## QAK (app rules, not ledger rules)
- Listing: a shop locks 250,000 QAK (app lock).
- Fee cut: ledger QAK balance ≥ 100,000 at broker creation → ManagementFeeRate 750, else 1000.
- Queue: locked QAK orders the deposit queue (advisory; the vault is public).
- Vote: one QAK, one vote, on the listing and the cap.
- Any QAK escrow or lock is an app lock. It is not CoverAvailable and the ledger never takes it. There is no QAK burn or
  seizure on default (earlier drafts described a 50% burn; that mechanic is gone).

Tokenomics: 1,000,000,000 QAK. Public pool 50%, team 10%, marketing 20%, AMM 20%. Launched on FirstLedger with 50 XRP liquidity,
1% AMM fee and a 15-minute anti-sniper. Issuer `r98RkKUasH5vA3mshD5Bi3eAVHCYwziY9M` is blackholed (verified live). Issuer half escrowed:
125M unlocks 8 Oct 2026 15:49 EEST, 375M unlocks 7 Nov 2026 16:24 EET.

## Risks
Clawback (the RLUSD issuer has it enabled) · no on-chain collateral · no liquidation · lock-up between the dates ·
interest booked at LoanSet · Xaman support for XLS-65/66 transaction types is not verified, and Xaman does not document
producing a LoanSet `CounterpartySignature` · not audited.

## Security
Escaped HTML, CSP in `vercel.json`, input validation, wallet required to apply or vote, 404 for unknown routes and pools,
load-time sanitising of stored state. `.env*` files are git-ignored; never commit `.env.local`.
