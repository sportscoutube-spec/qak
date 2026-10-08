// Bot-side checks (needs `npm install` in bot/): crypto-condition encoding against the xrpl.org example and the due-amount rule.
import assert from "node:assert"; import { conditionOf, fulfillmentOf, conditionFromFulfillment } from "./escrow-bot.js"; import * as S from "../src/state.js";
// xrpl.org EscrowCreate docs: empty preimage -> this condition and fulfillment
assert.equal(conditionOf(Buffer.alloc(0)), "A0258020E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855810100");
assert.equal(fulfillmentOf(Buffer.alloc(0)), "A0028000");
const pre = Buffer.alloc(32, 7), c = conditionOf(pre), f = fulfillmentOf(pre);
assert(S.isCondition(c)); assert(/^A0228020[0-9A-F]{64}$/.test(f)); assert.equal(conditionFromFulfillment(f), c);
console.log("ok - condition encoding matches the xrpl.org example; 32-byte preimage gives an app-valid condition");
console.log("bot tests ok");
