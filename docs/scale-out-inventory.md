# Scale-out — Phase A: inventory

What exists today for "one writer, many readers", what is stubbed, what is tested but uncalled, and
the write/read map the design in Phase B has to respect. **No behaviour changes in this phase.**

Read against `ARCHITECTURE.md` I1–I10, `docs/mesh-directive.md`, `docs/mesh-phase0-design.md`,
`docs/mesh-relay-design.md`, `docs/mesh-batching-design.md`. The tests under `server/test/mesh-*` are
the spec; where this document and a test disagree, the test wins and this document is wrong.

Date of inventory: 2026-09-18, `main` at `75a0f7d`.

---

## 1. The one-sentence finding

Almost every mechanism scale-out needs already exists as a **hub ↔ site** relationship: a data-owning
node pushes summaries upward and answers reads on request; an observing node stores mirrors and
serves a dashboard from them. **Scale-out is that same edge with the roles named differently** —
the primary is the data owner (mesh "child"), each replica is an observer (mesh "parent") holding a
read grant — plus three things that do not exist: a replica-shaped dashboard that serves *all* of a
workspace from mirror + proxy, a write path that refuses/redirects instead of writing, and a way for a
player attached to a replica to have its events reach the primary with the primary's consent.

Nothing in the invariants needs breaking. Two things need care: I2 (a replica forwarding player
events to the primary is a *write arriving over the wire* and must be a grant the primary's operator
sets) and I1 (a replica must keep its own players fed when the primary is gone).

---

## 2. What exists, what is stubbed, what nothing calls

Method: every module in `server/lib/mesh/` checked for a **production** `require` (routes, ws,
services, other mesh modules) versus test-only. "Operator can turn it on" means an env flag plus a UI
or route that a human can reach — the failure the directive records (every module tested, nothing
wired) is the one this column exists for.

### 2.1 Wired and reachable by an operator

| Module | Called from | Tests | Operator switch |
|---|---|---|---|
| `pairing.js` — mint/validate codes, depth + cycle checks | `routes/mesh-enroll.js`, `ws/meshSocket.js` | enroll, transport, topology | `MESH_ACCEPT_ENROLLMENT` → `POST /api/mesh/pair/code`; `MESH_ALLOW_UPLINK` → `POST /api/mesh/uplink` |
| `store.js` — node identity, edges (`mesh_edges`) | enroll route, `ws/index.js`, uplink service | enroll | same flags |
| `node-identity.js`, `capabilities.js`, `grants.js`, `envelope.js` | enroll route, meshSocket, uplink | invariants, capability-advertised, write-consent, depth | same |
| `uplink.js` + `services/mesh-uplink.js` — child dials parent, jittered backoff, bounded buffer | boot (`server.js` when uplink flag set) | transport, servers-view, enroll | `MESH_ALLOW_UPLINK` |
| `ws/meshSocket.js` — parent side, `/mesh` namespace: `mesh:envelope` (up), `mesh:read` (down) | `ws/index.js` | transport | `MESH_ACCEPT_ENROLLMENT` |
| `backpressure.js` — per-child caps (I6) | meshSocket | backpressure, transport | with enrollment |
| `mirror.js` + `mirror-store.js` — child projects, parent stores `mesh_mirror_*` | uplink service, meshSocket via `ws/index.js`, maintenance | aggregation, mirror-store, transport | with either flag |
| `node-data.js` — child's projections + `answerRead()` | uplink service, read-worker | read-worker | with uplink |
| `read-runner.js` + `read-worker.js` — reads answered on a **worker thread with its own readonly SQLite handle** | uplink service (`read-worker.js` is loaded by path from `read-runner.js`, not `require`d — a grep for callers misses it) | read-worker | with uplink |
| `read-proxy.js` — the **allowlist of exact paths** a parent may ask a child (`/api/devices`, `/:id`, `/telemetry`, `/screenshot`, `/debug`, `/assignments/device/:id`, `/groups`, `/playlists`, `/playlists/:id`), each pinned to a grant category | via `node-data.js` (transitive) | read-worker, transport | `GET /api/mesh/read/:nodeId` on the hub |
| `hub-view.js`, `alert-rollup.js`, `uptime-report.js`, `client-roles.js`, `client-tree.js` | `routes/mesh.js` (hub UI at `#/servers`) | hub-view, aggregation, uptime, roles, tree | with enrollment |
| `edge-status.js` — consent-from-below view, revoke | enroll route | edge-status, write-consent | uplink UI |
| `node-write.js` + `write-proxy.js` — parent asks child to write; child applies only if **its own operator** set the write grant (`PUT /api/mesh/uplink/:id/write-grant`) | uplink service; `POST /api/mesh/write/:nodeId` on hub | write-apply, write-consent, audit | child-side UI toggle |
| `content-offer.js`, `content-receive.js`, `content-sync.js`, `pull-download.js` — content transfer with pull tickets and resume | `routes/mesh.js`, uplink service, maintenance | content-sync, content-transfer | write grant `content-push` on the child |
| `local-apply.js`, `auto-forward.js`, `relay.js`, `audit.js` | uplink service, maintenance | local-apply, auto-forward, audit | with flags |
| `services/mesh-maintenance.js` — tombstone purge, provenance, retention | boot | maintenance | with flags |

