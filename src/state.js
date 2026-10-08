// Duck Bank model. Two layers:
//  1. Ledger math that mirrors XLS-65/66 checks (pure functions; formulas cited per spec section).
//  2. Off-ledger app state: applications, QAK votes, the QAK-ordered queue and shop name/city/purpose next to the ledger ids.
// Nothing here submits a transaction.
import { RULES as R, LIMITS as L, SPEC, AMENDMENTS, NETWORKS, FIRST_POOL, RIPPLE_EPOCH, ESCROW as E, NO_XRP, PATHS, FLAGS } from "./config.js";
const req = (c, m) => { if (!c) throw new Error(m); };
const DAY = 86400;
export const nowRipple = (ms = Date.now()) => Math.floor(ms / 1000) - RIPPLE_EPOCH;
export const fromRipple = (t) => (t == null ? null : new Date((t + RIPPLE_EPOCH) * 1000));
const floorCents = (x) => Math.floor(x * 100 + 1e-9) / 100;
const tenthBps = (v) => v / SPEC.TENTH_BPS_100PCT;

// ---------- XLS-65.1.4: closed-ended vault phases ----------
// Phase is derived from the parent ledger close time `now`; it is not stored.
export function vaultPhase(v, now) {
  if (!v || !v.VaultID) return "not created yet";
  if (v.VaultKind !== SPEC.VaultKind.ClosedEnded) return "NoPhase";
  if (now <= v.SubscriptionDate) return "Subscription";
  if (now < v.RedemptionDate) return "Investment";
  return "Redemption";
}
// VaultCreate data checks for a closed-ended vault (XLS-65 §3.2.5.1 #5, §3.2.5.2 #8-9).
export function checkVaultDates(sub, red, now) {
  req(Number.isInteger(sub) && Number.isInteger(red), "SubscriptionDate and RedemptionDate are required for VaultKind ClosedEnded (temMALFORMED)");
  req(sub + SPEC.MIN_INVESTMENT_PERIOD <= red && red < sub + SPEC.MAX_INVESTMENT_PERIOD, "RedemptionDate - SubscriptionDate must be >= 180 s and < 946708560 s (temMALFORMED)");
  if (now != null) { req(sub > now, "SubscriptionDate must be after the parent ledger close time (tecEXPIRED)"); req(red > now, "RedemptionDate must be after the parent ledger close time (tecEXPIRED)"); }
  return true;
}
// VaultDeposit on a closed-ended vault fails when now > SubscriptionDate (tecEXPIRED, XLS-65 §3.5.2.2 #15).
export function depositGate(v, now) {
  const ph = vaultPhase(v, now);
  if (ph === "Subscription" || ph === "NoPhase") return { ok: true };
  if (ph === "not created yet") return { ok: false, reason: "No vault yet (VaultCreate not done)." };
  return { ok: false, code: "tecEXPIRED", reason: `VaultDeposit only in the subscription window (phase now: ${ph}).` };
}
// LoanSet gates under LendingProtocolV1_1 (XLS-66 §3.8.5.2 #25-27 / XLS-66.1.2).
export const loanMaturitySpan = (t) => t.PaymentInterval * t.PaymentTotal;
export const latestLoanSetTime = (v, t) => v.RedemptionDate - loanMaturitySpan(t) - SPEC.LOAN_REDEMPTION_BUFFER;
export function loanSetWindowGate(v, t, now) {
  if (!v || !v.VaultID) return { ok: false, reason: "No vault yet (VaultCreate not done)." };
  if (v.VaultKind !== SPEC.VaultKind.ClosedEnded) return { ok: false, reason: "Under LendingProtocolV1_1 the vault must be ClosedEnded." };
  if (now <= v.SubscriptionDate) return { ok: false, code: "tecTOO_SOON", reason: "LoanSet only in the investment window: still in Subscription." };
  if (now >= v.RedemptionDate) return { ok: false, code: "tecEXPIRED", reason: "LoanSet only in the investment window: Redemption has started." };
  if (now + loanMaturitySpan(t) + SPEC.LOAN_REDEMPTION_BUFFER > v.RedemptionDate)
    return { ok: false, code: "tecNO_PERMISSION", reason: "StartDate + PaymentInterval x PaymentTotal + 60 > RedemptionDate: the loan would mature too close to Redemption." };
  return { ok: true };
}
// Planned dates for a vault created at `now` (app plan; fixed and immutable once VaultCreate succeeds).
export function planDates(plan, now) {
  const SubscriptionDate = now + plan.subscriptionDays * DAY, RedemptionDate = SubscriptionDate + plan.investmentDays * DAY;
  checkVaultDates(SubscriptionDate, RedemptionDate, now); return { SubscriptionDate, RedemptionDate };
}
// Plan check: the full loan term must fit inside the investment window with the 60 s buffer (XLS-66.1.2 §3.2.2).
export const planFits = (plan, t) => loanMaturitySpan(t) + SPEC.LOAN_REDEMPTION_BUFFER < plan.investmentDays * DAY;

// ---------- XLS-66 §3.8.5.1: LoanSet data verification ----------
export function validateLoanTerms(t) {
  const e = [];
  if (!(Number(t.PrincipalRequested) > 0)) e.push("PrincipalRequested <= 0 (temINVALID)");
  if (!(Number.isInteger(t.PaymentTotal) && t.PaymentTotal > 0)) e.push("PaymentTotal <= 0 (temINVALID)");
  if (!(Number.isInteger(t.PaymentInterval) && t.PaymentInterval >= SPEC.MIN_PAYMENT_INTERVAL)) e.push("PaymentInterval is less than 60 seconds (temINVALID)");
  if (!(Number.isInteger(t.GracePeriod) && t.GracePeriod >= SPEC.MIN_GRACE_PERIOD && t.GracePeriod <= t.PaymentInterval)) e.push("GracePeriod is less than 60 seconds or greater than the PaymentInterval (temINVALID)");
  if (!(Number.isInteger(t.InterestRate) && t.InterestRate >= 0 && t.InterestRate <= SPEC.MAX_RATE)) e.push("InterestRate exceeds maximum allowed value (temINVALID)");
  return e;
}

