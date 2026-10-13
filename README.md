# Duck Bank (v0.2 prototype)

Open borrowing in RLUSD on the XRP Ledger, built on XLS-65 (Single Asset Vault) and XLS-66 (Lending Protocol).
Any account that has paid the one-time access fee and posts XRP collateral (an XRP escrow held beside the loan) can apply to
borrow RLUSD. There is no vote. **QAK** is the app token: a one-time payment of 1,000,000 QAK gives an account lifetime access.
The code is **not audited**.

Live: https://trustline-tan.vercel.app · Whitepaper: `public/qak-whitepaper.pdf` (served at `/qak-whitepaper.pdf`)

## Status of the amendments
XLS-65/66 need **SingleAssetVault, LendingProtocol and LendingProtocolV1_1**. A rippled release is not activation: an
amendment counts only once validators enable it. The Status page (`#/status`) runs the read-only `feature` RPC on each network.
Snapshot 2026-10-08 09:13 EEST: mainnet and testnet have none enabled; devnet has all three.
BatchV1_1 and PermissionDelegationV1_1 are shown on the Status page for information only. They are not gates: the gate stays the
three lending amendments, and mainnet stays off.

- **Mainnet:** hard-off in `src/config.js` (`NETWORKS.mainnet.vaultLending = false`). No env switch turns it on. No mainnet deposits.
- **Testnet:** status only.
- **Devnet:** may call the real transactions once all three amendments read enabled and a test issuer is configured.
  RLUSD does not exist on devnet, so the asset is DUSD, a labelled devnet test token (not RLUSD, no value; currency code fixed in `src/config.js`)
  issued by `VITE_DEVNET_TEST_ISSUER`. Unset, devnet actions stay disabled. A completed end-to-end devnet run is listed on the Status page, plus Run D (12 Oct 2026): the batched sell leg and a batched leftover split to two lenders (3.939496 / 2.623704 DUSD).

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
`#/` home · `#/apply` access check + application · `#/pools` list · `#/pool/<id>` ledger objects, cap math, transactions ·
`#/lend` lender panel · `#/qak` QAK access fee, tokenomics, team, roadmap (`#/trust` redirects here) · `#/whitepaper` · `#/status` amendments

## Structure: one borrower, one vault
Each borrower gets its own closed-ended vault, its own loan broker and one loan. Lenders choose a borrower and hold that vault's
MPT share. A default is written down on that vault only; `DebtMaximum`, the first-loss cover and the 150/120 lines apply to
that one loan. A single shared vault with many loans would spread one borrower's write-down across every lender in it, so it
is not used.

## Ledger model (per borrower)
1. **VaultCreate** on RLUSD: `VaultKind` 1 (ClosedEnded), `SubscriptionDate`, `RedemptionDate`, `AssetsMaximum` = cap, `Scale` 6
   (IOU range 0-18), `tfVaultShareNonTransferable`. The optional borrower label stays off-ledger.
2. **LoanBrokerSet** on that VaultID: `DebtMaximum` = cap, `CoverRateMinimum` 15000 (15%), `CoverRateLiquidation` 100000,
   `ManagementFeeRate` 1000 (1% of interest; fixed afterwards).
3. **LoanBrokerCoverDeposit**: the broker's RLUSD first-loss cover.
4. **VaultDeposit**: only while now ≤ SubscriptionDate (later: `tecEXPIRED`).
5. **LoanSet**: only in the investment window, signed by broker and borrower (`CounterpartySignature`), and
   StartDate + PaymentInterval × PaymentTotal + 60 s ≤ RedemptionDate. `GracePeriod` ≤ `PaymentInterval`.
6. **LoanPay**: fixed installments (a smaller payment fails `tecINSUFFICIENT_PAYMENT`); late payments carry `tfLoanLatePayment`.
7. **LoanManage**: `tfLoanImpair` once a payment is overdue; `tfLoanDefault` after NextPaymentDueDate + GracePeriod.
   Cover paid = min(DebtTotal × CRM × CRL, DefaultAmount, CoverAvailable); the rest is written down on that vault only.
8. **LoanDelete** once PaymentRemaining is 0. Never a second borrower on one vault.

Builders: `src/payloads.js`. Gates and formulas: `src/state.js`. Ledger reads: `src/ledger.js`.

