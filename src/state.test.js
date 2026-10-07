import * as S from "./state.js"; import { RULES as R, TOKENOMICS as K } from "./config.js"; import assert from "node:assert";
const ok=(n)=>console.log("ok -",n); const P=0.01; // test snapshot price only
assert.equal(K.buckets.reduce((t,b)=>t+b.tokens,0),R.TOTAL_SUPPLY_QAK); assert.equal(K.escrow.reduce((t,b)=>t+b.tokens,0),500_000_000); ok("tokenomics sums");
{ const s=S.seed(); for(const p of s.pools){ assert(p.drawCap<=S.maxCap(p)); assert(p.drawCap<=R.MAX_CAP_RLUSD); assert.equal(p.listingLock.qak,250000); }
  for(const p of s.pools.filter(p=>p.drawn)) assert(S.firstLossQak(p)>0); ok("seed respects rules"); }
{ const s=S.seed(); const f={shop:"X",city:"Y",purpose:"stock",drawCap:2000,ratePct:10,termDays:60,listingLock:249999,account:"rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY"};
  assert.throws(()=>S.apply(s,f),/listing lock/); assert.throws(()=>S.apply(s,{...f,listingLock:250000,drawCap:2001}),/cap/); S.apply(s,{...f,listingLock:250000}); ok("listing lock 250,000 + cap"); }
{ assert.equal(S.feeBps(99999),100); assert.equal(S.feeBps(100000),75); const s=S.seed(); const p=s.pools[0];
  S.deposit(s,"p1","me",3000); assert.throws(()=>S.draw(s,"p1"),/snapshot/); assert.equal(S.minFirstLossQak(3000,P),45000);
  p.firstLoss=[{who:"h",qak:44999}]; assert.throws(()=>S.draw(s,"p1",P),/first-loss/); S.lockFirstLoss(s,"p1","rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY",1); S.draw(s,"p1",P);
  assert.throws(()=>S.lockFirstLoss(s,"p1","rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY",1),/before the draw/); assert.throws(()=>S.unlockFirstLoss(s,"p1","h"),/open/);
  const I=S.interestOf(p); S.repay(s,"p1",S.owedOf(p)); assert.equal(p.status,"repaid"); assert(Math.abs(p.interestPaid-I)<1e-3);
  assert(Math.abs(s.pot.rlusd-I*0.01*0.5)<1e-6,"unverified holding: fee 1.00% of interest, half to pot"); assert.equal(S.firstLossQak(p),0); assert.equal(p.onTimeLoans,2); ok("first-loss before draw, fee on interest, release on repay, cap growth"); }
{ const s=S.seed(); const p=s.pools[0]; p.shopHoldingQak=0; S.deposit(s,"p1","me",3000); S.draw(s,"p1",P);
  S.missPayment(s,"p1",500,100); assert.throws(()=>S.draw(s,"p1",P),/frozen/); S.repay(s,"p1",200); assert(p.frozen); S.repay(s,"p1",300); assert(!p.frozen);
  assert.equal(p.status,"repaying"); S.repay(s,"p1",S.owedOf(p)); assert.equal(p.onTimeLoans,0); ok("draw freeze; late resets growth"); }
// WP worked example: short 400, first-loss worth 400 -> lenders whole; worth 150 -> lenders eat 250; other pools untouched; no burn
for(const [flQak,loss] of [[40000,0],[15000,250]]){ const s=S.seed(); const p=s.pools[0]; S.deposit(s,"p1","me",3000); p.firstLoss=[{who:"h",qak:flQak}];
  p.drawn=3000; p.status="drawn"; p.repaid=S.owedOf(p)-400; const marina=JSON.stringify(s.pools[1]);
  S.missPayment(s,"p1",400,0); assert.throws(()=>S.declareDefault(s,"p1",P,29),/grace/); const r=S.declareDefault(s,"p1",P,30);
  assert.equal(r.shortfall,400); assert.equal(r.lenderLoss,loss); assert.equal(r.listingSeized,250000); assert.equal(s.pot.qak,250000);
  assert.equal(JSON.stringify(s.pools[1]),marina); assert(!("burned" in s)); }
