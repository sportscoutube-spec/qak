// Review fixes 2026-10-12: S1 key split helpers, S2 funding guards, account_tx paging, dry-run redaction, site footer.
import assert from "node:assert"; import fs from "node:fs";
import { redact, GRANT, checkGrant, asBroker, slotStatus, fundingState, finishable, noPayoutReason } from "../bot/escrow-bot.js";
import * as S from "../src/state.js";
import { accountTxSince, fundMemo, fundOf } from "../src/ledger.js";
import { t, done } from "./harness.js";
const ID = "C".repeat(64);
await t("redact blanks the Fulfillment at any depth", () => {
  const r = redact({ RawTransactions: [{ RawTransaction: { TransactionType: "EscrowFinish", Fulfillment: "A0228020AB" } }] });
  assert.equal(r.RawTransactions[0].RawTransaction.Fulfillment, "[redacted]"); assert(!JSON.stringify(r).includes("A0228020AB"));
});
await t("checkGrant: exactly OfferCreate; missing or broader grants refused", () => {
  const e = (...p) => ({ Permissions: p.map((x) => ({ Permission: { PermissionValue: x } })) });
  assert.deepEqual(GRANT, ["OfferCreate"]); assert.equal(checkGrant(e("OfferCreate")), null);
  assert.match(checkGrant(null), /no XLS-75 grant/); assert.match(checkGrant(e("OfferCreate", "Payment")), /broader.*Payment/); assert.match(checkGrant(e()), /lacks OfferCreate/);
});
await t("asBroker adds Delegate only when the signer is not the broker", () => {
  assert.deepEqual(asBroker({ TransactionType: "OfferCreate" }, "rB", "rH"), { TransactionType: "OfferCreate", Account: "rB", Delegate: "rH" });
  assert(!("Delegate" in asBroker({}, "rB", "rB")));
});
await t("slotStatus: Sequence must equal the account Sequence; Ticket must exist", () => {
  assert(slotStatus({ Sequence: 7 }, { accountSequence: 7 }).ok); assert(!slotStatus({ Sequence: 7 }, { accountSequence: 8 }).ok);
  assert(slotStatus({ Sequence: 0, TicketSequence: 9 }, { ticketExists: true }).ok); assert(!slotStatus({ Sequence: 0, TicketSequence: 9 }, { ticketExists: false }).ok);
});
await t("fundingState: idempotent per blob; a voided funded blob forfeits further funding and is owed by the shop", () => {
  assert.deepEqual(fundingState({ blobHash: "A" }), { paid: false, funded: false, forfeited: [], owedByShop: 0 });
  assert(fundingState({ fundPays: [{ blobHash: "A", amount: 5 }], blobHash: "A" }).funded);
  const s = fundingState({ fundPays: [{ blobHash: "A", amount: 5 }], loanPays: [], blobHash: "B" }); assert.equal(s.owedByShop, 5);
  assert.equal(fundingState({ fundPays: [{ blobHash: "A", amount: 5 }], loanPays: ["A"], blobHash: "B" }).forfeited.length, 0);
});
await t("fund memo round-trips", () => { const h = "AB".repeat(32); assert.equal(fundOf({ Memos: [fundMemo(ID, h)] }, ID), h); assert.equal(fundOf({ Memos: [fundMemo(ID, h)] }, "D".repeat(64)), null); });
await t("accountTxSince pages with markers and stops at the LoanSet that created the loan", async () => {
  const pages = [
    { transactions: [{ hash: "1", ledger_index: 30, tx_json: { TransactionType: "Payment" }, meta: {} }], marker: "m1" },
    { transactions: [{ hash: "2", ledger_index: 20, tx_json: { TransactionType: "LoanSet" }, meta: { AffectedNodes: [{ CreatedNode: { LedgerEntryType: "Loan", LedgerIndex: ID } }] } }], marker: "m2" },
    { transactions: [{ hash: "3", ledger_index: 10, tx_json: { TransactionType: "Payment" }, meta: {} }] }];
  const seen = []; const f = async (_u, o) => { const b = JSON.parse(o.body); seen.push(b.params[0].marker); return { ok: true, json: async () => ({ result: pages[seen.length - 1] }) }; };
  const rows = await accountTxSince("devnet", "rX", { LoanID: ID }, f);
  assert.deepEqual(rows.map((r) => r.hash), ["1", "2"]); assert.deepEqual(seen, [undefined, "m1"]);
});
await t("site footer 'code is not audited' is in index.html (every route renders inside it)", () => {
  assert.match(fs.readFileSync(new URL("../index.html", import.meta.url), "utf8"), /<footer id="site-footer">[^<]*The code is not audited/);
});
await t("finishable: expired or near-expiry escrows are left out of the Batch (run-e cause); not-yet-finishable ones wait", () => {
  const n = { FinishAfter: 845108610, CancelAfter: 845109360 };
  assert.equal(finishable(n, 845109672).ok, false); assert.equal(finishable(n, 845109672).later, false); assert.match(finishable(n, 845109672).why, /CancelAfter/);
  assert.equal(finishable(n, 845109340).ok, false, "inside the 30 s margin"); assert.equal(finishable(n, 845108000).later, true);
  assert(finishable(n, 845109000).ok); assert(finishable({ CancelAfter: 100 }, 50).ok);
  const src = fs.readFileSync(new URL("../bot/escrow-bot.js", import.meta.url), "utf8"); assert(/finishable\(e\.node, r\.now\)/.test(src), "once() filters rows through finishable");
});
await t("leftover 0 with share holders is reported as nothing to distribute, not as 'no share holders' (run-e bug)", () => {
  const holders = [{ account: "rA", shares: 30000000n }, { account: "rB", shares: 19980000n }];
  const split = S.proRata(0, holders); assert.equal(split.payouts.length, 0);
  assert.match(noPayoutReason(split, holders), /nothing to distribute to the 2 share holders/); assert.doesNotMatch(noPayoutReason(split, holders), /no share holders/);
  assert.match(noPayoutReason(S.proRata(5, []), []), /no share holders/);
});
done("test/review.fixes.test.js");
