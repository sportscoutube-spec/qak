#!/usr/bin/env node
// Duck Bank escrow bot, broker side. It holds the broker key and the escrow fulfillment, so it runs only here in Node, never in the browser.
// Every step it takes is an app step: XLS-66 does not take the XRP escrow as collateral and does not sell it.
//
//   node bot/escrow-bot.js condition --out <file outside the repo>
//        make a 32-byte preimage, save {condition, fulfillment} to that file (mode 0600), print the Condition only
//   node bot/escrow-bot.js status --pool <pool.json>
//        read-only: escrows, live ratio, add/default lines, window state and the four sale steps
//   node bot/escrow-bot.js run --pool <pool.json> [--dry-run] [--secrets <file>] [--loanpay-blob <file>] [--watch <s>] [--max-minutes <m>]
//        1 LoanManage tfLoanImpair once a payment is overdue  2 EscrowFinish every escrow  3 OfferCreate (IOC + sell) XRP for the vault asset
//        4 fund and submit the shop's own signed LoanPay (XLS-66: only Loan.Borrower may LoanPay)  then LoanManage tfLoanDefault for the rest
//        then, once the loan is defaulted or closed, `distribute` (below)
//   node bot/escrow-bot.js distribute --pool <pool.json> [--dry-run] [--secrets <file>]
//        leftover proceeds (not put into the loan by LoanPay) to the pool's lenders, pro rata to their vault MPT shares at the default
//        (or at the LoanPay that closed the loan): a Payment in the vault asset from the broker wallet to each lender. App rule.
//
// Secrets: BROKER_SEED and ESCROW_FULFILLMENT from the environment, or --secrets <json outside the repo, mode 0600> with
// {"brokerSeed": "...", "fulfillment": "..."}. Secrets are never printed or written anywhere else. Mainnet and testnet are refused.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import xrpl from "xrpl";
import * as S from "../src/state.js";
import * as P from "../src/payloads.js";
import * as L from "../src/ledger.js";
import { ESCROW, FLAGS, SPEC } from "../src/config.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NETS = { devnet: { id: 2, ws: "wss://devnet.xrpl-labs.com/", rpc: "https://devnet.xrpl-labs.com/" } }; // mainnet/testnet: refused in this build
const args = process.argv.slice(2), cmd = args[0];
const opt = (k, d = null) => { const i = args.indexOf("--" + k); return i < 0 ? d : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true; };
const DRY = !!opt("dry-run");
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const die = (m) => { console.error("escrow-bot: " + m); process.exit(2); };
const insideRepo = (f) => { const r = path.relative(REPO, path.resolve(f)); return !r.startsWith("..") && !path.isAbsolute(r); };

// ---------- crypto-condition (PREIMAGE-SHA-256, the only type XRPL supports) ----------
// DER: condition = A0 25 80 20 <sha256(preimage)> 81 01 <cost = preimage length>; fulfillment = A0 <len+2> 80 <len> <preimage> (lengths < 128).
const hx = (n) => n.toString(16).padStart(2, "0");
export const conditionOf = (preimage) => ("A0258020" + crypto.createHash("sha256").update(preimage).digest("hex") + "8101" + hx(preimage.length)).toUpperCase();
export const fulfillmentOf = (preimage) => ("A0" + hx(preimage.length + 2) + "80" + hx(preimage.length) + preimage.toString("hex")).toUpperCase();
export const conditionFromFulfillment = (ful) => { if (!/^A0228020[0-9A-F]{64}$/i.test(ful)) throw new Error("bad fulfillment"); return conditionOf(Buffer.from(ful.slice(8), "hex")); };