## Cap math (first pool)
AssetsMaximum = DebtMaximum = 10,000 RLUSD. XLS-66 counts expected interest toward both limits: LoanSet fails if
AssetsTotal ≥ AssetsMaximum, if AssetsTotal + InterestDue > AssetsMaximum or if DebtTotal + Principal + InterestDue > DebtMaximum.
At 10% APR, 3 payments of 30 days and the 1000 fee rate,
the maximum principal is **9,839.42 RLUSD** (InterestDue 160.56, total 9,999.98), rounded down to the cent with a 0.01 margin.
The app's deposit target equals that principal. The vault is public, so the ledger accepts deposits up to 10,000; if direct
deposits fill it, LoanSet fails and lenders wait for RedemptionDate.

## QAK: lifetime access (app rule, not a ledger rule)
- Fee: a one-time QAK `Payment` of 1,000,000 QAK (issuer `r98RkKUasH5vA3mshD5Bi3eAVHCYwziY9M`) from the borrower's account to
  `rpRVzQSeZxxakWryRuTchxGQN7cs5oPi52` gives that account lifetime access to apply. Frozen in `src/config.js` (`ACCESS`).
- Check: the app pages mainnet `account_tx` for the borrower (newest first, markers, up to 20,000 transactions) and accepts a
  validated `tesSUCCESS` Payment to that address whose `delivered_amount` is at least 1,000,000 QAK of that issuer. It reads
  `delivered_amount`, not `Amount`, so a partial payment does not count. Payments add up per payment, not across payments.
  Access belongs to the paying account only. If the history is longer than the cap, the check says so and does not pass.
- Pay: the apply page builds a Xaman payload for this Payment, pinned to the connected account, with the memo `duckbank/access`
  (MemoData = the account). **Mainnet signing is hard-off in this build**, so the button stays disabled behind the same flag as
  mainnet lending; a payment made from any other wallet counts, because the check reads the ledger.
- Access is not a vote, not a cap, not cover and not collateral. The QAK paid is not `CoverAvailable` and the ledger never
  takes it on default. There is no QAK burn or seizure.

Tokenomics: 1,000,000,000 QAK. Public pool 50%, team 10%, marketing 20%, AMM 20%. Launched on FirstLedger with 50 XRP liquidity,
1% AMM fee and a 15-minute anti-sniper. Issuer `r98RkKUasH5vA3mshD5Bi3eAVHCYwziY9M` is blackholed (verified live). Issuer half escrowed:
125M unlocks 8 Oct 2026 15:49 EEST, 375M unlocks 7 Nov 2026 16:24 EET.

## XRP escrow beside the loan
XLS-66 does not take this escrow as collateral and never sells it. Escrow, AMM and DEX facts come from the XRPL docs; anything
the ledger does not enforce is an **app rule**.

1. The broker makes a 32-byte preimage: `node bot/escrow-bot.js condition --out <file outside the repo>` (mode 0600; prints
   only the PREIMAGE-SHA-256 Condition) and publishes the Condition on the pool page.
2. The borrower signs `EscrowCreate` in Xaman: XRP to the broker wallet, `Condition`, `CancelAfter` = RedemptionDate + the loan's GracePeriod + 1 day,
   `FinishAfter` = SubscriptionDate + PaymentInterval (only while still in the future).
3. The app reads the escrow by owner + sequence (`ledger_entry`) and checks Destination, Condition, Amount and CancelAfter.
   LoanSet stays blocked until it passes, the opening ratio is ≥ 150%, and the app LoanSet deadline has not passed.
4. Ratio = sell-side quote for the escrowed XRP (`amm_info` with the XLS-30 swap formula, a `book_offers` walk, or both) ÷
   (DefaultAmount − the cover the ledger would move at default). Read-only; mainnet XRP/RLUSD for mainnet-view pools, XRP/DUSD
   on devnet, otherwise "no market". Add line 150%, default line 120%.
5. Under 150% the borrower has the add window to add a second escrow or LoanPay the balance down. If the window ends under 120%,
   the bot runs.
6. Four sale steps, each shown done/stuck from ledger reads: mark (`LoanManage` tfLoanImpair) → finish escrows (`EscrowFinish`)
   → sell (`OfferCreate` tfFillOrKill|tfSell) → the borrower's presigned `LoanPay`. Then `LoanManage` tfLoanDefault for the
   rest; any shortfall is written down on that vault.
