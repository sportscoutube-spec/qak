// Review 2026-10-12: bot default path, Batch rollback, thin-book shortfall, leftover pro rata. Offline (needs `npm install` in bot/).
import assert from "node:assert";
import * as B from "../bot/batch.js"; import { planSaleBatch, checkLoanPayBlob, dueNow } from "../bot/escrow-bot.js";
import * as S from "../src/state.js"; import * as P from "../src/payloads.js"; import { FLAGS, ESCROW as E } from "../src/config.js";
import { t, xfail, done } from "./harness.js";
const BR = "rBRR9DokNwd2BWmXrNiA28rNRijVMyeTw8", SHOP = "rBZaALm7orN4fVnYDmpE4treWZS4x4oQXG", L1 = "rP5UfxkFowivDbKNS9s83CoinnZnxpQjhu", L2 = "rKHEGNQoWpvwqqsfcoQYpDQAgJFhV5qXKq", L3 = "rHprdcgDE8VM5PgjPjKGMjZGWGh98V4CHp";
const Q = { currency: "4455534400000000000000000000000000000000", issuer: L3 }, ID = "B".repeat(64);
const COND = "A0258020" + "CD".repeat(32) + "810120", FUL = "A0228020" + "AB".repeat(32);
const amm = { xrp: 40, quote: 200, fee: 0.005 }, quoteFor = (pool) => (x) => S.sellQuote({ pool, levels: [], xrp: x });
const rows = [{ owner: SHOP, seq: 5946405, drops: 13e6 }, { owner: SHOP, seq: 5946407, drops: 7e6 }];

await t("full default path: impair → Batch[EscrowFinish×2, OfferCreate FoK+sell, Payment to shop] → presigned LoanPay → default", () => {
  const loan = { PaymentRemaining: 2, NextPaymentDueDate: 1000, GracePeriod: 60, Flags: 0, PeriodicPayment: "24.985103", TotalValueOutstanding: "50", PrincipalOutstanding: "49" };
  let plan = S.botPlan({ loan, margin: { state: "ok" }, now: 1001 }); assert(plan.mark && !plan.sell, "overdue: mark, sale waits for grace");
  plan = S.botPlan({ loan: { ...loan, Flags: FLAGS.lsfLoanImpaired }, margin: {}, now: 1061 }); assert(!plan.mark && plan.sell);
  assert.equal(P.loanManage({ LoanID: ID, action: "impair" }).Flags, FLAGS.tfLoanImpair);
  const { due } = dueNow(loan, 1061); const sb = planSaleBatch({ rows, quoteFor: quoteFor(amm), quote: Q, slippagePct: E.SELL_MAX_SLIPPAGE_PCT, loanPayAmount: due, condition: COND, fulfillment: FUL });
  assert.deepEqual(sb.items.map((x) => x.tx.TransactionType), ["EscrowFinish", "EscrowFinish", "OfferCreate", "Payment"]);
  const off = sb.items[2].tx; assert.equal(off.Flags, (FLAGS.tfFillOrKill | FLAGS.tfSell) >>> 0); assert.equal(off.TakerGets, "20000000");
  assert(Number(off.TakerPays.value) <= sb.quote * 0.97 + 1e-6 && Number(off.TakerPays.value) > 0, "min-out = quote − 3%");
  assert.equal(sb.pay, due); assert(sb.pay <= sb.minOut);
  sb.items[3].tx.Destination = SHOP; const b = B.buildBatch({ account: BR, sequence: 10, mode: "ALLORNOTHING", items: sb.items.map((x) => ({ tx: x.tx })), base: 10 });
  assert.equal(b.tx.Flags, B.MODE.ALLORNOTHING); assert(b.inners.every((x) => x.Fee === "0" && (x.Flags & B.TF_INNER_BATCH_TXN)));
  const blob = { TransactionType: "LoanPay", Account: SHOP, LoanID: ID, Amount: { ...Q, value: String(due) }, Flags: FLAGS.tfLoanLatePayment };
  assert.equal(checkLoanPayBlob(blob, { loan: { Borrower: SHOP }, LoanID: ID, quote: Q, due, late: true }), null);
  assert.equal(checkLoanPayBlob({ ...blob, Account: BR }, { loan: { Borrower: SHOP }, LoanID: ID, quote: Q, due, late: true }), "not signed by Loan.Borrower");
  assert.equal(checkLoanPayBlob({ ...blob, Flags: 0 }, { loan: { Borrower: SHOP }, LoanID: ID, quote: Q, due, late: true }), "late payment without tfLoanLatePayment");
  assert(S.defaultGate({ ...loan, Flags: FLAGS.lsfLoanImpaired }, 1061).ok);
});
await t("sale failure: an inner failure under ALLORNOTHING rolls back the finish (nothing applied, retried)", () => {
  const h = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
  // Atomic rollback as the ledger does it: outer tesSUCCESS, no inner tx on the validated ledger.
  let c = B.checkInnerResults({ mode: "ALLORNOTHING", outerHash: "O", outerLedger: 5, outerResult: "tesSUCCESS", innerHashes: h, found: [null, null, null] });
  assert(!c.ok); assert.equal(c.applied, 0); assert.deepEqual(c.failed, h);
  // A ledger that partly applied (finish ok, OfferCreate tecKILLED) must be flagged, never accepted.
  c = B.checkInnerResults({ mode: "ALLORNOTHING", outerHash: "O", outerLedger: 5, outerResult: "tesSUCCESS", innerHashes: h,
    found: [{ validated: true, result: "tesSUCCESS", ledger: 5, parent: "O" }, { validated: true, result: "tecKILLED", ledger: 5, parent: "O" }, null] });
  assert(!c.ok); assert(c.problems.some((p) => /partly applied/.test(p)));
  c = B.checkInnerResults({ mode: "ALLORNOTHING", outerHash: "O", outerLedger: 5, outerResult: "tesSUCCESS", innerHashes: h.slice(0, 1), found: [{ validated: true, result: "tesSUCCESS", ledger: 5, parent: "EVIL" }] });
  assert(!c.ok, "ParentBatchID mismatch is caught");
});
await t("thin book: no market → no Batch; below one installment → no Payment; default writes the shortfall down on that vault", () => {
  assert.match(planSaleBatch({ rows, quoteFor: () => ({ noMarket: true, best: 0 }), quote: Q, slippagePct: 3, condition: COND, fulfillment: FUL }).none, /no market/);
  const thin = { xrp: 400, quote: 20, fee: 0.005 }, sb = planSaleBatch({ rows, quoteFor: quoteFor(thin), quote: Q, slippagePct: 3, loanPayAmount: 24.985103, condition: COND, fulfillment: FUL });
  assert.equal(sb.pay, null); assert.equal(sb.items.at(-1).tx.TransactionType, "OfferCreate");
  const st = S.saleSteps({ loan: { PaymentRemaining: 2, Flags: FLAGS.lsfLoanDefault }, marked: { hash: "M" }, escrows: [{ seq: 1, drops: 20e6, state: "finished", finishHash: "F" }],
    sales: [{ hash: "S", xrpDrops: 20e6, quote: 0.9 }], pays: [], defaulted: { hash: "D", vaultLoss: 21.237279, defaultCovered: 3.747755 }, now: 10, nextDue: 24.985103 });
  assert.equal(st.shortfall, 21.237279); assert.equal(st.steps[3].status, "stuck"); assert.equal(st.leftover, 0.9); assert(st.leftoverFixed);
});
await t("leftover: pro rata only to lenders with a trust line; others recorded as owed (no reallocation)", () => {
  const split = S.proRata(6.563201, [{ account: L1, shares: 30_000000n }, { account: L2, shares: 19_980000n }, { account: SHOP, shares: 1_000000n }]);
  const st = S.leftoverStatus(split, { paid: [], lines: { [L1]: true, [L2]: true, [SHOP]: false } });
  const due = st.rows.filter((r) => r.owed > 0 && r.status === "owed").map((r) => r.account); assert.deepEqual(due.sort(), [L1, L2].sort());
  const noLine = st.rows.find((r) => r.account === SHOP); assert.equal(noLine.status, "owed: no trust line"); assert(noLine.owed > 0);
  assert.equal(Math.round(split.payouts.reduce((t, p) => t + p.amount, 0) * 1e6), 6563201, "whole leftover assigned, none moved to others");
});
await t("payout idempotency: memo-tagged payments already on the ledger are not paid again", () => {
  const split = S.proRata(10, [{ account: L1, shares: 1n }, { account: L2, shares: 1n }]);
  const st = S.leftoverStatus(split, { paid: [{ to: L1, amount: 5, hash: "H" }], lines: {} });
  assert.deepEqual(st.rows.map((r) => r.status), ["paid", "owed"]);
});
await t("sale batch never contains Loan*/Vault* inner txs (temINVALID_INNER_BATCH)", () => {
  for (const ty of ["LoanManage", "LoanPay", "LoanSet", "VaultDeposit"]) assert.throws(() => B.buildBatch({ account: BR, sequence: 1, mode: "ALLORNOTHING", base: 10, items: [{ tx: { TransactionType: ty } }, { tx: { TransactionType: "Payment" } }] }), /cannot be a Batch inner/);
});

