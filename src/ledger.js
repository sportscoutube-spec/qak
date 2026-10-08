// Read-only ledger reads: QAK issuer/balances (mainnet), amendment status via the `feature` RPC (per network),
// and Vault/LoanBroker/Loan entries by id. No transactions are built or sent here.
import { QAK_ISSUER, QAK_CURRENCY, LEDGER_RPC, NETWORKS, AMENDMENTS, RIPPLE_EPOCH, MARKETS, FLAGS as TXF } from "./config.js";
export { RIPPLE_EPOCH };
export const BLACKHOLES = ["rrrrrrrrrrrrrrrrrrrrrhoLvTp","rrrrrrrrrrrrrrrrrrrrBZbvji","rrrrrrrrrrrrrrrrrrrn5RM1rHd","rrrrrrrrrrrrrrrrrNAMEtxvNvQ"];
export const FLAGS = { lsfRequireDestTag:0x00020000, lsfRequireAuth:0x00040000, lsfDisallowXRP:0x00080000, lsfDisableMaster:0x00100000,
  lsfNoFreeze:0x00200000, lsfGlobalFreeze:0x00400000, lsfDefaultRipple:0x00800000, lsfDepositAuth:0x01000000,
  lsfDisallowIncomingTrustline:0x20000000, lsfAllowTrustLineLocking:0x40000000, lsfAllowTrustLineClawback:0x80000000 };
const NAMES = { lsfRequireDestTag:"RequireDestTag", lsfRequireAuth:"RequireAuth", lsfDisallowXRP:"DisallowXRP", lsfDisableMaster:"DisableMaster",
  lsfNoFreeze:"NoFreeze", lsfGlobalFreeze:"GlobalFreeze", lsfDefaultRipple:"DefaultRipple", lsfDepositAuth:"DepositAuth",
  lsfDisallowIncomingTrustline:"DisallowIncomingTrustline", lsfAllowTrustLineLocking:"AllowTrustLineLocking", lsfAllowTrustLineClawback:"AllowTrustLineClawback" };
export const flagNames=(f)=>Object.entries(FLAGS).filter(([,b])=>((f>>>0)&b)>>>0===b).map(([k])=>NAMES[k]);
const isQak=(cur)=>cur===QAK_CURRENCY;

export async function rpc(method, params, f=globalThis.fetch, url=LEDGER_RPC){
  const r=await f(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({method,params:[params]})});
  if(!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  const j=await r.json(); const res=j&&j.result; if(!res||res.status==="error"||res.error) throw new Error(`${method}: ${[res?.error,res?.error_message].filter(Boolean).join(": ")||"bad response"}`);
  return res; }

export async function issuerStatus(f=globalThis.fetch){
  const [info,gw,objs]=await Promise.all([
    rpc("account_info",{account:QAK_ISSUER,ledger_index:"validated",signer_lists:true},f),
    rpc("gateway_balances",{account:QAK_ISSUER,ledger_index:"validated"},f),
    rpc("account_objects",{account:QAK_ISSUER,ledger_index:"validated",type:"escrow",limit:400},f)]);
  const ad=info.account_data||{}; const flags=Number(ad.Flags)||0;
  const signerLists=(info.signer_lists||ad.signer_lists||[]);
  const masterDisabled=((flags&FLAGS.lsfDisableMaster)>>>0)!==0, regularKey=ad.RegularKey||null;
  const blackholed=masterDisabled&&(!regularKey||BLACKHOLES.includes(regularKey))&&signerLists.length===0;
  const obl=gw.obligations&&gw.obligations[QAK_CURRENCY]; 
  const escrows=(objs.account_objects||[]).filter(o=>o.LedgerEntryType==="Escrow"&&o.Amount&&typeof o.Amount==="object"&&isQak(o.Amount.currency))
    .map(o=>({value:String(o.Amount.value),destination:String(o.Destination||""),
      finishAfter:o.FinishAfter!=null?new Date((Number(o.FinishAfter)+RIPPLE_EPOCH)*1000):null,
      cancelAfter:o.CancelAfter!=null?new Date((Number(o.CancelAfter)+RIPPLE_EPOCH)*1000):null}))
    .sort((a,b)=>(a.finishAfter||0)-(b.finishAfter||0));
  return { ledgerIndex:info.ledger_index??null, flags:flagNames(flags), masterDisabled, regularKey, signerListCount:signerLists.length, blackholed,
    obligations:obl!=null?String(obl):"0", escrows, escrowedTotal:escrows.reduce((t,e)=>t+Number(e.value),0), fetchedAt:new Date() }; }

