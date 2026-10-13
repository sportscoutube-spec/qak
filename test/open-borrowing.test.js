// Open borrowing (2026-10-13): any account with lifetime access borrows against an XRP escrow; no votes, listing lock, queue,
// fee cut, shop fields or cover-only path. Offline: account_tx and Xaman are mocked or not reached.
import assert from "node:assert"; import fs from "node:fs";
import * as S from "../src/state.js"; import * as P from "../src/payloads.js"; import * as L from "../src/ledger.js";
import { ACCESS, NETWORKS, QAK_ISSUER, RULES } from "../src/config.js";
import { t, done } from "./harness.js";
globalThis.window = globalThis.window || { dispatchEvent() {}, open() {} };
const X = await import("../src/xaman.js");
const A = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY", Q = { currency: "QAK", issuer: QAK_ISSUER }, src = (f) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
const pay = (o = {}, m = {}) => ({ hash: "H".repeat(64), ledger_index: 7, validated: true, tx_json: { TransactionType: "Payment", Account: A, Destination: ACCESS.ADDRESS, Amount: { ...Q, value: "1000000" }, ...o },
  meta: { TransactionResult: "tesSUCCESS", delivered_amount: { ...Q, value: "1000000" }, ...m } });
const other = (i) => ({ hash: String(i).padStart(64, "0"), ledger_index: 100 - i, validated: true, tx_json: { TransactionType: "AccountSet", Account: A }, meta: { TransactionResult: "tesSUCCESS" } });
const mock = (pages) => { const calls = []; return { calls, f: async (url, o) => { const b = JSON.parse(o.body); calls.push({ url, ...b.params[0] }); const pg = pages[calls.length - 1] || { transactions: [] };
  return { ok: true, json: async () => ({ result: { status: "success", ...pg } }) }; } }; };

