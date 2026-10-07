import { CONFIG, RLUSD, ASSET, AMENDMENTS, GATED_TXS, RULES, TOKENOMICS, LIMITS } from "./config.js";
import * as S from "./state.js";
import * as X from "./xaman.js";
const esc=(v)=>String(v??"").replace(/[&<>"'`]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;","`":"&#96;"}[c]));
const load=()=>{ try{ return S.sanitizeState(JSON.parse(localStorage.getItem(KEY)||"null")); }catch{ return null; } };
const KEY="qak-v3"; let st = load() || S.seed();
const save=()=>localStorage.setItem(KEY,JSON.stringify(st)); const $=(h)=>document.getElementById("app").innerHTML=h;
const me=()=>X.wallet.account||"guest"; const tag=(s)=>`<span class="tag s-${esc(s)}">${esc(s)}</span>`; const sample=(p)=>p.sample?` <span class="tag sample">Sample shop</span>`:"";
const pct=(bps)=>(bps/100).toFixed(2);
const rlusdRow=`<tr><td>Asset</td><td>${ASSET} (currency code ${RLUSD.currencyHex}), mainnet issuer ${RLUSD.mainnetIssuer}</td></tr>`; const n=(x)=>Number(x).toLocaleString();
const gate=`<p class="off">Waiting on amendment: XLS-65/66 transactions are feature-flagged OFF (${CONFIG.enableVaultLending?"flag set, but mainnet still not enabled; devnet-only":"flag off"}). Mainnet sends: OFF.</p>`;
const act=(f)=>{ try{ f(); save(); }catch(e){ alert(e.message);} route(); };
if(import.meta.env?.DEV) window.T={ act, S, get st(){return st}, reset(){ st=S.seed(); save(); route(); } };

