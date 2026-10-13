// Review 2026-10-13: the Lend page (#/lend) and the lender-facing rules behind it. Offline except the optional live-bundle check
// (LIVE_BUNDLE=<path to the curl'd /assets/index-*.js>, LIVE_HTML=<path to the curl'd index.html>). Run: node test/review.lend.test.js
// Stack note: the app is plain JS + Vite + the Xaman (xumm) SDK. There is no React; the brief said React.
import assert from "node:assert"; import fs from "node:fs"; import { register } from "node:module";
import { t, xfail, pending, done } from "./harness.js";
register("./xumm-mock-loader.mjs", import.meta.url);
globalThis.window = { dispatchEvent() {}, open() {} };
const C = await import("../src/config.js"); const S = await import("../src/state.js"); const P = await import("../src/payloads.js"); const L = await import("../src/ledger.js");
const { NETWORKS, RLUSD_CURRENCY, DEVNET_TEST_CURRENCY, QAK_ISSUER, QAK_CURRENCY, FLAGS, AMENDMENTS } = C;
const rd = (f) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
const MAIN = rd("../src/main.js"), HTML = rd("../index.html");
const LEND = MAIN.slice(MAIN.indexOf("lend: () =>"), MAIN.indexOf("qak: () =>"));
const ALL_ON = Object.fromEntries(AMENDMENTS.required.map((a) => [a, true]));
const BR = "rBRokerxxxxxxxxxxxxxxxxxxxxxxxxxx".replace(/x/g, "a"), BW = "rBZaALm7orN4fVnYDmpE4treWZS4x4oQXG", OTHER = "rKHEGNQoWpvwqqsfcoQYpDQAgJFhV5qXKq";
const V = "A".repeat(64), LID = "B".repeat(64), DUSD = { currency: DEVNET_TEST_CURRENCY, issuer: "rHprdcgDE8VM5PgjPjKGMjZGWGh98V4CHp" };
const RLUSD_MAIN = { currency: RLUSD_CURRENCY, issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" };

// ---- Lend page facts (source of #/lend: src/main.js `lend:` template, index.html footer)
await t("lend page: wallet 'not connected' by default; QAK balance reads the ledger and shows 0 when disconnected", async () => {
  const X = await import("../src/xaman.js"); assert.equal(X.wallet.mode, "disconnected"); assert.equal(X.wallet.account, null);
  assert(/Wallet: \$\{esc\(X\.wallet\.account \|\| "not connected"\)\}/.test(LEND)); assert(/QAK balance \(ledger\)/.test(LEND));
  assert(/if \(!w\.account\) return "0 QAK \(not connected\)"/.test(MAIN));
});
await t("lend page: deposit only via a pool page, VaultDeposit only in that vault's subscription window (button disabled here)", () => {
  assert(/<button disabled>Deposit: open a pool page; VaultDeposit only in its subscription window<\/button>/.test(LEND));
});
await t("lend page: MPT share text (pseudo-account issuer, that borrower only, no withdrawal in the investment window, redeemable from RedemptionDate)", () => {
  for (const s of ["issued by that vault's pseudo-account", "the receipt for that borrower's vault only", "redeemable from RedemptionDate", "During the investment window it cannot be withdrawn"]) assert(LEND.includes(s), s);
});
await t("lend page: default path, four steps done/stuck, leftover rule and trust-line note", () => {
  for (const s of ["LoanManage tfLoanImpair", "finishes the borrower's XRP escrows", "sells the XRP", "LoanPay the borrower has signed", "each of the four steps as done or stuck",
    "less than one installment, or still with the broker once the loan is defaulted or closed", "pro rata to their vault MPT shares at the default", "outside the vault and the loan",
    "the ledger does not enforce it", "otherwise the amount stays recorded as owed"]) assert(LEND.includes(s), s);
});
await t("risk lines: clawback, no on-chain collateral, no ledger liquidation, not audited; footer has 'not audited' and 'Not an offer'", () => {
  const risks = MAIN.slice(MAIN.indexOf("const risks"), MAIN.indexOf("</ul>", MAIN.indexOf("const risks")));
  assert(/claw back|clawback/i.test(risks) && /No on-chain collateral inside the loan/.test(risks) && /No liquidation/.test(risks)); assert(/\$\{risks\}/.test(LEND));
  assert(/The code is not audited\./.test(HTML) && /Not an offer\./.test(HTML));
});

// 1. Network asset per network
await t("1 network assets: mainnet/testnet RLUSD issuers, devnet DUSD (not RLUSD code), QAK code + issuer", () => {
  assert.deepEqual([NETWORKS.mainnet.asset.currency, NETWORKS.mainnet.asset.issuer], [RLUSD_CURRENCY, "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"]);
  assert.deepEqual([NETWORKS.testnet.asset.currency, NETWORKS.testnet.asset.issuer], [RLUSD_CURRENCY, "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV"]);
  assert.equal(NETWORKS.devnet.asset.currency, DEVNET_TEST_CURRENCY); assert.notEqual(NETWORKS.devnet.asset.currency, RLUSD_CURRENCY);
  assert.equal(Buffer.from(DEVNET_TEST_CURRENCY, "hex").toString().replace(/\0/g, ""), "DUSD"); assert(/not RLUSD/.test(NETWORKS.devnet.asset.label));
  assert.equal(QAK_ISSUER, "r98RkKUasH5vA3mshD5Bi3eAVHCYwziY9M"); assert(QAK_CURRENCY === "QAK" || Buffer.from(QAK_CURRENCY, "hex").toString().startsWith("QAK"));
  assert(Object.isFrozen(NETWORKS.devnet.asset));
});
await t("1 devnet issuer: from VITE_DEVNET_TEST_ISSUER at build time (unset in Node -> devnet actions off)", () => {
  assert.equal(NETWORKS.devnet.asset.issuer, ""); assert(!S.networkGate("devnet", ALL_ON).ok);
  assert(S.networkGate("devnet", ALL_ON, DUSD).ok, "with the DUSD test issuer and all amendments on, devnet is open");
});
await t("1 devnet rejects an RLUSD asset (spec: devnet rejects RLUSD, uses DUSD)", () => {
  const g = S.networkGate("devnet", ALL_ON, RLUSD_MAIN);
  assert(!g.ok, "networkGate('devnet', amendments on, RLUSD asset) returns ok:true: the gate only checks that an issuer is set, never the currency code [state.js:394-401]");
});
if (process.env.LIVE_BUNDLE) await t("1 live bundle: devnet issuer rHprdc…V4CHp, both RLUSD issuers present", () => {
  const b = fs.readFileSync(process.env.LIVE_BUNDLE, "utf8"); for (const a of ["rHprdcgDE8VM5PgjPjKGMjZGWGh98V4CHp", "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV"]) assert(b.includes(a), a);
}); else pending("1 live bundle issuers", "set LIVE_BUNDLE=<curl'd bundle> to run");

// 2. VaultDeposit gates
const vault = { VaultID: V, VaultKind: C.SPEC.VaultKind.ClosedEnded, SubscriptionDate: 1000, RedemptionDate: 100000 };
await t("2 VaultDeposit: allowed at/through SubscriptionDate, tecEXPIRED after; refused before VaultCreate", () => {
  assert(S.depositGate(vault, 999).ok && S.depositGate(vault, 1000).ok);
  for (const now of [1001, 50000, 100000, 200000]) { const g = S.depositGate(vault, now); assert(!g.ok); assert.equal(g.code, "tecEXPIRED"); }
  assert(!S.depositGate({}, 0).ok); assert.equal(S.vaultPhase({}, 0), "not created yet");
});
await t("2 VaultDeposit on mainnet: refused while the amendments are off, and still refused with them on (hard-off), and Xaman refuses mainnet", async () => {
  const off = S.networkGate("mainnet", { SingleAssetVault: false, LendingProtocol: false, LendingProtocolV1_1: false });
  assert(!off.ok && off.reasons.some((r) => /not enabled/.test(r)) && off.reasons.some((r) => /Mainnet deposits are not enabled/.test(r)));
  assert(!S.networkGate("mainnet", ALL_ON).ok); assert.equal(NETWORKS.mainnet.vaultLending, false);
  assert.throws(() => { "use strict"; NETWORKS.mainnet.vaultLending = true; }); assert.equal(NETWORKS.mainnet.vaultLending, false);
  const X = await import("../src/xaman.js"); await assert.rejects(X.signTx(P.vaultDeposit({ VaultID: V, asset: RLUSD_MAIN, amount: 10 }), "mainnet"), /not enabled/);
});

// 3. MPT share
await t("3 share: VaultCreate sets tfVaultShareNonTransferable; holders come from the vault's own ShareMPTID, pseudo-account excluded", () => {
  const now = 10, tx = P.vaultCreate({ asset: DUSD, AssetsMaximum: 100, SubscriptionDate: 1000, RedemptionDate: 100000, now });
  assert(tx.Flags & FLAGS.tfVaultShareNonTransferable); assert.equal(C.RULES.SHARE_NON_TRANSFERABLE, true);
  const PSEUDO = "rPSEUDOaaaaaaaaaaaaaaaaaaaaaaaaaa", h = S.holdersFromMptHolders([{ account: BW, mpt_amount: "10" }, { account: PSEUDO, mpt_amount: "5" }], PSEUDO);
  assert(!h.some((x) => x.account === PSEUDO)); assert(h.some((x) => x.account === BW));
});
await t("3 redemption: phase is Investment until RedemptionDate and Redemption from it, whether or not the loan is late", () => {
  assert.equal(S.vaultPhase(vault, 99999), "Investment"); assert.equal(S.vaultPhase(vault, 100000), "Redemption");
  assert.equal(S.vaultPhase.length, 2, "phase depends only on the vault and the time, never on the loan");
});
pending("3 withdrawal gate before RedemptionDate", "the app has no VaultWithdraw builder or gate (src/payloads.js, src/state.js); only the ledger blocks it (tecTOO_SOON, devnet run). Lend page text only.");

// 4. QAK read-only, no TrustSet
await t("4 QAK balance: read-only account_lines on mainnet; 0 with no line", async () => {
  const calls = []; const f = async (url, o) => { calls.push([url, JSON.parse(o.body)]); return { ok: true, json: async () => ({ result: { status: "success", lines: [] } }) }; };
  const b = await L.qakBalance(BW, f); assert.equal(b.balance, 0); assert.equal(b.hasLine, false);
  assert.equal(calls.length, 1); assert.equal(calls[0][1].method, "account_lines"); assert.equal(calls[0][0], NETWORKS.mainnet.rpc);
});
await t("4 no TrustSet is ever built or sent (src, bot, payload exports)", () => {
  for (const f of ["../src/payloads.js", "../src/xaman.js", "../src/state.js", "../src/ledger.js", "../bot/escrow-bot.js", "../bot/batch.js"]) assert(!/TransactionType:\s*["`']TrustSet/.test(rd(f)), f);
  assert(!Object.keys(P).some((k) => /trust/i.test(k))); assert(/This app never sends a TrustSet/.test(MAIN));
});

// 5. Default steps
const loan = (o = {}) => ({ Borrower: BW, PaymentRemaining: 2, NextPaymentDueDate: 1000, GracePeriod: 100, Flags: 0, ...o });
const esc = (state) => [{ seq: 5, drops: 10e6, state, finishHash: "F".repeat(64) }];
await t("5 four steps in order: each later step 'not started' until the earlier one", () => {
  const a = S.saleSteps({ loan: loan(), now: 1200, overdue: true }).steps; assert.equal(a[0].status, "stuck"); assert(a.slice(1).every((s) => s.status === "not started"));
  const b = S.saleSteps({ loan: loan(), marked: { hash: "M" }, escrows: esc("present"), now: 1200 }).steps; assert.equal(b[0].status, "done"); assert.equal(b[1].status, "waiting"); assert.equal(b[2].status, "not started");
  const c = S.saleSteps({ loan: loan(), marked: { hash: "M" }, escrows: esc("finished"), now: 1200 }).steps; assert.equal(c[1].status, "done"); assert.equal(c[2].status, "waiting"); assert.equal(c[3].status, "not started");
  assert.deepEqual(c.map((s) => s.n), [1, 2, 3, 4]); assert(/LoanManage/.test(c[0].name) && /EscrowFinish/.test(c[1].name) && /Sell/.test(c[2].name) && /LoanPay/.test(c[3].name));
});
await t("5 sale failure (nothing sold after the window) leaves step 3 stuck and step 4 never 'done'; nothing paid", () => {
  const r = S.saleSteps({ loan: loan(), marked: { hash: "M" }, escrows: esc("finished"), sales: [], now: 5000, saleEnds: 4000 });
  assert.equal(r.steps[2].status, "stuck"); assert.notEqual(r.steps[3].status, "done"); assert.equal(r.paid, 0);
  const d = S.saleSteps({ loan: loan({ Flags: FLAGS.lsfLoanDefault }), marked: { hash: "M" }, escrows: esc("finished"), sales: [{ hash: "S", xrpDrops: 10e6, quote: 5 }], defaulted: { hash: "D", vaultLoss: 90 }, now: 5000 });
  assert.equal(d.steps[3].status, "stuck"); assert.equal(d.paid, 0); assert.equal(d.shortfall, 90);
});
await t("5 LoanPay is borrower-signed only: the bot refuses a blob not signed by Loan.Borrower", async () => {
  const { checkLoanPayBlob } = await import("../bot/escrow-bot.js"); const q = DUSD;
  const ok = { TransactionType: "LoanPay", Account: BW, LoanID: LID, Amount: { ...q, value: "12.5" }, Flags: 0 };
  assert.equal(checkLoanPayBlob(ok, { loan: loan(), LoanID: LID, quote: q, due: 12.5 }), null);
  assert.match(checkLoanPayBlob({ ...ok, Account: BR }, { loan: loan(), LoanID: LID, quote: q, due: 12.5 }), /not signed by Loan.Borrower/);
});

// 6. Leftover
await t("6 leftover: only lenders with an RLUSD line are 'paid'; no-line lenders stay 'owed: no trust line'", () => {
  const split = S.proRata(10, [{ account: BW, shares: 3 }, { account: OTHER, shares: 1 }]);
  const st = S.leftoverStatus(split, { paid: [{ to: BW, amount: split.payouts.find((p) => p.account === BW).amount, hash: "H" }], lines: { [BW]: true, [OTHER]: false } });
  assert.equal(st.rows.find((r) => r.account === BW).status, "paid"); const o = st.rows.find((r) => r.account === OTHER); assert.equal(o.status, "owed: no trust line"); assert(o.owed > 0);
  assert(Math.abs(split.payouts.reduce((t, p) => t + p.amount, 0) - 10) < 1e-6);
});
await t("6 under one installment never goes through LoanPay: no funding Payment in the Batch, step 4 stuck", async () => {
  const { planSaleBatch } = await import("../bot/escrow-bot.js");
  const pl = planSaleBatch({ rows: [{ owner: BW, seq: 5, drops: 10e6 }], quoteFor: () => ({ best: 5, source: "amm" }), quote: DUSD, slippagePct: 3, loanPayAmount: 12.5, condition: "A0258020" + "C".repeat(64) + "810120", fulfillment: "A0228020" + "C".repeat(64) });
  assert.equal(pl.pay, null); assert(!pl.items.some((i) => i.shopPay));
  const r = S.saleSteps({ loan: loan(), marked: { hash: "M" }, escrows: esc("finished"), sales: [{ hash: "S", xrpDrops: 10e6, quote: 5 }], now: 1200, nextDue: 12.5 });
  assert.equal(r.steps[3].status, "stuck"); assert.match(r.steps[3].detail, /below one installment/); assert.equal(r.leftover, 5);
});
await t("6 leftover is fixed only after default/close (before that it may still go into a LoanPay)", () => {
  assert(!S.leftoverFixed({ loan: loan(), defaulted: null })); assert(S.leftoverFixed({ loan: loan(), defaulted: { hash: "D" } })); assert(S.leftoverFixed({ loan: loan({ PaymentRemaining: 0 }) }));
});

// 7. Escrow gate and finish ordering
const COND = "A0258020" + "D".repeat(64) + "810120", T = { PaymentInterval: 2592000, PaymentTotal: 3, GracePeriod: 604800, InterestRate: 10000 };
await t("7 LoanSet blocked until the PREIMAGE-SHA-256 escrow to the broker is verified on the ledger", () => {
  const p = { escrow: { condition: COND }, terms: T };
  assert(!S.loanSetEscrowGate(p, { escrows: { verified: 0 } }).ok); assert(!S.loanSetEscrowGate({ ...p, escrow: { condition: "A0258020" + "D".repeat(10) } }, { escrows: { verified: 1 }, ratio: 200 }).ok);
  assert(S.loanSetEscrowGate(p, { escrows: { verified: 1 }, ratio: 200 }).ok);
  const exp = { owner: BW, destination: BR, condition: COND, cancelAfterMin: 10 }, node = { LedgerEntryType: "Escrow", Account: BW, Destination: BR, Condition: COND, Amount: "1000000", CancelAfter: 20 };
  assert(S.checkEscrow(node, exp).ok); assert(!S.checkEscrow({ ...node, Destination: OTHER }, exp).ok); assert(!S.checkEscrow({ ...node, Condition: undefined }, exp).ok);
  assert(S.isCondition(COND) && !S.isCondition("A0" + "D".repeat(70)));
});
await t("7 bot never sells/finishes an unmarked loan: whenever the plan would sell and the loan is not impaired/defaulted, it must mark first", () => {
  for (const now of [500, 1001, 1101, 5000]) for (const Flags of [0, FLAGS.lsfLoanImpaired, FLAGS.lsfLoanDefault]) for (const state of [null, "bot-armed"]) {
    const p = S.botPlan({ loan: loan({ Flags }), margin: state ? { state } : null, now }); const marked = Flags !== 0;
    if (p.sell && !marked) assert(p.mark, `now ${now}: sell without mark`);
  }
  assert(/if \(plan\.mark\) \{ ask\("impair"\); return/.test(rd("../bot/escrow-bot.js")), "once() returns before any EscrowFinish when a mark is needed");
});

// 8. Wallet
const X = await import("../src/xaman.js"); C.CONFIG.xamanApiKey = "12345678-1234-1234-1234-123456789abc";
let sent = null; const mock = (signed, account) => { globalThis.__xumm = { user: { get account() { return Promise.resolve(BW); }, get networkType() { return Promise.resolve("DEVNET"); } },
  payload: { async createAndSubscribe(p) { sent = p; return { created: { uuid: "u1", next: {} }, resolved: Promise.resolve({ signed }) }; }, async get() { return { response: { txid: "T".repeat(64), hex: "12", account } }; } } }; };
mock(false, BW); await X.connect();
await t("8 Xaman cancel: signed:false, no txid", async () => { mock(false, BW); const r = await X.signTx({ TransactionType: "VaultDeposit" }, "devnet"); assert.equal(r.signed, false); assert.equal(r.txid, null); });
await t("8 wrong account: signed by another account is rejected; payload pinned to the connected account", async () => {
  mock(true, OTHER); await assert.rejects(X.signTx({ TransactionType: "VaultDeposit" }, "devnet"), /not the connected account/);
  assert.equal(sent.txjson.Account, BW); assert.deepEqual(sent.options.signers, [BW]);
  await assert.rejects(X.signTx({ TransactionType: "VaultDeposit", Account: OTHER }, "devnet"), /not the connected account/);
});
await t("8 LoanSet missing its second signature is refused (temBAD_SIGNER) and a half signature is malformed", () => {
  const ls = P.loanSet({ LoanBrokerID: LID, Counterparty: BW, PrincipalRequested: 10, terms: T });
  assert.throws(() => P.assertLoanSetComplete(ls), /temBAD_SIGNER/); assert.throws(() => P.withCounterpartySignature(ls, { SigningPubKey: "02AB" }), /exactly one/);
  assert(P.assertLoanSetComplete(P.withCounterpartySignature(ls, { SigningPubKey: "02AB", TxnSignature: "30" })));
});

// 9. Sample row
await t("9 sample row: VaultID 'not created yet' and share 'none' until a real VaultID; seed has no VaultID", () => {
  const s = S.seed(), sp = s.pools.find((p) => p.sample); assert(sp && !sp.ledger.VaultID);
  assert(/p\.ledger\.VaultID \? `<code>.*?: NC\}/.test(LEND) && /p\.ledger\.VaultID \? "read from the ledger.*?" : "none"/.test(LEND)); assert(/not created yet/.test(MAIN.match(/const NC = .*/)[0]));
});
await t("9 a non-ledger VaultID never flips the sample row: recordLedger rejects a malformed id", () => {
  const s = S.seed(), sp = s.pools.find((p) => p.sample); let stored = false;
  try { S.recordLedger(s, sp.id, "VaultID", "<not a ledger id>"); stored = sp.ledger.VaultID === "<not a ledger id>"; } catch {}
  const kept = stored ? S.sanitizeState(JSON.parse(JSON.stringify(s))).pools.length : 1;
  assert(!stored, `recordLedger stored a malformed VaultID (row now shows it instead of "not created yet" and share "read from the ledger" instead of "none"); on reload sanitizeState then drops ${1 - kept} of 1 pools [state.js:466-471, caller main.js:187-188 stores createdId's LedgerIndex unchecked, ledger.js:61-67]`);
});

// Security
await t("sec: no seed / broker key / fulfillment / Xaman secret in client source", () => {
  for (const f of ["../src/main.js", "../src/xaman.js", "../src/config.js", "../src/state.js", "../src/payloads.js", "../src/ledger.js", "../index.html"]) {
    const s = rd(f); assert(!/\bs[1-9A-HJ-NP-Za-km-z]{28}\b/.test(s.replace(/"[0-9A-F]{64}"/g, "")), `${f}: seed-shaped string`); assert(!/A0228020[0-9A-F]{64}/.test(s), `${f}: fulfillment`);
    assert(!/(HOT_SEED|BROKER_SEED|ESCROW_FULFILLMENT|xamanApiSecret|VITE_.*SECRET)/.test(s), `${f}: secret name`);
  }
  assert(/fulfillment never enters the browser/.test(MAIN));
});
if (process.env.LIVE_BUNDLE) await t("sec live bundle: no seed-shaped string, no fulfillment, no secret env names; footer text in live html", () => {
  const b = fs.readFileSync(process.env.LIVE_BUNDLE, "utf8"); assert(!/\bs[1-9A-HJ-NP-Za-km-z]{28}\b/.test(b)); assert(!/A0228020[0-9A-F]{64}/.test(b)); assert(!/HOT_SEED|BROKER_SEED|ESCROW_FULFILLMENT|SECRET/.test(b));
  if (process.env.LIVE_HTML) { const h = fs.readFileSync(process.env.LIVE_HTML, "utf8"); assert(/The code is not audited\./.test(h) && /Not an offer\./.test(h)); }
}); else pending("sec live bundle scan", "set LIVE_BUNDLE (and LIVE_HTML) to run");
await t("sec XLS-75: the bot's grant is exactly [OfferCreate]; broader grants refused; EscrowFinish needs no grant", async () => {
  const { GRANT, checkGrant } = await import("../bot/escrow-bot.js"); assert.deepEqual(GRANT, ["OfferCreate"]);
  const g = (...p) => ({ Permissions: p.map((x) => ({ Permission: { PermissionValue: x } })) });
  assert.equal(checkGrant(g("OfferCreate")), null); for (const x of ["Payment", "PaymentBurn", "VaultDeposit", "LoanSet", "EscrowFinish"]) assert.match(checkGrant(g("OfferCreate", x)), /broader/);
  assert.match(checkGrant(null), /no XLS-75 grant/);
});
await xfail("sec XLS-75 (user wording): the grant covers EscrowFinish + OfferCreate", "design: EscrowFinish needs no grant (any account may finish a condition escrow; XRP still goes to the broker), so GRANT is [OfferCreate] only", async () => {
  const { GRANT } = await import("../bot/escrow-bot.js"); assert(GRANT.includes("EscrowFinish"), "GRANT = " + JSON.stringify(GRANT));
});
await t("sec cover: min(DebtTotal×CRM×CRL, DefaultAmount, CoverAvailable); shortfall = vault loss", () => {
  const d = S.defaultCover({ DebtTotal: 10000, CoverRateMinimum: 15000, CoverRateLiquidation: 100000, CoverAvailable: 2000, DefaultAmount: 9000 });
  assert.equal(d.defaultCovered, 1500); assert.equal(d.vaultLoss, 7500);
  assert.equal(S.defaultCover({ DebtTotal: 10000, CoverRateMinimum: 15000, CoverRateLiquidation: 100000, CoverAvailable: 100, DefaultAmount: 9000 }).defaultCovered, 100);
});
await t("sec sanitize: amounts, dates, addresses", () => {
  for (const bad of ["1e3", "-1", "0", "0.0000001", "abc", "1,000", NaN, Infinity, "1".repeat(16)]) assert.throws(() => P.value(bad), String(bad));
  assert.equal(P.value("12.5000"), "12.5");
  assert.throws(() => P.vaultDeposit({ VaultID: "a".repeat(64), asset: DUSD, amount: 1 }), /VaultID/); assert.throws(() => P.vaultDeposit({ VaultID: V, asset: { currency: "X", issuer: "evil" }, amount: 1 }), /issuer/);
  assert.throws(() => P.loanSet({ LoanBrokerID: LID, Counterparty: "<img>", PrincipalRequested: 1, terms: T }), /Counterparty/);
  assert.throws(() => S.checkVaultDates(2000, 1000, 0)); assert.throws(() => S.checkVaultDates(1.5, 1000, 0)); assert.throws(() => S.checkVaultDates(100, 1000, 500), /tecEXPIRED/);
  assert.equal(S.sanitizeState({ pools: [{ id: "<x>", network: "mainnet" }] }).pools.length, 0);
});
await t("sec copy: never claims the ledger sells XRP, seizes the escrow or makes lenders whole", () => {
  const txt = [MAIN, HTML, rd("../README.md"), rd("../docs/whitepaper.html")].join("\n");
  for (const re of [/ledger (sells|will sell|liquidates)/i, /(ledger|XLS-66) (seizes|takes) the (XRP )?escrow/i, /made whole|makes? (the )?lenders whole|lenders are repaid in full/i, /XRP sale clears the debt/i, /XLS-66 collateral/i])
    assert(!re.test(txt), String(re));
  assert(/XLS-66 does not take this XRP as collateral/.test(MAIN));
});
done("test/review.lend.test.js");
