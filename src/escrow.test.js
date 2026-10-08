// XRP escrow path: payload shape, LoanSet gate, ratio math from mocked amm_info/book_offers, lines and window, sale steps, no-XRP cap, phrase bans.
import * as S from "./state.js"; import * as P from "./payloads.js"; import * as L from "./ledger.js";
import { ESCROW as E, NO_XRP, PATHS, FIRST_POOL, RULES, FLAGS, MARKETS } from "./config.js";
import assert from "node:assert"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const ok = (n) => console.log("ok -", n); const near = (a, b, eps = 1e-6) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);
const SHOP = "rBZaALm7Pz1bGq5yvN2nYb9E1S1U6s2d1F", BROKER = "rBRR9DokhcK4TofnNm4dCt8pDVa1cHqo8N", ISS = "rHprdcgDE8VM5PgjPjKGMjZGWGh98V4CHp";
const COND = "A0258020" + "AB".repeat(32) + "810120", Q = { currency: "USD", issuer: ISS };

// Config values (flagged app rules)
assert.equal(E.ADD_LINE_PCT, 150); assert.equal(E.DEFAULT_LINE_PCT, 120); assert(E.ADD_WINDOW_SECONDS > 0 && E.SALE_WINDOW_SECONDS > 0 && E.CANCEL_AFTER_MARGIN_SECONDS > 0);
assert.equal(NO_XRP.MAX_CAP_RLUSD, 1000); assert.equal(FIRST_POOL.path, PATHS.escrow); assert.equal(FIRST_POOL.capRlusd, 10000);
assert.equal(MARKETS.mainnet.quote.currency, "524C555344000000000000000000000000000000"); assert.equal(MARKETS.testnet, null); ok("config: lines 150/120, windows, no-XRP cap 1,000, first pool on the escrow path");

// Escrow payload shape (XRPL Escrow docs: Amount in drops, Destination, PREIMAGE-SHA-256 Condition, CancelAfter, optional FinishAfter < CancelAfter)
{ const tx = P.escrowCreate({ Destination: BROKER, amountXrp: 12.5, Condition: COND, CancelAfter: 900000000, FinishAfter: 800000000 });
  assert.deepEqual(tx, { TransactionType: "EscrowCreate", Amount: "12500000", Destination: BROKER, Condition: COND, CancelAfter: 900000000, FinishAfter: 800000000 });
  assert.equal(P.escrowCreate({ Destination: BROKER, amountXrp: 1, Condition: COND, CancelAfter: 900000000 }).FinishAfter, undefined);
  assert.throws(() => P.escrowCreate({ Destination: BROKER, amountXrp: 1, Condition: COND }), /CancelAfter/);
  assert.throws(() => P.escrowCreate({ Destination: BROKER, amountXrp: 1, Condition: "A0258020" + "AB".repeat(32), CancelAfter: 9e8 }), /Condition/);
  assert.throws(() => P.escrowCreate({ Destination: BROKER, amountXrp: 1, Condition: COND, CancelAfter: 900, FinishAfter: 900 }), /before CancelAfter/);
  assert.throws(() => P.escrowCreate({ Destination: "nope", amountXrp: 1, Condition: COND, CancelAfter: 9e8 }), /Destination/);
  const fin = P.escrowFinish({ Owner: SHOP, OfferSequence: 7, Condition: COND, Fulfillment: "A0228020" + "CD".repeat(32) });
  assert.deepEqual(Object.keys(fin), ["TransactionType", "Owner", "OfferSequence", "Condition", "Fulfillment"]);
  const o = P.offerSellXrp({ xrpDrops: 5_000_000, quote: Q, minQuote: 10 }); assert.equal(o.Flags, 0x00020000 | 0x00080000); assert.equal(o.TakerGets, "5000000"); assert.equal(o.TakerPays.value, "10");
  ok("payloads: EscrowCreate, EscrowFinish, OfferCreate IOC+Sell"); }

// Escrow times fit the windows
{ const t = FIRST_POOL.terms, v = { SubscriptionDate: 1_000_000, RedemptionDate: 1_000_000 + FIRST_POOL.plan.investmentDays * 86400 };
  const x = S.escrowTimes(v, t, v.SubscriptionDate - 3600); assert.equal(x.CancelAfter, v.RedemptionDate + E.CANCEL_AFTER_MARGIN_SECONDS); assert.equal(x.FinishAfter, v.SubscriptionDate + t.PaymentInterval);
  assert.equal(S.escrowTimes(v, t, v.SubscriptionDate + t.PaymentInterval).FinishAfter, undefined);
  const dl = S.appLoanSetDeadline(v, t); assert(dl > v.SubscriptionDate, "deadline after subscription");
  assert(dl + S.loanMaturitySpan(t) + t.GracePeriod + E.SALE_WINDOW_SECONDS <= v.RedemptionDate && v.RedemptionDate < x.CancelAfter, "default handling ends before CancelAfter");
  assert.equal(S.investmentDaysFor(t), FIRST_POOL.plan.investmentDays); ok("escrow times: CancelAfter after RedemptionDate, FinishAfter at the first possible overdue, app LoanSet deadline"); }

