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
  RLUSD does not exist on devnet, so the asset is DUSD, a labelled devnet test token (not RLUSD, no value; currency code fixed in `src/config.js`)
  issued by `VITE_DEVNET_TEST_ISSUER`. Unset, devnet actions stay disabled. A completed end-to-end devnet run is listed on the Status page.

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
3. **LoanBrokerCoverDeposit**: the broker's RLUSD first-loss cover.
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

## XRP escrow beside the loan
XLS-66 does not take this escrow as collateral and never sells it. Escrow, AMM and DEX facts come from the XRPL docs; anything
the ledger does not enforce is an **app rule**.

1. The broker makes a 32-byte preimage: `node bot/escrow-bot.js condition --out <file outside the repo>` (mode 0600; prints
   only the PREIMAGE-SHA-256 Condition) and publishes the Condition on the pool page.
2. The shop signs `EscrowCreate` in Xaman: XRP to the broker wallet, `Condition`, `CancelAfter` = RedemptionDate + 1 day,
   `FinishAfter` = SubscriptionDate + PaymentInterval (only while still in the future).
3. The app reads the escrow by owner + sequence (`ledger_entry`) and checks Destination, Condition, Amount and CancelAfter.
   LoanSet stays blocked until it passes, the opening ratio is ≥ 150%, and the app LoanSet deadline has not passed.
4. Ratio = sell-side quote for the escrowed XRP (`amm_info` with the XLS-30 swap formula, a `book_offers` walk, or both) ÷
   (DefaultAmount − the cover the ledger would move at default). Read-only; mainnet XRP/RLUSD for mainnet-view pools, XRP/DUSD
   on devnet, otherwise "no market". Add line 150%, default line 120%.
5. Under 150% the shop has the add window to add a second escrow or LoanPay the balance down. If the window ends under 120%,
   the bot runs.
6. Four sale steps, each shown done/stuck from ledger reads: mark (`LoanManage` tfLoanImpair) → finish escrows (`EscrowFinish`)
   → sell (`OfferCreate` tfImmediateOrCancel|tfSell) → the shop's signed `LoanPay`. Then `LoanManage` tfLoanDefault for the
   rest; any shortfall is written down on that vault.

Shops with no XRP use the cover-only path: cap ≤ 1,000 RLUSD and a desk file kept off-ledger.

### Config (`src/config.js`, flagged values)
| Key | Value | Kind |
|---|---|---|
| `ESCROW.ADD_LINE_PCT` / `DEFAULT_LINE_PCT` | 150 / 120 | app rule |
| `ESCROW.ADD_WINDOW_SECONDS` | 72 h | app rule (flagged) |
| `ESCROW.SALE_WINDOW_SECONDS` | 3 days after grace | app rule (flagged) |
| `ESCROW.CANCEL_AFTER_MARGIN_SECONDS` | 1 day after RedemptionDate | app rule (flagged) |
| `ESCROW.LOANSET_SLACK_DAYS` | 3 | app rule |
| `ESCROW.SELL_MAX_SLIPPAGE_PCT` | 3 | bot limit price |
| `NO_XRP.MAX_CAP_RLUSD` | 1,000 | app rule (flagged) |
| First pool investment window | 103 days = 90 term + 7 grace + 3 sale + 3 slack | derived |

### Where the ledger and the plan differ
- **Finish at any time.** With a Condition, the broker can finish whenever it holds the fulfillment (after FinishAfter, before
  CancelAfter). "A price drop never finishes the escrow" and "sale only after LoanManage" are app rules.
- **XRP back to a repaying shop** only via `EscrowCancel` after CancelAfter (earlier: `tecNO_PERMISSION`). CancelAfter sits
  after RedemptionDate, and the app LoanSet deadline (RedemptionDate − term − grace − sale window) keeps the bot's work inside it.
- **LoanPay is borrower-only** (`tecNO_PERMISSION` for the broker). It works on an impaired loan (and unimpairs it) and fails
  `tecKILLED` after default. A late payment settles one installment, with no partial payments. So step 4 is a LoanPay the shop
  signs without submitting (Xaman `submit:false`); the bot funds the shop with exactly that amount and submits it. VaultDeposit
  after SubscriptionDate fails `tecEXPIRED`, and the vault pseudo-account cannot receive payments, so neither is a route.
- **Leftover proceeds go to the lenders, pro rata (app rule the broker promises; the ledger does not enforce it, and it is
  outside the vault and the loan).** Proceeds the bot could not put into the loan by LoanPay (below one installment, or
  still with the broker once the loan is defaulted or closed) are paid by the broker wallet as a `Payment` in the vault asset
  to each lender, pro rata to their vault MPT shares at the snapshot (the ledger of the default, up to that transaction, or
  of the LoanPay that closed the loan).
  - Snapshot: Clio `mpt_holders` for the ShareMPTID at that ledger; on xrpld (no `mpt_holders`) the balances are rebuilt
    from the MPToken entries in the vault pseudo-account's history, so lenders who withdrew later still count.
  - Every share holder counts. The pseudo-account issues the shares and holds none; broker-held shares count, and that part
    needs no payment.
  - Amounts floored to 0.000001; the rounding remainder goes to the largest holder (ties: lowest address).
  - No trust line for the asset: the Payment cannot deliver, so the amount stays recorded as owed and is shown.
  - Each Payment carries the memo `duckbank/leftover` + LoanID; the pool page lists amounts, hashes and anything owed.
- **Impair needs an overdue payment.** A price breach while payments are current arms the bot, which then waits for the next due date.

### The bot (`bot/escrow-bot.js`, broker side, devnet only)
```
cd bot && npm install
node escrow-bot.js condition --out ~/duckbank/escrow-secret.json
node escrow-bot.js status --pool ~/duckbank/pool.json
BROKER_SEED=… ESCROW_FULFILLMENT=… node escrow-bot.js run --pool ~/duckbank/pool.json --dry-run
node escrow-bot.js run --pool ~/duckbank/pool.json --secrets ~/duckbank/bot-secrets.json --loanpay-blob blob.txt --watch 10
node escrow-bot.js distribute --pool ~/duckbank/pool.json --dry-run        # leftover to lenders, pro rata (run also calls it at the end)
```
Seeds come only from env or a 0600 secrets file outside the repo, and are never logged. Mainnet and testnet are refused.

## Risks
Clawback (the RLUSD issuer has it enabled) · no on-chain collateral (the XRP escrow sits beside the loan) · no ledger
liquidation (the bot's sale is an app step and may fall short) · lock-up between the dates · XRP locked until CancelAfter ·
XLS-66 text books interest at LoanSet, devnet booked it as paid · Xaman support for XLS-65/66 transaction types is not verified, and Xaman does not document
producing a LoanSet `CounterpartySignature` · not audited.

## Security
Escaped HTML, CSP in `vercel.json`, input validation, wallet required to apply or vote, 404 for unknown routes and pools,
load-time sanitising of stored state. `.env*` files are git-ignored; never commit `.env.local`.
