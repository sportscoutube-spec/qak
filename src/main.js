import { PRODUCT, RULES, LIMITS, SPEC, FLAGS, AMENDMENTS, NETWORKS, GATED_TXS, TOKENOMICS, TEAM, ROADMAP, QAK_ISSUER, QAK_CURRENCY, QAK_EXPLORER, ASSET } from "./config.js";
import * as L from "./ledger.js";
import * as S from "./state.js";
import * as P from "./payloads.js";
import * as X from "./xaman.js";
const esc = (v) => String(v ?? "").replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" }[c]));
const n = (x) => Number(x).toLocaleString("en-US");
const m2 = (x) => Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctOf = (tenthBps) => (tenthBps / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 }) + "%";
const days = (s) => n(s / 86400) + (s === 86400 ? " day" : " days");
const athens = (d) => d ? new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Athens", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" }).format(d) : "none";
const KEY = "duckbank-v4";
const load = () => { try { return S.sanitizeState(JSON.parse(localStorage.getItem(KEY) || "null")); } catch { return null; } };
let st = load() || S.seed();
if (!st.pools.some((p) => p.id === "first")) st.pools.unshift(S.seed().pools[0]);
const save = () => localStorage.setItem(KEY, JSON.stringify(st));
const $ = (h) => (document.getElementById("app").innerHTML = h);
const NC = `<span class="muted">not created yet</span>`;
const sample = (p) => (p.sample ? ` <span class="tag sample">Sample shop</span>` : "");
const stageTag = (s) => `<span class="tag s-${esc(s)}">${esc(s)}</span>`;