// ---------- XLS-66 Appendix A-2: amortization, management fee, InterestDue ----------
export function loanMath(principal, t, managementFeeRate) {
  const r = tenthBps(t.InterestRate) * t.PaymentInterval / SPEC.SECONDS_PER_YEAR;          // (1)
  const n = t.PaymentTotal;
  const periodicPayment = r === 0 ? principal / n : principal * (r * (1 + r) ** n) / ((1 + r) ** n - 1); // (5)-(7)
  const totalValue = periodicPayment * n;                                                       // (30)
  const interestGross = totalValue - principal;                                                 // (31)
  const managementFee = interestGross * tenthBps(managementFeeRate);                            // (32)
  const interestDue = interestGross - managementFee;                                            // (33): interest owed to the Vault
  return { periodicRate: r, periodicPayment, totalValue, interestGross, managementFee, interestDue };
}
// InterestDue per unit of principal (linear in principal).
export const interestFactor = (t, fee) => loanMath(1, t, fee).interestDue;
// Fee rate used for cap math before the broker exists: the lower fee gives the higher InterestDue, so the bound is conservative.
export const capMathFeeRate = (pool) => pool?.ledger?.ManagementFeeRate ?? R.FEE_RATE_DISCOUNT;

// Max principal under AssetsMaximum and DebtMaximum (XLS-66 §3.8.5.2 #6, #13, #14, #19). `s` is the live (or planned) vault/broker state.
// #6  AssetsMaximum != 0 and AssetsTotal >= AssetsMaximum -> tecLIMIT_EXCEEDED
// #13 AssetsAvailable < PrincipalRequested -> tecINSUFFICIENT_FUNDS
// #14 AssetsMaximum != 0 and AssetsTotal + InterestDue > AssetsMaximum -> tecLIMIT_EXCEEDED
// #19 DebtMaximum != 0 and DebtMaximum < DebtTotal + PrincipalRequested + InterestDue -> tecLIMIT_EXCEEDED
export function maxPrincipal(s, t, fee) {
  const k = interestFactor(t, fee), AM = Number(s.AssetsMaximum) || 0, DM = Number(s.DebtMaximum) || 0;
  const AT = Number(s.AssetsTotal) || 0, AA = Number(s.AssetsAvailable) || 0, DT = Number(s.DebtTotal) || 0;
  if (AM && AT >= AM) return { max: 0, k, reason: "AssetsTotal >= AssetsMaximum (vault at capacity): LoanSet fails (tecLIMIT_EXCEEDED)" };
  let max = AA, why = "AssetsAvailable";
  if (AM && k > 0 && (AM - AT) / k < max) { max = (AM - AT) / k; why = "AssetsTotal + InterestDue <= AssetsMaximum"; }
  if (DM && (DM - DT) / (1 + k) < max) { max = (DM - DT) / (1 + k); why = "DebtTotal + PrincipalRequested + InterestDue <= DebtMaximum"; }
  max = Math.max(0, floorCents(max - R.ROUNDING_MARGIN));
  return { max, k, reason: why };
}
// Planning view for a fresh vault with AssetsMaximum = DebtMaximum = cap: lenders fill exactly the principal, then LoanSet.
// The largest principal P satisfies P + InterestDue(P) <= cap, i.e. P <= cap / (1 + k).
export function planUnderCap(cap, t, fee) {
  const k = interestFactor(t, fee);
  const max = Math.max(0, floorCents(cap / (1 + k) - R.ROUNDING_MARGIN));
  const m = loanMath(max, t, fee);
  return { cap, k, maxPrincipal: max, interestDue: m.interestDue, depositTarget: max, debtAtLoanSet: max + m.interestDue,
    fullCapFails: loanSetCapCheck({ AssetsMaximum: cap, DebtMaximum: cap, AssetsTotal: cap, AssetsAvailable: cap, DebtTotal: 0 }, cap, t, fee) };
}
// The cap checks LoanSet runs (returns the first failing check or ok).
export function loanSetCapCheck(s, principal, t, fee) {
  const I = loanMath(principal, t, fee).interestDue, AM = Number(s.AssetsMaximum) || 0, DM = Number(s.DebtMaximum) || 0;
  if (AM && s.AssetsTotal >= AM) return { ok: false, code: "tecLIMIT_EXCEEDED", check: 6, reason: "AssetsTotal >= AssetsMaximum (vault at capacity)" };
  if (s.AssetsAvailable < principal) return { ok: false, code: "tecINSUFFICIENT_FUNDS", check: 13, reason: "AssetsAvailable < PrincipalRequested" };
  if (AM && s.AssetsTotal + I > AM) return { ok: false, code: "tecLIMIT_EXCEEDED", check: 14, reason: "AssetsTotal + InterestDue > AssetsMaximum" };
  if (DM && DM < (Number(s.DebtTotal) || 0) + principal + I) return { ok: false, code: "tecLIMIT_EXCEEDED", check: 19, reason: "DebtMaximum < DebtTotal + PrincipalRequested + InterestDue" };
  return { ok: true, interestDue: I };
}

// ---------- XLS-66 §3.1.11 / §3.8.5.2 #20 / §3.10.5: first-loss capital (cover) ----------
// LoanSet needs CoverAvailable >= (DebtTotal + PrincipalRequested + InterestDue) x CoverRateMinimum.
export const coverRequired = (debtTotal, principal, interestDue, crm) => (debtTotal + principal + interestDue) * tenthBps(crm);
// On LoanManage tfLoanDefault: DefaultCovered = min(DebtTotal x CoverRateMinimum x CoverRateLiquidation, DefaultAmount, CoverAvailable).
export function defaultCover({ DebtTotal, CoverRateMinimum, CoverRateLiquidation, CoverAvailable, DefaultAmount }) {
  const minimumCover = DebtTotal * tenthBps(CoverRateMinimum);
  const covered = Math.min(minimumCover * tenthBps(CoverRateLiquidation), DefaultAmount, CoverAvailable);
  return { minimumCover, defaultCovered: covered, vaultLoss: DefaultAmount - covered };
}

