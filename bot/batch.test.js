// XLS-56 Batch helper + the bot's sale/leftover planning (offline; needs `npm install` in bot/).
import assert from "node:assert";
import * as B from "./batch.js"; import { planSaleBatch, checkLoanPayBlob } from "./escrow-bot.js"; import * as S from "../src/state.js"; import { FLAGS } from "../src/config.js";
const ok = (m) => console.log("ok - " + m);
const BR = "rBRR9DokNwd2BWmXrNiA28rNRijVMyeTw8", L1 = "rP5UfxkFowivDbKNS9s83CoinnZnxpQjhu", L2 = "rKHEGNQoWpvwqqsfcoQYpDQAgJFhV5qXKq", SHOP = "rBZaALm7orN4fVnYDmpE4treWZS4x4oQXG";
const Q = { currency: "4455534400000000000000000000000000000000", issuer: "rHprdcgDE8VM5PgjPjKGMjZGWGh98V4CHp" };

// Inner hash matches a validated devnet Batch (probe P4, outer 2B9E16AB…, 2026-10-12): inner txs as returned by `tx`.
{ const inner = [{ Account: BR, Amount: "10", Destination: L1, Fee: "0", Flags: 1073741824, Sequence: 5946411, SigningPubKey: "", TransactionType: "Payment" },
    { Account: BR, Amount: "10", Destination: L2, Fee: "0", Flags: 1073741824, Sequence: 5946412, SigningPubKey: "", TransactionType: "Payment" }];
  assert.equal(B.innerHash(inner[0]), "0CFF575A77C31B13ABEE3B6482AD7D23A83221FB459DBFA1DC4FF9EE86B0AC37");
  assert.equal(B.innerHash(inner[1]), "4455A70AC6ADEDDB3AEC31EB57CB0B111368D5CB734C5AA8BEEA009D9A7A48BF");
  const b = B.buildBatch({ account: BR, sequence: 5946410, mode: "ALLORNOTHING", base: 10, items: [{ tx: { TransactionType: "Payment", Destination: L1, Amount: "10" } }, { tx: { TransactionType: "Payment", Destination: L2, Amount: "10" } }] });
  assert.deepEqual(b.innerHashes, ["0CFF575A77C31B13ABEE3B6482AD7D23A83221FB459DBFA1DC4FF9EE86B0AC37", "4455A70AC6ADEDDB3AEC31EB57CB0B111368D5CB734C5AA8BEEA009D9A7A48BF"]);
  ok("inner tx hashes match devnet probe P4 (TXN\\0 prefix over the unsigned inner tx)"); }

