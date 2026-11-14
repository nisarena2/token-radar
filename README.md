# Token Radar v2

A token-launch radar for the make.fun `token-radar-01` bounty. It reads a sealed snapshot
of the protocol universe (DefiLlama data, 758 protocols at or above $5M TVL, as of 14 Nov 2026),
ranks the protocols that record no token by what a launch would be worth, and hands in a web
dashboard with a farm plan for each one.

## Model (radar-2)

Implied value follows only from the snapshot's own figures:

```
multiple  = median market-cap/TVL of token-bearing protocols in the same category
            (true median over protocols with a market cap above zero; used when the
            category holds at least 3 of them and the median is at least 0.05, else the
            overall median 0.2138), clamped to [0.05, 1.5]
growth    = 1 + 0.5 x change_7d/100, clamped to [0.5, 2.0]
age       = 1 + 0.08 x ln(1 + years since listed_at), years = days/365.25 (0 if unlisted)
chains    = 1 + 0.02 x min(chains, 4)
implied   = round(tvl_usd x multiple x growth x age x chains)
```

No protocol name is special-cased in the model: the same function scores every row.

## Data corrections

The snapshot's record is not proof: a protocol that records no token may still have one
that trades. Nine rows were checked against the live market on 14 Nov 2026:

- **Left out (2, outside the watchlist):** Theo Network thUSD (thUSD is a live
  yield-bearing stablecoin on Uniswap v4) and Circle Gateway (a bridged product of USDC).
- **Flagged, kept on the board (7, all on the watchlist):** USDD, Bittensor dTAO, OnRe,
  Plume Vaults, R25, Tori Finance and Hive Protocol. The gate requires every watchlist
  slug on the board, so these stay and carry a `TOKEN TRADES` flag with the evidence in
  the detail view; the launch thesis is dead for them.

The board holds 196 rows: the whole 40-protocol watchlist plus every other rankable
protocol. Top 5: Sentora Curator $682.9M, Steakhouse Financial $674.8M, Gauntlet $401.9M,
Veda $373.8M, USDD $200.8M (flagged).

## Dashboard

A dark radar page: a sortable, filterable board (search, category, token status, watchlist
only), a detail view per protocol with the model breakdown and a 4-step farm plan
($50-$200 of capital, a few dollars of gas, 4-8 week hold), and a corrections note.
No network, no framework: `dashboard/index.html` + `app.css` + `app.js`, data from
`data.js` written by `main.ts`.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

Node 22.18 or later. The program writes `out/board.json`, `out/data.js`, copies
`dashboard/` and `screenshots/` to `out/`, and writes `out/dossier.json` with the
vendored `vendor/makefun-board.ts` library. Two runs write the same bytes.

## Verification (run 2026-11-14, against the sealed snapshot)

- Board: **196 rows** (198 candidates minus the 2 exclusions below), ranks 1–196, implied
  values strictly decreasing and all distinct, every slug in the snapshot.
- Watchlist: **40 of 40 covered**. Top 5: Sentora Curator $682.9M, Steakhouse Financial
  $674.8M, Gauntlet $401.9M, Veda $373.8M, USDD $200.8M (flagged: its token already trades).
- Corrections: **7 rows flagged** (USDD, Bittensor dTAO, OnRe, Plume Vaults, R25, Tori
  Finance, Hive Protocol) and **2 rows excluded** (Theo Network thUSD, Circle Gateway) —
  each with its evidence in the dashboard's corrections note and the row's own detail view.
- Determinism: two runs of `main.ts` produce byte-identical `board.json` (238,270 bytes),
  `data.js` (240,569 bytes) and `dossier.json` (687,857 bytes). The dossier is byte-identical
  to a fresh `buildDossier` call on the same output directory.
- Dossier: 687,857 bytes (limit 1.5 MB); dashboard text in the dossier 20,782 bytes
  (limit 65,536). Dashboard source 20,518 bytes. Screenshots 1440x900 JPEG, 163–174 KB each.
- Dashboard data matches `board.json` exactly (0 mismatches across all 196 rows), and the
  dashboard contains no `http://` or `https://` anywhere.

## Files

- `main.ts` — the program: model, board, farm plans, dossier
- `dashboard/` — the static page (index.html, app.css, app.js)
- `screenshots/` — 1-board, 2-detail, 3-filtered (1440x900 renders of the dashboard)
- `vendor/makefun-board.ts` — the kit's dossier library, copied byte for byte
