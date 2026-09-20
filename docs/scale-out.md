# Scale-out: one writer, many readers

*Operator guide for a **replica** — a second ScreenTinker server that holds a live, read-only copy of
another server's workspaces and serves their dashboards. The design and its reasoning are in
[scale-out-design.md](scale-out-design.md); the inventory that led to it is in
[scale-out-inventory.md](scale-out-inventory.md). This page is what to do and what to expect.*

**Phase C1** scales dashboards. **Phase C2** lets screens connect to a replica too — see
[Players on a replica](#players-on-a-replica-c2). What is still not scaled is listed at the end.

---

## When to add a replica — and when not to

A replica helps when the **dashboard** is the thing that is slow or far away: an estate in three
regions whose operators sit next to a server that is not the one holding the data, or a fleet page
that a hundred operators reload while the primary is busy talking to a thousand screens. Reads move
to the replica; every write still goes to the primary, and the primary still runs every sweep.

A replica does **not** help when the primary is slow because of **players**: heartbeats, content
downloads, live view. Those stay on the primary in C1 (§6 of the design covers moving them). It
also does not help a single overloaded SQLite writer — one process still owns every write, by design.

Do not add a replica to "have a backup". A replica is a copy of the workspaces you shared, minus
every secret, that cannot become the primary on its own. Backups are in
[operations.md](operations.md).

---

## How it works, in one paragraph

The primary is an ordinary self-hosted server with `MESH_ALLOW_UPLINK` set. The replica is an
ordinary server with `MESH_ACCEPT_ENROLLMENT` set and `PRIMARY_URL` pointing at the primary. You
pair them the same way you pair any two mesh servers — a code minted on the replica, redeemed on
the primary — choosing the `serves-dashboard` role and the **workspace-replication** grant. From
then on the primary keeps a change log (SQLite triggers, created only while that grant exists) and
the replica pulls a snapshot, then every change, over the same mesh link, into the same tables its
own workspaces live in. Rows that arrived this way are tagged with the primary's node id on the
workspace (`workspaces.origin_node_id`); every route serves them unchanged. A request that would
**change** one of those workspaces is caught in one place — the tenancy resolver — and forwarded to
the primary as-is, with the operator's own token. Nothing is applied on the replica.

**Passwords, tokens and secrets are never copied.** The consent text says so next to the grant, and
`test_replication_blocklist_covers_every_secret_column` fails the build if a new column that looks
like one is not on the blocklist.

---

## Setting it up

### 1. The two servers

| | Primary | Replica |
|---|---|---|
| `MESH_ALLOW_UPLINK` | `true` | — |
| `MESH_ACCEPT_ENROLLMENT` | — | `true` |
| `PRIMARY_URL` | — | `https://primary.example.com` (what the replica forwards writes to) |
| `JWT_SECRET` | **the same value** | **the same value** |
| `SELF_HOSTED` | as today | as today (may differ — see I8 below) |

`JWT_SECRET` must match because a session minted by the primary is presented to the replica.
**Login always proxies; the replica never verifies a password.** Copied users have no password
hash, so `POST /api/auth/login` for one of them is forwarded to the primary, and the token that
comes back is good on both. The replica is not an identity provider and must not become one.

`PRIMARY_URL` has no default. Leave it unset and the replica serves reads and answers every write
with `409 read_only_replica`; nothing is compiled in and nothing is discovered
(`test_no_builtin_primary_url`).

### 2. Pair

On the **replica**, as the instance owner: **Servers → Let another server report to this one**,
tick **A complete, live copy of the shared workspaces…** (the `workspace-replication` grant; the
code then carries the `serves-dashboard` role alongside the usual telemetry role), read the
consent text under the tick, and generate the code. Over the API the same thing is
`POST /api/mesh/pair/code {"capabilities":["serves-dashboard","consumes-telemetry"],"grant":["workspace-replication"]}`.

On the **primary**: **Servers → Report this server to another one**, enter the replica's address
and the code, and choose the workspaces to share (or all). The primary creates its change-log
triggers the moment the edge is saved and starts reporting; the replica starts its snapshot the
moment the link comes up.

### 3. Watch it fill

`GET /api/status` on either server carries a `scale_out` block once the edge exists — and not
before, because roles come from edges, never from a `NODE_ROLE`:

```json
"scale_out": {
  "role": ["replica"],
  "replica_of": [{ "node_id": "…", "phase": "idle", "last_applied_rev": 412,
                   "as_of": 1789790523, "lag_s": 3, "edge": "up", "snapshot": null, "workspaces": 2 }]
}
```

`phase` is `snapshot` while the initial copy pages (with a `snapshot: {tables, done, rows}`
counter), then `incremental`/`idle`. `lag_s` is the age of the last applied change **and is `null`
while the link is down** — a replica that has not heard from its primary does not report a lag of
zero (I6: silence is not success).

On the primary, `scale_out.replicas[]` lists each replica with the last change revision it has
acknowledged, and `head_rev` is the primary's current position. `head_rev - acked_rev` is the
backlog.

---

## What an operator sees on a replica

- Every dashboard page for a copied workspace, from the copy. GETs are answered locally and never
  carry `x-st-served-by`.
- Every change — a rename, a publish, an upload, a schedule, a member or invite change on the
  workspace itself, an import — is forwarded. The response carries
  `x-st-served-by: primary` and the primary's own status: a `403` from the primary is a `403` here,
  not a `503`. The change then flows back to the replica through the change log; the bound is the
  30 s poll, and in practice the ~1 s change notice.
- Screen status (online/offline, last heartbeat, app version) arrives on the primary's
  `device-summary` report, every 60 s. That is the staleness bound for liveness on a replica.
- If the primary is unreachable, reads keep working from the copy and writes answer
  `503 primary_unreachable` with `retry_after: 30`. The replica never tries another address
  (`test_no_builtin_primary_url`), and the dashboard says which node it could not reach.
- The replica's **own** workspaces are unaffected: writes to them are applied locally as on any
  server. Sweeps (offline detection, schedules, content expiry, alerts, data-source polling, trial
  and nudge emails) run for the replica's own rows only — never for a copied workspace
  (`test_replica_never_runs_primary_sweeps`).

**Replica writes assume Bearer.** The forwarded request carries the operator's `Authorization`
header and nothing else that identifies them: cookies are stripped, and the primary's `Set-Cookie`
never reaches the browser through a replica. The dashboard is JWT-only, so this changes nothing for
it; a reverse proxy that added cookie sessions in front of the replica would not survive the hop.

**307 instead of proxying** — `PRIMARY_REDIRECT=true` — answers writes with a `307 Location` on the
primary instead of forwarding them. Browsers drop `Authorization` on a cross-origin redirect, so
this only works when one load balancer fronts both nodes. Leave it off unless that is your shape.

---

## Players on a replica (C2)

By default a replica serves dashboards only: a screen pointed at it is refused with
`read_replica` and the primary's address, so a mis-pointed panel says so on its setup screen
instead of pairing into a copy. To let screens connect to the replica, two operators each do one
thing:

1. **On the replica**, when minting the pairing code, tick *Also let screens connect to this
   server* under the copy tick (the `terminates-players` role; it needs `serves-dashboard` on the
   same edge). Over the API: `capabilities: ["serves-dashboard","terminates-players","consumes-telemetry"]`.
2. **On the primary**, after the link is up: **Servers → This server reports to → What this server
   may change** — tick **Let screens connect through the other server and report back here**
   (the `player-events` write grant) and choose the workspaces. Over the API:
   `PUT /api/mesh/uplink/:id/write-grant {"categories":["player-events"],"workspaces":[…]}`.

The grant is a WRITE grant on the primary, set only by the primary's operator. Nothing in a
pairing code, an enrolment answer or any message can set it (I2, I10) — a player event is a write
arriving at the data owner over the wire, and it is accepted only because the owner said so.

**What happens then.** A screen pointed at the replica pairs there: the replica asks the primary
to create the row (only the primary can mint a token; the token crosses once, to the screen, and
the replica keeps only its hash). The operator claims the code in either dashboard — the
replica's proxies to the primary — and the screen is told through the link. From then on:

- **Verification** is one question to the primary per socket: *is this device + token hash
  yours?* The answer is yes/no and the workspace; the token never leaves the primary
  (`test_verify_device_does_not_return_the_token`). The replica remembers a *yes* by hash, so
  the same screen can reconnect while the primary is unreachable. A screen it has never verified
  waits (`device:throttled`, 15 s) — it is never turned away and never redirected.

  **How long a remembered verdict lives.** Every answer from the primary overwrites it: a token
  rotated or revoked on the primary answers *no* at the screen's next register and the row is
  dropped, so while the primary is reachable a verdict is never older than the last register.
  While the primary is *unreachable* the verdict is the only thing standing between an old token
  and a socket, and that window is bounded: a verdict older than **7 days** (`VERDICT_TTL_S`) is
  not honoured and the screen waits. Rotating a token on the primary during an outage therefore
  cannot take effect on the replica until the primary is back — plan a rotation for a time when
  it is.
- **Assignments, playlists and media** come from the replica's mirror. A publish on the primary
  reaches the screen when the change replicates (the ~1 s notice, 30 s at worst). Media is fetched
  through from the primary per request (no cache yet).
- **Every event** the screen sends — online/offline, heartbeat, health, what it played, command
  results — is forwarded to the primary as a `player-event` write and applied there by the same
  code a directly connected screen runs. The replica keeps a durable, ordered outbox per primary
  (`mesh_player_events`): proof-of-play rows are never thinned or dropped and carry the time they
  happened on the replica, so a backlog drained after an outage is dated correctly; heartbeat-shaped
  events coalesce last-wins; live debug log lines are sent when the link is up and never queued.
  `GET /api/status` → `scale_out.replica_of[].players` shows what is pending.

  **The outbox is bounded.** Per primary, rows older than **14 days** are expired and past
  **500,000 rows** new play events are refused (both counted in `players.expired` /
  `players.refused_at_cap`). Heartbeats take one row per screen and logs take none, so what
  accumulates is plays: at one play every 8 s the cap holds about a fortnight of a 100-screen
  site. An outage longer than that loses the oldest evidence, and says so.
- **Commands** are the primary's. A command issued on the primary finds no local socket, sees
  `devices.attached_node_id`, and sends a `command-relay` up the edge; the replica emits it to the
  socket it holds. A command issued on the *replica's* dashboard goes REST → proxy → primary → relay
  — the replica never commands a copied screen itself, so there is one command path.

**When the primary is down**, screens attached to the replica keep playing from the mirror and
their own cache; their heartbeats are acked by the replica; their events queue; a reboot
reconnects on the cached verdict (a screen the replica has never verified waits instead). Media
is not cached on the replica — it is fetched through from the primary — so what keeps a screen
lit through an outage is **the player's own offline cache** of what it had already downloaded. A
screen that reboots and had never cached its media shows a black slot until the primary returns;
a playlist changed on the primary during the outage cannot reach the replica until then either. When it returns, the queue drains in order and `play_logs` gain
the rows (`test_play_event_buffered_while_primary_down_then_applied_in_order`; the two-process
`scale-out-c2-e2e.test.js` does exactly this with a real player socket).

**When the replica is down**, its screens reconnect to *it*, with backoff, as they would to any
server. They do not fail over to the primary unless their own server-URL list says so — no
automatic reroute (I9, `test_no_automatic_player_failover_to_primary`).

**When the edge is revoked** — on the primary, which is where revocation lives — the primary stops
reporting and drops the `player-events` grant, so forwarded events are refused and a screen it has
never verified through this replica cannot be verified; screens with a remembered verdict keep
reconnecting until `VERDICT_TTL_S`, and screens already attached keep playing from what they have.
The replica's own edge row is not told (silence looks the same as an outage, on purpose).

**The replica can end it too** — the node holding a copy must be able to stop holding it:
**Servers → Topology → Disconnect** next to that primary (`DELETE /api/mesh/links/<node id>`,
instance owner/operator). At once: the edge is revoked here and the primary's live socket is
dropped (its next connection is refused at the door, visible on the primary as
`scale_out.replicas[].link.connected: false`); pulling stops; new screens are refused with
`read_replica`; every media file cached for that primary is removed. The copied workspaces are
**kept**, read-only and no longer updated — the same retain-and-mark-stale default the primary's
Revoke has, so a report does not rewrite itself because somebody clicked disconnect. Screens
already attached keep playing what they have. `docs/scale-out-soak.md` walks through both sides.

A replica **without** the role, or a primary **without** the grant, behaves exactly as C1
(`test_replica_without_terminates_players_still_refuses_register`).

---

## Replica content cache (C3)

By default a replica holds copied **rows** and fetches media **bytes** through from the primary on
every request (see above). To let it keep the bytes, tick *Also keep copies of the media files
here* under the copy tick when minting the pairing code (the `caches-content` role; over the API,
`capabilities: [..., "caches-content"]`). No grant changes on the primary: the authority is the
copy grant its operator already gave; this tick is the replica's operator agreeing to spend disk.

- **When files appear.** The first time a file is asked for (a dashboard thumbnail, a player
  download) the replica fetches it from `PRIMARY_URL`, checks its size and — when the row carries
  one — its sha256, stores it, and serves it. Content that lands by replication into a cached
  workspace is also fetched in the background, one file at a time, so an outage usually finds
  the recent files already here.
- **With the primary down**, a file the replica has already stored is served as a plain local
  file — a *new* player, or a dashboard preview, gets it. A file the replica has never fetched
  answers `503 primary_unreachable`, exactly as without the cache; nothing is invented.
- **Quota.** `REPLICA_CACHE_BYTES` per primary, default 10 GiB — per primary on purpose, so one
  busy primary cannot starve another's files; a replica of two primaries may spend twice that,
  and `/api/status` → `scale_out.replica_of[].cache` shows `bytes`, `pinned_bytes` and
  `cap_bytes` for each so it is obvious which one is fat. Least-recently-read files are evicted
  to make room, **except files a playlist item or a screen's default content still names — those
  are pinned** (the slide on screen after an outage is exactly the file the replica may not have
  served for days). If the pinned set alone fills the cap, new files are served through, not
  stored. A file larger than the whole cap is never stored. A row that records no bytes
  (`file_size` 0) is never cached. If the disk fills mid-fetch the request is served through and
  `cache.last_error` says so.
- **When files leave.** Deleted on the primary → gone here after the next incremental. Link
  revoked, or the role removed → every file cached for that primary is removed on the next sweep
  (the copied rows stay as long as the mirror does; the bytes do not).

This is a different thing from the **player's own offline cache** (C2): a screen keeps playing
from what it downloaded whether or not the replica caches anything. The replica cache is for the
screen that has not downloaded yet.

---

## NOC on this server

**Servers → Topology → Open the live NOC**, or `#/noc` — instance owner only, and only where the
mesh is on (a stock install has no nav item and `GET /api/mesh/noc` is a 404). It is the graph of
**this server's** mesh and nothing further: this server, each server it reports to, each server
that reports to it, and the servers whose reports demonstrably travelled through a child. It is
not a view into anybody who did not enrol (I7, I8), it discovers no address, and it dials nothing.

- **Nodes** carry the name, the short node id and one role word (`primary` / `replica` / `hub` /
  `relay`) so two servers with the same hostname never look alike, plus `dashboard` / `players` /
  `cache` for what a child is served with here, and screen **counts** — online / total / stale /
  attached here.
- **Links** are coloured connected / lagging / down / revoked and captioned with the state word and
  the *copy lag* (`?` when the link is down — a lag is never invented), `acked/head` revision on an up link, and on a down
  link the outbox depth, cache bytes, and the C2/C3 counters (`players.sent`, `expired`,
  `refused_at_cap`, `cache.stored`). Click a node for the full card.
- **Movement** is a pulse on a link when its applied revision or its outbox depth changed since
  the last poll — the two numbers that mean rows or events crossed it. Counters, not envelopes;
  nothing is streamed to the browser.
- **Disconnect** on a child's card is the same control as Topology's (`DELETE /api/mesh/links/:id`),
  with the same consent text. There is no promote button.

**The chip is attention, the drawer is the board.** A server's chip carries its name, `n/m online`
(`no screens` when it holds none) and a red ring when something about it needs a click: a link to
it is down, its copy lag cannot be stated, or — for this server only — the filesystem under
`DATA_DIR` is below 10% free. Everything else is one hover or one click away: the short id and
roles in the chip's hover title, the link caption (state, copy lag, outbox, acked/head) on hover or
when the link touches the selected server, and the numbers in the drawer. Under the header a strip
shows this process's CPU (one core = 100%), resident memory and free disk, sampled on each poll;
`—` means the probe could not answer, never `0`. A child's host figures are not scraped — its
reports carry none today, so the drawer shows none. The screen table adds CPU, memory and storage
columns only when some listed screen has reported them, and a playlist column only when a title
exists.

**Two different ages, deliberately not one number.** *Copy lag* on a link is the age of the last
change-log revision this replica **applied** — how far the copy trails the primary; it is
`?` (unknown) when the link is down, never a reassuring `0`. *Seen* on a screen row is the seconds
since that screen's last heartbeat or device summary — how far the screen trails reality. A link
with a 3 s copy lag can still carry a screen not seen for a day, and a link that is down changes
nothing about a screen that is heartbeating to a replica. Selecting a node loads its screen table
(stale first, 50 rows, "and N more" to the Displays list) and its last five alerts, and while it
stays selected that one node's table is re-asked on each poll — one extra bounded query for the
selected node, never a screen list for every node — so *seen* ages with the graph instead of
sitting frozen under a pulsing link.

**What it costs.** One `GET /api/mesh/noc` every 3 s *while the page is open and the tab is
visible*; it stops on navigating away and on a hidden tab — so **"as of" freezes when the tab is
hidden** (a background window, another tab in front, DevTools detached over it). That is the rule
working, not a stuck page; it resumes when the tab is visible again. The answer is built from what this node
already holds — its edge rows, its own `scale_out` status, grouped screen counts, a few in-memory
counters — in O(edges), with no per-screen scan. Opening the NOC starts no snapshot, no cache
fill and no mesh read (`test_noc_poll_moves_no_data`, twenty polls on two real processes).

**A second tier (a replica that is itself a primary's hub).** A server can carry both flags:
`MESH_ALLOW_UPLINK` to report to a hub above it and `MESH_ACCEPT_ENROLLMENT` + `PRIMARY_URL` to
hold copies of primaries below it. Three things decide whether the top hub sees the bottom tier:

- **Depth.** `MESH_MAX_DEPTH` defaults to 2 (a hub and its children). A child of a child is level
  3 and is refused at pairing with the depth message; raise it on the *middle* server only when
  you mean to build that shape.
- **Consent from below.** A grandchild is relayed upward only after its own operator allows it:
  Servers → the uplink card → *Let this server pass your screens further up* on the grandchild
  (`PUT /api/mesh/uplink/<edgeId>/share-upward {"allow":true}`). Until then the top hub's NOC does not know it exists — that is the
  consent rule, not a fault. The middle server needs `relays-for-subtree` from the top hub.
- **What is relayed is a summary, not a copy.** The top hub learns the grandchild as *reached
  through a child* (`N hop(s)`) with its screen counts from device summaries; a copied workspace is
  never re-shared, so the top hub holds no rows of the grandchild's and cannot proxy writes for it.

Seen on a 12-server estate with such a tier: the middle server's own copies of its children kept
its change log moving, and the top hub's cursor parked at the last revision it was granted — the
link read `acked 437/626` and the log could never be pruned past 437. Since 2.1.5 the cursor
parks at the examined head on a short page, so `acked` follows `head` within one poll.

---

## I8 — hosted-shaped and self-hosted, both directions

The primary may be `SELF_HOSTED=true` and the replica hosted-shaped, or the reverse. A copied
workspace is served the way its **primary** serves it: the replica's own billing, trial, email-verify
and activation plumbing never touches copied rows (the trial and billing columns are on the
blocklist; the user-driven sweeps carry `LOCAL_USERS_SQL`). `server/test/scale-out-e2e.test.js`
boots both pairs — two real processes each way — and diffs the answers route by route.

---

## Promotion is manual

A replica does not become the primary on its own, ever. If the primary is gone for good:

1. Stop the old primary if it can still be reached. **An old primary must refuse to accept the
   same workspaces again until `origin_node_id` has been reconciled** — two servers that both think
   they own a workspace are the split-brain this whole design exists to prevent.
2. Sever the link from the replica: **Servers → Topology → Disconnect** next to the old primary
   (`DELETE /api/mesh/links/<old primary node id>`). The copied workspaces stay, read-only.
3. Clear the tag: `UPDATE workspaces SET origin_node_id = NULL, replica_rev = NULL, replica_as_of = NULL WHERE origin_node_id = '<old primary node id>';`
   From that point the rows are local, writes apply locally, and sweeps run.
4. Users of those workspaces have no password on the promoted node. They reset their password
   (`/api/auth/forgot`) — nothing else can be done about a secret that was never copied.
5. Players. Screens that were attached to this replica (C2) are already here: clear their
   `attached_node_id` (`UPDATE devices SET attached_node_id = NULL WHERE attached_node_id IS NOT NULL;`)
   and they become local screens at their next register — but they have no token on this node
   (tokens were never copied), so each must re-pair once. Screens that were on the old primary are
   re-pointed by the operator (`set_server_url`) and re-pair the same way. **The old primary must
   not accept those device tokens again**: keep it stopped, or revoke the tokens on it, until its
   `origin_node_id` reconciliation is done — a screen that can still reach the old primary with a
   valid token is a screen reporting to two servers.

There is no `promote` button because every step above is a decision an operator should make
knowing what it means, and because a button implies the reverse exists. It does not.

---

## What is not scaled yet

Documented gaps, in the order they are likely to matter:

- **`/api/update/check`, live view, screenshots-on-demand and LAN triggers** still talk to the
  primary; a screen attached to a replica reaches them there only if it can. Playback, pairing,
  heartbeats, proof-of-play and commands work through the replica (C2).
- **Uploads are proxied whole, and content bytes are fetched through on every view.**
  `POST /api/content` from a replica streams the upload to the primary; the content row then comes
  back through replication, and the file and thumbnail are fetched from `PRIMARY_URL` each time
  the dashboard asks for them (`/api/content/:id/file`, `/uploads/content/<name>` — the latter only
  for a name that belongs to a copied row, so the public path is not an open proxy). There is no
  local cache unless the replica declared `caches-content` (see [Replica content cache](#replica-content-cache-c3));
  without it a copied workspace's media is unavailable on the replica while the primary is down,
  and an attached screen plays from its own cache.
- **Playback history is not copied.** `play_logs` stays on the primary. The Reports page on a
  replica says so for a copied workspace ("Playback history lives on the primary server") instead
  of showing an empty report as if nothing ever played. Proof-of-play reports run on the primary.
- **Dashboard live updates on a replica are polled, not pushed.** The replica's dashboard socket
  does not fan out changes that arrive by replication; the page sees them on its next fetch.
- **Cross-node uniqueness.** A user on the primary with the same email as a local user on the
  replica is not copied (the local row wins). Their memberships on copied workspaces are, and
  reference the primary's user id. Sign in on the replica as the primary's user and everything
  works through the proxy; the replica's dashboard for the local user shows nothing for the copied
  workspace. Rare, and loud (the replica logs each skip).
- **Multiple primaries per replica** work (one edge each, tagged separately), but a workspace can
  only ever have one origin.