// buildBatch: flags, inner Fee "0", empty SigningPubKey, consecutive sequences, outer fee, limits, disabled inner types.
{ const ful = "A0228020" + "AB".repeat(32), cond = "A0258020" + "CD".repeat(32) + "810120";
  const b = B.buildBatch({ account: BR, sequence: 100, mode: "ALLORNOTHING", base: 10, lastLedgerSequence: 999, items: [
    { tx: { TransactionType: "EscrowFinish", Owner: SHOP, OfferSequence: 7, Condition: cond, Fulfillment: ful, TxnSignature: "XX", Fee: "12", LastLedgerSequence: 5 } },
    { tx: { TransactionType: "OfferCreate", Flags: FLAGS.tfFillOrKill | FLAGS.tfSell, TakerGets: "1000000", TakerPays: { ...Q, value: "1" } } }] });
  assert.equal(b.tx.Flags, 0x00010000); assert.equal(b.tx.Sequence, 100); assert.equal(b.tx.LastLedgerSequence, 999);
  for (const [i, t] of b.inners.entries()) { assert.equal(t.Fee, "0"); assert.equal(t.SigningPubKey, ""); assert(!("TxnSignature" in t) && !("LastLedgerSequence" in t)); assert(t.Flags & B.TF_INNER_BATCH_TXN); assert.equal(t.Sequence, 101 + i); assert.equal(t.Account, BR); }
  assert.equal(b.inners[1].Flags, (B.TF_INNER_BATCH_TXN | FLAGS.tfFillOrKill | FLAGS.tfSell) >>> 0, "OfferCreate keeps its own flags");
  // fee: 2×10 + EscrowFinish 10×(33 + 36/16) + OfferCreate 10 (no BatchSigners)
  assert.equal(B.innerFee(b.inners[0], 10), Math.ceil(10 * (33 + 36 / 16))); assert.equal(b.tx.Fee, String(20 + 353 + 10)); assert.deepEqual(b.signers, []);
  assert.equal(B.batchFee([{ TransactionType: "Payment" }, { TransactionType: "Payment" }], 10, 1), 50, "one BatchSigner adds one base fee");
  const pay = (d) => ({ tx: { TransactionType: "Payment", Destination: d, Amount: "1" } });
  assert.throws(() => B.buildBatch({ account: BR, sequence: 1, mode: "ALLORNOTHING", base: 10, items: [pay(L1)] }), /2\.\.8/);
  assert.throws(() => B.buildBatch({ account: BR, sequence: 1, mode: "ALLORNOTHING", base: 10, items: Array.from({ length: 9 }, () => pay(L1)) }), /2\.\.8/);
  assert.throws(() => B.buildBatch({ account: BR, sequence: 1, mode: "SOMETIMES", base: 10, items: [pay(L1), pay(L2)] }), /mode/);
  for (const t of ["LoanPay", "LoanManage", "LoanSet", "VaultDeposit", "LoanBrokerCoverDeposit", "VaultCreate", "Batch"]) assert.throws(() => B.buildBatch({ account: BR, sequence: 1, mode: "ALLORNOTHING", base: 10, items: [{ tx: { TransactionType: t } }, pay(L1)] }), /temINVALID_INNER_BATCH/);
  assert.equal(B.buildBatch({ account: BR, sequence: 1, mode: "INDEPENDENT", base: 10, items: [pay(L1), pay(L2)] }).tx.Flags, 0x00080000);
  // multi-account: the shop's inner tx brings its own sequence and makes the shop a required BatchSigner (outer fee + 1 base)
  const m = B.buildBatch({ account: BR, sequence: 50, mode: "ALLORNOTHING", base: 10, items: [pay(SHOP), { tx: { TransactionType: "Payment", Account: SHOP, Destination: BR, Amount: "1" }, sequence: 900 }] });
  assert.deepEqual(m.signers, [SHOP]); assert.equal(m.inners[1].Sequence, 900); assert.equal(m.tx.Fee, "50");
  assert.throws(() => B.buildBatch({ account: BR, sequence: 50, mode: "ALLORNOTHING", base: 10, items: [pay(SHOP), { tx: { TransactionType: "Payment", Account: SHOP, Destination: BR, Amount: "1" } }] }), /own sequence/);
  ok("buildBatch: mode flag, tfInnerBatchTxn, Fee 0, unsigned inners, sequences, outer fee, 2..8 limit, Loan*/Vault* refused, BatchSigners set"); }

// checkInnerResults: never trusts the outer tesSUCCESS.
{ const H = ["A".repeat(64), "B".repeat(64)], OUT = "C".repeat(64);
  const f = (result, extra = {}) => ({ validated: true, result, ledger: 10, parent: OUT, ...extra });
  let r = B.checkInnerResults({ mode: "ALLORNOTHING", outerHash: OUT, outerLedger: 10, outerResult: "tesSUCCESS", innerHashes: H, found: [f("tesSUCCESS"), f("tesSUCCESS")] });
  assert(r.ok && r.applied === 2);
  r = B.checkInnerResults({ mode: "ALLORNOTHING", outerHash: OUT, outerLedger: 10, outerResult: "tesSUCCESS", innerHashes: H, found: [null, null] });
  assert(!r.ok && r.applied === 0, "outer tesSUCCESS with no inner tx applied is a failure"); assert.match(r.problems.join(), /not on the validated ledger/);
  r = B.checkInnerResults({ mode: "ALLORNOTHING", outerHash: OUT, outerLedger: 10, outerResult: "tesSUCCESS", innerHashes: H, found: [f("tesSUCCESS"), f("tecKILLED")] });
  assert(!r.ok); assert.match(r.problems.join(), /tecKILLED/); assert.match(r.problems.join(), /partly applied/);
  r = B.checkInnerResults({ mode: "INDEPENDENT", outerHash: OUT, outerLedger: 10, outerResult: "tesSUCCESS", innerHashes: H, found: [f("tesSUCCESS"), f("tecPATH_DRY")] });
  assert(!r.ok && r.applied === 1); assert.deepEqual(r.failed, [H[1]]); assert(!/partly applied/.test(r.problems.join()));
  r = B.checkInnerResults({ mode: "ALLORNOTHING", outerHash: OUT, outerLedger: 10, outerResult: "tesSUCCESS", innerHashes: H, found: [f("tesSUCCESS", { parent: "D".repeat(64) }), f("tesSUCCESS", { ledger: 11 })] });
  assert(!r.ok); assert.match(r.problems.join(), /ParentBatchID mismatch/); assert.match(r.problems.join(), /not in the outer/);
  r = B.checkInnerResults({ mode: "ALLORNOTHING", outerHash: OUT, outerLedger: null, outerResult: "tefPAST_SEQ", innerHashes: H, found: [null, null] }); assert(!r.ok); assert.match(r.problems[0], /outer tefPAST_SEQ/);
  ok("inner results: an inner failure inside an outer tesSUCCESS is caught; ParentBatchID and ledger checked; INDEPENDENT lists the retries"); }

