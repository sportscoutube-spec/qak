// Xaman (formerly Xumm) via the Universal SDK `xumm` (browser = OAuth2 PKCE flow, public API key only; the API secret is never used).
// Scope: connect, read address + network, a SignIn test payload, and sign requests for XLS-65/66 transactions on an allowed network.
// Xaman support for XLS-65/66 transaction types is NOT verified: Xaman's docs say transaction types from amendments that are not
// enabled on mainnet may be unavailable. DEVNET is listed in Xaman's network rails, so payloads use options.force_network = "DEVNET".
// Xaman does not document producing a LoanSet CounterpartySignature, so the second LoanSet signature cannot be collected here.
// EscrowCreate is a long-standing mainnet transaction type; Xaman's developer docs state it accepts all mainnet XRPL transaction types.
import { CONFIG, NETWORKS } from "./config.js";
let sdk = null;
export const wallet = { mode: "disconnected", account: null, network: null, lastSign: null };
const emit = () => window.dispatchEvent(new Event("wallet"));
export const hasKey = () => /^[0-9a-f-]{36}$/i.test(CONFIG.xamanApiKey) && !/^0{8}-/.test(CONFIG.xamanApiKey);
export const XAMAN_SUPPORT = {
  forceNetwork: "DEVNET is a key in Xaman's network rails, so a payload can set options.force_network: \"DEVNET\".",
  txTypes: "Not verified. Xaman's docs: transaction types for amendments that are not voted in on mainnet may be unavailable. If Xaman rejects a payload, the error is shown.",
  escrow: "EscrowCreate (the borrower's XRP escrow to the broker) is a standard mainnet transaction type. Xaman's developer docs say Xaman accepts all mainnet XRPL transaction types, so it is supported; the Condition is a plain hex field.",
  counterparty: "Not available. Xaman does not document signing a LoanSet CounterpartySignature, so the borrower's counter-signature cannot be collected in this app. Note: with fixCleanup3_4_0 enabled (devnet), the counter-signature must use the counterparty hash prefix \"CPT\\0\" (0x43505400), not the normal \"STX\\0\"; a plain transaction signature is rejected as a bad signature (seen in the devnet test run).",
};

async function load() {
  if (sdk) return sdk;
  const { Xumm } = await import("xumm");
  sdk = new Xumm(CONFIG.xamanApiKey); // redirect URI must be whitelisted in apps.xaman.dev
  sdk.on("success", refresh); sdk.on("retrieved", refresh); sdk.on("logout", () => { Object.assign(wallet, { mode: "disconnected", account: null, network: null }); emit(); });
  return sdk;
}
async function refresh() { wallet.account = await sdk.user.account; wallet.network = (await sdk.user.networkType) || "unknown"; wallet.mode = "xaman"; emit(); }
export async function init() { if (hasKey()) { try { await load(); } catch (e) { console.warn(e); } } }
export async function connect() { if (!hasKey()) return connectMock(); await load(); await sdk.authorize(); await refresh(); }
// Mock wallet: used only when no Xaman API key is configured. It never signs or submits anything.
export function connectMock() { if (hasKey()) throw new Error("real Xaman configured"); Object.assign(wallet, { mode: "mock", account: "rPREVIEWxxxxxxxxxxxxxxxxxxxxxxxxx", network: "mock" }); emit(); }
export async function disconnect() { if (wallet.mode === "xaman") await sdk.logout(); Object.assign(wallet, { mode: "disconnected", account: null, network: null, lastSign: null }); emit(); }
// expect = the connected account: the payload pins it (txjson.Account + options.signers, both supported by the Xaman payload API),
// and the signed result is checked against it, so a signature from another account in Xaman is never treated as signed.
async function run(txjson, options, instruction, expect = null) {
  if (expect) { if (txjson.Account && txjson.Account !== expect) throw new Error(`payload Account ${txjson.Account} is not the connected account ${expect}`);
    if (txjson.TransactionType !== "SignIn") txjson = { ...txjson, Account: expect }; options = { ...options, signers: [expect] }; }
  const sub = await sdk.payload.createAndSubscribe({ txjson, options, custom_meta: { instruction } }, (ev) => { if ("signed" in ev.data) return ev.data; });
  if (!sub || !sub.created) throw new Error("Xaman did not create the sign request (transaction type or network may be unsupported)");
  if (sub.created.next?.always) window.open(sub.created.next.always, "_blank", "noopener");
  const r = await sub.resolved; const res = r && r.signed ? await sdk.payload.get(sub.created.uuid) : null;
  const signer = res?.response?.account || null;
  if (r && r.signed && expect && signer !== expect) throw new Error(`signed by ${signer || "an unknown account"}, not the connected account ${expect}: ignored`);
  return { signed: !!(r && r.signed), uuid: sub.created.uuid, account: signer, txid: res?.response?.txid || null, hex: res?.response?.hex || null };
}
export async function signTest() {
  if (wallet.mode === "mock") { wallet.lastSign = { mock: true, signed: false, note: "mock: nothing signed" }; emit(); return wallet.lastSign; }
  // SignIn is a Xaman pseudo-transaction: proves address control, never submitted to the ledger.
  wallet.lastSign = await run({ TransactionType: "SignIn" }, {}, "Duck Bank sign-in test"); emit(); return wallet.lastSign;
}
// Sign request for an XLS-65/66 transaction or the escrow-path EscrowCreate on `net`. submit=false returns the signed blob without submitting (used for the first LoanSet signature).
export async function signTx(txjson, net, { submit = true, instruction = "" } = {}) {
  const n = NETWORKS[net]; if (!n || !n.vaultLending) throw new Error("this network is not enabled for vault lending in this build");
  if (wallet.mode === "mock") return { mock: true, signed: false, note: "mock: nothing signed or submitted", txjson };
  if (wallet.mode !== "xaman") throw new Error("connect Xaman first");
  return run(txjson, { force_network: n.xaman, submit }, instruction || `Duck Bank: ${txjson.TransactionType} on ${n.label}`, wallet.account);
}
// Lifetime access fee: a QAK Payment, and QAK exists only on mainnet. Same rule as every other payload in this build: Xaman signing is
// allowed only on a network whose `vaultLending` flag is on, and mainnet is hard-off. So this payload is built and shown, but not
// sent to Xaman, until mainnet is enabled in a later build; paying from any other wallet counts, because the check reads the ledger.
export const ACCESS_SIGNING = () => NETWORKS.mainnet.vaultLending === true;
export async function signAccessFee(txjson) {
  if (!ACCESS_SIGNING()) throw new Error("mainnet signing is off in this build: the access payment cannot be sent through Xaman yet (the ledger check still counts a payment made from any wallet)");
  return signTx(txjson, "mainnet", { instruction: "Duck Bank lifetime access fee (QAK)" });
}
