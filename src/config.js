// Duck Bank configuration. Ledger names below are copied from XLS-65 (Single Asset Vault, incl. 65.1.4 Closed-Ended Vault)
// and XLS-66 (Lending Protocol, incl. 66.1.2 Closed-Ended Loan Gates and 66.2). Product values are marked "app rule".
// Static per-key reads: Vite inlines only these three values (reading import.meta.env as an object would inline every VITE_* var).
// The try/catch keeps Node tests working, where import.meta.env is undefined.
const env = {
  VITE_XAMAN_API_KEY: (() => { try { return import.meta.env.VITE_XAMAN_API_KEY; } catch { return undefined; } })(),
  VITE_XAMAN_REDIRECT_URI: (() => { try { return import.meta.env.VITE_XAMAN_REDIRECT_URI; } catch { return undefined; } })(),
  VITE_DEVNET_TEST_ISSUER: (() => { try { return import.meta.env.VITE_DEVNET_TEST_ISSUER; } catch { return undefined; } })(),
};
export const PRODUCT = { name: "Duck Bank", token: "QAK", site: "https://trustline-tan.vercel.app" };
export const CONFIG = {
  xamanApiKey: env.VITE_XAMAN_API_KEY || "",
  redirectUri: env.VITE_XAMAN_REDIRECT_URI || (typeof location !== "undefined" ? location.origin + "/" : ""),
};
export const RIPPLE_EPOCH = 946684800; // seconds between 1970-01-01 and 2000-01-01 (XRPL time)
export const RLUSD_CURRENCY = "524C555344000000000000000000000000000000"; // "RLUSD" as a 160-bit currency code
export const ASSET = "RLUSD";

// Amendments that gate vault lending. Deposits and LoanSet stay disabled on a network until ALL of `required` are enabled there.
// fixCleanup3_4_0 is shown for information (it changes impairment timing and due-date boundaries, XLS-66.2).
export const AMENDMENTS = {
  required: ["SingleAssetVault", "LendingProtocol", "LendingProtocolV1_1"],
  info: ["fixCleanup3_4_0"],
  ids: {
    SingleAssetVault: "81BD2619B6B3C8625AC5D0BC01DE17F06C3F0AB95C7C87C93715B87A4FD240D8",
    LendingProtocol: "565B90CA1AB2B9D42208ED10884188C64F9E19083DECB9634AAF06EB03299509",
    LendingProtocolV1_1: "A360E2BFD775A5B0DCE1C36C16DF31B72735A57584FD163655D2F9564F8E7AC8",
    fixCleanup3_4_0: "98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76",
  },
  // Snapshot from the read-only `feature` RPC (plus the Amendments ledger object), 2026-10-08 09:13 EEST. The Status page re-checks live.
  snapshot: { checked: "2026-10-08 09:13 EEST",
    mainnet: { SingleAssetVault: false, LendingProtocol: false, LendingProtocolV1_1: false, fixCleanup3_4_0: false },
    testnet: { SingleAssetVault: false, LendingProtocol: false, LendingProtocolV1_1: false, fixCleanup3_4_0: false },
    devnet:  { SingleAssetVault: true,  LendingProtocol: true,  LendingProtocolV1_1: true,  fixCleanup3_4_0: true } },
};

