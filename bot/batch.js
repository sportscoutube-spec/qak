// XLS-56 Batch (amendment BatchV1_1) helper for the broker-side bot. Node only.
// Spec (XLS-56 §2.1): exactly one mode flag on the outer tx; RawTransactions holds 2..8 inner txs, each with tfInnerBatchTxn, Fee "0",
// SigningPubKey "" and no TxnSignature/Signers; BatchSigners (sorted, one per other account) when another account has an inner tx;
// outer Fee = 2 × base + base per BatchSigner signature + Σ inner fees (§2.2, xrpl.org "Special Transaction Cost").
// §6: "An outer Batch transaction will return tesSUCCESS if the outer transaction succeeds, even if the inner transactions fail."
// So submitBatch never trusts the outer result: it looks up every inner tx by its hash on the validated ledger.
// Vault*/Loan* types are rejected as inner txs (temINVALID_INNER_BATCH, xrpl.org Batch reference), so they are refused here before signing.
import crypto from "node:crypto";
import xrpl from "xrpl";
import { encode } from "ripple-binary-codec";

export const MODE = { ALLORNOTHING: 0x00010000, ONLYONE: 0x00020000, UNTILFAILURE: 0x00040000, INDEPENDENT: 0x00080000 };
export const TF_INNER_BATCH_TXN = 0x40000000;
export const MIN_INNER = 2, MAX_INNER = 8;
export const DISABLED_INNER = ["VaultCreate", "VaultSet", "VaultDelete", "VaultDeposit", "VaultWithdraw", "VaultClawback", "LoanBrokerSet", "LoanBrokerDelete",
  "LoanBrokerCoverDeposit", "LoanBrokerCoverWithdraw", "LoanBrokerCoverClawback", "LoanSet", "LoanDelete", "LoanManage", "LoanPay", "Batch"];
const STRIP = ["TxnSignature", "Signers", "LastLedgerSequence", "NetworkID", "BatchSigners"];

// Inner tx hash: SHA-512Half of the "TXN\0" prefix + the inner tx's canonical binary (it is unsigned, so hashSignedTx does not apply).
export const innerHash = (inner) => crypto.createHash("sha512").update(Buffer.from("54584E00" + encode(inner), "hex")).digest("hex").slice(0, 64).toUpperCase();
// EscrowFinish with a Fulfillment costs base × (33 + fulfillment bytes / 16) (xrpl.org EscrowFinish); everything else here costs base.
export function innerFee(tx, base) {
  if (tx.TransactionType === "EscrowFinish" && tx.Fulfillment) return Math.ceil(base * (33 + tx.Fulfillment.length / 2 / 16));
  return base;
}
export const batchFee = (inners, base, signatures = 0) => 2 * base + signatures * base + inners.reduce((t, x) => t + innerFee(x, base), 0);
export const chunk = (arr, n = MAX_INNER) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// Build the outer Batch. items: [{tx, account?, sequence?}]. Inner txs of the outer account get consecutive sequences after the outer one
// (§A.11: inner txs need sequence numbers); other accounts' inner txs must bring their own `sequence`.
export function buildBatch({ account, sequence, mode, items, base, lastLedgerSequence, networkID }) {
  if (!MODE[mode]) throw new Error(`unknown batch mode ${mode}`);
  if (!Array.isArray(items) || items.length < MIN_INNER || items.length > MAX_INNER) throw new Error(`a Batch needs ${MIN_INNER}..${MAX_INNER} inner txs (got ${items?.length})`);
  if (!Number.isInteger(sequence) || sequence <= 0) throw new Error("outer Sequence required");
  let next = sequence + 1; const inners = [];
  for (const it of items) {
    const t = { ...it.tx }; for (const k of STRIP) delete t[k];
    if (DISABLED_INNER.includes(t.TransactionType)) throw new Error(`${t.TransactionType} cannot be a Batch inner tx (temINVALID_INNER_BATCH)`);
    const acct = it.account || t.Account || account; t.Account = acct;
    if (acct === account) t.Sequence = next++; else { if (!Number.isInteger(it.sequence)) throw new Error(`inner tx of ${acct} needs its own sequence`); t.Sequence = it.sequence; }
    t.Flags = ((Number(t.Flags) || 0) | TF_INNER_BATCH_TXN) >>> 0; t.Fee = "0"; t.SigningPubKey = ""; inners.push(t);
  }
  const signers = requiredSigners(account, inners);
  const tx = { TransactionType: "Batch", Account: account, Flags: MODE[mode], Sequence: sequence, Fee: String(batchFee(inners, base, signers.length)),
    RawTransactions: inners.map((t) => ({ RawTransaction: t })), ...(lastLedgerSequence ? { LastLedgerSequence: lastLedgerSequence } : {}), ...(networkID ? { NetworkID: networkID } : {}) };
  const hashes = inners.map(innerHash); if (new Set(hashes).size !== hashes.length) throw new Error("duplicate inner tx (temREDUNDANT)");
  return { tx, inners, innerHashes: hashes, signers, nextSequence: next };
}
// Accounts that must appear in BatchSigners (§2.1.3): every inner signer other than the outer account; a delegated inner tx is signed by its Delegate.
export function requiredSigners(outer, inners) { return [...new Set(inners.map((t) => t.Delegate || t.Account).filter((a) => a !== outer))].sort(); }

