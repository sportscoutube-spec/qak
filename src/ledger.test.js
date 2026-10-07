import * as L from "./ledger.js"; import { QAK_ISSUER as I } from "./config.js"; import assert from "node:assert";
const ok=(n)=>console.log("ok -",n);
const mock=(by)=>async(url,opt)=>{ const b=JSON.parse(opt.body); const r=by[b.method]; if(r instanceof Error) throw r;
  return { ok:true, json:async()=>({result:typeof r==="function"?r(b.params[0]):r}) }; };
const base={ account_info:{status:"success",ledger_index:5,account_data:{Account:I,Flags:0x00800000|0x00040000|0x00080000|0x40000000},signer_lists:[]},
  gateway_balances:{status:"success",obligations:{QAK:"499995683.6"}},
  account_objects:{status:"success",account_objects:[
    {LedgerEntryType:"Escrow",Amount:{currency:"QAK",issuer:I,value:"375000000"},Destination:"rDest",FinishAfter:0},
    {LedgerEntryType:"Escrow",Amount:{currency:"QAK",issuer:I,value:"125000000"},Destination:"rDest",FinishAfter:-RIPPLE()},
    {LedgerEntryType:"Escrow",Amount:"1000000",Destination:"rX"}]} };
function RIPPLE(){ return 3600; }
{ const s=await L.issuerStatus(mock(base)); assert.equal(s.blackholed,false); assert.equal(s.masterDisabled,false);
  assert.deepEqual(s.flags,["RequireAuth","DisallowXRP","DefaultRipple","AllowTrustLineLocking"]); assert.equal(s.obligations,"499995683.6");
  assert.equal(s.escrows.length,2,"XRP escrow ignored"); assert.equal(s.escrowedTotal,5e8); assert.equal(s.escrows[0].value,"125000000","sorted by unlock");
  assert.equal(s.escrows[1].finishAfter.toISOString(),"2000-01-01T00:00:00.000Z","ripple epoch"); ok("issuer status parse: flags, obligations, escrows"); }
for(const [ad,sl,want] of [[{Flags:0x00100000},[],true],[{Flags:0x00100000,RegularKey:"rrrrrrrrrrrrrrrrrrrrBZbvji"},[],true],[{Flags:0x00100000,RegularKey:"rSomeRealKey"},[],false],
  [{Flags:0x00100000},[{SignerEntries:[]}],false],[{Flags:0},[],false]]){
  const s=await L.issuerStatus(mock({...base,account_info:{status:"success",account_data:{Account:I,...ad},signer_lists:sl}})); assert.equal(s.blackholed,want,JSON.stringify(ad)); }
ok("blackhole rule: master disabled AND (no/blackhole regular key) AND no signer list");
await assert.rejects(()=>L.issuerStatus(mock({...base,gateway_balances:new Error("net down")})),/net down/);
await assert.rejects(()=>L.issuerStatus(mock({...base,account_info:{status:"error",error:"actNotFound"}})),/actNotFound/); ok("errors surface (neutral error state)");
{ const lines=(bal,auth=true)=>mock({account_lines:(p)=>{ assert.equal(p.peer,I); return {status:"success",lines:[{account:"rOther",currency:"QAK",balance:"999999"},{account:I,currency:"QAK",balance:bal,peer_authorized:auth,limit:"1000000000"}]}; }});
  assert.equal((await L.qakBalance("rA",lines("150000"))).balance,150000); assert.equal((await L.qakBalance("rA",lines("-5"))).balance,0);
  const none=await L.qakBalance("rA",mock({account_lines:{status:"success",lines:[]}})); assert.equal(none.hasLine,false); assert.equal(none.balance,0);
  assert.equal((await L.qakBalance("rA",lines("1",false))).authorized,false); ok("account_lines balance: issuer line only, no line = 0"); }
console.log("ledger tests ok");