### 2.2 Tested, **nothing calls them** — the failure the directive warns about

| Module | What it is | Tests | Verdict for Phase B |
|---|---|---|---|
| `circuit-breaker.js` | per-child breaker so a dead child is skipped, not waited on (I6) | `mesh-aggregation.test.js` | `ARCHITECTURE.md` cites it as one of I6's three guards, yet no production sweep constructs one. Either the hub's sweep (`hub-view`/maintenance) wires it or the I6 claim is overstated. **Wire it in Phase C** — a replica polling a primary is exactly the caller it was written for. |
| `backfill.js` | the order a newly-paired child sends its world (newest-first, bounded) | `mesh-aggregation.test.js` | Needed for a replica's **initial snapshot**. Wire or delete; do not leave a third state. |
| `fidelity.js` | per-hop thinning rules; proof-of-play on a refuse-list | `mesh-depth.test.js` | Only meaningful at depth > 2. Leave uncalled but **rename the test** to say it guards a vocabulary, not a behaviour, or delete. Not a scale-out concern. |

Everything else in the first grep that looked uncalled (`read-proxy`, `write-proxy`, `content-sync`,
`pull-download`, `read-worker`) is reached transitively or by path. Recorded so the next person does
not repeat the grep and draw the wrong conclusion.

### 2.3 Deliberately absent (do not build)

- `redistributes-content` capability — **available now** (`capabilities.js`, guarded by
  `declaring redistributes-content grants no authority over anyone`): a resource declaration, with
  the authority held per push by the content owner (`mesh_content_provenance.relayable`). Note
  `docs/mesh-relay-design.md` still opens with "REFUSED by validation" — that sentence is stale;
  its "Decision taken: both modes" section is what shipped. Scale-out does **not** need it: a
  replica serving *cached assignments* to its own players is serving its own mirror, not
  redistributing a customer's media to a subtree.
- Any compiled-in relay host, any automatic fallback — `test_no_builtin_relay_address`,
  `test_no_automatic_relay_fallback` stay source-level.
- `MESH_MAX_DEPTH` > 2 — `THE DEPTH CAP IS STILL 2`. Scale-out is **depth 1** (primary ↔ replica);
  a replica that is also a hub for sites is depth 2. Nothing here needs 3.

### 2.4 Invariant guard status

| | Guard | Status |
|---|---|---|
| I1 | `test_mesh_off_by_default` | passing |
| I2 | `test_downward_handlers_are_an_allowlist`, `a write grant can never arrive over the wire` | passing — the reviewed downward allowlist is exactly `mesh:read`, `mesh:write`, `mesh:hello`, `mesh:content-offer`, `mesh:content-purge` (`mesh-invariants.test.js:98`); every one is answered on the child by a grant the child's operator set. Adding a downward message for scale-out is a deliberate edit to that list with a reason. |
| I3–I7, I9, I10 | named tests | passing |
| **I8** | **none** | ⏳ still unguarded. `grep -rl "I8\|hosted-shaped"` over `server/test` returns nothing. Phase B must specify the test; Phase C ships it or records the gap in `ARCHITECTURE.md` again, explicitly. |

---

## 3. Flags today

| Flag | Default | Read in | Effect |
|---|---|---|---|
| `MESH_ACCEPT_ENROLLMENT` | off | `config.js:72` | mounts `/pair/code`, `/mesh` namespace, hub routes/UI |
| `MESH_ALLOW_UPLINK` | off | `config.js:76` | mounts `/uplink`, starts `services/mesh-uplink` |
| `MESH_MAX_DEPTH` | 2 | `config.js:81` | depth cap; guarded |
| `MESH_MIN_NODE_VERSION` | `2.0.0-0` | `config.js:86` | version floor (prerelease-inclusive) |

There is no `NODE_ROLE`, no `PRIMARY_URL`. Capabilities are a **set** on the edge
(`role_capabilities`), never an enum on the node — Phase B must keep that.

---

## 4. How SQLite is opened today

`server/db/database.js:13-23`, one handle per process:

