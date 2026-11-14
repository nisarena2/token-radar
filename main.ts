// Token Radar — main.ts
// Reads the sealed DefiLlama snapshot, ranks every pre-token protocol by an
// implied launch value derived from the snapshot's own figures, writes the
// board, the dashboard data and the dossier. Node 22+, standard library only.
//
// Value model (all inputs come from the snapshot, nothing is hardcoded by name):
//   implied = TVL x category multiple x growth factor x age factor x chain factor
//   - category multiple: the median market-cap/TVL ratio of the protocols in
//     the same category that already have a token (overall median as fallback),
//     clamped to [0.05, 1.5]. A pre-token protocol is worth, at launch, roughly
//     what the market already pays per dollar of TVL in its own category.
//   - growth factor: 1 + 0.5 x clamp(change_7d, -30, +100) / 100. Growing TVL
//     earns a premium, shrinking TVL a discount; the 0.5 damps one noisy week.
//   - age factor: 1 + 0.08 x ln(1 + years since listed_at), capped at 5 years.
//     Running longer with no token is proven staying power, not a penalty.
//   - chain factor: 1 + 0.02 x min(chains - 1, 4). Wider reach, slightly more.
// A protocol counts as pre-token only when DefiLlama records no token for it
// (gecko_id and symbol both null) and it is not a wrapped, staked or bridged
// product of a token that already trades (the house watchlist's own rule,
// applied here to every protocol, not just the ones above the floor).
import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};
type Snap = { as_of: string; source: string; floor_usd: number; protocols: Proto[]; watchlist: string[] };

const EXCL_CAT = new Set(["Bridge", "Canonical Bridge", "Liquid Staking", "Liquid Restaking", "Restaked BTC", "CEX"]);
const EXCH = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];
const VER_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WORD_RE = /\b(wrapped|staked|staking)\b/i;

// One farm playbook per kind of protocol. Steps are concrete: what to do,
// what it costs, how long to keep at it. {name} and {chain} are filled in per row.
const PLAYBOOKS: Record<string, string[]> = {
  risk: [
    "Deposit $250-$1,000 of stablecoins or ETH into {name} vaults on {chain}; leave the deposit working for at least 4 weeks.",
    "Split the deposit across two vaults if {name} runs more than one, so a single market never holds all of it.",
    "Use the vault once a week: top up, claim or re-deposit rewards so your wallet shows repeat activity over 8+ weeks.",
    "Watch for a points program or token announcement; keep the position open through any snapshot date.",
  ],
  dex: [
    "Add $200-$500 of liquidity to a {name} pool on {chain} in the pair with the most volume; hold the position 4+ weeks.",
    "Swap $25+ through {name} once a week for 8 weeks so your wallet has a steady history of trades.",
    "If {name} opens a points program, keep your liquidity in through the snapshot and do not pull it early.",
    "Track the pool's fees weekly; move the position only if fees fall to zero for two weeks in a row.",
  ],
  allocator: [
    "Allocate $250-$1,000 to {name} on {chain} and leave the capital deployed for at least 6 weeks.",
    "Reinvest any yield back into the same vault once a month instead of withdrawing it.",
    "Use {name} from the same wallet every time so all of your activity is tied to one address.",
    "Keep the position open through any announced snapshot; check the protocol's announcements weekly.",
  ],
  rwa: [
    "Buy $200-$1,000 of {name}'s tokenised asset on {chain} and hold it for at least 6 weeks.",
    "If {name} pays yield, claim and re-deposit it monthly rather than selling it.",
    "Complete any identity or onboarding step {name} asks for early, so a later snapshot does not catch you unverified.",
    "Hold the position through the end of the quarter; real-world-asset programs usually snapshot by quarter.",
  ],
  lending: [
    "Supply $250-$1,000 of ETH or stablecoins to {name} on {chain}; keep the supply in for at least 4 weeks.",
    "Borrow $50-$100 against the supply once, repay it within two weeks, and repeat monthly to build a usage history.",
    "Keep your health factor above 2.0 at all times so a price dip never liquidates the position.",
    "Use {name} at least once a week for 8 weeks; steady use counts more than one large deposit.",
  ],
  yield: [
    "Deposit $200-$500 into {name}'s highest-yield vault on {chain} and leave it compounding for 6+ weeks.",
    "Harvest and re-deposit rewards once a week instead of selling them, for at least a month.",
    "Try a second vault or strategy on {name} after two weeks so your wallet touches more than one product.",
    "Do not withdraw right before a snapshot; keep the position live until a distribution is announced.",
  ],
  deriv: [
    "Open a $100-$300 position on {name} on {chain} and hold it for at least a week; close it in profit or at a small loss.",
    "Trade $50+ once a week for 6 weeks so your wallet shows regular volume, not a single trade.",
    "Keep every position under 3x leverage so a sharp move does not wipe the account.",
    "If {name} runs a trading competition or points season, join it and keep trading through its end.",
  ],
  chain: [
    "Bridge $100-$300 to {name} and use its native apps weekly for 8 weeks: swaps, lending and mints all count.",
    "Hold a small balance of {name}'s gas token in the same wallet for the whole period.",
    "Mint or deploy one thing on {name} - an NFT, a domain or a contract - to show activity beyond transfers.",
    "Keep using the chain through any snapshot date; early chains reward users who stay, not one-time visitors.",
  ],
  stake: [
    "Stake $200-$500 of ETH or BTC with {name} on {chain} and leave it staked for at least 8 weeks.",
    "Restake the rewards once a month instead of claiming them to your wallet.",
    "If {name} offers more than one staking option, split the stake across two of them.",
    "Do not unstake before a snapshot; restaking programs usually reward the longest stakers most.",
  ],
  stable: [
    "Mint or buy $200-$500 of {name}'s stable asset on {chain} and hold it for at least 4 weeks.",
    "Provide $100+ of that stable asset as liquidity in its main pool for a month.",
    "Use the stable asset in one more place - a lending market or a payment - once a week.",
    "Keep the position open through the end of the month; stablecoin programs snapshot monthly.",
  ],
  predict: [
    "Place $20-$50 of bets on {name} on {chain} each week for 6 weeks, across at least three different markets.",
    "Provide $100+ of liquidity to a {name} market and leave it for the market's full duration.",
    "Resolve or claim winnings promptly; unclaimed positions can be missed by snapshots.",
    "Trade both sides of a market at least once so your wallet shows maker and taker activity.",
  ],
  other: [
    "Use {name} on {chain} with $100-$300 at least once a week for 6 weeks.",
    "Complete the protocol's onboarding or verification step in the first week so later activity counts.",
    "Try two different features of {name} - not the same action twice - so your wallet shows breadth.",
    "Keep a small balance active through any snapshot date; do not empty the wallet before a distribution.",
  ],
};

