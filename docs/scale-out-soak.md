# Scale-out soak — does the merged behaviour survive the bad days?

*A checklist for an operator with two servers, and the CI run that walks the same path.
C1 (#395), C2 (#396) and C3 (#397) are on `main`; this adds no capability. Every row names the
unit test that already holds the property in isolation — the point of the soak is that they hold
**together, in order, on a real link**.*

**CI:** `server/test/scale-out-soak.test.js` — two real processes and a real socket.io player,
~70 s, deliberately slower than the replica's 30 s poll. Run it alone:
`cd server && node --test test/scale-out-soak.test.js`.

**By hand:** a primary (`MESH_ALLOW_UPLINK=true`) and a replica (`MESH_ACCEPT_ENROLLMENT=true`,
`PRIMARY_URL=<primary>`, the same `JWT_SECRET`), paired with `serves-dashboard`,
`terminates-players` and `caches-content`, `player-events` granted on the primary, one screen
pointed at the replica. `docs/scale-out.md` has the setup.

---

## 0. Stock flags off — the soak must refuse to start

| Do | Expect |
|---|---|
| `GET /api/status` on a server with no mesh flags | no `scale_out` key at all |

The soak has nothing to soak on such a node and says so (step 0). A stock install must not grow a
change log, a verdict, an outbox row or a cache file, ever — `test_change_log_triggers_absent_without_replication_grant`, `test_replica_cache_absent_on_a_stock_install`, `a stock boot with the flags off grows no cache`.

## 1. Primary down for longer than the replica poll (30 s)

| Do | Expect |
|---|---|
| kill the primary; wait > 30 s; `GET /api/status` on the replica | `scale_out.replica_of[].edge = "down"`, **`lag_s = null`** — never `0` |
| the screen keeps playing | it does: mirror + its own cache; heartbeats answered by the replica (`device:heartbeat-ack`) |
| `GET /uploads/content/<name>` for a file the replica has served before | `200`, no `x-st-served-by` — the replica origins it |
| the same for a file it never fetched | **`503 {"code":"primary_unreachable"}`** — never a blank 200, never a 404 dressed as success |
| the screen plays / advances | `scale_out.replica_of[].players.pending` grows; `oldest_age_s` climbs |
| a dashboard write on the replica | `503 primary_unreachable`, `retry_after: 30` |

Tests: `test_replica_serves_last_state_when_primary_down_and_reports_lag_unknown`,
`test_replica_cache_never_invents_a_file`, `test_play_event_buffered_while_primary_down_then_applied_in_order`.

## 2. Primary back — the outbox drains, in order, dated when it happened

| Do | Expect |
|---|---|
| start the primary; watch `players.pending` | goes to `0`; `edge = "up"` |
| `SELECT started_at, ended_at, completed FROM play_logs WHERE device_id = …` on the **primary** | rows with `started_at` **inside the outage window**, one per play, closed by their own `play_end`; not one row per 2 s of drain time |

The primary's runaway-player throttle judges by the event's own time (the replica stamps `ts` on
receipt). Test: the "never thinned on replay" half of
`test_play_event_buffered_while_primary_down_then_applied_in_order`.

## 3. Device token rotated on the primary

There is no rotate route: a token changes when the fingerprint-reclaim or enrol-key path mints one,
or when an operator writes one. The operator form, on the primary:
`UPDATE devices SET device_token = '<new>' WHERE id = '<device>';`

| Do | Expect |
|---|---|
| the screen registers on the replica with the **old** token | `device:auth-error {error:"Invalid device token"}`; the replica's `mesh_player_verdicts` row for that device is **gone** |
| …with the **new** token | `device:registered` |
| kill the primary; the screen (rebooted) registers with the token it last had verified | `device:registered` — the remembered verdict is honoured |
| age the verdict past `VERDICT_TTL_S` (7 d): `UPDATE mesh_player_verdicts SET verified_at = verified_at - 8*86400 WHERE device_id = …` on the replica; register again | **`device:throttled {reason:"primary_unreachable"}`** — waits; not a redirect |
| a wrong token while the primary is down | `device:throttled {reason:"primary_unreachable"}` — the replica cannot decide, so it never says yes |

So: a rotation during an outage cannot reach the replica until the primary is back — the window
is bounded by the TTL. Tests: `a cached verdict is overwritten by every answer, dropped on "no",
and not honoured past its TTL`, `test_verify_device_does_not_return_the_token`,
`test_no_automatic_player_failover_to_primary`.

## 4. The pin set fills `REPLICA_CACHE_BYTES`

| Do | Expect |
|---|---|
| put two slides in the screen's playlist; read both through the replica | stored (`x-st-replica-cache: stored` once, then a plain local hit) |
| set the cap so those two fill it (soak: `REPLICA_CACHE_BYTES=6000` with 1×1 PNGs); read a third slide that is **not** in any playlist | `200` with **`x-st-served-by: primary`** — served through, not stored; the two on-screen files are untouched |
| `GET /api/status` | `scale_out.replica_of[].cache`: `bytes == pinned_bytes`, both `<= cap_bytes`; `last_error` names the file that did not fit |

A file a `playlist_items.content_id` or a device `default_content_id` names is never the LRU
victim. Test: `quota: LRU eviction under REPLICA_CACHE_BYTES; a file larger than the cap is never
stored; status reports it` (the pinned half).

## 5. Revoke `terminates-players` / `player-events`

Either side can end the link. From the **primary**: `Servers → This server reports to → Revoke`, or
`DELETE /api/mesh/uplink/:id` — severs the uplink and drops `write_grant` (so `player-events`) with
it; the replica is **not told** (silence looks the same as an outage, on purpose, I1/I6). From the
**replica**: §6 below.

| Do | Expect |
|---|---|
| revoke on the primary; `SELECT revoked_at, write_grant FROM mesh_edges` there | `revoked_at` set, `write_grant NULL` |
| the screen already attached to the replica | **keeps playing**; its heartbeats are still acked by the replica; its events queue (and will be refused when the link returns without the grant — visible in `players.last_error`) |
| a new / wrong-token register on the replica | while the primary's socket is still up: `auth-error "Invalid device token"` (the primary refuses the verify); once it is gone: `device:throttled primary_unreachable` (waits). Never a registration. |
| a screen with a remembered verdict | reconnects until `VERDICT_TTL_S` |

Test: soak step 7; `test_player_events_need_the_primary_grant` (the grant half).

## 6. The replica ends it (roles and copy, from the side holding the copy)

**Servers → Topology → Disconnect** on the replica, or `DELETE /api/mesh/links/<primary node id>`
(instance owner/operator). The parent-side `disenroll` — same retain-and-mark-stale outcome as the
primary's own Revoke, initiated here.

| Do | Expect |
|---|---|
| the DELETE | `200 {ok, filesDropped, copiedWorkspacesRetained, summary}`; a second call `409` |
| the primary, within its retry (~seconds) | `scale_out.replicas[].link = {connected:false, last_error:"This connection is no longer authorised…"}` — refused at the door, its live socket was dropped |
| any register on the replica for that primary's screens | `device:auth-error {reason:"read_replica", primary_url:…}` — C1's answer |
| the screen already attached | keeps playing; heartbeats still acked |
| media cached for that edge | **unlinked at once**; `mesh_content_cache` empty for it |
| `SELECT COUNT(*) FROM content WHERE workspace_id = '<copied ws>'` on the replica | **unchanged** — the copied rows stay, read-only and no longer updated (a change on the primary no longer arrives); the bytes do not |
| `GET /api/status` on the replica | no `scale_out` block for that primary any more |

A role also ends when the edge's token expires: `cachesContent`/`terminatesPlayers` check
`edgeIsActive`. Tests: `scale-out-disconnect.test.js`, `test_replica_cache_follows_a_primary_delete`
(revoke half), `test_replica_without_terminates_players_still_refuses_register`.

## 7. Same for a deleted slide

| Do | Expect |
|---|---|
| delete the content row on the primary | after the next incremental the replica's row is gone **and** its file is unlinked; no `.part` |

Test: `test_replica_cache_follows_a_primary_delete`.

---

## What the soak deliberately does not cover

Play-log replication (there is none: proof-of-play reaches the primary through `player-event`),
dashboard socket fan-out of replica-applied changes (a dashboard on the replica sees them on its
next fetch), automatic promotion (there is none; `docs/scale-out.md` has the manual steps), and
anything that would need a new table, grant or route.