// QAK balance of an account (trust line to the issuer). No line => 0.
export async function qakBalance(account, f=globalThis.fetch){
  const res=await rpc("account_lines",{account,peer:QAK_ISSUER,ledger_index:"validated"},f);
  const line=(res.lines||[]).find(l=>isQak(l.currency)&&l.account===QAK_ISSUER);
  if(!line) return { account, hasLine:false, balance:0, authorized:false };
  const b=Number(line.balance); return { account, hasLine:true, balance:Number.isFinite(b)&&b>0?b:0, authorized:!!line.peer_authorized, limit:String(line.limit) }; }

// Amendment status on one network via the read-only `feature` RPC (no arguments: nothing is voted or changed).
// Returns { SingleAssetVault: bool, ... } matched by amendment name, falling back to the known amendment ID.
export async function featureStatus(net, f=globalThis.fetch){
  const n=NETWORKS[net]; if(!n) throw new Error("unknown network");
  const res=await rpc("feature",{},f,n.rpc); const feats=res.features||{}; const out={};
  for(const name of [...AMENDMENTS.required,...AMENDMENTS.info]){
    const byName=Object.values(feats).find(v=>v&&v.name===name); const v=byName||feats[AMENDMENTS.ids[name]];
    out[name]=!!(v&&v.enabled===true); }
  return out; }
// Generic ledger_entry by object id on a network (Vault, LoanBroker, Loan).
export async function ledgerEntry(net, index, f=globalThis.fetch){
  if(!/^[0-9A-F]{64}$/.test(index||"")) throw new Error("bad ledger id");
  const res=await rpc("ledger_entry",{index,ledger_index:"validated"},f,NETWORKS[net].rpc); return res.node; }
// After a validated transaction: the LedgerIndex of the CreatedNode of a given type (e.g. "Vault", "LoanBroker", "Loan").
export async function createdId(net, txid, type, f=globalThis.fetch){
  if(!/^[0-9A-F]{64}$/.test(txid||"")) throw new Error("bad tx hash");
  const res=await rpc("tx",{transaction:txid},f,NETWORKS[net].rpc);
  if(!res.validated) throw new Error("transaction not validated yet");
  const result=res.meta?.TransactionResult; if(result!=="tesSUCCESS") throw new Error("transaction result "+result);
  const node=(res.meta.AffectedNodes||[]).map(x=>x.CreatedNode).find(c=>c&&c.LedgerEntryType===type);
  if(!node) throw new Error("no created "+type); return node.LedgerIndex; }