ok("whitepaper worked example (400 / 150) + isolation + no burn");
{ const s=S.seed(); s.pot.rlusd=100; const p=s.pools[0]; p.firstLoss=[]; p.drawn=3000; p.status="drawn"; p.repaid=S.owedOf(p)-400;
  S.missPayment(s,"p1",400,0); const r=S.declareDefault(s,"p1",P,30); assert.equal(r.fromPot,100); assert.equal(r.lenderLoss,300); assert.equal(s.pot.rlusd,0); ok("pot pays only up to its balance"); }
{ const s=S.seed(); S.voteCap(s,"p4",1500,5000,"rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY"); S.vote(s,"p4",true,1200,"rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY"); assert.equal(s.pools[3].status,"listed"); assert.equal(s.pools[3].drawCap,1500);
  assert.throws(()=>S.transition(s,"p4","repaid")); ok("1 QAK = 1 vote on listing and cap"); }
{ const s=S.seed(); const A="rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY", f={shop:" Shop ",city:"Athens",purpose:"stock",drawCap:1500,ratePct:10,termDays:60,listingLock:250000,account:A};
  assert.throws(()=>S.apply(s,{...f,account:undefined}),/connect/); assert.throws(()=>S.apply(s,{...f,account:"guest"}),/connect/);
  for(const [k,v,re] of [["shop","  ",/required/],["shop","x".repeat(61),/max 60/],["city","",/required/],["ratePct",-1,/rate/],["ratePct",36.5,/rate/],["ratePct","",/required/],["ratePct","abc",/number/],
    ["termDays",6,/term/],["termDays",181,/term/],["termDays",30.5,/term/],["drawCap",0,/cap/],["drawCap",-5,/cap/],["drawCap",1e12,/cap/],["drawCap","abc",/number/],["drawCap",1.5,/cap/],
    ["listingLock",1e15,/whole numbers/],["listingLock",250001,/listing lock/],["shopHoldingQak",-3,/QAK held/],["shopHoldingQak",2e9,/QAK held/],["purpose","x",/purpose/]])
    assert.throws(()=>S.apply(s,{...f,[k]:v}),re,k+"="+v);
  const p=S.apply(s,{...f,ratePct:0,termDays:7}); assert.equal(p.ratePct,0); assert.equal(p.termDays,7); assert.equal(p.shop,"Shop"); assert.equal(p.account,A);
  assert.equal(p.shopHoldingQak,null); assert.equal(S.poolFeeBps(p),100); const q=S.apply(s,{...f,shopHoldingQak:200000}); assert.equal(S.poolFeeBps(q),100,"self-declared holding gets no discount");
  assert.notEqual(p.id,q.id); assert(/^p_[0-9a-f-]{36}$/.test(p.id)); assert(s.pools.slice(0,4).every(x=>x.sample)&&!p.sample);
  assert.throws(()=>S.vote(s,"p4",true,10),/connect/); assert.throws(()=>S.lockFirstLoss(s,"p4","guest",10),/connect/); assert.throws(()=>S.lockFirstLoss(s,"p4",A,1.5),/whole/);
  assert.throws(()=>S.vote(s,"p4",true,2e9,A),/QAK weight/); ok("apply/vote/lock validation + account required + honest fee + uuid ids"); }
{ const s=S.seed(); const bad=JSON.parse(JSON.stringify(s)); bad.pools.push({...bad.pools[0],id:"x<img>",shop:"<img src=x>"}); bad.pools.push({...bad.pools[0],id:"ok2",shop:"y".repeat(500)});
  bad.pools.push({...bad.pools[0],id:"ok3",ratePct:1e9}); bad.pools.push({...bad.pools[0]}); bad.pools.push(null); bad.pools.push({...bad.pools[0],id:"ok4",log:[{}]});
  const c=S.sanitizeState(bad); assert.equal(c.pools.length,4); assert.equal(S.sanitizeState({pools:"x"}),null); assert.equal(S.sanitizeState(null),null);
  ok("load-time validation drops bad/duplicate records"); }
console.log("state tests ok");
