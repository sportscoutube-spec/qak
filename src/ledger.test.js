import * as L from "./ledger.js"; import * as P from "./payloads.js"; import { QAK_ISSUER as I, AMENDMENTS, NETWORKS, FLAGS, RLUSD_CURRENCY } from "./config.js"; import assert from "node:assert";
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

// featureStatus: read-only `feature` RPC per network, matched by name, ID fallback
{ const urls=[]; const feats={ "AAA":{name:"SingleAssetVault",enabled:true,supported:true}, "BBB":{name:"LendingProtocol",enabled:true,supported:true},
    [AMENDMENTS.ids.LendingProtocolV1_1]:{enabled:false,supported:true}, "CCC":{name:"fixCleanup3_4_0",enabled:true} };
  const f=async(url,opt)=>{ urls.push(url); const b=JSON.parse(opt.body); assert.equal(b.method,"feature"); assert.deepEqual(b.params,[{}],"no vote arguments"); return {ok:true,json:async()=>({result:{status:"success",features:feats}})}; };
  const d=await L.featureStatus("devnet",f); assert.deepEqual(d,{SingleAssetVault:true,LendingProtocol:true,LendingProtocolV1_1:false,fixCleanup3_4_0:true});
  await L.featureStatus("mainnet",f); await L.featureStatus("testnet",f); assert.deepEqual(urls,[NETWORKS.devnet.rpc,NETWORKS.mainnet.rpc,NETWORKS.testnet.rpc]);
  assert.deepEqual(await L.featureStatus("devnet",mock({feature:{status:"success",features:{}}})),{SingleAssetVault:false,LendingProtocol:false,LendingProtocolV1_1:false,fixCleanup3_4_0:false});
  await assert.rejects(()=>L.featureStatus("nope",f),/unknown network/); ok("featureStatus: per network, by name or ID, missing = not enabled"); }

// ledgerEntry / createdId
{ const V="A".repeat(64), T="B".repeat(64);
  assert.equal((await L.ledgerEntry("devnet",V,mock({ledger_entry:(p)=>{ assert.equal(p.index,V); assert.equal(p.ledger_index,"validated"); return {status:"success",node:{LedgerEntryType:"Vault",AssetsMaximum:"10000"}}; }}))).AssetsMaximum,"10000");
  await assert.rejects(()=>L.ledgerEntry("devnet","fake",mock({})),/bad ledger id/);
  const tx=(meta,validated=true)=>mock({tx:{status:"success",validated,meta}});
  const meta={TransactionResult:"tesSUCCESS",AffectedNodes:[{ModifiedNode:{LedgerEntryType:"AccountRoot"}},{CreatedNode:{LedgerEntryType:"MPTokenIssuance",LedgerIndex:"C".repeat(64)}},{CreatedNode:{LedgerEntryType:"Vault",LedgerIndex:V}}]};
  assert.equal(await L.createdId("devnet",T,"Vault",tx(meta)),V);
  await assert.rejects(()=>L.createdId("devnet",T,"Vault",tx(meta,false)),/not validated/);
  await assert.rejects(()=>L.createdId("devnet",T,"Vault",tx({...meta,TransactionResult:"tecEXPIRED"})),/tecEXPIRED/);
  await assert.rejects(()=>L.createdId("devnet",T,"LoanBroker",tx(meta)),/no created LoanBroker/);
  await assert.rejects(()=>L.createdId("devnet","x",tx(meta)),/bad tx hash/); ok("ledgerEntry and createdId: validated tesSUCCESS only, ids from CreatedNode"); }

