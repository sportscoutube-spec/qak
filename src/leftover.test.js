// Leftover proceeds to the pool's lenders, pro rata (app rule): split, rounding and dust, no-trust-line handling, snapshot derivation.
import * as S from "./state.js"; import * as L from "./ledger.js"; import assert from "node:assert";
const ok = (n) => console.log("ok -", n);
const A = "rAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", B = "rBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", C = "rCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", PSEUDO = "rPSEUDOxxxxxxxxxxxxxxxxxxxxxxxxxx", BROKER = "rBROKERxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SHARE = "0000000188522100AAAA", ISS = "rHprdcgDE8VM5PgjPjKGMjZGWGh98V4CHp", Q = { currency: "USD", issuer: ISS };
const sum = (sp) => sp.payouts.reduce((t, p) => t + Math.round(p.amount * 1e6), 0);

// Pro-rata split, rounding and dust
{ let sp = S.proRata(6.547539029056434, [{ account: A, shares: 49980000n }]); assert.equal(sp.total, 6.547539); assert.equal(sp.payouts[0].amount, 6.547539); assert.equal(sp.dust, 0);
  sp = S.proRata(100, [{ account: A, shares: 600n }, { account: B, shares: 300n }, { account: C, shares: 100n }]); assert.deepEqual(sp.payouts.map((p) => p.amount), [60, 30, 10]); assert.equal(sp.dust, 0);
  sp = S.proRata(1, [{ account: B, shares: 3n }, { account: A, shares: 3n }, { account: C, shares: 1n }]);
  assert.equal(sum(sp), 1_000_000, "whole leftover assigned"); assert.equal(sp.dust, 0.000001); assert.equal(sp.dustTo, A, "tie on shares: lowest address");
  assert.equal(sp.payouts.find((p) => p.account === A).amount, 0.428572); assert.equal(sp.payouts.find((p) => p.account === B).amount, 0.428571); assert.equal(sp.payouts.find((p) => p.account === C).amount, 0.142857);
  sp = S.proRata(0.000002, [{ account: A, shares: 1n }, { account: B, shares: 1n }, { account: C, shares: 5n }]); assert.equal(sum(sp), 2); assert.equal(sp.dustTo, C);
  sp = S.proRata(0.0000009, [{ account: A, shares: 1n }]); assert.equal(sp.total, 0); assert.equal(sp.payouts.length, 0, "below 0.000001: nothing to pay");
  sp = S.proRata(5, []); assert.equal(sp.unassigned, 5); assert.equal(sp.payouts.length, 0);
  sp = S.proRata(1, [{ account: A, shares: 10n ** 30n }, { account: B, shares: 1n }]); assert.equal(sum(sp), 1_000_000); assert.equal(sp.payouts.find((p) => p.account === B).amount, 0);
  ok("pro-rata split: floor to 0.000001, dust to the largest holder (ties: lowest address), whole leftover assigned, big share counts exact"); }

// Paid / owed / no trust line / broker's own shares
{ const sp = S.proRata(10, [{ account: A, shares: 5n }, { account: B, shares: 3n }, { account: C, shares: 1n }, { account: BROKER, shares: 1n }]);
  const st = S.leftoverStatus(sp, { paid: [{ to: A, amount: 5, hash: "H1" }], lines: { A: true, [B]: false, [C]: true }, self: BROKER });
  const by = Object.fromEntries(st.rows.map((r) => [r.account, r]));
  assert.equal(by[A].status, "paid"); assert.deepEqual(by[A].hashes, ["H1"]);
  assert.equal(by[B].status, "owed: no trust line"); assert.equal(by[B].owed, 3);
  assert.equal(by[C].status, "owed"); assert.equal(by[C].owed, 1);
  assert(by[BROKER].status.startsWith("kept")); assert.equal(by[BROKER].owed, 0);
  assert.equal(st.owed, 4); assert.equal(st.paid, 5);
  const half = S.leftoverStatus(sp, { paid: [{ to: C, amount: 0.4, hash: "H2" }] }); assert.equal(half.rows.find((r) => r.account === C).owed, 0.6);
  ok("status: paid with hashes, owed, owed with no trust line, broker's own shares need no payment"); }

// Leftover fixed only after default or close
{ assert(!S.leftoverFixed({ loan: { PaymentRemaining: 1 }, defaulted: null })); assert(S.leftoverFixed({ loan: { PaymentRemaining: 1 }, defaulted: { hash: "D" } }));
  assert(S.leftoverFixed({ loan: { PaymentRemaining: 0 }, defaulted: null })); assert(S.leftoverFixed({ loan: null, defaulted: null }));
  const st = S.saleSteps({ now: 1, marked: { hash: "M" }, escrows: [{ seq: 1, drops: 24e6, state: "finished" }], sales: [{ hash: "S", xrpDrops: 24e6, quote: 31.5 }], pays: [{ hash: "P", quote: 25 }], defaulted: { hash: "D", vaultLoss: 21 } });
  assert.equal(st.leftover, 6.5); assert(st.leftoverFixed); ok("leftover = proceeds − LoanPay, fixed at default or close"); }