// chunking (≤ 8 per Batch)
{ const a = Array.from({ length: 19 }, (_, i) => i);
  assert.deepEqual(S.leftoverChunks(a).map((x) => x.length), [8, 8, 3]); assert.deepEqual(S.leftoverChunks(a.slice(0, 9)).map((x) => x.length), [8, 1]);
  assert.deepEqual(S.leftoverChunks([]), []); assert.throws(() => S.leftoverChunks(a, 9)); assert.deepEqual(B.chunk(a, 8).map((x) => x.length), [8, 8, 3]);
  ok("leftover chunks: at most 8 Payments per Batch; a lone remainder goes out as a plain Payment"); }

// Idempotency: a lender with a memo-tagged leftover Payment on the ledger is not owed again; a partly paid lender is owed only the rest.
{ const split = S.proRata(10, [{ account: L1, shares: 600n }, { account: L2, shares: 400n }]);
  const st0 = S.leftoverStatus(split, { paid: [] }); assert.deepEqual(st0.rows.map((r) => r.owed), [6, 4]);
  const st1 = S.leftoverStatus(split, { paid: [{ hash: "H1", batch: "OB", to: L1, amount: 6 }] });
  assert.deepEqual(st1.rows.map((r) => [r.status, r.owed]), [["paid", 0], ["owed", 4]]); assert.deepEqual(st1.rows[0].batches, ["OB"]);
  const st2 = S.leftoverStatus(split, { paid: [{ hash: "H1", to: L1, amount: 6 }, { hash: "H2", to: L2, amount: 4 }] }); assert.equal(st2.owed, 0);
  const due = st2.rows.filter((r) => r.owed > 0 && r.status === "owed"); assert.equal(due.length, 0, "a retry after a full payout pays nobody");
  assert.deepEqual(S.leftoverBatches([{ batch: "X" }, { batch: "X" }, { batch: null }]), ["X"]);
  ok("leftover idempotency: memo-tagged payments on the ledger are subtracted before any retry"); }

