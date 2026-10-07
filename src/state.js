// Pool state machine (app rules). Nothing here touches a ledger.
// The QAK issuer is blackholed, so "seized" below means TREATED AS SEIZED by app rule against a published balance, never a ledger clawback.
import { RULES as R, LIMITS as L } from "./config.js";
export const STATUSES = ["applied","listed","drawn","repaying","late","repaid","defaulted"];
const T = { applied:["listed"], listed:["drawn"], drawn:["repaying","repaid","late"], repaying:["repaying","repaid","late"],
  late:["repaying","repaid","defaulted"], repaid:[], defaulted:[] };
const req = (c,m) => { if(!c) throw new Error(m); };
const pool = (s,id) => { const p=s.pools.find(x=>x.id===id); req(p,"no pool"); return p; };
const sum = (a) => a.reduce((t,x)=>t+x.qak,0);
export const today=()=>Math.floor(Date.now()/864e5);
export const capForHistory=(k)=>Math.min(R.MAX_CAP_RLUSD, Math.floor(R.INITIAL_CAP_RLUSD*(1+R.CAP_GROWTH_PCT)**k));
export const maxCap=(p)=>capForHistory(p.onTimeLoans||0);
export const nextCap=(p)=>capForHistory((p.onTimeLoans||0)+1);
export const firstLossQak=(p)=>sum(p.firstLoss);
export const minFirstLossQak=(cap,price)=>{ req(price>0,"a QAK snapshot price is required"); return Math.ceil(cap*R.FIRST_LOSS_PCT/price); };
export const feeBps=(holdingQak)=> (Number(holdingQak)||0)>=R.DISCOUNT_MIN_HOLDING_QAK ? R.DISCOUNT_FEE_BPS : R.PROTOCOL_FEE_BPS;
// Discount only for a ledger-verified holding. Self-declared holdings pay the full fee until a ledger balance read is wired.
export const poolFeeBps=(p)=> p.holdingVerified ? feeBps(p.shopHoldingQak) : R.PROTOCOL_FEE_BPS;
const isQak=(x)=>Number.isInteger(x)&&x>0&&x<=R.TOTAL_SUPPLY_QAK;
export const PREVIEW_ACCOUNT="rPREVIEWxxxxxxxxxxxxxxxxxxxxxxxxx";
export const isAccount=(who)=>typeof who==="string"&&(who===PREVIEW_ACCOUNT||/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(who));
const reqAccount=(who)=>req(isAccount(who),"connect a Xaman account first");
const newId=()=>"p_"+(globalThis.crypto?.randomUUID?globalThis.crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2));
const cleanName=(v,label)=>{ const t=String(v??"").trim(); req(t.length>0,`${label} required`); req(t.length<=L.NAME_MAX,`${label}: max ${L.NAME_MAX} characters`); return t; };
export const owedOf=(p)=>+(p.drawn*(1+p.ratePct/100*p.termDays/365)).toFixed(2);
export const interestOf=(p)=>+(owedOf(p)-p.drawn).toFixed(2);
export const daysLate=(p,day=today())=>p.lateSince==null?0:day-p.lateSince;
export const shares=(p,who)=>p.totalDeposits?(p.deposits[who]||0)/p.totalDeposits:0;
const blank=()=>({deposits:{},totalDeposits:0,drawn:0,repaid:0,interestPaid:0,firstLoss:[],frozen:false,hadLate:false,overdue:0,lateSince:null,
  votes:{yes:0,no:0},capVotes:{},voters:[],drawSnapshotPrice:null,log:[]});

export function seed(){
  const p=(id,shop,city,purpose,cap,rate,term,status,onTimeLoans,o={})=>({...blank(),id,shop,city,purpose,drawCap:cap,ratePct:rate,termDays:term,status,onTimeLoans,
    listingLock:{who:shop,qak:R.LISTING_LOCK_QAK},shopHoldingQak:R.LISTING_LOCK_QAK,holdingVerified:false,sample:true,...o});
  return { pools:[
    p("p1","Kostas Bakery","Athens","stock",3000,9,60,"listed",1,{firstLoss:[{who:"holder-a",qak:400000}]}),
    p("p2","Marina Fit Studio","Thessaloniki","fit-out",6750,11,120,"drawn",3,{totalDeposits:6750,deposits:{seed:6750},drawn:6750,firstLoss:[{who:"holder-b",qak:900000}]}),
    p("p3","Lefkada Surf Shop","Lefkada","stock",3000,10,45,"repaying",1,{totalDeposits:3000,deposits:{seed:3000},drawn:3000,repaid:1200,firstLoss:[{who:"holder-c",qak:400000}]}),
    p("p4","Psiri Records","Athens","fit-out",2000,12,90,"applied",0),
  ], pot:{rlusd:0,qak:0}, protocolRevenue:0, queue:[] };
}
export function transition(s,id,to,note=""){ const p=pool(s,id); req(T[p.status].includes(to),`illegal ${p.status} -> ${to}`);
  p.log.push(`${p.status} -> ${to} ${note}`.trim()); p.status=to; return p; }

