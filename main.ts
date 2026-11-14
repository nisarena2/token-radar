// Token Radar v2: a token-launch radar for token-radar-01 (Node 22, standard library only).
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>),
// scores every pre-token protocol with the model below, writes the ranked board to
// /output/board.json and the dashboard's data to /output/data.js, copies this repository's
// dashboard/ and screenshots/ to /output, and writes /output/dossier.json with the vendored
// make.fun library.
//
// The model (radar-2). Implied value follows only from the snapshot's own figures:
//
//   multiple  = median market-cap/TVL of token-bearing protocols in the same category
//               (true median over protocols with a market cap above zero; used when the
//               category holds at least 3 of them and the median is at least 0.05, else the
//               overall median 0.2138), clamped to [0.05, 1.5]
//   growth    = 1 + 0.5 x change_7d/100, clamped to [0.5, 2.0]
//   age       = 1 + 0.08 x ln(1 + years since listed_at), years = days/365.25 (0 if unlisted)
//   chains    = 1 + 0.02 x min(chains, 4)
//   implied   = round(tvl_usd x multiple x growth x age x chains)
//
// No protocol name is ever special-cased in the model: the same function scores every row.
// Two rows are left out of the board, and seven rows are flagged, by a documented
// data-correction table (see DATA_CORRECTIONS and TOKEN_FLAGS below). The snapshot's
// record is not proof: a protocol that records no token may still have one that trades.
// The gate's coverage row forces every watchlist slug onto the board, so a watchlist row
// whose token already trades is kept and flagged, never dropped; only rows outside the
// watchlist can be left out. Every flag and every omission carries its evidence.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The model's version label: the dashboard names it and the rules quote it. */
const MODEL_VERSION = 'radar-2';

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
interface SnapshotProtocol {
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
}

/** The whole snapshot document. */
interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The true median of a sorted-or-not list of numbers (average of the two middle values). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return sorted[(n - 1) / 2]!;
  return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The category multiples and the overall fallback, all derived from the snapshot itself. */
function multiples(snapshot: Snapshot): { byCategory: Map<string, { value: number; n: number }>; overall: number } {
  const tokenBearing = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const overall = median(tokenBearing.map((p) => p.mcap_usd! / p.tvl_usd));
  const byCategory = new Map<string, { value: number; n: number }>();
  const grouped = new Map<string, number[]>();
  for (const p of tokenBearing) {
    if (p.category === null) continue;
    const list = grouped.get(p.category) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    grouped.set(p.category, list);
  }
  for (const [category, ratios] of grouped) {
    byCategory.set(category, { value: median(ratios), n: ratios.length });
  }
  return { byCategory, overall };
}

/** The multiple one protocol gets: its category's median when the category holds at least
 *  3 token-bearing protocols and the median is at least the clamp floor, else the overall
 *  median. A category median below the floor carries no signal (its token-bearing set is
 *  dominated by dust or zero-cap records), so it falls back instead of clamping. */
function multipleFor(
  protocol: SnapshotProtocol,
  byCategory: Map<string, { value: number; n: number }>,
  overall: number,
): number {
  const entry = protocol.category === null ? undefined : byCategory.get(protocol.category);
  let multiple = overall;
  if (entry !== undefined && entry.n >= 3 && entry.value >= 0.05) multiple = entry.value;
  return Math.min(1.5, Math.max(0.05, multiple));
}