// Payload shapes (field and flag names from XLS-65 / XLS-66)
{ const asset={currency:RLUSD_CURRENCY,issuer:"rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"}, V="A".repeat(64), B="B".repeat(64), Lo="C".repeat(64), shop="rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
  const now=800000000, vc=P.vaultCreate({asset,AssetsMaximum:10000,SubscriptionDate:now+14*86400,RedemptionDate:now+114*86400,now});
  assert.deepEqual(vc,{TransactionType:"VaultCreate",Flags:0x00020000,Asset:asset,AssetsMaximum:"10000",Scale:6,VaultKind:1,SubscriptionDate:now+14*86400,RedemptionDate:now+114*86400});
  assert.equal(FLAGS.tfVaultShareNonTransferable,0x00020000); assert.equal(P.vaultCreate({asset,AssetsMaximum:1,SubscriptionDate:now+1000,RedemptionDate:now+2000,now,nonTransferable:false}).Flags,0);
  assert.throws(()=>P.vaultCreate({asset,AssetsMaximum:1,Scale:19,SubscriptionDate:now+1000,RedemptionDate:now+2000,now}),/Scale/);
  assert.throws(()=>P.vaultCreate({asset,AssetsMaximum:1,SubscriptionDate:now+1000,RedemptionDate:now+1100,now}),/180/);
  assert.throws(()=>P.vaultCreate({asset:{currency:RLUSD_CURRENCY,issuer:""},AssetsMaximum:1,SubscriptionDate:now+1000,RedemptionDate:now+2000,now}),/issuer/);
  assert.deepEqual(P.loanBrokerSet({VaultID:V,ManagementFeeRate:750,DebtMaximum:10000}),{TransactionType:"LoanBrokerSet",VaultID:V,ManagementFeeRate:750,DebtMaximum:"10000",CoverRateMinimum:15000,CoverRateLiquidation:100000});
  assert.throws(()=>P.loanBrokerSet({VaultID:V,ManagementFeeRate:10001,DebtMaximum:1}),/0..10000/); assert.throws(()=>P.loanBrokerSet({VaultID:V,ManagementFeeRate:0,DebtMaximum:1,CoverRateMinimum:0}),/both be zero/);
  assert.throws(()=>P.loanBrokerSet({VaultID:V,ManagementFeeRate:0,DebtMaximum:1,CoverRateLiquidation:100001}),/0..100000/); assert.throws(()=>P.loanBrokerSet({VaultID:"fake",ManagementFeeRate:0,DebtMaximum:1}),/VaultID/);
  assert.deepEqual(P.loanBrokerCoverDeposit({LoanBrokerID:B,asset,amount:1500}),{TransactionType:"LoanBrokerCoverDeposit",LoanBrokerID:B,Amount:{...asset,value:"1500"}});
  assert.deepEqual(P.vaultDeposit({VaultID:V,asset,amount:9839.02}),{TransactionType:"VaultDeposit",VaultID:V,Amount:{...asset,value:"9839.02"}});
  assert.throws(()=>P.vaultDeposit({VaultID:V,asset,amount:0}),/> 0/);
  const terms={InterestRate:10000,PaymentTotal:3,PaymentInterval:30*86400,GracePeriod:7*86400}; const ls=P.loanSet({LoanBrokerID:B,Counterparty:shop,PrincipalRequested:9839.02,terms});
  assert.equal(ls.TransactionType,"LoanSet"); assert.equal(ls.Counterparty,shop); assert.equal(ls.PrincipalRequested,"9839.02"); assert.equal(ls.GracePeriod,7*86400); assert.equal(ls.CounterpartySignature,undefined);
  assert.throws(()=>P.loanSet({LoanBrokerID:B,Counterparty:shop,PrincipalRequested:1,terms:{...terms,GracePeriod:31*86400}}),/GracePeriod/);
  assert.throws(()=>P.loanSet({LoanBrokerID:B,Counterparty:"guest",PrincipalRequested:1,terms}),/Counterparty/);
  // CounterpartySignature (XLS-66 §3.8.1.1): required; exactly one of single-sig pair or Signers
  assert.throws(()=>P.assertLoanSetComplete(ls),/temBAD_SIGNER/);
  const signed=P.withCounterpartySignature(ls,{SigningPubKey:"ED00",TxnSignature:"AB"}); assert.deepEqual(signed.CounterpartySignature,{SigningPubKey:"ED00",TxnSignature:"AB"}); assert(P.assertLoanSetComplete(signed));
  assert.deepEqual(P.withCounterpartySignature(ls,{Signers:[{Signer:{}}],SigningPubKey:""}).CounterpartySignature,{Signers:[{Signer:{}}],SigningPubKey:""});
  assert.throws(()=>P.withCounterpartySignature(ls,{SigningPubKey:"ED00",TxnSignature:"AB",Signers:[{}]}),/exactly one/); assert.throws(()=>P.withCounterpartySignature(ls,{}),/exactly one/);
  assert.throws(()=>P.withCounterpartySignature(vc,{SigningPubKey:"a",TxnSignature:"b"}),/not a LoanSet/);
  assert.deepEqual(P.loanPay({LoanID:Lo,asset,amount:3333.333334}),{TransactionType:"LoanPay",LoanID:Lo,Amount:{...asset,value:"3333.333334"},Flags:0});
  assert.equal(P.loanPay({LoanID:Lo,asset,amount:1,late:true}).Flags,0x00040000);
  assert.deepEqual(P.loanManage({LoanID:Lo,action:"default"}),{TransactionType:"LoanManage",LoanID:Lo,Flags:0x00010000});
  assert.equal(P.loanManage({LoanID:Lo,action:"impair"}).Flags,0x00020000); assert.equal(P.loanManage({LoanID:Lo,action:"unimpair"}).Flags,0x00040000); assert.throws(()=>P.loanManage({LoanID:Lo,action:"freeze"}),/action/);
  assert.deepEqual(P.loanDelete({LoanID:Lo}),{TransactionType:"LoanDelete",LoanID:Lo});
  const json=JSON.stringify([vc,ls,signed]); for(const bad of ["Account","Sequence","Fee","Collateral","Liquidat"]) assert(!json.includes('"'+bad),bad+" not in payloads");
  ok("payload shapes: VaultCreate, LoanBrokerSet, CoverDeposit, VaultDeposit, LoanSet(+CounterpartySignature), LoanPay, LoanManage, LoanDelete"); }

// Xaman layer: mainnet/testnet refused regardless of wallet; mock path is labelled and signs nothing
{ globalThis.window={dispatchEvent(){}}; const X=await import("./xaman.js"); assert.equal(X.hasKey(),false);
  await assert.rejects(()=>X.signTx({TransactionType:"VaultDeposit"},"mainnet"),/not enabled for vault lending/);
  await assert.rejects(()=>X.signTx({TransactionType:"VaultDeposit"},"testnet"),/not enabled for vault lending/);
  await assert.rejects(()=>X.signTx({TransactionType:"VaultDeposit"},"devnet"),/connect Xaman/);
  X.connectMock(); assert.equal(X.wallet.mode,"mock"); const r=await X.signTx({TransactionType:"VaultDeposit"},"devnet"); assert.equal(r.mock,true); assert.equal(r.signed,false); assert.match(r.note,/mock/);
  assert.match(X.XAMAN_SUPPORT.txTypes,/Not verified/); assert.match(X.XAMAN_SUPPORT.counterparty,/Not available/); ok("xaman: mainnet hard-off in the signer, mock labelled, support caveats stated"); }
console.log("ledger tests ok");