// Application: shop name, city, purpose, cap, rate, term and a 250,000 QAK listing lock (bought from the pool like any holder).
// Requires a connected account (recorded). New applicants are first-time shops (0 on-time loans); history is not self-declared.
const num=(v,label)=>{ req(v!==undefined&&v!==null&&String(v).trim()!=="",`${label} required`); const x=Number(v); req(Number.isFinite(x),`${label} must be a number`); return x; };
export function apply(s,f){ reqAccount(f.account); const shop=cleanName(f.shop,"shop name"), city=cleanName(f.city,"city");
  req(["stock","fit-out"].includes(f.purpose),"purpose must be stock or fit-out");
  const cap=num(f.drawCap,"draw cap"), max=capForHistory(0);
  req(Number.isInteger(cap)&&cap>=1&&cap<=max,`cap must be a whole number 1..${max} RLUSD for this shop (first-time shops: ${R.INITIAL_CAP_RLUSD})`);
  const rate=num(f.ratePct,"interest rate"); req(rate>=L.RATE_MIN_PCT&&rate<=L.RATE_MAX_PCT,`interest rate must be ${L.RATE_MIN_PCT}..${L.RATE_MAX_PCT}% APR`);
  const term=num(f.termDays,"term"); req(Number.isInteger(term)&&term>=L.TERM_MIN_DAYS&&term<=L.TERM_MAX_DAYS,`term must be a whole number of days, ${L.TERM_MIN_DAYS}..${L.TERM_MAX_DAYS}`);
  const lock=num(f.listingLock,"listing lock"); req(isQak(lock),`QAK amounts must be whole numbers 1..${R.TOTAL_SUPPLY_QAK.toLocaleString()}`);
  req(lock===R.LISTING_LOCK_QAK,`listing lock must be ${R.LISTING_LOCK_QAK.toLocaleString()} QAK`);
  // QAK held comes from the ledger (account_lines), passed in by the app, never from the form. Preview/unconnected = 0.
  const held=Number(f.ledgerQak)||0; req(held>=0&&held<=R.TOTAL_SUPPLY_QAK,"bad ledger balance");
  req(lock<=held,`listing lock (${lock.toLocaleString()} QAK) must be covered by your QAK balance (ledger): ${held.toLocaleString()} QAK`);
  const p={...blank(),id:newId(),shop,city,purpose:f.purpose,drawCap:cap,ratePct:rate,termDays:term,status:"applied",onTimeLoans:0,
    account:f.account,listingLock:{who:f.account,qak:lock},shopHoldingQak:held,holdingVerified:f.ledgerVerified===true,sample:false,log:["applied by "+f.account]};
  s.pools.push(p); return p; }

// Load-time validation of stored state (localStorage is untrusted). Bad pools are dropped; strings are type/length checked.
const okStr=(x,max)=>typeof x==="string"&&x.length<=max;
const okNum=(x)=>typeof x==="number"&&Number.isFinite(x);
function okPool(p){ return p&&typeof p==="object"&&okStr(p.id,64)&&/^[A-Za-z0-9_-]+$/.test(p.id)&&okStr(p.shop,L.NAME_MAX)&&p.shop.trim()&&okStr(p.city,L.NAME_MAX)&&p.city.trim()
  &&["stock","fit-out"].includes(p.purpose)&&STATUSES.includes(p.status)&&["drawCap","ratePct","termDays","totalDeposits","drawn","repaid"].every(k=>okNum(p[k]))
  &&p.drawCap>0&&p.drawCap<=R.MAX_CAP_RLUSD&&p.ratePct>=L.RATE_MIN_PCT&&p.ratePct<=L.RATE_MAX_PCT&&p.termDays>=L.TERM_MIN_DAYS&&p.termDays<=L.TERM_MAX_DAYS
  &&p.deposits&&typeof p.deposits==="object"&&Array.isArray(p.firstLoss)&&p.firstLoss.every(x=>x&&okStr(x.who,64)&&isQak(x.qak))
  &&Array.isArray(p.log)&&p.log.every(l=>okStr(l,L.LOG_MAX))&&p.listingLock&&okNum(p.listingLock.qak)&&p.votes&&okNum(p.votes.yes)&&okNum(p.votes.no)
  &&(p.account===undefined||isAccount(p.account))&&(p.shopHoldingQak===null||p.shopHoldingQak===undefined||isQak(p.shopHoldingQak)); }
