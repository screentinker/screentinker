# Where media is stored

ScreenTinker can keep playlist media — each uploaded file, its thumbnail, its subtitle track and the
copies kept for version history — on any of:

| Provider | Covers |
|---|---|
| `local` (default) | `UPLOADS_DIR/content` on the server's own disk, exactly as before this feature |
| `s3` | Amazon S3 **and every S3-compatible store**: MinIO, Garage, Ceph RGW, SeaweedFS, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces. Google Cloud Storage works through its S3-interoperability (HMAC) endpoint. |
| `azure` | Azure Blob Storage, Azurite, sovereign clouds |

Nothing else moves. The SQLite database, fonts, screenshots, certificates, the JWT secret, the
plugin inbox and OTA packages stay on local disk.

With nothing configured, nothing changes: uploads land in `UPLOADS_DIR/content` byte for byte as
they always have, and no new rows are written anywhere.

## Configuring the instance default (environment)

Enough to boot with an empty database:

```sh
STORAGE_PROVIDER=local|s3|azure          # unset = local

# S3 and S3-compatible
S3_ENDPOINT=                             # blank = AWS
S3_PUBLIC_ENDPOINT=                      # the name SCREENS use; see "Presign or proxy"
S3_PUBLIC_BASE_URL=                      # optional CDN in front of a public-read bucket (unsigned URLs)
S3_REGION=us-east-1                      # required by the SDK even if the store ignores it; R2 uses "auto"
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_PREFIX=                               # optional; prepended to every key
S3_FORCE_PATH_STYLE=                     # default: true when S3_ENDPOINT is set, false for AWS

# Azure
AZURE_STORAGE_CONNECTION_STRING=         # or account + key below
AZURE_STORAGE_ACCOUNT=
AZURE_STORAGE_ACCOUNT_KEY=
AZURE_STORAGE_CONTAINER=
AZURE_STORAGE_ENDPOINT=                  # Azurite / sovereign cloud account URL
AZURE_STORAGE_PUBLIC_ENDPOINT=           # optional: the account URL screens can reach

STORAGE_PRESIGN_TTL_SEC=900              # clamped to 60..3600
STORAGE_DRAIN_AFTER_HOURS=               # unset = keep old copies until an admin removes them
STORAGE_LOCAL_READ_PRIORITY=0            # where local disk sorts among a file's copies (lower = first)
STORAGE_CACHE_MAX_MB=2048                # local cache for readers that need a file (bundles, exports)
STORAGE_ALLOW_PRIVATE_ENDPOINT=          # "false" to refuse a loopback/LAN endpoint even from env
```

Env credentials are never copied into SQLite.

**Env wins over the database.** If `STORAGE_PROVIDER` is set, it is the instance default even when
a platform admin once saved an instance-default profile in the dashboard. A redeploy with a new
bucket must get that bucket, not have it overridden by an old row. Unset `STORAGE_PROVIDER` and the
saved row (if any) applies.

Regions: AWS needs the bucket's real region; MinIO, Garage, Ceph and SeaweedFS accept anything
(`us-east-1`); R2 wants `auto`; B2 and Wasabi want the region in their endpoint (e.g.
`us-west-004`). ScreenTinker sends no checksum headers it is not required to send
(`requestChecksumCalculation: WHEN_REQUIRED`), which the newer AWS SDK otherwise adds and several
compatible stores reject. It does not need Object Lock, multipart checksums or Transfer
Acceleration.

### MinIO beside the server

```yaml
services:
  screentinker:
    image: ghcr.io/screentinker/screentinker:latest
    environment:
      STORAGE_PROVIDER: s3
      S3_ENDPOINT: http://minio:9000           # what the SERVER uses
      S3_PUBLIC_ENDPOINT: https://media.example.com   # what SCREENS use (omit: screens go through the server)
      S3_BUCKET: signage
      S3_ACCESS_KEY_ID: screentinker
      S3_SECRET_ACCESS_KEY: change-me-please
  minio:
    image: minio/minio
    command: server /data --console-address :9001
    environment:
      MINIO_ROOT_USER: screentinker
      MINIO_ROOT_PASSWORD: change-me-please
    volumes: [minio:/data]
volumes: { minio: {} }
```

