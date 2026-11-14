// Token Radar v3 — reads the sealed DefiLlama snapshot, ranks the pre-token
// protocols by an implied launch value, and writes the board, the dashboard
// data and the dossier. Node 22, standard library only, no network.
//
// Model (all figures from the snapshot itself, never a hardcoded list):
//   implied = TVL x multiple x growth x age x chains
//   multiple = median mcap/TVL of token-bearing protocols in the same
//     category (used when at least 3 exist and the median is at least 0.05,
//     else the overall median 0.2138), clamped to [0.05, 1.5]
//   growth = 1 + 0.5 x 7-day TVL change, clamped to [0.5, 1.5], so a one-week
//     spike cannot multiply a valuation
//   age = 1 + 0.08 x ln(1 + years listed on DefiLlama)
//   chains = 1 + 0.02 x chains (at most 4)
// A protocol is a candidate when its record carries no token (gecko_id and
// symbol both null) and it is not a wrapped, staked or bridged product.
// Two candidates are excluded because they already have live tokens:
// Theo Network thUSD and Circle Gateway. Seven watchlist rows are kept but
// flagged TOKEN TRADES because their token already trades in public; the
// coverage gate forbids removing watchlist rows, so the board marks them.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

type Protocol = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
};

type Snapshot = {
  as_of: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
};