export function sanitizeState(raw){ if(!raw||typeof raw!=="object"||!Array.isArray(raw.pools)) return null;
  const pools=raw.pools.filter(okPool).map(p=>({...p,holdingVerified:false,voters:Array.isArray(p.voters)?p.voters.filter(v=>v&&okStr(v.who,64)):[]}));
  const ids=new Set(); const uniq=pools.filter(p=>!ids.has(p.id)&&ids.add(p.id));
  const queue=Array.isArray(raw.queue)?raw.queue.filter(q=>q&&okStr(q.who,64)&&okStr(q.id,64)&&okNum(q.amt)&&okNum(q.qakLocked)):[];
  const pot=raw.pot&&okNum(raw.pot.rlusd)&&okNum(raw.pot.qak)?raw.pot:{rlusd:0,qak:0};
  return { pools:uniq, pot, protocolRevenue:okNum(raw.protocolRevenue)?raw.protocolRevenue:0, queue }; }

// Votes: one QAK = one vote, on listing and on draw cap only.
export function vote(s,id,yes,qak,who){ reqAccount(who); const p=pool(s,id); req(p.status==="applied","voting only while applied"); qak=Number(qak); req(isQak(qak),"QAK weight must be a whole number 1..1,000,000,000");
  p.votes[yes?"yes":"no"]+=qak; (p.voters=p.voters||[]).push({who,yes:!!yes,qak});
  if(p.votes.yes>=R.LIST_VOTE_THRESHOLD_QAK && p.votes.yes>p.votes.no){
    const best=Object.entries(p.capVotes).sort((a,b)=>b[1]-a[1])[0]; if(best && best[1]>p.votes.yes) p.drawCap=Number(best[0]);
    transition(s,id,"listed",`(QAK vote passed; cap ${p.drawCap})`); }
  return p; }
export function voteCap(s,id,cap,qak,who){ reqAccount(who); qak=Number(qak); req(isQak(qak),"QAK weight must be a whole number 1..1,000,000,000"); const p=pool(s,id); req(p.status==="applied","cap votes only while applied"); cap=Number(cap);
  req(cap>0&&cap<=maxCap(p),`cap vote must be 1..${maxCap(p)}`); p.capVotes[cap]=(p.capVotes[cap]||0)+Number(qak); return p; }

// First-loss: any holder locks QAK under one named pool before the draw; cannot be pulled while the loan is open.
export function lockFirstLoss(s,id,who,qak){ reqAccount(who); const p=pool(s,id); req(["applied","listed"].includes(p.status),"first-loss must be posted before the draw");
  qak=Number(qak); req(isQak(qak),"QAK amount must be a whole number 1..1,000,000,000"); p.firstLoss.push({who,qak}); return p; }
export function unlockFirstLoss(s,id,who){ const p=pool(s,id); req(["applied","listed"].includes(p.status),"lock cannot be pulled while the loan is open");
  p.firstLoss=p.firstLoss.filter(x=>x.who!==who); return p; }

export function deposit(s,id,who,amt){ const p=pool(s,id); amt=Number(amt); req(p.status==="listed","deposits only into listed pools"); req(amt>0,"bad amount");
  const room=p.drawCap-p.totalDeposits; req(room>0,"pool full; join queue"); amt=Math.min(amt,room);
  p.deposits[who]=(p.deposits[who]||0)+amt; p.totalDeposits+=amt; return amt; }
// Queue: locked QAK orders the queue when a pool is full. It does not reserve a fill.
export function enqueue(s,who,id,amt,qakLocked){ s.queue.push({who,id,amt:Number(amt),qakLocked:Number(qakLocked)||0});
  s.queue.sort((a,b)=>b.qakLocked-a.qakLocked); return s.queue; }

