// Review 2026-10-12: Xaman wallet flows with a mocked `xumm` SDK (no network). Run: node test/review.wallet.test.js
import assert from "node:assert"; import { register } from "node:module";
import { t, done } from "./harness.js";
register("./xumm-mock-loader.mjs", import.meta.url);
globalThis.window = { dispatchEvent() {}, open() {} };
const { CONFIG } = await import("../src/config.js"); const P = await import("../src/payloads.js");
CONFIG.xamanApiKey = "12345678-1234-1234-1234-123456789abc"; // fake public key, mock SDK only
const X = await import("../src/xaman.js");
const ME = "rBZaALm7orN4fVnYDmpE4treWZS4x4oQXG", OTHER = "rKHEGNQoWpvwqqsfcoQYpDQAgJFhV5qXKq", ID = "C".repeat(64);
let sent = null; const mock = (signed, account) => { globalThis.__xumm = {
  user: { get account() { return Promise.resolve(ME); }, get networkType() { return Promise.resolve("DEVNET"); } },
  payload: { async createAndSubscribe(p) { sent = p; return { created: { uuid: "u1", next: {} }, resolved: Promise.resolve({ signed }) }; },
    async get() { return { response: { txid: "T".repeat(64), hex: "12", account } }; } } }; };
mock(false, ME); await X.connect();
await t("Xaman PKCE flow uses the public API key only (no secret in config)", () => { assert(X.hasKey()); assert(!("xamanApiSecret" in CONFIG)); assert.equal(X.wallet.account, ME); });
await t("Xaman cancel: signed:false, nothing reported as signed", async () => {
  mock(false, ME); const r = await X.signTx({ TransactionType: "LoanPay" }, "devnet"); assert.equal(r.signed, false); assert.equal(r.txid, null);
});
await t("mainnet/testnet sign requests are refused before Xaman is called", async () => {
  sent = null; for (const n of ["mainnet", "testnet", "nope"]) await assert.rejects(X.signTx({ TransactionType: "VaultDeposit" }, n), /not enabled/); assert.equal(sent, null);
});
await t("payload is forced to DEVNET", async () => { mock(true, ME); await X.signTx({ TransactionType: "LoanPay" }, "devnet"); assert.equal(sent.options.force_network, "DEVNET"); });
await t("wrong account: a payload signed by another account is rejected [BUG xaman.js:36-37]", async () => {
  mock(true, OTHER); let r, err = null; try { r = await X.signTx({ TransactionType: "LoanPay" }, "devnet"); } catch (e) { err = e; }
  assert(err || r?.signed === false, `signed by ${OTHER} while connected as ${ME}: accepted as signed (txid ${r?.txid?.slice(0, 6)}…)`);
});
await t("wrong account: the sign request pins the expected signer (options.signers) [BUG xaman.js:49]", async () => {
  mock(true, ME); await X.signTx({ TransactionType: "LoanPay" }, "devnet"); assert.deepEqual(sent.options.signers, [ME], "no signer restriction in the payload");
});
await t("missing second signature on LoanSet: the broker-signed LoanSet is not submitted and cannot pass the completeness check", async () => {
  mock(true, ME); const tx = P.loanSet({ LoanBrokerID: ID, Counterparty: OTHER, PrincipalRequested: 10, terms: { InterestRate: 1000, PaymentTotal: 2, PaymentInterval: 240, GracePeriod: 60 } });
  await X.signTx(tx, "devnet", { submit: false }); assert.equal(sent.options.submit, false); assert.throws(() => P.assertLoanSetComplete(tx), /temBAD_SIGNER/);
});
done("test/review.wallet.test.js");
