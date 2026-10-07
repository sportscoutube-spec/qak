// Read-only mainnet ledger reads for QAK. No transactions are built or sent here.
import { QAK_ISSUER, QAK_CURRENCY, LEDGER_RPC } from "./config.js";
export const RIPPLE_EPOCH = 946684800;
export const BLACKHOLES = ["rrrrrrrrrrrrrrrrrrrrrhoLvTp","rrrrrrrrrrrrrrrrrrrrBZbvji","rrrrrrrrrrrrrrrrrrrn5RM1rHd","rrrrrrrrrrrrrrrrrNAMEtxvNvQ"];
export const FLAGS = { lsfRequireDestTag:0x00020000, lsfRequireAuth:0x00040000, lsfDisallowXRP:0x00080000, lsfDisableMaster:0x00100000,
  lsfNoFreeze:0x00200000, lsfGlobalFreeze:0x00400000, lsfDefaultRipple:0x00800000, lsfDepositAuth:0x01000000,
  lsfDisallowIncomingTrustline:0x20000000, lsfAllowTrustLineLocking:0x40000000, lsfAllowTrustLineClawback:0x80000000 };
const NAMES = { lsfRequireDestTag:"RequireDestTag", lsfRequireAuth:"RequireAuth", lsfDisallowXRP:"DisallowXRP", lsfDisableMaster:"DisableMaster",
  lsfNoFreeze:"NoFreeze", lsfGlobalFreeze:"GlobalFreeze", lsfDefaultRipple:"DefaultRipple", lsfDepositAuth:"DepositAuth",
  lsfDisallowIncomingTrustline:"DisallowIncomingTrustline", lsfAllowTrustLineLocking:"AllowTrustLineLocking", lsfAllowTrustLineClawback:"AllowTrustLineClawback" };
export const flagNames=(f)=>Object.entries(FLAGS).filter(([,b])=>((f>>>0)&b)>>>0===b).map(([k])=>NAMES[k]);
const isQak=(cur)=>cur===QAK_CURRENCY;

export async function rpc(method, params, f=globalThis.fetch){
  const r=await f(LEDGER_RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({method,params:[params]})});
  if(!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  const j=await r.json(); const res=j&&j.result; if(!res||res.status==="error"||res.error) throw new Error(`${method}: ${res?.error_message||res?.error||"bad response"}`);
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