const pages={
  "": ()=>`<section class="hero"><div class="hero-text">
   <span class="eyebrow">Built on XRPL · Powered by ${ASSET}</span>
   <h1>Short working-capital loans to named shops.</h1>
   <p class="lead">Lenders fund one named retailer at a time, such as stock for a bakery or a fit-out for a studio, in ${ASSET} on the XRP Ledger. Each shop has its own pool, and lenders get a pool-share receipt for that shop only, so a loss stays in that pool.</p>
   <div class="cta"><a class="btn" href="#/pools">Browse pools</a><a class="btn sec" href="#/apply">Apply as a shop</a></div>
   </div><div class="hero-art"><img src="/banner.jpg" alt="QAK Duck Bank on the XRP Ledger" class="banner"/></div></section>
   <div class="stats"><div><b>${st.pools.length}</b><span>shop pools</span></div><div><b>${n(st.pools.reduce((t,p)=>t+p.drawCap,0))}</b><span>${ASSET} total caps</span></div><div><b>≤ 10,000</b><span>${ASSET} per pool</span></div><div><b>1,000,000,000</b><span>QAK, fixed supply</span></div></div>
   <p class="note">Figures include sample shops.</p>
   <div class="grid"><div class="card"><h3>Small first pools</h3>First pools are at or under 10,000 ${ASSET}, and short. First-time shops start at ${n(RULES.INITIAL_CAP_RLUSD)} ${ASSET}.</div>
   <div class="card"><h3>No guaranteed yield</h3>Shops can pay late or default. First-loss QAK takes a shortfall before lenders, and the cover pot pays only up to its balance. Anything still unpaid stays in that pool. Not audited.</div>
   <div class="card"><h3>QAK is not the loan</h3>QAK lists a shop, sits first-loss under one pool, cuts the fee, orders a full queue, votes a listing and a cap, and backs a default-cover pot. RLUSD is what is lent; the pool share is what the lender holds. <b>No buy tax.</b> Buys outside this app are untaxed.</div></div>`,
  apply: ()=>`<h1>Retailer application</h1><form class="card" id="f">
   <p>${X.wallet.account?`Applying as ${esc(X.wallet.account)}`:'<span class="warn">Connect Xaman to submit an application. Your account address is recorded with it.</span>'}</p>
   <label>Shop name<input name="shop" required maxlength="${LIMITS.NAME_MAX}"></label><label>City<input name="city" required maxlength="${LIMITS.NAME_MAX}"></label>
   <label>Purpose<select name="purpose"><option>stock</option><option>fit-out</option></select></label>
   <label>Draw cap (${ASSET}; first-time shops max ${n(RULES.INITIAL_CAP_RLUSD)})<input name="drawCap" type="number" min="1" step="1" max="${RULES.INITIAL_CAP_RLUSD}" value="${RULES.INITIAL_CAP_RLUSD}" required></label>
   <label>Interest rate % APR (${LIMITS.RATE_MIN_PCT}-${LIMITS.RATE_MAX_PCT})<input name="ratePct" type="number" step="any" min="${LIMITS.RATE_MIN_PCT}" max="${LIMITS.RATE_MAX_PCT}" value="10" required></label><label>Term (days, ${LIMITS.TERM_MIN_DAYS}-${LIMITS.TERM_MAX_DAYS})<input name="termDays" type="number" step="1" min="${LIMITS.TERM_MIN_DAYS}" max="${LIMITS.TERM_MAX_DAYS}" value="60" required></label>
   <label>QAK listing lock (must be ${n(RULES.LISTING_LOCK_QAK)})<input name="listingLock" type="number" step="1" value="${RULES.LISTING_LOCK_QAK}" required></label>
   <label>QAK held by the shop account (self-declared; not verified until the ledger balance read is wired, so the fee stays ${pct(RULES.PROTOCOL_FEE_BPS)}%)<input name="shopHoldingQak" type="number" step="1" min="1" placeholder="optional"></label>
   <p id="minfl" class="warn"></p><p id="err" class="off" role="alert"></p>
   <button>Submit application</button></form><p>After you submit, the application is reviewed. QAK holders vote on the listing and the cap. Status starts at ${tag("applied")}.</p>`,
  whitepaper: ()=>`<h1>QAK Whitepaper</h1><p><a class="btn" href="/qak-whitepaper.pdf" download>Download PDF</a> <a class="btn sec" href="/qak-whitepaper.pdf" target="_blank" rel="noopener">Open in new tab</a></p>
   <iframe src="/qak-whitepaper.pdf" class="pdf" title="QAK Whitepaper"></iframe>`,
  pools: ()=>`<h1>Pools</h1><div class="grid">${st.pools.map(p=>`<div class="card"><h3><a href="#/pool/${encodeURIComponent(p.id)}">${esc(p.shop)}</a>${sample(p)}</h3>
   ${esc(p.city)} · ${esc(p.purpose)} · ${tag(p.status)}<br>Cap ${n(p.drawCap)} ${ASSET} · ${n(p.ratePct)}% · ${n(p.termDays)}d<br>Deposited ${n(p.totalDeposits)}</div>`).join("")}</div>
   `,
  pool: (id)=>{ const p=st.pools.find(x=>x.id===id); if(!p) return `<h1>Not found</h1><p>No pool with that id.</p><p><a class="btn" href="#/pools">Back to Pools</a></p>`;
   const a=(fn,l,_d,why="Opens when XRPL vaults go live")=>`<button disabled title="${why}">${l}: ${why}</button>`; const Q="Opens after QAK launch";
   return `<h1>${esc(p.shop)} ${tag(p.status)}${sample(p)}</h1><div class="card"><table>
   <tr><td>City</td><td>${esc(p.city)}</td></tr><tr><td>Purpose</td><td>${esc(p.purpose)}</td></tr>${rlusdRow}${p.account?`<tr><td>Applicant account</td><td>${esc(p.account)}</td></tr>`:""}<tr><td>Draw cap</td><td>${n(p.drawCap)} ${ASSET}</td></tr>
   <tr><td>Rate / term</td><td>${n(p.ratePct)}% APR / ${n(p.termDays)} days</td></tr><tr><td>Deposited / drawn / repaid</td><td>${n(p.totalDeposits)} / ${n(p.drawn)} / ${n(p.repaid)} (owed ${n(S.owedOf(p))})</td></tr>
   <tr><td>Listing lock</td><td>${n(p.listingLock.qak)} QAK</td></tr><tr><td>First-loss locked</td><td>${n(S.firstLossQak(p))} QAK from ${p.firstLoss.length} holder(s); valued at the draw snapshot${p.drawSnapshotPrice?" ("+n(p.drawSnapshotPrice)+" "+ASSET+")":""}. The cushion is only what was locked.</td></tr><tr><td>Protocol fee</td><td>${pct(S.poolFeeBps(p))}% of interest paid${p.holdingVerified?"":" (QAK holding not verified on ledger)"}</td></tr><tr><td>Shop max cap now</td><td>${n(S.maxCap(p))} ${ASSET} (${p.onTimeLoans||0} on-time loans)</td></tr>
   <tr><td>Next eligible cap</td><td>${p.status==="defaulted"?"none":n(S.nextCap(p))+" "+ASSET+" if this loan is repaid fully on time"+(p.hadLate?" (a late payment means growth resets to "+n(RULES.INITIAL_CAP_RLUSD)+")":"")}</td></tr>
   <tr><td>Draws</td><td>${p.frozen?`<span class="off">FROZEN: ${n(p.overdue)} ${ASSET} overdue, ${S.daysLate(p)} days late (default possible after ${RULES.DEFAULT_GRACE_DAYS})</span>`:'<span class="on">not frozen</span>'}</td></tr>
   <tr><td>Votes (1 QAK = 1 vote)</td><td>listing: yes ${n(p.votes.yes)} / no ${n(p.votes.no)}</td></tr>
   <tr><td>Your pool shares</td><td>${(S.shares(p,me())*100).toFixed(1)}% of ${esc(p.shop)} pool (receipt for this shop only)</td></tr></table></div>
   <div class="card"><h3>Pool actions</h3>
   ${a("vote","QAK vote: listing / cap",0,Q)}
   ${a("lockFirstLoss","Lock first-loss QAK",0,Q)}
   ${a("deposit","Deposit")}
   ${a("draw","Shop draws")}
   ${a("repay","Repay 1,000")}${gate}
   <ul>${p.log.map(l=>`<li>${esc(l)}</li>`).join("")}</ul></div>`; },
  lend: ()=>`<h1>Lender panel</h1>
   <div class="card">Wallet: ${esc(X.wallet.account||"not connected")}<br><button disabled>Deposit: Opens when XRPL vaults go live</button><button disabled>Withdraw: Opens when XRPL vaults go live</button></div>
   <div class="card"><h3>Lent asset</h3><table>${rlusdRow}<tr><td>Testnet issuer</td><td>${RLUSD.testnetIssuer}</td></tr></table></div>
   <div class="card"><h3>Your receipts</h3><table><tr><th>Pool</th><th>Deposited</th><th>Share</th><th>Status</th></tr>
   ${st.pools.filter(p=>p.deposits[me()]).map(p=>`<tr><td>${esc(p.shop)}</td><td>${n(p.deposits[me()])}</td><td>${(S.shares(p,me())*100).toFixed(1)}%</td><td>${tag(p.status)}</td></tr>`).join("")||"<tr><td colspan=4>none</td></tr>"}</table></div>
   <div class="card"><h3>Lender queue (ordered by locked QAK; does not reserve a fill)</h3><button disabled>Join queue: Opens when XRPL vaults go live</button>
   <ol>${st.queue.map(q=>`<li>${esc(q.who.slice(0,10))} ${n(q.amt)} → ${esc(q.id)} (QAK ${n(q.qakLocked)})</li>`).join("")}</ol></div>
   <div class="card">On-ledger path (when amendments go live): VaultCreate per shop → VaultDeposit returns vault shares (MPT). ${gate}</div>`,
  trust: ()=>{ const R=RULES,K=TOKENOMICS; return `<h1>QAK roles</h1><div class="grid">
   ${[["Listing",`A shop locks <b>${n(R.LISTING_LOCK_QAK)} QAK</b> to be listed. The lock is bought from the pool, the same way any other holder buys QAK. If the shop defaults, the app treats that lock as seized and it goes to the cover pot.`],
     ["First-loss",`Any holder can lock QAK under one named pool before the draw. It cannot be pulled while the loan is open. Repayment releases the lock. A shortfall takes that QAK, valued at the snapshot, before the RLUSD lenders. Anything still unpaid stays in that pool. The cushion is only what was locked. The app also requires the lock to be worth at least ${R.FIRST_LOSS_PCT*100}% of the drawn amount at the draw snapshot.`],
     ["Fee",`The protocol fee is <b>${pct(R.PROTOCOL_FEE_BPS)}%</b> of interest paid, or <b>${pct(R.DISCOUNT_FEE_BPS)}%</b> for an account holding at least ${n(R.DISCOUNT_MIN_HOLDING_QAK)} QAK. It is taken in ${ASSET}.`],
     ["Queue","Locked QAK orders the queue when a pool is full. It does not reserve a fill."],
     ["Vote","One QAK is one vote, on listing and on draw cap only. A vote cannot move another pool's deposits."],
     ["Cover pot",`Half of protocol fees, plus seized stake, goes to the pot. The pot pays the next default only up to its balance, then stops. Currently ${n(st.pot.rlusd.toFixed(2))} ${ASSET} + ${n(st.pot.qak)} QAK.`]]
     .map(([h,b])=>`<div class="card"><h3>${h}</h3>${b}</div>`).join("")}</div>
   <div class="card">The QAK issuer is blackholed after launch, so no more QAK can be minted and the issuer cannot seize a balance on the ledger. "Seized" here is an app rule applied against a published balance. It is not a ledger clawback, and nothing is burned. <b>QAK has no buy or sell tax.</b> Buys outside the app are untaxed. QAK is never the lent asset and never the lender receipt.</div>
   <h2>Tokenomics</h2><div class="card"><p>QAK is created on ${K.venue} in ${K.mint}. Supply is <b>${n(K.supply)}</b>, fixed. Half is sold into the opening pool. The other half is the issuer allocation, earmarked before launch.</p>
   <table><tr><th>Bucket</th><th>Of supply</th><th>Tokens</th><th>Use</th></tr>${K.buckets.map(b=>`<tr><td>${b.name}</td><td>${b.pct}%</td><td>${n(b.tokens)}</td><td>${b.use}</td></tr>`).join("")}</table></div>
   <div class="card"><h3>Escrow</h3><p>${K.venue} escrows the whole 500,000,000 QAK issuer allocation.</p><table>${K.escrow.map(e=>`<tr><td>${e.name}</td><td>${e.pct}%</td><td>${n(e.tokens)} QAK</td><td>${e.when}</td></tr>`).join("")}</table></div>
   <div class="card"><h3>Fair launch settings</h3>Initial liquidity: ${K.fairLaunch.liquidityXrp} XRP (form minimum ${K.fairLaunch.formMinXrp} XRP), with the XRP side burned. AMM pool fee: ${K.fairLaunch.ammFeePct}%. Anti-sniper launch: on, for ${K.fairLaunch.antiSniperMin} minutes. ${K.venue} takes a temporary deposit to cover protocol fees and reserves, and returns what remains at the end of the ${K.fairLaunch.antiSniperMin} minutes. The issuer is blackholed after launch.</div>`; },
  status: ()=>`<h1>Amendment status</h1><p>Checked ${AMENDMENTS.checked} via ${AMENDMENTS.method}.</p><table><tr><th>Amendment</th><th>Mainnet</th><th>Testnet</th><th>Devnet</th></tr>
   ${AMENDMENTS.items.map(a=>`<tr><td>${a.name} (${a.xls})</td><td class="off">${a.mainnet}</td><td class="off">${a.testnet}</td><td class="on">${a.devnet}</td></tr>`).join("")}</table>
   <p><button id="recheck">Re-check live now</button> <span id="live"></span></p>
   <div class="card"><h3>Gated transactions (OFF)</h3>${GATED_TXS.join(", ")}<br>Flag VITE_ENABLE_VAULT_LENDING=${CONFIG.enableVaultLending}. A devnet path is possible because both amendments are enabled there, but it is not wired up in v1. Mainnet sends are hard-off.</div>
   <div class="card">RLUSD mainnet issuer ${RLUSD.mainnetIssuer}, testnet issuer ${RLUSD.testnetIssuer} (docs.ripple.com).</div>`,
};
const AMEND_IDX="7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4";
const viaHttp=async(url)=>{ const r=await (await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({method:"ledger_entry",params:[{index:AMEND_IDX,ledger_index:"validated"}]})})).json(); return r.result.node.Amendments||[]; };
const viaWs=(url)=>new Promise((res,rej)=>{ let ws; const t=setTimeout(()=>{ try{ws.close();}catch{} rej(new Error("timeout")); },10000);
  try{ ws=new WebSocket(url); }catch(e){ clearTimeout(t); return rej(e); }
  ws.onopen=()=>ws.send(JSON.stringify({id:1,command:"ledger_entry",index:AMEND_IDX,ledger_index:"validated"}));
  ws.onmessage=(m)=>{ clearTimeout(t); try{ const d=JSON.parse(m.data); ws.close(); d.result?.node ? res(d.result.node.Amendments||[]) : rej(new Error(d.error||"bad response")); }catch(e){ rej(e); } };
  ws.onerror=()=>{ clearTimeout(t); rej(new Error("connection failed")); }; });