- `journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON` (pragma at open; an older comment
  in the same file says OFF — the pragma is what runs).
- `wal_autocheckpoint = 0` in the main process; checkpoints run **off-thread** in
  `db/wal-checkpointer-worker.js`, which opens its **own** handle (#149). A fallback re-arms auto-
  checkpoint if the worker dies.
- `lib/mesh/read-worker.js` opens a **third** handle, `readonly: true`, in a worker thread — the
  existing proof that "the read path cannot write" can be a property of the handle, not a code
  review. This is the pattern a replica's read serving should copy.
- `lib/preflight-deps.js` opens a scratch handle at boot to verify the driver.

**Process model: exactly one server process per data directory, by assumption, not by lock.** There
is no flock, no PID file, and no socket.io adapter — so two processes on one DB would each have their
own copy of every in-memory registry below and would not see each other's socket rooms. That, not
SQLite's writer lock, is why "run two node processes" is not scale-out.

In-process state that a second process would silently duplicate:

| Registry | Where | Consequence if duplicated |
|---|---|---|
| `rateLimits` map | `server.js:871` | limits halve |
| login / pair / TOTP lockouts | `lib/*-lockout.js` | brute-force budget doubles |
| `lib/command-queue` (queued device commands, TTL flush) | | commands queued on one process never reach a player on the other |
| `lib/apk-cache` slots | | harmless (derived from disk) |
| `services/heartbeat` liveness maps, `services/scheduler` timers | | two sweeps, duplicate offline alerts |
| mesh `backpressure` per-child counters | | caps halve |
| socket.io rooms (`/`, `/dashboard`, `/mesh`) | `ws/index.js` | a dashboard on process B never sees a device on process A |

---

## 5. Write map — every path that mutates workspace data

All of these must run on the primary and only on the primary.

### 5.1 HTTP (per route file; `router.post|put|patch|delete` count)

`auth` 24 · `devices` 16 · `playlists` 14 · `admin` 14 · `content` 11 · `device-groups` 10 ·
`workspaces` 9 · `org-sso` 9 · `mesh` 8 · `layouts` 8 · `admin-plugins` 8 · `mesh-enroll` 7 ·
`widgets` 6 · `approvals` 6 · `ai` 6 · `video-walls` 5 · `data-sources` 5 · `assignments` 5 ·
`tokens` 4 · `subscription` 4 · `slide-decks` 4 · `triggers` 3 · `stripe` 3 · `schedules` 3 ·
`revisions` 3 · `pip` 3 · `kiosk` 3 · `folders` 3 · `player-debug` 2 · `fonts` 2 ·
`custom-shaders` 2 · `agency` 2 · `white-label` 1 · `telemetry-collector` 1 · `status` 1
(import) · `provisioning` 1 · `plugin-submissions` 1 · `hardware-submissions` 1 · `embedded` 1 ·
`diagnostics` 1.

Inline in `server.js` (not routers): `POST /api/provision/pair`, `/api/devices/web-player`,
`/api/devices/:id/live/publish`, `/api/device/exit`, `/api/trigger`, `/api/widgets/:id/telemetry`,
`/api/brightsign/snapshot`, `/api/stripe/webhook`, `/api/plugin-submissions`,
`/api/admin/plugins/submissions`.

**Rule that falls out:** the method is the write signal. There is no GET that writes except
`GET /api/auth/verify-email` (token redemption) and the OTA check (stamps `ota_channel_served`) —
both must be named in Phase B as "GETs that go to the primary".

### 5.2 Socket events from players (`ws/deviceSocket.js`) — all write

`device:register` (upsert device, pairing), `device:heartbeat` (last_heartbeat, telemetry),
`device:info`, `device:playback-state`, `device:play-event` (proof-of-play; **never thinned**),
`device:event`, `device:log`, `device:screenshot`, `device:ota-status`, `device:content-ack`,
`device:connectivity-report`, `device:trigger-status`, `device:shell-result`, `device:exit`,
`disconnect` (offline stamp), `wall:sync*`, `group:sync*` (relayed to peers, not stored).

### 5.3 Socket events from dashboards (`ws/dashboardSocket.js`)

`dashboard:device-command`, `request-screenshot`, `remote-*`, `talk-*`, `live-publish` — these
**do not write the DB directly**; they are routed to a player socket (or queued in
`lib/command-queue`). They need the player's socket, which lives on whichever process the player
connected to. That is the first cross-node problem Phase B has to solve, and it is a routing problem,
not a write problem.

### 5.4 Background writers (`services/`)

`heartbeat` (offline sweep + alerts), `scheduler` (schedule evaluation → assignments),
`content-expiry`, `threshold-alerts`, `trialExpiry` (hosted), `alerts`, `billingEmails`,
`activationNudge`, `agency-digest`, `mesh-maintenance`, `mesh-uplink`. **Every one must run on the
primary only**; a replica running `heartbeat` would raise offline alerts for players it cannot see.

### 5.5 Stripe / billing / signing

`routes/stripe.js` webhook, `routes/subscription.js`, APK signing (`scripts/finalize-release.sh`) —
single-owner by nature; listed so Phase D can say "not scaled this way" with a source.

---

## 6. Hot read map — what a replica must serve

From the dashboard's own calls (`frontend/js/api.js`) and the device-detail/dashboard views:

| Read | Route | Already proxyable via `read-proxy` allowlist? | Mirrored in `mesh_mirror_*`? |
|---|---|---|---|
| Device list (the fleet page) | `GET /api/devices` | yes (`health`) | yes (`mesh_mirror_devices`, summary) |
| Device detail | `GET /api/devices/:id` | yes | partial |
| Telemetry history | `GET /api/devices/:id/telemetry` | yes | no (thinned per hop by design) |
| Screenshot | `GET /api/devices/:id/screenshot` | yes (`display-capture`) | no — bytes stay with the owner |
| Debug log | `GET /api/devices/:id/debug` | yes (`diagnostics`) | no |
| Assignments for a device | `GET /api/assignments/device/:id` | yes (`content-metadata`) | no |
| Groups | `GET /api/groups` | yes (`identity`) | no |
| Playlists list / detail | `GET /api/playlists`, `/:id` | yes (`content-metadata`) | no |
| Content library | `GET /api/content`, `/api/folders` | **no** | no |
| Schedules, layouts, widgets, walls, slide decks | `GET /api/...` | **no** | no |
| Activity log | `GET /api/activity` | **no** | no |
| Reports / proof-of-play | `GET /api/reports/*` | **no** | `mesh_mirror_play_logs` (full fidelity) |
| Status / version | `GET /api/status`, `/api/version` | n/a — local to the node | n/a |
| Live fan-out | `/dashboard` namespace events | **no** | no |

So today a hub can already show a fleet page for a site it observes. What it cannot do is be *the*
dashboard for that site: the content library, schedules, layouts and the live socket are missing,
and the allowlist is exact-path by design (I2 — widening it is a reviewed edit, not a wildcard).

---

## 7. What is genuinely new for scale-out (Phase B's scope)

1. **Naming the roles as capabilities, not a type.** `accepts-enrollment` on the primary's edge to
   a replica already exists. A replica is `consumes-telemetry` + (new) `serves-dashboard` +
   optionally `terminates-players`. An analytics sink is `consumes-proof-of-play` alone — exists.
2. **A replica dashboard** that reads mirrors first, proxies the rest via `read-proxy` (widening the
   allowlist to content/schedules/layouts/activity — each a reviewed line), and **307s every
   non-GET** to the primary. Never a second writer.
3. **Snapshot + incremental** for a replica: `backfill.js` (exists, uncalled) for the initial
   world, the existing envelope push for increments, `circuit-breaker.js` (exists, uncalled) around
   the replica's pull.
4. **Player termination on a replica** — the only item that touches I2. A player's events are writes
   to the primary's tables. They can arrive at the primary only under a grant category the
   **primary's operator** sets (a new write category alongside `content-push` / `device-command`,
   refused over the wire like them). Until that grant exists, players stay sticky to the primary,
   and a replica is dashboards-only. Cached assignments for a replica's own players come from the
   replica's mirror — I1 holds because the mirror is local.
5. **Failure semantics**: primary gone → replica serves last mirror with an `as_of`, writes return
   `503 {code:'primary_unreachable'}`, players hold cached playlists (they already do — that is
   the offline path every player has). No fallback to any address the operator did not type (I9).
6. **I8 test**: the topology harness (`test/helpers/mesh-topology.js`) is an **in-process graph**
   of `Node` objects — it has no notion of hosted vs self-hosted, so it cannot express I8 as it
   stands. The repo does have a two-real-servers pattern (`test/support-access-e2e.test.js`,
   `test/last-login-stamp.test.js` spawn `server.js` on free ports). I8 needs that shape: one
   process with `SELF_HOSTED=false` (hosted e-mail verification, trial sweep, hide-billing off),
   one with `SELF_HOSTED=true`; enroll A under B and B under A; assert the same grants, the same
   refusals, the same read answers in both directions. Phase B specifies it; Phase C ships it.

Not in scope, and said so: replacing SQLite, multi-writer, STUN/TURN, depth 3, a relay host.