Create the bucket once (`mc mb local/signage`). A loopback or private-network endpoint is allowed
from env; on a profile created in the dashboard it needs the "private network" option, which only a
platform admin can set on a hosted instance.

### Azurite

```yaml
  azurite:
    image: mcr.microsoft.com/azure-storage/azurite
    command: azurite-blob --blobHost 0.0.0.0
# and on screentinker:
      STORAGE_PROVIDER: azure
      AZURE_STORAGE_ACCOUNT: devstoreaccount1
      AZURE_STORAGE_ACCOUNT_KEY: Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==
      AZURE_STORAGE_ENDPOINT: http://azurite:10000/devstoreaccount1
      AZURE_STORAGE_CONTAINER: signage
```

## Three levels: instance, organization, workspace

A workspace's **new** uploads go to the first of these that is set:

| Level | Who sets it | Where |
|---|---|---|
| **Workspace** | Org owners and admins. Workspace admins too, but only when the organization turns on *Workspace admins may choose their own workspace's storage* (off by default). | Settings → Where media is stored → *This workspace: new uploads go to* |
| **Organization** | Org owners and admins | Settings → Where media is stored → *Organization: new uploads go to* |
| **Instance** | The server's environment, or a platform admin | `STORAGE_PROVIDER` etc. (above), or **Platform → System → Instance storage** |

If none is set, media goes to local disk.

- **The environment wins at the instance level.** When `STORAGE_PROVIDER` is set it is the instance
  default even if a platform admin also saved an instance profile. The Platform card shows the
  environment's choice and marks the stored profile *not in effect*. There is at most one stored
  instance profile.
- **A profile belongs to one level.** An instance profile can be used by every organization; an
  organization profile by every workspace in that organization; a workspace profile only by that
  workspace. A sibling workspace, or another organization, gets "no such profile". Org admins can
  see and manage their workspaces' own profiles; a workspace admin sees only their own workspace's.
- **A choice that stops working falls back.** If a workspace's chosen profile is deleted, made
  read-only, or its key can no longer be decrypted, new uploads go to the organization's choice
  instead of failing, and the settings page says so.
- A profile that a workspace or organization still points at, or that still holds files, cannot be
  deleted.

## Profiles (dashboard)

**Settings → Where media is stored**. An MSP customer can keep their media in their own account:
add a profile, test it, and pick it under *New uploads go to*, for the whole organization or for
one workspace. There is no per-file choice.

- Keys are encrypted at rest with the server's JWT secret and are **never shown again** — the
  dashboard shows only the last four characters of the key id. If `JWT_SECRET` changes, stored keys
  can no longer be decrypted; the profile says so and the key must be re-entered.
- **Changing *New uploads go to* does not move existing files.** Each content row records the
  profile and key it was written with. Moving existing media is the migration below.
- A profile belongs to one organization and is never usable by another.
- A profile endpoint goes through the same SSRF guard as data sources: cloud metadata and
  link-local addresses are always refused; loopback and private networks only with the profile's
  "private network" option.

## Presign or proxy: what a screen is told

Players still download a URL and cache the bytes for offline playback; none of them speaks S3.

| The chosen copy is… | The screen fetches |
|---|---|
| on local disk | `/uploads/content/<file>` exactly as before |
| in a bucket with a **public** endpoint (AWS itself, `public_endpoint`, or `public_base_url`), and the screen may fetch directly | a presigned GET (15 min by default, stable for a window so repeated payloads do not change it) |
| in a bucket screens cannot reach (an internal endpoint, a SAS-only Azure profile, or "download directly" switched off) | this server, which streams it from the bucket with Range support |

⚠️ **A screen must be able to resolve `public_endpoint`, or it will not be used.** ScreenTinker never
presigns the internal endpoint: `http://minio:9000` means nothing to a TV on the shop network. With
no public endpoint, screens are served through the server — which is also the air-gap path: a
screen on a private LAN that cannot reach AWS still plays, because it only ever talks to the
ScreenTinker server.

The device payload keeps its old `filepath` field, and old players keep building
`/uploads/content/<filepath>`; the server answers that from whichever stored copy is available. A
new `file_url` field carries an absolute URL (the presign, or `APP_URL/api/content/:id/file`) for
players that want it. Presigning can be switched off per workspace (Settings) or per device
(`devices.storage_direct_fetch = 0`).

