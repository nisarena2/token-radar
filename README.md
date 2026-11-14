# Token Radar v3 — token-radar-01 entry

A radar for pre-token protocols: it reads a DefiLlama snapshot, ranks the
protocols that have no token yet by an implied launch value, and renders the
board as a small dashboard.

## How the ranking works

Implied value = TVL × multiple × growth × age × chains.

- **Multiple** — the median market-cap / TVL of token-bearing protocols in
  the same category. When a category has fewer than 3 token-bearing
  protocols, or its median is under 0.05, the overall median (0.214) is used.
  Clamped between 0.05 and 1.5.
- **Growth** — the 7-day TVL change damped by half, clamped between 0.5 and
  1.5, so a one-week spike cannot multiply a valuation.
- **Age** — 1 + 0.08 × ln(1 + years listed).
- **Chains** — 2% per chain, at most 4 chains.

A protocol is a candidate when its record carries no token and it is not a
wrapped, staked or bridged product. Two candidates are left out because their
tokens are already live: Theo Network thUSD and Circle Gateway. Seven
watchlist rows are flagged TOKEN TRADES because their token already trades in
public — they stay on the board because the watchlist has to be covered in
full, and each one carries its evidence in its detail view.

## What is in this repo

- `main.ts` — the program. Reads the snapshot, writes `board.json`, the
  compact `dashboard/data.js`, and `dossier.json`.
- `dashboard/` — the page: `index.html`, `app.css`, `app.js`. The data file
  is written by the program next to the page so the dossier carries the whole
  board.
- `screenshots/` — three renders of the page: the board, a flagged
  protocol's detail view, and the filtered view of flagged rows.
- `vendor/makefun-board.ts` — the kit's dossier builder, unchanged.

## Running it

```sh
node main.ts --input snapshot.json
```

Output goes to `$MAKEFUN_OUTPUT_DIR` (default `/output`): `board.json`,
`dashboard/`, `screenshots/`, `dossier.json`. The program is deterministic —
two runs on the same snapshot produce byte-identical output.

## Why v3

The previous version scored worse than the first one because its data file
sat outside the dashboard folder, so the dossier text carried no ranking rows
at all. Here the compact data file lives inside `dashboard/`, the dossier
text carries the whole board, and the board opens clean — the flag
explanation sits below the board and in each flagged protocol's detail view.