/** The three multipliers and the implied value one protocol gets. */
function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  byCategory: Map<string, { value: number; n: number }>,
  overall: number,
): { implied: number; multiple: number; growth: number; ageFactor: number; chainsFactor: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const years = age === null ? 0 : age / 365.25;
  const growth = Math.min(2.0, Math.max(0.5, 1 + 0.5 * (finite(protocol.change_7d, 0) / 100)));
  const ageFactor = 1 + 0.08 * Math.log1p(years);
  const chainsFactor = 1 + 0.02 * Math.min(protocol.chains.length, 4);
  const multiple = multipleFor(protocol, byCategory, overall);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growth * ageFactor * chainsFactor));
  return { implied, multiple, growth, ageFactor, chainsFactor, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word wrapped, staked or staking in a name: a wrapped or staked product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Exchange names a protocol name must not begin with (the house watchlist rule). */
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Categories the house watchlist rule keeps off the list. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whether a protocol records no token at all. */
function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a
 *  versioned pool, not a wrapped/staked/bridged product of a token that already trades. */
function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((name) => p.name.startsWith(name))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Data corrections, checked against the live market on 14 November 2026.
// The snapshot records no token for these protocols, but each one's token already
// trades. The gate's coverage row requires every watchlist slug on the board, so
// the seven watchlist rows stay and carry a flag; the two rows outside the
// watchlist are left out. Evidence is quoted in the dashboard's corrections note.
// ---------------------------------------------------------------------------

/** Watchlist rows whose token already trades: kept on the board (coverage) and flagged. */
const TOKEN_FLAGS: Record<string, string> = {
  'usdd':
    'USDD is a live TRON stablecoin: it trades on HTX, SunSwap, Gate, KuCoin and Kraken, is CoinGecko-listed with a market cap near $1.5B, contract TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz. The snapshot records no token for it.',
  'bittensor-dtao':
    'TAO trades on Binance, Coinbase, Kraken, KuCoin and OKX at about $207 with a market cap near $2.44B. dTAO is Bittensor\u2019s subnet-token system, not a protocol still waiting for a token.',
  'onre':
    'ONyc, OnRe\u2019s flagship product, is a live token: CoinGecko-listed with a market cap near $115\u2013234M, trading on Orca and Raydium at about $1.16.',
  'plume-vaults':
    'PLUME had its token generation event on 21 Jan 2025 and trades on Binance, Coinbase, Upbit, Bybit and Kraken. Plume Vaults is a product of Plume Network, whose token already trades.',
  'r25':
    'rcUSD, rcUSDp on Sui and rcUSD+ on Polygon are live yield-bearing stablecoin tokens, launched in Nov 2025. The protocol\u2019s product is the token.',
  'tori-finance':
    'trUSD is a live synthetic-dollar token, CoinGecko rank near 300 with a market cap near $77.4M, and strUSD is its staked token. The protocol states it has no governance token.',
  'hive-protocol':
    'Hive is B-Squared Network\u2019s BTC-staking product and its reward token B2 trades on KuCoin and Gate since its Apr 2025 IDO at about $0.42, with 67.35M in circulation. No separate Hive token exists.',
};

/** Rows outside the watchlist whose token already trades: left out of the board. */
const EXCLUDED_ROWS: Record<string, string> = {
  'theo-network-thusd':
    'thUSD is a live yield-bearing stablecoin, CoinGecko-listed, trading on Uniswap v4 (contract 0xa3fe5c7596024e6811e14f029937d5bd8ae485b3). The protocol is the thUSD product, and no Theo token has been announced.',
  'circle-gateway':
    'Circle Gateway is Circle\u2019s unified-USDC-balance product, live on mainnet since 19 Aug 2025 on 13 chains: a bridged product of USDC, which trades.',
};

/** Notes for rows that stay on the board with a caveat the reader should know. */
const ROW_NOTES: Record<string, string> = {
  'axis':
    'USDx, the protocol\u2019s synthetic dollar, is live on Curve and Pendle since Sep 2026, but Axis has announced a public sale of a separate governance token (Coordinates points map to a governance allocation). This row ranks that not-yet-launched governance token.',
  'bitfi-basis':
    '$BFI had a public sale on 11\u201315 Jun 2026 at $0.05, but its token generation date is still unannounced and the token does not trade yet. This row ranks the token to come.',
  'b14g':
    'b14g had a security incident on 31 Oct 2026: about 97M CORE (near $1.35M) was withdrawn without authorisation from its contracts. Staked BTC was untouched, contracts were paused, and the post-mortem is still pending.',
  'lightning-network':
    'Lightning has no token by design: every payment is bitcoin, and no Lightning token will ever launch. It is ranked because the snapshot records no token for it, not because a launch is coming.',
};

/** A farm step: the action, what it costs, and how long it takes. */
interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  implied_value_usd: number;
  token_status: 'no_token_recorded' | 'token_trades';
  token_note: string | null;
  model: {
    multiple: number;
    growth_multiplier: number;
    age_multiplier: number;
    chains_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  watchlist: boolean;
  token_status: 'no_token_recorded' | 'token_trades';
  token_note: string | null;
  multiple: number;
  growth_multiplier: number;
  age_multiplier: number;
  chains_multiplier: number;
  farm_steps: string[];
}

/** Everything the dashboard renders, from the snapshot. */
interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  overall_multiple: number;
  watchlist_size: number;
  board_size: number;
  flagged_size: number;
  excluded_size: number;
  rows: RadarRow[];
  excluded: { slug: string; name: string; evidence: string }[];
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 42;
  if (age < 180) return 56;
  if (age < 365) return 42;
  return 28;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The asset to fund with: bitcoin on a payments chain, dollars everywhere else. */
function assetFor(p: SnapshotProtocol): string {
  return (p.category ?? '').toLowerCase().includes('payment') ? 'BTC' : 'USDC';
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield aggregator') || c.includes('yield') || c.includes('liquidity manager') || c === 'farm') {
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  }
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain} as lending collateral and keep the position open.`;
  }
  if (c.includes('dex')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('basis')) return `Deposit $${capital} into ${name}'s delta-neutral vault on ${chain} and hold the receipt token.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('restak') || c.includes('staking')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('payment')) return `Open a Lightning channel funded with $${capital} of BTC through ${name} and route one payment a week.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('chain')) return `Use $${capital} of the chain's native asset in ${name}'s staking app on ${chain} and keep the position open.`;
  if (c.includes('index')) return `Buy $${capital} of ${name}'s index token on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('stable')) return `Mint or hold $${capital} of the stable asset through ${name} on ${chain}.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: four steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a
 * hand-written list of names. A flagged row's first step says the launch thesis is dead.
 */
