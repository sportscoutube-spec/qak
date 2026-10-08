import * as S from "./state.js"; import { RULES as R, TOKENOMICS as K, TEAM, ROADMAP, FIRST_POOL, NETWORKS, AMENDMENTS } from "./config.js"; import assert from "node:assert";
const ok = (n) => console.log("ok -", n); const A = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY"; const DAY = 86400;
const near = (a, b, eps = 1e-6) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);

// Tokenomics, team, roadmap
assert.equal(K.supply, 1_000_000_000); assert.equal(K.buckets.reduce((t, b) => t + b.tokens, 0), R.TOTAL_SUPPLY_QAK);
assert.deepEqual(K.buckets.map((b) => [b.name, b.pct]), [["Public pool", 50], ["Team", 10], ["Marketing", 20], ["AMM", 20]]);
assert.equal(K.escrow.reduce((t, e) => t + e.tokens, 0), 500_000_000); assert.deepEqual(K.launch, { liquidityXrp: 50, ammFeePct: 1, antiSniperMin: 15 });
assert.deepEqual(TEAM.map((t) => t.name), ["McQAK", "Donald QAK", "Della", "Huey QAK"]); assert.equal(ROADMAP.length, 3);
ok("tokenomics, team, roadmap");

// Seed: exactly one first pool, cap 10,000, no ledger ids
{ const s = S.seed(); assert.equal(s.pools.length, 1); const p = s.pools[0]; assert.equal(p.capRlusd, 10000); assert(p.sample);
  assert.deepEqual(Object.values(p.ledger), [null, null, null, null, null, null, null]); assert(S.planFits(p.plan, p.terms));
  assert.deepEqual(S.validateLoanTerms({ ...p.terms, PrincipalRequested: 1 }), []); assert(p.terms.GracePeriod <= p.terms.PaymentInterval); ok("seed: one first pool, no fake ids, grace <= interval"); }

// Window gating (XLS-65.1.4 phases; XLS-65 §3.5.2.2 #15; XLS-66 §3.8.5.2 #25-27)
{ const v = { VaultID: "A".repeat(64), VaultKind: 1, SubscriptionDate: 1000, RedemptionDate: 1000 + 100 * DAY }; const t = FIRST_POOL.terms;
  assert.equal(S.vaultPhase({ VaultID: null }, 0), "not created yet"); assert.equal(S.vaultPhase({ ...v, VaultKind: 0 }, 0), "NoPhase");
  assert.equal(S.vaultPhase(v, 1000), "Subscription"); assert.equal(S.vaultPhase(v, 1001), "Investment"); assert.equal(S.vaultPhase(v, v.RedemptionDate - 1), "Investment"); assert.equal(S.vaultPhase(v, v.RedemptionDate), "Redemption");
  assert(S.depositGate(v, 1000).ok); assert.equal(S.depositGate(v, 1001).code, "tecEXPIRED"); assert.equal(S.depositGate(v, v.RedemptionDate).code, "tecEXPIRED"); assert(!S.depositGate({ VaultID: null }, 0).ok);
  assert.equal(S.loanSetWindowGate(v, t, 1000).code, "tecTOO_SOON"); assert.equal(S.loanSetWindowGate(v, t, v.RedemptionDate).code, "tecEXPIRED");
  const last = S.latestLoanSetTime(v, t); assert.equal(last, v.RedemptionDate - 90 * DAY - 60);
  assert(S.loanSetWindowGate(v, t, 1001).ok); assert(S.loanSetWindowGate(v, t, last).ok); assert.equal(S.loanSetWindowGate(v, t, last + 1).code, "tecNO_PERMISSION");
  assert(!S.loanSetWindowGate({ ...v, VaultKind: 0 }, t, 1001).ok); ok("window gating: subscription deposits, investment LoanSet, 60 s redemption buffer"); }
{ assert.throws(() => S.checkVaultDates(1000, 1179), /180/); S.checkVaultDates(1000, 1180); assert.throws(() => S.checkVaultDates(1000, 1000 + 946708560), /946708560/);
  assert.throws(() => S.checkVaultDates(100, 1000, 100), /tecEXPIRED/); assert.throws(() => S.checkVaultDates(null, 1000), /ClosedEnded/);
  const d = S.planDates(FIRST_POOL.plan, 5000); assert.equal(d.SubscriptionDate, 5000 + 14 * DAY); assert.equal(d.RedemptionDate, d.SubscriptionDate + 100 * DAY); ok("VaultCreate date checks"); }

