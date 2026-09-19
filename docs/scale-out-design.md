# Scale-out — Phase B: design (schema and interfaces, no behaviour)

One logical ScreenTinker deployment as **one writer, many readers**. Follows
[`scale-out-inventory.md`](scale-out-inventory.md) (Phase A) and is written in the shape of
[`mesh-phase0-design.md`](mesh-phase0-design.md): decisions, why, what they cost, and the judgement
calls that deserve a second opinion. Nothing here runs until Phase C, and Phase C ships each piece
behind the existing flags.

**Status: design for review. Not implemented.**

---

## 0. The decision everything else follows from

**A replica is a mesh parent. The primary is a mesh child.**

The inventory found that a data-owning node already pushes summaries upward, answers reads on
request, and is the only party that can set a grant on its data (I10); an observing node already
accepts enrollment, stores mirrors, and serves a dashboard from them. Scale-out is that edge, with
the observer serving *all* of the owner's workspace instead of a summary.

So the roles map onto the code that exists, with no new transport and no inversion of consent:

| Scale-out name | Mesh position | Runs | Flag it needs |
|---|---|---|---|
| **primary** | child / data owner | `services/mesh-uplink` — dials out to each replica; owns the SQLite writer; runs every background writer | `MESH_ALLOW_UPLINK` |
| **replica** | parent / observer | `ws/meshSocket` — accepts the primary's enrollment; holds a full-fidelity mirror; serves dashboards | `MESH_ACCEPT_ENROLLMENT` |
| **relay** | either, with `relays-for-subtree` | unchanged from today | as today |
| **analytics sink** | parent, `consumes-proof-of-play` only | unchanged | `MESH_ACCEPT_ENROLLMENT` |

The brief said "replica enrolls to primary". In wire terms it is the primary that redeems the
replica's pairing code and dials, and that is deliberate:

- **I10 falls out for free.** The party that types the grant is the party whose data it is — the
  primary's operator, on the primary, choosing what to share (`POST /api/mesh/uplink` already
  validates the workspace scope against what that user administers). A replica can *ask* for
  `workspace-replication` in its pairing code; the primary's operator agrees to it or does not.
- **No second transport, no inversion.** `Uplink` pushes, `meshSocket` receives; `mesh:read` asks
  downward under the allowlist. Every scale-out message is one of those two things.
- **NAT is the right way round.** A replica exists to be reachable (it serves dashboards); the
  primary need not be. Dial-out from the primary works wherever the replica is public.

Multi-parent is already permitted (`mesh_edges`, `UNIQUE (peer_node_id, direction)`), so one primary
with N replicas is N `up` edges and nothing new.

**`NODE_ROLE` is not introduced.** "Primary" and "replica" are what an edge's capability set means,
read off the edge — not an enum on the node that would forbid a node from being a replica for one
deployment and the primary of its own workspaces at the same time (which is exactly what a regional
office box is).

---

## 1. Vocabulary additions

All additive. Existing values are untouched; existing edges stay valid.

### 1.1 Capabilities (`lib/mesh/capabilities.js`) — declared by the **replica** in its pairing code

| Capability | Means | Requires on the same edge |
|---|---|---|
| `serves-dashboard` | this node serves HTTP GETs and the `/dashboard` socket for the shared workspaces from its mirror, and forwards writes to the primary | `consumes-telemetry` |
| `terminates-players` *(Phase C2)* | this node accepts player sockets for the shared workspaces, serves them assignments from its mirror, and forwards their events to the primary | `serves-dashboard`, and the `player-events` **write** grant set on the primary |

Capability is not permission (Phase 0). Declaring `serves-dashboard` with only a `health` grant gets
you a fleet page and nothing else — the same rule as today.

### 1.2 Grant categories (`lib/mesh/grants.js`)

| Category | Kind | Set by | What crosses the wire |
|---|---|---|---|
| `workspace-replication` | read | primary's operator | full-fidelity rows of the workspace-scoped tables listed in §3.1, minus the column blocklist in §3.2 |
| `player-events` | **write** | primary's operator, on the primary, via the existing `PUT /api/mesh/uplink/:id/write-grant` surface | player socket events forwarded by a `terminates-players` replica, applied through the primary's own device handlers |

`player-events` joins `content-push` and `device-command` in `validateGrant()`'s refuse list: it
**cannot arrive over the wire**, only be stored by the granting node's operator. The existing test
`a write grant can never arrive over the wire` extends to it by adding the name to the list it
iterates — no new mechanism.