function loadSecrets(needed) {
  let brokerSeed = process.env.BROKER_SEED || null, fulfillment = process.env.ESCROW_FULFILLMENT || null;
  const file = opt("secrets");
  if (file) {
    if (insideRepo(file)) die("refusing a secrets file inside the repo; keep it outside " + REPO);
    const st = fs.statSync(file); if (st.mode & 0o077) die("secrets file must be mode 0600 (chmod 600)");
    const j = JSON.parse(fs.readFileSync(file, "utf8")); brokerSeed = j.brokerSeed || brokerSeed; fulfillment = j.fulfillment || fulfillment;
  }
  if (needed && !brokerSeed) die("no broker seed: set BROKER_SEED or pass --secrets <file>");
  return { wallet: brokerSeed ? xrpl.Wallet.fromSeed(brokerSeed) : null, fulfillment };
}
function loadPool() {
  const f = opt("pool"); if (!f || f === true) die("--pool <pool.json> required");
  const p = JSON.parse(fs.readFileSync(f, "utf8")); if (!NETS[p.network]) die(`network ${p.network} refused: this build runs the bot on devnet only (mainnet is hard-off)`);
  for (const k of ["LoanID", "LoanBrokerID", "VaultID"]) if (!/^[0-9A-F]{64}$/.test(p[k] || "")) die(`pool ${k} missing`);
  if (!S.isCondition(p.condition)) die("pool condition missing or malformed");
  const w = { ...ESCROW, ...(p.windows || {}) }; const stateFile = opt("state") || f.replace(/\.json$/, "") + ".state.json";
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { belowAddSince: null, saleStartedAt: null, finishedDrops: 0, soldDrops: 0, proceeds: 0, delivered: 0, log: [] };
  return { p, w, stateFile, state, save: () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)) };
}
async function connect(net) {
  const c = new xrpl.Client(NETS[net].ws, { connectionTimeout: 30000, timeout: 60000 }); await c.connect();
  const nid = (await c.request({ command: "server_info" })).result.info.network_id;
  if (nid !== NETS[net].id) { await c.disconnect(); die(`server network_id ${nid} is not ${net}`); }
  return c;
}
const node = async (c, req) => { try { return (await c.request({ command: "ledger_entry", ...req, ledger_index: "validated" })).result.node; } catch (e) { if (/entryNotFound|objectNotFound/.test(e?.data?.error || e.message)) return null; throw e; } };
const ceil6 = (x) => Math.ceil(Number(x) * 1e6 - 1e-6) / 1e6;