// Per-network config. `vaultLending` is the feature flag for XLS-65/66 transactions on that network.
// Mainnet is hard-OFF in this build regardless of amendment status. Devnet is allowed once all three amendments are enabled there.
export const NETWORKS = {
  mainnet: { label: "Mainnet", xaman: "MAINNET", rpc: "https://xrplcluster.com/", vaultLending: false,
    offReason: "Mainnet: XLS-65/66 transactions are hard-off in this build. Mainnet deposits are not enabled.",
    asset: { label: "RLUSD", currency: RLUSD_CURRENCY, issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", test: false } },
  testnet: { label: "Testnet", xaman: "TESTNET", rpc: "https://testnet.xrpl-labs.com/", vaultLending: false,
    offReason: "Testnet: status only in this build.",
    asset: { label: "RLUSD (testnet)", currency: RLUSD_CURRENCY, issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV", test: true } },
  devnet: { label: "Devnet", xaman: "DEVNET", rpc: "https://devnet.xrpl-labs.com/", vaultLending: true, offReason: "",
    // DEVNET TEST-ISSUER PLACEHOLDER. RLUSD does not exist on devnet, so devnet uses a self-issued test IOU.
    // Set VITE_DEVNET_TEST_ISSUER to that test issuer's address. Empty = devnet actions stay disabled.
    asset: { label: "devnet test IOU (not RLUSD)", currency: RLUSD_CURRENCY, issuer: env.VITE_DEVNET_TEST_ISSUER || "", test: true,
      placeholder: "DEVNET_TEST_ISSUER_PLACEHOLDER (set VITE_DEVNET_TEST_ISSUER)" } },
};
export const LEDGER_RPC = NETWORKS.mainnet.rpc; // QAK reads are mainnet, read-only

// QAK token on XRPL mainnet. Issuer status (flags, blackhole, escrows) is read live; never hardcoded.
export const QAK_ISSUER = "r98RkKUasH5vA3mshD5Bi3eAVHCYwziY9M";
export const QAK_CURRENCY = "QAK";
export const QAK_EXPLORER = "https://livenet.xrpl.org/accounts/" + QAK_ISSUER;

// XLS-65/66 transaction names (spec §2.1 / §2). There is no LoanDraw: principal moves inside LoanSet.
export const GATED_TXS = ["VaultCreate","VaultSet","VaultDeposit","VaultWithdraw","VaultDelete","VaultClawback",
  "LoanBrokerSet","LoanBrokerDelete","LoanBrokerCoverDeposit","LoanBrokerCoverWithdraw","LoanBrokerCoverClawback",
  "LoanSet","LoanDelete","LoanManage","LoanPay"];

// Spec constants and flags (values copied from the spec text).
export const SPEC = {
  LOAN_REDEMPTION_BUFFER: 60,      // XLS-66.1.2 §3.1
  MIN_INVESTMENT_PERIOD: 180,      // XLS-65.1.4 §3.2
  MAX_INVESTMENT_PERIOD: 946708560,// XLS-65.1.4 §3.2 (exclusive)
  MIN_PAYMENT_INTERVAL: 60,        // XLS-66 §3.8.5.1 #15
  MIN_GRACE_PERIOD: 60,            // XLS-66 §3.8.5.1 #16 (and GracePeriod <= PaymentInterval)
  SECONDS_PER_YEAR: 31536000,      // XLS-66 A-2 (1)
  TENTH_BPS_100PCT: 100000,        // 1/10 bps units: 100000 = 100%
  MAX_MANAGEMENT_FEE_RATE: 10000,  // XLS-66 §3.3.3.1 #3
  MAX_RATE: 100000,                // InterestRate, CoverRateMinimum, CoverRateLiquidation upper bound
  SCALE_MIN: 0, SCALE_MAX: 18, SCALE_DEFAULT: 6, // XLS-65 §3.1.6.1.1 (IOU)
  VaultKind: { OpenEnded: 0, ClosedEnded: 1 },   // XLS-65.1.4 §3.1.1 (a field, not a flag)
};
export const FLAGS = {
  tfVaultPrivate: 0x00010000, tfVaultShareNonTransferable: 0x00020000,           // VaultCreate (XLS-65 §3.2.2)
  tfLoanOverpayment: 0x00010000,                                                  // LoanSet (XLS-66 §3.8.2)
  tfLoanDefault: 0x00010000, tfLoanImpair: 0x00020000, tfLoanUnimpair: 0x00040000, // LoanManage (§3.10.2)
  tfLoanPayOverpayment: 0x00010000, tfLoanFullPayment: 0x00020000, tfLoanLatePayment: 0x00040000, // LoanPay (§3.11.2)
  lsfLoanDefault: 0x00010000, lsfLoanImpaired: 0x00020000, lsfLoanOverpayment: 0x00040000,       // Loan (§3.2.3)
};

// Duck Bank rules (app rules unless marked otherwise).
export const RULES = {
  TOTAL_SUPPLY_QAK: 1_000_000_000,
  LISTING_LOCK_QAK: 250_000,          // app rule: QAK locked to list a shop (an app lock, not CoverAvailable)
  FEE_RATE: 1000,                     // ManagementFeeRate 1000 = 1.00% of interest (fixed at LoanBrokerSet)
  FEE_RATE_DISCOUNT: 750,             // ManagementFeeRate 750 = 0.75%, chosen at broker creation if the shop holds >= DISCOUNT_MIN_HOLDING_QAK
  DISCOUNT_MIN_HOLDING_QAK: 100_000,
  LIST_VOTE_THRESHOLD_QAK: 1000,      // app rule: one QAK = one vote; listing passes at >= 1,000 yes and yes > no
  MAX_CAP_RLUSD: 10_000,              // AssetsMaximum and DebtMaximum of a shop vault/broker
  COVER_RATE_MINIMUM: 15000,          // 15%: RLUSD cover required before LoanSet, as a share of DebtTotal (incl. interest)
  COVER_RATE_LIQUIDATION: 100000,     // 100%: up to the whole minimum cover is taken on default
  VAULT_SCALE: 6,                     // Scale for the RLUSD (IOU) vault; spec range 0..18, default 6
  SHARE_NON_TRANSFERABLE: true,       // VaultCreate with tfVaultShareNonTransferable: the vault MPT share can only be redeemed
  ROUNDING_MARGIN: 0.01,              // app rule: RLUSD kept back from the max principal for ledger rounding
};
// Input bounds for applications (app rules).
export const LIMITS = { RATE_MIN_PCT: 0, RATE_MAX_PCT: 36, PAYMENTS_MIN: 1, PAYMENTS_MAX: 12, INTERVAL_MIN_DAYS: 1, INTERVAL_MAX_DAYS: 90,
  TERM_MAX_DAYS: 180, NAME_MAX: 60, LOG_MAX: 300 };
const DAY = 86400;
// The first pool: one shop, one closed-ended vault, one broker, one loan. No ledger objects exist yet, so every id is null.
export const FIRST_POOL = {
  id: "first", shop: "Kostas Bakery", city: "Athens", purpose: "stock", sample: true, network: "devnet", stage: "applied",
  capRlusd: RULES.MAX_CAP_RLUSD,
  terms: { InterestRate: 10000, PaymentTotal: 3, PaymentInterval: 30 * DAY, GracePeriod: 7 * DAY }, // 10% APR, 3 x 30 days, 7-day grace
  plan: { subscriptionDays: 14, investmentDays: 100 },
};
export const TOKENOMICS = {
  venue: "FirstLedger", mint: "Q4 2026", supply: 1_000_000_000,
  buckets: [
    { name: "Public pool", pct: 50, tokens: 500_000_000, use: "Sold into the opening FirstLedger pool." },
    { name: "Team", pct: 10, tokens: 100_000_000, use: "McQAK, Donald QAK, Della and Huey QAK. Out of the escrowed issuer half." },
    { name: "Marketing", pct: 20, tokens: 200_000_000, use: "Listings, content and the shop desk. Out of the escrowed issuer half." },
    { name: "AMM", pct: 20, tokens: 200_000_000, use: "Added to the QAK/XRP AMM after unlock. Out of the escrowed issuer half." },
  ],
  escrow: [
    { name: "Escrow 1", tokens: 125_000_000, unlock: "8 Oct 2026 15:49 EEST" },
    { name: "Escrow 2", tokens: 375_000_000, unlock: "7 Nov 2026 16:24 EET" },
  ],
  launch: { liquidityXrp: 50, ammFeePct: 1, antiSniperMin: 15 },
};
export const TEAM = [
  { name: "McQAK", role: "Founder" }, { name: "Donald QAK", role: "CTO" },
  { name: "Della", role: "Marketing" }, { name: "Huey QAK", role: "Developer" },
];
export const ROADMAP = [
  { when: "Q4 2026", step: "Mint", what: "QAK issued on FirstLedger: 1,000,000,000 supply, 50 XRP starting liquidity, 1% AMM fee, 15-minute anti-sniper. Issuer blackholed; issuer half in two escrows." },
  { when: "Next", step: "Devnet vault and broker", what: "One shop: a closed-ended VaultCreate on a devnet test IOU, LoanBrokerSet, LoanBrokerCoverDeposit, VaultDeposit, a dual-signed LoanSet and LoanPay." },
  { when: "After all three amendments are enabled on mainnet", step: "Mainnet deposits", what: "SingleAssetVault, LendingProtocol and LendingProtocolV1_1 enabled on mainnet. Until then mainnet deposits stay off." },
];