// Mocked amm_info / book_offers -> ratio math
const ammRes = { amm: { account: "rAMM", amount: "1000000000", amount2: { ...Q, value: "2000" }, trading_fee: 500 } };
const bookRes = { offers: [{ TakerGets: { ...Q, value: "100" }, TakerPays: "40000000" }, { TakerGets: { ...Q, value: "30" }, TakerPays: "10000000" }, { TakerGets: { ...Q, value: "1" }, TakerPays: "1", taker_gets_funded: { ...Q, value: "0" }, taker_pays_funded: "0" }] };
const fetchMock = (by) => async (url, opt) => { const b = JSON.parse(opt.body); const r = by[b.method]; return { ok: true, json: async () => (r instanceof Error ? { result: { status: "error", error: r.message } } : { result: { status: "success", ledger_index: 9, ...r } }) }; };
{ const d = await L.marketDepth("devnet", fetchMock({ amm_info: ammRes, book_offers: bookRes }), { rpc: "https://x", quote: Q, label: "XRP/DUSD" });
  const pool = S.ammPool(d.amm, Q), levels = S.bookLevels(d.offers); assert.deepEqual(pool, { xrp: 1000, quote: 2000, fee: 0.005 }); assert.equal(levels.length, 2); near(levels[0].price, 3); near(levels[1].price, 2.5);
  near(S.ammOut(pool, 10), 2000 * (1 - 1000 / (1000 + 10 * 0.995)));
  const q = S.sellQuote({ pool, levels, xrp: 60 }); near(q.book, 10 * 3 + 40 * 2.5); assert.equal(q.bookFilled, 50); assert(q.best >= q.amm && q.best >= q.book - 1e-9); assert.equal(q.source, "AMM + order book");
  assert(q.combined > q.amm && q.combined > q.book);
  const owed = S.owedAfterCover({ TotalValueOutstanding: 110, ManagementFeeOutstanding: 1, DebtTotal: 109, CoverAvailable: 50, CoverRateMinimum: 10000, CoverRateLiquidation: 10000 }) // 1/10 bps: 10000 = 10%;
  near(owed.DefaultAmount, 109); near(owed.coverPayable, 109 * 0.1 * 0.1); near(owed.net, 109 - 1.09);
  near(S.escrowRatioPct(q.best, owed.net), q.best / owed.net * 100);
  const need = S.xrpForRatio({ pool, levels }, owed.net, 150); assert(S.sellQuote({ pool, levels, xrp: need }).best >= owed.net * 1.5 - 1e-6); assert(S.sellQuote({ pool, levels, xrp: need - 0.001 }).best < owed.net * 1.5);
  const none = await L.marketDepth("devnet", fetchMock({ amm_info: new Error("actNotFound"), book_offers: { offers: [] } }), { rpc: "https://x", quote: Q });
  assert.equal(S.ammPool(none.amm, Q), null); assert(S.sellQuote({ pool: null, levels: [], xrp: 5 }).noMarket); assert.equal(S.xrpForRatio({ pool: null, levels: [] }, 10), null);
  const fp = S.plannedOwed(FIRST_POOL); near(fp.net, 8499.98, 0.01); near(fp.coverPayable, 1500, 0.01);
  ok("ratio: amm_info (XLS-30 formula 9) and book_offers walk, owed after the ledger's DefaultCovered, XRP needed for 150%"); }