// Read everything the decision needs (validated ledger only).
async function readAll(c, p, w) {
  const lg = (await c.request({ command: "ledger", ledger_index: "validated" })).result.ledger, now = lg.close_time;
  const [loan, broker, vault] = [await node(c, { index: p.LoanID }), await node(c, { index: p.LoanBrokerID }), await node(c, { index: p.VaultID })];
  if (!broker || !vault) throw new Error("LoanBroker or Vault not found");
  const quote = { currency: vault.Asset.currency, issuer: vault.Asset.issuer };
  const exp = { owner: p.shop, destination: broker.Owner, condition: p.condition, cancelAfterMin: vault.RedemptionDate + w.CANCEL_AFTER_MARGIN_SECONDS };
  const escrows = []; for (const e of p.escrows) escrows.push({ ...e, node: await node(c, { escrow: { owner: e.owner, seq: e.seq } }) });
  const set = S.escrowSet(escrows, exp);
  const mk = await L.marketDepth(p.network, globalThis.fetch, { rpc: NETS[p.network].rpc, quote, label: "vault asset vs XRP", unit: "" });
  const market = { pool: S.ammPool(mk.amm, quote), levels: S.bookLevels(mk.offers) };
  const owed = loan && loan.PaymentRemaining > 0 ? S.owedAfterCover({ ...loan, DebtTotal: broker.DebtTotal, CoverAvailable: broker.CoverAvailable, CoverRateMinimum: broker.CoverRateMinimum, CoverRateLiquidation: broker.CoverRateLiquidation }) : null;
  const q = S.sellQuote({ ...market, xrp: set.drops / S.DROPS });
  const ratio = owed ? (market.pool || market.levels.length ? S.escrowRatioPct(q.best, owed.net) : null) : null;
  return { now, ledger: lg.ledger_index, loan, broker, vault, quote, exp, escrows, set, market, owed, q, ratio };
}
function printStatus(r, m, plan) {
  say(`ledger ${r.ledger}, close time ${r.now}`);
  say(`escrows: ${r.set.verified} verified of ${r.escrows.length}, ${r.set.drops / S.DROPS} XRP`, r.set.rows.filter((x) => !x.ok).map((x) => `seq ${x.seq}: ${x.problems.join("; ")}`).join(" | "));
  say(`market: ${r.market.pool ? `AMM ${r.market.pool.xrp} XRP / ${r.market.pool.quote} (fee ${r.market.pool.fee * 100}%)` : "no AMM"}, ${r.market.levels.length} book levels; quote ${r.q.best.toFixed(6)} via ${r.q.source}`);
  say(r.owed ? `owed after cover ${r.owed.net.toFixed(6)} (DefaultAmount ${r.owed.DefaultAmount} − cover payable ${r.owed.coverPayable.toFixed(6)}); ratio ${r.ratio == null ? "n/a" : r.ratio.toFixed(2) + "%"}` : "no open loan balance");
  say(`margin: ${m.state} (${m.label}); plan: ${plan.why}`);
}
async function submit(c, wallet, tx, st, label, save) {
  const prepared = await c.autofill({ ...tx, Account: wallet.address }); prepared.LastLedgerSequence += 20;
  const signed = wallet.sign(prepared); st.log.push({ at: new Date().toISOString(), label, hash: signed.hash, pending: true }); save(); // persist before submit
  let res; try { res = await c.submitAndWait(signed.tx_blob); } catch (e) { const t = await c.request({ command: "tx", transaction: signed.hash }).catch(() => null); if (t?.result?.validated) res = t; else throw e; }
  const code = (res.result.meta || res.result.metaData).TransactionResult; Object.assign(st.log[st.log.length - 1], { pending: false, result: code }); save();
  say(`${code === "tesSUCCESS" ? "OK" : "!!"} ${label}: ${code} ${signed.hash}`); return { hash: signed.hash, code, fee: Number(prepared.Fee), meta: res.result.meta || res.result.metaData };
}
async function submitBlob(c, blob, st, label, save) {
  const hash = xrpl.hashes.hashSignedTx(blob); st.log.push({ at: new Date().toISOString(), label, hash, pending: true }); save();
  let res; try { res = await c.submitAndWait(blob); } catch (e) { const t = await c.request({ command: "tx", transaction: hash }).catch(() => null); if (t?.result?.validated) res = t; else throw e; }
  const code = (res.result.meta || res.result.metaData).TransactionResult; Object.assign(st.log[st.log.length - 1], { pending: false, result: code }); save();
  say(`${code === "tesSUCCESS" ? "OK" : "!!"} ${label}: ${code} ${hash}`); return { hash, code, meta: res.result.meta || res.result.metaData };
}
// Amount LoanPay needs now (XLS-66 A-3.2: late = periodic + service + late fee + late interest; one installment per late LoanPay; final = TotalValueOutstanding).
export function dueNow(loan, now) {
  const late = now > loan.NextPaymentDueDate; let due = Number(loan.PeriodicPayment) + (Number(loan.LoanServiceFee) || 0);
  if (loan.PaymentRemaining === 1) due = Math.max(due, Number(loan.TotalValueOutstanding));
  if (late) due += (Number(loan.LatePaymentFee) || 0) + Number(loan.PrincipalOutstanding) * ((Number(loan.LateInterestRate) || 0) / SPEC.TENTH_BPS_100PCT) * ((now - loan.NextPaymentDueDate) / SPEC.SECONDS_PER_YEAR);
  return { late, due: ceil6(due) };
}