// ---------- XLS-66 §3.10 / §3.11 / §3.9: loan servicing gates (fixCleanup3_4_0 boundaries) ----------
// LoanPay: on time needs Amount >= periodicPayment + LoanServiceFee; late (now > NextPaymentDueDate) needs tfLoanLatePayment.
export function loanPayCheck(loan, amount, late, now) {
  if (!loan || loan.PaymentRemaining === 0) return { ok: false, code: "tecKILLED", reason: "Loan is already fully paid or defaulted." };
  const isLate = now > loan.NextPaymentDueDate;
  if (isLate && !late) return { ok: false, code: "tecEXPIRED", reason: "Payment is late: tfLoanLatePayment is required." };
  const due = Number(loan.PeriodicPayment) + (Number(loan.LoanServiceFee) || 0) + (isLate ? (Number(loan.LatePaymentFee) || 0) : 0);
  if (isLate && (Number(loan.LateInterestRate) || 0) > 0 && amount < due) return { ok: false, code: "tecINSUFFICIENT_PAYMENT", reason: "Below periodic payment + fees (late interest is computed by the ledger on top)." };
  if (amount < due) return { ok: false, code: "tecINSUFFICIENT_PAYMENT", reason: `Below the fixed installment (${due}). Partial repayments are not possible.` };
  return { ok: true, late: isLate };
}
// LoanManage tfLoanImpair: only when now > NextPaymentDueDate (fixCleanup3_4_0, XLS-66 §3.10.4.2 #9).
export function impairGate(loan, now) {
  if (!loan || loan.PaymentRemaining === 0) return { ok: false, code: "tecNO_PERMISSION", reason: "Loan is settled or defaulted." };
  if (loan.Flags & 0x00010000) return { ok: false, code: "tecNO_PERMISSION", reason: "Loan is defaulted." };
  if (loan.Flags & 0x00020000) return { ok: false, code: "tecNO_PERMISSION", reason: "Loan is already impaired." };
  if (now <= loan.NextPaymentDueDate) return { ok: false, code: "tecTOO_SOON", reason: "Impairment only after a payment is overdue." };
  return { ok: true };
}
// LoanManage tfLoanDefault: only when now > NextPaymentDueDate + GracePeriod (fixCleanup3_4_0, §3.10.4.2 #6), by LoanBroker.Owner.
export function defaultGate(loan, now) {
  if (!loan || loan.PaymentRemaining === 0) return { ok: false, code: "tecNO_PERMISSION", reason: "Loan is settled or defaulted." };
  if (loan.Flags & 0x00010000) return { ok: false, code: "tecNO_PERMISSION", reason: "Loan is already defaulted." };
  if (now <= loan.NextPaymentDueDate + loan.GracePeriod) return { ok: false, code: "tecTOO_SOON", reason: "Default only after NextPaymentDueDate + GracePeriod." };
  return { ok: true };
}
// LoanDelete: only when PaymentRemaining == 0 (settled or defaulted), §3.9.3.2 #2.
export const deleteGate = (loan) => (loan && loan.PaymentRemaining === 0 ? { ok: true } : { ok: false, code: "tecHAS_OBLIGATIONS", reason: "Loan still has payments remaining." });

// ---------- XRP escrow beside the loan ----------
// XLS-66 does not take this XRP as collateral and does not sell it. Everything below that is not an Escrow/AMM/DEX rule is an app rule.
export const DROPS = 1_000_000;
// PREIMAGE-SHA-256 condition for a 32-byte preimage (crypto-conditions DER, the only type XRPL supports): A0 25 80 20 <sha256(preimage)> 81 01 20.
export const isCondition = (hex) => typeof hex === "string" && /^A0258020[0-9A-F]{64}810120$/.test(hex);
const sec = (x) => Math.round(x);
// App sizing of the investment window: term + grace + sale window + LoanSet slack (whole days).
export const investmentDaysFor = (t, w = E) => Math.ceil((loanMaturitySpan(t) + t.GracePeriod + w.SALE_WINDOW_SECONDS) / DAY) + w.LOANSET_SLACK_DAYS;
// App LoanSet deadline (stricter than the ledger's RedemptionDate - term - 60 s): the last due date + grace + sale window must end by RedemptionDate.
export const appLoanSetDeadline = (v, t, w = E) => v.RedemptionDate - loanMaturitySpan(t) - t.GracePeriod - w.SALE_WINDOW_SECONDS;
// Escrow times for a pool (ledger-checked fields; the values are app rules):
//  CancelAfter = RedemptionDate + margin. With LoanSet by the app deadline, last due date + grace + sale window <= RedemptionDate < CancelAfter,
//  so the shop cannot EscrowCancel before default handling ends. A shop that repays gets its XRP back only after CancelAfter (EscrowCancel).
//  FinishAfter = SubscriptionDate + PaymentInterval: no loan can have a payment overdue earlier (LoanSet only after SubscriptionDate), so the
//  ledger refuses any EscrowFinish before it. Set only while it is still in the future (no past times in EscrowCreate); omitted for later escrows.
export function escrowTimes(v, t, now, w = E) {
  req(v && Number.isInteger(v.SubscriptionDate) && Number.isInteger(v.RedemptionDate), "needs the vault's SubscriptionDate and RedemptionDate (VaultCreate first)");
  const CancelAfter = v.RedemptionDate + w.CANCEL_AFTER_MARGIN_SECONDS, fa = v.SubscriptionDate + t.PaymentInterval;
  return { CancelAfter, FinishAfter: now != null && fa > now + 60 ? fa : undefined };
}
// Check one Escrow entry read by owner + sequence against what the pool expects.
export function checkEscrow(node, exp) {
  if (!node || node.LedgerEntryType !== "Escrow") return { ok: false, drops: 0, problems: ["not found on the ledger (finished, canceled or never created)"] };
  const p = [], drops = typeof node.Amount === "string" && /^\d+$/.test(node.Amount) ? Number(node.Amount) : 0;
  if (node.Account !== exp.owner) p.push(`owner ${node.Account} is not the shop ${exp.owner}`);
  if (node.Destination !== exp.destination) p.push(`destination ${node.Destination} is not the broker ${exp.destination}`);
  if (String(node.Condition || "").toUpperCase() !== String(exp.condition || "").toUpperCase()) p.push("Condition does not match the broker's published condition");
  if (!(drops > 0)) p.push("Amount is not XRP");
  if (!(Number(node.CancelAfter) >= exp.cancelAfterMin)) p.push(`CancelAfter ${node.CancelAfter ?? "missing"} is before the required ${exp.cancelAfterMin}`);
  return { ok: p.length === 0, drops, problems: p };
}
export function escrowSet(list, exp) {
  const rows = (list || []).map((e) => ({ seq: e.seq, owner: e.owner, ...checkEscrow(e.node, exp) }));
  const good = rows.filter((r) => r.ok);
  return { rows, verified: good.length, drops: good.reduce((t, r) => t + r.drops, 0) };
}

