// Review 2026-10-12: unit, flow, gate, regression and input tests. Pure functions only, no network.
import assert from "node:assert"; import fs from "node:fs";
import * as S from "../src/state.js"; import * as P from "../src/payloads.js";
import { RULES as R, ESCROW as E, NETWORKS, AMENDMENTS, FIRST_POOL, FLAGS, ACCESS } from "../src/config.js";
import { t, pending, xfail, done } from "./harness.js";
const DAY = 86400, ID = "A".repeat(64), SHOP = "rBZaALm7orN4fVnYDmpE4treWZS4x4oQXG", BR = "rBRR9DokNwd2BWmXrNiA28rNRijVMyeTw8";
const COND = "A0258020" + "CD".repeat(32) + "810120", T = FIRST_POOL.terms;
const near = (a, b, eps = 1e-6) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);
const ALL_ON = { SingleAssetVault: true, LendingProtocol: true, LendingProtocolV1_1: true };
const vault = { VaultID: ID, VaultKind: 1, SubscriptionDate: 10_000, RedemptionDate: 10_000 + 103 * DAY };
const exported = Object.keys(S).concat(Object.keys(P)).join(" ");

// ---------- 1. Unit ----------
for (const [feat, re] of [["advance-rate", /advance/i], ["aging", /aging|ageing/i], ["concentration", /concentration/i]])
  if (re.test(exported)) await t(`${feat} exists`, () => {}); else pending(`${feat} rule`, `no ${feat} function or constant in src/state.js, src/payloads.js or src/config.js (grep of src/, bot/, docs and the whitepaper finds none): missing feature`);

await t("150% add line / 120% default line: marginState boundaries", () => {
  assert.equal(E.ADD_LINE_PCT, 150); assert.equal(E.DEFAULT_LINE_PCT, 120);
  assert.equal(S.marginState({ ratio: 150, now: 0 }).state, "ok");
  assert.equal(S.marginState({ ratio: 149.99, belowAddSince: 0, now: 10 }).state, "add-window");
  const after = E.ADD_WINDOW_SECONDS;
  assert.equal(S.marginState({ ratio: 119.99, belowAddSince: 0, now: after }).state, "bot-armed");
  assert.equal(S.marginState({ ratio: 120, belowAddSince: 0, now: after }).state, "below-add");
  assert.equal(S.marginState({ ratio: NaN, now: 0 }).state, "no-ratio");
  assert.equal(S.nextBelowSince(151, 5, 9), null); assert.equal(S.nextBelowSince(140, null, 9), 9); assert.equal(S.nextBelowSince(140, 5, 9), 5);
});
await t("live ratio = sell-side value ÷ owed after cover (ledger default formula)", () => {
  const o = S.owedAfterCover({ TotalValueOutstanding: 100, ManagementFeeOutstanding: 1, DebtTotal: 100, CoverAvailable: 50, CoverRateMinimum: 15000, CoverRateLiquidation: 100000 });
  near(o.DefaultAmount, 99); near(o.coverPayable, 15); near(o.net, 84);
  near(S.escrowRatioPct(126, o.net), 150); assert.equal(S.escrowRatioPct(1, 0), Infinity);
});
await t("cover formulas: LoanSet minimum and default cover (devnet run B figures)", () => {
  near(S.coverRequired(0, 1000, 50, 15000), 157.5);
  const d = S.defaultCover({ DebtTotal: 999.97, CoverRateMinimum: 15000, CoverRateLiquidation: 100000, CoverAvailable: 200, DefaultAmount: 999.97 });
  near(d.defaultCovered, 149.9955); near(d.vaultLoss, 849.9745);
  near(S.defaultCover({ DebtTotal: 100, CoverRateMinimum: 15000, CoverRateLiquidation: 100000, CoverAvailable: 5, DefaultAmount: 100 }).defaultCovered, 5);
});
await t("AssetsMaximum enforcement: checks #6, #13, #14, #19 and planUnderCap", () => {
  const s = { AssetsMaximum: 1000, DebtMaximum: 1000, AssetsTotal: 1000, AssetsAvailable: 1000, DebtTotal: 0 };
  assert.equal(S.loanSetCapCheck(s, 900, T, R.FEE_RATE).check, 6);
  assert.equal(S.loanSetCapCheck({ ...s, AssetsTotal: 900, AssetsAvailable: 100 }, 900, T, R.FEE_RATE).check, 13);
  const pl = S.planUnderCap(1000, T, R.FEE_RATE);
  assert(S.loanSetCapCheck({ ...s, AssetsTotal: pl.maxPrincipal, AssetsAvailable: pl.maxPrincipal }, pl.maxPrincipal, T, R.FEE_RATE).ok);
  assert.equal(S.loanSetCapCheck({ ...s, AssetsTotal: 999, AssetsAvailable: 999 }, 999, T, R.FEE_RATE).check, 14);
  assert.equal(S.loanSetCapCheck({ ...s, AssetsMaximum: 0, AssetsTotal: 999, AssetsAvailable: 999 }, 999, T, R.FEE_RATE).check, 19);
  assert(pl.maxPrincipal + pl.interestDue <= 1000); assert(!pl.fullCapFails.ok);
  assert.equal(S.maxPrincipal({ ...s }, T, R.FEE_RATE).max, 0);
});
await t("interest booking (spec, upfront): InterestDue = total interest − management fee, booked at LoanSet", () => {
  const m = S.loanMath(1000, T, R.FEE_RATE); near(m.interestDue, m.interestGross * 0.99); assert(m.interestDue > 0);
});
await xfail("interest booking on devnet is cash basis (brief: upfront)", "devnet run A/C: interest reached AssetsTotal only as LoanPay arrived; state.js only models the upfront (spec) booking, there is no cash-basis model", () => {
  assert(/cash/i.test(exported), "no cash-basis booking function exported");
});