async function liveCheck(){ const el=document.getElementById("live"); if(el) el.textContent="checking…"; const out=[];
  for(const [net,url] of Object.entries(AMENDMENTS.servers)){ try{ const am=await (url.startsWith("wss:")?viaWs(url):viaHttp(url));
    out.push(net+": "+AMENDMENTS.items.map(a=>a.name+"="+(am.includes(a.id)?"enabled":"no")).join(" ")); }
    catch(e){ out.push(net+": live check unavailable from the browser right now"); } }
  const el2=document.getElementById("live"); if(el2) el2.textContent=out.join(" | "); }
function walletUI(){ const w=X.wallet, el=document.getElementById("wallet");
  el.innerHTML = w.account ? `<span>${esc(w.account.slice(0,8))}… · ${esc(w.network)}${w.mode==="preview"?" · preview":""}</span>
   <button class="sec" id="dc">Disconnect</button>${w.lastSign?` <span class="on">signed: ${esc(w.lastSign.signed)}</span>`:""}`
   : `<button id="cx">${X.hasKey()?"Connect Xaman":"Preview wallet"}</button>`;
  el.querySelector("#cx")?.addEventListener("click",()=>X.connect().catch(e=>alert(e.message)));
  el.querySelector("#sg")?.addEventListener("click",()=>X.signTest().catch(e=>alert(e.message)));
  el.querySelector("#dc")?.addEventListener("click",()=>X.disconnect()); }