// Lines and window
{ const now = 10_000, w = E.ADD_WINDOW_SECONDS;
  assert.equal(S.marginState({ ratio: 151, belowAddSince: null, now }).state, "ok");
  assert.equal(S.marginState({ ratio: 149, belowAddSince: now, now }).state, "add-window"); assert.equal(S.marginState({ ratio: 110, belowAddSince: now - w + 1, now }).state, "add-window");
  assert.equal(S.marginState({ ratio: 119.9, belowAddSince: now - w, now }).state, "bot-armed"); assert.equal(S.marginState({ ratio: 130, belowAddSince: now - w, now }).state, "below-add");
  assert.equal(S.marginState({ ratio: null, now }).state, "no-ratio");
  assert.equal(S.nextBelowSince(149, null, 5), 5); assert.equal(S.nextBelowSince(140, 3, 5), 3); assert.equal(S.nextBelowSince(150, 3, 5), null);
  const loan = { Flags: 0, PaymentRemaining: 2, NextPaymentDueDate: 1000, GracePeriod: 100 };
  assert.deepEqual([S.botPlan({ loan, margin: { state: "bot-armed" }, now: 900 }).mark, S.botPlan({ loan, margin: { state: "bot-armed" }, now: 900 }).sell], [false, false]);
  let b = S.botPlan({ loan, margin: { state: "ok" }, now: 1001 }); assert(b.mark && !b.sell);
  b = S.botPlan({ loan: { ...loan, Flags: FLAGS.lsfLoanImpaired }, margin: { state: "bot-armed" }, now: 1001 }); assert(!b.mark && b.sell);
  b = S.botPlan({ loan: { ...loan, Flags: FLAGS.lsfLoanImpaired }, margin: { state: "ok" }, now: 1101 }); assert(b.sell);
  ok("lines and window: 150% add line, window, 120% default line arms the bot; impair only once overdue"); }