async function once(c, ctx, secrets) {
  const { p, w, state, save } = ctx;
  const r = await readAll(c, p, w);
  state.belowAddSince = r.ratio == null ? state.belowAddSince : S.nextBelowSince(r.ratio, state.belowAddSince, r.now, w.ADD_LINE_PCT); save();
  const m = S.marginState({ ratio: r.ratio, belowAddSince: state.belowAddSince, now: r.now, windowSec: w.ADD_WINDOW_SECONDS, add: w.ADD_LINE_PCT, def: w.DEFAULT_LINE_PCT });
  const plan = S.botPlan({ loan: r.loan, margin: m, now: r.now });
  printStatus(r, m, plan);
  const wallet = secrets.wallet; if (wallet && wallet.address !== r.broker.Owner) die("the broker seed does not match LoanBroker.Owner");
  const act = async (label, tx) => { if (DRY) { say(`[dry-run] would submit ${label}:`, JSON.stringify(tx)); return { code: "dry-run" }; } return submit(c, wallet, tx, state, label, save); };
  if (!r.loan) return { done: true, why: "Loan not on the ledger" };
  // Step 1: mark.
  if (plan.mark) await act("1 LoanManage tfLoanImpair", P.loanManage({ LoanID: p.LoanID, action: "impair" }));
  if (!plan.sell && !state.saleStartedAt) return { done: false, why: plan.why };
  if (!state.saleStartedAt && !DRY) { state.saleStartedAt = r.now; save(); }
  const saleEnds = (state.saleStartedAt ?? r.now) + w.SALE_WINDOW_SECONDS;
  // Step 2: finish every verified escrow still open.
  if (!DRY && !secrets.fulfillment) die("no fulfillment: set ESCROW_FULFILLMENT or pass --secrets");
  if (secrets.fulfillment && conditionFromFulfillment(secrets.fulfillment) !== p.condition.toUpperCase()) die("the fulfillment does not match the pool's Condition");
  let openLeft = 0;
  for (const row of r.set.rows) {
    const e = r.escrows.find((x) => x.seq === row.seq && x.owner === row.owner);
    if (!e.node) continue; if (!row.ok) { say(`skip escrow ${row.seq}: ${row.problems.join("; ")}`); continue; }
    const res = await act(`2 EscrowFinish ${row.owner}/${row.seq}`, P.escrowFinish({ Owner: row.owner, OfferSequence: row.seq, Condition: p.condition, Fulfillment: secrets.fulfillment || "A0228020" + "0".repeat(64) }));
    if (res.code === "tesSUCCESS") { state.finishedDrops += row.drops; save(); } else openLeft++;
  }
  // Step 3: sell what the escrows delivered (never the broker's own XRP).
  const toSell = state.finishedDrops - state.soldDrops;
  if (toSell > 0) {
    const q = S.sellQuote({ ...r.market, xrp: toSell / S.DROPS });
    if (q.noMarket || !(q.best > 0)) say("3 sell: no market (no AMM, empty book); step stuck");
    else {
      const minQuote = q.best * (1 - w.SELL_MAX_SLIPPAGE_PCT / 100);
      const res = await act(`3 OfferCreate sell ${toSell / S.DROPS} XRP (quote ${q.best.toFixed(6)} via ${q.source}, limit ${minQuote.toFixed(6)})`, P.offerSellXrp({ xrpDrops: toSell, quote: r.quote, minQuote }));
      if (res.code === "tesSUCCESS") { const sold = -L.balanceDelta(res.meta, wallet.address, "XRP") - res.fee; const got = L.balanceDelta(res.meta, wallet.address, r.quote);
        state.soldDrops += Math.min(toSell, Math.max(0, sold)); state.proceeds += got; save(); say(`sold ${sold / S.DROPS} XRP, received ${got} of the vault asset`); }
    }
  }
  // Step 4: deliver with the shop's own signed LoanPay, funded by the broker right before submission.
  const loan = await node(c, { index: p.LoanID }); const left = state.proceeds - state.delivered;
  if (loan && loan.PaymentRemaining > 0 && !(loan.Flags & FLAGS.lsfLoanDefault) && left > 0) {
    const { late, due } = dueNow(loan, r.now); const blobFile = opt("loanpay-blob");
    if (left < due) say(`4 LoanPay: proceeds left ${left} are below one installment ${due}; LoanPay takes no partial payment, so this part is a shortfall`);
    else if (!blobFile || blobFile === true || !fs.existsSync(blobFile)) say(`4 LoanPay: waiting for the shop's signed LoanPay of at least ${due}${late ? " with tfLoanLatePayment" : ""} (XLS-66: only Loan.Borrower may LoanPay)`);
    else {
      const blob = fs.readFileSync(blobFile, "utf8").trim(), tx = xrpl.decode(blob);
      const amt = Number(tx.Amount?.value);
      const bad = tx.TransactionType !== "LoanPay" ? "not a LoanPay" : tx.Account !== loan.Borrower ? "not signed by Loan.Borrower" : tx.LoanID !== p.LoanID ? "wrong LoanID"
        : tx.Amount?.currency !== r.quote.currency || tx.Amount?.issuer !== r.quote.issuer ? "wrong asset" : !(amt >= due) ? `amount ${amt} below the ${due} due` : amt > left + 1e-9 ? `amount ${amt} above the proceeds left ${left}` : late && !(Number(tx.Flags) & FLAGS.tfLoanLatePayment) ? "late payment without tfLoanLatePayment" : null;
      if (bad) say(`4 LoanPay blob refused: ${bad}`);
      else if (DRY) say(`[dry-run] would send ${amt} to the shop and submit its signed LoanPay`);
      else {
        const pay = await submit(c, wallet, { TransactionType: "Payment", Destination: loan.Borrower, Amount: { ...r.quote, value: tx.Amount.value } }, state, `4a Payment ${amt} to the shop for its LoanPay`, save);
        if (pay.code === "tesSUCCESS") { const lp = await submitBlob(c, blob, state, `4b LoanPay ${amt} (shop-signed${late ? ", tfLoanLatePayment" : ""})`, save); if (lp.code === "tesSUCCESS") { state.delivered += amt; save(); } }
      }
    }
  }
  // Default the rest when the ledger allows it and nothing more can be delivered (or the sale window is over).
  const l2 = await node(c, { index: p.LoanID });
  if (l2 && l2.PaymentRemaining > 0 && !(l2.Flags & FLAGS.lsfLoanDefault)) {
    // Wait while escrows are still open, finished XRP is unsold, or proceeds can still pay an installment, unless the sale window is over.
    const g = S.defaultGate(l2, r.now), more = openLeft > 0 || state.finishedDrops > state.soldDrops + 1000 || state.proceeds - state.delivered >= dueNow(l2, r.now).due;
    if (g.ok && (!more || r.now > saleEnds)) { await act("LoanManage tfLoanDefault (remaining shortfall)", P.loanManage({ LoanID: p.LoanID, action: "default" })); return { done: !DRY, why: "defaulted" }; }
    return { done: false, why: g.ok ? (openLeft ? "escrows still open" : "XRP or proceeds left to deliver") : `default not allowed yet (${g.reason})` };
  }
  return { done: true, why: l2 ? (l2.Flags & FLAGS.lsfLoanDefault ? "defaulted" : "settled") : "loan gone" };
}