Azure presigns are service SAS URLs scoped to one blob, read-only, short-lived, signed on the server
with the account key. The account key itself is never handed to a screen, and neither is an
operator-supplied SAS (with a SAS-only profile, screens are proxied).

## The refcount rule

One stored object can back several content rows: mesh-pushed content and identical uploads within
an organization share bytes. **An object is deleted only when no remaining row — in any workspace —
still names it, and only if ScreenTinker wrote it.** The row goes first, then the bytes, so a delete
that fails half-way leaves an unreferenced object, never a row pointing at nothing. Object deletes
are best-effort and logged, like local unlinks.

## Attaching an existing bucket

Add a profile in **read-only** mode, test it, then **Browse** to list it (folders, 200 per page) and
import what you choose:

- **Reference** — the content row points at your existing key. ScreenTinker never modifies, moves or
  deletes it. Nothing is downloaded to import it (a HEAD for the size, a 4 KiB ranged read to check
  the type); the thumbnail is made afterwards in the background. HTML bundles must be copied.
- **Copy** — the object is downloaded into the workspace's own storage through the normal upload
  path (type check, bundle validation, thumbnail, duration), respecting `MAX_FILE_SIZE`.

A read-write profile only ever writes and deletes under its own `st/` prefix — enforced in the
storage layer, not just the dashboard — so a bucket shared with your own objects is safe to use.

## Moving media: copy, dual-read, commit, drain

Moving an organization from local disk to S3, from S3 to Azure, or off a dead MinIO is a live
operation. **Screens keep playing throughout, from whichever ready copy answers.**

A move covers **one workspace** (*Move this workspace here*: on Switch, the workspace's own choice
is set to the target) or **the organization** (*Move organization here*: every workspace that
follows the organization; workspaces with their own storage are left alone). One move per
organization runs at a time. A workspace admin can start and manage only their own workspace's move.

1. **Copy** (*Move media here*). Every file is streamed from its first readable copy to the target
   and hashed on the way; on a match a verified copy is recorded. The old copy stays. Thumbnails and
   subtitles travel with their file; their failure does not fail the file. A file pushed to ten
   workspaces is uploaded once. New uploads during the copy go to the target first and to the old
   location as well. Progress is kept in the database, so a restart resumes where it stopped — and
   a restart never switches or deletes anything.
2. **Dual read.** While both copies exist, every read picks the first one that is up. A store that
   errors is skipped, and after three failures in 30 s it is not tried again for 60 s, so a dead
   bucket does not slow playlist pushes. If every copy fails, the screen gets the same 404 it
   already handles.
3. **Switch** (commit). The new copies become primary and the old ones *draining*: still read if the
   new copy fails, never written. New uploads go only to the target.
4. **Remove old copies** (drain), or set `STORAGE_DRAIN_AFTER_HOURS`. Deletes draining copies
   ScreenTinker wrote, only where another ready copy exists, and only after the refcount says
   nothing else needs them. Reference imports are never drained.

**Stop** (abort) at any point puts the old copies back as primary, restores the previous choice
of the organization or workspace, and keeps everything already copied: abort is not a delete.

`GET /api/content/:id/locations` (org admin) lists every copy of an item, its state, and which one
a read would use right now.

Storage quota is still ScreenTinker's own number (`file_size` on each item). A file that has a copy
in two places during a migration is counted once.

## Limits of this version

- Revision copies of files that were on local disk stay in `.history/` on local disk after a
  migration (still restorable); copies retained while a file was in a bucket move with the
  migration.
- Readers that need a file rather than a stream — the HTML-bundle inliner, backup export, mesh
  content pulls, the e-paper renderer's local-image path — fetch an item held only in a bucket into
  `UPLOADS_DIR/storage-cache` (capped by `STORAGE_CACHE_MAX_MB`, oldest evicted first) and read that.
- Mesh receive and backup import still write to local disk first and then move the file to the
  workspace's storage; if that move fails the item stays on local disk, where it already plays.
- A receiving mesh node checks "do I already have these bytes?" against local disk, so an item
  held only in a bucket may be transferred again on a re-push (it lands on the same row).
- Presigned uploads (browser straight to bucket) are not implemented; uploads always pass through
  the server, which is where they are type-checked.
