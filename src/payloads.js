// Unsigned XLS-65/66 transaction JSON for Xaman sign requests. Field and flag names are copied from the spec text.
// Xaman fills Account, Sequence and Fee. Nothing here signs or submits.
import { SPEC, FLAGS, RULES as R } from "./config.js";
import { checkVaultDates, validateLoanTerms } from "./state.js";
const req = (c, m) => { if (!c) throw new Error(m); };
const isId = (x) => typeof x === "string" && /^[0-9A-F]{64}$/.test(x);
const isAcct = (x) => typeof x === "string" && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(x);
// IOU value string: up to 6 decimals, no exponent, no trailing zeros.
export const value = (x) => { const n = Number(x); req(Number.isFinite(n) && n > 0, "amount must be > 0"); return n.toFixed(6).replace(/\.?0+$/, ""); };
const iou = (asset, x) => { req(asset && asset.issuer && isAcct(asset.issuer), "asset issuer not set"); return { currency: asset.currency, issuer: asset.issuer, value: value(x) }; };

// VaultCreate (XLS-65 §3.2 + 65.1.4): closed-ended vault on an IOU, AssetsMaximum = cap, Scale for an IOU (0..18).
export function vaultCreate({ asset, AssetsMaximum, Scale = R.VAULT_SCALE, SubscriptionDate, RedemptionDate, nonTransferable = R.SHARE_NON_TRANSFERABLE, now }) {
  req(asset && isAcct(asset.issuer), "asset issuer not set");
  req(Number.isInteger(Scale) && Scale >= SPEC.SCALE_MIN && Scale <= SPEC.SCALE_MAX, "Scale must be 0..18 for an IOU");
  checkVaultDates(SubscriptionDate, RedemptionDate, now);
  return { TransactionType: "VaultCreate", Flags: nonTransferable ? FLAGS.tfVaultShareNonTransferable : 0,
    Asset: { currency: asset.currency, issuer: asset.issuer }, AssetsMaximum: value(AssetsMaximum), Scale,
    VaultKind: SPEC.VaultKind.ClosedEnded, SubscriptionDate, RedemptionDate };
}
// LoanBrokerSet (XLS-66 §3.3), create: VaultID, ManagementFeeRate (fixed after creation), DebtMaximum, cover rates (both 0 or both non-zero).
export function loanBrokerSet({ VaultID, ManagementFeeRate, DebtMaximum, CoverRateMinimum = R.COVER_RATE_MINIMUM, CoverRateLiquidation = R.COVER_RATE_LIQUIDATION }) {
  req(isId(VaultID), "VaultID required");
  req(Number.isInteger(ManagementFeeRate) && ManagementFeeRate >= 0 && ManagementFeeRate <= SPEC.MAX_MANAGEMENT_FEE_RATE, "ManagementFeeRate must be 0..10000 (temINVALID)");
  for (const [k, v] of [["CoverRateMinimum", CoverRateMinimum], ["CoverRateLiquidation", CoverRateLiquidation]]) req(Number.isInteger(v) && v >= 0 && v <= SPEC.MAX_RATE, `${k} must be 0..100000 (temINVALID)`);
  req((CoverRateMinimum === 0) === (CoverRateLiquidation === 0), "CoverRateMinimum and CoverRateLiquidation must both be zero or both non-zero (temINVALID)");
  return { TransactionType: "LoanBrokerSet", VaultID, ManagementFeeRate, DebtMaximum: value(DebtMaximum), CoverRateMinimum, CoverRateLiquidation };
}
// LoanBrokerCoverDeposit (§3.5): only the broker owner; Amount must be the vault asset (else tecWRONG_ASSET).
export function loanBrokerCoverDeposit({ LoanBrokerID, asset, amount }) {
  req(isId(LoanBrokerID), "LoanBrokerID required"); return { TransactionType: "LoanBrokerCoverDeposit", LoanBrokerID, Amount: iou(asset, amount) };
}
// VaultDeposit (XLS-65 §3.5): VaultID + Amount in the vault asset. Returns vault MPT shares.
export function vaultDeposit({ VaultID, asset, amount }) {
  req(isId(VaultID), "VaultID required"); return { TransactionType: "VaultDeposit", VaultID, Amount: iou(asset, amount) };
}
// LoanSet (§3.8), broker-initiated (§3.8.3): the broker signs first with Counterparty = the shop; the shop then fills CounterpartySignature.
export function loanSet({ LoanBrokerID, Counterparty, PrincipalRequested, terms, fees = {} }) {
  req(isId(LoanBrokerID), "LoanBrokerID required"); req(isAcct(Counterparty), "Counterparty (the shop account) required");
  const t = { ...terms, PrincipalRequested: Number(PrincipalRequested) }; const e = validateLoanTerms(t); req(e.length === 0, e.join("; "));
  return { TransactionType: "LoanSet", Flags: 0, LoanBrokerID, Counterparty, PrincipalRequested: value(PrincipalRequested),
    InterestRate: t.InterestRate, PaymentTotal: t.PaymentTotal, PaymentInterval: t.PaymentInterval, GracePeriod: t.GracePeriod,
    LoanOriginationFee: String(fees.LoanOriginationFee ?? "0"), LoanServiceFee: String(fees.LoanServiceFee ?? "0"),
    LatePaymentFee: String(fees.LatePaymentFee ?? "0"), ClosePaymentFee: String(fees.ClosePaymentFee ?? "0"),
    OverpaymentFee: 0, LateInterestRate: 0, CloseInterestRate: 0, OverpaymentInterestRate: 0 };
}
// Attach the counterparty's signature (§3.8.1.1): exactly one of {SigningPubKey + TxnSignature} or {Signers (+ optional empty SigningPubKey)}.
export function withCounterpartySignature(tx, sig) {
  req(tx && tx.TransactionType === "LoanSet", "not a LoanSet");
  const pair = !!(sig && sig.SigningPubKey && sig.TxnSignature), multi = !!(sig && Array.isArray(sig.Signers) && sig.Signers.length);
  req(pair !== multi, "CounterpartySignature needs exactly one of SigningPubKey+TxnSignature or Signers");
  const CounterpartySignature = pair ? { SigningPubKey: sig.SigningPubKey, TxnSignature: sig.TxnSignature } : { Signers: sig.Signers, ...(sig.SigningPubKey === "" ? { SigningPubKey: "" } : {}) };
  return { ...tx, CounterpartySignature };
}
// A LoanSet outside a Batch without CounterpartySignature fails temBAD_SIGNER (§3.8.5.1 #2).
export function assertLoanSetComplete(tx) { req(tx && tx.CounterpartySignature, "LoanSet without CounterpartySignature fails (temBAD_SIGNER)"); return true; }
// LoanPay (§3.11): the shop pays a fixed installment. Late payments need tfLoanLatePayment.
export function loanPay({ LoanID, asset, amount, late = false }) {
  req(isId(LoanID), "LoanID required"); return { TransactionType: "LoanPay", LoanID, Amount: iou(asset, amount), Flags: late ? FLAGS.tfLoanLatePayment : 0 };
}
// LoanManage (§3.10): broker owner only; flags are mutually exclusive.
export function loanManage({ LoanID, action }) {
  req(isId(LoanID), "LoanID required");
  const f = { default: FLAGS.tfLoanDefault, impair: FLAGS.tfLoanImpair, unimpair: FLAGS.tfLoanUnimpair }[action]; req(f, "action must be default, impair or unimpair");
  return { TransactionType: "LoanManage", LoanID, Flags: f };
}
// LoanDelete (§3.9): borrower or broker owner, only when PaymentRemaining == 0.
export function loanDelete({ LoanID }) { req(isId(LoanID), "LoanID required"); return { TransactionType: "LoanDelete", LoanID }; }