### 1.3 Envelope payload types (`lib/mesh/envelope.js`)

| Type | Direction | Body |
|---|---|---|
| `change-notice` | up (primary → replica) | `{ workspace_id, rev }` — "I have changes up to rev N". Tiny, coalesced, sent on every write-burst and on reconnect. |
| `command-relay` *(C2)* | up (primary → replica) | `{ device_id, command }` — deliver this command to a player you terminate. |
| `player-event` *(C2)* | **down**, as a `mesh:write` op | `{ device_id, event, payload }` — one player socket event. Applied on the primary only under `player-events`. |

Unknown types stay `relayOnly` (I5). A pre-scale-out replica between a newer primary and a newer
hub forwards them unread.

### 1.4 Read-proxy allowlist (`lib/mesh/read-proxy.js`) — two new exact paths

| Path | Grant | Answers |
|---|---|---|
| `GET /api/mesh/snapshot?workspace=&table=&after_id=&limit=` | `workspace-replication` | a bounded page of rows of one table, ordered by primary key, for the initial copy |
| `GET /api/mesh/changes?workspace=&since=&limit=` | `workspace-replication` | `{ rows: [{rev, table, row_id, op}], upto }` from the change log |

Both are answered on the primary's **read worker** (readonly handle), like every other proxied read.

---

## 2. Enrollment, step by step

Identical in feel to pairing a site to a hub, because it is the same flow.

1. **On the replica** (`MESH_ACCEPT_ENROLLMENT=1`): operator opens Servers → *Add a server* and mints
   a code, ticking `serves-dashboard` and asking for `workspace-replication` (+ `health`,
   `identity`, `content-metadata`, `proof-of-play` as wanted). The code carries the *ask*.
2. **On the primary** (`MESH_ALLOW_UPLINK=1`): operator enters the replica's URL + code, and chooses
   **which workspaces** to share (existing `shareAllWorkspaces` / list, validated against what the
   user administers). The consent screen names what `workspace-replication` means in one sentence:
   *"A full copy of these workspaces' configuration, device state and play history will be held on
   `<replica name>` and kept current. Passwords, tokens and secrets are never copied."*
3. Existing checks run unchanged: code unburned, no cycle, depth ≤ 2, version ≥ floor.
4. The primary's uplink connects. First thing over the edge: `mesh:hello` (exists), then the replica
   starts the **snapshot** (§4). Until the snapshot completes, the replica's dashboard for those
   workspaces shows *"Copying from `<primary>` — 42%"*, not stale data.

Revocation from either side works as today (`edge-status.js`). A revoked replica keeps its mirror
**marked stale** and stops serving it after `retention_days`, the same rule mirrors already have.

---

## 3. What is replicated

### 3.1 Tables

Workspace-scoped, needed to render the dashboard read-only and to feed a player. In dependency order
(the snapshot copies in this order so foreign keys resolve):

```
organizations, workspaces, users*, organization_members, workspace_members,
folders, content, fonts, custom_shaders,
widgets, layouts, slide_decks, data_sources,
playlists, playlist_items, schedules, assignments,
device_groups, device_group_members, devices, device_telemetry (bounded window),
activity_log, play_logs, alerts, triggers, pip, kiosk, walls
```

`*users`: only `id, email, name, role, avatar_url, plan_id, created_at` — see §3.2.

Not replicated, ever: `mesh_*` (the replica has its own), `recovery_grants`, `support_*`,
`api_tokens`, `org_sso_*`, `totp_*`, `password_reset_*`, `stripe_*`, `plans` (seeded locally),
`schema_migrations`, `plugin_*`. A replica that needs any of these has stopped being a replica.

### 3.2 Column blocklist — the one place delete-based filtering is used, and why

`node-data.js` builds projections by *adding* what the grant allows (Phase 0). Replication is the
opposite problem: the point is a faithful copy, so the projection is "every column **except**". That
is a delete-based filter, which the codebase warns against because a column added later ships by
default. The mitigation is a **schema test**: `test_replication_blocklist_covers_every_secret_column`
walks `PRAGMA table_info` for every replicated table and fails if a column whose name matches
`/hash|secret|token|password|key|totp|stripe/` is not on the blocklist. Adding a secret column
without listing it fails CI, which is the fail-closed direction.