// ---------- Selling XRP: AMM (XLS-30 swap formula) and order book walk ----------
const iouVal = (a) => (a && typeof a === "object" ? Number(a.value) : NaN);
const sameIssue = (a, q) => a && typeof a === "object" && a.currency === q.currency && a.issuer === q.issuer;
// amm_info -> { xrp, quote, fee } (XRP units, quote units, fee fraction). TradingFee is in 1/100,000 (1000 = 1%).
export function ammPool(amm, quote) {
  if (!amm) return null; const a = amm.amount, b = amm.amount2; let xrp, q;
  if (typeof a === "string" && sameIssue(b, quote)) { xrp = Number(a) / DROPS; q = iouVal(b); }
  else if (typeof b === "string" && sameIssue(a, quote)) { xrp = Number(b) / DROPS; q = iouVal(a); }
  else return null;
  return xrp > 0 && q > 0 ? { xrp, quote: q, fee: (Number(amm.trading_fee) || 0) / 100000 } : null;
}
// XLS-30 formula (9), equal weights: out = Γquote × [1 − Γxrp / (Γxrp + in × (1 − TFee))].
export const ammOut = (pool, xrpIn) => (pool && xrpIn > 0 ? pool.quote * (1 - pool.xrp / (pool.xrp + xrpIn * (1 - pool.fee))) : 0);
// book_offers with taker_gets = quote and taker_pays = XRP: standing offers that give the quote for XRP. Funded amounts win when present.
export function bookLevels(offers) {
  return (offers || []).map((o) => { const xrp = Number(o.taker_pays_funded ?? o.TakerPays) / DROPS, q = iouVal(o.taker_gets_funded ?? o.TakerGets); return { xrp, quote: q, price: q / xrp }; })
    .filter((l) => l.xrp > 0 && l.quote > 0 && Number.isFinite(l.price)).sort((a, b) => b.price - a.price);
}
function bookTake(levels, amt, commit) { let left = amt, out = 0;
  for (const l of levels) { if (left <= 1e-12) break; if (l.xrp <= 1e-12) continue; const t = Math.min(left, l.xrp); out += t * l.price; left -= t; if (commit) l.xrp -= t; }
  return { out, filled: amt - Math.max(0, left) }; }
