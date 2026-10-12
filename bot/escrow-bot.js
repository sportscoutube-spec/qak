#!/usr/bin/env node
// Duck Bank escrow bot, broker side. It holds the broker key and the escrow fulfillment, so it runs only here in Node, never in the browser.
// Every step it takes is an app step: XLS-66 does not take the XRP escrow as collateral and does not sell it.
//
//   node bot/escrow-bot.js condition --out <file outside the repo>
//        make a 32-byte preimage, save {condition, fulfillment} to that file (mode 0600), print the Condition only
//   node bot/escrow-bot.js status --pool <pool.json>
//        read-only: escrows, live ratio, add/default lines, window state and the four sale steps
//   node bot/escrow-bot.js run --pool <pool.json> [--dry-run] [--secrets <file>] [--loanpay-blob <file>] [--watch <s>] [--max-minutes <m>]
//        1 LoanManage tfLoanImpair once a payment is overdue (its own tx: Loan* cannot be a Batch inner tx)
//        2+3 one XLS-56 Batch, ALLORNOTHING: EscrowFinish every escrow + OfferCreate (fill-or-kill + sell, limit = quote − 3%) + Payment of the
//            shop's presigned LoanPay amount to the shop when that amount is covered by the guaranteed minimum output (all or none apply)
//        4 submit the shop's own presigned LoanPay (XLS-66: only Loan.Borrower may LoanPay)  then LoanManage tfLoanDefault for the rest
//        then, once the loan is defaulted or closed, `distribute` (below)
//   node bot/escrow-bot.js distribute --pool <pool.json> [--dry-run] [--secrets <file>]
//        leftover proceeds (not put into the loan by LoanPay) to the pool's lenders, pro rata to their vault MPT shares at the default
//        (or at the LoanPay that closed the loan): a Payment in the vault asset from the broker wallet to each lender, sent in XLS-56
//        Batches of up to 8 Payments (INDEPENDENT mode), skipping any lender already paid (memo duckbank/leftover + LoanID). App rule.
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
import * as B from "./batch.js";

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
  // JSON-RPC over HTTP for every request (public devnet websockets stall now and then), with a timeout and retries on network errors;
  // ledger errors (status "error") pass through unchanged.
  const RPC_URL = NETS[net].rpc; const orig = c.request.bind(c); c.request = async (r) => { const { command, ...rest } = r; let last;
    for (let i = 0; i < 8; i++) { try { const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: command, params: [{ api_version: 2, ...rest }] }), signal: AbortSignal.timeout(20000) });
        const j = await res.json(); if (j.result?.status === "error" || j.result?.error) { const e = new Error(j.result.error_message || j.result.error); e.data = j.result; throw e; } return { result: j.result }; }
      catch (e) { if (e.data) throw e; last = e; await new Promise((s) => setTimeout(s, 3000)); } } throw last; };
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