// ---------- live reads ----------
// Re-render only pages that show the data, so a form being typed into is never reset.
const curPage = () => location.hash.replace(/^#\/?/, "").split("/")[0];
const soft = (pgs) => { if (pgs.includes(curPage())) route(); };
const LG = { issuer: null, issuerErr: null, issuerLoading: false, issuerAt: 0, bal: null, balErr: null, balLoading: false, pool: {} };
const FEAT = Object.fromEntries(Object.keys(NETWORKS).map((k) => [k, { data: null, err: null, at: null, loading: false }]));
const FEAT_PAGES = ["", "pool", "lend", "status"];
function checkFeatures(net) { const f = FEAT[net]; if (f.loading) return; f.loading = true; f.err = null; soft(["status"]);
  L.featureStatus(net).then((d) => { f.data = d; f.at = new Date(); }).catch((e) => { f.err = e.message || "unavailable"; f.at = new Date(); }).finally(() => { f.loading = false; soft(FEAT_PAGES); }); }
const checkAll = () => Object.keys(NETWORKS).forEach(checkFeatures);
function loadIssuer(force) { if (LG.issuerLoading || (!force && (LG.issuer || LG.issuerErr) && Date.now() - LG.issuerAt < 60000)) return; LG.issuerLoading = true; LG.issuerErr = null;
  L.issuerStatus().then((x) => { LG.issuer = x; LG.issuerAt = Date.now(); }).catch((e) => { LG.issuerErr = e.message || "unavailable"; LG.issuerAt = Date.now(); }).finally(() => { LG.issuerLoading = false; soft(["qak", "status"]); }); }
function loadBalance() { const w = X.wallet; if (w.mode !== "xaman" || !w.account) { LG.bal = null; LG.balErr = null; return; }
  if (LG.balLoading || (LG.bal && LG.bal.account === w.account)) return; LG.balLoading = true; LG.balErr = null;
  L.qakBalance(w.account).then((b) => { LG.bal = b; }).catch((e) => { LG.bal = null; LG.balErr = e.message || "unavailable"; }).finally(() => { LG.balLoading = false; const el = document.getElementById("ledgerqak"); if (el) el.value = balText(); soft(["lend", "pool"]); }); }
// Vault / LoanBroker / Loan entries for a pool, read from its network by id. Nothing is shown unless it came from the ledger.
function loadPool(p) { const c = (LG.pool[p.id] ||= { loading: false, at: 0 }); const ids = p.ledger; if (!ids.VaultID || c.loading || Date.now() - c.at < 30000) return;
  c.loading = true; c.err = null;
  Promise.all([L.ledgerEntry(p.network, ids.VaultID), ids.LoanBrokerID ? L.ledgerEntry(p.network, ids.LoanBrokerID) : null, ids.LoanID ? L.ledgerEntry(p.network, ids.LoanID) : null])
    .then(([v, b, l]) => { c.vault = v; c.broker = b; c.loan = l; }).catch((e) => { c.err = e.message || "unavailable"; }).finally(() => { c.loading = false; c.at = Date.now(); soft(["pool"]); }); }
const ledgerQak = () => (X.wallet.mode === "xaman" && LG.bal && LG.bal.account === X.wallet.account ? LG.bal.balance : 0);
const ledgerVerified = () => X.wallet.mode === "xaman" && !!LG.bal && LG.bal.account === X.wallet.account;
const balText = () => { const w = X.wallet; if (!w.account) return "0 QAK (not connected)"; if (w.mode !== "xaman") return "0 QAK (mock wallet has no ledger balance)";
  if (LG.balErr) return "0 QAK (ledger read unavailable: " + LG.balErr + ")"; if (!LG.bal) return "reading ledger…";
  return LG.bal.hasLine ? `${n(LG.bal.balance)} QAK${LG.bal.authorized ? "" : " (trust line not yet authorized by issuer)"}` : "0 QAK (no QAK trust line)"; };

// ---------- shared copy ----------
const qakLink = `<a href="${esc(QAK_EXPLORER)}" target="_blank" rel="noopener noreferrer">${esc(QAK_ISSUER)}</a>`;
const qakRow = `<tr><td>QAK token</td><td>currency code ${esc(QAK_CURRENCY)}, issuer ${qakLink}</td></tr>`;
const lineNote = `<p class="note">To hold QAK, an account sets a trust line to issuer ${qakLink} for currency code ${esc(QAK_CURRENCY)}. This app never sends a TrustSet.</p>`;
const risks = `<ul class="risks">
 <li><b>Clawback.</b> The RLUSD issuer has clawback enabled. It can claw back RLUSD from a vault (VaultClawback works in every phase) and broker cover above the minimum (LoanBrokerCoverClawback).</li>
 <li><b>No on-chain collateral.</b> Loans are unsecured on the ledger. The XLS-66 security section says the protocol "does not offer on-chain algorithmic protection against default".</li>
 <li><b>No liquidation.</b> On default the ledger moves at most min(DebtTotal × CoverRateMinimum × CoverRateLiquidation, DefaultAmount, CoverAvailable) from cover into the vault. The rest is written down on that vault, so a miss stays in that shop.</li>
 <li><b>Lock-up.</b> Withdrawals are blocked from SubscriptionDate to RedemptionDate. Redemption opens on RedemptionDate even if a loan is late.</li>
 <li><b>Interest booked early.</b> At LoanSet the vault's AssetsTotal rises by the expected interest, before any interest is paid.</li>
 <li>The code is not audited.</li></ul>`;
const pseudoNote = `The vault's pseudo-account holds the RLUSD. It cannot receive ordinary payments, so money reaches lenders only through VaultDeposit, LoanPay and, on default, cover moved by LoanManage.`;

// ---------- gates ----------
const featData = (net) => FEAT[net].data;
const gateFor = (net) => S.networkGate(net, featData(net));
function actions(p) {
  const now = S.nowRipple(), g = gateFor(p.network), net = NETWORKS[p.network], asset = net.asset, c = LG.pool[p.id] || {};
  const v = c.vault ? { VaultID: p.ledger.VaultID, ...c.vault } : { VaultID: p.ledger.VaultID, VaultKind: 1, SubscriptionDate: p.ledger.SubscriptionDate, RedemptionDate: p.ledger.RedemptionDate };
  const fee = S.capMathFeeRate(p), plan = S.planUnderCap(p.capRlusd, p.terms, fee);
  const w = X.wallet, base = [...g.reasons]; if (!w.account) base.push("Connect a wallet.");
  const listed = p.stage === "listed" ? [] : ["The shop is not listed yet (QAK vote pending)."];
  const list = [];
  const add = (key, label, who, extra, build) => { let tx = null, err = null; try { tx = build(); } catch (e) { err = e.message; }
    list.push({ key, label, who, reasons: [...base, ...extra, ...(err && !extra.length ? [err] : [])], tx, err }); };
  add("VaultCreate", "1. VaultCreate (closed-ended, RLUSD)", "operator", [...listed, ...(p.ledger.VaultID ? ["Vault already created for this shop."] : [])],
    () => P.vaultCreate({ asset, AssetsMaximum: p.capRlusd, ...S.planDates(p.plan, now), now }));
  add("LoanBrokerSet", "2. LoanBrokerSet on this VaultID", "operator (vault owner)", [...(p.ledger.VaultID ? [] : ["Needs a VaultID."]), ...(p.ledger.LoanBrokerID ? ["Broker already created."] : [])],
    () => P.loanBrokerSet({ VaultID: p.ledger.VaultID, ManagementFeeRate: S.feeRateAtBrokerCreation(p.shopHoldingQak), DebtMaximum: p.capRlusd }));
  const need = S.coverRequired(0, plan.maxPrincipal, plan.interestDue, RULES.COVER_RATE_MINIMUM);
  add("LoanBrokerCoverDeposit", "3. LoanBrokerCoverDeposit (RLUSD first-loss)", "operator (broker owner)", p.ledger.LoanBrokerID ? [] : ["Needs a LoanBrokerID."],
    () => P.loanBrokerCoverDeposit({ LoanBrokerID: p.ledger.LoanBrokerID, asset, amount: Math.ceil(need * 100) / 100 }));
  const dg = S.depositGate(v, now);
  add("VaultDeposit", "4. VaultDeposit (lenders, subscription window only)", "lender", dg.ok ? [] : [dg.reason],
    () => P.vaultDeposit({ VaultID: p.ledger.VaultID, asset, amount: 100 }));
  const lg = S.loanSetWindowGate(v, p.terms, now); const cov = c.broker ? Number(c.broker.CoverAvailable) : null;
  const loanExtra = [...(lg.ok ? [] : [lg.reason]), ...(p.ledger.LoanID ? ["This shop already has its loan."] : []), ...(p.account ? [] : ["No shop account on file for Counterparty."]),
    ...(cov != null && cov < need ? [`CoverAvailable ${m2(cov)} is below the required ${m2(need)}.`] : [])];
  add("LoanSet", "5. LoanSet (broker signs, shop counter-signs)", "broker + shop", loanExtra,
    () => P.loanSet({ LoanBrokerID: p.ledger.LoanBrokerID, Counterparty: p.account, PrincipalRequested: plan.maxPrincipal, terms: p.terms }));
  const loan = c.loan || null, mm = S.loanMath(plan.maxPrincipal, p.terms, fee);
  add("LoanPay", "6. LoanPay (fixed installment)", "shop", p.ledger.LoanID ? [] : ["Needs a LoanID."],
    () => P.loanPay({ LoanID: p.ledger.LoanID, asset, amount: Math.ceil((loan ? Number(loan.PeriodicPayment) : mm.periodicPayment) * 1e6) / 1e6, late: loan ? now > loan.NextPaymentDueDate : false }));
  const ig = S.impairGate(loan, now), dfg = S.defaultGate(loan, now), del = S.deleteGate(loan);
  add("LoanManageImpair", "7a. LoanManage tfLoanImpair (overdue payment)", "operator", p.ledger.LoanID ? (ig.ok ? [] : [ig.reason]) : ["Needs a LoanID."], () => P.loanManage({ LoanID: p.ledger.LoanID, action: "impair" }));
  add("LoanManageDefault", "7b. LoanManage tfLoanDefault (after grace)", "operator", p.ledger.LoanID ? (dfg.ok ? [] : [dfg.reason]) : ["Needs a LoanID."], () => P.loanManage({ LoanID: p.ledger.LoanID, action: "default" }));
  add("LoanDelete", "8. LoanDelete (settled or written off)", "shop or operator", p.ledger.LoanID ? (del.ok ? [] : [del.reason]) : ["Needs a LoanID."], () => P.loanDelete({ LoanID: p.ledger.LoanID }));
  return list;
}
const CREATES = { VaultCreate: ["Vault", "VaultID"], LoanBrokerSet: ["LoanBroker", "LoanBrokerID"] };
async function runAction(p, a) {
  const out = document.getElementById("txout"); const say = (t) => { if (out) out.textContent = t; };
  try {
    if (a.key === "LoanSet") {
      const r = await X.signTx(a.tx, p.network, { submit: false, instruction: "Duck Bank LoanSet: broker signature (not submitted)" });
      say(r.mock ? r.note : `Broker signature collected (not submitted). The shop must now add CounterpartySignature. ${X.XAMAN_SUPPORT.counterparty}${r.hex ? "\nSigned blob: " + r.hex : ""}`); return;
    }
    const r = await X.signTx(a.tx, p.network, {}); if (r.mock) { say(r.note); return; }
    if (!r.signed) { say("Not signed."); return; }
    say(`Signed and submitted: ${r.txid || "(no tx hash returned)"}. Waiting for validation…`);
    if (CREATES[a.key] && r.txid) { await new Promise((res) => setTimeout(res, 8000)); const id = await L.createdId(p.network, r.txid, CREATES[a.key][0]);
      S.recordLedger(st, p.id, CREATES[a.key][1], id);
      if (a.key === "VaultCreate") { S.recordLedger(st, p.id, "SubscriptionDate", a.tx.SubscriptionDate); S.recordLedger(st, p.id, "RedemptionDate", a.tx.RedemptionDate); }
      if (a.key === "LoanBrokerSet") S.recordLedger(st, p.id, "ManagementFeeRate", a.tx.ManagementFeeRate);
      save(); LG.pool[p.id] = null; route(); }
  } catch (e) { say("Error: " + (e.message || e)); }
}

// ---------- pages ----------
const firstPlan = () => { const p = st.pools.find((x) => x.id === "first"); return S.planUnderCap(p.capRlusd, p.terms, S.capMathFeeRate(p)); };
function capCard(p) {
  const fee = S.capMathFeeRate(p), pl = S.planUnderCap(p.capRlusd, p.terms, fee), mm = S.loanMath(pl.maxPrincipal, p.terms, fee);
  const need = S.coverRequired(0, pl.maxPrincipal, pl.interestDue, RULES.COVER_RATE_MINIMUM);
  const d0 = S.defaultCover({ DebtTotal: pl.debtAtLoanSet, CoverRateMinimum: RULES.COVER_RATE_MINIMUM, CoverRateLiquidation: RULES.COVER_RATE_LIQUIDATION, CoverAvailable: need, DefaultAmount: pl.debtAtLoanSet });
  return `<div class="card"><h3>Cap math: maximum principal under the cap</h3>
  <p>AssetsMaximum and DebtMaximum are both ${n(p.capRlusd)} ${ASSET}. XLS-66 counts expected interest toward both: LoanSet fails if AssetsTotal ≥ AssetsMaximum, if AssetsTotal + InterestDue &gt; AssetsMaximum, or if DebtTotal + PrincipalRequested + InterestDue &gt; DebtMaximum (all tecLIMIT_EXCEEDED). So a full ${n(p.capRlusd)} deposit plus a ${n(p.capRlusd)} principal would make LoanSet fail.</p>
  <table><tr><td>Maximum principal that fits</td><td><b>${m2(pl.maxPrincipal)} ${ASSET}</b></td></tr>
  <tr><td>Expected interest to the vault (InterestDue)</td><td>${m2(pl.interestDue)} ${ASSET} (fee rate used: ${fee}${p.ledger.ManagementFeeRate == null ? ", the lower fee tier, so the bound holds for either tier" : ""})</td></tr>
  <tr><td>Principal + InterestDue</td><td>${m2(pl.debtAtLoanSet)} ≤ ${n(p.capRlusd)}</td></tr>
  <tr><td>Deposit target (app stops here)</td><td>${m2(pl.depositTarget)} ${ASSET}. The vault is public, so the ledger itself accepts deposits up to AssetsMaximum. If direct deposits push AssetsTotal to ${n(p.capRlusd)}, LoanSet fails and lenders wait for RedemptionDate.</td></tr>
  <tr><td>Fixed installment (PeriodicPayment)</td><td>${m2(mm.periodicPayment)} ${ASSET} × ${n(p.terms.PaymentTotal)}</td></tr>
  <tr><td>Cover required before LoanSet</td><td>${m2(need)} ${ASSET} = (DebtTotal + PrincipalRequested + InterestDue) × CoverRateMinimum ${pctOf(RULES.COVER_RATE_MINIMUM)}</td></tr>
  <tr><td>Default with no payments made</td><td>DefaultCovered = min(${m2(pl.debtAtLoanSet)} × ${pctOf(RULES.COVER_RATE_MINIMUM)} × ${pctOf(RULES.COVER_RATE_LIQUIDATION)}, ${m2(pl.debtAtLoanSet)}, CoverAvailable) = ${m2(d0.defaultCovered)}; written down on this vault: ${m2(d0.vaultLoss)} ${ASSET}</td></tr></table>
  <p class="note">The ${n(p.capRlusd)} ${ASSET} cap is unchanged. Rounded down to the cent with a ${RULES.ROUNDING_MARGIN} ${ASSET} margin for ledger rounding. Formulas: XLS-66 Appendix A-2 (1), (5)-(7), (30)-(33).</p></div>`;
}
const pages = {
  "": () => { const pl = firstPlan(); return `<section class="hero"><div class="hero-text">
   <span class="eyebrow">Duck Bank · XRP Ledger · ${ASSET}</span>
   <h1>Short loans to named shops. One shop per vault.</h1>
   <p class="lead">Each shop gets its own closed-ended XRPL vault in ${ASSET} and one loan broker. Lenders deposit during the subscription window and hold the vault MPT share: the receipt for that shop only. The shop borrows once in the investment window and repays in fixed installments. A miss stays in that shop.</p>
   <div class="cta"><a class="btn" href="#/pools">Browse pools</a><a class="btn sec" href="#/apply">Apply as a shop</a></div>
   </div><div class="hero-art"><img src="/banner.jpg" alt="Duck Bank on the XRP Ledger" class="banner"/></div></section>
   <div class="stats"><div><b>1</b><span>first pool (sample shop)</span></div><div><b>${n(RULES.MAX_CAP_RLUSD)}</b><span>${ASSET} cap (AssetsMaximum)</span></div><div><b>${m2(pl.maxPrincipal)}</b><span>${ASSET} max principal under the cap</span></div><div><b>Off</b><span>mainnet deposits</span></div></div>
   <div class="grid"><div class="card"><h3>The ledger model</h3>VaultCreate (VaultKind ClosedEnded, SubscriptionDate, RedemptionDate, AssetsMaximum) → LoanBrokerSet on that VaultID → LoanBrokerCoverDeposit in ${ASSET} → VaultDeposit in the subscription window → a LoanSet signed by broker and shop in the investment window → LoanPay. Overdue: LoanManage tfLoanImpair; after grace: LoanManage tfLoanDefault. Settled or written off: LoanDelete.</div>
   <div class="card"><h3>QAK, the app token</h3>QAK lists a shop, sets the fee cut at broker creation, orders the deposit queue and votes on the listing and the cap. ${ASSET} is the lent asset. The vault MPT share is the lender's receipt. RLUSD cover posted by the broker is the only first-loss the ledger uses.</div>
   <div class="card"><h3>Status</h3>XLS-65/66 are not enabled on mainnet, so mainnet deposits are off. As of 8 Oct 2026, devnet has all three required amendments enabled; the devnet path needs a test issuer, because RLUSD does not exist on devnet. <a href="#/status">Live check</a></div></div>
   <div class="card"><h3>Risks</h3>${risks}</div>`; },
  apply: () => `<h1>Shop application</h1><form class="card" id="f">
   <p>${X.wallet.account ? `Applying as ${esc(X.wallet.account)}${X.wallet.mode === "mock" ? " (mock)" : ""}` : '<span class="warn">Connect a wallet to apply. Your account becomes the LoanSet Counterparty.</span>'}</p>
   <p class="note">Shop name, city and purpose stay off-ledger, stored next to the vault and broker ids.</p>
   <label>Shop name<input name="shop" required maxlength="${LIMITS.NAME_MAX}"></label><label>City<input name="city" required maxlength="${LIMITS.NAME_MAX}"></label>
   <label>Purpose<select name="purpose"><option>stock</option><option>fit-out</option></select></label>
   <label>Cap (${ASSET}; becomes AssetsMaximum and DebtMaximum; max ${n(RULES.MAX_CAP_RLUSD)})<input name="capRlusd" type="number" min="1" step="1" max="${RULES.MAX_CAP_RLUSD}" value="${RULES.MAX_CAP_RLUSD}" required></label>
   <label>Interest rate % APR (${LIMITS.RATE_MIN_PCT}-${LIMITS.RATE_MAX_PCT}; InterestRate in 1/10 bps)<input name="ratePct" type="number" step="0.001" min="${LIMITS.RATE_MIN_PCT}" max="${LIMITS.RATE_MAX_PCT}" value="10" required></label>
   <label>Number of payments (PaymentTotal, ${LIMITS.PAYMENTS_MIN}-${LIMITS.PAYMENTS_MAX})<input name="paymentTotal" type="number" step="1" min="${LIMITS.PAYMENTS_MIN}" max="${LIMITS.PAYMENTS_MAX}" value="3" required></label>
   <label>Payment interval in days (PaymentInterval)<input name="intervalDays" type="number" step="1" min="${LIMITS.INTERVAL_MIN_DAYS}" max="${LIMITS.INTERVAL_MAX_DAYS}" value="30" required></label>
   <label>Grace period in days (GracePeriod, at most the payment interval)<input name="graceDays" type="number" step="1" min="1" value="7" required></label>
   <label>QAK listing lock (app lock, must be ${n(RULES.LISTING_LOCK_QAK)})<input name="listingLock" type="number" step="1" value="${RULES.LISTING_LOCK_QAK}" required></label>
   <label>QAK balance (ledger)<input id="ledgerqak" type="text" readonly value="${esc(balText())}"></label>
   <p id="calc" class="note"></p><p id="err" class="off" role="alert"></p>
   <button>Submit application</button></form>
   <p>Repayment is a fixed installment each PaymentInterval; a smaller payment fails (tecINSUFFICIENT_PAYMENT). QAK holders then vote on the listing and the cap. Status starts at ${stageTag("applied")}.</p>`,
  whitepaper: () => `<h1>Duck Bank whitepaper</h1><p><a class="btn" href="/qak-whitepaper.pdf" download>Download PDF</a> <a class="btn sec" href="/qak-whitepaper.pdf" target="_blank" rel="noopener">Open in new tab</a></p>
   <iframe src="/qak-whitepaper.pdf" class="pdf" title="Duck Bank whitepaper"></iframe>`,
  pools: () => `<h1>Pools</h1><p class="note">One shop per vault. No pool has on-ledger objects yet.</p><div class="grid">${st.pools.map((p) => { const pl = S.planUnderCap(p.capRlusd, p.terms, S.capMathFeeRate(p));
   return `<div class="card"><h3><a href="#/pool/${encodeURIComponent(p.id)}">${esc(p.shop)}</a>${sample(p)}</h3>
   ${esc(p.city)} · ${esc(p.purpose)} · ${stageTag(p.stage)} · ${esc(NETWORKS[p.network].label)}<br>AssetsMaximum ${n(p.capRlusd)} ${ASSET} · max principal ${m2(pl.maxPrincipal)}<br>
   ${pctOf(p.terms.InterestRate)} APR · ${n(p.terms.PaymentTotal)} × ${days(p.terms.PaymentInterval)} · grace ${days(p.terms.GracePeriod)}<br>VaultID: ${p.ledger.VaultID ? `<code>${esc(p.ledger.VaultID.slice(0, 12))}…</code>` : NC}</div>`; }).join("")}</div>`,
  pool: (id) => { const p = st.pools.find((x) => x.id === id); if (!p) return `<h1>Not found</h1><p>No pool with that id.</p><p><a class="btn" href="#/pools">Back to Pools</a></p>`;
   loadPool(p); const c = LG.pool[p.id] || {}, v = c.vault, b = c.broker, net = NETWORKS[p.network], ids = p.ledger;
   const sub = v ? v.SubscriptionDate : ids.SubscriptionDate, red = v ? v.RedemptionDate : ids.RedemptionDate;
   const idCell = (x) => (x ? `<code>${esc(x)}</code>` : NC);
   const subW = sub ? `until ${esc(athens(S.fromRipple(sub)))} (SubscriptionDate)` : `planned: ${n(p.plan.subscriptionDays)} days from VaultCreate; SubscriptionDate is fixed at VaultCreate (${NC})`;
   const invW = sub && red ? `${esc(athens(S.fromRipple(sub)))} to ${esc(athens(S.fromRipple(red)))}; LoanSet no later than ${esc(athens(S.fromRipple(S.latestLoanSetTime({ RedemptionDate: red }, p.terms))))}` : `planned: ${n(p.plan.investmentDays)} days after SubscriptionDate. LoanSet must satisfy StartDate + PaymentInterval × PaymentTotal + 60 s ≤ RedemptionDate (${days(S.loanMaturitySpan(p.terms))} term)`;
   const acts = actions(p); window.__acts = acts; window.__pool = p;
   return `<h1>${esc(p.shop)} ${stageTag(p.stage)}${sample(p)}</h1>
   <div class="card"><h3>Ledger objects (${esc(net.label)})</h3><table>
   <tr><td>VaultID</td><td>${idCell(ids.VaultID)}</td></tr><tr><td>LoanBrokerID</td><td>${idCell(ids.LoanBrokerID)}</td></tr><tr><td>LoanID</td><td>${idCell(ids.LoanID)}</td></tr>
   <tr><td>Vault kind</td><td>VaultKind ${SPEC.VaultKind.ClosedEnded} (ClosedEnded)</td></tr>
   <tr><td>Subscription window</td><td>${subW}</td></tr><tr><td>Investment window</td><td>${invW}</td></tr>
   <tr><td>Redemption date</td><td>${red ? esc(athens(S.fromRipple(red))) + " (RedemptionDate)" : `${NC}; set at VaultCreate`}</td></tr>
   <tr><td>Phase now</td><td>${esc(S.vaultPhase(v ? { VaultID: ids.VaultID, ...v } : { VaultID: ids.VaultID, VaultKind: 1, SubscriptionDate: sub, RedemptionDate: red }, S.nowRipple()))}</td></tr>
   <tr><td>Asset</td><td>${esc(net.asset.label)}, currency ${esc(net.asset.currency)}, issuer ${net.asset.issuer ? esc(net.asset.issuer) : `<span class="warn">${esc(net.asset.placeholder || "not set")}</span>`}</td></tr>
   <tr><td>AssetsMaximum</td><td>${n(p.capRlusd)} ${ASSET}${v ? ` (ledger: ${esc(v.AssetsMaximum)}; AssetsTotal ${esc(v.AssetsTotal)}, AssetsAvailable ${esc(v.AssetsAvailable)}, LossUnrealized ${esc(v.LossUnrealized)})` : ""}</td></tr>
   <tr><td>DebtMaximum</td><td>${n(p.capRlusd)} ${ASSET}${b ? ` (ledger: ${esc(b.DebtMaximum)}; DebtTotal ${esc(b.DebtTotal)})` : ""}</td></tr>
   <tr><td>CoverAvailable</td><td>${b ? esc(b.CoverAvailable) + " " + ASSET : NC}</td></tr>
   <tr><td>CoverRateMinimum / CoverRateLiquidation</td><td>${RULES.COVER_RATE_MINIMUM} (${pctOf(RULES.COVER_RATE_MINIMUM)}) / ${RULES.COVER_RATE_LIQUIDATION} (${pctOf(RULES.COVER_RATE_LIQUIDATION)}); fixed at LoanBrokerSet</td></tr>
   <tr><td>Share non-transferable</td><td>${RULES.SHARE_NON_TRANSFERABLE ? "yes: tfVaultShareNonTransferable is set at VaultCreate, so the vault MPT share can only be redeemed" : "no"}</td></tr>
   <tr><td>Scale</td><td>${RULES.VAULT_SCALE} (IOU vault; spec range 0-18, default 6)</td></tr>
   <tr><td>ManagementFeeRate</td><td>${ids.ManagementFeeRate != null ? `${ids.ManagementFeeRate} (${S.feePct(ids.ManagementFeeRate)}% of interest)` : `decided at broker creation: ${RULES.FEE_RATE} (${S.feePct(RULES.FEE_RATE)}%), or ${RULES.FEE_RATE_DISCOUNT} (${S.feePct(RULES.FEE_RATE_DISCOUNT)}%) if the shop holds ≥ ${n(RULES.DISCOUNT_MIN_HOLDING_QAK)} QAK on the ledger then`}</td></tr>
   <tr><td>Loan terms</td><td>InterestRate ${p.terms.InterestRate} (${pctOf(p.terms.InterestRate)} APR), PaymentTotal ${p.terms.PaymentTotal}, PaymentInterval ${n(p.terms.PaymentInterval)} s (${days(p.terms.PaymentInterval)}), GracePeriod ${n(p.terms.GracePeriod)} s (${days(p.terms.GracePeriod)}); no origination, service or late fees</td></tr>
   ${c.err ? `<tr><td>Ledger read</td><td class="off">unavailable: ${esc(c.err)}</td></tr>` : ""}</table>
   <p class="note">${pseudoNote}</p></div>
   ${capCard(p)}
   <div class="card"><h3>Off-ledger (Duck Bank app)</h3><table><tr><td>Shop / city / purpose</td><td>${esc(p.shop)} / ${esc(p.city)} / ${esc(p.purpose)}</td></tr>
   <tr><td>Shop account (LoanSet Counterparty)</td><td>${p.account ? esc(p.account) : "not on file (sample shop)"}</td></tr>
   ${qakRow}<tr><td>Listing lock</td><td>${n(p.listingLock.qak)} QAK, an app lock. It is not CoverAvailable and the ledger never takes it.</td></tr>
   <tr><td>Votes (1 QAK = 1 vote)</td><td>listing: yes ${n(p.votes.yes)} / no ${n(p.votes.no)}</td></tr></table></div>
   <div class="card"><h3>Transactions for this shop</h3><p class="note">Each button builds the exact spec fields and asks Xaman to sign on ${esc(net.label)} (force_network ${esc(net.xaman)}). Xaman support for these transaction types is not verified. Mainnet is hard-off.</p>
   <ol class="acts">${acts.map((a, i) => `<li><b>${esc(a.label)}</b> <span class="muted">by ${esc(a.who)}</span><br>
     <button data-act="${i}" ${a.reasons.length || !a.tx ? "disabled" : ""}>${X.wallet.mode === "mock" ? "Mock sign (nothing is signed)" : "Sign in Xaman"}</button>
     ${a.reasons.length ? `<span class="off">${a.reasons.map(esc).join(" ")}</span>` : ""}
     ${a.tx ? `<details><summary>Payload fields</summary><pre>${esc(JSON.stringify(a.tx, null, 1))}</pre></details>` : ""}</li>`).join("")}</ol>
   <p class="note">LoanSet follows XLS-66 §3.8.3: the broker signs first with Counterparty = the shop; the shop then fills CounterpartySignature and submits. ${esc(X.XAMAN_SUPPORT.counterparty)}</p>
   <pre id="txout" class="out"></pre>
   <ul>${p.log.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>`; },
  lend: () => { const g = gateFor("devnet"); return `<h1>Lender panel</h1>
   <div class="card">Wallet: ${esc(X.wallet.account || "not connected")}${X.wallet.mode === "mock" ? " (mock)" : ""}<br>QAK balance (ledger): ${esc(balText())}<br>
   <button disabled>Deposit: open a pool page; VaultDeposit only in its subscription window</button><br><span class="off">${g.ok ? "" : esc(g.reasons.join(" "))}</span></div>
   <div class="card"><h3>What you hold</h3>A VaultDeposit returns the vault MPT share, issued by that vault's pseudo-account. It is the receipt for that shop only, and it is redeemable from RedemptionDate. During the investment window it cannot be withdrawn.
   <table><tr><th>Pool</th><th>VaultID</th><th>Your vault MPT share</th></tr>${st.pools.map((p) => `<tr><td>${esc(p.shop)}</td><td>${p.ledger.VaultID ? `<code>${esc(p.ledger.VaultID.slice(0, 12))}…</code>` : NC}</td><td>${p.ledger.VaultID ? "read from the ledger (MPToken of the vault's ShareMPTID)" : "none"}</td></tr>`).join("")}</table></div>
   <div class="card"><h3>Lent asset per network</h3><table>${Object.values(NETWORKS).map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(x.asset.label)}</td><td>${x.asset.issuer ? esc(x.asset.issuer) : `<span class="warn">${esc(x.asset.placeholder || "not set")}</span>`}</td></tr>`).join("")}</table></div>
   <div class="card"><h3>Deposit queue (app rule)</h3>Locked QAK orders the Duck Bank queue. The vault is public, so the ledger accepts any VaultDeposit during Subscription; the queue orders who the app invites first.
   <ol>${st.queue.map((q) => `<li>${esc(q.who.slice(0, 10))} ${n(q.amt)} → ${esc(q.id)} (QAK ${n(q.qakLocked)})</li>`).join("") || "<li>empty</li>"}</ol></div>
   <div class="card"><h3>QAK</h3><table>${qakRow}</table>${lineNote}</div>
   <div class="card"><h3>Risks</h3>${risks}</div>`; },
  qak: () => { const R = RULES, K = TOKENOMICS; return `<h1>QAK</h1><p>QAK is Duck Bank's app token. Its roles are app rules; none of them is ledger cover.</p><div class="grid">
   ${[["Listing", `A shop locks <b>${n(R.LISTING_LOCK_QAK)} QAK</b> to be listed. This is an app lock.`],
     ["Fee cut", `ManagementFeeRate is fixed at LoanBrokerSet, so the discount is decided at broker creation: ${R.FEE_RATE} (${S.feePct(R.FEE_RATE)}% of interest), or ${R.FEE_RATE_DISCOUNT} (${S.feePct(R.FEE_RATE_DISCOUNT)}%) if the shop's ledger balance is at least ${n(R.DISCOUNT_MIN_HOLDING_QAK)} QAK at that moment.`],
     ["Queue", "Locked QAK orders the Duck Bank deposit queue. It does not reserve a fill, and the public vault accepts any VaultDeposit during Subscription."],
     ["Vote", "One QAK, one vote, on the listing and the cap. A vote cannot move another vault's deposits."]]
     .map(([h, b]) => `<div class="card"><h3>${h}</h3>${b}</div>`).join("")}</div>
   <div class="card"><h3>App locks are not cover</h3>Any QAK escrow or lock is an app lock. It is not CoverAvailable: LoanBrokerCoverDeposit accepts only the vault asset (${ASSET}) and only from the broker owner. On default the ledger takes RLUSD cover only. ${ASSET} is the lent asset, and the vault MPT share is the lender's receipt.</div>
   ${issuerCard()}${lineNote}
   <h2>Tokenomics</h2><div class="card"><p>Created on ${K.venue} in ${K.mint}. Supply <b>${n(K.supply)}</b> QAK, fixed. The issuer is blackholed. Half of supply, the issuer allocation, is in two escrows.</p>
   <table><tr><th>Bucket</th><th>Of supply</th><th>Tokens</th><th>Use</th></tr>${K.buckets.map((b) => `<tr><td>${esc(b.name)}</td><td>${b.pct}%</td><td>${n(b.tokens)}</td><td>${esc(b.use)}</td></tr>`).join("")}</table></div>
   <div class="card"><h3>Escrows</h3><table>${K.escrow.map((e) => `<tr><td>${esc(e.name)}</td><td>${n(e.tokens)} QAK</td><td>unlocks ${esc(e.unlock)}</td></tr>`).join("")}</table><p class="note">The live escrow list is in the issuer card above.</p></div>
   <div class="card"><h3>Launch</h3>${K.venue}: ${K.launch.liquidityXrp} XRP starting liquidity, ${K.launch.ammFeePct}% AMM fee, ${K.launch.antiSniperMin}-minute anti-sniper.</div>
   <h2>Team</h2><div class="grid">${TEAM.map((t) => `<div class="card"><h3>${esc(t.name)}</h3>${esc(t.role)}</div>`).join("")}</div>
   <h2>Roadmap</h2><table class="card"><tr><th>When</th><th>Step</th><th>What</th></tr>${ROADMAP.map((r) => `<tr><td>${esc(r.when)}</td><td>${esc(r.step)}</td><td>${esc(r.what)}</td></tr>`).join("")}</table>`; },
  status: () => { const nets = Object.keys(NETWORKS), all = [...AMENDMENTS.required, ...AMENDMENTS.info];
   const cell = (net, a) => { const f = FEAT[net]; if (f.loading) return `<td>checking…</td>`; if (f.err) return `<td class="warn">unavailable</td>`; if (!f.data) return `<td class="muted">snapshot: ${AMENDMENTS.snapshot[net][a] ? "enabled" : "not enabled"}</td>`; return f.data[a] ? `<td class="on">enabled</td>` : `<td class="off">not enabled</td>`; };
   return `<h1>Amendment status</h1>
   <p>Live check: the read-only <code>feature</code> RPC on each network (no arguments, so nothing is voted or changed). Deposits and LoanSet stay disabled on a network until <b>all three</b> of SingleAssetVault, LendingProtocol and LendingProtocolV1_1 are enabled there. A rippled release is not activation: a server can support an amendment long before validators enable it, and only "enabled" counts.</p>
   <p><button id="recheck">Re-check all networks now</button></p>
   <table><tr><th>Amendment</th>${nets.map((k) => `<th>${esc(NETWORKS[k].label)}<br><span class="muted">${esc(NETWORKS[k].rpc)}</span></th>`).join("")}</tr>
   ${all.map((a) => `<tr><td>${esc(a)}${AMENDMENTS.info.includes(a) ? " (info: impairment timing)" : ""}</td>${nets.map((k) => cell(k, a)).join("")}</tr>`).join("")}
   <tr><td>Checked</td>${nets.map((k) => `<td>${FEAT[k].at ? esc(athens(FEAT[k].at)) : `snapshot ${esc(AMENDMENTS.snapshot.checked)}`}${FEAT[k].err ? `<br><span class="warn">${esc(FEAT[k].err)}</span>` : ""}</td>`).join("")}</tr>
   <tr><td>Vault lending in this app</td>${nets.map((k) => { const g = gateFor(k); return `<td class="${g.ok ? "on" : "off"}">${g.ok ? "allowed" : "disabled: " + esc(g.reasons.join(" "))}</td>`; }).join("")}</tr></table>
   <div class="card"><h3>Network config</h3><table><tr><th>Network</th><th>Feature flag</th><th>Lent asset</th><th>Issuer</th></tr>${nets.map((k) => { const x = NETWORKS[k]; return `<tr><td>${esc(x.label)}</td><td>${x.vaultLending ? "on when all three amendments are enabled" : `off (${esc(x.offReason)})`}</td><td>${esc(x.asset.label)}</td><td>${x.asset.issuer ? esc(x.asset.issuer) : `<span class="warn">${esc(x.asset.placeholder || "not set")}</span>`}</td></tr>`; }).join("")}</table>
   <p class="note">RLUSD does not exist on devnet, so devnet uses a self-issued test IOU. With no test issuer configured, devnet actions stay disabled. The RLUSD issuer has clawback enabled (AllowTrustLineClawback).</p></div>
   <div class="card"><h3>Xaman support</h3><ul><li>Networks: ${esc(X.XAMAN_SUPPORT.forceNetwork)}</li><li>Transaction types (${GATED_TXS.length} XLS-65/66 types): ${esc(X.XAMAN_SUPPORT.txTypes)}</li><li>LoanSet counter-signature: ${esc(X.XAMAN_SUPPORT.counterparty)}</li><li>Without an API key the wallet is a mock: it shows payloads and signs nothing.</li></ul></div>
   <h2>QAK issuer</h2>${issuerCard()}`; },
};
function issuerCard() {
  if (LG.issuerErr && !LG.issuer) return `<div class="card"><h3>Live issuer status</h3><p>Live issuer status unavailable right now (${esc(LG.issuerErr)}). Check the issuer on ${qakLink}.</p><button id="reissuer">Retry</button></div>`;
  const x = LG.issuer; if (!x) return `<div class="card"><h3>Live issuer status</h3><p>Reading the issuer from the XRP Ledger…</p></div>`;
  return `<div class="card"><h3>Live issuer status</h3><table>${qakRow}
   <tr><td>Blackholed</td><td class="${x.blackholed ? "on" : "off"}">${x.blackholed ? "yes" : "no"} (master key ${x.masterDisabled ? "disabled" : "enabled"}; regular key ${esc(x.regularKey || "none")}; signer lists ${n(x.signerListCount)})</td></tr>
   <tr><td>Circulating (issuer obligations)</td><td>${esc(Number(x.obligations).toLocaleString("en-US", { maximumFractionDigits: 2 }))} QAK</td></tr>
   <tr><td>Escrowed</td><td>${x.escrows.length ? `${n(x.escrowedTotal)} QAK in ${n(x.escrows.length)} escrow(s)<ul>${x.escrows.map((e) => `<li>${esc(Number(e.value).toLocaleString("en-US"))} QAK to ${esc(e.destination)}, unlocks (FinishAfter) ${esc(athens(e.finishAfter))}${e.cancelAfter ? ", cancel after " + esc(athens(e.cancelAfter)) : ""}</li>`).join("")}</ul>` : "none"}</td></tr>
   <tr><td>Flags</td><td>${esc(x.flags.join(", ") || "none")}</td></tr></table>
   <p class="note">Read live from the XRP Ledger (xrplcluster.com, validated ledger ${esc(x.ledgerIndex ?? "?")}) at ${esc(athens(x.fetchedAt))}. <button id="reissuer" class="sec">Refresh</button></p></div>`;
}
function walletUI() {
  const w = X.wallet, el = document.getElementById("wallet");
  el.innerHTML = w.account ? `<span>${esc(w.account.slice(0, 8))}… · ${esc(w.network)}${w.mode === "mock" ? ' · <span class="tag sample">mock</span>' : ""}</span>
   <button class="sec" id="sg">Sign-in test</button> <button class="sec" id="dc">Disconnect</button>${w.lastSign ? ` <span class="${w.lastSign.signed ? "on" : "warn"}">${w.lastSign.mock ? "mock: nothing signed" : "signed: " + esc(w.lastSign.signed)}</span>` : ""}`
   : `<button id="cx">${X.hasKey() ? "Connect Xaman" : "Mock wallet"}</button>`;
  el.querySelector("#cx")?.addEventListener("click", () => X.connect().catch((e) => alert(e.message)));
  el.querySelector("#sg")?.addEventListener("click", () => X.signTest().catch((e) => alert(e.message)));
  el.querySelector("#dc")?.addEventListener("click", () => X.disconnect());
}
const notFound = () => `<h1>404: page not found</h1><p>There is no page at this address.</p><p><a class="btn" href="#/">Home</a></p>`;
const dec = (x) => { try { return decodeURIComponent(x || ""); } catch { return ""; } };
function applyCalc(f) {
  const el = document.getElementById("calc"); if (!el) return;
  try { const terms = { InterestRate: Math.round(Number(f.ratePct.value) * 1000), PaymentTotal: Number(f.paymentTotal.value), PaymentInterval: Number(f.intervalDays.value) * 86400, GracePeriod: Number(f.graceDays.value) * 86400 };
    const cap = Number(f.capRlusd.value), errs = S.validateLoanTerms({ ...terms, PrincipalRequested: cap || 1 });
    if (errs.length) { el.textContent = errs.join("; "); return; }
    const pl = S.planUnderCap(cap, terms, RULES.FEE_RATE_DISCOUNT), need = S.coverRequired(0, pl.maxPrincipal, pl.interestDue, RULES.COVER_RATE_MINIMUM);
    el.textContent = `With AssetsMaximum = DebtMaximum = ${n(cap)} ${ASSET}: maximum principal ${m2(pl.maxPrincipal)} (InterestDue ${m2(pl.interestDue)} counts toward the cap). RLUSD cover required before LoanSet: ${m2(need)}. Term ${n(terms.PaymentTotal * terms.PaymentInterval / 86400)} days must end at least 60 s before RedemptionDate.`;
  } catch (e) { el.textContent = e.message; }
}
function route() {
  const [pg, arg] = location.hash.replace(/^#\/?/, "").split("/");
  if (pg === "trust") { location.replace("#/qak"); return; }
  const titles = { "": "Duck Bank", apply: "Apply", pools: "Pools", pool: "Pool", lend: "Lend", qak: "QAK", status: "Status", whitepaper: "Whitepaper" };
  document.title = Object.hasOwn(titles, pg) ? (pg ? `${titles[pg]} · ${PRODUCT.name}` : `${PRODUCT.name}: short loans to named shops on the XRP Ledger`) : `Not found · ${PRODUCT.name}`;
  $(Object.hasOwn(pages, pg) ? pages[pg](dec(arg)) : notFound());
  document.getElementById("recheck")?.addEventListener("click", checkAll);
  if (pg === "qak" || pg === "status") { loadIssuer(false); document.getElementById("reissuer")?.addEventListener("click", () => loadIssuer(true)); }
  document.querySelectorAll("button[data-act]").forEach((btn) => btn.addEventListener("click", () => { const a = window.__acts?.[Number(btn.dataset.act)]; if (a && window.__pool) runAction(window.__pool, a); }));
  const f = document.getElementById("f");
  if (f) { const upd = () => applyCalc(f); f.addEventListener("input", upd); upd();
    f.onsubmit = (e) => { e.preventDefault(); const err = document.getElementById("err");
      try { const p = S.apply(st, { ...Object.fromEntries(new FormData(f)), account: X.wallet.account, ledgerQak: ledgerQak(), ledgerVerified: ledgerVerified() }); save(); location.hash = "#/pool/" + encodeURIComponent(p.id); }
      catch (x) { err.textContent = x.message; } }; }
}
window.addEventListener("hashchange", route); window.addEventListener("wallet", () => { loadBalance(); walletUI(); soft(["", "pools", "pool", "lend", "qak", "status", "whitepaper"]); const a = document.querySelector("#f p"); if (a && X.wallet.account) a.textContent = "Applying as " + X.wallet.account + (X.wallet.mode === "mock" ? " (mock)" : ""); });
walletUI(); route(); X.init(); checkFeatures("devnet");
