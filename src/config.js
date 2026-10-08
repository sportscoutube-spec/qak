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
// Devnet stand-in for RLUSD (RLUSD does not exist on devnet). A distinct, clearly labelled TEST token: "DUSD" as a 160-bit code.
// It is NOT RLUSD and has no value. Its issuer comes from VITE_DEVNET_TEST_ISSUER (public address only).
export const DEVNET_TEST_CURRENCY = "4455534400000000000000000000000000000000"; // "DUSD"
export const DEVNET_TEST_TICKER = "DUSD";

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
    asset: { label: "RLUSD", unit: "RLUSD", currency: RLUSD_CURRENCY, issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", test: false } },
  testnet: { label: "Testnet", xaman: "TESTNET", rpc: "https://testnet.xrpl-labs.com/", vaultLending: false,
    offReason: "Testnet: status only in this build.",
    asset: { label: "RLUSD (testnet)", unit: "RLUSD", currency: RLUSD_CURRENCY, issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV", test: true } },
  devnet: { label: "Devnet", xaman: "DEVNET", rpc: "https://devnet.xrpl-labs.com/", vaultLending: true, offReason: "",
    // RLUSD does not exist on devnet, so devnet uses a self-issued TEST token with its own currency code (DUSD), never the RLUSD code.
    // Set VITE_DEVNET_TEST_ISSUER to that test issuer's address. Empty = devnet actions stay disabled.
    asset: { label: "DUSD devnet test token (not RLUSD)", unit: "DUSD (devnet test token)", currency: DEVNET_TEST_CURRENCY, issuer: env.VITE_DEVNET_TEST_ISSUER || "", test: true,
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
// Completed devnet end-to-end run of the XLS-65/66 flow on the DUSD devnet test token (record from the test script, 8 Oct 2026).
// Shown on the Status page as "Devnet test run". The vaults, brokers and loans were deleted at the end; the tx hashes stay on devnet until a reset.
export const DEVNET_TEST_RUN = {"when":"8 Oct 2026, 10:08–10:23 EEST","explorer":"https://devnet.xrpl.org","issuer":"rHprdcgDE8VM5PgjPjKGMjZGWGh98V4CHp","assetLabel":"DUSD devnet test token (not RLUSD)","note":"Expected rejections (tecEXPIRED, tecTOO_SOON) are deliberate negative tests. The vaults, brokers and loans were deleted at the end, so only the transactions remain.","runs":[
  {"title":"Run A: full lifecycle (cap 1,000 DUSD, 36% APR, 3 × 120 s)","VaultID":"EE7B93B45FA3EB44D40D2ADD6FE38AD75416887FFF73B37106EAB5BD4359DFBF","LoanBrokerID":"96C8E5B92C3B4E07888D32F813C72C07848F60AD63CE7CD6F6326D78626A5E19","LoanID":"64E379A2509125D64C0E8B28145D0F0EDA2736D2D070C637D7E09AD2092F21FD","summary":"Two lenders deposited 600 and 399.98 DUSD; LoanSet 999.97 DUSD; three on-time LoanPay; after RedemptionDate they redeemed 600.0016273815 and 399.9810848668 DUSD (interest net of the 1% management fee).","steps":[
    {"step":"VaultCreate","result":"tesSUCCESS","ok":true,"hash":"068C36EBB5AC09254AAEC543D08826429D83DA2F3E2C5F67EAAB99B5FC1CA3D9"},
    {"step":"LoanBrokerSet","result":"tesSUCCESS","ok":true,"hash":"5B596C188AC963D5BC3B0D34E7EBEE45297A4D8135BF31B57EC510EF94B5EE2F"},
    {"step":"LoanBrokerCoverDeposit","result":"tesSUCCESS","ok":true,"hash":"7887C04C21CBCA06AADC6FF8D74C8EA18969AFA67A1133C040956143387CCFDE"},
    {"step":"VaultDeposit lender1","result":"tesSUCCESS","ok":true,"hash":"6DEE578CE373B8B11720E78DBB441620D3470A2C330858C43770F2C5E4BA3184"},
    {"step":"VaultDeposit lender2","result":"tesSUCCESS","ok":true,"hash":"29DCFA2EAE90128E25B33516FA51E1CCA001CF39E64BA6B3764FB47F4E91C3A9"},
    {"step":"VaultDeposit late (rejected)","result":"tecEXPIRED","ok":true,"hash":"7E413DC96D72A3BA01FF40AD7CF83C54A2856C706D13B88B90FFD2A8E7971317"},
    {"step":"LoanSet","result":"tesSUCCESS","ok":true,"hash":"5234AE96AED797AC9CF763BAB460F9E048155D12DCD669107A595299250721F9"},
    {"step":"VaultWithdraw early (rejected)","result":"tecTOO_SOON","ok":true,"hash":"99F22E215E1911034D3938271F2AC3B5B1389DB8C5F8D3E0701829AD21756FEE"},
    {"step":"LoanPay 1","result":"tesSUCCESS","ok":true,"hash":"BF018D862E09C192AD814B8CD7FE7C532DECD79AD9B7A046522E53A7768324C0"},
    {"step":"LoanPay 2","result":"tesSUCCESS","ok":true,"hash":"5C89F4D41488D872E1EC51ACB284DE4D4B8AF88ECE22FBC629FD25E2BBBE10C5"},
    {"step":"LoanPay 3","result":"tesSUCCESS","ok":true,"hash":"C28F701025C1C60EF0A232D0E2A6E1223454E5D830157E671892745BA7720FF2"},
    {"step":"LoanDelete","result":"tesSUCCESS","ok":true,"hash":"E0BDAF25B885393FAE1242628AE508A4E2FB6F4CA326FC9E940DADF29DBA23C6"},
    {"step":"VaultWithdraw lender1","result":"tesSUCCESS","ok":true,"hash":"00FF35D61B68AF4F17030C32AE6F6C2527AC39CCB574BC8453696726797D7F7E"},
    {"step":"VaultWithdraw lender2","result":"tesSUCCESS","ok":true,"hash":"F4786AD4E88B390B26C011F441CD4E5889DC5C08D6E61CC1BAE189858AC0C290"},
    {"step":"LoanBrokerCoverWithdraw","result":"tesSUCCESS","ok":true,"hash":"A1B86884B37795D7FF3DAE053A1926ACD85E4870D1F1D4CB5AA398F3FBF9D05A"},
    {"step":"LoanBrokerDelete","result":"tesSUCCESS","ok":true,"hash":"DA1910C12361E8407EB48E50DFE5B674D7EDD6439895D4B404ED845C21BE34FF"},
    {"step":"VaultDelete","result":"tesSUCCESS","ok":true,"hash":"04B565C2F8C5F3630C04CC9C706F3FDE08DD7095C7EC7741B66E841C8C8D003A"}]},
  {"title":"Run B: missed payment, impair, default (cap 1,000 DUSD, 2 × 60 s, grace 60 s)","VaultID":"3CAE917B66970B98EBFA748259EAC46B7DB61C9520D09DE3ED7AB9975483E7BD","LoanBrokerID":"A0A1FBCF300FF2C7B438DCFDE217161BA7038DB3A57D936DF6C1FAE8FE2D98B8","LoanID":"56952E23C35824713D4314F07214E8CDB4499646015BF353C41B215AB9504445","summary":"Default moved 149.9955 DUSD of cover into the vault = min(DebtTotal 999.97 × 15% × 100%, DefaultAmount, CoverAvailable 200); 849.9745 DUSD was written down. The lender redeemed 150.0055000000 of 999.98 DUSD.","steps":[
    {"step":"VaultCreate","result":"tesSUCCESS","ok":true,"hash":"D6FEC7810CF5E964705DF6829486F0E2951B55B0385519923FC55E7644C47D9F"},
    {"step":"LoanBrokerSet","result":"tesSUCCESS","ok":true,"hash":"F95A70F80B2A44A161FF536D767B65E52B2E6058269ECADFFF5FFA1299F6CDDE"},
    {"step":"LoanBrokerCoverDeposit","result":"tesSUCCESS","ok":true,"hash":"5A0852220CCA8B66D02C12917E91409C766182B4F8983338A54541F7C393185A"},
    {"step":"VaultDeposit lender1","result":"tesSUCCESS","ok":true,"hash":"61A84601A982E809B09D35AF32EAEA2D7844A6960BE10A3A008673CCF7A8C600"},
    {"step":"VaultDeposit late (rejected)","result":"tecEXPIRED","ok":true,"hash":"83571DB089126C14733A2DA16554807B3F344243DE2387D96A65AFFB0521001E"},
    {"step":"LoanSet","result":"tesSUCCESS","ok":true,"hash":"B71970D2F807DEA7E0FA9B6F336D0BF25149921D4F322781AE7AA3D06A6F4984"},
    {"step":"LoanManage impair early (rejected)","result":"tecTOO_SOON","ok":true,"hash":"D2337E322DDF8E94BC4C66D843DEBDBEFE71E7236F5C76BC1C1F5B7D9284603A"},
    {"step":"LoanManage impair","result":"tesSUCCESS","ok":true,"hash":"17CC128148918737A3B182835AD1BC8AF03A4AEC1EAD6DB19687C3826941DBAA"},
    {"step":"LoanManage default early (rejected)","result":"tecTOO_SOON","ok":true,"hash":"28B10DFDAAE0F7278DB1EAEB3A2B4941EF4B29572AE08EC4684BC918A6270886"},
    {"step":"LoanManage default","result":"tesSUCCESS","ok":true,"hash":"20F8451C8D5F4A8BF5182823962A56D49FD133EFFE0C3F6FB44DEE7BB4284996"},
    {"step":"VaultWithdraw lender3","result":"tesSUCCESS","ok":true,"hash":"B6262D1425CD94FD17EE9343605AE60543838C2B9E7756A318DBE87E7AA2A7E0"},
    {"step":"LoanDelete","result":"tesSUCCESS","ok":true,"hash":"AEB85E40A062CC56C73DD6FD2C2C3BAD03F55DFD4957700456EDF576703D1139"},
    {"step":"LoanBrokerCoverWithdraw","result":"tesSUCCESS","ok":true,"hash":"E8DCE4792BEC670FBEFA1584C4D227E21741DF422D974150667E18DB059151A7"},
    {"step":"LoanBrokerDelete","result":"tesSUCCESS","ok":true,"hash":"85366DE43004BEDCBB573CF5C49709A3DFB17ABC8CB00750E6042EFF72BAFC58"},
    {"step":"VaultDelete","result":"tesSUCCESS","ok":true,"hash":"287C76E2135A8CBA3BA81597606EAAF4C4DEACDDB62D8E91F739F932B6651C65"}]}]};