// Sale Batch contents and minimum output
{ const cond = "A0258020" + "CD".repeat(32) + "810120", ful = "A0228020" + "AB".repeat(32);
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ owner: SHOP, seq: 10 + i, drops: 5_000_000 }));
  const quoteFor = (xrp) => ({ best: xrp * 2, source: "AMM" }); // 2 DUSD per XRP
  let p = planSaleBatch({ rows: rows(2), quoteFor, quote: Q, slippagePct: 3, loanPayAmount: 12.5, condition: cond, fulfillment: ful });
  assert.deepEqual(p.items.map((x) => x.tx.TransactionType), ["EscrowFinish", "EscrowFinish", "OfferCreate", "Payment"]);
  assert.equal(p.drops, 10_000_000); assert.equal(p.minOut, 19.4, "minimum = quote 20 − 3%");
  const off = p.items[2].tx; assert.equal(off.TakerGets, "10000000"); assert.equal(off.TakerPays.value, "19.4"); assert.equal(off.Flags, (FLAGS.tfFillOrKill | FLAGS.tfSell) >>> 0, "fill-or-kill + sell, not IOC");
  assert.equal(p.pay, 12.5); assert.equal(p.items[3].tx.Amount.value, "12.5"); assert(p.items[3].shopPay); assert.deepEqual(p.pre, []);
  p = planSaleBatch({ rows: rows(2), quoteFor, quote: Q, slippagePct: 3, loanPayAmount: 19.5, condition: cond, fulfillment: ful });
  assert.equal(p.pay, null); assert.deepEqual(p.items.map((x) => x.tx.TransactionType), ["EscrowFinish", "EscrowFinish", "OfferCreate"]); assert.match(p.why, /above the guaranteed minimum/);
  p = planSaleBatch({ rows: rows(9), quoteFor, quote: Q, slippagePct: 3, loanPayAmount: 12.5, condition: cond, fulfillment: ful });
  assert.equal(p.items.length, 8); assert.equal(p.items.filter((x) => x.row).length, 6); assert.equal(p.pre.length, 3); assert.equal(p.drops, 45_000_000, "pre-finished XRP is sold in the main Batch");
  p = planSaleBatch({ rows: rows(8), quoteFor, quote: Q, slippagePct: 3, loanPayAmount: null, condition: cond, fulfillment: ful }); assert.equal(p.items.length, 8); assert.equal(p.pre.length, 1);
  p = planSaleBatch({ rows: [], unsoldDrops: 3_000_000, quoteFor, quote: Q, slippagePct: 3, loanPayAmount: 5, condition: cond, fulfillment: ful }); assert.deepEqual(p.items.map((x) => x.tx.TransactionType), ["OfferCreate", "Payment"]);
  assert.match(planSaleBatch({ rows: rows(1), quoteFor: () => ({ noMarket: true, best: 0 }), quote: Q, slippagePct: 3, condition: cond, fulfillment: ful }).none, /no market/);
  // every planned Batch passes buildBatch
  const b = B.buildBatch({ account: BR, sequence: 1, mode: "ALLORNOTHING", base: 10, items: planSaleBatch({ rows: rows(9), quoteFor, quote: Q, slippagePct: 3, loanPayAmount: 12.5, condition: cond, fulfillment: ful }).items.map((x) => ({ tx: { ...x.tx, ...(x.shopPay ? { Destination: SHOP } : {}) } })) });
  assert.equal(b.inners.length, 8);
  const loan = { Borrower: SHOP }; const LID = "F".repeat(64);
  assert.equal(checkLoanPayBlob({ TransactionType: "LoanPay", Account: SHOP, LoanID: LID, Amount: { ...Q, value: "12.5" }, Flags: FLAGS.tfLoanLatePayment }, { loan, LoanID: LID, quote: Q, due: 12.5, late: true }), null);
  assert.match(checkLoanPayBlob({ TransactionType: "LoanPay", Account: SHOP, LoanID: LID, Amount: { ...Q, value: "12.5" }, Flags: 0 }, { loan, LoanID: LID, quote: Q, due: 12.5, late: true }), /tfLoanLatePayment/);
  assert.match(checkLoanPayBlob({ TransactionType: "LoanPay", Account: BR, LoanID: LID, Amount: { ...Q, value: "12.5" } }, { loan, LoanID: LID, quote: Q, due: 1, late: false }), /Borrower/);
  ok("sale Batch: EscrowFinish ×n + OfferCreate FoK+sell (min = quote − 3%) + Payment of the LoanPay amount only when ≤ the minimum; 8-tx limit with pre-finish"); }
// saleSteps groups the inner txs by their outer Batch and says the sell leg was atomic.
{ const OB = "9".repeat(64);
  const st = S.saleSteps({ loan: { PaymentRemaining: 1, Flags: 0 }, marked: { hash: "M" }, escrows: [{ seq: 1, drops: 5e6, state: "finished", finishHash: "F1", finishBatch: OB }, { seq: 2, drops: 5e6, state: "finished", finishHash: "F2", finishBatch: OB }],
    sales: [{ hash: "O1", batch: OB, xrpDrops: 1e7, quote: 20 }], shopPays: [{ hash: "P1", batch: OB, quote: 12.5 }], pays: [{ hash: "LP", quote: 12.5 }], now: 0 });
  assert.equal(st.batches.length, 1); assert.deepEqual(st.batches[0], { outer: OB, finishes: ["F1", "F2"], sales: ["O1"], shopPays: ["P1"] });
  assert.equal(st.steps[1].batches.length, 1); assert.equal(st.steps[2].batches.length, 1); assert.match(st.steps[2].detail, /atomic .* via XLS-56 Batch/); assert.equal(st.shopFunded, 12.5);
  assert.equal(st.leftover, 7.5, "Payment to the shop is not counted as proceeds; leftover = proceeds − LoanPay");
  const plain = S.saleSteps({ marked: { hash: "M" }, escrows: [{ seq: 1, drops: 5e6, state: "finished", finishHash: "F1" }], sales: [{ hash: "O1", xrpDrops: 5e6, quote: 9 }], now: 0 });
  assert.equal(plain.batches.length, 0); assert(!/Batch/.test(plain.steps[2].detail));
  ok("saleSteps: outer Batch + inner hashes per step; atomic note only when the sale was batched"); }
console.log("batch tests ok");