// Loan terms (XLS-66 §3.8.5.1)
{ const t = { PrincipalRequested: 100, InterestRate: 10000, PaymentTotal: 3, PaymentInterval: 30 * DAY };
  assert.match(S.validateLoanTerms({ ...t, GracePeriod: 31 * DAY }).join(), /GracePeriod/); assert.match(S.validateLoanTerms({ ...t, GracePeriod: 59 }).join(), /GracePeriod/);
  assert.deepEqual(S.validateLoanTerms({ ...t, GracePeriod: 30 * DAY }), []); assert.match(S.validateLoanTerms({ ...t, GracePeriod: 60, PaymentInterval: 59 }).join(), /PaymentInterval/);
  assert.match(S.validateLoanTerms({ ...t, GracePeriod: 60, PaymentTotal: 0 }).join(), /PaymentTotal/); assert.match(S.validateLoanTerms({ ...t, GracePeriod: 60, InterestRate: 100001 }).join(), /InterestRate/);
  ok("loan terms: GracePeriod 60..PaymentInterval, interval >= 60, PaymentTotal > 0"); }

// Amortization and cap math (XLS-66 A-2; §3.8.5.2 #6, #13, #14, #19)
{ const t = FIRST_POOL.terms; const m = S.loanMath(1000, { ...t, InterestRate: 0 }, 1000); near(m.periodicPayment, 1000 / 3); near(m.interestDue, 0);
  const r = 0.1 * 30 * DAY / 31536000, R3 = (1 + r) ** 3, pp = 1000 * r * R3 / (R3 - 1); const mm = S.loanMath(1000, t, 1000);
  near(mm.periodicPayment, pp); near(mm.interestGross, pp * 3 - 1000); near(mm.interestDue, (pp * 3 - 1000) * 0.99); near(mm.managementFee, (pp * 3 - 1000) * 0.01);
  const pl = S.planUnderCap(10000, t, 750); assert.equal(pl.maxPrincipal, 9839.02); assert(pl.maxPrincipal + pl.interestDue <= 10000); assert.equal(pl.depositTarget, pl.maxPrincipal);
  assert.equal(pl.fullCapFails.ok, false); assert.equal(pl.fullCapFails.check, 6);
  // the user's numbers: 10,000 deposited + 10,000 principal fails; the computed max passes all cap checks for both fee tiers
  assert.equal(S.loanSetCapCheck({ AssetsMaximum: 10000, DebtMaximum: 10000, AssetsTotal: 10000, AssetsAvailable: 10000, DebtTotal: 0 }, 10000, t, 1000).code, "tecLIMIT_EXCEEDED");
  assert.equal(S.loanSetCapCheck({ AssetsMaximum: 0, DebtMaximum: 10000, AssetsTotal: 10000, AssetsAvailable: 10000, DebtTotal: 0 }, 10000, t, 1000).check, 19);
  assert.equal(S.loanSetCapCheck({ AssetsMaximum: 10000, DebtMaximum: 0, AssetsTotal: 9990, AssetsAvailable: 9990, DebtTotal: 0 }, 9990, t, 1000).check, 14);
  assert.equal(S.loanSetCapCheck({ AssetsMaximum: 10000, DebtMaximum: 10000, AssetsTotal: 500, AssetsAvailable: 500, DebtTotal: 0 }, 600, t, 1000).check, 13);
  for (const fee of [750, 1000]) assert(S.loanSetCapCheck({ AssetsMaximum: 10000, DebtMaximum: 10000, AssetsTotal: pl.maxPrincipal, AssetsAvailable: pl.maxPrincipal, DebtTotal: 0 }, pl.maxPrincipal, t, fee).ok);
  assert.equal(S.maxPrincipal({ AssetsMaximum: 10000, DebtMaximum: 10000, AssetsTotal: 10000, AssetsAvailable: 10000 }, t, 750).max, 0);
  const mx = S.maxPrincipal({ AssetsMaximum: 10000, DebtMaximum: 10000, AssetsTotal: 9000, AssetsAvailable: 9000, DebtTotal: 0 }, t, 750); assert.equal(mx.max, 8999.99); assert.equal(mx.reason, "AssetsAvailable");
  assert.equal(S.capMathFeeRate({ ledger: { ManagementFeeRate: null } }), 750); assert.equal(S.capMathFeeRate({ ledger: { ManagementFeeRate: 1000 } }), 1000);
  ok("cap math: interest counts toward AssetsMaximum/DebtMaximum; max principal 9,839.02 under 10,000"); }

