# Roku player — library tests

The pure BrightScript libraries in `roku/source/lib/` (`tz.brs`, `schedule.brs`,
`powerwindow.brs`, `playorder.brs`) are run in the BrightScript Simulation Engine (`brs-node`)
against the same conformance vectors every other player answers to. Nothing here needs a Roku.

## Run

Node 22 (brs-node needs it), from the repo root:

```sh
cd roku && npm install            # dev tooling only: brs-node, brighterscript, bslint
~/.nvm/versions/node/v22.23.2/bin/node tests/run-vectors.js
```

or `npm test` from `roku/`. Exit status is non-zero on any failure. It takes about 30 s, most of
it the Intl brute force that computes the expected `next_edge_ms`.

`brs-node` is looked up at `$BRS_CLI`, then `roku/node_modules/brs-node/bin/brs.cli.js`; set
`BRS_CLI=/path/to/brs-node/bin/brs.cli.js` to use another copy.

Compiler + lint (zero diagnostics expected):

```sh
cd roku && ~/.nvm/versions/node/v22.23.2/bin/node node_modules/brighterscript/dist/cli.js --project bsconfig.json
```

## What is checked

`run-vectors.js` builds the cases in node, writes them as `fixture.json` into a temporary `pkg:`
root next to copies of the four libraries and `tests/brs/test_main.brs`, runs brs-node on it, and
reads back `FAIL …` / `COUNT …` / `DONE …` lines.

| file | cases | expected values from |
|---|---|---|
| `shared/schedule-vectors.json` | every vector, item = `{ schedules: blocks, play_from, play_until }` | the vector |
| `shared/power-window-vectors.json` | every vector; `on` and `next_edge_ms` | the vector; edge from a minute-by-minute brute force with Intl + `power-window.js` `_windowCovers` |
| power-next-edge (generated) | 5 zones (incl. Lord Howe's 30-min DST, Kathmandu) × instants around every 2026 transition × 9 schedules | same brute force; cross-checked against JS `nextEdge().at` where no offset change intervenes |
| power-zone (generated) | schedule zone vs table zone, `powerSchedule.tz_table` override, unknown zone, broken tables | hand-written + brute force |
| tz-localparts (generated) | 20 zones × random instants 1971–2099 + both sides of every 2026 transition + calendar edges (leap days, 1900/2100, pre-1970, year 1) | `Intl.DateTimeFormat` |
| play-order (generated) | sequential / shuffle / weighted scenarios incl. eligibility changing mid-bag, plus 60 random fuzz scenarios; also `weightOf` per item | `tizen/js/play-order.js` driven by the same seeded LCG |

Each vector's `tz_table` is what the server would send: offset spans found with Intl at minute
precision (15-min scan + bisection) from 24 h before `utc_now` (9 days ahead for power cases, so the
8-day next-edge reference is exact). The schedule and power vectors are also run on tables from
the real payload builder, `server/lib/tz-table.js`, when it is present.

The zone-dependent cases are then run again with **no table** (`tz_table: null`) and brs-node's
`TZ` set to the vector's zone, which exercises the `roDateTime.ToLocalTime()` fallback.

Randomness: the play-order state takes `state.rnd = { next: function() … }`; the tests inject a
Park–Miller LCG (`s = s * 48271 mod 2^31-1`, `s / (2^31-1)`) that produces bit-identical doubles in
node and BrightScript, so index sequences can be compared exactly.

## Adding a case

Add vectors to `shared/*-vectors.json` (every player must agree with them), or a generated case in
`run-vectors.js`. A case is `{ kind, file, id, …, expect }`; `test_main.brs` dispatches on `kind`
(`localparts`, `schedule`, `power`, `playorder`).