export function draw(s,id,snapshotPrice){ const p=pool(s,id); req(!p.frozen,"draws frozen: overdue payment"); req(p.totalDeposits>0,"no deposits");
  req(p.totalDeposits<=maxCap(p),"exceeds shop max cap");
  const min=minFirstLossQak(p.totalDeposits,snapshotPrice); req(firstLossQak(p)>=min,`first-loss below minimum: need ${min} QAK at snapshot ${snapshotPrice}`);
  p.drawn=p.totalDeposits; p.drawSnapshotPrice=snapshotPrice; return transition(s,id,"drawn"); }

// Fee: 1.00% (or 0.75% for >=100,000 QAK held) of INTEREST paid, in RLUSD. Half to cover pot.
export function repay(s,id,amt){ const p=pool(s,id); const owed=owedOf(p); const paid=Math.min(Number(amt),owed-p.repaid); req(paid>0,"nothing owed");
  p.repaid+=paid; const interestPart=+(paid*interestOf(p)/owed).toFixed(6); p.interestPaid+=interestPart;
  const fee=interestPart*poolFeeBps(p)/1e4; s.pot.rlusd+=fee*R.COVER_SHARE_OF_FEES; s.protocolRevenue+=fee*(1-R.COVER_SHARE_OF_FEES);
  if(p.status==="late"){ p.overdue=Math.max(0,+(p.overdue-paid).toFixed(2)); if(p.overdue>0){ p.log.push(`partial overdue payment ${paid}; still frozen`); return p; }
    p.frozen=false; p.lateSince=null; p.log.push("overdue cleared; draw freeze lifted"); }
  if(p.repaid>=owed){ p.onTimeLoans=p.hadLate?0:(p.onTimeLoans||0)+1;
    p.log.push(`repaid: lenders paid first; first-loss lock (${firstLossQak(p)} QAK) and listing lock released`+(p.hadLate?"; cap growth reset":""));
    p.releasedFirstLoss=p.firstLoss; p.firstLoss=[]; return transition(s,id,"repaid"); }
  return transition(s,id,"repaying"); }
export function missPayment(s,id,overdueAmt,day=today()){ const p=pool(s,id); overdueAmt=Number(overdueAmt); req(overdueAmt>0,"overdue amount required");
  transition(s,id,"late","(missed repayment; draws frozen)"); p.frozen=true; p.hadLate=true; p.overdue=overdueAmt; p.lateSince=day; return p; }

// Default: shortfall takes first-loss QAK (valued at snapshot) before lenders; listing lock treated as seized -> pot;
// pot pays only up to its RLUSD balance, then stops; anything still unpaid stays in this pool.
export function declareDefault(s,id,snapshotPrice,day=today()){ const p=pool(s,id); req(p.status==="late","only late pools");
  req(daysLate(p,day)>=R.DEFAULT_GRACE_DAYS,`grace period: ${R.DEFAULT_GRACE_DAYS} days late required`); req(snapshotPrice>=0,"snapshot price required");
  transition(s,id,"defaulted"); const shortfall=+Math.max(0,owedOf(p)-p.repaid).toFixed(2);
  const flQak=firstLossQak(p), flValue=flQak*snapshotPrice, fromFirstLoss=Math.min(flValue,shortfall);
  const flTaken=snapshotPrice>0?Math.min(flQak,Math.ceil(fromFirstLoss/snapshotPrice)):0;
  const listingSeized=p.listingLock.qak; s.pot.qak+=listingSeized; p.listingLock.qak=0; p.firstLoss=[]; // first-loss remainder above shortfall is released
  const afterFl=+(shortfall-fromFirstLoss).toFixed(2); const fromPot=Math.min(s.pot.rlusd,afterFl); s.pot.rlusd-=fromPot;
  const lenderLoss=+(afterFl-fromPot).toFixed(2);
  p.log.push(`default: shortfall ${shortfall}; first-loss ${flTaken} QAK treated as seized (${fromFirstLoss.toFixed(2)} RLUSD at ${snapshotPrice}); listing lock ${listingSeized} QAK treated as seized -> pot; pot paid ${fromPot.toFixed(2)}; lender loss ${lenderLoss} stays in this pool`);
  return { shortfall, flTaken, fromFirstLoss, listingSeized, fromPot, lenderLoss }; }