async function status() {
  const ctx = loadPool(); const c = await connect(ctx.p.network);
  try { const r = await readAll(c, ctx.p, ctx.w); const m = S.marginState({ ratio: r.ratio, belowAddSince: ctx.state.belowAddSince, now: r.now, windowSec: ctx.w.ADD_WINDOW_SECONDS, add: ctx.w.ADD_LINE_PCT, def: ctx.w.DEFAULT_LINE_PCT });
    printStatus(r, m, S.botPlan({ loan: r.loan, margin: m, now: r.now }));
    const si = await L.saleInputs(ctx.p.network, { LoanID: ctx.p.LoanID, broker: r.broker.Owner, shop: ctx.p.shop, escrows: ctx.p.escrows, quote: r.quote });
    const st = S.saleSteps({ ...si, now: r.now, overdue: !!(r.loan && r.loan.PaymentRemaining > 0 && r.now > r.loan.NextPaymentDueDate), nextDue: r.loan && r.loan.PaymentRemaining > 0 ? dueNow(r.loan, r.now).due : null,
      saleEnds: ctx.state.saleStartedAt ? ctx.state.saleStartedAt + ctx.w.SALE_WINDOW_SECONDS : null });
    for (const s of st.steps) say(`step ${s.n} ${s.name}: ${s.status} (${s.detail})`, s.txs.join(" "));
    say(`proceeds ${st.proceeds}, paid by LoanPay ${st.paid}, undelivered ${st.undelivered}, written down ${st.shortfall ?? "n/a"}`);
    return st;
  } finally { await c.disconnect(); }
}
async function run() {
  const ctx = loadPool(), secrets = loadSecrets(!DRY), c = await connect(ctx.p.network);
  const watch = Number(opt("watch", 0)) || 0, until = Date.now() + (Number(opt("max-minutes", 30)) || 30) * 60000;
  try { let r; for (;;) { r = await once(c, ctx, secrets); say("->", r.why); if (r.done || !watch || DRY || Date.now() > until) break; await new Promise((res) => setTimeout(res, watch * 1000)); }
    if (r?.done && /defaulted|settled|loan gone/.test(r.why)) { say("loan defaulted or closed: distributing any leftover to the lenders, pro rata"); await distributeOnce(ctx, secrets, c); } }
  finally { await c.disconnect(); }
}
// Leftover proceeds to the pool's lenders, pro rata to their vault MPT shares at the snapshot (the default, or the LoanPay that closed
// the loan). App rule the broker promises: a direct Payment in the vault asset from the broker wallet, outside the vault and the loan.
// Amounts are floored to 0.000001; the rounding remainder goes to the largest holder. A holder with no trust line for the asset cannot
// receive: its amount stays recorded as owed. Each Payment carries the memo "duckbank/leftover" + LoanID so the app can show it.
async function distributeOnce(ctx, secrets, c) {
  const { p, state, save } = ctx;
  const broker = await node(c, { index: p.LoanBrokerID }); const vault = await node(c, { index: p.VaultID });
  if (!vault) throw new Error("Vault not found (needed for the share snapshot)");
  const brokerAcct = broker ? broker.Owner : secrets.wallet?.address; if (!brokerAcct) die("broker account unknown: the LoanBroker is gone, pass the broker seed");
  if (secrets.wallet && secrets.wallet.address !== brokerAcct) die("the broker seed does not match LoanBroker.Owner");
  const quote = { currency: vault.Asset.currency, issuer: vault.Asset.issuer };
  const x = await L.saleInputs(p.network, { LoanID: p.LoanID, broker: brokerAcct, shop: p.shop, escrows: p.escrows, quote });
  const st = S.saleSteps({ ...x, now: 0 });
  if (!st.leftoverFixed || !x.fixedAt) { say("leftover not fixed yet: the loan is neither defaulted nor closed; nothing to distribute"); return { done: false }; }
  say(`leftover ${st.leftover.toFixed(6)} = proceeds ${st.proceeds.toFixed(6)} − LoanPay ${st.paid.toFixed(6)}; snapshot at ledger ${x.fixedAt.ledger} (${x.fixedAt.by} ${x.fixedAt.hash})`);
  const snap = await L.shareSnapshot(p.network, { VaultID: p.VaultID, at: x.fixedAt });
  const split = S.proRata(st.leftover, snap.holders);
  say(`share holders (${snap.source}): ${snap.holders.map((h) => `${h.account} ${h.shares}`).join(", ") || "none"}; dust ${split.dust} to ${split.dustTo || "n/a"}`);
  if (!split.payouts.length) { say(`no share holders at the snapshot: ${split.unassigned} stays recorded with the broker`); state.leftover = { split, snapshot: { source: snap.source, at: x.fixedAt }, rows: [] }; save(); return { done: true }; }
  const lines = {}; for (const r of split.payouts) lines[r.account] = await L.hasLine(p.network, r.account, quote);
  let status = S.leftoverStatus(split, { paid: x.leftoverPays, lines, self: brokerAcct });
  const due = status.rows.filter((r) => r.owed > 0 && r.status === "owed"), need = due.reduce((t, r) => t + r.owed, 0);
  const have = await L.iouBalance(p.network, brokerAcct, quote).catch(() => null);
  if (have != null && Number(have) + 1e-9 < need) { say(`broker holds ${have} of the vault asset, below the ${need.toFixed(6)} to pay; stopping`); return { done: false }; }
  for (const r of due) {
    const tx = { TransactionType: "Payment", Destination: r.account, Amount: { ...quote, value: String(+r.owed.toFixed(6)) }, Memos: [L.leftoverMemo(p.LoanID)] };
    if (DRY) { say(`[dry-run] would pay ${r.owed} to ${r.account} (${r.pct}% of the shares):`, JSON.stringify(tx)); continue; }
    const res = await submit(c, secrets.wallet, tx, state, `leftover ${r.owed} to ${r.account} (${r.pct}% of the shares)`, save);
    if (res.code !== "tesSUCCESS") say(`payment to ${r.account} failed ${res.code}: the amount stays recorded as owed`);
  }
  for (const r of status.rows.filter((r) => r.status === "owed: no trust line")) say(`owed ${r.owed} to ${r.account}: no trust line for the vault asset, so it stays recorded as owed`);
  if (!DRY) { const y = await L.saleInputs(p.network, { LoanID: p.LoanID, broker: brokerAcct, shop: p.shop, escrows: p.escrows, quote }); status = S.leftoverStatus(split, { paid: y.leftoverPays, lines, self: brokerAcct }); }
  state.leftover = { split: { ...split, payouts: split.payouts }, snapshot: { source: snap.source, at: x.fixedAt }, rows: status.rows }; save();
  for (const r of status.rows) say(`lender ${r.account}: ${r.amount} → ${r.status}${r.hashes.length ? " " + r.hashes.join(" ") : ""}`);
  return { done: true };
}
async function distribute() {
  const ctx = loadPool(), secrets = loadSecrets(!DRY), c = await connect(ctx.p.network);
  try { await distributeOnce(ctx, secrets, c); } finally { await c.disconnect(); }
}
function condition() {
  const out = opt("out"); if (!out || out === true) die("--out <file outside the repo> required"); if (insideRepo(out)) die("refusing to write the fulfillment inside the repo");
  if (fs.existsSync(out)) die("file exists; refusing to overwrite a fulfillment");
  const pre = crypto.randomBytes(ESCROW.PREIMAGE_BYTES), condition = conditionOf(pre);
  fs.writeFileSync(out, JSON.stringify({ condition, fulfillment: fulfillmentOf(pre) }, null, 2), { mode: 0o600 });
  console.log(condition);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const f = { condition, status, run, distribute }[cmd]; if (!f) die("usage: condition --out <file> | status --pool <file> | run --pool <file> [--dry-run] [--secrets <file>] [--loanpay-blob <file>] [--watch <s>] | distribute --pool <file> [--dry-run] [--secrets <file>]");
  Promise.resolve(f()).catch((e) => die(e?.data?.error || e.message));
}