// Snapshot from mocked history: last MPToken state per account at or before {ledger, txIndex}; pseudo-account and zero balances dropped
{ const mt = (kind, acct, amt, prev) => ({ [kind]: { LedgerEntryType: "MPToken", [kind === "CreatedNode" ? "NewFields" : "FinalFields"]: { Account: acct, MPTokenIssuanceID: SHARE, ...(amt != null ? { MPTAmount: String(amt) } : {}) }, ...(prev != null ? { PreviousFields: { MPTAmount: String(prev) } } : {}) } });
  const row = (ledger, txIndex, nodes, res = "tesSUCCESS") => ({ ledger, txIndex, meta: { TransactionResult: res, AffectedNodes: nodes } });
  const txs = [row(10, 0, [mt("CreatedNode", BROKER, null)]), row(11, 1, [mt("CreatedNode", A, 600)]), row(11, 2, [mt("CreatedNode", B, 400)]), row(12, 0, [mt("ModifiedNode", A, 900, 600)]),
    row(12, 1, [mt("CreatedNode", C, 999)], "tecEXPIRED"), row(13, 0, [{ ModifiedNode: { LedgerEntryType: "MPToken", FinalFields: { Account: B, MPTokenIssuanceID: "OTHER", MPTAmount: "5" } } }]),
    row(20, 3, [{ ModifiedNode: { LedgerEntryType: "Loan", FinalFields: {} } }]), row(20, 5, [mt("ModifiedNode", B, 100, 400)]), row(30, 0, [mt("DeletedNode", A, null, 900)]), row(31, 0, [mt("CreatedNode", PSEUDO, 7)])];
  const at = (ledger, txIndex) => S.holdersFromHistory([...txs].reverse(), SHARE, PSEUDO, { ledger, txIndex }).map((h) => [h.account, Number(h.shares)]).sort();
  assert.deepEqual(at(20, 3), [[A, 900], [B, 400]], "at the default tx (index 3): B's later withdrawal in the same ledger not counted");
  assert.deepEqual(at(20, 5), [[A, 900], [B, 100]]); assert.deepEqual(at(30, null), [[B, 100]], "deleted MPToken = 0"); assert.deepEqual(at(40, null), [[B, 100]], "pseudo-account dropped");
  assert.deepEqual(S.holdersFromMptHolders([{ account: A, mpt_amount: "5" }, { account: B, mpt_amount: "0" }, { account: PSEUDO, mpt_amount: "3" }], PSEUDO).map((h) => h.account), [A]);
  ok("snapshot: rebuilt from VaultDeposit/VaultWithdraw metadata at {ledger, txIndex}; failed txs, other MPTs, zero balances and the pseudo-account ignored"); }

// shareSnapshot: Clio mpt_holders when available, else history; leftover payments found by memo
{ const hexs = (t) => Buffer.from(t).toString("hex").toUpperCase(); const LOAN = "AB".repeat(32);
  const mk = (by) => async (url, opt) => { const b = JSON.parse(opt.body); const r = typeof by[b.method] === "function" ? by[b.method](b.params[0]) : by[b.method];
    return { ok: true, json: async () => ({ result: r instanceof Error ? { status: "error", error: r.message } : { status: "success", ...r } }) }; };
  const vault = { ledger_entry: { node: { LedgerEntryType: "Vault", Account: PSEUDO, ShareMPTID: SHARE } } };
  let seen = null;
  let s = await L.shareSnapshot("devnet", { VaultID: "CD".repeat(32), at: { ledger: 20, txIndex: 3 } }, mk({ ...vault, mpt_holders: (p) => { seen = p; return { mptokens: [{ account: A, mpt_amount: "70" }, { account: B, mpt_amount: "30" }] }; } }));
  assert(/Clio/.test(s.source)); assert.equal(seen.ledger_index, 20); assert.equal(seen.mpt_issuance_id, SHARE); assert.deepEqual(s.holders.map((h) => Number(h.shares)), [70, 30]);
  s = await L.shareSnapshot("devnet", { VaultID: "CD".repeat(32), at: { ledger: 20, txIndex: 3 } }, mk({ ...vault, mpt_holders: new Error("unknownCmd"),
    account_tx: { transactions: [{ ledger_index: 11, tx_json: { TransactionType: "VaultDeposit" }, meta: { TransactionIndex: 0, TransactionResult: "tesSUCCESS", AffectedNodes: [{ CreatedNode: { LedgerEntryType: "MPToken", NewFields: { Account: A, MPTokenIssuanceID: SHARE, MPTAmount: "49980000" } } }] } }] } }));
  assert(/history/.test(s.source)); assert.deepEqual(s.holders.map((h) => [h.account, Number(h.shares)]), [[A, 49980000]]);
  assert.deepEqual(L.leftoverMemo(LOAN), { Memo: { MemoType: hexs("duckbank/leftover"), MemoData: hexs(LOAN) } });
  assert.equal(await L.hasLine("devnet", A, Q, mk({ account_lines: { lines: [{ currency: "USD", account: ISS, balance: "0" }] } })), true);
  assert.equal(await L.hasLine("devnet", A, Q, mk({ account_lines: { lines: [] } })), false); assert.equal(await L.hasLine("devnet", A, Q, mk({ account_lines: new Error("actNotFound") })), false);
  ok("shareSnapshot: Clio mpt_holders at the snapshot ledger, else rebuilt from history; leftover memo; trust-line check"); }
console.log("leftover tests ok");