// LoanSet blocked without an escrow; cover-only cap
{ const p = { ...S.seed().pools[0], escrow: { condition: COND, records: [] } };
  let g = S.loanSetEscrowGate(p, {}); assert(!g.ok); assert(g.reasons.some((r) => /blocked until the shop's XRP escrow/.test(r)));
  g = S.loanSetEscrowGate({ ...p, escrow: { condition: null, records: [] } }, { escrows: { verified: 1, drops: 1 }, ratio: 200 }); assert(!g.ok && /Condition/.test(g.reasons[0]));
  g = S.loanSetEscrowGate(p, { escrows: { verified: 1, drops: 1 }, ratio: 149.9 }); assert(!g.ok && /150% add line/.test(g.reasons[0]));
  g = S.loanSetEscrowGate(p, { escrows: { verified: 1, drops: 1 }, noMarket: true }); assert(!g.ok);
  assert(S.loanSetEscrowGate(p, { escrows: { verified: 2, drops: 1 }, ratio: 150 }).ok);
  const v = { SubscriptionDate: 0, RedemptionDate: 200 * 86400 }; assert(!S.loanSetEscrowGate(p, { escrows: { verified: 1 }, ratio: 160, vault: v, now: S.appLoanSetDeadline(v, p.terms) + 1 }).ok);
  const exp = { owner: SHOP, destination: BROKER, condition: COND, cancelAfterMin: 500 };
  const node = { LedgerEntryType: "Escrow", Account: SHOP, Destination: BROKER, Condition: COND, Amount: "7000000", CancelAfter: 500 };
  const set = S.escrowSet([{ owner: SHOP, seq: 3, node }, { owner: SHOP, seq: 4, node: { ...node, Destination: SHOP } }, { owner: SHOP, seq: 5, node: null }, { owner: SHOP, seq: 6, node: { ...node, CancelAfter: 499 } }, { owner: SHOP, seq: 7, node: { ...node, Condition: COND.replace("AB", "AC") } }], exp);
  assert.equal(set.verified, 1); assert.equal(set.drops, 7_000_000); assert.equal(set.rows.filter((r) => !r.ok).length, 4);
  // cover-only path: cap <= 1,000 and a desk file
  const st = S.seed(), base = { shop: "Kiosk", city: "Patra", purpose: "stock", capRlusd: "1000", ratePct: "10", paymentTotal: "3", intervalDays: "30", graceDays: "7", listingLock: String(RULES.LISTING_LOCK_QAK), account: SHOP, ledgerQak: RULES.LISTING_LOCK_QAK, ledgerVerified: true };
  assert.throws(() => S.apply(st, { ...base, path: PATHS.cover, capRlusd: "1001", deskFile: "id + lease" }), /cover-only path with a cap of at most 1,000/);
  assert.throws(() => S.apply(st, { ...base, path: PATHS.cover, deskFile: "" }), /desk/);
  const cp = S.apply(st, { ...base, path: PATHS.cover, deskFile: "id + lease" }); assert.equal(cp.path, PATHS.cover); assert(S.loanSetEscrowGate(cp).ok);
  assert(!S.loanSetEscrowGate({ ...cp, capRlusd: 5000 }).ok); assert(!S.loanSetEscrowGate({ ...cp, deskFile: null }).ok);
  const ep = S.apply(S.seed(), { ...base, capRlusd: "5000" }); assert.equal(ep.path, PATHS.escrow); assert.deepEqual(ep.escrow, { condition: null, records: [] });
  assert.throws(() => S.recordCondition(st, cp.id, COND), /cover-only/); S.recordCondition(st, "first", COND.toLowerCase()); assert.equal(st.pools[0].escrow.condition, COND);
  assert.throws(() => S.recordCondition(st, "first", "A0258020"), /Condition/);
  S.recordEscrow(st, "first", { owner: SHOP, seq: 9 }); assert.throws(() => S.recordEscrow(st, "first", { owner: SHOP, seq: 9 }), /already/);
  ok("LoanSet gate: blocked without a verified escrow, under 150%, without a market or past the app deadline; cover-only cap 1,000 + desk file"); }

// Sale steps derived from ledger reads
{ const now = 100; let s = S.saleSteps({ now }); assert.deepEqual(s.steps.map((x) => x.status), ["not started", "not started", "not started", "not started"]);
  s = S.saleSteps({ now, overdue: true }); assert.equal(s.steps[0].status, "stuck");
  const marked = { hash: "M" }, esc = [{ seq: 1, drops: 10e6, state: "finished", finishHash: "F1" }, { seq: 2, drops: 5e6, state: "present" }];
  s = S.saleSteps({ now, marked, escrows: esc, saleEnds: 200 }); assert.deepEqual(s.steps.map((x) => x.status), ["done", "waiting", "waiting", "not started"]);
  s = S.saleSteps({ now: 300, marked, escrows: esc, saleEnds: 200 }); assert.equal(s.steps[1].status, "stuck");
  s = S.saleSteps({ now, marked, escrows: [{ seq: 1, drops: 5e6, state: "canceled" }] }); assert.equal(s.steps[1].status, "stuck");
  const fin = esc.map((e) => ({ ...e, state: "finished" })), sales = [{ hash: "S1", xrpDrops: 15e6, quote: 40 }];
  s = S.saleSteps({ now, marked, escrows: fin, sales, nextDue: 50 }); assert.deepEqual(s.steps.map((x) => x.status), ["done", "done", "done", "stuck"]); assert(/partial/.test(s.steps[3].detail));
  s = S.saleSteps({ now, marked, escrows: fin, sales, pays: [{ hash: "P1", quote: 25 }], defaulted: { hash: "D", vaultLoss: 30 } });
  assert.deepEqual(s.steps.map((x) => x.status), ["done", "done", "done", "done"]); near(s.undelivered, 15); assert.equal(s.shortfall, 30); assert.deepEqual(s.steps[3].txs, ["P1"]);
  s = S.saleSteps({ now, marked, escrows: fin, sales, defaulted: { hash: "D", vaultLoss: 30 } }); assert.equal(s.steps[3].status, "stuck");
  s = S.saleSteps({ now, marked, escrows: fin, sales, pays: [{ hash: "P1", quote: 60 }], loan: { PaymentRemaining: 0, Flags: 0 } }); assert.equal(s.steps[3].status, "done");
  ok("sale steps: mark, finish, sell, LoanPay each done/stuck/waiting from ledger facts; shortfall from the default"); }

// Devnet run C is on the Status card with every hash and the sale-step inputs
{ const { DEVNET_TEST_RUN: R } = await import("./config.js"); const c = R.runs.find((r) => r.sale); assert(c && /escrow/i.test(c.title));
  assert(c.steps.length >= 20 && c.steps.every((x) => /^[0-9A-F]{64}$/.test(x.hash) && x.ok)); assert.equal(c.sale.escrows.length, 2);
  for (const t of ["EscrowCreate", "LoanSet", "tfLoanImpair", "EscrowFinish", "OfferCreate", "LoanPay", "tfLoanDefault"]) assert(c.steps.some((x) => x.step.includes(t)), t);
  assert(c.steps.some((x) => /after default/.test(x.step) && x.result === "tecKILLED")); ok("devnet run C recorded: escrow, gated LoanSet, impair, finish, sell, shop LoanPay, default"); }

// Phrase bans across the UI, config, whitepaper and README
{ const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); const files = [];
  for (const d of ["src", "docs", "bot"]) for (const f of fs.readdirSync(path.join(root, d))) if (/\.(js|html|md)$/.test(f) && !/\.test\.js$/.test(f)) files.push(path.join(root, d, f));
  files.push(path.join(root, "index.html"), path.join(root, "README.md"));
  const bans = [/not the loan/i, /no buy tax/i, /guaranteed yield/i, /made whole/i, /make (lenders|you) whole/i, /\bTRUSTLINE\b/, /\bTRUST\b/, /XLS-66 collateral/i, /clears? the debt/i, /repays? the (whole|full) (debt|loan)/i, /QAK[^.]{0,60}first[- ]loss/i, /first[- ]loss[^.]{0,60}QAK/i];
  for (const f of files) { const txt = fs.readFileSync(f, "utf8"); for (const b of bans) assert(!b.test(txt), `${path.relative(root, f)} matches banned ${b}`); }
  ok(`phrase bans: ${files.length} files clean`); }
console.log("escrow tests ok");