export const bookOut = (levels, xrpIn) => bookTake(levels.map((l) => ({ ...l })), xrpIn, false);
// Combined walk: each chunk goes to whichever venue pays more for it at that point. The AMM leg composes exactly to formula (9)
// (the fee is not counted back into the pool, which is the conservative side).
export function combinedOut(pool, levels, xrpIn, chunks = E.QUOTE_CHUNKS) {
  const step = xrpIn / chunks, lv = levels.map((l) => ({ ...l })); let p = pool ? { ...pool } : null, out = 0, viaAmm = 0, viaBook = 0;
  for (let k = 0; k < chunks; k++) {
    const a = p ? ammOut(p, step) : 0, b = bookTake(lv, step, false);
    if (b.filled >= step - 1e-12 && b.out >= a) { bookTake(lv, step, true); out += b.out; viaBook += step; }
    else if (p && a > 0) { p = { ...p, xrp: p.xrp + step * (1 - p.fee), quote: p.quote - a }; out += a; viaAmm += step; }
    else if (b.out > 0) { bookTake(lv, step, true); out += b.out; viaBook += b.filled; }
  }
  return { out, viaAmm, viaBook };
}
// What `xrp` would fetch now. Takes the best of AMM only, book only and the combined walk (the payment engine itself mixes AMM and book).
export function sellQuote({ pool, levels = [], xrp }) {
  const noMarket = !pool && !levels.length;
  if (noMarket || !(xrp > 0)) return { xrp, amm: 0, book: 0, bookFilled: 0, combined: 0, best: 0, source: noMarket ? "no market" : "nothing to sell", noMarket };
  const amm = ammOut(pool, xrp), bk = bookOut(levels, xrp), comb = combinedOut(pool, levels, xrp);
  const best = [["AMM only", amm], ["order book only", bk.out], ["AMM + order book", comb.out]].reduce((x, y) => (y[1] > x[1] + 1e-9 ? y : x));
  return { xrp, amm, book: bk.out, bookFilled: bk.filled, combined: comb.out, viaAmm: comb.viaAmm, viaBook: comb.viaBook, best: best[1], source: best[0], noMarket };
}
// RLUSD still owed after cover: DefaultAmount − DefaultCovered, with the ledger's own default formula (XLS-66 §3.10.5), i.e. the cover the
// ledger would actually move, not the whole CoverAvailable.
export function owedAfterCover({ TotalValueOutstanding, ManagementFeeOutstanding, DebtTotal, CoverAvailable, CoverRateMinimum, CoverRateLiquidation }) {
  const DefaultAmount = Number(TotalValueOutstanding) - (Number(ManagementFeeOutstanding) || 0);
  const d = defaultCover({ DebtTotal: Number(DebtTotal), CoverRateMinimum, CoverRateLiquidation, CoverAvailable: Number(CoverAvailable) || 0, DefaultAmount });
  return { DefaultAmount, coverPayable: d.defaultCovered, net: Math.max(0, DefaultAmount - d.defaultCovered) };
}
// Planned figures before LoanSet (no Loan yet): principal + InterestDue, cover = the LoanSet minimum.
export function plannedOwed(pool) {
  const fee = capMathFeeRate(pool), pl = planUnderCap(pool.capRlusd, pool.terms, fee), m = loanMath(pl.maxPrincipal, pool.terms, fee);
  const cover = coverRequired(0, pl.maxPrincipal, pl.interestDue, R.COVER_RATE_MINIMUM);
  return owedAfterCover({ TotalValueOutstanding: pl.maxPrincipal + m.interestGross, ManagementFeeOutstanding: m.managementFee, DebtTotal: pl.debtAtLoanSet,
    CoverAvailable: cover, CoverRateMinimum: R.COVER_RATE_MINIMUM, CoverRateLiquidation: R.COVER_RATE_LIQUIDATION });
}
export const escrowRatioPct = (quoteOut, net) => (net > 0 ? (quoteOut / net) * 100 : Infinity);
// Smallest XRP amount whose sell-side quote reaches `pct` of `net` (null if this market cannot reach it).
export function xrpForRatio(market, net, pct = E.ADD_LINE_PCT) {
  const target = (net * pct) / 100; if (!(target > 0)) return 0;
  let hi = 1; const q = (x) => sellQuote({ ...market, xrp: x }).best;
  while (q(hi) < target) { hi *= 2; if (hi > 1e11) return null; }
  let lo = 0; for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (q(mid) >= target) hi = mid; else lo = mid; }
  return Math.ceil(hi * DROPS) / DROPS;
}
// Add/default lines and the add window (app rules). belowAddSince: first time the ratio was seen under the add line (null if not).
export const nextBelowSince = (ratio, prev, now, add = E.ADD_LINE_PCT) => (ratio >= add ? null : prev ?? now);
export function marginState({ ratio, belowAddSince, now, windowSec = E.ADD_WINDOW_SECONDS, add = E.ADD_LINE_PCT, def = E.DEFAULT_LINE_PCT }) {
  if (ratio == null || Number.isNaN(ratio)) return { state: "no-ratio", label: "no live ratio (no market or no escrow)" };
  if (ratio >= add) return { state: "ok", label: `at or above the ${add}% add line` };
  const since = belowAddSince ?? now, endsAt = since + windowSec;
  if (now < endsAt) return { state: "add-window", since, endsAt, label: `under the ${add}% add line: the shop can add a second escrow or LoanPay the balance down until the window ends` };
  if (ratio < def) return { state: "bot-armed", since, endsAt, label: `window over and under the ${def}% default line: the bot runs, starting with LoanManage` };
  return { state: "below-add", since, endsAt, label: `window over, between the ${def}% and ${add}% lines: no bot; it runs if the ratio falls under ${def}%` };
}
// When the bot may start each step (app rules on top of the ledger gates):
//  mark (LoanManage tfLoanImpair): the ledger allows it only once a payment is overdue (now > NextPaymentDueDate). A price breach alone
//    cannot be marked while payments are current, so an armed bot waits for the next overdue payment.
//  sale (steps 2-4): once marked AND (the grace period ran out unpaid OR the bot is armed by the ratio).
export function botPlan({ loan, margin, now }) {
  if (!loan) return { mark: false, sell: false, why: "no Loan on the ledger" };
  const f = Number(loan.Flags) || 0, overdue = loan.PaymentRemaining > 0 && now > loan.NextPaymentDueDate;
  if (f & FLAGS.lsfLoanDefault) return { mark: false, sell: true, defaulted: true, why: "loan already defaulted: steps 2-4 can still run for the record, LoanPay is closed (tecKILLED)" };
  if (loan.PaymentRemaining === 0) return { mark: false, sell: false, why: "loan settled" };
  const impaired = !!(f & FLAGS.lsfLoanImpaired), armed = margin?.state === "bot-armed", graceOver = now > loan.NextPaymentDueDate + loan.GracePeriod;
  return { mark: overdue && !impaired, impaired, overdue, armed, graceOver, sell: (impaired || overdue) && (graceOver || armed),
    why: !overdue ? (armed ? "armed by the ratio; waiting for an overdue payment (LoanManage impair needs now > NextPaymentDueDate)" : "payments current") : (graceOver || armed ? "overdue and past grace (or armed): mark, finish, sell, LoanPay" : "overdue: mark now; sale waits for the grace period") };
}
// Four sale steps, derived only from ledger reads (no keys). Inputs:
//  loan: Loan entry (null if deleted); marked: {hash}|null (LoanManage tfLoanImpair/default seen); escrows: [{seq, drops, state: present|finished|canceled}]
//  sales: [{hash, xrpDrops, quote}] broker sells after the finish; pays: [{hash, quote}] LoanPay on this LoanID after the mark;
//  defaulted: {hash, vaultLoss, defaultCovered}|null; saleEnds: end of the sale window (Ripple time) or null; nextDue: amount LoanPay needs now.
export function saleSteps({ loan = null, marked = null, escrows = [], sales = [], pays = [], defaulted = null, now, saleEnds = null, overdue = false, nextDue = null }) {
  const late = saleEnds != null && now > saleEnds, S = (status, detail, txs = []) => ({ status, detail, txs });
  const fin = escrows.filter((e) => e.state === "finished"), canc = escrows.filter((e) => e.state === "canceled"), pres = escrows.filter((e) => e.state === "present");
  const finDrops = fin.reduce((t, e) => t + e.drops, 0), soldDrops = sales.reduce((t, x) => t + x.xrpDrops, 0), proceeds = sales.reduce((t, x) => t + x.quote, 0), paid = pays.reduce((t, x) => t + x.quote, 0);
  const s1 = marked ? S("done", "LoanManage marked the loan", [marked.hash]) : overdue ? S("stuck", "a payment is overdue and LoanManage tfLoanImpair has not been sent") : S("not started", "no payment overdue; nothing to mark");
  let s2;
  if (!marked) s2 = S("not started", "waits for step 1");
  else if (!escrows.length) s2 = S("stuck", "no XRP escrow on record for this shop");
  else if (canc.length) s2 = S("stuck", `${canc.length} escrow(s) canceled after CancelAfter: that XRP went back to the shop`);
  else if (!pres.length) s2 = S("done", `${fin.length} escrow(s) finished, ${finDrops / DROPS} XRP to the broker`, fin.map((e) => e.finishHash).filter(Boolean));
  else s2 = S(late ? "stuck" : "waiting", `${pres.length} of ${escrows.length} escrow(s) still open${late ? " after the sale window" : ""}`);
  let s3;
  if (!fin.length) s3 = S("not started", "waits for step 2");
  else if (soldDrops >= finDrops * 0.999) s3 = S("done", `${soldDrops / DROPS} XRP sold for ${+proceeds.toFixed(6)}`, sales.map((x) => x.hash));
  else s3 = S(late ? "stuck" : "waiting", soldDrops ? `${soldDrops / DROPS} of ${finDrops / DROPS} XRP sold (thin book or price limit)` : "XRP not sold yet", sales.map((x) => x.hash));
  let s4;
  const settled = loan && loan.PaymentRemaining === 0 && !(Number(loan.Flags) & FLAGS.lsfLoanDefault);
  if (!sales.length) s4 = S("not started", "waits for step 3");
  else if (settled) s4 = S("done", `LoanPay ${+paid.toFixed(6)} settled the loan`, pays.map((x) => x.hash));
  else if (paid > 0) s4 = S(defaulted ? "done" : "waiting", `LoanPay ${+paid.toFixed(6)} after the mark${defaulted ? "; the rest was defaulted" : "; LoanManage default of the rest when the ledger allows it"}`, pays.map((x) => x.hash));
  else if (defaulted) s4 = S("stuck", "loan defaulted with no LoanPay from the proceeds", [defaulted.hash]);
  else if (nextDue != null && proceeds < nextDue) s4 = S("stuck", `proceeds ${+proceeds.toFixed(6)} are below one installment (${+nextDue.toFixed(6)}); LoanPay takes no partial payment`);
  else s4 = S(late ? "stuck" : "waiting", "waiting for the shop's signed LoanPay (XLS-66 accepts LoanPay only from Loan.Borrower)");
  return { steps: [["Mark the loan (LoanManage)", s1], ["Finish every escrow (EscrowFinish + fulfillment)", s2], ["Sell the XRP (OfferCreate on the DEX/AMM)", s3], ["LoanPay up to what is owed", s4]].map(([name, st], i) => ({ n: i + 1, name, ...st })),
    proceeds, paid, undelivered: Math.max(0, proceeds - paid), shortfall: defaulted ? defaulted.vaultLoss : null };
}
// LoanSet gate for the escrow path (app rule: the ledger's LoanSet knows nothing of the escrow). Cover-only path: small cap + desk file.
export function loanSetEscrowGate(pool, ev = {}) {
  const r = [];
  if (pool.path === PATHS.cover) {
    if (pool.capRlusd > NO_XRP.MAX_CAP_RLUSD) r.push(`Cover-only path: cap must be at most ${NO_XRP.MAX_CAP_RLUSD.toLocaleString("en-US")} RLUSD.`);
    if (!pool.deskFile) r.push("Cover-only path: the desk file (off-ledger) is not on record.");
    return { ok: r.length === 0, reasons: r };
  }
  if (!isCondition(pool.escrow?.condition)) r.push("The broker has not published the escrow Condition yet.");
  if (!ev.escrows || ev.escrows.verified === 0) r.push("LoanSet stays blocked until the shop's XRP escrow to the broker is found on the ledger by owner + sequence, with the right destination, Condition, XRP amount and CancelAfter.");
  else if (ev.noMarket) r.push("No market to value the escrowed XRP, so the opening ratio cannot be checked.");
  else if (!(ev.ratio >= E.ADD_LINE_PCT)) r.push(`Opening ratio ${Number.isFinite(ev.ratio) ? ev.ratio.toFixed(1) + "%" : "unknown"} is under the ${E.ADD_LINE_PCT}% add line (app rule): add a second escrow before LoanSet.`);
  if (ev.vault && ev.now != null && ev.now > appLoanSetDeadline(ev.vault, pool.terms, ev.windows || E)) r.push("Past the app LoanSet deadline (RedemptionDate − term − grace − sale window): default handling would not fit before RedemptionDate.");
  return { ok: r.length === 0, reasons: r };
}

