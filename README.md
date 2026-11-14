# Token Radar

A token-launch radar for the make.fun token-radar-01 bounty. It reads a sealed
DefiLlama snapshot of 758 protocols, finds the ones that record no token and
are not a wrapped, staked or bridged product of a token that trades, and ranks
them by what their launch would be worth — then shows the board on a dashboard
a reader can sort, filter and dig into, with a concrete farm plan per protocol.
The board holds 198 rows: the whole 40-protocol house watchlist, plus every
other pre-token protocol in the snapshot that passes the same exclusion rule.

## The value model

Implied value = TVL × category multiple × growth × age × chains. The multiple
is the median market-cap/TVL ratio of the protocols in the same category that
already have a token (overall median as fallback), clamped to 0.05–1.5. Growth
is the 7-day TVL change, damped by half and clamped. Age is a small premium
for how long the protocol has run with no token. Chains add a little for reach.
Every input comes from the snapshot itself; no protocol is ranked by name.

## Layout

- `main.ts` — the program: reads the snapshot, builds the board, writes the
  dashboard data, copies the dashboard and screenshots, writes the dossier.
- `dashboard/` — the static page (index.html, app.css, app.js). No network.
- `screenshots/` — three renders of the page: the board, a detail view, a
  filtered view.
- `vendor/makefun-board.ts` — the kit's dossier library, unchanged.

Run it with `MAKEFUN_OUTPUT_DIR=out node main.ts --input <path/to/snapshot.json>`.