// Cover (XLS-66 §3.8.5.2 #20, §3.10.5)
{ near(S.coverRequired(0, 9839.02, 160.96, 15000), 9999.98 * 0.15);
  const ex = S.defaultCover({ DebtTotal: 1090, CoverRateMinimum: 10000, CoverRateLiquidation: 10000, CoverAvailable: 1000, DefaultAmount: 1090 }); near(ex.defaultCovered, 10.9); near(ex.vaultLoss, 1079.1); // spec §3.1.11 example
  const a = S.defaultCover({ DebtTotal: 10000, CoverRateMinimum: 15000, CoverRateLiquidation: 100000, CoverAvailable: 1500, DefaultAmount: 10000 }); near(a.defaultCovered, 1500); near(a.vaultLoss, 8500);
  const b = S.defaultCover({ DebtTotal: 10000, CoverRateMinimum: 15000, CoverRateLiquidation: 100000, CoverAvailable: 900, DefaultAmount: 10000 }); near(b.defaultCovered, 900);
  const c = S.defaultCover({ DebtTotal: 10000, CoverRateMinimum: 15000, CoverRateLiquidation: 100000, CoverAvailable: 5000, DefaultAmount: 400 }); near(c.defaultCovered, 400); near(c.vaultLoss, 0);
  const d = S.defaultCover({ DebtTotal: 10000, CoverRateMinimum: 15000, CoverRateLiquidation: 50000, CoverAvailable: 5000, DefaultAmount: 10000 }); near(d.defaultCovered, 750);
  ok("cover payout = min(DebtTotal x CRM x CRL, DefaultAmount, CoverAvailable); rest written down on the vault"); }

// Servicing: fixed installments, impairment, default after grace, delete (fixCleanup3_4_0 boundaries)
{ const loan = { PaymentRemaining: 3, NextPaymentDueDate: 5000, GracePeriod: 600, PeriodicPayment: "3333.5", LoanServiceFee: "0", Flags: 0 };
  assert(S.loanPayCheck(loan, 3333.5, false, 5000).ok); assert.equal(S.loanPayCheck(loan, 1000, false, 4000).code, "tecINSUFFICIENT_PAYMENT");
  assert.equal(S.loanPayCheck(loan, 3333.5, false, 5001).code, "tecEXPIRED"); assert(S.loanPayCheck(loan, 3333.5, true, 5001).ok);
  assert.equal(S.loanPayCheck({ ...loan, PaymentRemaining: 0 }, 1, false, 0).code, "tecKILLED");
  assert.equal(S.impairGate(loan, 5000).code, "tecTOO_SOON"); assert(S.impairGate(loan, 5001).ok); assert.equal(S.impairGate({ ...loan, Flags: 0x00020000 }, 6000).code, "tecNO_PERMISSION");
  assert.equal(S.defaultGate(loan, 5600).code, "tecTOO_SOON"); assert(S.defaultGate(loan, 5601).ok); assert(S.defaultGate({ ...loan, Flags: 0x00020000 }, 5601).ok, "impaired loans can be defaulted");
  assert.equal(S.deleteGate(loan).code, "tecHAS_OBLIGATIONS"); assert(S.deleteGate({ ...loan, PaymentRemaining: 0 }).ok);
  ok("servicing: fixed installment, late flag, impair after due, default after grace, delete when settled"); }

// Three-amendment gating and the mainnet hard-off
{ const all = { SingleAssetVault: true, LendingProtocol: true, LendingProtocolV1_1: true }; const iss = { issuer: "rTESTissuerxxxxxxxxxxxxxxxxxxxxxx" };
  assert.deepEqual(AMENDMENTS.required, ["SingleAssetVault", "LendingProtocol", "LendingProtocolV1_1"]);
  assert(S.networkGate("devnet", all, iss).ok);
  for (const a of AMENDMENTS.required) { const g = S.networkGate("devnet", { ...all, [a]: false }, iss); assert(!g.ok); assert.match(g.reasons.join(), new RegExp(a + " is not enabled")); }
  assert.match(S.networkGate("devnet", null, iss).reasons.join(), /not checked/);
  const m = S.networkGate("mainnet", all); assert(!m.ok); assert.match(m.reasons.join(), /hard-off/); assert.equal(NETWORKS.mainnet.vaultLending, false);
  assert(!S.networkGate("testnet", all).ok);
  const noIss = S.networkGate("devnet", all, { issuer: "" }); assert(!noIss.ok); assert.match(noIss.reasons.join(), /RLUSD does not exist on devnet/);
  assert.equal(NETWORKS.devnet.asset.issuer, "", "no devnet issuer invented"); assert.match(NETWORKS.devnet.asset.placeholder, /PLACEHOLDER/);
  assert.notEqual(NETWORKS.devnet.asset.currency, NETWORKS.mainnet.asset.currency, "devnet test token must not use the RLUSD code"); assert.equal(Buffer.from(NETWORKS.devnet.asset.currency.slice(0, 8), "hex").toString(), "DUSD");
  assert.match(NETWORKS.devnet.asset.label, /test token/); assert.match(NETWORKS.devnet.asset.label, /not RLUSD/); assert.equal(NETWORKS.mainnet.vaultLending, false, "mainnet hard-off");
  ok("gating: all three amendments required, mainnet hard-off, devnet needs a test issuer"); }