// ---------- Network / amendment gate ----------
// Deposits and LoanSet stay disabled until ALL THREE required amendments are enabled on that network. Mainnet is hard-off.
export function networkGate(net, features, asset) {
  const n = NETWORKS[net]; const reasons = [];
  if (!n) return { ok: false, reasons: ["Unknown network."] };
  if (!n.vaultLending) reasons.push(n.offReason);
  if (!features) reasons.push(`${n.label}: amendment status not checked yet.`);
  else for (const a of AMENDMENTS.required) if (features[a] !== true) reasons.push(`${n.label}: ${a} is not enabled.`);
  const iss = (asset || n.asset).issuer;
  if (!iss) reasons.push(net === "devnet" ? "Devnet: no test-issuer set. RLUSD does not exist on devnet; set VITE_DEVNET_TEST_ISSUER to a self-issued test IOU issuer." : `${n.label}: no asset issuer set.`);
  return { ok: reasons.length === 0, reasons };
}

// ---------- QAK app rules ----------
// Fee cut: ManagementFeeRate is fixed at LoanBrokerSet, so the QAK balance check happens once, at broker creation.
export const feeRateAtBrokerCreation = (ledgerQak) => ((Number(ledgerQak) || 0) >= R.DISCOUNT_MIN_HOLDING_QAK ? R.FEE_RATE_DISCOUNT : R.FEE_RATE);
export const feePct = (rate) => (rate / 1000).toFixed(2); // 1000 (1/10 bps) = 1.00%