await t("access address and fee are a frozen config constant", () => {
  assert(Object.isFrozen(ACCESS)); assert.equal(ACCESS.ADDRESS, "rpRVzQSeZxxakWryRuTchxGQN7cs5oPi52"); assert.equal(ACCESS.FEE_QAK, 1_000_000); assert.equal(ACCESS.MEMO_TYPE, "duckbank/access");
  assert.throws(() => { "use strict"; ACCESS.FEE_QAK = 1; }); assert.equal(ACCESS.NETWORK, "mainnet");
});
await t("accessStatus pages account_tx on mainnet with markers and finds the payment on a later page", async () => {
  const m = mock([{ transactions: [other(1), other(2)], marker: "m1" }, { transactions: [other(3), pay()], marker: "m2" }, { transactions: [other(9)] }]);
  const r = await L.accessStatus(A, m.f); assert(r.ok); assert.equal(r.delivered, 1e6); assert.equal(r.hash, "H".repeat(64));
  assert.equal(m.calls.length, 2, "stops at the hit"); assert.deepEqual(m.calls.map((c) => c.marker), [undefined, "m1"]); assert(m.calls.every((c) => c.url === NETWORKS.mainnet.rpc && c.account === A && c.forward === false));
});
await t("accessStatus: no qualifying payment in the whole history -> not ok, complete", async () => {
  const m = mock([{ transactions: [pay({}, { delivered_amount: { ...Q, value: "999999" } })], marker: "m1" }, { transactions: [pay({ Destination: "rOTHERxxxxxxxxxxxxxxxxxxxxxxxxxxx" })] }]);
  const r = await L.accessStatus(A, m.f); assert(!r.ok && r.complete); assert.equal(m.calls.length, 2); assert.match(r.reason, /1,000,000 QAK/);
});
await t("accessStatus: history longer than the cap -> not ok, incomplete (never a silent pass)", async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ transactions: [other(i)], marker: "m" + i }));
  const r = await L.accessStatus(A, mock(many).f, { max: 3 }); assert(!r.ok && !r.complete); assert.match(r.reason, /not read/);
});
await t("accessStatus: a read error is an error, not access", async () => {
  await assert.rejects(L.accessStatus(A, async () => ({ ok: false, status: 503 })), /HTTP 503/);
});
await t("access payload: QAK Payment to the access address, exact fee, memo duckbank/access, no partial-payment flag, Account pinned", () => {
  const tx = P.accessPayment({ account: A });
  assert.deepEqual(Object.keys(tx), ["TransactionType", "Account", "Destination", "Amount", "Flags", "Memos"]);
  assert.equal(tx.TransactionType, "Payment"); assert.equal(tx.Account, A); assert.equal(tx.Destination, ACCESS.ADDRESS); assert.deepEqual(tx.Amount, { ...Q, value: "1000000" });
  assert.equal(tx.Flags & 0x00020000, 0, "no tfPartialPayment"); assert(!("SendMax" in tx) && !("Paths" in tx));
  assert.equal(Buffer.from(tx.Memos[0].Memo.MemoType, "hex").toString(), "duckbank/access"); assert.equal(Buffer.from(tx.Memos[0].Memo.MemoData, "hex").toString(), A);
  assert.throws(() => P.accessPayment({ account: "guest" }), /borrower account/); assert.throws(() => P.accessPayment({ account: ACCESS.ADDRESS }), /cannot pay itself/);
  // the payload passes the app's own check once delivered in full
  assert(S.isAccessPayment({ tx, meta: { TransactionResult: "tesSUCCESS", delivered_amount: tx.Amount }, validated: true }, A));
});
await t("access payment stays behind the mainnet flag: Xaman signing is off while mainnet is hard-off", async () => {
  assert.equal(NETWORKS.mainnet.vaultLending, false); assert.equal(X.ACCESS_SIGNING(), false);
  await assert.rejects(X.signAccessFee(P.accessPayment({ account: A })), /mainnet signing is off/);
  await assert.rejects(X.signTx({ TransactionType: "Payment" }, "mainnet"), /not enabled/);
});
await t("UI: apply page has the access check and an optional label; no shop name/city/purpose, votes, listing lock, queue, fee cut or cover-only path", () => {
  const m = src("../src/main.js");
  for (const re of [/name="shop"/, /name="city"/, /name="purpose"/, /name="listingLock"/, /name="deskFile"/, /name="path"/, /QAK vote/, /Deposit queue/, /Votes \(1 QAK/, /Fee cut/, /cover-only/i, /LISTING_LOCK/, /FEE_RATE_DISCOUNT/, /S\.vote|S\.enqueue/])
    assert(!re.test(m), `main.js still has ${re}`);
  assert(/name="label"/.test(m) && /Borrower label \(optional/.test(m)); assert(/Lifetime access/.test(m) && /ACCESS\.ADDRESS/.test(m) && /ACCESS\.FEE_QAK/.test(m));
  assert(/XRP collateral: an XRP escrow held beside the loan/.test(m)); assert(/XLS-66 does not take this XRP as collateral/.test(m));
  // Changed 2026-10-13: risk cards removed by the user; the clawback / no-collateral / no-liquidation lines are no longer on app pages. Footer only.
  assert(/The code is not audited/.test(src("../index.html")), "footer kept");
});
await t("structure: one borrower = one vault + one broker + one loan; DebtMaximum = AssetsMaximum = the borrower's cap", () => {
  const s = S.seed(); const p = S.apply(s, { account: A, capRlusd: "2500", ratePct: "10", paymentTotal: "2", intervalDays: "30", graceDays: "7", access: { ok: true } });
  const V = "C".repeat(64); const VE = { entry: { LedgerEntryType: "Vault", index: V } }; S.recordLedger(s, p.id, "VaultID", V, VE); assert.throws(() => S.recordLedger(s, "first", "VaultID", V, VE), /another borrower/);
  assert.throws(() => S.recordLedger(s, p.id, "LoanID", "D".repeat(64)) && S.recordLedger(s, p.id, "LoanID", "E".repeat(64)), /already set/);
  const lbs = P.loanBrokerSet({ VaultID: V, ManagementFeeRate: RULES.FEE_RATE, DebtMaximum: p.capRlusd }); assert.equal(lbs.DebtMaximum, "2500"); assert.equal(lbs.ManagementFeeRate, 1000);
});
done("test/open-borrowing.test.js");