7. **The sell leg is atomic through XLS-56 Batch** (amendment BatchV1_1, `bot/batch.js`). Every EscrowFinish, the OfferCreate
   and the Payment of the LoanPay amount to the borrower are the inner transactions of one `Batch` in ALLORNOTHING mode: all of them
   apply, or none do. The bot never trusts the outer `tesSUCCESS` (XLS-56 §6): it looks up every inner hash on the validated
   ledger and checks its result, its `ParentBatchID` and its ledger. Both the outer hash and the inner hashes are recorded in the
   bot state, and the pool page shows them. Limits: 2..8 inner transactions. Escrows beyond the limit are finished first, in
   their own transactions or INDEPENDENT batches, and their XRP is sold in the main Batch.
   - Amount: a Batch carries fixed amounts and the sale output is unknown in advance. The OfferCreate is fill-or-kill + sell with
     TakerPays = quote − 3%, so it sells all the XRP for at least that, or it is killed and the whole Batch with it. The Payment to
     the borrower is included only when the presigned LoanPay amount ≤ that minimum. Output above it stays with the broker as
     leftover for the lenders. Otherwise the Payment and the LoanPay follow the Batch separately, if the actual output covers them.
   - **LoanPay stays presigned, and impair and default stay separate**, because Loan* (and Vault*) transactions can be neither
     Batch inner transactions (`temINVALID_INNER_BATCH`) nor delegated (XLS-75; a DelegateSet granting LoanPay fails
     `temMALFORMED`, devnet probe 2026-10-12).
   - **Escrow + LoanSet atomicity waits on LendingProtocolV1_2**, a future amendment that would lift the inner-transaction ban on
     Loan*. Until then LoanSet is gated on the escrows already being on the ledger.
   - **Payment delegation is deliberately not used**: a delegated Payment cannot be limited to an amount, a currency or a
     destination, so it would let the bot spend all of the borrower's RLUSD.
   - **Three keys.** The *hot* bot account runs the watcher and submits the Batch and the EscrowFinish itself (any account may
     finish a condition escrow; the XRP still goes to the broker). The *broker* key stays cold: it signs LoanManage,
     LoanBrokerSet and cover, and once grants the hot account `OfferCreate` only (XLS-75 DelegateSet; no Payment, no
     PaymentBurn, no Vault*/Loan*; a delegated Payment or EscrowCreate fails `terNO_DELEGATE_PERMISSION`, devnet probe
     2026-10-12). The bot asks the operator to run `manage` for impair/default instead of signing it. The funding Payment to
     the borrower and the leftover payments need a separately approved *payer* key (a BatchSigner), because a Payment grant cannot
     be limited. Tradeoff: if the payer key is the broker key and it is kept online, S1 gains nothing for that leg; keep it on a
     separate, low-balance account where you can.
   - **The borrower can void its presigned LoanPay** (reuse the Sequence or Ticket, or move the funds away) after it receives the
     funding Payment. No XRPL primitive ties a payment to a later LoanPay, and a Check or token escrow would hand the funds to the
     borrower in the same way. Mitigation: the bot prefers a Ticket-based LoanPay, checks before funding that the blob's
     Sequence/Ticket is still live, tags the funding with the memo `duckbank/fund` (LoanID + blob hash) and reads it back from the
     ledger for idempotency, uses a tight LastLedgerSequence, submits the LoanPay right after the funding validates, and funds
     once only: if a funded blob is voided, no more funding goes to that borrower and the amount is recorded as owed by the borrower.
     Residual risk: a racing borrower can keep one funding (at most one installment) per loan.

There is no cover-only path: a borrower without an XRP escrow cannot get a LoanSet.