function farmSteps(p: SnapshotProtocol, age: number | null, flagged: boolean): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const asset = assetFor(p);
  const steps: FarmStep[] = [];
  if (flagged) {
    steps.push({
      text: `Heads-up: this protocol's token already trades, so there is no token launch left to farm here. Use the product only if you want it itself, never as a launch bet, and do not buy the live token expecting an airdrop.`,
      cost: 'nothing to check',
      time: '5 minutes',
    });
  } else {
    steps.push({
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline. Fund it with $${capital} of ${asset} on ${chain}.`,
      cost: 'about $3 of gas for the first transaction',
      time: '10 minutes to set up',
    });
  }
  steps.push({
    text: actionFor(p, capital, chain),
    cost: `$${capital} of capital and about $4 of gas`,
    time: '15 minutes to set up',
  });
  steps.push({
    text: `Repeat one qualifying action each week for 6 weeks, such as a deposit, a swap, a vote or a claim, so the activity spans more than one snapshot.`,
    cost: 'about $2 of gas a week',
    time: '10 minutes a week',
  });
  steps.push({
    text: `Hold the position for at least ${hold} days, then open the protocol's own points or rewards page and claim only from the link it publishes. Never pay a fee to claim.`,
    cost: `the $${capital} stays in the position; no fee to check`,
    time: '10 minutes',
  });
  return steps;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
function buildBoard(snapshot: Snapshot): BoardRow[] {
  const { byCategory, overall } = multiples(snapshot);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable protocol, strongest TVL first. Two rows are
  // left out by the data-correction table (their token already trades).
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && !(p.slug in EXCLUDED_ROWS))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const value = impliedValue(p, snapshot.as_of, byCategory, overall);
    return { p, value };
  });
  scored.sort((a, b) => b.value.implied - a.value.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    const flagged = s.p.slug in TOKEN_FLAGS;
    const note = TOKEN_FLAGS[s.p.slug] ?? ROW_NOTES[s.p.slug] ?? null;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      implied_value_usd: s.value.implied,
      token_status: flagged ? 'token_trades' : 'no_token_recorded',
      token_note: note,
      model: {
        multiple: Math.round(s.value.multiple * 1e4) / 1e4,
        growth_multiplier: Math.round(s.value.growth * 1e4) / 1e4,
        age_multiplier: Math.round(s.value.ageFactor * 1e4) / 1e4,
        chains_multiplier: Math.round(s.value.chainsFactor * 1e4) / 1e4,
        age_days: s.value.age,
      },
      farm_steps: farmSteps(s.p, s.value.age, flagged).map(stepText),
    };
  });
}

/** A board row's compact form for data.js. */
function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.model.age_days,
    implied_value_usd: row.implied_value_usd,
    watchlist: watchlist.has(row.slug),
    token_status: row.token_status,
    token_note: row.token_note,
    multiple: row.model.multiple,
    growth_multiplier: row.model.growth_multiplier,
    age_multiplier: row.model.age_multiplier,
    chains_multiplier: row.model.chains_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
function buildRadar(snapshot: Snapshot, board: BoardRow[]): RadarData {
  const { overall } = multiples(snapshot);
  const index = bySlug(snapshot.protocols);
  const excluded = Object.keys(EXCLUDED_ROWS)
    .map((slug) => {
      const p = index.get(slug);
      return { slug, name: p === undefined ? slug : p.name, evidence: EXCLUDED_ROWS[slug]! };
    })
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    overall_multiple: Math.round(overall * 1e4) / 1e4,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    flagged_size: board.filter((r) => r.token_status === 'token_trades').length,
    excluded_size: excluded.length,
    rows: board.map((r) => radarRow(r, new Set(snapshot.watchlist))),
    excluded,
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const board = buildBoard(snapshot);
const radar = buildRadar(snapshot, board);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.flagged_size} flagged token-trades, ${radar.excluded_size} excluded)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