// QAK fee cut at broker creation
{ assert.equal(S.feeRateAtBrokerCreation(99_999), 1000); assert.equal(S.feeRateAtBrokerCreation(100_000), 750); assert.equal(S.feePct(750), "0.75"); ok("fee cut decided at broker creation"); }

// Application, votes, queue, ledger ids
{ const s = S.seed(); const f = { shop: " Shop ", city: "Athens", purpose: "stock", capRlusd: 10000, ratePct: 10, paymentTotal: 3, intervalDays: 30, graceDays: 7, listingLock: 250000, account: A, ledgerQak: 250000, ledgerVerified: true };
  assert.throws(() => S.apply(s, { ...f, account: undefined }), /connect/); assert.throws(() => S.apply(s, { ...f, account: "guest" }), /connect/);
  for (const [k, v, re] of [["shop", "  ", /required/], ["shop", "x".repeat(61), /max 60/], ["city", "", /required/], ["ratePct", -1, /rate/], ["ratePct", 36.5, /rate/], ["ratePct", "abc", /number/],
    ["capRlusd", 0, /cap/], ["capRlusd", 10001, /cap/], ["capRlusd", 1.5, /cap/], ["paymentTotal", 0, /payments/], ["paymentTotal", 13, /payments/], ["intervalDays", 0, /interval/], ["intervalDays", 91, /interval/],
    ["graceDays", 31, /GracePeriod <= PaymentInterval/], ["graceDays", 0, /grace/], ["listingLock", 250001, /listing lock/], ["ledgerQak", 249999, /covered/], ["ledgerQak", undefined, /covered/], ["purpose", "x", /purpose/]])
    assert.throws(() => S.apply(s, { ...f, [k]: v }), re, k + "=" + v);
  assert.throws(() => S.apply(s, { ...f, paymentTotal: 12, intervalDays: 30 }), /180 days/);
  const p = S.apply(s, f); assert.equal(p.shop, "Shop"); assert.equal(p.terms.InterestRate, 10000); assert.equal(p.terms.GracePeriod, 7 * DAY); assert.equal(p.ledger.VaultID, null);
  assert(/^p_[0-9a-f-]{36}$/.test(p.id)); assert(S.planFits(p.plan, p.terms));
  assert.throws(() => S.vote(s, p.id, true, 10), /connect/); assert.throws(() => S.vote(s, p.id, true, 2e9, A), /QAK weight/);
  S.voteCap(s, p.id, 8000, 5000, A); S.vote(s, p.id, true, 1200, A); assert.equal(p.stage, "listed"); assert.equal(p.capRlusd, 8000); assert.throws(() => S.voteCap(s, p.id, 9000, 1, A), /only while applied/);
  assert.throws(() => S.voteCap(S.seed(), "first", 10001, 1, A), /cap vote/);
  S.enqueue(s, A, p.id, 100, 5); S.enqueue(s, "rB" + "x".repeat(30), p.id, 100, 50); assert.equal(s.queue[0].qakLocked, 50);
  const V = "B".repeat(64); S.recordLedger(s, p.id, "VaultID", V); assert.throws(() => S.recordLedger(s, p.id, "VaultID", "C".repeat(64)), /already set/);
  assert.throws(() => S.recordLedger(s, "first", "VaultID", V), /another shop/); ok("application, votes, queue, one shop per vault"); }

// Load-time validation
{ const s = S.seed(); const p = S.apply(s, { shop: "A", city: "B", purpose: "stock", capRlusd: 5000, ratePct: 5, paymentTotal: 1, intervalDays: 30, graceDays: 30, listingLock: 250000, account: A, ledgerQak: 3e5 });
  const bad = JSON.parse(JSON.stringify(s)); const t = bad.pools[1];
  bad.pools.push({ ...t, id: "x<img>" }, { ...t, id: "ok2", shop: "y".repeat(500) }, { ...t, id: "ok3", terms: { ...t.terms, GracePeriod: t.terms.PaymentInterval + 1 } }, { ...t }, null,
    { ...t, id: "ok4", ledger: { ...t.ledger, VaultID: "fake-id" } }, { ...t, id: "ok5", capRlusd: 20000 }, { ...t, id: "ok6", stage: "drawn" });
  const c = S.sanitizeState(bad); assert.equal(c.pools.length, 2); assert.equal(S.sanitizeState({ pools: "x" }), null); assert.equal(S.sanitizeState(null), null);
  const two = JSON.parse(JSON.stringify(s)); two.pools[0].ledger.VaultID = "D".repeat(64); two.pools[1].ledger.VaultID = "D".repeat(64); assert.equal(S.sanitizeState(two).pools.length, 1, "second shop on the same vault dropped");
  assert.equal(p.ledger.LoanID, null); ok("load-time validation drops bad records and duplicate vaults"); }
console.log("state tests ok");