// ---------- Spec/design mismatches vs the brief (expected to fail against the code; evidence in /workspace/qa/review-2026-10-12.md) ----------
await xfail("brief: LoanManage tfLoanDefault is the FIRST bot step", "code impairs first, defaults last: LoanPay after default is tecKILLED (devnet run C) and only the borrower can LoanPay (tecNO_PERMISSION)", () => {
  const plan = S.botPlan({ loan: { PaymentRemaining: 2, NextPaymentDueDate: 0, GracePeriod: 0, Flags: 0 }, margin: { state: "bot-armed" }, now: 10 });
  assert.equal(plan.firstAction, "default");
});
await xfail("brief: LoanManage + EscrowFinish + sale + LoanPay in ONE XLS-56 Batch", "LoanManage/LoanPay are disabled as Batch inner txs (temINVALID_INNER_BATCH, devnet probe)", () => {
  B.buildBatch({ account: BR, sequence: 1, mode: "ALLORNOTHING", base: 10, items: [{ tx: P.loanManage({ LoanID: ID, action: "default" }) }, { tx: P.escrowFinish({ Owner: SHOP, OfferSequence: 1, Condition: COND, Fulfillment: FUL }) }] });
});
await t("S1: the hot run never loads the broker key; LoanManage only via the cold `manage` command (fixed)", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../bot/escrow-bot.js", import.meta.url), "utf8");
  const once = src.slice(src.indexOf("async function once("), src.indexOf("async function status("));
  assert(!/P\.loanManage/.test(once), "the hot loop builds no LoanManage"); assert(/the broker key stays cold/.test(src));
  assert(/die\("BROKER_SEED is set in the hot bot's environment/.test(src));
});
done("test/review.bot.test.js");