Blocklist at design time: `users.password_hash`, `users.totp_secret`, `users.email_verify_hash`,
`users.password_reset_hash`, `users.stripe_*`, `devices.device_token`, `devices.enrol_key`,
`devices.settings_pin`, `data_sources.credentials`, `widgets.secrets`.

`devices.device_token` is the sharp one: a `terminates-players` replica must authenticate its own
players. §6 handles it without the token leaving the primary.

### 3.3 Ownership tag — one column

`workspaces.origin_node_id TEXT NULL`. NULL means "mine". Set on every replicated workspace row to
the primary's node UUID. Every other replicated row is owned through its `workspace_id`, so **one
column decides** whether a write is local or remote, and the tenancy resolver already loads the
workspace row on every request.

---

## 4. Snapshot and incremental mirror — without dual writes

**The primary never writes to a replica. The replica never writes to primary tables on the primary.
The only thing that crosses is a change log the primary derives from its own writes.**

### 4.1 Change log on the primary

```sql
CREATE TABLE IF NOT EXISTS mesh_change_log (
  rev          INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  ts           INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_mesh_change_log_ws ON mesh_change_log(workspace_id, rev);
```

Populated by **SQLite triggers** (`AFTER INSERT/UPDATE/DELETE`) on each table in §3.1, so the 130
write handlers in the inventory need no edits and cannot forget one. Triggers are **created only
while an active `up` edge carries `workspace-replication`, and dropped when the last one is revoked**
(`services/mesh-uplink` at boot and on edge change). A stock install has no triggers, no log, no
cost — which is what "cannot tell this exists" requires. Guarded by
`test_change_log_triggers_absent_without_replication_grant`.

Rows are pruned once every active replica has acknowledged past them (`mesh_edges.last_sync_at`
holds the acknowledged rev per edge), with a floor of 7 days so a replica that was down for a weekend
resumes incrementally rather than re-snapshotting.

### 4.2 Snapshot (initial copy)

On first connect, or when the replica's `last_applied_rev` is older than the log's oldest row:

1. Replica reads `rev_now` via `mesh:read /api/mesh/changes?since=0&limit=1` (the head).
2. For each table in §3.1 order, pages `GET /api/mesh/snapshot` until empty, applying rows into its
   own tables with `origin_node_id` set on the workspace. **`backfill.js` decides the order and
   pacing** — it is the uncalled module whose whole purpose this is (newest devices first so the
   fleet page fills from the top; bounded batch; yield between pages).
3. Then applies `changes?since=<rev_now>` to close the gap opened while paging.
4. Marks the workspace `replica_as_of = now`, `replica_rev = head`.

Snapshot runs on the replica in a **worker thread with its own write handle** so a 400-screen copy
never blocks the replica's own dashboard (the I6 posture: one slow peer must not stall a node).

### 4.3 Incremental

The primary's uplink sends `change-notice { workspace_id, rev }` whenever the log advances
(debounced 250 ms, so a bulk publish is one notice). The replica answers by pulling
`changes?since=last_applied_rev` and, for each row, `snapshot?table=&row_id=` (or a batched form:
`changes` may inline rows ≤ 64 KB — Phase C decides by measurement, the interface allows both).
Applied in rev order inside one transaction per batch; `last_applied_rev` advances only after commit,
so a crash mid-batch replays, never skips.

A replica also polls `changes` every 30 s regardless of notices (silence is not success; a lost
notice must not mean a stale replica until the next write).

### 4.4 Lag bound — the number the dashboard shows

`replica_lag = now − ts(last applied rev)` when the edge is up; **`unknown` when the edge is down**,
never "0 s" — the uptime-report rule (`silence ≠ 100%`) applies to replicas too. Documented bound
under normal operation: notice debounce (250 ms) + one round trip + apply; **target < 5 s**, alarm
at 60 s. Surfaced in `/api/status` (§8) and as a banner on every dashboard page served for a
replicated workspace: *"Read-only copy of `<primary>` · as of 3 s ago"*.

---

## 5. Dashboard on a replica

### 5.1 Reads

**Unchanged route handlers run against the replica's own database.** Because replicated rows live
in the same tables under the same schema, `GET /api/devices`, `/api/content`, `/api/playlists`,
`/api/schedules`, `/api/activity`, `/api/reports/*` and the rest work without a second
implementation. This is the whole reason for logical row replication rather than a mirror schema:
the inventory's hot-read table has 14 rows, and 9 of them have no mirror today.