// Judge the inner results. found[i] = {validated, result, ledger, parent} or null (not found on the validated ledger).
// ALLORNOTHING: ok only if every inner tx is tesSUCCESS; a mix means the ledger did not behave atomically (flagged).
// INDEPENDENT: each inner stands alone; ok = all succeeded, `failed` lists the ones to retry.
export function checkInnerResults({ mode, outerHash, outerLedger, outerResult, innerHashes, found }) {
  const rows = innerHashes.map((hash, i) => { const f = found[i];
    const problem = !f || !f.validated ? "not on the validated ledger" : f.parent && f.parent !== outerHash ? "ParentBatchID mismatch" : outerLedger && f.ledger !== outerLedger ? "not in the outer tx's ledger" : f.result !== "tesSUCCESS" ? f.result : null;
    return { hash, result: f?.result ?? null, ok: !problem, problem }; });
  const okN = rows.filter((r) => r.ok).length, problems = rows.filter((r) => !r.ok).map((r) => `${r.hash.slice(0, 8)}: ${r.problem}`);
  if (outerResult !== "tesSUCCESS") problems.unshift(`outer ${outerResult}`);
  if (mode === "ALLORNOTHING" && okN > 0 && okN < rows.length) problems.push("ALLORNOTHING batch partly applied (should be impossible)");
  return { ok: outerResult === "tesSUCCESS" && okN === rows.length, applied: okN, rows, failed: rows.filter((r) => !r.ok).map((r) => r.hash), problems };
}

async function lookup(c, hash) {
  try { const r = (await c.request({ command: "tx", transaction: hash })).result; return { validated: !!r.validated, result: r.meta?.TransactionResult, ledger: r.ledger_index, parent: r.meta?.ParentBatchID ?? null, meta: r.meta, tx: r.tx_json || r }; }
  catch (e) { if (/txnNotFound/.test(e?.data?.error || e.message)) return null; throw e; }
}
// Build, (co-)sign, persist, submit and verify a Batch. signerWallets: wallets of the other accounts named in BatchSigners.
// record(entry) is called before submit (so a crash leaves the outer + inner hashes on disk) and again with the results.
export async function submitBatch(c, wallet, { mode, items, signerWallets = [], record = () => {}, label = "Batch", waitLedgers = 20 }) {
  const [ai, fee, si] = await Promise.all([c.request({ command: "account_info", account: wallet.address, ledger_index: "current" }), c.request({ command: "fee" }), c.request({ command: "server_info" })]);
  const base = Math.max(Number(fee.result.drops.base_fee), Number(fee.result.drops.open_ledger_fee) || 0, 10); // at least 10 drops
  const lls = fee.result.ledger_current_index + waitLedgers, nid = si.result.info.network_id;
  const b = buildBatch({ account: wallet.address, sequence: ai.result.account_data.Sequence, mode, items, base, lastLedgerSequence: lls, networkID: nid > 1024 ? nid : undefined });
  const missing = b.signers.filter((a) => !signerWallets.some((w) => w.address === a)); if (missing.length) throw new Error(`BatchSigners missing for ${missing.join(", ")}`);
  if (b.signers.length) { const parts = b.signers.map((a) => { const t = JSON.parse(JSON.stringify(b.tx)); xrpl.signMultiBatch(signerWallets.find((w) => w.address === a), t); return t; });
    b.tx.BatchSigners = parts.flatMap((p) => p.BatchSigners).sort((x, y) => (x.BatchSigner.Account < y.BatchSigner.Account ? -1 : 1)); }
  const signed = wallet.sign(b.tx); const entry = { at: new Date().toISOString(), label, type: "Batch", mode, hash: signed.hash, innerHashes: b.innerHashes, innerTypes: b.inners.map((t) => t.TransactionType), lastLedgerSequence: lls, fee: b.tx.Fee, pending: true };
  record(entry);
  const sub = await c.request({ command: "submit", tx_blob: signed.tx_blob }); const prelim = sub.result.engine_result;
  let outer = null;
  if (/^(tes|tec|ter|tef)/.test(prelim) || prelim === "telCAN_NOT_QUEUE") {
    for (;;) { outer = await lookup(c, signed.hash); if (outer?.validated) break; const v = (await c.request({ command: "ledger", ledger_index: "validated" })).result.ledger_index; if (v > lls) { outer = null; break; } await new Promise((r) => setTimeout(r, 2000)); }
  }
  const outerResult = outer?.result ?? prelim; const found = [];
  for (const h of b.innerHashes) found.push(outer ? await lookup(c, h) : null);
  const check = checkInnerResults({ mode, outerHash: signed.hash, outerLedger: outer?.ledger, outerResult, innerHashes: b.innerHashes, found });
  Object.assign(entry, { pending: false, result: outerResult, ledger: outer?.ledger ?? null, inner: check.rows.map((r, i) => ({ hash: r.hash, type: b.inners[i].TransactionType, result: r.result, ok: r.ok })), ok: check.ok, problems: check.problems });
  record(entry);
  return { hash: signed.hash, result: outerResult, ledger: outer?.ledger ?? null, check, inners: b.inners.map((t, i) => ({ tx: t, hash: b.innerHashes[i], ...(found[i] || {}), ok: check.rows[i].ok })), entry };
}