// ---------- XRP escrow, market and sale-step reads (read-only) ----------
const rpcUrl = (net) => { const n = NETWORKS[net]; if (!n) throw new Error("unknown network"); return n.rpc; };
const isAcct = (x) => typeof x === "string" && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(x);
// Market for a network: amm_info for XRP/quote and book_offers where takers give XRP and get the quote (the side that buys our XRP).
// Missing AMM (actNotFound) or an empty book is "no market" for that venue, not an error.
export async function marketDepth(net, f = globalThis.fetch, override = null) {
  const m = override ? { label: override.label || "market", unit: override.unit || "", ...MARKETS[net], ...override } : MARKETS[net];
  if (!m) return { net, none: "no market configured for this network", amm: null, offers: [] };
  if (!isAcct(m.quote.issuer)) return { net, none: "quote issuer not set", amm: null, offers: [] };
  const soft = (p) => p.catch((e) => { if (/actNotFound|entryNotFound|objectNotFound/.test(e.message)) return null; throw e; });
  const [amm, book] = await Promise.all([
    soft(rpc("amm_info", { asset: { currency: "XRP" }, asset2: { currency: m.quote.currency, issuer: m.quote.issuer }, ledger_index: "validated" }, f, m.rpc)),
    soft(rpc("book_offers", { taker_gets: { currency: m.quote.currency, issuer: m.quote.issuer }, taker_pays: { currency: "XRP" }, limit: 200, ledger_index: "validated" }, f, m.rpc))]);
  return { net, label: m.label, unit: m.unit, quote: m.quote, amm: amm ? amm.amm : null, offers: book ? book.offers || [] : [], ledgerIndex: (book || amm)?.ledger_index ?? null, fetchedAt: new Date() };
}
// One Escrow entry by owner + sequence (ledger_entry "escrow" form). Not found returns null.
export async function escrowEntry(net, owner, seq, f = globalThis.fetch) {
  if (!isAcct(owner) || !Number.isInteger(seq)) throw new Error("bad escrow key");
  try { return (await rpc("ledger_entry", { escrow: { owner, seq }, ledger_index: "validated" }, f, rpcUrl(net))).node; }
  catch (e) { if (/entryNotFound|objectNotFound/.test(e.message)) return null; throw e; }
}
// Sequence of a validated transaction (TicketSequence when a Ticket was used): the key of the escrow it created.
export async function txInfo(net, hash, f = globalThis.fetch) {
  if (!/^[0-9A-F]{64}$/.test(hash || "")) throw new Error("bad tx hash");
  const r = await rpc("tx", { transaction: hash }, f, rpcUrl(net)); const t = r.tx_json || r;
  return { validated: !!r.validated, result: r.meta?.TransactionResult, type: t.TransactionType, account: t.Account, seq: t.TicketSequence || t.Sequence, meta: r.meta, tx: t, date: t.date ?? r.date ?? null };
}
// Escrows owned by an account (account_objects type escrow) with their creating sequence from PreviousTxnID (an Escrow is never modified
// after EscrowCreate, so PreviousTxnID is the EscrowCreate). The Escrow entry itself does not store the sequence.
export async function accountEscrows(net, account, f = globalThis.fetch) {
  const r = await rpc("account_objects", { account, type: "escrow", ledger_index: "validated", limit: 400 }, f, rpcUrl(net));
  const out = [];
  for (const o of r.account_objects || []) { let seq = null; try { const t = await txInfo(net, o.PreviousTxnID, f); if (t.type === "EscrowCreate" && t.account === account) seq = t.seq; } catch {} out.push({ seq, node: o }); }
  return out;
}
// Balance change of one account in tx metadata: XRP (drops) or one IOU (quote units). RippleState balances are from the low account's side.
export function balanceDelta(meta, account, asset) {
  let d = 0;
  for (const n of meta?.AffectedNodes || []) { const x = n.ModifiedNode || n.CreatedNode || n.DeletedNode; if (!x) continue;
    const fin = x.FinalFields || x.NewFields || {}, prev = x.PreviousFields || {};
    if (asset === "XRP" && x.LedgerEntryType === "AccountRoot" && fin.Account === account) {
      const a = Number(fin.Balance ?? 0), b = n.CreatedNode ? 0 : Number(prev.Balance ?? fin.Balance ?? 0); d += a - b; }
    if (asset !== "XRP" && x.LedgerEntryType === "RippleState" && fin.Balance && fin.Balance.currency === asset.currency) {
      const lo = fin.LowLimit?.issuer, hi = fin.HighLimit?.issuer; if (!((lo === account && hi === asset.issuer) || (hi === account && lo === asset.issuer))) continue;
      const a = Number(n.DeletedNode ? 0 : fin.Balance.value), b = n.CreatedNode ? 0 : Number((prev.Balance ?? fin.Balance).value); d += (lo === account ? 1 : -1) * (a - b); } }
  return d;
}
const vaultLossOf = (meta) => { for (const n of meta?.AffectedNodes || []) { const x = n.ModifiedNode; if (x && x.LedgerEntryType === "Vault" && x.PreviousFields?.AssetsTotal != null) return Number(x.PreviousFields.AssetsTotal) - Number(x.FinalFields.AssetsTotal); } return null; };
async function accountTx(net, account, f) { const r = await rpc("account_tx", { account, ledger_index_min: -1, ledger_index_max: -1, limit: 400, forward: false }, f, rpcUrl(net)); return (r.transactions || []).map((x) => ({ tx: x.tx_json || x.tx, meta: x.meta, hash: x.hash || (x.tx_json || x.tx)?.hash })); }
// Everything saleSteps() needs, read from the ledger: Loan, the broker's LoanManage/EscrowFinish/OfferCreate/Payment, the shop's LoanPay
// and escrow cancels. `escrows` = [{owner, seq}] on record. Only validated tesSUCCESS transactions count.
export async function saleInputs(net, { LoanID, broker, shop, escrows, quote }, f = globalThis.fetch) {
  const loan = await ledgerEntry(net, LoanID, f).catch((e) => { if (/entryNotFound|objectNotFound/.test(e.message)) return null; throw e; });
  const [btx, stx] = await Promise.all([accountTx(net, broker, f), accountTx(net, shop, f)]);
  const ok = (x) => x.meta && x.meta.TransactionResult === "tesSUCCESS";
  const all = [...btx, ...stx].filter(ok); const seen = new Set(); const txs = all.filter((x) => (seen.has(x.hash) ? false : seen.add(x.hash))).sort((a, b) => (a.tx.date || 0) - (b.tx.date || 0));
  const manage = txs.filter((x) => x.tx.TransactionType === "LoanManage" && x.tx.LoanID === LoanID);
  const markTx = manage.find((x) => (Number(x.tx.Flags) & (TXF.tfLoanImpair | TXF.tfLoanDefault)) !== 0) || null;
  const defTx = manage.find((x) => (Number(x.tx.Flags) & TXF.tfLoanDefault) !== 0) || null;
  const markDate = markTx ? markTx.tx.date : null;
  const es = [];
  for (const e of escrows || []) {
    const node = await escrowEntry(net, e.owner, e.seq, f);
    const fin = txs.find((x) => x.tx.TransactionType === "EscrowFinish" && x.tx.Owner === e.owner && x.tx.OfferSequence === e.seq);
    const can = txs.find((x) => x.tx.TransactionType === "EscrowCancel" && x.tx.Owner === e.owner && x.tx.OfferSequence === e.seq);
    let drops = node ? Number(node.Amount) : 0;
    if (!node && fin) drops = balanceDelta(fin.meta, broker, "XRP") + (fin.tx.Account === broker ? Number(fin.tx.Fee) : 0);
    es.push({ owner: e.owner, seq: e.seq, drops, state: node ? "present" : fin ? "finished" : can ? "canceled" : "missing", finishHash: fin?.hash || null, node });
  }
  const firstFin = es.map((e) => txs.find((x) => x.hash === e.finishHash)).filter(Boolean).map((x) => x.tx.date).sort((a, b) => a - b)[0] ?? null;
  const sales = firstFin == null ? [] : txs.filter((x) => x.tx.Account === broker && ["OfferCreate", "Payment"].includes(x.tx.TransactionType) && x.tx.date >= firstFin)
    .map((x) => ({ hash: x.hash, xrpDrops: -(balanceDelta(x.meta, broker, "XRP") + Number(x.tx.Fee)), quote: balanceDelta(x.meta, broker, quote) }))
    .filter((x) => x.xrpDrops > 0 && x.quote > 0);
  const pays = markDate == null ? [] : txs.filter((x) => x.tx.TransactionType === "LoanPay" && x.tx.LoanID === LoanID && x.tx.date >= markDate)
    .map((x) => ({ hash: x.hash, quote: -balanceDelta(x.meta, x.tx.Account, quote) }));
  const defaulted = defTx ? { hash: defTx.hash, vaultLoss: vaultLossOf(defTx.meta) } : null;
  return { loan, marked: markTx ? { hash: markTx.hash, date: markDate } : null, escrows: es, sales, pays, defaulted };
}