Exceptions, served by proxy (`mesh:read`, existing allowlist) because the bytes stay with the owner:
`GET /api/devices/:id/screenshot`, `/debug`, `/api/content/:id/file`, `/thumbnail`. A replica may
cache file bytes on disk under the primary's storage accounting — **only** if the edge also carries
`content-metadata`; otherwise it proxies each request.

### 5.2 Writes — never a second writer

Every non-GET for a workspace whose `origin_node_id` is set is intercepted in **one place**, the
tenancy resolver (`lib/tenancy.js resolveTenancy`), after the workspace row is loaded:

- If `PRIMARY_URL` is configured: the replica **reverse-proxies** the request to
  `PRIMARY_URL + req.originalUrl`, forwarding the `Authorization` header and body unchanged, with a
  10 s timeout. The primary authenticates the *user's* token and enforces every rule it enforces
  today. The replica adds nothing and removes nothing; it is a pipe, not a peer, for this request.
- If `PRIMARY_URL` is not configured: `409 { error, code: 'read_only_replica' }`.
- If the proxy fails: `503 { error, code: 'primary_unreachable', retry_after }`.

Why proxy rather than 307: browsers drop `Authorization` on a cross-origin redirect, so a 307 would
turn every write into a 401 unless the two nodes share an origin. 307 stays available as an
operator option (`PRIMARY_REDIRECT=1`) for same-origin deployments behind one load balancer, where it
is cheaper. Both are documented; proxy is the default because it works without a load balancer.

`PRIMARY_URL` is **operator-supplied**. It is not learned from the edge, not defaulted, not
discovered (I9). `test_no_builtin_primary_url` asserts no string literal resembling a host is used
as its default.

GETs that write (`/api/auth/verify-email`, `/api/update/check` stamping `ota_channel_served`) are
listed by exact path in the same interceptor and proxied like writes.

### 5.3 Authentication on a replica

- **Sessions**: JWTs verify on the replica with the **same `JWT_SECRET`**, an operator setting that
  the docs make explicit. The user row is present (replicated, minus secrets), so `resolveSessionUser`
  works unchanged.
- **Login, password reset, TOTP, SSO**: all POSTs → proxied to the primary (§5.2). The replica holds
  no password hash and cannot verify one; that is a feature, not a gap.
- **API tokens** (`/api/tokens`, scoped tokens): not replicated. A scoped token authenticates on the
  primary only. Documented; revisit if a customer needs read tokens on replicas.

### 5.4 Live events (`/dashboard` namespace)

A replica emits to its own `/dashboard` rooms whenever it applies a change or receives a
`device-summary` envelope — so a tab on the replica sees device state within the lag bound. Commands
from a replica tab (`dashboard:device-command`) are acknowledged `{delivered:false,
reason:'read_replica'}` and the frontend falls back to the REST command route, which proxies to the
primary. (`routes/devices.js POST /:id/command` refuses `settings` because it is not in
`ALLOWED_COMMANDS` while the socket path allows it — Phase C aligns the two lists; the inventory
found that inconsistency.)

### 5.5 What a replica does not run

Every service in inventory §5.4 checks `hasLocalWritableWorkspaces()` before scheduling. A replica
with no workspaces of its own runs **no** heartbeat sweep, scheduler, content-expiry, threshold
alerts, trial sweep. A replica that also owns local workspaces runs them **for those only** —
`workspaces.origin_node_id IS NULL` is the filter in each service's query.
`test_replica_never_runs_primary_sweeps` boots a replica-only node and asserts none of the
service timers arm.

---

## 6. Players on a replica *(Phase C2 — shipped; operator guide in scale-out.md)*

Phase C1 ships dashboards only; **players stay connected to the primary**. A replica in C1 refuses
`device:register` for a replicated workspace with `{ error: 'read_replica', primary_url }` so a
mis-pointed player says so on its setup screen instead of pairing into a copy.

C2 adds `terminates-players`, gated by the `player-events` write grant on the primary:

- **Authentication.** The replica has no `device_token`. It verifies a player by asking the primary
  once per socket via `mesh:read GET /api/mesh/verify-device?device_id=&token_hash=` (new exact
  path, `player-events` grant) and caches the answer for the socket's life. The token never leaves
  the primary; the replica learns only yes/no. If the primary is down, a player with a **prior
  verified session on this replica** reconnects on its cached verdict; a new player waits.
