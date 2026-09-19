# Scale-out: one writer, many readers

*Operator guide for a **replica** — a second ScreenTinker server that holds a live, read-only copy of
another server's workspaces and serves their dashboards. The design and its reasoning are in
[scale-out-design.md](scale-out-design.md); the inventory that led to it is in
[scale-out-inventory.md](scale-out-inventory.md). This page is what to do and what to expect.*

**Phase C1.** Dashboards scale; players do not yet (they stay on the primary). See
[What is not scaled yet](#what-is-not-scaled-yet).

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
- Every change — a rename, a publish, an upload, a schedule — is forwarded. The response carries
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

## I8 — hosted-shaped and self-hosted, both directions

The primary may be `SELF_HOSTED=true` and the replica hosted-shaped (or the reverse). A copied
workspace is served the way its **primary** serves it: the replica's own billing, trial, email-verify
and activation plumbing never touches copied rows (the trial and billing columns are on the
blocklist; the user-driven sweeps carry `LOCAL_USERS_SQL`). `server/test/scale-out-e2e.test.js`
boots exactly that pair — two real processes — and diffs the answers route by route.

---

## Promotion is manual

A replica does not become the primary on its own, ever. If the primary is gone for good:

1. Stop the old primary if it can still be reached. **An old primary must refuse to accept the
   same workspaces again until `origin_node_id` has been reconciled** — two servers that both think
   they own a workspace are the split-brain this whole design exists to prevent.
2. On the replica, revoke the edge (Servers → the primary → Revoke). The copied workspaces stay.
3. Clear the tag: `UPDATE workspaces SET origin_node_id = NULL, replica_rev = NULL, replica_as_of = NULL WHERE origin_node_id = '<old primary node id>';`
   From that point the rows are local, writes apply locally, and sweeps run.
4. Users of those workspaces have no password on the promoted node. They reset their password
   (`/api/auth/forgot`) — nothing else can be done about a secret that was never copied.
5. Point the players at the new server (C1: they were on the old primary).

There is no `promote` button because every step above is a decision an operator should make
knowing what it means, and because a button implies the reverse exists. It does not.

---

## What is not scaled yet

Documented gaps, in the order they are likely to matter:

- **Players stay on the primary.** Heartbeats, content downloads, `/api/update/check`, live view and
  triggers all talk to the primary. A replica does not accept a player for a copied workspace.
- **Uploads are proxied whole, and content bytes are fetched through on every view.**
  `POST /api/content` from a replica streams the upload to the primary; the content row then comes
  back through replication, and the file and thumbnail are fetched from `PRIMARY_URL` each time
  the dashboard asks for them (`/api/content/:id/file`, `/uploads/content/<name>` — the latter only
  for a name that belongs to a copied row, so the public path is not an open proxy). There is no
  local cache in C1, and a copied workspace's media is unavailable on the replica while the primary
  is down.
- **Playback history is not copied.** `play_logs` stays on the primary, so the Reports page on a
  replica shows an empty report for a copied workspace. Proof-of-play reports run on the primary.
- **Dashboard live updates on a replica are polled, not pushed.** The replica's dashboard socket
  does not fan out changes that arrive by replication; the page sees them on its next fetch.
- **Cross-node uniqueness.** A user on the primary with the same email as a local user on the
  replica is not copied (the local row wins). Their memberships on copied workspaces are, and
  reference the primary's user id. Sign in on the replica as the primary's user and everything
  works through the proxy; the replica's dashboard for the local user shows nothing for the copied
  workspace. Rare, and loud (the replica logs each skip).
- **Multiple primaries per replica** work (one edge each, tagged separately), but a workspace can
  only ever have one origin.