const CAT_TO_BOOK: Record<string, string> = {
  "Risk Curators": "risk", "Dexs": "dex", "Onchain Capital Allocator": "allocator",
  "RWA": "rwa", "Lending": "lending", "Collateral Markets": "lending",
  "Uncollateralized Lending": "lending", "CDP": "lending", "CDP Manager": "lending",
  "Yield": "yield", "Yield Aggregator": "yield", "Liquidity Manager": "yield",
  "Leveraged Farming": "yield", "Farm": "yield", "Derivatives": "deriv",
  "Basis Trading": "deriv", "Interest Rate Derivatives": "deriv", "Chain": "chain",
  "Staking Pool": "stake", "Restaking": "stake", "Anchor BTC": "stake",
  "Decentralized BTC": "stake", "Dual-Token Stablecoin": "stable",
  "Stablecoin Wrapper": "stable", "Prediction Market": "predict",
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function clamp(x: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, x)); }
function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86400000;
}
function isExcluded(p: Proto): boolean {
  if (p.category !== null && EXCL_CAT.has(p.category)) return true;
  if (VER_RE.test(p.name)) return true;
  if (WORD_RE.test(p.name)) return true;
  if (EXCH.some((e) => p.name.startsWith(e))) return true;
  return false;
}
function fmtUsd(n: number): string {
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  return "$" + Math.round(n / 1e3) + "K";
}