// ---------- Off-ledger app state ----------
export const STAGES = ["applied", "listed"]; // off-ledger stages; after "listed" the ledger objects define the state
export const PREVIEW_ACCOUNT = "rPREVIEWxxxxxxxxxxxxxxxxxxxxxxxxx";
export const isAccount = (who) => typeof who === "string" && (who === PREVIEW_ACCOUNT || /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(who));
const reqAccount = (who) => req(isAccount(who), "connect a Xaman account first");
const isQak = (x) => Number.isInteger(x) && x > 0 && x <= R.TOTAL_SUPPLY_QAK;
const isId = (x) => x === null || (typeof x === "string" && /^[0-9A-F]{64}$/.test(x));
const isTime = (x) => x === null || (Number.isInteger(x) && x > 0);
const newId = () => "p_" + (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const cleanName = (v, label) => { const t = String(v ?? "").trim(); req(t.length > 0, `${label} required`); req(t.length <= L.NAME_MAX, `${label}: max ${L.NAME_MAX} characters`); return t; };
const num = (v, label) => { req(v !== undefined && v !== null && String(v).trim() !== "", `${label} required`); const x = Number(v); req(Number.isFinite(x), `${label} must be a number`); return x; };
const blankLedger = () => ({ VaultID: null, LoanBrokerID: null, LoanID: null, ShareMPTID: null, SubscriptionDate: null, RedemptionDate: null, ManagementFeeRate: null });
const base = () => ({ votes: { yes: 0, no: 0 }, capVotes: {}, voters: [], log: [], ledger: blankLedger(), escrow: { condition: null, records: [] } });

export function seed() {
  const f = FIRST_POOL;
  return { pools: [{ ...base(), id: f.id, shop: f.shop, city: f.city, purpose: f.purpose, sample: true, network: f.network, stage: f.stage,
    capRlusd: f.capRlusd, terms: { ...f.terms }, plan: { ...f.plan }, path: f.path, deskFile: null, account: null,
    listingLock: { who: null, qak: R.LISTING_LOCK_QAK }, shopHoldingQak: null, holdingVerified: false }], queue: [] };
}

// Application (off-ledger). The cap becomes AssetsMaximum and DebtMaximum; the terms become LoanSet fields.
export function apply(s, f) {
  reqAccount(f.account); const shop = cleanName(f.shop, "shop name"), city = cleanName(f.city, "city");
  req(["stock", "fit-out"].includes(f.purpose), "purpose must be stock or fit-out");
  const cap = num(f.capRlusd, "cap"); req(Number.isInteger(cap) && cap >= 1 && cap <= R.MAX_CAP_RLUSD, `cap must be a whole number 1..${R.MAX_CAP_RLUSD.toLocaleString("en-US")} RLUSD`);
  const rate = num(f.ratePct, "interest rate"); req(rate >= L.RATE_MIN_PCT && rate <= L.RATE_MAX_PCT, `interest rate must be ${L.RATE_MIN_PCT}..${L.RATE_MAX_PCT}% APR`);
  const pt = num(f.paymentTotal, "number of payments"); req(Number.isInteger(pt) && pt >= L.PAYMENTS_MIN && pt <= L.PAYMENTS_MAX, `number of payments must be a whole number ${L.PAYMENTS_MIN}..${L.PAYMENTS_MAX}`);
  const iv = num(f.intervalDays, "payment interval"); req(Number.isInteger(iv) && iv >= L.INTERVAL_MIN_DAYS && iv <= L.INTERVAL_MAX_DAYS, `payment interval must be a whole number of days ${L.INTERVAL_MIN_DAYS}..${L.INTERVAL_MAX_DAYS}`);
  req(pt * iv <= L.TERM_MAX_DAYS, `term (payments x interval) must be at most ${L.TERM_MAX_DAYS} days`);
  const gr = num(f.graceDays, "grace period"); req(Number.isInteger(gr) && gr >= 1, "grace period must be a whole number of days, at least 1");
  req(gr <= iv, "grace period must not exceed the payment interval (GracePeriod <= PaymentInterval)");
  const path = f.path || PATHS.escrow; req(Object.values(PATHS).includes(path), "path must be xrp-escrow or cover-only");
  let deskFile = null;
  if (path === PATHS.cover) { req(cap <= NO_XRP.MAX_CAP_RLUSD, `a shop with no XRP lists on the cover-only path with a cap of at most ${NO_XRP.MAX_CAP_RLUSD.toLocaleString("en-US")} RLUSD`);
    deskFile = String(f.deskFile ?? "").trim(); req(deskFile.length > 0, "cover-only path: describe the file the desk keeps on the shop (off-ledger)"); req(deskFile.length <= 120, "desk file note: max 120 characters"); }
  const lock = num(f.listingLock, "listing lock"); req(isQak(lock), `QAK amounts must be whole numbers 1..${R.TOTAL_SUPPLY_QAK.toLocaleString("en-US")}`);
  req(lock === R.LISTING_LOCK_QAK, `listing lock must be ${R.LISTING_LOCK_QAK.toLocaleString("en-US")} QAK`);
  const held = Number(f.ledgerQak) || 0; req(held >= 0 && held <= R.TOTAL_SUPPLY_QAK, "bad ledger balance");
  req(lock <= held, `listing lock (${lock.toLocaleString("en-US")} QAK) must be covered by your QAK balance (ledger): ${held.toLocaleString("en-US")} QAK`);
  const terms = { InterestRate: Math.round(rate * 1000), PaymentTotal: pt, PaymentInterval: iv * DAY, GracePeriod: gr * DAY };
  const errs = validateLoanTerms({ ...terms, PrincipalRequested: cap }); req(errs.length === 0, errs.join("; "));
  const plan = { subscriptionDays: FIRST_POOL.plan.subscriptionDays, investmentDays: investmentDaysFor(terms) }; // app rule: term + grace + sale window + LoanSet slack
  req(planFits(plan, terms), "loan term does not fit the investment window");
  const p = { ...base(), id: newId(), shop, city, purpose: f.purpose, sample: false, network: "devnet", stage: "applied", capRlusd: cap, terms, plan, path, deskFile,
    account: f.account, listingLock: { who: f.account, qak: lock }, shopHoldingQak: held, holdingVerified: f.ledgerVerified === true, log: ["applied by " + f.account] };
  s.pools.push(p); return p;
}

// Votes: one QAK = one vote, on the listing and the cap only (app rule, off-ledger).
const pool = (s, id) => { const p = s.pools.find((x) => x.id === id); req(p, "no pool"); return p; };
export function vote(s, id, yes, qak, who) {
  reqAccount(who); const p = pool(s, id); req(p.stage === "applied", "voting only while applied"); qak = Number(qak); req(isQak(qak), "QAK weight must be a whole number 1..1,000,000,000");
  p.votes[yes ? "yes" : "no"] += qak; p.voters.push({ who, yes: !!yes, qak });
  if (p.votes.yes >= R.LIST_VOTE_THRESHOLD_QAK && p.votes.yes > p.votes.no) {
    const best = Object.entries(p.capVotes).sort((a, b) => b[1] - a[1])[0]; if (best && best[1] > p.votes.yes) p.capRlusd = Number(best[0]);
    p.stage = "listed"; p.log.push(`listed by QAK vote; cap ${p.capRlusd} RLUSD`); }
  return p;
}
export function voteCap(s, id, cap, qak, who) {
  reqAccount(who); qak = Number(qak); req(isQak(qak), "QAK weight must be a whole number 1..1,000,000,000"); const p = pool(s, id); req(p.stage === "applied", "cap votes only while applied");
  const maxCap = p.path === PATHS.cover ? NO_XRP.MAX_CAP_RLUSD : R.MAX_CAP_RLUSD;
  cap = Number(cap); req(Number.isInteger(cap) && cap > 0 && cap <= maxCap, `cap vote must be 1..${maxCap}`); p.capVotes[cap] = (p.capVotes[cap] || 0) + qak; return p;
}
// Queue: locked QAK orders the Duck Bank deposit queue (app rule). The vault itself is public: the ledger accepts any VaultDeposit during Subscription.
export function enqueue(s, who, id, amt, qakLocked) {
  reqAccount(who); pool(s, id); amt = Number(amt); req(amt > 0, "bad amount");
  s.queue.push({ who, id, amt, qakLocked: Number(qakLocked) || 0 }); s.queue.sort((a, b) => b.qakLocked - a.qakLocked); return s.queue;
}
// Record ledger ids after a validated transaction. One shop per vault: a pool's VaultID, LoanBrokerID and LoanID are set once.
export function recordLedger(s, id, field, value) {
  const p = pool(s, id); req(["VaultID", "LoanBrokerID", "LoanID", "ShareMPTID", "SubscriptionDate", "RedemptionDate", "ManagementFeeRate"].includes(field), "bad field");
  req(p.ledger[field] == null, `${field} already set for this shop`);
  if (field === "VaultID") req(!s.pools.some((q) => q.ledger.VaultID === value), "this vault already belongs to another shop");
  p.ledger[field] = value; p.log.push(`${field} = ${value}`); return p;
}

// Off-ledger escrow records next to the ledger ids: the broker's published Condition (never the fulfillment) and escrow owner + sequence.
export function recordCondition(s, id, hex) {
  const p = pool(s, id); req(p.path === PATHS.escrow, "cover-only pools have no XRP escrow"); hex = String(hex || "").trim().toUpperCase();
  req(isCondition(hex), "Condition must be a PREIMAGE-SHA-256 condition for a 32-byte preimage (A0258020…810120)");
  req(!p.escrow.condition, "Condition already published for this shop"); p.escrow.condition = hex; p.log.push("escrow Condition published by the broker"); return p;
}
export function recordEscrow(s, id, { owner, seq, hash = null }) {
  const p = pool(s, id); req(p.path === PATHS.escrow, "cover-only pools have no XRP escrow"); req(isAccount(owner) && owner !== PREVIEW_ACCOUNT, "escrow owner must be an XRPL account");
  seq = Number(seq); req(Number.isInteger(seq) && seq > 0, "escrow sequence must be a positive whole number"); req(hash === null || isId(hash), "bad tx hash");
  req(!p.escrow.records.some((r) => r.owner === owner && r.seq === seq), "escrow already on record"); req(p.escrow.records.length < 20, "at most 20 escrows per shop");
  p.escrow.records.push({ owner, seq, hash }); p.log.push(`escrow on record: ${owner} sequence ${seq}`); return p;
}

// Load-time validation of stored state (localStorage is untrusted). Bad pools are dropped.
const okStr = (x, max) => typeof x === "string" && x.length <= max;
const okNum = (x) => typeof x === "number" && Number.isFinite(x);
function okPool(p) {
  return p && typeof p === "object" && okStr(p.id, 64) && /^[A-Za-z0-9_-]+$/.test(p.id) && okStr(p.shop, L.NAME_MAX) && p.shop.trim() && okStr(p.city, L.NAME_MAX) && p.city.trim()
    && ["stock", "fit-out"].includes(p.purpose) && STAGES.includes(p.stage) && Object.hasOwn(NETWORKS, p.network)
    && okNum(p.capRlusd) && p.capRlusd > 0 && p.capRlusd <= R.MAX_CAP_RLUSD
    && p.terms && validateLoanTerms({ ...p.terms, PrincipalRequested: 1 }).length === 0 && p.terms.InterestRate <= L.RATE_MAX_PCT * 1000
    && p.plan && Number.isInteger(p.plan.subscriptionDays) && p.plan.subscriptionDays > 0 && Number.isInteger(p.plan.investmentDays) && planFits(p.plan, p.terms)
    && p.ledger && ["VaultID", "LoanBrokerID", "LoanID"].every((k) => isId(p.ledger[k])) && (p.ledger.ShareMPTID === null || (typeof p.ledger.ShareMPTID === "string" && /^[0-9A-F]{48}$/.test(p.ledger.ShareMPTID)))
    && isTime(p.ledger.SubscriptionDate) && isTime(p.ledger.RedemptionDate) && [null, R.FEE_RATE, R.FEE_RATE_DISCOUNT].includes(p.ledger.ManagementFeeRate)
    && Array.isArray(p.log) && p.log.every((l) => okStr(l, L.LOG_MAX)) && p.listingLock && okNum(p.listingLock.qak) && p.votes && okNum(p.votes.yes) && okNum(p.votes.no)
    && p.capVotes && typeof p.capVotes === "object" && (p.account === null || p.account === undefined || isAccount(p.account))
    && (p.shopHoldingQak === null || p.shopHoldingQak === undefined || okNum(p.shopHoldingQak))
    && Object.values(PATHS).includes(p.path) && (p.path !== PATHS.cover || (p.capRlusd <= NO_XRP.MAX_CAP_RLUSD && okStr(p.deskFile, 120) && p.deskFile.trim()))
    && p.escrow && (p.escrow.condition === null || isCondition(p.escrow.condition)) && Array.isArray(p.escrow.records) && p.escrow.records.length <= 20
    && p.escrow.records.every((r) => r && isAccount(r.owner) && Number.isInteger(r.seq) && r.seq > 0 && (r.hash === null || isId(r.hash)));
}
export function sanitizeState(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.pools)) return null;
  const pools = raw.pools.filter(okPool).map((p) => ({ ...p, holdingVerified: false, voters: Array.isArray(p.voters) ? p.voters.filter((v) => v && okStr(v.who, 64)) : [] }));
  const ids = new Set(), vaults = new Set();
  const uniq = pools.filter((p) => { if (ids.has(p.id)) return false; if (p.ledger.VaultID && vaults.has(p.ledger.VaultID)) return false; ids.add(p.id); if (p.ledger.VaultID) vaults.add(p.ledger.VaultID); return true; });
  const queue = Array.isArray(raw.queue) ? raw.queue.filter((q) => q && okStr(q.who, 64) && okStr(q.id, 64) && okNum(q.amt) && okNum(q.qakLocked)) : [];
  return { pools: uniq, queue };
}
