// Verified facts (checked 2026-10-07). See README "Sources".
const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
export const CONFIG = {
  xamanApiKey: env.VITE_XAMAN_API_KEY || "",
  redirectUri: env.VITE_XAMAN_REDIRECT_URI || (typeof location !== "undefined" ? location.origin + "/" : ""),
  enableVaultLending: env.VITE_ENABLE_VAULT_LENDING === "true",
  enableMainnetSends: false, // hard-off in this build regardless of env
};
// RLUSD issuers from docs.ripple.com (token-addresses + rlusd-on-the-xrpl)
export const RLUSD = {
  currencyHex: "524C555344000000000000000000000000000000",
  mainnetIssuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
  testnetIssuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
};
export const ASSET = "RLUSD";
// QAK token on XRPL mainnet. Issuer status (flags, blackhole, obligations, escrows) is read live; never hardcoded.
export const QAK_ISSUER = "r98RkKUasH5vA3mshD5Bi3eAVHCYwziY9M";
export const QAK_CURRENCY = "QAK";
export const QAK_EXPLORER = "https://livenet.xrpl.org/accounts/" + QAK_ISSUER;
export const LEDGER_RPC = "https://xrplcluster.com/"; // mainnet; already in CSP connect-src
export const AMENDMENTS = {
  checked: "2026-10-07 10:33 EEST",
  method: "ledger_entry Amendments object (validated ledger) on public servers",
  items: [
    { name: "SingleAssetVault", xls: "XLS-65", id: "81BD2619B6B3C8625AC5D0BC01DE17F06C3F0AB95C7C87C93715B87A4FD240D8",
      mainnet: "not enabled (no majority)", testnet: "not enabled (no majority)", devnet: "enabled" },
    { name: "LendingProtocol", xls: "XLS-66", id: "565B90CA1AB2B9D42208ED10884188C64F9E19083DECB9634AAF06EB03299509",
      mainnet: "not enabled (no majority)", testnet: "not enabled (no majority)", devnet: "enabled" },
  ],
  servers: { mainnet: "https://xrplcluster.com/", testnet: "wss://s.altnet.rippletest.net:51233", devnet: "wss://s.devnet.rippletest.net:51233" }, // JSON-RPC on test/devnet has no CORS; WebSocket works from browsers
};
export const GATED_TXS = ["VaultCreate","VaultSet","VaultDeposit","VaultWithdraw","VaultDelete","VaultClawback",
  "LoanBrokerSet","LoanBrokerDelete","LoanBrokerCoverDeposit","LoanBrokerCoverWithdraw","LoanBrokerCoverClawback",
  "LoanSet","LoanDelete","LoanManage","LoanPay"];

// Credit rules. Whitepaper (public/qak-whitepaper.pdf, Oct 2026) values are marked WP; others are app rules where the WP is silent.
export const RULES = {
  TOTAL_SUPPLY_QAK: 1_000_000_000,   // WP: fixed, issuer blackholed after launch
  LISTING_LOCK_QAK: 250_000,         // WP: shop locks 250,000 QAK to be listed
  FIRST_LOSS_PCT: 0.15,              // app rule: first-loss QAK posted before the draw must be worth >= 15% of the cap at the draw snapshot
  QAK_SNAPSHOT_PRICE_RLUSD: null,    // WP: QAK is valued "at the snapshot". No QAK price exists before mint; supplied at draw/default time.
  PROTOCOL_FEE_BPS: 100,             // WP: 1.00% of interest paid, taken in RLUSD
  DISCOUNT_FEE_BPS: 75,              // WP: 0.75% ...
  DISCOUNT_MIN_HOLDING_QAK: 100_000, // WP: ... for an account holding at least 100,000 QAK
  COVER_SHARE_OF_FEES: 0.5,          // WP: half of protocol fees (+ seized stake) to the cover pot
  LIST_VOTE_THRESHOLD_QAK: 1000,     // app rule (WP: one QAK = one vote; threshold not defined)
  INITIAL_CAP_RLUSD: 2000,           // app rule
  MAX_CAP_RLUSD: 10000,              // WP: first pools at or under 10,000 RLUSD
  CAP_GROWTH_PCT: 0.5,               // app rule
  DEFAULT_GRACE_DAYS: 30,            // app rule
};
// Input bounds for applications (app rules).
export const LIMITS = { RATE_MIN_PCT: 0, RATE_MAX_PCT: 36, TERM_MIN_DAYS: 7, TERM_MAX_DAYS: 180, NAME_MAX: 60, LOG_MAX: 300 };
export const TOKENOMICS = {
  venue: "FirstLedger", mint: "Q4 2026", supply: 1_000_000_000,
  buckets: [
    { name: "Public pool", pct: 50, tokens: 500_000_000, use: "Opening liquidity against 50 XRP. The XRP side is burned." },
    { name: "Team", pct: 10, tokens: 100_000_000, use: "Founder, CTO and developers. Comes out of the issuer allocation." },
    { name: "Marketing", pct: 20, tokens: 200_000_000, use: "Listings, content and the shop desk. Comes out of the issuer allocation." },
    { name: "AMM", pct: 20, tokens: 200_000_000, use: "Added to the QAK/XRP pool after unlock. Comes out of the issuer allocation." },
  ],
  escrow: [
    { name: "Escrow 1", pct: 25, tokens: 125_000_000, when: "Delivered 24 hours after creation (fixed)." },
    { name: "Escrow 2", pct: 75, tokens: 375_000_000, when: "Date at least one month after the form is signed." },
  ],
  fairLaunch: { liquidityXrp: 50, formMinXrp: 25, ammFeePct: 1, antiSniperMin: 15 },
};