### Config (`src/config.js`, flagged values)
| Key | Value | Kind |
|---|---|---|
| `ESCROW.ADD_LINE_PCT` / `DEFAULT_LINE_PCT` | 150 / 120 | app rule |
| `ESCROW.ADD_WINDOW_SECONDS` | 72 h | app rule (flagged) |
| `ESCROW.SALE_WINDOW_SECONDS` | 3 days after grace | app rule (flagged) |
| `ESCROW.CANCEL_AFTER_BUFFER_SECONDS` | CancelAfter = RedemptionDate + GracePeriod + 1 day (24 h buffer; devnet proof runs use 15 min) | app rule (flagged) |
| `ESCROW.LOANSET_SLACK_DAYS` | 3 | app rule |
| `ESCROW.SELL_MAX_SLIPPAGE_PCT` | 3 | bot limit price |
| `ACCESS.FEE_QAK` / `ACCESS.ADDRESS` | 1,000,000 QAK / `rpRVzQSeZxxakWryRuTchxGQN7cs5oPi52` | app rule (frozen) |
| First pool investment window | 103 days = 90 term + 7 grace + 3 sale + 3 slack | derived |

### Where the ledger and the plan differ
- **Finish at any time.** With a Condition, the broker can finish whenever it holds the fulfillment (after FinishAfter, before
  CancelAfter). "A price drop never finishes the escrow" and "sale only after LoanManage" are app rules.
- **XRP back to a repaying borrower** only via `EscrowCancel` after CancelAfter (earlier: `tecNO_PERMISSION`). CancelAfter sits
  at RedemptionDate + GracePeriod + a 24 h buffer, and the app LoanSet deadline (RedemptionDate − term − grace − sale window) keeps the
  bot's work inside it, with the grace period and buffer as room for a late sale (the ledger refuses EscrowFinish after CancelAfter).
- **LoanPay is borrower-only** (`tecNO_PERMISSION` for the broker). It works on an impaired loan (and unimpairs it) and fails
  `tecKILLED` after default. A late payment settles one installment, with no partial payments. So step 4 is a LoanPay the borrower
  signs without submitting (Xaman `submit:false`); the bot funds the borrower with exactly that amount and submits it. VaultDeposit
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
  - Sent in XLS-56 Batches of up to 8 Payments, INDEPENDENT mode, so one lender who cannot receive does not block the others
    (that amount stays owed and is retried). Idempotent: before each Batch the bot re-reads the memo-tagged payments on the
    ledger and pays only what is still owed. A leftover Batch that may still validate (LastLedgerSequence not passed) blocks a
    new one. A lone remaining lender gets a plain Payment (a Batch needs at least 2 inner transactions).
- **Impair needs an overdue payment.** A price breach while payments are current arms the bot, which then waits for the next due date.

### The bot (`bot/escrow-bot.js`, broker side, devnet only)
```
cd bot && npm install
node escrow-bot.js condition --out ~/duckbank/escrow-secret.json
node escrow-bot.js status --pool ~/duckbank/pool.json
node escrow-bot.js grant  --pool ~/duckbank/pool.json --broker-secrets ~/duckbank/broker.json --hot rHOT…   # cold, once: OfferCreate only
HOT_SEED=… ESCROW_FULFILLMENT=… node escrow-bot.js run --pool ~/duckbank/pool.json --dry-run   # dry-run never prints the fulfillment
node escrow-bot.js run --pool ~/duckbank/pool.json --secrets ~/duckbank/hot-secrets.json --payer-secrets ~/duckbank/payer.json --loanpay-blob blob.txt --watch 10
node escrow-bot.js manage --pool ~/duckbank/pool.json --broker-secrets ~/duckbank/broker.json   # cold: the impair/default the bot asked for
node escrow-bot.js distribute --pool ~/duckbank/pool.json --dry-run        # leftover to lenders, pro rata (run also calls it at the end)
```
Seeds come only from env or a 0600 secrets file outside the repo, and are never logged. Mainnet and testnet are refused.

## Risks
Clawback (the RLUSD issuer has it enabled) · no on-chain collateral (the XRP escrow sits beside the loan) · no ledger
liquidation (the bot's sale is an app step and may fall short) · lock-up between the dates · XRP locked until CancelAfter ·
XLS-66 text books interest at LoanSet, devnet booked it as paid · Xaman support for XLS-65/66 transaction types is not verified, and Xaman does not document
producing a LoanSet `CounterpartySignature` · not audited.

## Security
Escaped HTML, CSP in `vercel.json`, input validation, wallet and lifetime access required to apply, 404 for unknown routes and pools,
load-time sanitising of stored state. `.env*` files are git-ignored; never commit `.env.local`.