// ---------- 2. Flow ----------
await t("subscription window open/closed: VaultDeposit gate (tecEXPIRED after SubscriptionDate)", () => {
  assert(S.depositGate(vault, vault.SubscriptionDate).ok); assert.equal(S.depositGate(vault, vault.SubscriptionDate + 1).code, "tecEXPIRED");
});
await t("investment window: ledger window open but app blocks LoanSet with no escrow", () => {
  const now = vault.SubscriptionDate + 1; assert(S.loanSetWindowGate(vault, T, now).ok);
  const pool = { escrow: { condition: COND }, terms: T };
  const g = S.loanSetEscrowGate(pool, { escrows: { verified: 0 }, vault, now }); assert(!g.ok); assert(g.reasons.some((r) => /blocked until the borrower's XRP escrow/.test(r)));
  assert(!S.loanSetEscrowGate({ ...pool, escrow: { condition: null } }, { escrows: { verified: 1 }, ratio: 200, vault, now }).ok, "no published Condition");
  assert(!S.loanSetEscrowGate(pool, { escrows: { verified: 1 }, ratio: 149.9, vault, now }).ok, "under 150% at open");
  assert(S.loanSetEscrowGate(pool, { escrows: { verified: 1 }, ratio: 150, vault, now }).ok);
  assert(!S.loanSetEscrowGate(pool, { escrows: { verified: 1 }, ratio: 200, vault, now: S.appLoanSetDeadline(vault, T) + 1 }).ok, "past app deadline");
});
await t("dual signature: LoanSet without CounterpartySignature is refused; exactly one signature form", () => {
  const tx = P.loanSet({ LoanBrokerID: ID, Counterparty: SHOP, PrincipalRequested: 100, terms: T });
  assert.throws(() => P.assertLoanSetComplete(tx), /temBAD_SIGNER/);
  assert.throws(() => P.withCounterpartySignature(tx, {}), /exactly one/);
  assert.throws(() => P.withCounterpartySignature(tx, { SigningPubKey: "02AB", TxnSignature: "30", Signers: [{}] }), /exactly one/);
  assert(P.assertLoanSetComplete(P.withCounterpartySignature(tx, { SigningPubKey: "02AB", TxnSignature: "30" })));
});
await t("redemption blocked until RedemptionDate even if the loan is late", () => {
  const late = vault.RedemptionDate - DAY;
  const loan = { PaymentRemaining: 2, NextPaymentDueDate: late - 30 * DAY, GracePeriod: 7 * DAY, Flags: FLAGS.lsfLoanImpaired };
  assert(S.defaultGate(loan, late).ok, "loan is past grace"); assert.equal(S.vaultPhase(vault, late), "Investment");
  assert.equal(S.vaultPhase(vault, vault.RedemptionDate), "Redemption");
});

// ---------- 4. Gates ----------
await t("mainnet deposit rejected even with all amendments reported on", () => {
  const g = S.networkGate("mainnet", ALL_ON); assert(!g.ok); assert(g.reasons.some((r) => /hard-off/.test(r)));
  assert(!S.networkGate("testnet", ALL_ON).ok); assert(!S.networkGate("mainnet", null).ok); assert(!S.networkGate("bogus", ALL_ON).ok);
  assert.deepEqual(AMENDMENTS.required, ["SingleAssetVault", "LendingProtocol", "LendingProtocolV1_1"]);
  for (const a of AMENDMENTS.required) assert(!S.networkGate("devnet", { ...ALL_ON, [a]: false }, { issuer: SHOP }).ok, a);
});
await t("devnet path requires a test issuer (never the RLUSD code)", () => {
  const g = S.networkGate("devnet", ALL_ON, { issuer: "" }); assert(!g.ok); assert(g.reasons.some((r) => /test-issuer/.test(r)));
  assert(S.networkGate("devnet", ALL_ON, { issuer: SHOP }).ok); assert.notEqual(NETWORKS.devnet.asset.currency, NETWORKS.mainnet.asset.currency);
  assert.throws(() => P.vaultDeposit({ VaultID: ID, asset: { currency: "X", issuer: "" }, amount: 1 }), /issuer/);
});
await t("mainnet hard-off is a frozen constant (fixed: deep Object.freeze in config.js)", () => {
  assert(Object.isFrozen(NETWORKS) && Object.isFrozen(NETWORKS.mainnet) && Object.isFrozen(NETWORKS.mainnet.asset));
  assert.throws(() => { "use strict"; NETWORKS.mainnet.vaultLending = true; }); assert.equal(NETWORKS.mainnet.vaultLending, false);
});

// ---------- 6. Regression ----------
await t("no cover-only path: a pool without an escrow never passes the LoanSet gate", () => {
  const g = S.loanSetEscrowGate({ path: "cover-only", capRlusd: 1000, deskFile: "file 12", escrow: { condition: null, records: [] }, terms: T }, {}); assert(!g.ok);
  const s = S.seed(); const p = S.apply(s, { account: SHOP, capRlusd: "500", ratePct: "10", paymentTotal: "3", intervalDays: "30", graceDays: "7", access: { ok: true } });
  S.recordCondition(s, p.id, COND); S.recordEscrow(s, p.id, { owner: SHOP, seq: 1 }); assert.equal(p.escrow.records.length, 1);
});
await t("access rules never build a tx moving RLUSD or XRP; the access payload moves only QAK to the frozen address", () => {
  const s = S.seed(); S.apply(s, { account: SHOP, capRlusd: "1000", ratePct: "10", paymentTotal: "3", intervalDays: "30", graceDays: "7", access: { ok: true } });
  assert(!/TransactionType|"Amount"|"Destination"/.test(JSON.stringify(s)));
  const pay = P.accessPayment({ account: SHOP }); assert.equal(pay.Destination, ACCESS.ADDRESS); assert.equal(pay.Amount.currency, "QAK"); assert.equal(pay.Amount.value, "1000000");
  assert(Object.isFrozen(ACCESS)); assert.throws(() => { "use strict"; ACCESS.ADDRESS = BR; }); assert.equal(ACCESS.ADDRESS, "rpRVzQSeZxxakWryRuTchxGQN7cs5oPi52");
});

// ---------- Input sanitization (security check) ----------
const base = { account: SHOP, label: "X", capRlusd: "1000", ratePct: "10", paymentTotal: "3", intervalDays: "30", graceDays: "7", access: { ok: true } };
await t("apply: NaN / negative / huge / fractional caps and rates are rejected", () => {
  for (const [k, v] of [["capRlusd", "NaN"], ["capRlusd", "-5"], ["capRlusd", "1e9"], ["capRlusd", "10.5"], ["capRlusd", "Infinity"], ["ratePct", "-1"], ["ratePct", "37"], ["paymentTotal", "2.5"], ["intervalDays", "0"], ["graceDays", "31"], ["label", "x".repeat(61)], ["access", null], ["access", { ok: "yes" }]])
    assert.throws(() => S.apply(S.seed(), { ...base, [k]: v }), undefined, `${k}=${v} accepted`);
});
await t("apply stores a script-like borrower label verbatim (escaped at render by main.js esc())", () => {
  const p = S.apply(S.seed(), { ...base, label: "<img src=x onerror=alert(1)>" }); assert.equal(p.label, "<img src=x onerror=alert(1)>");
});
await t("payload value(): an amount that rounds to 0 at 6 decimals is refused [BUG payloads.js:9]", () => {
  assert.throws(() => P.value(0.0000004), /amount/, `value(0.0000004) returned "${(() => { try { return P.value(0.0000004); } catch { return "throw"; } })()}"`);
});
await t("payload value(): decimal strings, trailing zeros, precision", () => {
  assert.equal(P.value(100), "100"); assert.equal(P.value("10.50"), "10.5"); assert.equal(P.value(0.1 + 0.2), "0.3"); assert.equal(P.value(0.000001), "0.000001"); assert.equal(P.value(24.9851034), "24.985103");
  for (const bad of ["1e3", "abc", "", null, undefined, NaN, -1, 0, Infinity, 1e15, "-2"]) assert.throws(() => P.value(bad), undefined, String(bad));
});
await t("payload value(): huge amounts never produce exponent notation [BUG payloads.js:9]", () => {
  const v = (() => { try { return P.value(1e21); } catch { return "throw"; } })(); assert(v === "throw" || !/e/i.test(v), `value(1e21) = "${v}"`);
});
await t("localStorage tampering: sanitizeState drops malformed pools and stale shop-era fields", () => {
  const good = S.seed().pools[0];
  const st = S.sanitizeState({ pools: [{ ...good, holdingVerified: true, stage: "listed", votes: { yes: 9e9, no: 0 } }, { ...good, id: "x y" }, { ...good, id: "n2", network: "evil" }, { ...good, id: "n3", capRlusd: 1e9 }], queue: [{ who: 1 }] });
  assert.equal(st.pools.length, 1); for (const k of ["holdingVerified", "stage", "votes"]) assert(!(k in st.pools[0]), k); assert(!("queue" in st));
});
await t("localStorage tampering cannot grant access: no access flag is stored, and transactions re-check the ledger", () => {
  const good = S.seed().pools[0]; const st = S.sanitizeState({ pools: [{ ...good, access: { ok: true }, accessVerified: true }] });
  assert(!("access" in st.pools[0]) && !("accessVerified" in st.pools[0]));
  const main = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8"); assert(/const acc = accessOf\(p\.account\), listed = acc\.ok \? \[\] : \[acc\.reason\]/.test(main), "actions gate on the live access read");
});
done("test/review.unit.test.js");