- **Reads.** Assignments, playlist payloads, content URLs come from the replica's mirror. A dead
  primary changes nothing for playback — the mirror is local (I1), and the player's own offline cache
  sits underneath that as today.
- **Writes.** Each player event is a `mesh:write` op of type `player-event`, applied on the primary
  through the same functions `ws/deviceSocket.js` calls for a directly connected player. This is the
  one refactor the design needs: the handler bodies become callable with `(device, payload, meta)`
  instead of closing over `socket`. `play-event` rows are **never thinned** and **never dropped**:
  the replica buffers them durably (`mesh_write_ops`, exists) while the primary is unreachable, and
  the primary applies them in order on reconnect. Health/heartbeat events are coalesced (last wins)
  in the same buffer.
- **Commands.** The primary's dashboard (or any replica's, via proxy) issues a command; the
  primary's `deliverCommand` finds no local socket for the device, sees `devices.attached_node_id =
  <replica>`, and sends `command-relay` **up** the edge; the replica delivers it to its local socket
  and the player's ack returns as a `player-event`. `attached_node_id` is a new nullable column on
  `devices`, written by the primary when it applies a `player-event` from a replica.

The I2 accounting for C2, stated plainly: `player-event` is a write arriving at the data owner over
the wire, and it is permitted **only** because the primary's operator set `player-events` on the
primary. `command-relay` is a parent acting on a child's upward message; it is permitted because the
replica's operator declared `terminates-players` for that edge. Both are edits to reviewed lists
with a reason, which is what the allowlist test asks for.

---

## 7. Failure semantics

| Event | Replica dashboards | Replica-attached players (C2) | Primary-attached players | Writes |
|---|---|---|---|---|
| Primary unreachable | serve last applied state; banner says *as of* and *lag unknown*; no fallback to any address not typed (I9) | keep playing from mirror + own cache; events buffered durably | keep playing from own cache (today's behaviour) | `503 primary_unreachable` |
| Replica unreachable | n/a | reconnect to the replica with backoff; **do not** fail over to the primary unless the player's own server-URL list says so (no automatic reroute, I9) | unaffected | unaffected |
| Edge revoked | mirror marked stale, served until `retention_days`, then 410 | refused with `read_replica` | unaffected | 409 `read_only_replica` |
| Primary disk dies | promotion (Phase D): operator clears `origin_node_id` on the replica's copy, severs the edge, sets the same `JWT_SECRET`, re-points players (`set_server_url`) | become primary-attached | re-pointed by operator | resume on the promoted node; data loss bound = last lag |
| Two nodes both believe they are primary | impossible by construction: "primary" is *having no `origin_node_id`* on a workspace, and only an operator's promotion clears it; nothing automatic does | | | |

Promotion is **manual and documented**, never automatic — automatic failover is how a peer design
acquires a coordinator, and it always arrives as a bug fix.

---

## 8. Metrics and visibility

`GET /api/status` gains, only when relevant (absent on a stock install):

```json
"scale_out": {
  "role": ["primary"] | ["replica"] | ["primary","replica"],
  "replicas": [{ "node_id": "…", "name": "…", "acked_rev": 1234, "lag_s": 2.1, "edge": "up" }],
  "replica_of": [{ "node_id": "…", "name": "…", "last_applied_rev": 1230, "lag_s": null,
                   "edge": "down", "as_of": 1758000000, "workspaces": 3 }]
}
```

`lag_s: null` when the edge is down — coverage, not a number that flatters. The Servers page shows
the same, and the uptime report gains a "replica coverage" line so a replica that silently fell
behind is visible in the artifact a customer reads.

---

## 9. I8 — the test, specified

Two **real** server processes (the `support-access-e2e.test.js` pattern), not the in-process graph:

- Node H: `SELF_HOSTED=false` (hosted shape: e-mail verification hard-block, trial sweep, billing
  routes mounted). Node S: `SELF_HOSTED=true`.
- Enroll S as a replica of H (H is primary). Assert: snapshot completes, a playlist published on H
  appears on S, a POST on S proxies and lands on H, revocation from S stops the feed.
- Tear down. Enroll H as a replica of S. Assert **the identical list**, with the roles swapped.
- Assert neither node's behaviour differs by `SELF_HOSTED` on any mesh route, grant, refusal or
  read answer (diff the two runs' response bodies after normalising ids and timestamps).

Named `I8: a hosted-shaped node and a self-hosted node scale out identically in both directions`.
If Phase C cannot make it pass, the gap goes back into `ARCHITECTURE.md` in words, as now.

---

## 10. Flags (final)

| Flag | Default | Who sets it | Meaning |
|---|---|---|---|
| `MESH_ACCEPT_ENROLLMENT` | off | replica | as today |
| `MESH_ALLOW_UPLINK` | off | primary | as today |
| `PRIMARY_URL` | unset | replica | where this node forwards writes for replicated workspaces. Operator-typed. No default. |
| `PRIMARY_REDIRECT` | off | replica | use 307 instead of a server-side proxy (same-origin deployments) |
| `MESH_MAX_DEPTH` | 2 | — | **unchanged** |

No `NODE_ROLE`. Roles are read from edges.

---

## 11. Schema summary (all additive; no-op on a stock install)

- `workspaces.origin_node_id TEXT NULL`, `workspaces.replica_rev INTEGER`, `workspaces.replica_as_of INTEGER`
- `devices.attached_node_id TEXT NULL` *(C2)*
- `mesh_change_log` (§4.1) + index; triggers created/dropped by the uplink service, never in the
  migration list
- `mesh_edges.acked_rev INTEGER` (replica's acknowledged position, written by the primary from the
  replica's ack; complements `last_sync_at`)

---

## 12. Tests Phase C ships with the behaviour

| Test | Guards |
|---|---|
| `test_change_log_triggers_absent_without_replication_grant` | stock install cannot tell this exists (I1) |
| `test_replication_blocklist_covers_every_secret_column` | no secret column ships by omission |
| `test_replica_refuses_or_proxies_every_non_get_for_remote_workspaces` | never a second writer |
| `test_no_builtin_primary_url` | I9 for the write path |
| `test_replica_never_runs_primary_sweeps` | one process owns the sweeps |
| `test_replica_serves_last_state_when_primary_down_and_reports_lag_unknown` | I1 + silence ≠ success |
| `test_player_events_need_the_primary_grant` *(C2)* | I2 / I10 |
| `test_snapshot_then_incremental_converges` | §4 correctness (publish 200 items during snapshot; replica ends equal) |
| `test_circuit_breaker_is_constructed_by_the_replica_pull` | the uncalled module becomes called |
| `I8: …identically in both directions` | §9 |
| existing `mesh-*` suites | unchanged; the downward allowlist gains `player-event` (C2) with a reason in the test |

---

## 13. Judgement calls worth a second opinion

1. **Row-level replication into the same tables vs. a mirror schema.** Chosen for reuse of 40 route
   files. Cost: the ownership check lives in one resolver and must not be bypassed by a route that
   skips `resolveTenancy` — a test enumerates routes and asserts every mutating one passes through it.
2. **SQLite triggers for the change log vs. instrumenting write handlers.** Triggers cannot be
   forgotten and cost nothing when absent. Cost: bulk operations (a 5,000-row import) write 5,000 log
   rows — bounded by the same chunked-prune discipline as `play_logs`.
3. **Reverse proxy vs. 307 for writes.** Proxy by default for the `Authorization` reason; 307
   optional. The proxy forwards bytes and headers, never re-signs or re-authorises anything.
4. **Players stay on the primary in C1.** It halves the surface for the first hardware run and keeps
   I2 untouched until there is a two-node deployment to test C2 against. The relay-tier document's
   reasoning applies: stacking an untested tier on an unproven one makes the first failure ambiguous.
5. **`JWT_SECRET` shared by configuration.** The alternative (replica-issued sessions) makes the
   replica an authority for identity, which is the thing it must not be.

---

## 14. Definition of done, mapped

| DoD | Where it is satisfied |
|---|---|
| 1. Two processes; replica dashboard shows live state lagged by a documented bound | §4.4, §5, `/api/status.scale_out` |
| 2. Publish on primary → replica reflects; publish on replica refused or proxied | §4.3, §5.2, `test_replica_refuses_or_proxies…` |
| 3. Kill primary: players keep content, replica read-only, no silent relay | §7, I9 tests unchanged, `test_replica_serves_last_state…` |
| 4. Flags default off; stock install cannot tell | §4.1 triggers, `test_mesh_off_by_default`, `test_change_log_triggers_absent…` |
| 5. I1–I10 pass; I8 has a real test or an explicit gap | §9 |
