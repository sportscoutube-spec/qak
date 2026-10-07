// Xaman (formerly Xumm) via the Universal SDK `xumm` (browser = OAuth2 PKCE flow).
// Scope in this build: connect, read address + network, sign a SignIn test payload. Nothing else.
import { CONFIG } from "./config.js";
let sdk = null;
export const wallet = { mode: "disconnected", account: null, network: null, lastSign: null };
const emit = () => window.dispatchEvent(new Event("wallet"));
export const hasKey = () => /^[0-9a-f-]{36}$/i.test(CONFIG.xamanApiKey) && !/^0{8}-/.test(CONFIG.xamanApiKey);

async function load() {
  if (sdk) return sdk;
  const { Xumm } = await import("xumm");
  sdk = new Xumm(CONFIG.xamanApiKey); // redirect URI must be whitelisted in apps.xaman.dev (VITE_XAMAN_REDIRECT_URI)
  sdk.on("success", refresh); sdk.on("retrieved", refresh); sdk.on("logout", () => { Object.assign(wallet,{mode:"disconnected",account:null,network:null}); emit(); });
  return sdk;
}
async function refresh() { wallet.account = await sdk.user.account; wallet.network = (await sdk.user.networkType) || "unknown";
  wallet.mode = "xaman"; emit(); }
export async function init() { if (hasKey()) { try { await load(); } catch (e) { console.warn(e); } } }
export async function connect() { if (!hasKey()) return connectPreview(); await load(); await sdk.authorize(); await refresh(); }
export function connectPreview() { if (hasKey()) throw new Error("real Xaman configured"); Object.assign(wallet,{ mode:"preview", account:"rPREVIEWxxxxxxxxxxxxxxxxxxxxxxxxx", network:"TESTNET" }); emit(); }
export async function disconnect() { if (wallet.mode==="xaman") await sdk.logout(); Object.assign(wallet,{mode:"disconnected",account:null,network:null,lastSign:null}); emit(); }
export async function signTest() {
  if (wallet.mode === "preview" && !hasKey()) { wallet.lastSign = { preview:true, signed:true, txid:null, note:"preview" }; emit(); return wallet.lastSign; }
  // SignIn is a Xaman pseudo-transaction: proves address control, never submitted to the ledger.
  const sub = await sdk.payload.createAndSubscribe({ TransactionType: "SignIn" }, (ev) => { if ("signed" in ev.data) return ev.data; });
  if (sub.created.next?.always) window.open(sub.created.next.always, "_blank");
  const r = await sub.resolved; wallet.lastSign = { signed: !!r.signed, payload: sub.created.uuid }; emit(); return wallet.lastSign;
}