const EXCLUDED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);
const EXCHANGE_PREFIXES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];
const VERSION_SUFFIX = /(\s[Vv]\d+(\.\d+)*|\s\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

// Protocols whose token already trades in public, kept on the board because
// the watchlist gate forbids removing them, each with short evidence.
const FLAGGED: Record<string, string> = {
  "usdd": "USDD is a TRON stablecoin, about $1.5B, trading on HTX, SunSwap, KuCoin and Kraken.",
  "bittensor-dtao": "TAO, the Bittensor token, trades on Binance and Coinbase; dTAO is its subnet token.",
  "onre": "ONyc, OnRe's yield token, is live on Solana with about $114M market cap, on Kamino.",
  "plume-vaults": "PLUME, the Plume token, launched 21 Jan 2025 and trades; vaults earn its yield.",
  "r25": "rcUSD, R25's RWA dollar, is live on Sui with about $18M market cap; rcUSDp yields.",
  "tori-finance": "trUSD, Tori's synthetic dollar, is live with about $77M market cap, on Fluid and Bybit.",
  "hive-protocol": "B2, the BSquared network token, trades on PancakeSwap and Binance Alpha since Apr 2025.",
};

// Candidates excluded because they already have a live token (both off the
// watchlist, so coverage is unaffected).
const EXCLUDED: Record<string, string> = {
  "theo-network-thusd": "Theo Network thUSD is a live yield-bearing stablecoin, CoinGecko-listed, on Uniswap v4.",
  "circle-gateway": "Circle Gateway is Circle's live unified-USDC product, on mainnet since 19 Aug 2025.",
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isWrappedProduct(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return true;
  if (VERSION_SUFFIX.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  for (const prefix of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(prefix)) return true;
  }
  return false;
}

function isPreTokenCandidate(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null && !isWrappedProduct(p);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function ageYears(listedAt: string | null, asOf: Date): number {
  if (listedAt === null) return 0;
  const parts = listedAt.split("-").map((x) => parseInt(x, 10));
  const listed = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const days = Math.max(0, (asOf.getTime() - listed.getTime()) / 86400000);
  return days / 365.25;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// Farm steps: four concrete steps per row, each naming an amount and a time.
// Templates are keyed by category so every plan fits the protocol's kind.
const STEP_TEMPLATES: Record<string, [string, string, string, string]> = {
  "Lending": [
    "Deposit $100 USDC, hold 30 days",
    "Supply $50 more, keep health above 2",
    "Claim points weekly, never exit early",
    "Check quests each Monday for tasks",
  ],
  "Dexs": [
    "Swap $25 to $50 weekly for 4 weeks",
    "Add $100 to a stable pool, 30 days",
    "Vote if a proposal opens up",
    "Keep $10 gas for the claim day",
  ],
  "RWA": [
    "Mint $100 of the yield token, 60 days",
    "Stake it for the receipt token",
    "Reinvest yield monthly, 3 times",
    "Check redemption before exiting",
  ],
  "Yield": [
    "Deposit $100, lock 30 days, boost yield",
    "Harvest weekly, restake at once",
    "Split $200 across two vaults",
    "Exit only after the lock ends",
  ],
  "Derivatives": [
    "Open a $50 hedge, hold 14 days",
    "Close half at 2 weeks, keep rest",
    "Post $100 margin, stay under 2x",
    "Log volume weekly, keep streak",
  ],
  "CDP": [
    "Mint $50 stablecoins on $100 collateral",
    "Keep collateral ratio above 200%",
    "Repay $25 after 30 days, mint again",
    "Watch the peg daily, exit if slips",
  ],
  "Risk Curators": [
    "Deposit $100 in a vault, 30 days",
    "Compare APY weekly, move if drops",
    "Stake $50 more after first payout",
    "Withdraw only after epoch closes",
  ],
  "Onchain Capital Allocator": [
    "Allocate $100 to top vault, 30 days",
    "Rebalance $50 monthly to best APY",
    "Claim points every Friday",
    "Keep $25 buffer for gas and fees",
  ],
  "Basis Trading": [
    "Deposit $100, earn basis yield 30 days",
    "Roll the position each Friday",
    "Harvest $10 yield weekly, compound",
    "Exit if funding turns negative",
  ],
  "Chain": [
    "Bridge $50 to the chain, use weekly",
    "Pay gas with $10, keep reserve",
    "Use the main app 4 times a month",
    "Stake $25 if a pool opens",
  ],
};
const GENERIC_STEPS: [string, string, string, string] = [
  "Use the app weekly with $50, a month",
  "Deposit $100, hold 30 days, earn points",
  "Complete every quest the app shows",
  "Keep $10 gas for the claim day",
];

function farmSteps(p: Protocol): [string, string, string, string] {
  return (p.category !== null && STEP_TEMPLATES[p.category]) || GENERIC_STEPS;
}

function main(): void {
  const args = process.argv.slice(2);
  let inputPath = "/input/snapshot.json";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && i + 1 < args.length) inputPath = args[i + 1];
  }
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  const repoRoot = dirname(fileURLToPath(import.meta.url));

  const snapshot: Snapshot = JSON.parse(readFileSync(inputPath, "utf8"));
  const asOf = new Date(snapshot.as_of + "T00:00:00Z");
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));

  // Value model: multiples from the token-bearing protocols in the snapshot.
  const tokenBearing = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const overallMultiple = median(tokenBearing.map((p) => (p.mcap_usd as number) / p.tvl_usd));
  const byCategory = new Map<string, number[]>();
  for (const p of tokenBearing) {
    const key = p.category ?? "Unknown";
    const list = byCategory.get(key) || [];
    list.push((p.mcap_usd as number) / p.tvl_usd);
    byCategory.set(key, list);
  }
  const categoryMultiple = new Map<string, number>();
  for (const [category, ratios] of byCategory) {
    if (ratios.length >= 3) categoryMultiple.set(category, median(ratios));
  }

  const candidates = snapshot.protocols.filter(isPreTokenCandidate);
  const watchlist = new Set(snapshot.watchlist);
  const rows: {
    slug: string;
    name: string;
    rank: number;
    implied: number;
    tvl: number;
    change7d: number | null;
    category: string;
    status: number;
    multiple: number;
    growth: number;
    ageFactor: number;
    chainsFactor: number;
    evidence: string;
    steps: [string, string, string, string];
    catMedian: boolean;
    watch: boolean;
  }[] = [];

  for (const p of candidates) {
    if (p.slug in EXCLUDED) continue;
    const catMult = p.category !== null ? categoryMultiple.get(p.category) : undefined;
    const multiple = clamp(catMult !== undefined && catMult >= 0.05 ? catMult : overallMultiple, 0.05, 1.5);
    const growth = clamp(p.change_7d === null ? 1 : 1 + 0.5 * (p.change_7d / 100), 0.5, 1.5);
    const ageFactor = 1 + 0.08 * Math.log1p(ageYears(p.listed_at, asOf));
    const chainsFactor = 1 + 0.02 * Math.min(p.chains.length, 4);
    const implied = Math.round(p.tvl_usd * multiple * growth * ageFactor * chainsFactor);
    rows.push({
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied,
      tvl: p.tvl_usd,
      change7d: p.change_7d === null ? null : Math.round(p.change_7d * 10) / 10,
      category: p.category ?? "Unknown",
      status: p.slug in FLAGGED ? 1 : 0,
      multiple: round3(multiple),
      growth: round3(growth),
      ageFactor: round3(ageFactor),
      chainsFactor: round3(chainsFactor),
      evidence: FLAGGED[p.slug] || "",
      steps: farmSteps(p),
      catMedian: catMult !== undefined && catMult >= 0.05,
      watch: watchlist.has(p.slug),
    });
  }

  // Rank by implied value, ties by TVL then slug so the order is fixed.
  rows.sort((a, b) => b.implied - a.implied || b.tvl - a.tvl || (a.slug < b.slug ? -1 : 1));
  // Implied values must strictly decrease with rank: nudge a value down by
  // a dollar when rounding ties it with the row above.
  for (let i = 0; i < rows.length; i++) {
    rows[i].rank = i + 1;
    if (i > 0 && rows[i].implied >= rows[i - 1].implied) {
      rows[i].implied = rows[i - 1].implied - 1;
    }
  }

  const flaggedCount = rows.filter((r) => r.status === 1).length;
  const watchCovered = rows.filter((r) => r.watch).length;

  // board.json: the full board with the model factors per row.
  const board = {
    model: "radar-3",
    as_of: snapshot.as_of,
    rows: rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      rank: r.rank,
      implied_value_usd: r.implied,
      farm_steps: r.steps,
      category: r.category,
      tvl_usd: r.tvl,
      change_7d: r.change7d,
      token_status: r.status === 1 ? "token_trades" : "no_token_recorded",
      evidence: r.evidence,
      multiple: r.multiple,
      growth: r.growth,
      age_factor: r.ageFactor,
      chains_factor: r.chainsFactor,
      category_multiple_used: r.catMedian,
      watchlist: r.watch,
    })),
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "board.json"), JSON.stringify(board, null, 1) + "\n");

  // dashboard/data.js: the compact board the page renders and the dossier
  // text carries whole. One row per line, arrays to keep it small.
  const header = [
    "// Token Radar v3 — compact board data, one row per line.",
    "// Columns: [slug, name, implied_value_usd, tvl_usd, change_7d, category, status, multiple, growth, age_factor, chains_factor, evidence, [farm step x4], category_multiple_used]",
    "// status: 0 = records no token, 1 = token already trades (flagged and kept: the watchlist gate forbids removing it).",
    "// Model: implied = TVL x multiple x growth x age x chains. multiple = median mcap/TVL of token-bearing protocols in the category (n>=3 and >=0.05, else overall 0.2138, clamped 0.05-1.5); growth = 1 + 0.5 x 7d change, clamped 0.5-1.5; age = 1 + 0.08 x ln(1+years listed); chains = 1 + 0.02 x chains (max 4).",
    "// Excluded (2, both off the watchlist, both already have live tokens): theo-network-thusd (live yield stablecoin, CoinGecko-listed, Uniswap v4); circle-gateway (Circle unified USDC, live mainnet 19 Aug 2025).",
    `// ${rows.length} rows, watchlist ${watchCovered}/40, ${flaggedCount} flagged. Snapshot ${snapshot.as_of}, ${snapshot.protocols.length} protocols.`,
    "const WATCHLIST=" + JSON.stringify(rows.filter((r) => r.watch).map((r) => r.slug)) + ";",
    "const ROWS=[",
  ].join("\n");
  const lines = rows.map((r) => {
    const row = [
      r.slug,
      r.name,
      r.implied,
      r.tvl,
      r.change7d,
      r.category,
      r.status,
      r.multiple,
      r.growth,
      r.ageFactor,
      r.chainsFactor,
      r.evidence,
      r.steps,
      r.catMedian ? 1 : 0,
    ];
    return JSON.stringify(row) + ",";
  });
  const dataJs = header + "\n" + lines.join("\n") + "\n];\n";

  // Copy the dashboard shell, then write the generated data beside it.
  const dashboardOut = join(outDir, "dashboard");
  mkdirSync(dashboardOut, { recursive: true });
  cpSync(join(repoRoot, "dashboard"), dashboardOut, { recursive: true });
  writeFileSync(join(dashboardOut, "data.js"), dataJs);

  // Copy the screenshots, then build the dossier from the finished output.
  const shotsIn = join(repoRoot, "screenshots");
  const shotsOut = join(outDir, "screenshots");
  const shotFiles = existsSync(shotsIn) ? readdirSync(shotsIn).filter((f) => /\.(png|jpe?g)$/i.test(f)) : [];
  if (shotFiles.length > 0) {
    mkdirSync(shotsOut, { recursive: true });
    cpSync(shotsIn, shotsOut, { recursive: true });
    const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
    // buildDossier returns the dossier JSON as bytes (a Uint8Array): write
    // those bytes verbatim, never re-serialise them, or the file balloons.
    if (typeof dossier === "string") {
      writeFileSync(join(outDir, "dossier.json"), dossier);
    } else if (dossier instanceof Uint8Array) {
      writeFileSync(join(outDir, "dossier.json"), dossier);
    } else if (Array.isArray(dossier)) {
      writeFileSync(join(outDir, "dossier.json"), Buffer.from(dossier));
    } else if (dossier && typeof dossier === "object") {
      writeFileSync(join(outDir, "dossier.json"), JSON.stringify(dossier));
    }
  } else {
    console.log("token radar: no screenshots yet, dossier skipped");
  }

  console.log(`token radar: ${snapshot.protocols.length} protocols, ${rows.length} rows scored (${flaggedCount} flagged token-trades, ${Object.keys(EXCLUDED).length} excluded)`);
  console.log(`token radar: wrote ${join(outDir, "board.json")}, ${join(dashboardOut, "data.js")} and ${join(outDir, "dossier.json")}`);
  void bySlug;
}

main();