function main(): void {
  const args = process.argv.slice(2);
  let inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  let snapPath = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) {
      const v = args[++i];
      if (v.endsWith(".json")) snapPath = v;
      else inputDir = v;
    }
  }
  const outDir = resolve(process.env.MAKEFUN_OUTPUT_DIR || "/output");
  const snap: Snap = JSON.parse(readFileSync(snapPath || join(inputDir, "snapshot.json"), "utf8"));
  const watch = new Set(snap.watchlist);

  // Category multiples from the snapshot itself: median mcap/TVL of the
  // token-bearing protocols in each category, overall median as fallback.
  const byCat = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of snap.protocols) {
    if (p.mcap_usd && p.tvl_usd > 0) {
      const r = p.mcap_usd / p.tvl_usd;
      allRatios.push(r);
      if (p.category) {
        const arr = byCat.get(p.category) || [];
        arr.push(r);
        byCat.set(p.category, arr);
      }
    }
  }
  const overall = median(allRatios);
  const multipleFor = (cat: string | null): { m: number; cat: boolean } => {
    const arr = cat ? byCat.get(cat) : undefined;
    if (arr && arr.length >= 5) return { m: clamp(median(arr), 0.05, 1.5), cat: true };
    return { m: clamp(overall, 0.05, 1.5), cat: false };
  };

  const cands = snap.protocols.filter(
    (p) => p.gecko_id === null && p.symbol === null && !isExcluded(p),
  );

  const scored = cands.map((p) => {
    const { m: multiple, cat: multipleIsCat } = multipleFor(p.category);
    const growth = p.change_7d ?? 0;
    const growthF = 1 + 0.5 * (clamp(growth, -30, 100) / 100);
    const years = p.listed_at ? daysBetween(p.listed_at, snap.as_of) / 365.25 : 1.0;
    const ageF = 1 + 0.08 * Math.log(1 + Math.min(Math.max(years, 0), 5));
    const chainF = 1 + 0.02 * Math.min(Math.max(p.chains.length - 1, 0), 4);
    const implied = Math.round(p.tvl_usd * multiple * growthF * ageF * chainF);
    return { p, multiple, multipleIsCat, growth, years, growthF, ageF, chainF, implied };
  });
  scored.sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  const logMin = Math.log10(Math.max(scored[scored.length - 1].implied, 1));
  const logMax = Math.log10(Math.max(scored[0].implied, 2));

  const rows = scored.map((s, i) => {
    const book = CAT_TO_BOOK[s.p.category || ""] || "other";
    const chain = s.p.chains[0] || "Ethereum";
    const steps = PLAYBOOKS[book].map((t) =>
      t.replaceAll("{name}", s.p.name).replaceAll("{chain}", chain),
    );
    const score = clamp(Math.round((100 * (Math.log10(Math.max(s.implied, 1)) - logMin)) / (logMax - logMin)), 5, 99);
    return {
      slug: s.p.slug, name: s.p.name, category: s.p.category, chains: s.p.chains,
      tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d, listed_at: s.p.listed_at,
      rank: i + 1, implied_value_usd: s.implied, score, on_watchlist: watch.has(s.p.slug),
      value_model: {
        multiple: +s.multiple.toFixed(3),
        multiple_source: s.multipleIsCat ? "category" : "overall",
        growth_factor: +s.growthF.toFixed(3),
        age_factor: +s.ageF.toFixed(3), chain_factor: +s.chainF.toFixed(3),
      },
      farm_steps: steps,
    };
  });

  mkdirSync(outDir, { recursive: true });
  const board = {
    as_of: snap.as_of, source: snap.source, floor_usd: snap.floor_usd,
    rows_count: rows.length, watchlist_count: snap.watchlist.length,
    methodology:
      "implied = TVL x category multiple (median mcap/TVL of token-bearing protocols in the same category, " +
      "overall median as fallback, clamped 0.05-1.5) x growth factor (1 + 0.5 x clamp(change_7d, -30, 100)/100) x " +
      "age factor (1 + 0.08 x ln(1 + years since listed_at, capped 5y)) x chain factor (1 + 0.02 x min(chains-1, 4)). " +
      "Only protocols with no token recorded (gecko_id and symbol null) and not a wrapped, staked or bridged product " +
      "of a token that trades are ranked. An implied value is this entry's own claim, never make.fun's.",
    rows,
  };
  writeFileSync(join(outDir, "board.json"), JSON.stringify(board, null, 2) + "\n", "utf8");

  // Dashboard data: compact rows + the same playbooks, so the page renders
  // exactly the farm plans the board carries, from one definition.
  const dataRows = rows.map((r) => ({
    s: r.slug, n: r.name, c: r.category, h: r.chains, t: r.tvl_usd,
    g: r.change_7d, a: r.listed_at, v: r.implied_value_usd, sc: r.score,
    w: r.on_watchlist ? 1 : 0, m: r.value_model.multiple,
    f: r.value_model.multiple_source === "category" ? 1 : 0,
  }));
  const data = {
    asOf: snap.as_of, floor: snap.floor_usd, count: rows.length,
    watchlist: snap.watchlist.length, preToken: cands.length,
    playbooks: PLAYBOOKS, catBook: CAT_TO_BOOK, rows: dataRows,
  };

  const dashOut = join(outDir, "dashboard");
  const repoRoot = dirname(fileURLToPath(import.meta.url));
  cpSync(join(repoRoot, "dashboard"), dashOut, { recursive: true });
  writeFileSync(join(dashOut, "data.js"), "window.RADAR = " + JSON.stringify(data) + ";\n", "utf8");
  cpSync(join(repoRoot, "screenshots"), join(outDir, "screenshots"), { recursive: true });

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, "dossier.json"), dossier);
  console.log(`board rows: ${rows.length} (watchlist ${snap.watchlist.length} covered)`);
  console.log(`top 5: ${rows.slice(0, 5).map((r) => r.name + " " + fmtUsd(r.implied_value_usd)).join(" | ")}`);
  console.log(`dossier bytes: ${dossier.length}`);
}

main();