const notFound=()=>`<h1>404: page not found</h1><p>There is no page at this address.</p><p><a class="btn" href="#/">Home</a></p>`;
const dec=(x)=>{ try{ return decodeURIComponent(x||""); }catch{ return ""; } };
function route(){ const [pg,arg]=location.hash.replace(/^#\/?/,"").split("/"); $(Object.hasOwn(pages,pg)?pages[pg](dec(arg)):notFound());
  document.getElementById("recheck")?.addEventListener("click",liveCheck);
  const f=document.getElementById("f"); if(f){ const upd=()=>{ const c=Number(f.drawCap.value)||0; document.getElementById("minfl").textContent=`Listing needs a ${n(RULES.LISTING_LOCK_QAK)} QAK lock. Cap at most ${n(RULES.INITIAL_CAP_RLUSD)} ${ASSET} for a first-time shop. Before the draw, holders must lock first-loss QAK worth at least ${RULES.FIRST_LOSS_PCT*100}% of ${n(c)} ${ASSET} (${n(c*RULES.FIRST_LOSS_PCT)} ${ASSET}), valued at the draw snapshot. QAK has no price before mint.`; };
    f.drawCap.addEventListener("input",upd); upd(); }
  if(f) f.onsubmit=(e)=>{ e.preventDefault(); const err=document.getElementById("err");
    try{ const p=S.apply(st,{...Object.fromEntries(new FormData(f)),account:X.wallet.account}); save(); location.hash="#/pool/"+encodeURIComponent(p.id); }
    catch(x){ err.textContent=x.message; } }; }
window.addEventListener("hashchange",route); window.addEventListener("wallet",()=>{walletUI();route();});
walletUI(); route(); X.init();