// Plan the atomic sell leg (pure, tested). rows: verified open escrows [{owner, seq, drops}]; unsoldDrops: XRP already finished but not sold.
// Batch limit (XLS-56 §2.1.2): 2..8 inner txs. Slots: 1 OfferCreate, 1 Payment to the shop when included, the rest EscrowFinish. Escrows that
// do not fit are finished first in their own txs/batches (`pre`), and their XRP is sold in the main Batch.
// Payment amount: an ALLORNOTHING Batch can only carry fixed amounts, and the sale output is not known in advance. The OfferCreate is
// fill-or-kill + sell, so it either sells all the XRP at or above the limit price (output >= TakerPays = minOut) or is killed, and the whole
// Batch with it. The Payment therefore carries the shop's presigned LoanPay amount only when that amount <= minOut; any output above it stays
// with the broker (it is leftover for the lenders, never sent to the shop). If minOut is below the LoanPay amount, the Batch carries no
// Payment, and the Payment + LoanPay follow only if the actual output covers them (not atomic; logged).
export function planSaleBatch({ rows, unsoldDrops = 0, quoteFor, quote, slippagePct, loanPayAmount = null, condition, fulfillment }) {
  const maxFin = B.MAX_INNER - 1 - (loanPayAmount ? 1 : 0); const inBatch = rows.slice(0, maxFin), pre = rows.slice(maxFin);
  const finish = (r) => P.escrowFinish({ Owner: r.owner, OfferSequence: r.seq, Condition: condition, Fulfillment: fulfillment });
  const drops = unsoldDrops + rows.reduce((t, r) => t + r.drops, 0); if (!(drops > 0)) return { none: "no XRP to sell" };
  const q = quoteFor(drops / S.DROPS); if (q.noMarket || !(q.best > 0)) return { none: "no market (no AMM, empty book)" };
  const minOut = Math.floor(q.best * (1 - slippagePct / 100) * 1e6) / 1e6; if (!(minOut > 0)) return { none: "minimum output rounds to 0" };
  const offer = P.offerSellXrp({ xrpDrops: drops, quote, minQuote: minOut, fillOrKill: true });
  const pay = loanPayAmount && loanPayAmount <= minOut + 1e-9 ? loanPayAmount : null;
  const items = [...inBatch.map((r) => ({ tx: finish(r), row: r })), { tx: offer }];
  if (pay) items.push({ tx: { TransactionType: "Payment", Destination: null, Amount: { ...quote, value: P.value(pay) } }, shopPay: true });
  return { pre: pre.map((r) => ({ tx: finish(r), row: r })), items, drops, quote: q.best, source: q.source, minOut, pay,
    why: pay ? `Payment ${pay} (the presigned LoanPay amount) <= guaranteed minimum ${minOut}` : loanPayAmount ? `LoanPay amount ${loanPayAmount} above the guaranteed minimum ${minOut}: no Payment in the Batch` : "no presigned LoanPay yet: no Payment in the Batch" };
}
// Check the shop's presigned LoanPay blob against the Loan (does not check that proceeds cover it).
export function checkLoanPayBlob(tx, { loan, LoanID, quote, due, late }) {
  const amt = Number(tx.Amount?.value);
  return tx.TransactionType !== "LoanPay" ? "not a LoanPay" : tx.Account !== loan.Borrower ? "not signed by Loan.Borrower" : tx.LoanID !== LoanID ? "wrong LoanID"
    : tx.Amount?.currency !== quote.currency || tx.Amount?.issuer !== quote.issuer ? "wrong asset" : !(amt >= due) ? `amount ${amt} below the ${due} due` : late && !(Number(tx.Flags) & FLAGS.tfLoanLatePayment) ? "late payment without tfLoanLatePayment" : null;
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
  // Steps 2+3 (+ the Payment to the shop): one ALLORNOTHING Batch.
  if (!DRY && !secrets.fulfillment) die("no fulfillment: set ESCROW_FULFILLMENT or pass --secrets");
  if (secrets.fulfillment && conditionFromFulfillment(secrets.fulfillment) !== p.condition.toUpperCase()) die("the fulfillment does not match the pool's Condition");
  const ful = secrets.fulfillment || "A0228020" + "0".repeat(64);
  const recordB = (e) => { if (!state.log.includes(e)) state.log.push(e); save(); };
  let openLeft = 0; const rows = [];
  for (const row of r.set.rows) { const e = r.escrows.find((x) => x.seq === row.seq && x.owner === row.owner); if (!e.node) continue; if (!row.ok) { say(`skip escrow ${row.seq}: ${row.problems.join("; ")}`); openLeft++; continue; } rows.push(row); }
  // The shop's presigned LoanPay (read now, so its amount can ride in the Batch).
  const loan0 = await node(c, { index: p.LoanID }); let lp = null; const blobFile = opt("loanpay-blob");
  if (loan0 && loan0.PaymentRemaining > 0 && !(loan0.Flags & FLAGS.lsfLoanDefault)) {
    const { late, due } = dueNow(loan0, r.now);
    if (blobFile && blobFile !== true && fs.existsSync(blobFile)) { const blob = fs.readFileSync(blobFile, "utf8").trim(), tx = xrpl.decode(blob), hash = xrpl.hashes.hashSignedTx(blob);
      const bad = checkLoanPayBlob(tx, { loan: loan0, LoanID: p.LoanID, quote: r.quote, due, late });
      if (bad) say(`4 LoanPay blob refused: ${bad}`); else if (!(state.loanPays || []).includes(hash)) lp = { blob, hash, amt: Number(tx.Amount.value), late, due }; }
    else if (blobFile && rows.length && r.now < saleEnds - w.SALE_WINDOW_SECONDS / 2) return { done: false, why: `waiting for the shop's presigned LoanPay (at least ${due}) so its funding can ride in the Batch` };
  }
  const unsold = state.finishedDrops - state.soldDrops;
  if (rows.length || unsold > 0) {
    const plan2 = planSaleBatch({ rows, unsoldDrops: unsold > 1000 ? unsold : 0, quoteFor: (xrp) => S.sellQuote({ ...r.market, xrp }), quote: r.quote, slippagePct: w.SELL_MAX_SLIPPAGE_PCT,
      loanPayAmount: lp && !(state.funded || []).includes(lp.hash) ? lp.amt : null, condition: p.condition, fulfillment: ful });
    if (plan2.none) { say(`2+3 sell: ${plan2.none}; step stuck`); openLeft += rows.length; }
    else {
      for (const it of plan2.items) if (it.shopPay) it.tx.Destination = loan0.Borrower;
      say(`2+3 plan: ${plan2.items.length} inner txs, sell ${plan2.drops / S.DROPS} XRP (quote ${plan2.quote.toFixed(6)} via ${plan2.source}, minimum ${plan2.minOut}); ${plan2.why}${plan2.pre.length ? `; ${plan2.pre.length} escrow(s) beyond the 8-tx limit are finished first` : ""}`);
      if (DRY) say("[dry-run] would submit Batch ALLORNOTHING:", JSON.stringify(plan2.items.map((x) => x.tx)));
      else {
        // Escrows beyond the 8-tx limit: finish them first (INDEPENDENT batches of up to 8, or a single tx), then sell everything in the main Batch.
        for (const grp of B.chunk(plan2.pre, B.MAX_INNER)) {
          if (grp.length === 1) { const res = await submit(c, wallet, grp[0].tx, state, `2 EscrowFinish ${grp[0].row.owner}/${grp[0].row.seq} (beyond the Batch limit)`, save); if (res.code === "tesSUCCESS") { state.finishedDrops += grp[0].row.drops; save(); } continue; }
          const res = await B.submitBatch(c, wallet, { mode: "INDEPENDENT", items: grp.map((x) => ({ tx: x.tx })), record: recordB, label: `2 Batch INDEPENDENT: EscrowFinish ×${grp.length} (beyond the main Batch's limit)` });
          grp.forEach((x, i) => { if (res.inners[i].ok) state.finishedDrops += x.row.drops; }); save(); say(`${res.check.ok ? "OK" : "!!"} pre-finish Batch ${res.hash} ${res.check.problems.join("; ")}`);
        }
        const res = await B.submitBatch(c, wallet, { mode: "ALLORNOTHING", items: plan2.items.map((x) => ({ tx: x.tx })), record: recordB, label: `2+3 Batch ALLORNOTHING: EscrowFinish ×${plan2.items.filter((x) => x.row).length} + OfferCreate FoK (min ${plan2.minOut})${plan2.pay ? ` + Payment ${plan2.pay} to the shop` : ""}` });
        say(`${res.check.ok ? "OK" : "!!"} 2+3 Batch ${res.hash}: outer ${res.result}; inner ${res.check.rows.map((x, i) => `${plan2.items[i].tx.TransactionType} ${x.hash} ${x.result ?? "not applied"}`).join(", ")}`);
        if (res.check.problems.length) say("   batch problems:", res.check.problems.join("; "));
        if (res.check.ok) {
          plan2.items.forEach((x) => { if (x.row) state.finishedDrops += x.row.drops; });
          const off = res.inners[plan2.items.findIndex((x) => x.tx.TransactionType === "OfferCreate")];
          const sold = -L.balanceDelta(off.meta, wallet.address, "XRP"), got = L.balanceDelta(off.meta, wallet.address, r.quote);
          state.soldDrops += Math.max(0, sold); state.proceeds += got;
          if (plan2.pay) { (state.funded ||= []).push(lp.hash); state.shopFunded = (state.shopFunded || 0) + plan2.pay; }
          save(); say(`sold ${sold / S.DROPS} XRP for ${got} (guaranteed minimum ${plan2.minOut})${plan2.pay ? `, paid ${plan2.pay} to the shop in the same Batch` : ""}`);
        } else { openLeft += rows.length; say("the Batch applied nothing (ALLORNOTHING); it is retried on the next pass with a fresh quote"); }
      }
    }
  }
  // Step 4: the shop's presigned LoanPay. If its funding was not in the Batch (amount above the guaranteed minimum), fund it now from the
  // actual proceeds when they cover it (two separate txs, not atomic).
  if (lp && !DRY) {
    const left = state.proceeds - state.delivered; let funded = (state.funded || []).includes(lp.hash);
    if (!funded && left + 1e-9 >= lp.amt) { const pay = await submit(c, wallet, { TransactionType: "Payment", Destination: loan0.Borrower, Amount: { ...r.quote, value: P.value(lp.amt) } }, state, `4a Payment ${lp.amt} to the shop (outside the Batch: amount above the guaranteed minimum)`, save);
      if (pay.code === "tesSUCCESS") { (state.funded ||= []).push(lp.hash); funded = true; save(); } }
    else if (!funded) say(`4 LoanPay: proceeds left ${left} are below the presigned ${lp.amt}; LoanPay takes no partial payment, so this part is a shortfall`);
    if (funded) { const res = await submitBlob(c, lp.blob, state, `4 LoanPay ${lp.amt} (shop-presigned${lp.late ? ", tfLoanLatePayment" : ""})`, save);
      (state.loanPays ||= []).push(lp.hash); if (res.code === "tesSUCCESS") state.delivered += lp.amt; save(); }
  } else if (lp && DRY) say(`[dry-run] would submit the shop's presigned LoanPay ${lp.amt}`);
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
  // Leftover Payments in XLS-56 Batches of up to 8, INDEPENDENT mode: each lender's Payment stands alone, so one lender that cannot receive
  // (frozen line, removed line) does not block the others; failures stay "owed" and are retried. Idempotent: before each chunk the bot
  // re-reads the ledger for memo-tagged (duckbank/leftover + LoanID) Payments to each lender and pays only what is still owed; a Batch still
  // pending from an earlier pass (not validated, LastLedgerSequence not passed) blocks a new one.
  const pendingB = state.log.filter((e) => e.type === "Batch" && e.pending && /^leftover/.test(e.label));
  if (pendingB.length && !DRY) { const v = (await c.request({ command: "ledger", ledger_index: "validated" })).result.ledger_index;
    if (pendingB.some((e) => v <= e.lastLedgerSequence)) { say("an earlier leftover Batch may still validate; waiting before paying again"); return { done: false }; } pendingB.forEach((e) => (e.pending = false)); save(); }
  const payTx = (r) => ({ TransactionType: "Payment", Destination: r.account, Amount: { ...quote, value: P.value(r.owed) }, Memos: [L.leftoverMemo(p.LoanID)] });
  for (const grp of S.leftoverChunks(due.map((r) => r.account), B.MAX_INNER)) {
    if (DRY) { for (const a of grp) { const r = due.find((x) => x.account === a); say(`[dry-run] would pay ${r.owed} to ${a} (${r.pct}% of the shares):`, JSON.stringify(payTx(r))); } continue; }
    const now2 = await L.saleInputs(p.network, { LoanID: p.LoanID, broker: brokerAcct, shop: p.shop, escrows: p.escrows, quote });
    const fresh = S.leftoverStatus(split, { paid: now2.leftoverPays, lines, self: brokerAcct }).rows.filter((r) => grp.includes(r.account) && r.owed > 0 && r.status === "owed");
    for (const a of grp) if (!fresh.some((r) => r.account === a)) say(`lender ${a}: already paid on the ledger (memo duckbank/leftover); skipped`);
    if (!fresh.length) continue;
    if (fresh.length === 1) { const r = fresh[0]; const res = await submit(c, secrets.wallet, payTx(r), state, `leftover ${r.owed} to ${r.account} (${r.pct}% of the shares)`, save); if (res.code !== "tesSUCCESS") say(`payment to ${r.account} failed ${res.code}: the amount stays recorded as owed`); continue; }
    const res = await B.submitBatch(c, secrets.wallet, { mode: "INDEPENDENT", items: fresh.map((r) => ({ tx: payTx(r) })), record: (e) => { if (!state.log.includes(e)) state.log.push(e); save(); },
      label: `leftover Batch INDEPENDENT: ${fresh.map((r) => `${r.owed} to ${r.account}`).join(", ")}` });
    say(`${res.check.ok ? "OK" : "!!"} leftover Batch ${res.hash}: outer ${res.result}; ${res.check.rows.map((x, i) => `${fresh[i].account} ${fresh[i].owed} ${x.hash} ${x.result ?? "not applied"}`).join(", ")}`);
    for (const [i, x] of res.check.rows.entries()) if (!x.ok) say(`payment to ${fresh[i].account} failed (${x.problem}): the amount stays recorded as owed`);
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
