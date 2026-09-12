# Changelog

## Unreleased

### Added

**Live video (WebRTC).** An optional path that shows sub-second video of what a screen is actually
playing, alongside the existing screenshot stream. With a [go2rtc](https://github.com/AlexxIT/go2rtc)
sidecar and a publishing player, one screen can be watched by many dashboards without asking the
device to encode a separate stream per viewer; ScreenTinker is only ever the signaling proxy and
never becomes an SFU. Off by default at every level (server master gate `LIVE_VIDEO_ENABLED`, per
workspace, per device), so enabling the sidecar never silently starts streaming. The Android
publisher was rewritten onto a WebSocket + trickle-ICE path (native libwebrtc drops the inline
HTTP-answer candidates that browsers tolerate), and its foreground service was hardened against the
ANR and native crashes that came from disposing a `PeerConnection` from its own callback. The
dashboard plays WebRTC first, then falls back to MSE/HLS, then to the screenshot stream. Documented
in `docs/live-video.md`.

**A VP8/VP9-capable go2rtc image.** Stock go2rtc registers only H264/H265 for WebRTC ingest, so a
publisher with no H264 encoder gets its video rejected and no frames flow. This is invisible for
browsers and real phones (all offer H264) but bites the Android emulator, whose only H264 codec is a
software encoder libwebrtc excludes. `docker/go2rtc-vp8/` builds an image that adds VP8/VP9 to the
receive set with a one-function patch, for emulator testing and unusual hardware. Real hardware does
not need it.

**Talk: voice intercom and PA broadcast.** Operators can now talk to screens over the same go2rtc
path, in Opus. Per device, Talk is one-way by default (operator mic to the screen's speaker, so it
works on a mic-less display) with a separate 2-way button that appears only when the device declares
a microphone. Per group and per workspace, a one-way PA broadcast fans a single operator stream out
to every device in scope, listen-only, so a whole group's mics never mix into noise. The operator
can optionally share a webcam, shown fullscreen over the content on the screen; content audio and
video duck while talk is active and restore on stop, and hardware echo-cancellation on the device
stops the operator hearing themselves. Talk is fail-soft: any failure just leaves no audio and never
touches playback or live video.

**Talk is gated per organization, with a per-org TURN/STUN.** Talk is off by default and enabled per
org: a global `TALK_ENABLED` master switch plus each organization's own `talk_enabled` flag, both
required. A platform admin sets it under Admin → Organizations, where an organization can also
provide its **own ICE (STUN/TURN) servers** — a JSON override that applies to that org's live video
and talk alike, falling back to the sidecar's `GO2RTC_*` servers when unset. `lib/org-webrtc.js`
resolves both from a device or workspace up to its org, and every talk endpoint enforces the flag
server-side.

**Trial expiry actually happens.** The 14-day Pro trial used to end only when the user next opened
Billing, paired a screen, uploaded content, or a screen reconnected; anyone who went quiet stayed on
Pro indefinitely (283 of 421 hosted accounts on 2026-09-12). A nightly sweep (`services/trialExpiry.js`,
14:00 UTC) now moves every lapsed trial to Free through the same `expireTrial()` the lazy path uses,
and pushes each affected screen its access-gated playlist so an extra screen that is connected stops
at once. Two emails go with it, once per user: "your Pro trial ends in N days" at three days out, and
"your Pro trial has ended" after the downgrade, each naming which screens stop and what it costs to
keep them. Off entirely under `SELF_HOSTED=true`; emails also need `HOSTED_INSTANCE=true`. The
expiry email only reaches trials that lapsed within `TRIAL_EXPIRED_EMAIL_MAX_AGE_DAYS` (default 30),
so the first sweep on a deep backlog downgrades silently rather than mailing months-old signups. New
columns `users.trial_expired_at`, `trial_ending_email_sent_at`, `trial_expired_email_sent_at`; the
Billing page shows "Your Pro trial ended on …" for a downgraded account.

### Fixed

**A dashboard push could re-enable a paywalled screen.** Only the three device-register paths
consulted `checkDeviceAccess`; the ~20 dashboard-side pushes (playlist, content, layout, widget and
group edits, the scheduler, mute-sync, data-source refresh, video walls, releases) and the offline
flush in `lib/command-queue` all sent the raw playlist, so assigning content to a blocked screen
brought it back until its next reconnect. `buildPlaylistPayload` — the only builder exported for
delivery — is now the gated one; the dashboard preview uses `buildPlaylistPayloadUnchecked`.

**Blocked screens said "Device Limit Reached" instead of "Trial Expired".** The trial-expired branch
was keyed on `trial_started`, which the downgrade nulls first, so it could never fire. It now keys on
`trial_expired_at` and tells the owner their trial ended.

## 2.0.8

The first release since 2.0.7, and a large one: two new subsystems, a new player platform, and
every open issue on the tracker.

### Added

**Content approval workflows and version history.** A workspace admin can require approval before
anything goes live. It is off by default for every existing and new workspace, and turning it on
changes nothing that is already playing. Draft, Submitted, Approved, Published, with a Changes
requested path and a reviewer comment. Approval binds to an immutable revision and to the stamps of
everything it depends on, both rechecked at the decision and again at publish, so an edit after
approval invalidates it rather than shipping unreviewed. Nobody can approve their own submission or
one containing changes they authored. A single release policy in `lib/release-policy.js` is
consulted by every path that can change a screen: playlist and deck publish, widget, layout and
content edits, agency auto-publish, and schedule-generated playlists.

Version history is always on, for content, playlists, layouts, slide decks and widgets, with one
revision model. Every revision records who made it, including whether it came from a person, an API
token, an import, a mesh peer or a restore. Revisions can be previewed, compared and restored, and a
restore creates a new draft attributed to the restorer rather than rewriting anything. Replaced
media bytes are retained so an older revision stays viewable, under a bounded retention that never
prunes what is live, pending review or a migration baseline. Widget config secrets are redacted in
every history response. Documented in `docs/approvals-and-history.md`.

**Data sources.** A workspace can register an external source and bind widget and slide fields to
it with `{{ds:name.field}}`. iCal is the first integration, aimed at room booking panels: a sign
knows whether the room is busy, what is on next and when it frees up. Fetches go through the SSRF
guard with pinned DNS, a body cap, redirect limits and a per-workspace concurrency bound. Contributed by @renebohne in #332 and #340.

**LG webOS player.** An installed shell around the web player, so a webOS signage panel is a first
class display alongside Android, Tizen, BrightSign and the browser.

**Embedded renderer: multi-zone layouts.** The e-paper and microcontroller path can now render a
full layout, not just a single item, compositing zones natively with Jimp where every zone is an
image and falling back to a browser render otherwise. Contributed by @renebohne in #331 and #339.

@renebohne authored 22 of the 40 commits in this release.

### Fixed

**Samsung Tizen panels black-screened on 2.0.x (#330).** A content security policy added in 2.0.0
blocked the player's own scripts on Tizen 5.0. The panel installed the app, the shell stayed
responsive, and nothing rendered, with nothing in any log. Proven on hardware by a control build.
The policy is removed rather than corrected: it also omitted the `file:` scheme from `img-src` and
`media-src`, so a corrected script policy would have booted the app and then black-screened it again
on any cached media. The reasoning that justified the policy, and what would have to be measured on
a panel before one is ever added back, is recorded in `tizen/config.xml`.

**Playback froze mid-playlist on some Android TV chipsets (#333).** With group sync on, the player
warms the next clip on a second decoder six seconds before each boundary. Where the chipset allows
only one decoder, that reclaimed the one already playing: the picture held and the playlist never
advanced. The stall watchdog did fire, but reported through the path a video uses when it ends
normally, which a synced group deliberately ignores. A stalled or errored video is now a fault
distinct from a normal finish, a failed warm-up is no longer promoted at the boundary, and a clip
that faults on every attempt is held rather than looped.

**Screen background colour never reached the player (#336).** The query that builds the device
payload lists its columns explicitly and the colour added in 2.0.7 was never added to the list, so
every push carried no colour and players kept their default black. Two places that painted their own
black over it, the letterbox around a fullscreen video and the frame around a widget, are fixed with
it.

**Android displays reinstalled the same build forever (#341).** The OTA check advertised the
server's own version rather than the version of the APK it would serve. A server whose mounted APK
is older offers an update, Android accepts the download as a same-version reinstall, and the display
returns on the old version to be offered again. Two field displays did this 493 times over five
days with nothing failing anywhere. The server now reads `versionName` out of the APK itself, so it
cannot advertise a version it does not hold, and the update-check breaker gained a progress axis:
the same target offered repeatedly to a display that never moves stops being offered. This is the
skip-after-N that #144 identified and left out.

**The SSSP manifest reported the .wgt size in bytes (#329).** Samsung expects kilobytes, and the
mismatch failed the install with a message that named neither.

**Raspberry Pi kiosk installs ran two launchers.** Each supervised the other's browser, so a
restart left an orphaned renderer holding the display. One launcher per install now, supervising
itself.

### Also

Slide decks, playlists, layouts and widgets all record history whether or not approval is enabled.
The embedded renderer reads the published snapshot rather than live playlist rows, so an e-paper
panel no longer shows a draft. `pinnedLookup` handles `options.all` for modern Node request paths.

## 2.0.7

### Fixed — 2.0.6 broke the dashboard for everyone

`frontend/js/views/schedule.js` shipped with its new recurrence block inserted INSIDE an
unterminated `import {`, so the file was a syntax error. `app.js` imports that module statically,
which means the failure was never confined to the Schedule view: the whole dashboard module graph
stopped evaluating, and every page rendered blank and reported "Disconnected". The player and the
API were unaffected — screens carried on showing their playlists throughout — but nobody could
open the dashboard to see that.

The fix is a reordering; not a line of the recurrence logic changed.

Nothing in this repo had ever parsed browser code. The server has its own tests and CI lints
`docs/openapi.yaml`, but `frontend/` was only ever read by a browser, so a file that could not be
parsed at all passed every gate we had. `test/frontend-parses.test.js` now parses every `.js` under
`frontend/` and `tizen/` — accepting module or classic-script syntax, since the tree holds both —
and asserts the static-import property that made this fatal rather than local.

### Fixed — the dashboard no longer probes for a mesh it was told it does not have (#329)

The mesh routers mount conditionally, and the client discovered whether they existed by calling them
and reading the 404: `/mesh/capabilities` then `/mesh/nodes` on every sidebar render, `/mesh/orgs`
on every `/me` refresh, and `/mesh/alerts` and `/mesh/uptime` whenever those views opened. On an
install with no mesh — very nearly all of them — that is a steady trickle of 404s in the console for
a question the server settled at boot.

`/api/auth/me` now carries `mesh: { enroll, hub }`, recorded where the mount decision is actually
made, mirroring the existing `hide_billing` flag. The two are separate because the routes are: the
Servers nav turns on `enroll` (either half of a mesh), while the aggregate reads live in the hub
router and turn on `hub`.

An absent flag means UNKNOWN, not off. A server older than this field, or a user cached before it,
falls through to the original probe-and-catch path, so an older install still lights up its Servers
section correctly rather than silently hiding it.

## 2.0.6

### Added — e-paper and microcontroller displays

`/api/embedded/render` pre-renders whatever a screen should be showing into a device-native image, so
a panel with no browser and no Android on it can still be a ScreenTinker display. Server-side resize
and Floyd-Steinberg or Atkinson dithering, output as a packed 1-bit bitstream (48 KB for an 800x480
e-paper), BMP, JPEG or PNG. Contributed by @renebohne in #322 and tested against a Seeed Studio
reTerminal Sticky.

The interesting part for a battery device is what it does NOT send. An ETag on every render means a
panel that wakes, asks, and finds nothing has changed gets a 304 with no body and goes straight back
to sleep, and `X-ST-Expires-In` tells it how long that sleep can be. A playlist cursor comes back in
the same headers, so the device needs no state of its own beyond a token.

Pairing is by six-digit code, generated by the SERVER with a CSPRNG. The device asks for a code and
displays what it is given rather than choosing one, which is what stops somebody registering codes
and waiting for an operator to type one they already own. `pair/status` hands back the device token
only to the caller holding the `claim_secret` issued at registration, and both routes sit behind the
existing pairing lockout.

The renderer needs `puppeteer-core` and a browser ONLY for widgets and slides; images render natively
through Jimp with neither installed. Nothing is a hard dependency: with no browser present the server
boots and the image path works, and a widget render answers `BROWSER_NOT_FOUND` rather than failing.
It is off by default in the shipped image, which carries no browser.

### Added — upload your own transition shader (#320)

`shared/Transitions/` is deliberately a first-party set: every shipped shader written from scratch
and stamped MIT, so `docs/licensing.md` can make a flat claim with no per-effect conditions. An
operator's own shader is their content and their licence, so it is stored per workspace and never
enters the shipped library, the manifest, or a release.

Delivery turned out to be much smaller than expected, and the reason is worth recording: every player
already resolves a shader as an id to a GLSL string. The web player and Tizen read the same
`window.__TRANSITION_SHADERS` global, and Android has one reader with one caller. So the sources
travel WITH the playlist, keyed by ids the items already reference, and each player merges them into
the lookup it has. No new endpoint, no download, no cache to invalidate, and Tizen needs no `.wgt`
rebuild or re-signing. Only shaders a playlist actually references are sent.

Validation is structural rather than a compile, deliberately. The only honest way to know GLSL is
valid is to link it against a real GL context, and putting that on the upload path makes a browser a
server dependency, the exact thing #322 spends its effort making optional. So: the renderer's entry
point must be present, no preprocessor directives, 64 KB, at most eight parameters. A shader that
passes those and is still broken fails the way an unknown one already does, which is a hard cut.

An upload cannot shadow a built-in: ids are prefixed `custom-`, the resolver consults the shipped
manifest first, and the Android side refuses to hold an id without that prefix. The cap is per
ORGANISATION, not per workspace, because workspaces are cheap to create and a per-workspace limit is
therefore not a limit.

### Added — a plain Crossfade, and it is the default for a new transition widget

The transition library shipped fourteen effects and every one was a set piece: CRT Collapse,
Datamosh, Film Advance, Van Eck. There was no plain dissolve, so a playlist that just wanted slides
to melt into each other had to choose between a hard cut and a glitch. Contributed by @rolbk in #315.

The argument for taking it, which was theirs and was right: a dissolve is not a fifteenth effect, it
is the default transition in every signage product and the one most operators will ever use. "Upload
your own shader" is the answer for genuinely custom effects, not for the one everybody expects out of
the box. Nobody should have to write GLSL to get a fade between two slides. `Crossfade` therefore
sorts first in the manifest and is what a new transition widget previews, and the file sort is
case-insensitive so that ordering cannot drift back on a later filename.

Two parameters, both 0..1: `ease` (default 1) applies a smoothstep to the linear `progress` every
player drives, so the dissolve is slow-in and slow-out; `dipToBlack` (default 0) blends toward a
fade through black. At progress 0 the output is exactly the outgoing frame and at 1 exactly the
incoming one, so the mounted element underneath matches the last wipe frame with no seam.

No new build step: a `.glsl` flows through the generators that already exist, and the checked-in
`manifest.json` and `tizen/js/transitions.js` were regenerated with it.


### Added — the Android player runs on Android 6.0 (#328)

`minSdk` drops from 24 to 23, so the APK installs on Android 6.0 boxes and older tablets that could
otherwise only run the web player in a browser, and Firefox 143 was the last browser release for
that OS. Contributed by @rolbk.

Three API-24 call sites are guarded rather than dropped: EXIF orientation for remote images reads
through a temp file below N, remote tap and swipe fall back to in-app view dispatch where gesture
dispatch is unavailable, and the network callback registers for any network instead of the default
one. At `minSdk` 23 the Gradle plugin emits the v1 signature itself, which Android 6 needs to install
at all; `resignReleaseV1` stays as a backstop, and a signed build was checked to still carry v1, v2
and v3 so MDM-managed signage keeps the JAR signature it depends on.

### Added — specific days of the week on a schedule (#327)

The scheduler has always understood `BYDAY`, evaluated against the DEVICE's local day of week, and
`recurrence_end` has always been stored and honoured by both the scheduler and the calendar. Neither
was reachable: the form offered four fixed presets, so weekdays and weekends were expressible and
"Mon, Wed, Fri" was not, and a repeat could never be given an end date. Both are on the form now, and
editing a schedule whose days are not a preset shows the days it actually uses.

### Added — a background colour per screen (#325)

The letterbox behind content that does not fill the frame was `#000` in the player's stylesheet, so a
white-background image sat in a black surround and looked like a fault. It is a per-device setting
now, following the route `orientation` already takes. Unset means the player's own default, so every
existing screen keeps exactly the black it has, and the reset control clears back to unset rather
than pinning the screen to black. Hex only, validated at the API and again in the player, because the
value reaches an inline style.

### Fixed — a clock widget could not hide its seconds, and was always English (#323)

`second:'2-digit'` was unconditional, so a clock widget could only ever be HH:MM:SS, while the
Designer's clock element has had a seconds checkbox all along. There is a setting now, defaulting to
on so existing widgets are unchanged. The clock was also formatted with a hardcoded `en-US`, so a
Spanish operator got English weekday and month names on a screen whose dashboard, timezone and
audience were all Spanish. A blank locale now means the screen's own locale rather than English,
which is what the Slides clock has always done.


### Fixed — the weather widget ignored its own size setting (#324)

Only the temperature scaled with `font_size`; the location, description and icon were pinned at 18px,
16px and 64px. In a small zone the icon alone is 64px whatever the space, so the content overflowed
and the widget grew a scrollbar, reported precisely as "the font size does change, but nothing
else". No Fit setting could help, because Fit places the widget's output rather than laying it out.
All four sizes derive from one base now and the widget clips rather than scrolls. A side-by-side
layout and an optional city line come with it, and the condition text can arrive in the operator's
language instead of always English.

### Fixed — Android portrait wipes were fitted to the unrotated display (#326)

The Android half of the fault fixed in the web player for 2.0.5. MainActivity transposes the stage's
layout params before rotating it, and a View's rotation does not change its layout bounds, so on a
1920x1080 panel set to portrait the stage is laid out 1080x1920 while `displayMetrics` still reports
1920x1080. Every wipe was fitted to the latter. `transitionView` is `MATCH_PARENT` inside that same
rotated root, so its own measured size is the stage box, which is what the wipe uses now.

⚠️ NOT VERIFIED ON HARDWARE. The unit tests do not exercise `runWipe` and no portrait Android panel
was available. The signature to look for is the picture visibly changing shape for the length of the
transition, on every effect rather than one.

### Changed — CI installs the way production does

The smoke job booted the server and checked its version, but installed with `npm ci` and let
`DATA_DIR` default. Both quietly made it unable to see the two failures it most needed to catch. A
devDependency required at load time booted fine here and crashed for every self-hoster, which is
exactly what #322 arrived doing. And `DATA_DIR` defaults to `server/`, which is also where a module
inventing its own uploads path would guess, so a wrong guess and the right answer were the same
directory, which is why an uploads-path bug in #322 was invisible until it was reproduced by hand.

It now installs `--omit=dev` as `upgrade.sh` and the Dockerfile do, boots with `DATA_DIR` outside the
checkout as the image does, and asserts three things this project has been bitten by: release notes
present and matching VERSION, every router answering 401 rather than 404, and the database landing
under `DATA_DIR` with no stray `.db` files in the checkout.

### Changed — llms.txt

There was no `llms.txt`, and the SPA catch-all answered 200 with the dashboard shell for it, so an
audit read a missing file as a malformed one. Added with an H1, a summary and linked sections, every
internal link checked against a file on disk.

### Changed — the Tizen bundle byte-identity guard is gone

It arrived with #315 and it was a fair catch: the `#BS-UMD` guard reads the checked-in
`tizen/js/transitions.js`, so a copy that has drifted from the bundler is one that guard is silently
not guarding, and it had drifted. Requiring a regeneration commit after every shader change is the
wrong fix. The cleaner answer is to stop committing that file at all, since `build-wgt.sh`
regenerates it on every build, and point the existing guard at `bundle()` instead.

### Upgrading

One new column (`devices.background_color`) and one new table (`custom_shaders`), both added by the
usual migration on first boot. Nothing to run by hand and nothing to undo: an instance that never
sets a background colour or uploads a shader behaves exactly as it did before.

**The Android APK changes for every screen.** `minSdk` drops to 23, so `versionCode` moves and every
Android display takes the update at its next check. The player also gains the portrait wipe fix,
which is the one change in this release that has not been confirmed on hardware. Worth watching a
portrait Android screen through a transition before rolling the APK widely.

**The embedded renderer is off unless you turn it on.** It needs `puppeteer-core` and a browser for
widget and slide rendering, and the shipped image carries neither. Image rendering works without
them. If you want the full path: `npm i puppeteer-core` in `server/` and set `CHROME_PATH`.

**Custom transitions are capped per organisation**, not per workspace, and the cap is a flat 50 rather
than plan-derived. If you want it to follow the plan, `organizations.plan_id` is the hook.


## 2.0.5

### Fixed — every wipe on a portrait panel was drawn in landscape

A portrait screen rotates `#playerContainer` with a CSS transform, and a transform does not move the
layout box: `clientWidth`/`clientHeight` are the box the image is fitted into, while
`getBoundingClientRect()` is the rotated envelope. On a portrait panel those are each other's
transposes. The GL wipe fitted both frames into the envelope and painted them on a fixed, unrotated
overlay, so the picture jumped to 1.8x at the start of every transition and back at the end, on all
fourteen effects. Measured across the boundary with grid slides: 5 dB PSNR, where a 4 px shift
scores 19 dB. The wipe now takes the stage's own box and its computed placement, which is the
landscape case unchanged and the portrait case turned exactly as the stage is. A stage with no box
hard-cuts instead of running a 2x2 wipe fabricated from a 0x0 rect. Reported and fixed by
@rolbk in #315; the accompanying report notes Android's `MediaPlayerManager.runWipe` has the same
fault, which is not fixed here.

### Fixed — a clock widget's timezone was checked for its spelling, not its existence (#316)

`safeTimezone` tested the value against a character class, which answers neither question a timezone
field has. A Spanish operator hit both halves in one sitting: `España` failed the character class and
was silently replaced with UTC, so the clock ran two hours behind with nothing saying why, while
`Spain` and `GMT+2` passed it, are not zones, and made `toLocaleTimeString` throw inside the
generated widget script — so the clock rendered nothing at all. Intl decides now, at save time, on
both create and update, with a message naming the right format. The render-time fallback stays for
configs already stored, since a wrong clock beats a blank one, but nothing new can reach it. The
dashboard field is backed by the browser's own zone list.

### Fixed — the layout editor dragged a square it had just destroyed (#316)

The zone mousedown handler sets the selection and calls `renderZones()`, which removes every
`.zone-el` and builds them again. From that point the element the handler closed over is detached, so
dragging updated `z.x_percent` but painted onto an orphan: nothing moved under the pointer and the
zone jumped to its new position at the next render, which is to say the next time the operator
clicked. Reported identically in Chrome and Firefox, which is what a DOM bug looks like rather than
an input one.

### Fixed — uploads were capped at 20 files, and the refusal said nothing (#317)

Somebody uploading 160 photos from a company party got an error with no number in it and worked out
by trial that sixteen at a time went through. Two faults: the per-request cap was 20, and no
`MulterError` was ever handled, so exceeding it surfaced as a bare unhandled error. An oversized
single file had the same missing handler. The cap is higher and stated when hit, and the dashboard
now chunks a large selection, reports progress across the whole selection rather than 0-100% per
batch, and on a mid-way failure says how many files already landed.

### Fixed — a signup was never recorded as a login

`last_login` had one writer, called from the two interactive login finishers. `POST /api/auth/register`
issues a session immediately and was never stamped, so anyone who signed up and kept using that
session read as "never logged in" for as long as the account existed. On the hosted instance that was
132 of 349 accounts, 43 of them with real authenticated activity. The column feeds admin views and
was about to be used to select accounts for deletion, so this was one query away from removing live
customers. `scripts/backfill-last-login.js` repairs existing rows from each user's most recent
activity, and deliberately leaves users with no activity NULL: `activity_log` is not retained for the
life of an instance, so for older accounts there is no evidence either way.

### Fixed — the update check could only see the first 100 container tags

GHCR returns 100 tags and a `Link: rel="next"` header, and the check read page one and stopped. Page
one is in push order, so it ended wherever the project was 100 tags ago, and the highest semver tag
visible was 1.9.40 — permanently, drifting further behind with every release. Every self-hosted
instance was therefore told 1.9.40 was current: nobody on 1.9.x was ever offered 2.x, and instances
already on 2.x were told they were ahead of the latest release. Nothing errored, which is why it went
unnoticed. The walk now follows the next link, bounded at 20 pages, and a later page failing still
uses the tags already gathered.

### Added — many playlist items at once, and a whole-playlist sort (#318, #319)

`POST /playlists/:id/items/bulk` takes a list of content ids and inserts them in one transaction.
Content only: widgets and child playlists are singular things placed deliberately, and the nesting
rules on the single-item route exist to be reasoned about one at a time. Partial success is the
design — refusing 160 photos because one expired last week is an obstacle, but silently dropping it
is worse, since the published snapshot filters expired content and the operator would publish a
shorter playlist with nothing saying so. Valid rows go in, refused ones come back itemised.

Sorting is computed in the dashboard and sent to the existing reorder route, so the server learns
nothing about sort modes and the result is ordinary `sort_order` values: the operator can still drag
afterwards. Widgets and nested playlists have no filename or duration of their own, so they keep
their relative order and settle after the content. The picker sorts and multi-selects too, and adds
in the order shown rather than the order ticked.

### Changed — the site had no page for someone searching "hosted"

Titles and meta descriptions across `guides/`, `compare/` and `integrations/` ran 61-79 and 159-247
characters and truncated in results; sixteen titles and eighteen descriptions are now inside 60 and
155, with `og:*` and `twitter:*` updated alongside. `cloud-digital-signage.html` is new: the site
ranked for hosted queries and converted none of them, because every snippet said self-hosted, free
and open source, and the page that answered those searchers did not exist. It states outright that
the software is identical, MIT licensed, and that self-hosting is free and stays free, and carries a
real "should you self-host instead?" section.

The Samsung guide gets a content fix rather than a metadata one: it sells the URL Launcher path,
which is exactly the path that fails on older sets, so it was recruiting the people who then arrive
in support with a Connect button that does nothing. A "Which Samsung TVs work" section now states the
2022-and-newer floor before the setup steps and sends older sets to the Android TV or Raspberry Pi
guides.

### Upgrading

No schema changes and no configuration changes. The portrait wipe fix is in the web player, which
the server serves, so upgrading the server delivers it — no APK or `.wgt` rebuild is required for it.
`scripts/backfill-last-login.js` is optional and dry-run by default; run it with `--apply` if you
report on `last_login`.

## 2.0.4

Five things, and three of them are the same shape: a server refusing a player and the player never
coming back. Two were introduced by 2.0.1 and found by deploying it and looking at what it did.

### Fixed — a screen could sit on "Waiting for content" with everything it needed already cached (#314)

Reported from a fleet: after an OTA the panel sat on the waiting screen indefinitely, with all media
cached and a playlist assigned, and toggling the playlist assignment in the dashboard fixed it
instantly. That workaround is the tell. It is a server-initiated push, the one route into a player
that does not go through register.

**The backoff window slid forward for ever.** Every retry INSIDE the window recomputed its own end
from the moment of the retry, so a player reconnecting on its own timer pushed its release further
away and never got back in. Measured on a running server: still refused after 70 seconds of complete
silence, having been told to retry after 60. Because a throttled register returns before the playlist
is sent, "never got back in" is a dark screen. Retries inside the window now report the time
remaining and nothing more; a device that genuinely storms is still caught, and still escalates, on
the rate path the moment the window expires.

**And nobody was listening.** Three separate gates refuse a register and all three announce it with
`device:throttled`, which no player implemented: not Android, not the web player, not Tizen, not
BrightSign. The server asked for a pause and the client came straight back on its one-second timer,
re-tripping the window it was waiting out. The web player (and so BrightSign) and Android now honour
the server's number, clamped at both ends so a missing value cannot strand a screen and a zero cannot
turn the reconnect into a busy loop.

**Android could also read a full cache as an empty one.** Readiness asked whether the cached copy
carried the revision the playlist asked for, and an asset cached by a build from before content
revisions existed has no revision to compare, so it could never answer yes. A panel whose disk was
full of playable media therefore waited for content it already had. Playback now prefers confirmed
content exactly as before and falls back to "we have bytes for this" only when nothing anywhere
passes that bar, so a replaced asset still reaches the screen the moment it lands.

### Fixed — a deferred boot stranded every web and Tizen player it refused

2.0.1 added a hold that keeps players off a server while it drains stranded plays. It refused them in
Socket.IO namespace middleware, and a v4 client treats that as a denial rather than a fault: it stops
reconnecting, fires no disconnect event, and ignores its own retry settings. The web player arms its
reconnect supervisor from the disconnect handler and Tizen's watchdog waits on a connected socket, so
both sat on "Connection failed: maintenance" until somebody power-cycled the panel. Android survived
on an unrelated backstop.

Which made the feature worse than the stampede it prevents, on exactly the kind of install it was
written for. The unit test could not see it because it connected with reconnection disabled, and the
assertion it did make required the broken behaviour.

The socket is now accepted and then refused, using the same `device:throttled` the other refusal
gates use, carrying how long to wait. A client that honours it waits and returns; a client that
ignores it still gets an ordinary disconnect, which every player already supervises. Verified with 70
simulated panels against a boot carrying 400,001 stranded plays: 67 were refused, and all 70
recovered on their own.

### Fixed — the most expensive thing the server did, it did on every play

`closeStrandedPlays` repairs rows left open when a play's end was lost. It ran on every `play_start`.
It is a correlated self-join of the play log against itself plus a join to content, grouped per row,
across the device's whole history: measured against a copy of a real fleet database (3.1 million
rows, 2.7 million on the busiest device) at **362ms, and 355ms when there was nothing to close**. The
full price is paid whether or not it finds anything.

At roughly one play per second across a 78-panel site that is a ~150ms synchronous block about once a
second, permanently. A 60-second CPU profile from the affected server put **27.1% of all wall time**
inside this one call, which is the entire explanation for a loop whose median sat at the measurement
floor while its 99th percentile sat at 130-165ms. It is also why moving that customer to faster
storage fixed their baseline and left the spikes untouched: the cost is CPU, not disk.

A lost play end comes from a session ending abruptly, so the evidence for one is the FIRST play of a
NEW connection. Inside a live session every end arrives normally and there is nothing to repair. The
sweep is now armed per connection and disarmed once it runs. The repair itself is unchanged, including
the same-zone rule and the per-row ceiling that stops a 20-second clip being credited with hours.

### Fixed — an enrolment key could be minted by a token that should not have one

2.0.3 stopped an API token READING a display's enrolment key, because that key lets its holder be that
screen. The routes that MINT and REVOKE one were left on the default gate, where anything that is not
a read needs only write scope, which handed the same power back through another door. Both now require
full scope, the same as the trigger secret.

Separately, the notification sent when a display is created was broadcasting the raw device row to
every member of the workspace with only the device token removed, so the settings PIN, the trigger
secret and the enrolment key went to everyone regardless of role. It now goes through the same
sanitiser the device list uses.

### Added — server diagnostics in platform admin

Diagnosing a slow install meant sending a customer a shell script and talking them through running it
as root on their production server. Everything it collected was already being recorded: the event loop
writes its own timings every second, and one affected server held 205,866 rows of exactly the history
we had spent an afternoon reconstructing by hand.

Platform admin now has three read-outs: the instance shape (table sizes, payload sizes, play-log depth
and its indexes), the loop-lag history including a daily trend, and an on-demand CPU profile. The
daily trend is the one that matters, because a step change on a date turns "why is this server slow"
into "what happened on the 14th".

⚠️ The profile runs in-process, so no debug port is ever opened. The alternative was the recipe we
were about to hand a customer: signal the process to open the V8 inspector, attach, capture, and hope
somebody remembers to close it. Same data, nothing listening, nothing left behind. One at a time,
bounded, and audited. It returns counts, timings and function names; no playlist content, no media,
no credentials.

### Fixed — the landing page had not caught up with 2.0

BrightSign was missing from a page that lists supported platforms, despite running the same player as
every browser and being able to host the server itself. The "Content Designer" card advertised the
feature that is deprecating rather than Slides, which replaced it, and there was nothing about
triggers or workspaces.

### Upgrading

Nothing to do. No schema change, no configuration change. Players pick up the throttle handling when
they next update; the server-side fixes apply to every player already in the field, including ones
that will never be updated.

## 2.0.3

### Fixed — an API token could read a display's enrolment key

The enrolment key added in 2.0.1 was withheld from the device list, which is the rule that governs
`settings_pin`: one consumer, so do not hand it to every member on every dashboard load. It was not
withheld from an API token, and that is the rule that governs `trigger_secret` — `GET
/api/devices/:id` has no scope gate, so a READ-scoped integration token could read the key off the
detail response.

The key is the stronger of the two credentials. The trigger secret lets its holder push content to a
screen; the enrolment key lets its holder BE the screen — register as that display, take its
playlist and its commands, and report as it. So it now sits behind the same gate, and the helper is
named for the category rather than for one member of it.

Scope, honestly: enrolment keys are opt-in and only exist on displays somebody deliberately made a
web player for, and an API token is already a workspace credential. This narrows an exposure inside
an authenticated surface; it is not a path from the outside.

A dashboard session still reads the key, because the operator has to be able to copy the player URL.

## 2.0.2

### Fixed — the "what's new" panel was empty in every container

2.0.1 added the panel that tells you what changed after an upgrade, and did not ship the file it
reads. `release-notes.json` lives at the repo root; the Dockerfile copies the root files it needs one
by one and this one was never added, so `/api/release-notes` answered with nothing on every
containerised install. Everything passed on the way out — the unit tests read the file out of the
source tree, where it was present the whole time. Found by deploying it and looking, which is the
expensive way to find it.

The Dockerfile now copies it, and a test reads every repo-root path the server code resolves at
runtime and asserts the image ships each one, so the next root file is caught the day somebody adds
the read rather than on a deploy.

Nothing else changed. If your 2.0.1 install is otherwise behaving, this only affects that panel.

## 2.0.1

Two things the field found in 2.0.0. Neither is a new feature; both are places where the product
made someone do work it should have done itself.

### Added — slides can talk, and a deck can have music under it

A slide can carry a **voiceover**, and a deck can carry one **background music** track that plays
continuously underneath the whole thing. **Audio files can now be uploaded** — mp3, m4a, wav, ogg
and flac — which the content library previously refused outright.

The interesting part is where the audio lives, because the obvious answer is wrong twice. A slide is
a widget in an iframe, and a deck publishes as one widget per slide plus a playlist — so a looping
track inside a slide would restart on every advance, which is the one thing a bed must not do. Audio
in there would also be invisible to the rule that decides which zone owns the sound, and to the
per-item mute, the wall-follower rule and the browser's autoplay gesture — the same reason a slide's
background video has always been unconditionally silent.

So neither track is rendered into the slide. The player owns both elements: the voiceover for as
long as its item is up, the bed across items that name the same track. Publish stamps one track id
across every slide in the deck, and the player leaves a playing bed alone when the id has not
changed — compared by id rather than URL, because replacing an audio file keeps the id and changes
the path. The bed is stored once, on the deck, so two slides can never disagree about it.

Both tracks play on **every player**, not just a browser tab: the web player, Tizen, BrightSign and
Android each own the two elements themselves, with the same rule in all four — the bed is keyed on
its track id and a matching id is left completely alone, never re-prepared and never restarted. On
Android that is two ExoPlayer instances of its own, deliberately not the one that owns the video
surface, whose lifetime ends with every item. A panel that has not updated declares no support and
the dashboard stops offering a deck with a voiceover to a screen that cannot say it.

A voiceover longer than its slide's dwell is now flagged in the editor, exactly like motion that
outlives its dwell has been since decks shipped — the slide changes mid-sentence otherwise.

Screens stay silent by default. Audio still goes through the same mute decision as everything else,
which on a signage panel with no user gesture means muted.

### Added — a web player that survives a host with no storage (#313)

Reported by someone driving vMix signage from a browser input. A vMix browser input deletes its
entire browser profile when vMix closes — vMix's own staff say so on their forum — so localStorage,
cookies and IndexedDB all go together and the player comes back knowing nothing. A player with no
identity pairs as a NEW display, so every restart of the production PC left another dead screen in
the dashboard.

Add Display now has a checkbox — *"This player can't stay paired"* — which creates the display
from the dashboard and hands back a **web player URL**: `…/player?k=…`. There is no code to type,
because there is no player yet to show one. The key in that URL identifies the screen, so a player
with nothing else comes back as the display it was rather than as a stranger, and the URL is always
available afterwards on that display's **Web player** tab.

**Nothing gets one of these unless it is asked for.** Ordinary pairing does not mint a key, the
register path never creates one, and the tab only appears on a display that actually has one — so
every display added the usual way is exactly as it was.

- **It is a separate credential, not the device token.** The token authenticates every message and
  cannot be changed without re-pairing the screen. This does one thing — names a display and proves
  you may be it — and an operator can roll it from the display's page and paste a new URL without
  touching the screen. Same reach while it is secret; a completely different recovery when it is not.
- **It is an exchange at the door.** The key is turned into the display's id and token in the first
  lines of the register handler, so the blocked gate, the flap limiter, the token check and the
  reconnect path all run exactly as they always did. A parallel authentication path would have been
  a parallel set of bugs.
- **A key that resolves to nothing is refused, never fallen through.** Dropping to the pairing path
  would provision a new row — and a storage-less player would do that on every restart, which is
  the failure being fixed.
- Offered only on web players, never handed out in a device list response, and counted against the
  same per-IP lockout that guards pairing codes.

Onboarding is unchanged: pair the screen the way you always did, then take its URL from the display
page and paste that into vMix.

### Fixed — a slide was a different composition on every screen shape

A slide is laid out in percentages and in units relative to the stage, so **the stage's aspect is
the composition**. The renderer handed the stage whatever box the panel had, which meant a deck
designed at 16:9 became a different slide on anything else: a background set to cover was cropped
about a fifth off each side, headlines ran past the edges, and the eyebrow could sit off-screen
entirely. Found on a 2560x1800 Android panel, where the whole slide was one background image and a
fifth of it was simply missing.

The stage is now fitted to the shape the deck was authored in and centred, with the surrounding
frame painted black — so the slide is the same composition on a 16:9 panel, an ultrawide, a portrait
screen or inside a zone. The deck's shape is stamped onto every published slide at publish time,
the same way the music bed's id is, so nothing downstream has to ask the deck anything. A deck
published before this carries no shape and is treated as 16:9, which is the editor's default and
what those decks were laid out in.

⚠️ **The fitting is done in script, and that is the load-bearing half.** Container query units
shipped in Chrome 105, and a lot of signage hardware still runs an Android WebView from 2021 — where
every type size on a slide was an invalid declaration the engine threw away, so those panels have
never rendered a slide at the authored size. The oversized, clipped text people were seeing there
was the browser's default size being auto-inflated, not a layout bug. The fitter converts those
units to pixels against the fitted stage, reading the number out of the element's style attribute
rather than the CSSOM — on an engine that rejected the declaration the CSSOM has nothing left to
read. Three CSS-only versions of this were tried first and abandoned; the note in
`server/test/slide-render.test.js` records why, so nobody rebuilds one. If the script cannot run,
the stage falls back to the full box and the slide renders exactly as it did before — degraded,
never blank.

### Fixed — a 2.0.0 first boot could be flattened by its own fleet

Reported from a 73-device install on a Synology DS225+ over spinning SATA, upgrading 1.9.39 to
2.0.0. Migrations and the playlist-source backfill were fine. What was not:

- **The `play_logs` index build printed nothing for over five minutes.** It sat in uninterruptible
  disk sleep, which from outside is indistinguishable from a hang — and the natural response to a
  hang is to kill it, which is the one thing that must not happen during a migration. The build now
  logs an estimated row count and a warning before it starts, and its duration afterwards. There is
  deliberately no progress *during* it: `db.exec` is one synchronous call and nothing else in the
  process can run until it returns, so the honest options are a line either side or silence.
- **All 73 players reconnected at once and HTTP was unreachable for about twenty minutes**, even
  though the WebSocket layer was accepting. The #142 shed was working exactly as designed and could
  not help — nothing was misbehaving, there were simply 73 well-behaved players arriving together
  while the stranded-play sweep was still draining. Setting `SCREENTINKER_DEFER_PLAYERS=1` (and, by
  default, the first boot after a migration that touched plays) now refuses players with a 503
  until the sweep reports idle. `/api/status` keeps answering 200 with a `maintenance` block saying
  why — failing a healthcheck mid-maintenance is how a slow boot becomes a restart loop — and the
  dashboard is untouched, so an operator can watch the drain rather than being locked out with the
  fleet. It always lifts: when the sweep drains, or after 30 minutes, whichever comes first.
  This is the reporter's own workaround (stop nginx → let maintenance finish → start nginx) made
  into something nobody has to know.
- **The stranded sweep now logs every batch** — `batch i/n closed=X remaining=Y duration=Z` — and
  raises to warn past two seconds, so slow storage is visible in the same stream as the shed lines.
  On the reported hardware each batch held the loop for one to two seconds and nothing said so.

The batch size was already right; it has not changed.

**The "36,096 stranded plays" figure in the 2.0.0 notes was the investigation set, not the
universe.** That was one database's open rows. This install had **494,000**. Wording corrected in
the entries below.

### Added — onboarding can put a playlist on the screen before you walk away

The wizard ended when a display existed, congratulated you, and left the screen blank; assigning
something was a separate hunt through Playlists that nothing in the wizard mentioned. Raised by a
vendor running Juuno alongside this, and it is a fair hit.

The last step now asks "What should this screen play?" and offers the playlists the workspace
already has. It writes through the same endpoint the Displays picker uses, so the assignment is a
real per-screen override rather than something the inheritance resolver quietly undoes later.
Skipping it behaves exactly as before — the wizard never blocks on it. Nothing new is created and
no new kind of playlist exists.

### Fixed — onboarding said content was playing when the screen was blank

Found while adding the step above, and it is the more serious half. Adding an item to a playlist
marks that playlist a draft, and a player's payload is built from the published snapshot with no
fallback to the live items — so a playlist that has never been published sends the screen an empty
list.

The wizard's upload step created the display's playlist, added the clip, said "Content uploaded and
assigned!", and finished on "Your display is paired and content is playing!" — with nothing on the
screen and nothing anywhere saying a publish was still owed. The Displays page at least shows a
Publish button and a draft marker; onboarding showed neither.

It now publishes what it assigns, so the wizard's claim is true. Choosing an existing playlist on
the last step publishes it too, but ONLY if it has never been published — one that already has a
snapshot may carry draft edits somebody is midway through, and pushing those to every screen using
it is not a setup wizard's decision to make.

### Fixed — the getting-started checklist was a dead end

It lived only on the dashboard, so following one of its own steps lost it: click "Add some
content", land on the Content Library, and the thing that sent you there is gone — no step, no
progress, nothing naming what you were in the middle of.

Worse, its buttons did nothing once you arrived. Only step 1 carried an in-page action; the rest
fell back to setting the location hash, which is a no-op when it is already the page you are on. So
on Playlists, the checklist's "New playlist" button sat there doing nothing while the page's own
New Playlist button opened the dialog.

The checklist now appears on every page its steps link to — including the two it hands you off to
mid-flow: the page for a playlist you just created, and the screen's own page where the last step
sends you — and every step acts in place: "Add content" opens
the file picker, "New playlist" opens the same dialog the page's own button does, and "Assign"
opens the display's page. Where a step means something different from where you are standing, it
says so and does that instead: inside an empty playlist it reads "Add content" and fills that
playlist, and on a screen's own page it reads "Choose playlist", opens the Playlist tab the picker
is hidden behind, and puts the cursor in it. One shared
mount rather than a copy per view, and a test derives the affected pages from the steps themselves,
so adding a step that points somewhere new fails until that page handles it.

Assigning a playlist to a screen no longer counts as finished until that playlist is **published**.
It used to tick on the assignment alone, so "Get your first screen live" reported 4 of 4 while the
display sat dark — and the banner that explains why ("Devices will show nothing until you publish")
was not even rendered: it is built from the device's playlist status at page-render time, and
assigning only repainted the item list. So it appeared on the next full page load, which is also
when a completed checklist disappears, making it look as though the warning only showed up once the
checklist got out of the way. The page now re-renders after an assign, so the warning and the
outstanding step are on screen together. A layout with no playlist stopped counting too — there is
nothing to put in its zones.

And an empty playlist no longer ticks "Put content in a playlist". It used to count the moment one
existed — which is what step 3's own button produces — so the checklist marked itself done and sent
the user on to "Send it to the screen" with nothing in it. That puts a blank playlist on a display,
which is the same failure as the onboarding publish bug reached from a different direction.

### Added — the app says what changed after an upgrade

Until now an upgrade was invisible from inside the product. The admin page could tell you a newer
version existed and offer to install it, the nav grew a badge, Settings showed a number — and
nothing anywhere said what you got.

A "What's new" panel now appears on the dashboard the first time you sign in after the running
version changes, with a few plain-language lines about what is different. It is a panel in the
page, not a dialog in the way, and it is dismissed per version rather than once and forever, so
the next release is announced too. The full list, including older versions, lives under
Settings → About.

The notes are written by hand for each release (`release-notes.json`) rather than generated from
this changelog. This file is for whoever touches the code next; that one is for someone who wants
to know whether anything they do has changed.

### Upgrading

An ordinary upgrade. If this instance runs 50 or more players on spinning storage and is coming
from 1.9, read
[Upgrading 1.9 to 2.0 on slow storage](docs/operations.md#upgrading-19-to-20-on-slow-storage)
first — it applies to the 2.0.0 boot you may not have taken yet.

## 2.0.0

The 2.0 line, gathering everything from `2.0.0-alpha0` through `2.0.0-beta8`. Those entries stay
below and are the detailed history; this is what changed since **1.9.x**.

Upgrading from 1.9.x is a normal upgrade — schema migrations run on first boot, nothing needs doing
by hand, and no existing content, playlist, schedule or device pairing changes meaning. The
"Upgrading" section at the end of this entry lists the three things worth knowing first.

### Added — slides

A real authoring surface for the thing most people were using a text widget for. `config.template`
is a view — geometry, style, motion, a slot name per element — and `config.fields` is a record. They
meet at render time and nowhere else, so editing a headline three months later writes one string
and leaves the layout untouched. Fifteen signage products were surveyed before this was designed and
not one of them makes the changeable text part of the template; the single vendor that does is the
one where editing later genuinely breaks.

- **Elements**: headlines, text, big numbers, photos, rules and panels, plus **clock, date,
  countdown and QR** moved over from the designer. QR codes are drawn server-side, so a code needs
  no network at the panel and no third-party image service.
- **Fonts**, bundled and served with the slide, so a deck renders the same on Android, Tizen,
  BrightSign and a browser instead of falling back to whatever a panel happened to have. Uploads are
  supported and carry a licence note, because this server redistributes the file.
- **Motion** per element, with the editor showing when the last element settles against the slide's
  own dwell — an animation that outlives its slide reads as a broken player, not a mis-timed one.
- **Portrait and other shapes**, so a deck can be authored for the screen it will land on.
- **Picture and video backgrounds**, with a scrim so white text stays readable over both. A video
  background keeps the still as its poster, so a slow or undecodable clip shows the picture rather
  than a black rectangle.
- **Generated slides**, and then **layered** ones: a background plate plus individual objects cut
  out with real transparency, each landing as its own element with its own entrance, and a headline
  painted as artwork rather than typeset. The words behind that artwork stay a field, so they remain
  editable and are read out to anything that cannot see the picture.

The **Designer is marked deprecating** in the navigation. Widgets made with it still play and are
still editable there; new work belongs in Slides.

### Added — triggers

An external system — a Crestron or Extron panel, a PLC, a button — can put a playlist over whatever
a screen is showing. **Resolved on the screen itself**, so an alarm still works with the WAN down,
which is the entire point: a trigger that needs the server is a trigger that fails in the situation
it exists for. Assigning a trigger is what makes a screen download and pin the target playlist's
media, so an unassigned trigger is a row in a database that will never fire.

Fired over HTTP or UDP, in four wire shapes, because an integrator should not have to know which
kind of box is behind the address. Where a player cannot bind a socket, the server can hold the door
open instead — opt-in, and still gated per device.

### Added — node mesh

Servers can federate: a hub can see a customer's screens, transfer content to them, ask them to
reboot or reload, and read diagnostics — each under its own grant, with the **customer deciding**
what they accept and able to see what was done to them. There is a relay tier for topologies that
need one.

⚠️ Deliberately conservative for this release: enrollment and uplinks are **opt-in**, depth is capped
at two tiers, and the mesh is read-only for the things it does not yet carry across a link
(content, schedules, widgets and layouts are not mirrored).

### Added — running the server on the player

A BrightSign can now run ScreenTinker itself: the server as a real Node process, the player in the
widget beside it. Screenshots, audio-plane muting and LAN trigger ingress all work on that shape.
Video backgrounds composite behind slide content there too, which took a hardware session to prove.

### Added — proof of play that survives an outage

Players queue what they played while offline and flush it on reconnect, deduplicated by a
player-minted id so a re-flush cannot double-count. A 20,963-second hole in the record was what
prompted it.

### Added — workspaces, SSO, and the rest

A second workspace per account; per-organisation SSO/OIDC with DNS-verified domains; HTML bundles
(`.wgt` / `.zip`) as a playlist item; bulk selection and group actions; playlist inheritance that
forks instead of overwriting; Japanese localisation, and locales that no longer have to be complete
to ship. Licences are gated in CI and an SBOM is published with every release.

### Added — a receipt when a payment succeeds

On `invoice.payment_succeeded`, so it covers renewals and portal payments rather than only the first
checkout, and exactly once per invoice — Stripe retries webhooks until it gets a 2xx and can
redeliver regardless.

### Fixed — the event loop was really blocked, and the band was lying about it (#307)

Reported from a 70-screen deployment, and it turned out to be three things at once.

**The band was decided by one 20ms bucket per second.** A sampling window holds ~49 records, and the
99th percentile of 49 records is the maximum — measured on a production instance,
`avg(max_ms − p99_ms) = 0.000` in every window across two hours. Release required five *consecutive*
clean seconds, which a working server never strings together, so one instance sat at `elevated` for
sixteen days with its typical delay at the measurement floor. The band now reads the median of the
last 15 windows. Replaying the real series: 88.6% elevated before, 99.9% normal after. Maintenance
is band-gated, so this was also quietly throttling every prune sweep.

**Closing a play searched the device's whole history** — and `LIMIT 1` cannot help when there is a
sort in front of it. One screen with 377,132 play rows made that query cost **153ms on the event
loop every time it advanced an item**. The server now remembers the row it opened and closes it by
primary key, with an indexed fallback for plays it did not open.

**Plays were started and never closed** — 36,096 open rows in the database this was investigated
against, the oldest three months old, and that set was what the query above had to search. (That
figure is one instance's open set, not a ceiling: a 73-device field install upgrading to 2.0.0 had
494,000. See 2.0.1.) A play now expires once it has been open longer than its
content could have run, closed at its ceiling so a dark screen is never credited with playback.

### Fixed — the trigger form was never styled

It used a CSS class that does not exist, so it rendered as a bare stack of labels appended to the
page. Rebuilt as a proper dialog, and unpublished playlists are no longer offered as a target —
the server refuses them, so listing them only meant filling in the form to be told no.

### Upgrading

- **Nothing to do by hand.** Migrations run on first boot. The #307 index is created then, on a
  1.4M-row table, in about 150ms.
- **The mesh is off unless you turn it on.** No server joins anything by default.
- **The Designer still works.** It is marked deprecating, not removed, and existing widgets are
  unaffected.

## 2.0.0-beta8

A production bug from a 70-screen deployment, the trigger form finally looking
like the rest of the product, and a receipt when somebody pays you.

### Fixed — the event loop was really blocked, and the band was lying about it (#307)

Three defects, found by measuring a production server rather than reading the code.

**The band was decided by one 20ms bucket per second.** A sampling window is one second at 20ms
resolution, so the histogram holds ~49 records — and the 99th percentile of 49 records **is the
maximum**. Measured over two hours of production: `avg(max_ms − p99_ms) = 0.000`, exactly, in every
window. So the band tracked the worst single bucket each second, and release required five
*consecutive* clean seconds, which a server doing real work never strings together. One instance sat
at `elevated` for sixteen days with its typical delay pinned at the 20ms measurement floor. The
band now reads the median of the last 15 windows; a lone outlier cannot move a median. Replaying the
real series: 88.6% elevated before, 99.9% normal after. A sustained storm still reads critical, and
a single catastrophic window still escalates immediately.

That also mattered beyond the label: maintenance is band-gated, so while the band was wrongly
elevated, every prune sweep was being skipped most of the time.

**Closing a play searched the device's whole history.** The query ordered every open row for a
device and took the first — and `LIMIT 1` cannot save you when there's a sort in front of it. One
production screen has 377,132 play rows; that query measured **153ms, on the event loop, every time
that panel advanced an item**. Exactly the signature in the telemetry: 100–300ms spikes in pairs,
about ten seconds apart. The server now remembers the row it opened and closes it by primary key,
with the search kept as an indexed fallback for plays it didn't open.

**Plays were started and never closed** — 36,096 open rows in the database this was investigated
against, the oldest from June. A play now expires once it has been open longer than its content
could have run, at its ceiling, so downtime is still never credited as playback. (Read that count
as one instance's backlog, not the size of the problem: a 73-device field install upgrading to
2.0.0 had 494,000 open rows. See 2.0.1.)

Rehearsed against a copy of a real production database: 36,096 open rows → 11, in about three
minutes, with no downtime credited and the sweep costing 0ms in steady state.

### Fixed — the trigger form was never styled

It used `.modal-backdrop`, a class defined nowhere. The app's modal CSS is `.modal-overlay`. So it
got no positioning, no centering, no dimming and no card — it appended a stack of bare labels to the
end of the page. Nothing errored, which is why it survived: it read as an unfinished feature rather
than as a typo.

Rebuilt on the skeleton every other dialog uses, grouped into five sections, with the sources next
to the token they qualify and Enabled beside Save. Escape, the close button and the backdrop all
dismiss it now — Cancel used to be the only way out.

### Changed — unpublished playlists are no longer offered to a trigger

The server refuses a trigger pointing at a playlist with no published snapshot, and it is right to:
such a trigger syncs with no items and renders nothing, forever, silently. But the dropdown listed
every playlist, so the normal way to meet that rule was to fill in the whole form and be told no.
The one already saved on a trigger stays listed even if it has since been unpublished — dropping it
would silently re-point that trigger at whatever happened to be first.

### Added — a receipt email when a payment succeeds

On `invoice.payment_succeeded`, so it covers renewals and portal payments rather than only the
first checkout. Sent **exactly once per invoice**: Stripe retries webhooks until it gets a 2xx and
can redeliver regardless, and nothing in the Stripe route deduped before — the other handlers only
survived it by being idempotent updates. The claim is taken before the send, and the send happens
after the acknowledgement so a hung mail transport cannot hold a webhook open.

Zero-amount invoices (trials, full coupons, proration credits) do not produce a receipt, and neither
does an invoice that cannot be tied to an account.

## 2.0.0-beta7

The slide editor absorbs most of what the designer could do, and gains two things nothing in signage
does: slides generated as separately animated cut-out layers, and video behind the words.

### Added — clock, date, countdown and QR are slide elements

Four kinds moved out of the designer, which is now labelled **Designer (deprecating)** in the nav
rather than removed: widgets made with it still play and are still re-editable there, and pulling
the entry would strand them in the raw HTML editor.

The security argument is the whole reason this could be done at all. The designer implements these
by building a **script per element**, interpolating an element's configuration into JavaScript
source — `setInterval` with a date pasted in, `fetch` with a URL pasted in — so operator input
becomes program text. The slide renderer has spent its life keeping script out of its output.

Here the script is a **constant**: byte-identical in every document, with no interpolation of any
kind. Configuration reaches it as `data-` attributes through the HTML escaper, is read with
`getAttribute`, and is written with `textContent`, never `innerHTML`. There is no path from a
slide's configuration to executed code, and the tests assert it directly — the emitted script is
compared byte-for-byte against the constant.

Formats are allowlists rather than format strings, time zones and locales are structural regexes,
the countdown target is normalised to epoch milliseconds, and a QR payload only ever becomes module
coordinates. QR codes are drawn server-side from the already-bundled `qrcode` library, so a code
needs no network at the panel and no third-party image service.

Worth knowing if you have used it: **the designer's QR was never real.** Its editor drew a box with
the word "QR" in it, and its publish path has no `qr` case at all, so the element vanished entirely
from the published widget.

### Added — layered slides: generated objects, cut out and animated separately

Describe a scene and get back a background plate plus individual objects with real transparency,
each landing as its own element with its own entrance — rather than one flat picture with text on
top.

The pieces are **generated**, not extracted. Segmenting an object out of a finished image needs a
model, which means a native dependency and a ~100MB asset on a product that deliberately dropped
`sharp`; it is also worse at the job, because an object composited onto a soft background has no
clean boundary and the edges come back ragged around exactly the thin features a viewer looks at.
Instead each object is generated alone on a flat chroma backdrop and keyed out in pure JavaScript.

A bad cut-out still looks like a cut-out, so two measurements decide whether one is kept: how far
the backdrop's border wanders from its median, and whether the key removed anything at all. An
object that fails is skipped, named, and reported — a slide comes back with three layers or two, and
the difference is never something an operator has to notice for themselves.

### Added — lettering: a generated headline that is painted, not typeset

Brush script and painted display type, the things no bundled font can do. **The words stay a
field**: the editor shows them, a regenerate is asked for them, and they are emitted as the image's
alt text, so a slide whose headline is a picture is still readable to anything that cannot see it.
It can never be cropped, and it falls back to real type if it cannot be generated — a slide whose
whole purpose is to say one thing must not come back saying nothing.

Image models misspell, and nothing can verify that the picture spells the headline, so the operator
is told to check it every time.

### Added — video backgrounds

The background layer can be a clip, sitting in front of the still rather than replacing it: the
still becomes the video's `poster`, so what shows while the video loads — and for good on a panel
that cannot decode it — is the picture rather than a black rectangle.

Always muted, and not configurable: autoplay without a gesture is only permitted for muted media,
the player already decides which zone owns the audio, and scenery that talks over the next zone is
a support call.

**Proven on a live XT245.** With hardware z-order a video decodes onto a plane the DOM sits behind,
so a background would play *over* the headline — the inverse of a background. The renderer emits
`hwz="off"`, and a probe on real hardware confirmed DOM composites over a playing video (three
captures seconds apart, the overlay steady while the footage moved). Every other platform ignores
the unknown attribute.

### Added — `fit` on slide images

`cover` fills the box and crops the overflow, which is right for a photograph and wrong for a
cut-out, where the crop slices through the object itself. `cover` remains the default and slides
authored before this render byte for byte as they did.

### Fixed

- A QR added with no styling was a **solid white square**: its modules inherited the element colour,
  which defaults to white, on the white panel behind them. Modules now have their own colour
  defaulting to black, and a deck warning catches an unscannable pair at authoring time rather than
  on a wall.
- Per-element configuration was **silently dropped on every save**. The deck writer rebuilds each
  stored element key by key, so a clock would have lost its time zone the next time the deck was
  touched for an unrelated reason, with the editor still showing the operator's own choice until
  they reloaded.
- Generated objects landed **under the headline**, and a headline as short as "20% OFF" wrapped into
  the subhead. The text band is now reserved server-side, and the geometry assumes the wrap rather
  than the intent.

## 2.0.0-beta6

Two things that had never worked on a BrightSign now do, both proven on a live XT245 rather than
argued from the code.

### Added — the server can hold the LAN trigger door for players that cannot

Triggers are player-side by design so an alarm survives the WAN going down — but that needs the
player to bind a socket, which needs a Node context. BrightSign's server-on-a-player build creates
its widget **without** `nodejs_enabled` (deliberately: a Node-enabled widget "is NOT Node", and
hosting the server there cost four boot failures), so the player has no `require`, `dgram` and raw
`http` both throw, and no listener ever binds. Measured on hardware: trigger ports 7847, 8079 and
8099 all closed. **Enabling triggers on such a device did nothing whatsoever.** Tizen is in the same
position and says so honestly in `capabilities.js`.

The server on that board is real Node, so it can hold the door and hand what arrives to the player
over the socket they already share. On a server-on-a-player the offline guarantee is untouched —
server and player are the same hardware.

* ⚠️ **The player still decides.** The server resolves only *which device* a payload is addressed to,
  by its secret, and forwards the wire text verbatim; accept/reject stays in the one resolver both
  sides already share.
* ⚠️ The secret sweep **does not break early** (reply time would otherwise leak a device's position
  in the list), and "no such device" and "wrong transport" answer identically, so an unauthenticated
  LAN port cannot be used to enumerate secrets or configuration.
* **Off unless `TRIGGER_INGRESS=1`**, and still gated per device by the same `accept_http` /
  `accept_udp` flags an operator already sets. Set `TRIGGER_INGRESS_UDP_PORT` to move the port.

Verified on an XT245: a real UDP datagram across the LAN put the alarm on screen; the clear token
restored the playlist; `GET /api/trigger?secret=…&token=…` did the same.

### Fixed — screenshots on a BrightSign server-on-a-player

⚠️ **The BrightSign screenshot branch had never run on real hardware.** It was gated on
`device.platform === 'brightsign'`, and a BrightSign reports **`Chrome 148`** — its player is the
web player inside a Chromium widget. So the special-case, *including the pre-existing snapshot
queue*, never executed: a capture request was accepted, did nothing, and left the previous frame in
place. On our test unit that frame was ten days old.

The gate is now what the server can actually do (`@brightsign/screenshot` loads in this process)
plus a loopback check on the device, since we capture our own framebuffer and must never send it
labelled as another screen.

⚠️ **If you self-host and rely on BrightSign screenshots, they have not been working.** There is no
data to repair — no capture was ever taken — but the dashboard's "last screenshot" for those devices
is as old as whenever it last worked by another route.

Also new: `/api/status` reports **`screen_capture`**, because the absence of a capture is otherwise
invisible — the request succeeds and nothing happens.

## 2.0.0-beta5

LAN triggers now work on Android. Until this release they had **never once worked on an Android
panel** — three separate defects, each invisible to the test suite, all found by firing a real
trigger at a real device for the first time.

### Fixed — the overlay was built on a network thread, so it was never visible

`TriggerListeners` reads its datagram (or HTTP request) on its own thread and called straight
through to `TriggerOverlay.show()`, which constructs Views and attaches them. The failure mode was
the worst kind: no crash, no log. `dumpsys` showed the box really was a child of the layer — and
measuring **0×0**, because it never got a layout pass.

So the trigger "fired", the controller logged it, the lease ran, the state machine believed a screen
was covered, and the panel carried on playing its playlist. That is the reported "triggers are
inert", exactly. Every view touch now goes through the main-thread handler the class already had.

### Fixed — UDP was dead whenever no multicast group was configured (the default)

⚠️ **`org.json`'s `optString` returns the STRING `"null"` for a JSON null on Android.** The server
sends `multicast_group: null` when unset, and that string reached `InetAddress.getByName()` from
*outside* `joinGroup`'s try — so it threw all the way out and killed the whole listener thread,
including the unicast and broadcast paths that never needed a group at all.

⚠️ **The same trap hits two neighbours, and one is security-relevant.** `secret: null` became the
string `"null"`, and a fire is refused only when the device secret `isNullOrEmpty()` — which
`"null"` is not. **A device with trigger listeners enabled and no secret set accepted
`ST1 null <token>` instead of refusing everything.** `clear_all_token: null` likewise made the
literal token `"null"` clear every active trigger.

**If you have trigger listeners enabled, set a secret** (`POST /api/devices/:id/trigger-secret`).
Devices on this release refuse every fire until one is set, which is what should always have
happened.

⚠️ A JVM test cannot reproduce any of this: the reference `org.json` returns the *fallback* for a
JSON null, and only Android's returns `"null"`. That is why the suite was green. The same trap
already cost this project once, in the `remote_url` download path.

### Fixed — trigger media was never downloaded on Android

The adopt site's comment says the media "is pinned by the same message that pins the base playlist".
True for the **web** player, whose service worker gets trigger URLs appended by
`lib/device-triggers.js`. Android has no service worker — it downloads through `DownloadCoordinator`,
driven by a loop over `assignments` **only**, and trigger items live in a separate array that never
reached it.

So assigning a trigger to a device whose base playlist was unchanged downloaded nothing, and the
fire rendered its black box with no media inside: the "black screen" half of the report.

### Verified on hardware

HTTP POST raw `ST1` line → overlay on screen with its video playing; clear token → base playlist
restored; `GET /trigger?secret=…&token=…` → overlay again. The built-in UDP self-test reports
"this player receives its own group", proving the receive path. An external UDP fire could not be
staged through an emulator's NAT, so that specific path remains unproven end to end.

## 2.0.0-beta4

A one-fix release, and the fix is to beta3's own inference. Worth reading if you run beta3.

### Fixed — a stranded play could be credited with hours it did not play

beta3 added a repair that closes a play left open by an outage, using the start of the play that
followed it. Sound reasoning — but the guard against an implausible span was a blanket 24 hours,
and that is not tight enough. Deployed to our alpha instance, it closed a **20-second clip with a
duration of 31,368 seconds** (8h43m): the device had been offline overnight with no backfill
available, so the "next play" was the following morning and the entire gap was credited to the item.

⚠️ **If you deployed beta3, check for this.** Any row whose `duration_sec` far exceeds the real
length of its content was inferred wrongly and should be reverted to open:

```sql
SELECT p.id, p.duration_sec, c.duration_sec AS real_length
  FROM play_logs p JOIN content c ON c.id = p.content_id
 WHERE p.ended_at IS NOT NULL AND c.duration_sec > 0
   AND p.duration_sec > c.duration_sec + 60;
```

The ceiling now comes from the item's **own length** where we know it — a 20-second clip cannot have
played for eight hours whatever the gap says — with a short grace for rounding and stalls, and a
modest absolute cap where the length is unknown (widgets, images with an operator-set dwell). Beyond
either, the row stays open, which is honest about what we do not know. A genuinely long item still
closes correctly: a 40-minute video is allowed its 40 minutes, which a small fixed cap would have
wrongly refused.

The lesson is the one the rest of that module already followed and this guard did not: a missing
duration reads as missing, but an invented one reads as fact — and would be billed as fact.

## 2.0.0-beta3

Proof-of-play survives an outage now. Found by accident: a host-maintenance window took our alpha
instance down for 5h49m while an Android TV player was mid-soak against it. The screen played
faultlessly the whole time — and the server recorded none of it.

### Fixed — plays during an outage are no longer thrown away (#299)

Playback is offline-native; reporting was online-only. Every player guarded its proof-of-play emit
on a live socket and returned, so a play happening with the link down was discarded where it
occurred — not queued, not retried. `play_logs` had a 20,963-second hole where ~1,040 plays should
be, and nothing anywhere reported the loss. For a product where proof-of-play is frequently the
billable artifact, an outage silently erased the evidence that content ran.

Players now keep finished plays in a bounded, persisted queue and replay them on reconnect with
their **real** timestamps. Three things this had to get right:

* ⚠️ **Complete plays, not replayed start/end pairs.** The server closes a play by finding "the most
  recent open row for this device+content", so a backlog replayed alongside live playback could
  close the row the player has open *right now*. A finished play carrying both timestamps inserts
  in one shot and cannot race anything.
* ⚠️ **The server had to learn to accept a time.** It stamps rows `strftime('%s','now')` — correct
  for live plays, useless for old ones. Replaying through it would have recorded a thousand plays
  as all happening in the seconds after reconnect, which is *worse* than the gap because it reads
  as real data. And because a panel's clock cannot be trusted (a dead RTC reports 1970), times
  outside a sane window are **dropped rather than clamped** into looking plausible.
* ⚠️ **Backfill bypasses the insert throttle.** `PLAY_LOG_MIN_GAP_MS` caps proof-of-play at one row
  per device per 2s to bound a runaway live player. Applied to a flush it would have decimated the
  backlog to roughly one surviving row per 2s of flush time — silently reintroducing the same loss.
  The batch is bounded instead.

Replay is idempotent via a player-minted id with a partial unique index, so a flush that dies
before its ack cannot double-count: trading an under-report for an over-report is not a fix.
Entries clear only on the server's ack, and the queue is bounded so a panel offline for weeks
cannot fill its storage — evictions are counted rather than silent, which is how the original bug
hid.

Covers every player: one shared queue serves the web player (and therefore BrightSign and Fire
TV/Vega) and is copied byte-identically into the Tizen `.wgt`; Android has its own Kotlin port with
the wire shape pinned by tests on both sides.

### Fixed — the play an outage stranded is closed from the play that followed it

One row per outage was beyond the backfill's reach: the item in flight when the link dropped had
its start recorded live and its end lost, so it sat open forever with no duration. The queue cannot
replay it without duplicating the row that already exists.

But the evidence was already in the table — a device advancing to another item proves the previous
one ran until that moment, so the successor's `started_at` is the predecessor's end. This also
repairs rows stranded by **past** outages and reboots, on the first play after upgrading.

* ⚠️ **Same zone only.** A multi-zone device plays several items at once, so the next row for the
  device may belong to a different zone that started while this one was still on screen. Closing
  against it would cut the play short.
* ⚠️ **Never the item playing now** (it has no successor because it has not ended), and **never
  across an implausible span** — a panel that played one item, went dark for a week and returned
  must not have a week of runtime attributed to it. Past the cap the row stays open and honest.
* `completed` is deliberately left alone: advancing is evidence it *played* that long, not that it
  ran to its end — an error-advance looks identical from here.

## 2.0.0-beta2

A player release: two defects reported against 1.9.40 on Android TV, both fixed here. They came
from one operator running five TVs, and both have the same underlying shape — the video path
trusted a signal that a wedged or reconfiguring decoder never sends.

### Fixed — a frozen playlist now recovers itself (#297)

A video advanced the playlist in exactly two ways: ExoPlayer reported `STATE_ENDED`, or it reported
a playback error. A decoder that simply **wedges** reports neither — it stays `READY`, the player
still believes it is playing, and the position stops moving. Nothing in the app ever looked at the
position, so the playlist stopped for good and only restarting the app recovered it.

* A stall detector now watches playback position instead of waiting for an event, and routes a
  wedge into the same self-heal an error already used.
* ⚠️ **The dangerous half of a watchdog is the false positive**, not the miss: firing on a paused
  wall follower, a group-sync member waiting for its slot, or a stream that is legitimately
  buffering would skip content nobody asked it to skip. A stalled item is only reported while the
  player claims to be playing, buffering gets a longer allowance than a stuck `READY` state, and
  a report resets the detector so one wedge cannot advance twice. Most of the nine new tests are
  about *not* firing.

### Fixed — the green screen at the switch to the next video (#298)

`setupExoPlayer()` disabled Media3's shutter, with the comment "hold the last frame instead of
flashing black during a reset/prepare". It does not hold the last frame — it **uncovers the video
surface**, and with `surface_type="texture_view"` the buffer behind that surface during a decoder
reconfiguration is whatever the SoC left there. On several TV chipsets that is uninitialised YUV,
which paints solid green.

That accounts for every detail of the report: TVs only, at the switch to the next item, unaffected
by re-encoding every clip to identical settings (the codec is torn down and re-created on each
`prepare` regardless of resolution), and gone when the playlist loops a single item.

* The freeze-frame the old comment promised is now painted explicitly, into the ImageView stacked
  above the video surface, and cleared on `onRenderedFirstFrame` — the only trustworthy signal that
  the decoder is putting real pixels on screen.
* When there is no frame to hold, the shutter is re-armed, so a brief black hold remains the worst
  case rather than green.
* The cover reuses one half-size bitmap. Capturing at full resolution on every switch would
  allocate ~33MB a time on a 4K panel — on exactly the memory-constrained devices already failing.

## 2.0.0-beta1

First beta of the 2.0 line. The alpha series proved the shape; this is the point at which the
feature set stops moving and the remaining work is verification. Two things landed since alpha8
that change what the product can do — HTML bundles as playable content, and a way to actually
create a workspace — alongside a run of defects that only show up in front of a person.

⚠️ **Two known gaps carried into beta deliberately**, both documented where they live rather than
left to be discovered: a flattened HTML bundle cannot `fetch()` its own files at runtime or stream
embedded video, and Tizen's offline bundle path has never run on a real panel
(`docs/player-parity.md` says which platforms are measured).


### Added — you can create a second workspace

Workspace scoping, invites, member roles, the switcher and the JWT context were all built and
working. What did not exist was any way to make one: a `workspaces` row was written in exactly
two places — at signup and by a platform admin — both hardcoded to the name "Default", and the
tenant-facing router had GET, PATCH, members and invites but no POST.

Production showed 313 organizations with exactly one workspace each. That read like nobody wanted
a second one; it actually meant nobody could have one.

* `POST /api/workspaces` creates one in an organization **you administer**. The org is resolved
  from your own membership; an `organization_id` in the body is honoured only after confirming you
  are org_owner or org_admin there — otherwise the endpoint would mint a workspace inside someone
  else's tenant, which every workspace-scoped route downstream would then treat as legitimately
  theirs.
* ⚠️ **An org role is required, not `can_admin`.** A workspace_admin administers one workspace;
  letting that mint siblings would let anyone handed a corner of a tenant grow it. The creator is
  added as workspace_admin, or they would own a workspace they could not administer or invite into.
* A per-org cap (`MAX_WORKSPACES_PER_ORG`, default 25) stops a scripted caller filling the switcher.
* The switcher gains a "New workspace" control — always visible in the single-workspace view, since
  hiding the only route to an invisible capability behind a hover is how this happened in the first
  place — and a row at the foot of the dropdown.

### Added — HTML bundles (`.wgt` / `.zip`) play as a playlist item

Upload a W3C widget package or a plain zip of `index.html` plus assets, and put it in a playlist
like any other content. Asked for by a BrightSign community contact; it plays on all four players
and survives an outage on three of them.

* A bundle is an **ordinary content row**. The archive is stored exactly as uploaded and is never
  extracted on the server, so it inherits revision-keyed re-download, resumable delivery, the mesh,
  storage quota, replace, folders and expiry — and zip-slip has no target on our disk.
* Validation reads only the zip's central directory. Refuses traversal (after normalising
  backslashes, or a Windows-built archive escapes), symlink entries, encryption, unsupported
  compression, duplicate names, non-UTF8 names, declared bombs, and an archive with no entry point.
  A `.wgt`'s `config.xml` `<content src>` wins over `index.html`.
* The server flattens it into one self-contained document, which is what makes it playable
  everywhere on day one — every player already mounts an iframe and none of them can unzip.
* **Offline** on web, BrightSign and Vega (the render is fetched same-origin and mounted as
  `srcdoc`, so it lands in the service worker's Cache API) and on Android (its own render store).
  ⚠️ Tizen's offline path is implemented but has **never run on a panel**; its online path is
  unchanged. See `docs/player-parity.md`.
* **Limits, stated plainly:** a flattened bundle cannot `fetch()` its own files at runtime and
  cannot stream embedded video. Both are traded away for playing on every platform.

### Fixed — an unrecognised media type stopped the playlist dead

On the web and Android players an item whose `mime_type` matched nothing mounted nothing **and
armed no advance timer**: no media element, so no error event, and neither watchdog re-arms the
rotation. One such item blanked the screen and froze the loop until a socket push or a restart.
Reachable in a single call, because `POST /api/content/remote` stores `mime_type` verbatim from the
request body with no validation. Tizen degraded better but still retried a broken item forever in a
single-item playlist. All three now skip.

### Fixed — "Add Background Image" and "Choose Logo" did nothing on a directory board

Reported as "someone couldn't upload a background picture", and that is exactly what it
was. The image picker referenced `esc()` — added by the escaping sweep on 2026-08-11 and
never imported into `views/widgets.js` — so opening the dialog threw ReferenceError before
it could attach itself to the page. The button was inert, silently, and the promise behind
it never settled.

The same missing import broke two more things on the same day, in the same file:

* the **Weather** widget's config form could not be opened at all (`esc(config.location)`)
* the **Social** widget's config form could not be opened at all (`esc(config.query)`)

Verified against the 1.9.x tree in a real browser: Weather and Social render an empty form
and the picker never opens, all three with `esc is not defined`; adding the import fixes
all three and leaves no page errors.

Nothing caught it. The reference resolves only when the line runs, so a syntax check
passes; every view still rendered, because all three calls sit inside click handlers; and
the whole suite stayed green. `test/frontend-shared-helpers.test.js` now fails when a
frontend file calls a shared helper it has not imported, and the browser smoke opens every
widget type's form.

**This is live on hosted (v1.9.36, since 2026-08-14) and on the 1.9.x branch — it needs the
same one-line fix there.**

### Added — upload a picture from inside the picker

The dialog was read-only, and its empty state said so: "Upload images first from Content
Library". Choosing a background meant abandoning a half-filled widget form, crossing to
another view to upload, and coming back. It now takes a file directly — a button or a drop
— uploads it into the library, and returns it selected.

### Fixed — the image picker could show nothing while the library was full of images

It asked for `/content` with no query, which returns the 100 newest rows of **every** type,
and filtered to images afterwards. A workspace whose last hundred uploads were videos saw
an empty picker, and the search box could not reach them either because it only ever
filtered what had already been fetched. Both the widget picker and the slide editor now ask
the server for images, and for its maximum.

### Fixed — picking an image threw the grid back to the top

Every selection re-rendered the whole list, which re-fetched each authenticated thumbnail
and reset the scroll position. Choosing a fourth background meant scrolling down four times.

### Fixed — a refused upload said only "Upload failed"

The server is specific — unsupported file type, storage limit, no workspace — and
`uploadContent()` replaced all of it with a shrug. It now reports what the server said.

## 2.0.0-alpha8

### Fixed — the slide Motion tab could not be used

Delay and duration each moved one step and stopped. Both sliders triggered a
repaint that rewrote the panel they live in, destroying the control being dragged
on its first input event — the same defect the Style tab had, still present here
because that tab was fixed and this one was not touched.

Motion now matches Style: grouped controls, a slider **and** a number box for each
value, and the entrance replays when you let go of a slider rather than
restarting on every pixel of the drag.

### Fixed — typing a headline lost the caret after every character

The text field on the Content tab had the same problem, in the place it shows
worst: each keystroke rebuilt the panel, so the textarea was replaced and the
cursor went with it. Typing past the first letter was not possible.

### Added — the Motion tab shows timing against the slide

Delay and duration mean nothing on their own: 0.8s is unnoticeable on a
ten-second slide and most of a two-second one. The tab now draws where the
selected element lands against the slide's dwell, with the other elements behind
it for context, and says plainly when something will still be animating as the
slide is replaced — which on a wall reads as text that never arrives.

### Internal

The rule those three bugs broke is now enforced rather than remembered: a guard
fails the build if any live-value handler triggers a full repaint, if the two
update paths are collapsed back together, if a typed number commits on every
keystroke, or if the editor stops taking its fonts and animations from the
server. It found the third instance itself.

## 2.0.0-alpha7

Two fixes and one addition, all found by using the thing.

### Fixed — the slide Style panel could not be used

Every slider called a repaint that replaced the panel's own HTML — including the
control being dragged. The slider you were holding was destroyed on its first input
event, so it moved one step and stopped, and the colour picker closed the moment you
picked a colour. It looked fine and did nothing.

Value changes now update the stage, the thumbnail and the header and leave the
control under the pointer alone. Structural changes — adding, deleting, reordering —
still repaint everything, because the list of things to inspect has changed.

While it was open, the panel was rebuilt around that: every value has a slider **and**
a number box, so you can drag to find a look or type to match one; controls are grouped
into Position & size, Type and Appearance; weight and align are buttons rather than
dropdowns; and the colour control is a real swatch instead of the plain white bar a
native colour input renders as until its internals are styled.

### Added — picture backgrounds

A slide can sit on a photo from your content library, with a **Dim** control.

The dim is not decoration. The photo is whatever you had, its contrast varies across
the frame, and white text over a bright sky is unreadable from the far side of a lobby.
It renders as a scrim between the photo and the words — dimming the photo needs image
editing, dimming the text ruins it. The background colour stays underneath, because
that is what shows while the photo downloads and what stays if it never arrives.

### Fixed — a failed BrightSign server install now says why

When a payload install failed part way, the log on the device simply stopped and the
reason went to two places nobody can reach: a status listener bound to localhost, and
an on-screen buffer that is gone at the next reboot. The one file a technician can
fetch remotely contained everything except the cause.

Worse, the tree replace is not atomic. Dying part way leaves a mixture — the version
file already updated while half the modules are the old ones — and that tree boots,
because a failed update is deliberately survivable. The box then reports a version
nobody built.

Failures are now written to that log, naming the file the install died on. A marker
records that a replace was interrupted, and the next boot reinstalls rather than
trusting the version number.

⚠️ On an existing player this takes **two reboots** to arm: the launcher ships inside
the payload, and a new launcher only runs from the boot after it is installed.

### Note on upgrading

Still a pre-release, so Android players on the stable channel will not take it.

## 2.0.0-alpha6

Slides. A deck of PowerPoint-style pages you build in the dashboard, each element with its own
entrance, published as a playlist your screens already understand.

### Added — a slide editor

**Slides** in the sidebar. Build a deck, drag elements around the stage, and give each one an
entrance — rise, drop, slide, zoom, wipe or fade, with its own delay and duration. Headline, text,
big number, photo, rule and panel. Three property tabs per element plus one for the slide itself.

Publishing emits one slide widget per page and a playlist that orders them, so nothing downstream
had to learn a new content type: scheduling, groups, inheritance and every player keep working on
objects that already existed.

**Editing text does not rebuild the layout.** A slide keeps its geometry, style and motion in a
*template* and its words in a *record*, joined when the slide renders. That is what makes coming
back in three months to change a number actually work — and it is the thing every other widget in
this product gets wrong by baking content into its HTML.

**Saving is not publishing.** Somebody part-way through a deck has every right to a slide that does
not add up yet, and nothing reaches a wall until they say so.

### Added — fonts, finally

Five families ship with the server — Inter, Archivo, Oswald, Bitter and JetBrains Mono — so a slide
looks the same on Android, Tizen, BrightSign and a browser. Before this there was no font pipeline
at any layer: the old designer offered "Impact", which exists on none of those, so the same slide
rendered differently on every panel.

All five are under the SIL Open Font License, which permits the redistribution this product
performs — every screen showing a slide downloads the face from your server.

You can **upload your own** for a brand face: `.woff2`, `.woff`, `.ttf` or `.otf`, checked by
content rather than by filename. Delete one later and slides using it stay readable in a bundled
family rather than falling back to whatever the panel happens to have.

### Fixed — an Android bug that would have made decks unusable

Playlist continuity was keyed on content id, and widget items have none. In a playlist made of
slides every item looked identical, so any edit snapped playback back to the first slide — and then
returned without re-rendering, leaving the old slide on screen with the index pointing elsewhere.
Fixed with an identity that includes the widget, plus a re-render when only the revision moved.

### Fixed — releases were shipping short, silently

CI never built the two BrightSign artifacts that make a player run the **server** rather than just
the player. Every release since they existed went out without them and nothing said so. They are
built in CI now, the payload manifest ships beside its payload, and `finalize-release.sh` refuses
to finish if any expected asset is missing.

Release tarballs also carried `server/.claude/` tooling files — all zero bytes, nothing leaked, and
now excluded and caught by the credential gate.

### Added — naming your servers

Every server in a mesh has a name its peers display. It defaulted to the machine's hostname and
there was no way to change it — the setter existed and had no callers, so a lab of three servers
was three boxes all called `i9`. Rename under **Servers**; the name reaches every peer on the next
report, and travels upward only, so nobody above can rename your server for you.

### Added — remote diagnostics, verified content, and passing content on

An MSP can see *why* a customer's screen is unhealthy, under its own grant, with error payloads
reduced to the message and a URL's origin — never the query string. Content is checked before it is
served, by size every time and by digest when the file has actually changed. And a relay can pass
content on to a server below it when all three parties agree.

### Note on upgrading

Still a pre-release, so Android players on the stable channel will not take it. The mesh remains off
unless `MESH_ACCEPT_ENROLLMENT` or `MESH_ALLOW_UPLINK` is set.

## 2.0.0-alpha5

The mesh stops being read-only. A hub can now send content to a customer's server and ask its
screens to do things — and every one of those is a *request* the receiving server decides on, using
its own grant, its own disk and its own rules. Servers also finally have names.

### Added — a hub can send content to a customer's server

Content pushed from a hub is offered, not delivered: the receiving server checks the grant its own
operator gave, the disk budget that grant carries, and the free space it actually has, then accepts
or refuses and says which. Transfers resume where they left off rather than restarting, which is
what makes a 400 MB video survive a site link that drops. Abandoned transfers are swept.

One campaign can be sent to many customers at once. The batch re-checks visibility and permission
per server, so it cannot reach a customer a single send could not.

### Added — a hub can ask a customer's screens to reboot, reload or change settings

Under a separate grant, with a deliberately smaller command set than a local operator has. The
consent screen says "reboot, reload, change settings on screens", so `shell` and `install_apk` are
not in it — a consent screen that overstates what it grants is worse than none.

### Added — the customer can see what was done to them

Every write a hub performs against a customer's server is recorded on that server, visible to its
own operator, and cannot be edited or suppressed from above. An MSP relationship a customer cannot
audit is not one they consented to.

### Added — a relay tier

A hub can pass content on to a server further down, but only when all three parties agree: the
content's owner marked it relayable, the relay operator opted that client in, and the receiving
server's own grant allows it. None of the three is substitutable for another. Telemetry travels the
other way through a relay under the same rule.

### Added — topology, and names for the servers in it

The Servers view draws the estate as a tree: direct neighbours, servers further away, how many hops
a screen's data crosses to reach you, and which server relayed it. Previously a three-tier mesh was
indistinguishable from a two-tier one.

And servers can be named. The name defaulted to the machine's hostname and there was no way to
change it — the setter existed and had no callers, so a lab of three servers was three boxes all
called `i9`. An instance owner can now rename theirs under **Servers → Rename**; the name reaches
every peer on the next report. It travels upward only: nobody above can rename your server.

### Added — remote diagnostics, under their own grant

A hub can see why a customer's screen is unhealthy, not merely that it is. Error payloads are not
forwarded wholesale: what travels is the message, the fingerprint, and a URL's origin and path
without its query string.

### Added — bulk selection and group actions on the dashboard

Select several screens and act on them together (#296).

### Added — playlist inheritance that forks instead of overwriting

A per-device edit to a group's playlist now forks a copy rather than editing the playlist every
other device in the group is using.

### Fixed — a long list of things that only three real servers could find

Among them: the write path could not be reached by any user on any install; a backslash walked
through the path allowlist; the disk budget could be bypassed by omitting a field; a delete could
take another customer's bytes with it; a mandated retry double-applied; a restore restarted every
screen that already had the content; content ids were never translated between servers, so a push
would have failed even once everything else was right.

### Fixed — the API documented six commands and accepted twenty-two

`POST /groups/{id}/command` had grown three times and the spec kept the original six, so an
integrator would conclude their token could reboot a screen but not set its volume. A contract test
now fails if the two ever disagree again.

### Added — API documentation for things that already shipped

`POST /devices/{id}/command` (commanding a single screen was reachable only over the dashboard
socket) and the whole `/triggers` surface, which shipped in alpha4 undocumented.

### Note on upgrading

The mesh is off unless you turn it on: with `MESH_ACCEPT_ENROLLMENT` and `MESH_ALLOW_UPLINK` unset
there are no mesh routes at all. As with alpha4, this is a pre-release version — Android players on
the stable OTA channel will not take it.

## 2.0.0-alpha4

Triggers become usable, and a QA pass found that the previous build could not switch them on.

### Fixed — the feature could not be enabled at all

Nothing anywhere wrote a device's trigger secret or its accept flags. The server read them, the
player consumed them, the dashboard rendered their diagnostics — and no route ever set them, so the
secret was always empty, every payload was refused, and no listener ever started. There is now an
API and a form on the device page for the listener settings and the shared secret.

### Fixed — a trigger produced a black, silent screen on a real panel

Two bugs compounded. The overlay was created unmuted, and unmuted playback without a user gesture is
refused outright — a signage panel never gets one — so the alarm video never started, and with a
single-item trigger there was nothing to recover it. Meanwhile the base playlist was being silenced
underneath it. The net effect of firing a trigger was worse than not having the feature.

### Fixed — trigger content did not reach the screen until it happened to reconnect

Creating, editing or deleting a trigger pushed nothing, so a panel that had been running for weeks
never learned about it. Publishing an edited playlist reached only screens using it as their main
playlist, never those using it as a trigger target — so an operator could swap an evacuation notice,
see "Published", and have every panel keep showing the old one. Both now deliver immediately, along
with the content the trigger needs so it still works with the network down.

### Fixed — a trigger could be saved that could never play offline

A trigger whose playlist contained a web page, a YouTube video, or an item whose file had been
deleted would save without complaint and then show nothing when it mattered. These are now refused
at save time, naming the item.

### Fixed — device credentials were readable by API tokens

A read-only integration token could list a device group and receive the credential a screen uses to
authenticate, plus its settings PIN and trigger secret. Two other routes returned the trigger secret
after a rename. Unrelated to triggers in origin; found while reviewing them.

### Added — the Android player can show triggers

Android renders a trigger's playlist from its local cache, so it works offline, and silences the
main playlist while the overlay is up.

### Known limitation

Trigger audio behaviour is unverified on BrightSign hardware. The player uses two independent
mechanisms to silence the main playlist so it works if either is honoured, but confirming it needs
someone listening at a panel.

## 2.0.0-alpha3

One fix, and it is the one that makes the previous two releases reach a player at all.

### Fixed — a BrightSign player's launcher could never be updated

The server package installs onto the player and replaces the whole server tree. The small launcher
that boots it sits beside that tree, and the installer updated it by copying the new copy up itself.

On real hardware that copy silently did nothing. The package installed, the server ran, the version
number changed — and the launcher stayed exactly as it was when the player was first set up. The
only record of the failure went somewhere unreachable from the device, so nothing anywhere said so.

⚠️ **Every launcher fix so far was affected**, including the 24-hour update check added in
2.0.0-alpha2, which exists precisely so a running player does not need someone to power-cycle it.
Until this release, that check could not have arrived on any player in the field.

The launcher now travels at the top level of the package and is installed by the same mechanism that
places its other 9,630 files. A package built before this change cannot update a launcher, and the
install log now says so rather than leaving no trace.

**If you have a player on 2.0.0-alpha0, alpha1 or alpha2, it needs one more manual reboot to take
this release.** After that its launcher updates with every package, and the 24-hour check takes over.

### Known limits

Unchanged from 2.0.0-alpha0 — read-only, two tiers, no content/schedules/widgets/layouts across a
link, and both sides on 2.0.0 or newer. See that entry.

## 2.0.0-alpha2

Everything here came out of watching a real BrightSign take the previous release, rather than from
reading code. The mesh is still **off by default** and still read-only; the limits under
2.0.0-alpha0 all still apply.

### Added — a running player checks for a new server payload every 24 hours

The check ran once, at boot. A player that stayed up for a month never saw a single release, so
updating it meant someone power-cycling it — the manual step the update path exists to remove.

It asks for the small manifest, not the 80MB package. When something new is published the player
**reboots** so the boot path installs it: the server runs inside the launcher process, so it cannot
be replaced underneath itself, and rebooting reuses the install that runs on every cold start rather
than a second, rarer copy of it.

⚠️ **Each published payload is worth exactly one reboot.** If an install does not take, the player
stays where it is and says why in `.payload-install.log` rather than rebooting every day and
re-downloading the package each time. Checks are jittered, because a fleet provisioned together
boots together and would otherwise all ask in the same second forever.

Configure with `updateCheckHours` in `st-config.json` (24 by default, `0` checks only at boot).
`autoUpdate: false` still pins a player to what it has and disables this with it.

### Fixed — a connected server showed the version it had on pairing day

`peer_version` was written once, at enrollment, and never updated. A player that took a new release
and was demonstrably running it still appeared on the parent as whatever it ran when it was paired.
The Servers view calls that column **version skew**, which makes a frozen value worse than no value
at all: it is the field you check to confirm a fleet took an update, and it answered with the past.

It now refreshes from the peer's own reports. A report relayed from further down the tree updates
that node, not the link it travelled over.

### Fixed — a player could quietly lose the ability to see the next payload

The installer recorded the payload's checksum *after* refreshing its own launcher. A player was
found running the current release with no checksum recorded at all — and because the checksum is
what detects a **rebuild** of an unchanged version string, that player would have kept booting
happily while never taking another payload.

The checksum is now written as soon as the tree is verified, before anything optional, and read back
afterwards, because an empty write is otherwise indistinguishable from success. The install log also
records the stages in between, which previously wrote nothing at all across the riskiest part of the
update.

### Known limits

Unchanged from 2.0.0-alpha0 — read-only, two tiers, no content/schedules/widgets/layouts across a
link, and both sides on 2.0.0 or newer. See that entry.

## 2.0.0-alpha1

The second Node Mesh alpha. The mesh is still **off by default** and still read-only; the limits
listed under 2.0.0-alpha0 all still apply unchanged. This release is what using alpha0 on real
hardware turned up, plus a player fix that has nothing to do with the mesh and matters to everyone.

### Fixed — a duration-only playlist edit never reached the player (#295)

Change nothing but an item's duration, publish, and a running player kept advancing on the old
value. Reloading the page did not help either, because the stale duration was also in the player's
local cache.

The player fingerprints the item list to decide whether a change is big enough to **restart**
playback, and duration is deliberately not part of that — a duration edit must not send the screen
back to item 1. It simply had nowhere else to be applied.

It is now applied in place and written to the cache, along with **every other per-item field that
does not need a restart**: mute, captions, subtitles and title were in exactly the same trap. A mute
change on the item currently on screen takes effect immediately rather than at the next loop.

Reported, diagnosed and patched by **@stuart-hampl**, who also spotted that duration was not the
only field affected. Thank you.

### Fixed — a remote screen shows a picture

Screenshots from a connected server now render in the Displays list and on the device page. The
proxy was there in alpha0 and did not work in a browser: it required an auth header, and an `<img>`
tag cannot send one.

### Fixed — BrightSign server upgrades

The BrightSign server package can now update itself in the field instead of needing a card pulled:
it fetches a manifest, compares a checksum, and installs only on a real difference. First install is
handled too, which the first cut of this missed — a player with no payload yet would sit waiting for
a change that had already happened. Every install verifies its checksum before extracting.

The bootable package is now called **`autorun-server`** rather than `autorun-boot`.

### Added — Simplified Chinese, and French at full parity

- **Simplified Chinese** (`简体中文`), complete — 1821 of 1821 strings. Contributed by **@huyuy77**.
- **French** goes from 1156 to 1821 strings, so it is no longer half English in practice.
  Contributed by **@giyokun**, who also corrected a set of Japanese machine-translation artefacts —
  "opt-in" had been rendering as *optional power-on*, and "clean exit" as a literal pretty doorway.

### Known limits

Unchanged from 2.0.0-alpha0 — read-only, two tiers, no content/schedules/widgets/layouts across a
link, and both sides on 2.0.0 or newer. See that entry.

## 2.0.0-alpha0

The first build of **Node Mesh**: connecting one ScreenTinker server to another, so an operator
running several of them — or an MSP watching customers who each run their own — can see and work
across all of them from one place.

⚠️ **This is an alpha, on the `2.0.0` branch, and the mesh is off by default.** With
`MESH_ACCEPT_ENROLLMENT` and `MESH_ALLOW_UPLINK` unset there is no new API surface, no new socket
namespace, no background work and nothing new in the UI. An install that never sets them should be
indistinguishable from 1.9.x.

### Added — one server can observe another

Two servers pair with a short-lived, single-use code. The side **giving** the data decides what
travels: a grant is an explicit list of categories (health, identity, what is scheduled to play,
proof of play, screenshots…), each described in plain language at the moment of the decision rather
than as a vocabulary to look up. `[]` means nothing is shared, and it is the default.

A server also chooses **which workspaces** go up. Sharing every workspace — including ones created
later — is the instance owner's decision alone; anyone else names workspaces they administer, and
naming one they do not is refused rather than quietly trimmed.

Connected servers appear as **orgs in the ordinary workspace switcher**, and their screens in the
ordinary Displays list, with the device page rendering exactly as it does for a local screen. It is
read-only for now, said once in a banner rather than as a disabled state on every button.

### Added — Servers, Activity and Reports

- **Servers** — the connected servers, the topology (per-link health, version skew, depth limit) and
  pairing.
- **Activity** now shows open alerts from *every* connected server beside this one's. There is no
  such thing as "a remote outage" to the person on call; there is an outage.
- **Reports** gains a per-client uptime report with a CSV export — the artifact an MSP hands a
  customer. ⚠️ It reports **coverage** beside uptime, because a site whose link died a week ago sends
  no incidents and would otherwise score a flawless 100%.

### Changed — status is tri-state

A remote screen is *online*, *offline*, or **last known** — amber, not red — when the server that
reports it cannot currently be reached. A WAN blip on one link must never paint 400 healthy screens
red and send an engineer to a working site. Every remote row carries its age.

### Changed — telemetry

`wifi_ssid` is no longer collected, stored or displayed. 94% of its values were not SSIDs at all, and
the ones that were are customer network names, which are geolocatable against public wardriving
databases. Signal strength stays: the name was the liability, the signal is what an installer acts
on. `cpu_usage` is rounded at the source, where nothing has ever displayed more than a whole percent.

### Performance

A reporting child sends **one batched message per cycle instead of one per screen** — 402 messages a
minute becomes one for a 400-screen site — compressed on the body, which takes a cycle from 227 KB to
around 8 KB. Batching is negotiated: a server that does not understand batches is sent individual
payloads exactly as before. Reads served to a parent run on a **worker thread** where the platform
has one, and inline where it does not, with both paths returning the same answer.

### Known limits in this alpha

- **Read-only.** A connected server can be observed and browsed, not changed. The vocabulary for
  write grants exists and is deliberately unused.
- **Two tiers.** `MESH_MAX_DEPTH` is 2. Deeper trees are implemented and tested but stay locked until
  two tiers have run on real hardware.
- Content, schedules, widgets and layouts are not yet readable across a link, so those panels are
  empty when viewing another server rather than showing your own.
- Both sides of a link must be on 2.0.0 or newer.


## 1.9.39

A single wording change, following feedback on the white-label work in 1.9.38.

### Changed — the hide-branding toggle no longer names anyone

In 1.9.38 the setting read `Hide "<your brand>" branding` on a white-labelled instance, because it
was included in the brand substitution. That was backwards: the toggle hides the *platform's*
attribution, not the operator's own name, so on an instance branded "Acme" it offered to hide Acme's
branding.

It now reads "Hide platform branding", and the equivalent in the six other translated languages.

### Fixed — a missing database driver is repaired again on Node 20 and 22

1.9.38 made `better-sqlite3` an optional dependency, so that a host without a compiler installs
cleanly and falls back to Node's built-in driver. That fallback needs Node 24: on the 20.x and 22.x
lines the built-in is absent or behind a flag, and there a missing `better-sqlite3` means the server
cannot start at all.

npm will quietly skip an optional dependency whose install script it declines to run — leaving an
install that reports success and a server that will not boot. The startup check now treats optional
dependencies as required on any host that has no built-in driver, and repairs them like any other
missing package.

### Upgrading

No migrations, no configuration changes. Nothing to do.

## 1.9.38

A fix for anyone running the server on the display itself, and the white-label gaps a reseller
reported.

### Fixed — a player hosting its own server showed a black screen

On a BrightSign running ScreenTinker for the screens around it, the player area was black once the
first account existed. Nothing was broken in the player: the page and every one of its scripts
loaded normally, and nothing appeared in any log.

The device shows a local page that layers the player in a frame, and the server sends
`X-Frame-Options: SAMEORIGIN`. That local page is served from `file://`, which is not the same
origin, so the browser refused to draw the frame and left it black.

The header is now dropped only when the server was started as a player host and the request came
from the machine's own loopback interface. An ordinary server is unchanged, and so is any request
arriving over the network — which is where clickjacking would have to come from.

It also applies to what the player embeds, not only the player itself: browsers judge that rule
against the top-level page, so widget and kiosk views inside a playlist would otherwise have gone
black one level deeper.

### Fixed — white-labelling left the product name in a dozen places

Reported by a partner reselling the platform under their own brand (#292).

**The APK download filename.** Downloads saved as `ScreenTinker.apk` regardless of branding, which
told whoever received the file exactly what the upstream product was. It now uses the configured
brand name, resolved from the domain the request arrived on, sanitised to something safe as both a
filename and an HTTP header.

**Users created by an administrator no longer ask to be verified.** They were created unverified, so
they met a "Please confirm your email address" banner they could not dismiss — and on an instance
with no mail server configured, could never clear. Nobody sends a verification link to an account an
administrator provisioned.

**Nine user-facing strings** — setup instructions, the empty-dashboard hint, onboarding, two sign-in
errors — named the product directly and now use the configured brand, in all seven translated
languages. An install with no brand set reads exactly as before.

Three references were deliberately left as they are: the brand-name field's own placeholder, the
explanation of what install statistics report to the upstream project, and the widget security
warning.

### Upgrading

No migrations, no configuration changes, and nothing to do differently. Hosted and self-hosted
installs are unaffected by the framing change unless they run the server on a player.

## 1.9.37

Two fixes worth upgrading for on their own, and a change to how the server picks its database driver.

### Fixed — the password box disappeared while you were creating the first account

On a brand-new install with no users yet, typing an email address into the sign-in form made the
password field vanish and the button change to "Next". There was no way to finish creating the first
account, which is the only thing a fresh install can do.

The cause was the identifier-first sign-in flow, which asks the server which provider an address uses
before offering a credential. That question has no meaning when the user table is empty — there is
nobody to identify, the operator is creating the first account — but the "you edited the address, go
back a step" handler still fired on the first keystroke and took the password field with it.

First-run setup now ignores that flow entirely rather than being initialised into a state a later
keystroke could undo, and the decision about what the form shows lives in one place instead of two
mutable flags updated from four listeners.

**If you are installing on your own hardware, this is the fix you want.** The bug only appears before
the first account exists, so it never shows up on an established server — and it made a first install
look broken.

### Fixed — a fresh checkout could not resolve the server's dependencies

`server/node_modules` was committed as a symbolic link pointing at its own absolute path. Anything
that followed it got a filesystem loop, so a fresh clone produced a server whose dependencies could
not resolve, and building the BrightSign package failed outright. Only people working from the git
repository were affected; released tarballs and Docker images were not.

### Changed — the SQLite driver is now chosen when the server starts

The server prefers `better-sqlite3`, as it always has, and falls back to Node's built-in
`node:sqlite` when the native module is unavailable. `better-sqlite3` is therefore now an *optional*
dependency.

**Nothing changes for an ordinary install**: where the native module builds, it is used. What changes
is that a host without a compiler — a player, a minimal container, a machine whose Node version moved
— now starts on the built-in driver instead of failing, and the startup check no longer attempts a
source rebuild it cannot complete there.

Both drivers are run against the full test suite on every change, which was the real motivation: the
player package used to be produced by rewriting the server at build time, so the database layer it
shipped with had never been executed by any test.

### Added — a BrightSign player can host the server

A BrightSign XT245 can now run ScreenTinker itself, serving the displays around it, with the setup
address on screen until the first account exists and the player taking over afterwards. It is opt-in
per device and off by default. Video thumbnails and durations work there too: the package carries
`ffprobe` and `ffmpeg` built for the player.

Those binaries are unmodified FFmpeg 7.1.1 under the LGPL, built without any GPL component, and the
licence ships beside them. `legal/third-party.html` gains the corresponding notice — and drops Sharp,
which it still listed although 1.9.34 replaced it.

### Upgrading

No migrations and no configuration changes.

`scripts/upgrade.sh` needs no adjustment: `npm ci --omit=dev` still installs `better-sqlite3`, because
optional dependencies are installed by default. To deliberately run on the built-in driver — Node 24
or newer — set `ST_SQLITE_DRIVER=node`. Setting it to `better-sqlite3` makes a missing native module a
startup error rather than a silent fallback, which is worth doing where you expect the native driver
and want to be told if it is gone.

## 1.9.36

A single fix. **1.9.36 replaces 1.9.35** — see below for whether that affects you.

### Fixed — 1.9.35 would not start on a server collecting install statistics

A server with install-statistics collection switched on could not start 1.9.35. It threw
`ReferenceError: Cannot access 'db' before initialization` while loading, before it began listening,
and a service manager configured to restart it would do so in a loop.

**Almost nobody is affected.** The fault is inside a block that only runs when a server is configured
to *collect* statistics from other installs — not when it merely reports its own. That is a single
deployment, not a normal install. If you have never set `TELEMETRY_COLLECTOR`, 1.9.35 runs correctly
and this release changes nothing for you.

The cause was a reference to the database resolved when the file loaded rather than when the request
arrived, in code that had been moved earlier in the same release.

### Changed — the startup check now covers configuration only one deployment uses

The fault above shipped through a full test suite and every CI job green, because the affected block
is switched on by configuration that no test set. It had never executed anywhere except the one
server that turns it on.

The startup smoke check now boots with that configuration enabled and confirms the routes it adds
actually answer. Code that only one deployment runs is exactly the code an automated check has to
exercise, and it now does.

### Upgrading

No migrations, no configuration changes, and no dependency changes from 1.9.35 — this release only
alters when one value is read. Upgrading from 1.9.34 or earlier, the 1.9.35 note still applies:
`npm ci --omit=dev` is required in both directions, which `scripts/upgrade.sh` already runs.

## 1.9.35

A maintenance release. Two faults where the product was working correctly and still looked broken to
whoever was standing in front of the screen, plus the dependency advisories that could reach a running
server.

No migrations and no configuration changes. See the upgrade note at the end of this entry.

### Fixed — a player could get stuck on an update it was never able to install

A staged update is saved under a filename built from the version the server advertised. If a server
advertised one version while still serving the file for an older one, the player saved the old file
under the new name — and from then on found it, verified its signature, accepted it, and installed
something that changed nothing. The version never moved, so the same update was offered again, and the
player retried the same no-op until it hit its attempt limit.

The signature check passed the whole time, correctly: the file was genuine, it was simply the wrong
one. Worse, fixing the server did not help, because the bad file was reused before anything was
downloaded. Recovery meant deleting the file on the device by hand.

A staged update is now reused only when the version inside the file matches the version being
installed, and a fresh download is checked the same way before it is applied. A server serving the
wrong file now says so — *"server served 1.9.33 but advertised 1.9.34 — the update on the server is
stale"* — and the file is deleted instead of kept. That makes this self-healing: once the server is
corrected, the player recovers on its own.

**Clear update cache** on the device page discards every staged update on a player. The version check
should make it rarely necessary; it exists because a player already holding a bad file predates this
release and cannot benefit from the check, and because the alternative is a cable and a laptop.

### Fixed — directory search showed the system keyboard on top of its own

The directory-search widget draws its own on-screen keyboard, sized and themed to the panel and on by
default. On Android it was never visible. The page puts the cursor in a real text field, which is the
signal for the device to raise its system keyboard — over the bottom of the screen, exactly where the
widget's keyboard is.

So a wall-mounted directory showed the phone keyboard: split across the screen, with microphone, GIF,
emoji and a settings key that opens the keyboard vendor's own interface on a kiosk. On one panel the
only keyboard installed was voice input, so touching the search box opened a microphone. The widget's
own keyboard had been underneath the whole time.

When the widget draws a keyboard, it now tells the device not to raise one. Turn the built-in keyboard
off and the system keyboard behaves as before — with nothing to cover, it is the only way left to type.

### Changed — the dependency advisories that could reach a running server are cleared

Every high-severity advisory affecting a production install is resolved, including eight in the mail
library covering SMTP command injection and header injection. The remaining advisories are in
development-only tooling that is not installed on a server and cannot be reached from one.

The real-time connection to players is deliberately untouched: the fix there was a patch to the message
parser with no change to the format players speak, so nothing about an existing player's connection
changes.

Sending mail was previously covered only by tests that substituted the mail library for a stand-in,
which would have stayed green through any change in the library itself. It is now also tested against
the real one.

### Added — an install that collects statistics can show the total on its landing page

Where install statistics are being collected, the landing page can show how many screens have been
deployed in total. It is an aggregate across every install that chooses to report, so it says nothing
about any single one.

This does nothing on a normal install: the figure is served only where collection is switched on, so a
private server never publishes its own screen count, and the line is hidden entirely rather than
showing a zero.

### Changed — release notes are the written ones

Published release notes now come from this file rather than from a list of commit subjects. The
previous release announced itself as one commit titled "chore(release)" while the entry describing it
sat here unread.

### ⚠️ Upgrading from 1.9.34 reinstalls dependencies

This release changes `server/package.json`, so **`npm ci --omit=dev` is required, not optional** — in
both directions. `scripts/upgrade.sh` already runs it, and the server repairs a missed install at
startup where it can reach the npm registry.

Docker deployments need no action; dependencies are installed inside the image.

## 1.9.34

Single sign-on is the headline, rebuilt rather than extended — because of a vulnerability in what
was there before. Alongside it: the last native image dependency is gone, several players that
could not install updates now can, and an install can optionally report how many screens it runs.

No migrations and no configuration changes. See the upgrade note at the end of this entry.

### Fixed — the old sign-in path could be replayed by any site you had signed into
What shipped as "OAuth" verified almost nothing. It asked whether an **access** token was valid and
then trusted the email address that came back, never asking the only question that matters: *who was
this token issued for?* Any other site a user had signed into — anything holding a token with the
right scope — could replay it against ScreenTinker and receive a session as that user. No password,
no interaction from the victim.

Identity now comes from an **ID token only**, with the signature checked against the provider's
keys and `iss`, `aud`, `azp`, `exp` and `nonce` all verified. One flow for every provider:
Authorization Code with PKCE, completed server-side. Google and Microsoft became ordinary entries
rather than hand-written special cases, which is what removed the two paths that were wrong.

### Added — organizations bring their own single sign-on
Instance-wide providers stay the default and are now unlimited in number. On top of that, an
organization can connect its own identity provider — Entra, Okta, Auth0, Keycloak, anything speaking
OpenID Connect — configured by that organization's own admins in Settings, with no operator
involvement and no restart.

A provider may only assert addresses at domains the organization has **proved it controls**, via a
TXT record at `_screentinker-verify.<domain>`. An unverified claim lapses after eight hours and
releases the domain, so a typo cannot park someone else's domain indefinitely. A domain belongs to
one organization only. Proof by delegated name (CNAME) is refused outright: it would need a wildcard
zone we do not operate, and it would turn a subdomain takeover into an apex takeover.

An organization's provider never appears publicly. The login page reveals it only after someone
enters an address at a verified domain, so a guessed domain cannot confirm who your customers are.

**Require single sign-on** is available per organization: passwords refused, other providers
refused, the instance's own Google and Microsoft buttons refused — otherwise "requires SSO" would
just be renaming the bypass. Turning it *off* again needs a platform administrator to approve the
request, so one compromised org admin cannot quietly reopen password login. Break-glass for a
platform administrator is the correct password and nothing else, and a wrong password returns the
same refusal everyone else gets, so it cannot be used to discover whether an account exists.

⚠️ **Enabling it clears the passwords** of members at verified domains. That is not reversible
without a reset.

Entra sends no `email_verified` claim, which is why a Microsoft provider is trusted on other
grounds: an instance-wide Microsoft entry is pinned to a single directory chosen by the operator,
and an organization's own provider is believed once it has verified a domain — the DNS proof stands
in for the claim, since whoever controls a domain's DNS controls its mail. A provider that has
verified nothing assumes nothing, and an explicit `email_verified: false` is refused from anyone.
Other providers that verify addresses without saying so can opt in with
`OIDC_<SLUG>_ASSUME_EMAIL_VERIFIED=true`.

**With no SSO environment variables set, the product behaves exactly as it did before.**

### Added — an existing account can move to single sign-on
Signing in with a provider has always refused to take over an account that already has a password,
and that refusal is right — otherwise anyone who could persuade a provider to assert your address
would inherit your account. But the way out had never been built, so an account created with a
password simply could not use single sign-on.

**Settings → Sign-in method** now offers it, in both directions. An account has exactly **one**
credential: linking **deletes** the password, and the confirmation says so, because a password left
behind is a second way in that you believe you replaced. Unlinking asks for the new password first
and applies both changes together, so the account is never left without a way in.

The account being linked is the one you are **signed in as**, never whichever account matches the
address the provider returns — that is what separates linking from the takeover the login page
refuses. Only providers configured on this server can be linked; an organization's own provider
cannot attach itself to an account.

### Changed — the login page asks who you are before how you sign in
The password box appears once you have entered your address and continued, rather than sitting there
from the start. That is what lets the page check whether your organization uses single sign-on
*before* offering you a credential, so someone whose company requires it is shown that rather than a
password box that was always going to be refused. Correcting your address takes you back a step.

The address is no longer looked up on every keystroke — it answered for half-finished domains,
changed the form under you mid-address, and could exhaust a shared office network's lookup budget
before anyone had tried to sign in. The instance's own provider buttons stay visible throughout, so
the page no longer changes shape while you type.

Setup instructions for both operators and organization admins are in
[docs/sso-setup.md](docs/sso-setup.md), written from configuring real Google and Entra applications
— including the one that catches everyone: the Microsoft tenant setting names the directory that
*authenticates the user*, which for personal accounts is not the directory the application is
registered in.

### Changed — image processing no longer needs a native library
Thumbnails and image measurement are now pure JavaScript, with WebAssembly decoders for webp and
avif, running on a worker thread. Nothing in the image path is a compiled binary any more, and
`better-sqlite3` is the only native module left.

A native module needs a prebuilt binary matching both the platform and the Node version; when there
isn't one the server fails at load with an error that reads like database corruption rather than a
missing image library. That class of failure is gone from this half of the product.

Format support is unchanged in practice: jpeg, png, gif, tiff and bmp decode directly, webp and avif
through WebAssembly. `.heic` still produces no thumbnail — it never did, because the image library
in use decodes AV1 but refuses HEVC.

Decoding moved off the main thread deliberately. Pure JavaScript costs about a second for a
12-megapixel photo, which in-process would stall everything else — and the thumbnail backfill walks
an entire library at startup, which is exactly how a maintenance task turns into missed heartbeats
and players marked offline. Thumbnailing is slower in wall-clock terms and no longer competes with
serving requests.

### Fixed — players that could not install an update
Three separate faults, each able to strand a player on an old version.

**Updates were written to external storage.** Where that location is absent, or exists but cannot be
written to, the download failed the instant it began — before any data arrived — and reported only
that it had failed to download or verify. The same player could be caching content perfectly well
throughout, because content goes to internal storage. Updates now go to the first location that
genuinely accepts them, starting with internal storage, and each candidate is tested by *writing to
it* rather than by asking whether it is writable — the previous check asked, was told yes, and the
write failed anyway.

**Prerelease versions were ordered as text**, so a build numbered 10 or higher sorted below one
numbered 8 or 9. A player on such a build was told it was already up to date and could not be moved
forward, while the server named the newer build as latest in the same reply. Numbers in version
names are now compared as numbers. The BrightSign host package carried the same comparison and is
fixed with it — there, a wrong answer replaces the script that starts the player.

**A readable update was refused on Android 9 and 10**, where a downloaded file's signing certificate
comes from a legacy path that can return nothing. The player now reads the signature itself before
giving up. Verification is unchanged: the certificate is still compared against the installed app,
and anything unsigned, tampered with, or signed by a different key is still rejected.

A failed update now also says which of those things went wrong, instead of one message covering
every possible cause.

⚠️ **A player already stuck cannot be rescued by this release**, because the broken path is how
updates arrive and the "Push an APK" button used it too. Such a player needs one update installed by
hand, after which it recovers on its own and stays fixed.

### Fixed — the Android player could leave a band down one edge of the screen
A panel would sometimes not fill its display, leaving a bar the exact size of the hidden system bar.
It was intermittent because it depended on whether the app was measured before or after the system
UI was hidden — the same screen could come up correct after a reboot and wrong after an app restart.
The stage is now measured from the current window and re-measured when focus changes.

Reported on an RK356x Android box, where it was compounded by an unrelated HDMI mode problem;
pinning the output resolution fixed the corruption, and this fixes the band that remained.

### Added — opt-in install statistics
ScreenTinker cannot see how widely it is deployed, because self-hosted installs are private by
design and should stay that way. A platform administrator is asked, once, whether this install will
share how many screens it runs.

The whole payload is three fields — a random instance ID, the version, and the screen count — and
nothing else: no hostnames, addresses, organization or user names, device names, content or
configuration. Settings shows the **actual payload this server would send**, generated live from its
own data, alongside what it last really sent and when, so the claim can be checked rather than taken
on trust. Turning it on reports immediately, and a blocked outbound connection is named along with
the address to allow, rather than failing silently.

Off until enabled, and both answers are remembered — declining is permanent, so the prompt does not
return after an update. `TELEMETRY_EXTRA_ENDPOINT` posts the same three fields to a collector you
run; it is **additional, not a redirect**, and independent of the sharing switch, so an operator who
wants their own numbers and nothing sent to us can set it and leave sharing off.

The random ID exists only so repeat reports from one server count as one server, which makes a
report pseudonymous rather than anonymous — the wording says so plainly. Because sharing is opt-in,
any total published from it is a floor, never an estimate of the install base. Full detail in
[docs/telemetry.md](docs/telemetry.md).

### Added — organizations may re-enable same-origin widgets, deliberately
Widget isolation removed `allow-same-origin`, which also broke embedding for sites that enforce
strict CORS. There is now an organization-level switch to put it back, behind a modal requiring a
typed acknowledgement, with a persistent banner while it is on. It needs an organization owner or
admin — a workspace admin is deliberately not enough — and the change is written to the activity
log. Contributed by @ChrisChrome.

The widget editor's **Preview is excluded** from that switch. Preview renders inside the dashboard
where the admin's session token lives, so honouring the setting there would let anyone who can
author a widget lift the session of whichever admin clicked Preview. The setting exists so
*displays* can embed origin-strict sites; a display holds a device token, an admin's browser does
not.

### Fixed — RSS tickers ran at a speed that depended on how much news there was
Scroll speed set a fixed total time for the whole strip to cross the screen regardless of length, so
a feed with twenty items was dragged past in the same seconds as a feed with one — too fast to read,
and it appeared to jump back to the start. It now holds a constant rate, so more items simply take
proportionally longer and every item scrolls fully into and out of view. Contributed by @ChrisChrome.

### Fixed — user-controlled text is escaped where it reaches the page
An audit pass over the frontend's HTML sinks, escaping the ones that receive user-controlled data.
Also here: dashboard banners no longer overlap the sidebar, shift the layout, or vanish when
switching views, and the main content no longer collapses to a narrow column.

### Added — an operations runbook
[docs/operations.md](docs/operations.md): how to deploy, verify and roll back an instance in both
shapes it runs in, what to back up first, how to upgrade Node.js safely, and the traps that are only
obvious once they have bitten you — including three from a Raspberry Pi 5 report, two of which are
not Pi-specific. A piped installer cannot really ask you anything, because the pipe is its input and
every prompt takes the default. X11 tools fail silently on Wayland, so screen blanking and cursor
hiding can be entirely absent while appearing configured. And an overlay filesystem protects an SD
card by discarding writes — safe for a player, quietly destructive for a server whose database is
written continuously.

### Changed — `better-sqlite3` pinned to 12.9.0
Preparation for a future Node.js 22 upgrade, landed separately so the runtime and the database
driver can move independently rather than as one flag day.

The pin is **exact on purpose**. 12.9.0 is the last release publishing prebuilt binaries for both
the current and the next Node major; later 12.x releases dropped the older one while still
advertising support for it. A caret range would resolve to one of those and silently turn
installation into a source build. Nothing in the query API changed.

### ⚠️ Upgrading from 1.9.33 reinstalls dependencies
This release changes `server/package.json`, so **`npm ci --omit=dev` is required, not optional** —
in both directions.

- **Upgrading**: `scripts/upgrade.sh` already runs it, and the server repairs a missed install at
  startup where it can reach the npm registry.
- **Rolling back past this release**: mandatory. Earlier builds load a native image library at
  runtime that this release removes, so rolling back the code without reinstalling leaves a server
  whose image ingest cannot load its decoder.

Docker deployments need no action either way; dependencies are installed inside the image.

### Known limitations
Deliberately unresolved, and worth knowing:

- Requiring single sign-on **clears the passwords** of members at verified domains, irreversibly
  without a reset.
- Turning that requirement back off depends on a platform administrator approving the request; if
  nobody does, the organization stays on single sign-on.
- `landing.html` still interpolates plan names into HTML without escaping. Those values come from
  the plans table rather than from end users, so it is a loose end rather than an exposure.
- `/api/provision` is limited to 5 requests per minute, so a twenty-display install day involves
  some waiting. Pre-existing and unchanged by this release.

### Thanks
This release — and a good deal of what came before it — exists because people outside the project
reported problems and sent patches. Credit was recorded inconsistently at the time, so it is
collected here rather than left scattered.

**Code contributed**

- **@ChrisChrome** — the organization-level widget sandbox toggle (#254) and the RSS ticker rate fix,
  both in this release. Earlier: the Debian player/server install script (#137) and web player
  auto-connect (#6).
- **@BlazzzPlay** — eight merged pull requests across 1.9.4 to 1.9.13: server-side preview sessions
  to work around CSP (#151), the Android hidden settings menu (#152), sending device identity on
  reconnect before pairing (#164), the dashboard version indicator and update check (#165, #181),
  authenticated thumbnail loading (#182), the server URL in the Add Display modal and the Releases
  link on the APK download page (#210), and uploads respecting the current folder (#211).
- **@a10kiloham** — boot-time thumbnail healing with ffmpeg diagnostics and packaging (#244), the
  screenshot-request verdict toast and the reverse-proxy header pitfall it documented (#243), and a
  configurable maximum upload size (#233).
- **@albanobattistella** — the Italian translation, and its updates since (#2, #145, #232).

**Reported**

- **@carloblu74** — the Raspberry Pi 5 report behind #245, which found five defects in the installer
  and kiosk launcher that nothing in this repository would have caught, because nothing here had ever
  executed those scripts on a Pi. The runbook notes above come from it.
- **@bold-media-group** — by a wide margin the largest source of field reports, across roughly fifty
  issues: the OTA rollout and version-advertising problems, event-loop lag under long uptime, video
  wall behaviour, Tizen playback regressions, and the content-loading failures that led to resumable
  downloads.
- **@Smiley-k**, **@Semetra22**, **@patrickfinardi09**, **@hapishyguy**, **@Nikhil12656**,
  **@gittyguy92** and **@Obe-BoldMediaGroup** — bug reports and feature requests across the 1.9.x
  line, including SMTP transport, playlist item scheduling, and the Android playlist-order fault
  behind #234.

Several of the hardest faults this year were found by someone running the product on hardware the
project does not own. That is worth saying plainly.

## 1.9.33

A patch off 1.9.32. The headline is a boot-time crash that could brick a display permanently — a
player that died on startup, every startup, and could not be recovered by rebooting it. The rest is
the live debug log finally working on the web player, and the playlist-skipping bug that log found
within minutes of being switched on.

### Fixed — a cached playlist could brick a display across reboots
The most serious of these. On startup the player restores its **cached** playlist and renders the
first item immediately. If that item was a video carrying a transition, it read an internal flag
before that flag's declaration had run — which in JavaScript is a *throw*, not an empty value. The
player died during boot.

The loop is what made it fatal rather than annoying: the playlist came from the display's own local
cache, so it never stayed up long enough to receive a corrected one. Every boot re-read the same
cache and died the same way. **Rebooting the player — the one remedy an operator has — did nothing.**
Recovery meant changing the player the server hands out; nothing in the dashboard would have helped.

Found on a BrightSign, but nothing about it was BrightSign-specific: any browser-based display could
have hit it. No customer display was in this state, and the one playlist that mixed video with a
transition happened to start on an image, which was luck rather than protection.

### Fixed — one broken clip could skip several playlist items
A media error scheduled a skip *per error event*, and each new skip orphaned the previous timer
instead of cancelling it, so all of them fired. Four decode errors on one clip meant four advances.
On a single-item playlist that merely replayed the same file, which is why it hid for so long; on a
real playlist it silently dropped the next three items and nothing said why.

One failure now means one skip. A clip that is still playable is no longer discarded on a stray
event, while anything genuinely undecodable is still skipped, so a broken file can never stall a
playlist. Failures also now report the actual media error instead of an anonymous "Video error".

### Added — the live debug log works on browser-based displays
The per-device **Debug logging** checkbox has always sent its command, but only the Android player
ever answered it. The panel opened on every other display and streamed almost nothing.

It now streams what the player has always been recording internally: its own log, uncaught errors
with file and line, failed downloads, and on BrightSign the host's boot report. Switching it on also
**replays what was buffered before you opened it**, timestamped with how long ago each line really
happened — so the failure you came to investigate is already on screen instead of needing to happen
again.

It matters most where there is no alternative: on a signage player there is no console to open and
no cable to attach, and this is the only way to see what the display thinks it is doing.

**Freeze** holds the view still while continuing to buffer underneath, because the moment you freeze
a log is the moment the lines explaining it are still arriving. **Copy** puts the visible capture on
the clipboard, stamped with the display and time, and works on self-hosted dashboards served over
plain HTTP where the browser clipboard API is unavailable. Errors and warnings are now coloured, so
the one line that explains the fault no longer sits in a wall of grey.

### Changed — display controls sit above the status panels
Reboot, screen on/off, launch, force update and shutdown were flush against the status cards, which
read as though they belonged to them.

## 1.9.32

A patch off 1.9.31. The headline is that a BrightSign can finally photograph its own screen; the
rest is a thumbnail library that heals itself, a Raspberry Pi installer that asks the operator
rather than the pipe, IPv6 on the dashboard, and a pairing code you can read from across a room.

### Fixed — a BrightSign can now screenshot itself, video included
That platform has never managed it. Video decodes onto a hardware plane the DOM cannot read, so the
player's in-page canvas composite came back with the content missing, and the panel truthfully but
uselessly reported *"Video is playing on the hardware plane and cannot be captured"* while playing
perfectly.

It now uses **BrightSign's own `@brightsign/screenshot` API**, which composites the video and
graphics layers — exactly the thing a canvas cannot do. The capture is written to RAM rather than
the boot flash: the remote-control view asks for one every second, and a screenshot per second
written to flash wears it out for nothing, since the file is read back and deleted immediately.

Remote control gets it for free — the live view and the screenshot button share one capture path,
so the live view now shows real video instead of a card explaining why it can't.

The long way round is kept as a fallback for firmware without the module, and its own bug is fixed
on the way: the host asked the player's diagnostic web server on a hardcoded port 80, while that
port is configurable and commonly moved (the unit this was found on serves it on 8080 with nothing
on 80 at all). It now reads the port from the registry the server is configured from.

### Fixed — per-item dayparting was silently dead on BrightSign
A BrightSign widget runs with Node integration, which puts `module` into the page's scope. Every
shared module that exported with an `else` therefore took the CommonJS branch and never assigned
its browser global — and every consumer has a silent fallback, so nothing ever complained.

The visible casualty was the transition engine, which is gated on exactly those globals and so
never initialised. The costly one was `schedule-eval`: without it the player falls back to "always
active", so **scheduled content played outside its window** on that platform, with nothing in any
log. Modules now export to both targets.

### Fixed — thumbnails that never appear, and never retry
Thumbnail generation is best-effort by contract, and three gaps made its failures invisible and
permanent: ffmpeg is a system dependency nothing surfaced (and the Docker image did not install
it), a row that missed generation was never retried, and a failed image thumbnail stored a path to
a file that was never written — which the dashboard then requested forever as a broken image.

There is now a `[MEDIA]` startup diagnostic, a once-per-boot backfill that heals old rows, ffmpeg in
the runtime image, and the phantom path is gone. Video probing moved off the synchronous spawn it
had always used: two subprocess calls with a 15-second timeout each, run synchronously, stop the
whole server for their duration — survivable for one human-initiated upload, not for a sweep
walking an entire library unattended.

### Fixed — Raspberry Pi 5 installer (#245)
`curl … | sudo bash` makes stdin the *script*, and bash has consumed it by the time any prompt
runs — so the mode menu answered itself and Player-Only could not be reached through the documented
install at all. Prompts now read the terminal.

Pi 5 on Bookworm defaults to Wayland, where `xset`, `unclutter` and `xrandr` are no-ops that log an
error and do nothing: those Pis had no blanking suppression and no cursor hiding while appearing
configured. The launcher now detects the session and branches. Chromium is told not to ask for a
keyring password no kiosk can answer, and the crash-restore surface that put a white page over the
player on every boot but the first is cleared properly. The login banner also spelled the product
name wrong.

### Added — a display's IPv6 address on the dashboard
The player only ever collected IPv4, so a v6-only panel reported no address at all and the dashboard
showed a dash for a perfectly reachable screen. Both are now reported, in their own fields, because
a dual-stack panel has both and either may be the one you need. Link-local addresses are excluded —
every interface has one and none can be dialled without a zone index.

### Fixed — the pairing code was unreadable on 4K and 8K panels
Every size on the player's setup screens was a hard-coded pixel value. A CSS pixel covers a quarter
of the screen area on a 4K panel that it does on 1080p, and a sixteenth on 8K, so the code that
fills a 1080p screen was a smudge on the wall it was installed on. Sizing is now proportional to the
viewport: identical at 1080p, twice the size at 4K, four times at 8K.

### Fixed — the screenshot button lied when it could not work
The server already answered `offline` or `unsupported`, but no dashboard sender listened, so
clicking Screenshot on an offline display showed "Screenshot requested" and did nothing. The verdict
now surfaces as a toast. Thanks to @a10kiloham for this and for the thumbnail work above.

### Fixed — CI judged the capability baselines against the wrong source
The baselines describe what an un-updated display can do, so they are checked against the shipped
source via a release tag. A shallow checkout has no tags, so the check silently fell back to the
working tree — and a release commit made the newest tag HEAD, flipping every assertion at once.
Both are fixed; the matrix is judged against the previous release.

## 1.9.31

A patch off 1.9.30 carrying the video-wall and playlist-preview work, a QA sweep that drove real
browsers and real panels rather than reading code, and the fix for a loop stall our own maintenance
was inflicting on a customer's fleet every morning.

### Fixed — a wall of portrait panels had to be built backwards (#236)
The wall canvas was secretly framebuffer space, not the wall as you see it. That is invisible while
every panel is the normal way up, and actively misleading the moment one isn't: two portrait-mounted
panels standing side by side had to be **stacked vertically** in the editor, with a pre-rotated copy
of every video, before the output came out right. It worked, but only after trial and error, and it
meant a portrait wall could never reuse existing content.
Each panel now carries a mounting rotation (0/90/180/270), the canvas means the physical wall, and
the player works out the mapping — so side by side is drawn side by side and landscape content plays
across portrait panels unmodified. Applied on the web, Tizen and Android players.
**Existing walls are untouched and need no migration.** Every wall in the field is rotation 0, which
takes the original code path verbatim — an operator who upgrades will not find a wall that was
aligned yesterday has moved. Rebuilding an existing portrait wall the natural way round is an opt-in
change the operator makes when they choose to.
While a display is a member of a wall, its per-panel rotation replaces its own Orientation setting:
the two describe the same physical fact, and honouring both turned the content twice.
### Added — a wall no longer hides its own screens (#235)
Grouping displays into a wall replaced their individual cards, so one dead panel of a four-panel
wall was invisible from the dashboard, and inspecting a single screen meant pulling it out of the
wall (re-syncing the live wall) and putting it back. The wall screen now lists its panels with live
online state and a link straight to each device's page, and the wall card on the dashboard shows a
per-member status chip. A screenshot can be requested per panel without disturbing playback.

### Fixed — the checkpointer was stalling the event loop for seconds at a time (#240)
Reported as loop lag that grew with uptime and reset on restart, with a distinctive signature: mean,
p50, p99 and max identical to two decimal places. That signature is not a fixed cost paid on every
cycle. It is what a `perf_hooks` histogram reports when a window recorded **exactly one** delay —
the mean is the raw value and every percentile returns the bucket ceiling above it. Reproducible
against the reported figures to the decimal (`record(1329070000)` gives mean 1329.07, p50/p99/max
1329.59). So the loop took one long turn that swallowed the whole sampling second, episodically.

The long turn was ours, and it is measured rather than argued. Running the real checkpointer worker
against a real WAL with one reader mid-transaction: a single main-thread write blocked for
**4,936 ms**, and the checkpoint that blocked it reported `WAL 8.8MB -> 8.8MB` — it reclaimed
nothing. `wal_checkpoint(TRUNCATE)` is the blocking form and its locks are held across
*connections*, so moving it to a worker thread in 1.9.2-patch3 took the fsync off the loop but not
the lock. It also does not throw when it cannot get those locks: it returns `busy=1` after sitting
on SQLite's five-second busy timeout. Five seconds of stalled loop for no benefit, reported as a
success.

It was reached far too easily. The rule was "escalate if the WAL grew across three consecutive 15s
runs", which **any sustained 45-second write burst** satisfies — a fleet powering on in the morning
does it daily. Escalation now needs the WAL to be in the upper half of its budget
(`WAL_CHECKPOINT_STARVATION_FLOOR_MB`, default 8) **and** to be outside a cooldown
(`WAL_CHECKPOINT_ESCALATE_COOLDOWN_MS`, default 5 min). Both gates are needed: a size floor alone
does nothing for a server whose WAL already sits above it, which was exactly the reported case.

The 16 MB high-water escalation bypasses both gates and is untouched, so *the WAL still cannot grow
unbounded*. A checkpoint that reclaimed nothing now says so in the log instead of reading like a
success.

Also softened the recovery path: when the checkpointer worker is declared unrecoverable, inline
autocheckpoint is re-armed on the main connection — a state that lasts the life of the process, and
therefore looks exactly like "degrades with uptime, a restart fixes it". It used to also run an
unconditional blocking checkpoint on the main thread on the way in; that now happens only above the
high-water mark, and the fallback state is served on `/api/status` rather than being inferable only
from a log line that may have rolled.

### Added — loop-lag telemetry that can be read correctly (#240)
The reported numbers were interpreted, reasonably, as a per-cycle cost, because nothing in them said
how many samples they were made of. `/api/status` now carries `samples` alongside the percentiles
(around 50 in a healthy second, 1 when a single turn swallowed it), `tick_gap_ms` measured on the
wall clock independently of the histogram, and `worst_tick_gap_ms` / `worst_tick_at` — monotone, so
five-minute polling can no longer miss an episode entirely. The `debug` block adds the checkpointer's
worker, fallback and respawn state.

Band semantics are deliberately unchanged: a one-sample window during a real stall is the correct
trigger for the shed valve, and suppressing it would blind the protection at the moment it is needed.

### Fixed — `device_telemetry` grew forever for any display that stopped reporting
The only trim was a per-device row cap applied on that device's own heartbeat, so a decommissioned,
swapped or seasonally-dark panel left its rows behind permanently. There is now a matching age sweep
(`TELEMETRY_RETENTION_DAYS`, default 30), per-device so it rides the existing index rather than
scanning, chunked and yielding like the status-log sweep. The default matches the uptime report's own
default window, so it cannot remove rows that report would have shown.

### Added — a playlist preview you can skip through (#239)
Reviewing item 8 of a playlist cost seven durations of waiting. The preview takes a skip/next
control.

### Added — a video playlist item defaults to the clip's own length (#237)
Rather than the generic default duration, which had to be corrected by hand for every video.

### Fixed — the dashboard preview of a rotated display (#238)
A display rotated 90°/270° was previewed the way its framebuffer is laid out rather than the way
people see it. It now matches what the wall shows.

### Fixed — three controls that did nothing, and a parity matrix that said otherwise
An audit of all four players against their shipped sources found controls a customer can press today
that change nothing. The volume slider worked on Android only: the dashboard sends
`set_volume { level: 0..1 }`, while the web player read `payload.value` and divided by 100 and Tizen
read `payload.value ?? payload.volume` — three complete, working volume implementations that could
not be driven. Correcting only the key would have been worse than leaving it broken, since
`level: 0.5` would have become 0.5%: the scale is now chosen by which key arrived, not by the
magnitude of the number.

Tizen's offline media cache could never have worked on a panel — its adapter used the deprecated
Filesystem API in three ways the IDL rules out, so `MediaCache.create()` returned null on every panel
in the fleet. BrightSign carried calls that compile and are documented to do something else. Every
fix cites the vendor document that proves it, and the linter now fails on each next time.

Four dashboard→device socket handlers had no capability gate, and a re-register could erase a panel's
recorded platform. The parity matrix and the capability baselines are now tested against the players'
**shipped** sources in both directions, so a baseline that over-claims and a player that gains a
handler without its baseline moving both fail the build.

### Fixed — a fresh panel skipped the first item of its playlist
A newly paired panel always learns its playlist before the media arrives, so the 3-second content
re-check is what really begins playback — and it advanced *past* the index already seeded for a
playlist that had not started. The first pass ran 1, 2, 3, 0, and item 1 appeared only after the list
wrapped. Reproduced on the emulator on every fresh pair.

### Fixed — a rotated wall panel screenshotted as a black rectangle
The mounting rotation introduced with #236 is the first real rotation on an ancestor of the video
surface, and the screenshot compositor pasted the frame with an axis-aligned rectangle — so on a
rotated panel it landed outside the capture bitmap and the dashboard received plain black. A panel
that looks dead while it is playing perfectly is the worst thing a diagnostic can say.

### Fixed — the service worker claimed credit for offline widgets it never sees
`sw.js` said its cache-first widget branch was what kept a widget rendering with the network gone. It
is not: the player mounts
widgets in an iframe sandboxed without `allow-same-origin`, making it an opaque-origin client that a
service worker does not control. Measured, not reasoned — five mounts over 25 seconds of real
playback left zero widget entries in the cache.

### Fixed — CI judged the capability baselines against the wrong source
The baselines describe what an un-updated display can do, so they are checked against the shipped
source via the latest tag. The default shallow checkout has no tags, so the lookup found nothing and
the suite silently fell back to the working tree — where a player's payload bug had just been fixed,
making the build demand a baseline change for displays that cannot possibly have the fix yet. Green
locally, red in CI, for a reason visible nowhere in the diff. The test job now fetches tags, and the
bidirectional assertions skip rather than invert when there are none.

## 1.9.30

A patch off 1.9.29 carrying two fixes for faults that are live and silent. Both were found by a QA
pass driving real browsers rather than by reading code, and both fail in the direction that leaves a
screen dark with nothing in any log.

### Fixed — a missing media file answered 200 with the dashboard, cached for a month
`express.static` calls `next()` on a miss and the only thing downstream was the SPA catch-all, so
`GET /uploads/content/<gone>.mp4` returned **200 OK, `Content-Type: text/html`**, 15KB of
`index.html`, under the `public, max-age=2592000, immutable` header the mount had already set on the
way in.

For a player that is the worst possible answer. Every downloader in this product treats 200 as
success, so a panel stores the HTML page **as the video**, caches it for a month, and renders a black
frame. Android's cache validates the byte COUNT against `Content-Length`, not the content type, so a
correctly-sized page passes the integrity check and is promoted as a valid asset.

It is reachable exactly when it hurts: a content replace writes a new randomly-named file and unlinks
the old one, so any snapshot still pointing at the old name asks for a file that is gone. A miss now
terminates in a 404 with no cache header — `immutable` is a promise about a file that exists.

### Fixed — an empty playlist wiped a display's entire offline library
The player asks the service worker to hold its current media and to drop anything else. An empty list
was honoured as "drop everything" — and `assignments: []` is what the server sends for a device
between playlists, for a playlist never published, and from inside the `catch` when a stored snapshot
fails to parse. Reproduced: three cached assets, one empty payload, cache emptied.

That is only survivable while the uplink is up, which is precisely when the offline cache does not
matter. A cache kept too long costs disk the quota reclaims anyway; one dropped at the wrong moment
is a dark screen with no way back. An empty list is no longer a prune instruction.

## 1.9.29

The release candidates 1.9.29-rc1 through rc5 are folded in here; the entries below record what
changed since 1.9.28 in the form it actually ships. Two of these were found only by driving real
hardware and a real browser, and neither could have been caught by a test in this repo.

### Fixed — the web player's offline cache was switched off at the URL everyone uses
A service worker's default scope is its own directory, so `/player/sw.js` could only control
`/player/` **and below** — which does not include `/player` itself, the URL the dashboard shows and
the one panels are configured with. Registration succeeded, logged success, and then controlled
nothing: no shell cache, no content cache, no offline playback, and no error to notice.

### Fixed — screens went black on a bad link instead of playing cached content
The offline playback path was never the problem: the cache could never be **filled**. Every download
began at byte 0 and the partial was discarded on any interruption, so an asset larger than one
uninterrupted transfer was re-fetched forever. Downloads now resume, with `If-Range` and a 416 guard
so a changed or over-long asset can never be spliced.

### Added — every player caches media for offline playback
Tizen caches the media itself now, not just the playlist; the web player (and BrightSign) accumulate
in resumable chunks driven by the playlist rather than by playback. Content carries a revision, so
replacing an asset reaches displays that already hold the old bytes — previously it could not, ever.

### Added — players declare what they can actually do
Each player reports its real capabilities at registration and the dashboard stops offering controls
that cannot work. A display that declares nothing keeps its per-platform baseline, so nothing in the
field loses controls on upgrade.

### Fixed — the BrightSign host scripts were written against Roku's API reference
BrightScript is Roku's language and the two references read alike, so calls to objects that do not
exist looked exactly like calls to ones that do. A string literal that stopped the script compiling,
an existence check that could never return true, and a self-update path that could never mark a
package applied — all corrected, and guarded by a checker, since nothing in CI can run BrightScript.

## 1.9.29-rc5

### Fixed — the BrightSign host scripts were written against Roku's API reference
BrightScript is Roku's language, the two references read almost identically, and nothing in CI can
run either — so a call to an object that does not exist looked exactly like a call to one that does.
Found by auditing against BrightSign's published reference after a consultant's deployment failed,
and verified on an XT245.

- **A string literal stopped the whole script loading.** `"{""width"":"` is not an escaped quote;
  BrightScript has no escape sequences, so it is three adjacent literals with no operator between
  them. The compiler rejects the entire file — `ScriptLoadError: Syntax Error (compile error &h02)`
  — which is not a broken feature but **no player at all**, on a display showing nothing.
- **`MatchFiles` was called with a path as both arguments.** It takes a DIRECTORY plus a pattern and
  returns nothing when the pattern contains a separator, so the existence check could never return
  true for any file on any player. That is the reported failure: `no autorun.zip on any volume`
  printed while `dir SD:` listed it. It also silently disabled the entire self-update path.
- **Roku objects that do not exist on BrightSign**, each quietly disabling a feature: `roFileSystem`
  (~20 sites — an update could never be marked applied), `roMessageDigest` (verification returned
  false unconditionally and burned the retry counter), `PostFromStringWithRetry` (a snapshot request
  raised "member function not found" from inside the event loop and took the player down).
- **`Unpack()` deletes everything already in its target directory.** Unpacking an update to the
  volume root would have erased the player's provisioning and its whole content pool as a side
  effect of a routine upgrade. It now stages to a directory of its own and never overwrites
  `screentinker.json`.
- Rotation moves to `SetScreenModes()` (`SetMode()` takes one argument) and fires only on a real
  change, because that call reboots the player.

`server/test/brightscript-api-surface.test.js` guards all of it — a deny-list of Roku APIs plus the
argument shapes and literal forms that compile and then do nothing.

### Fixed — a player that could not cache was telling the fleet it could
A real BrightSign exposes `navigator.serviceWorker`, passes an `'serviceWorker' in navigator` check,
and then never even fetches the worker: its runtime refuses to register one. It advertised
`offline.cache` while unable to cache a byte. The capability is now claimed only when a worker is
genuinely in control, and a refused registration reports itself to the server instead of a
`console.warn` on a display nobody has a console for.

### Fixed — storage paths assumed a card slot that may not exist
`StorageRoot()` knew only internal flash and SD. Fitting real storage to a flash-booting player and
moving the deployment onto it resolved every derived path — the offline page, the widget's local
storage, the update paths — to a slot with nothing in it. It now probes in the order the OS itself
searches for an autorun script. The widget's `storage_path` is likewise an absolute path on the boot
volume rather than a bare `/cache`, which carried no drive specifier and so had nowhere to persist.

## 1.9.29-rc4

### Fixed — the web player's offline cache was switched off at the URL everyone uses
A service worker's default scope is its own directory, so `/player/sw.js` could only ever control
`/player/` **and below** — which does not include `/player` itself. The player is served at all
three of `/player`, `/player/` and `/player/index.html`, and `/player` is the one that gets used: it
is what the dashboard shows and what gets typed into a panel. On that URL registration *succeeded*,
logged "Service Worker registered", and then controlled nothing at all: no shell cache, no content
cache, no offline playback, and no error to notice.

Registration now asks for scope `/`, and the server sends `Service-Worker-Allowed` to permit it.
Both halves are load-bearing — without the header the registration does not narrow, it fails
outright. Found by driving a real browser at the player; no unit test could have seen it, because
the bug lived entirely in the relationship between a URL and a header.

### Fixed — screens went black on a bad link instead of playing cached content
Reported from a one-bar 5G site. The offline playback path was never the problem: the cache could
never be **filled**. Every download attempt started at byte 0 and the partial was deleted on any
interruption, so an asset larger than one uninterrupted transfer was discarded and re-fetched
forever — minutes of progress thrown away, back off, repeat. With nothing cached, the player showed
its waiting state, which from across a room reads as a black screen.

Downloads now resume: an interrupted transfer keeps its partial and asks for the rest with `Range`.
Two ways that could corrupt a cache, both closed — `If-Range` makes a changed asset come back as a
full body (restart) rather than a spliceable tail, and a partial longer than the asset is discarded
on a 416. Bytes are kept only where they can be built upon: with no validator there is no safe
resume, so the partial is dropped and the attempt backs off as the failure it is.

### Added — every player now caches media for offline playback
- **Tizen** cached nothing but the playlist, so a panel came back from a reboot knowing exactly what
  to show and fetched every frame of it from a server that was not there. It now caches the media
  itself to `wgt-private`, resumable, with the transfer asynchronous so a stalled chunk cannot
  freeze the player. `offline.cache` is declared at runtime rather than assumed: a build with no
  writable private storage still says nothing.
- **The web player** (and BrightSign, which runs it) stored only what a single `fetch()` happened to
  complete — nothing at all on a marginal link. It now accumulates in resumable chunks, driven by
  the player's playlist rather than by playback, so the prefetch does not compete with the video on
  screen for the same scarce bandwidth.

### Fixed — replacing an asset could never reach a screen that had already cached it
`PUT /api/content/:id/replace` changes an asset's bytes under a stable id, and every player caches
by that id — so the new bytes could not reach a panel that already held the old ones. Not "until the
next refresh": never. Content now carries a revision, stamped onto each item at send time, and every
player keys its cache on it. The same send-time refresh fixes a second bug: a replace writes a new
randomly-named file and unlinks the old one, so the filepath baked into a published playlist
snapshot pointed at a **deleted** file, and web panels 404'd on that item until somebody thought to
republish. The route now also pushes to affected devices, which it never did.

Superseded copies are reclaimed rather than left for the quota: the player declares the complete set
of media it needs and the worker drops everything else.

### Added — capability declaration across all four players
Each player declares what it can actually do at registration, and the dashboard stops offering
controls that cannot work on that hardware. An absent declaration falls back to a per-platform
baseline, so the displays already in the field keep their controls rather than losing them the
moment this ships.

## 1.9.29-rc3

### Fixed — autorun.zip could not be opened by a player
Reported from a real automated deployment: the rc2 archive reached the player and was rejected as
invalid. Two causes, both ours.

- **The archive must be STORED, not compressed.** The player bootstrap extracts `autozip.brs` by
  itself before any script runs, and `roBrightPackage` supports a specific set of methods, of which
  "no compression" is the universally safe one. Both builders now store — and the server-side
  package builder had been using maximum deflate, so **every self-update package it produced would
  have failed the same way**, silently and in the field.
- **`roBrightPackage`, not `roUnzip`**, is the supported reader. Converted in `autozip.brs` and in
  the self-update path.

Both builders now assert the property instead of trusting the flag: the build script refuses a
compressed member, and a test walks the archive's local file headers. A compressed package uploads,
downloads and deploys perfectly and only then fails to open, which reads as a broken deployment
rather than a broken zip.

`autozip.brs` also adopts the shipped volume-discovery pattern — probe `USB1:`/`SD:`/`SSD:`/`FLASH:`
for the archive rather than guessing, since a player may boot from internal flash.

### Fixed — muting never reached a YouTube item
A YouTube item is a cross-origin iframe, so `el.muted` reaches nothing. The two browser-family
players failed in opposite directions: the web player consulted autoplay policy and nothing else, so
an item muted in the admin console **played with sound** and a wall follower blared alongside its
leader; Tizen hardcoded `mute=1`, so YouTube there was **permanently silent** and no toggle could
change it. Android was already correct. The rule now lives once in `server/lib/media-mute.js`, and
the unmute prompt no longer appears on an item an operator deliberately muted.

### Fixed — screenshots reported success while sending blank frames
Capture marked itself successful because the draw did not throw. On a hardware plane
`drawImage(video)` returns a fully transparent image and throws nothing, so the dashboard showed a
dead screen while the panel played perfectly. Capture is now proven by an alpha probe, so a genuine
fade-to-black still reads as captured.

### Added
- **BrightSign native synchronisation**, wired end to end and chosen per group, reusing the existing
  leader election. A group whose leader is offline falls back to the clock protocol rather than
  waiting for an announcement that never comes.
- **Real telemetry and hardware identity** — temperature, player storage, model, OS version, serial
  and output index — instead of a block of nulls and a `wifi_ssid` of "Web Player" on a PoE
  appliance.
- **Offline content caching** with correct range-request handling, and a **package self-update**
  whose version is stamped into `autorun.brs` at build time — unstamped, a player applies an update,
  still reports the old version, and is offered it forever.
- **Command parity**: real `reboot`, real display blanking, and `set_volume` on BrightSign.

### Removed
- The `user_agent` fallback in BrightSign detection. `devices` has no such column, so the branch was
  unreachable and passed only in a test that fabricated the field.

## 1.9.29-rc2

Fixes for three things rc1 only revealed once it was deployed and pointed at real hardware.

### Fixed
- **The player assets 404'd in a container.** `/player/st-bridge.js` and `/player/st-sync.js` are
  served from `../brightsign` so the copy the player loads can never drift from the copy on the
  player's own storage — but the Dockerfile never copied that directory into the image, so both
  routes worked from a dev checkout and failed in Docker. Note how this fails when the route is
  absent entirely: the SPA fallback answers **200 with `text/html`**, so the browser gets a page
  where it expected JavaScript and the bridge silently never exists.
- **A BrightSign kept re-pairing on every boot.** The bridge persisted `device_id` but not
  `device_token`. The server authenticates a claim to an existing display with the token, so an id
  presented without one reads as a brand-new player and gets a fresh device row.
- **A BrightSign was labelled "Web Player".** It runs the same web player, so `client_type` is
  `player` and the device view fell through to a hardcoded label — indistinguishable from a
  browser tab, for a dedicated signage appliance.

### Added
- **`autorun.zip` — a single-file player installer**, attached to every release and built by
  `scripts/build-autorun-zip.sh`. Drop it on the root of a player's storage and power-cycle.
- **Booting from internal flash.** A player runs `FLASH:/autorun.brs` with no card present at all,
  so a failed card slot no longer ends a player's life. Confirmed on an XT245 with a physically
  dead microSD interface.

## 1.9.29-rc1

**BrightSign port.** The player on BrightSign is the ordinary web player running in an
`roHtmlWidget` — that part already worked. This release adds the host around it, which covers what a
page cannot do for itself, and a per-group choice of synchronisation protocol.

Release candidate: cut for testing on alpha, not for production fleets.

### Added
- **`brightsign/autorun.brs` — a supervised host, not a URL wrapper.** It owns the widget lifecycle,
  because a page-initiated `location.reload()` does not reliably bring an `roHtmlWidget` back: a
  deploy on 2026-07-28 reloaded every connected player and the BrightSign was the only one that never
  returned. The page now posts `{type:"restart"}` and the host rebuilds the widget. It also retries
  `load-error` with backoff, falls back to a local page, and runs a heartbeat watchdog that catches a
  page which loaded fine and then wedged — the case `load-error` never reports.
- **`brightsign/st-bridge.js` — the page's half of that contract**, over `@brightsign/messageport`.
  Registry-backed identity (the registry outlives `localStorage` on this platform),
  restart-instead-of-reload, heartbeat, and sync-backend reporting. Every method degrades to a no-op
  off-platform, so it is served to every player rather than gated on a user agent.
- **`brightsign/st-sync.js` — native SyncManager support.** Frame-accurate video sync between
  BrightSign players via `setSyncParams` on the standard `<video>` element.
- **`server/lib/sync-backend.js` — whose protocol a group runs.** `auto` picks BrightSign's native
  sync when every member is a BrightSign and ours otherwise. Native sync selected for a mixed group,
  or for players on different subnets, downgrades and reports why: BrightWall is multicast and
  cannot cross networks, and a half-synced group looks perfectly healthy on the dashboard while one
  panel drifts alone.
- **Boot from internal flash.** A player will run `FLASH:/autorun.brs` with no card present at all,
  confirmed on an XT245 whose microSD interface is physically dead. `StorageRoot()` probes for it and
  falls back to `SD:`, so a failed card slot no longer ends a player's life.

### Changed
- The web player restarts through a single `restartPlayer()` path instead of four separate
  `location.reload()` call sites. Off BrightSign the behaviour is unchanged.
- Storage keys carry a per-output suffix so a dual-output player's two widgets, which share an origin
  and one `localStorage`, cannot collapse into a single device row.

## 1.9.28

**Platform-wide QA sweep — 25 fixes.** Findings from an audit of the Android player, the browser and
Tizen players, and the server and dashboard, plus the issues a customer reported on #234 while
testing. Several are data-loss or isolation defects reachable by an ordinary user doing an ordinary
thing.

### Fixed — data loss and isolation
- **Saving a layout no longer destroys zone bindings and schedules.** Zones were deleted and
  re-inserted with the same ids, on the assumption that reusing an id preserved what pointed at
  them. It does not: SQLite runs referential actions on the DELETE, so every multi-zone playlist item
  was un-assigned (`ON DELETE SET NULL`) and every zone-bound schedule was permanently deleted
  (`ON DELETE CASCADE`). Nudging one zone by a pixel did this, and returned 200. Zones are now
  diffed; only genuinely removed zones are deleted, where those cascades are correct.
- **Schedules that outlive a deleted device group keep their workspace.** The conversion INSERT
  omitted `workspace_id`, so converted rows were invisible in the list and calendar, undeletable
  (403), and still fired every 60 seconds. A boot migration repairs rows already orphaned.
- **A saved device snapshot only applies inside the workspace it was taken in.** The lookup keyed on
  the hardware fingerprint alone, so a panel deleted from one workspace and paired into another
  inherited the first workspace's playlist and blocked flag.
- **Overlay pushes are held to the same write check as every other fleet action.** The three PiP
  routes carried only a token-scope check, which is a deliberate pass-through for dashboard sessions.
- **A schedule's zone is checked against the caller's workspace** — the one polymorphic reference
  missing from the existing validation.
- **Relayed playback progress is stamped with the authenticated device**, rather than trusting the
  id in the payload.

### Fixed — Android
- **Per-item scheduling works on Android 7.** `java.time` is API 26 and `minSdk` is 24 with no core
  library desugaring, so dayparting threw `NoClassDefFoundError` — an Error, which sailed past the
  deliberate fail-open guard, aborted the playlist update before content downloaded and then cleared
  the cache. Those panels sat on "waiting for content" and a reboot did not help. Verified on a real
  API 24 image.
- **A slow image decode can no longer strand a screen.** A remote image that finished after the
  playlist moved on mounted itself over the current item and called `exoPlayer.stop()`, landing in
  `STATE_IDLE` where no advance is ever scheduled.
- **The playlist and OTA checker stop when the Activity is destroyed.** Both kept running on the main
  looper, so every relaunch left a second controller reporting playback — inflating Reports — and
  another OTA checker whose install receiver was never unregistered.
- **A server rejection is handled once**, and a transient reclaim-settle hold no longer wipes the
  offline cache and jumps to pairing. Two handlers were assigned to the same callback; the later
  silently replaced the one that surfaces the server's reason.
- **Widget edits reach multi-zone layouts**, and a zone whose video fails recovers instead of going
  black permanently.

### Fixed — players
- **The web player notices layout and zone changes.** Editing zones or moving an item between them
  was judged "unchanged" and never reached the screen — the same defect fixed on Android, still live
  on web. Tizen already handled it.
- **Replacing the only item of a one-item playlist works.** The change was deferred until "the next
  advance", but single-item rendering deliberately never advances, so the old content played forever.
- **Leaving a sync group or a video wall re-renders** instead of freezing on the current clip.
- **A group-synced screen shows the idle card** when every daypart has closed, instead of looping the
  last in-window item out of hours.
- **The suspended-account card no longer breaks the player.** It replaced the status overlay,
  destroying an element every later status update wrote to — so the player reported itself crashed
  every few minutes and could be stranded on a stale card with no retry timer.
- **A zone video that fails now recovers** on web as well as Android.

### Fixed — dashboard and content
- **Editing a content item no longer rewrites types the dropdown cannot represent.** Opening a
  YouTube item and pressing Save turned it into an MP4 — a dead slide on every screen, and
  unrecoverable from the dialog.
- **Hand-written text widgets render at the size they were written.** Every `px` font size was
  converted to `vw` to rescue legacy designer output, including markup people typed themselves:
  `font-size:16px` became 2.8px on a 1080p screen.
- **Text taller than the screen is no longer silently clipped** — a text widget can now shrink to
  fit, scroll, or clip, defaulting to shrink (a no-op when the content already fits).
- **Eight dashboard views stop reporting success for refused requests.** Their local fetch helpers
  resolved on any status, so a 403 showed a success toast and the UI kept displaying a value the
  server had rejected.
- **Deleting a playlist tells the screens showing it**, rather than leaving the content up.
- **The onboarding checklist no longer counts a field no player reads**, which told operators
  "content assigned" while the screen showed "waiting for content".
- **An empty `device_info` no longer wipes 17 device columns.** The browser player's refresh-register
  sends `{}` every five minutes, and a blind full-row overwrite nulled version, resolution, OTA state
  and capability flags — degrading exactly the client family that cannot be inspected any other way.

### Fixed — scheduling
- **The calendar draws a recurring schedule on every day it actually fires.** A Mon-Fri rule drew as
  Mondays only, or as nothing at all if it had been created on a weekend, and a schedule started more
  than a year ago drew nothing — while the engine ran all of them correctly the whole time.
- **A recurring schedule respects its start and end dates.** The engine compared weekday and time
  only, so a campaign set to finish weeks ago kept running. ⚠️ This changes live behaviour: any
  recurring schedule past its end date will stop.
- **A content-only schedule now puts that content on the screen.** `content_id` was stored, validated
  and read by nothing, while the calendar drew a block labelled with the filename as confirmation. It
  now gets a playlist holding that item.

### Added
- **Per-display pre-release channel.** Publish `ScreenTinker-beta.apk` with a declared version
  alongside the stable APK and send it only to displays you choose; untick to move a display back.
  See the README.

## 1.9.27

**A real pre-release channel: publish a second APK and choose which displays get it.**
1.9.26 added a per-display opt-in, but it was passive — it stopped a sideloaded test build being
reverted, while the build itself still had to be installed by hand on every display. This makes the
opt-in mean something the server can act on.

### Added — beta channel
- **A second APK slot.** Put `ScreenTinker-beta.apk` beside the stable one and it is served only to
  displays with **Accept pre-release builds** ticked. Everyone else continues to get the stable APK,
  unchanged.
- **The beta build must declare its version**, in a sidecar `ScreenTinker-beta.apk.version` holding
  just the version (e.g. `1.9.27-rc1`). This is not optional and it fails closed: a beta with no
  declared version — or an unparseable one — does not activate the channel at all, and opted-in
  displays keep getting stable. The server cannot infer it (stable's version is the server's own
  constant because the two ship together, and reading it from the APK means parsing binary
  `AndroidManifest.xml` on the request path), and advertising a version that does not match the
  bytes served is exactly the condition that produces an update loop.
- **The check and the download resolve the channel identically**, and fall back to stable
  identically, so `apk_size` always describes the bytes actually delivered. An unrecognised channel
  serves stable rather than failing.
- **No player update is required.** The client already fetches whatever `download_url` the server
  hands back, so displays already in the field can be moved between channels from the dashboard.

### Fixed — switching back off a beta
- **Unticking the box now actually moves the display.** Stable is semver-*older* than the beta it
  replaces, so the ordinary "never offer a downgrade" rule stranded the display and unticking would
  have been another silent no-op. It is now offered the release build, reported as `channel-return`.
- The return requires **evidence that the display was actually served the beta channel**
  (`devices.ota_channel_served`, written once when it changes rather than on every check). Returning
  every non-opted-in display that happens to run a pre-release would have dragged existing testers
  back to stable the moment their server upgraded — the precise harm the opt-in exists to prevent.
  A tester who is ahead of the server on a build of their own is left alone, as before.

> **Cut beta builds with the same `versionCode` as the stable release they branch from.** Android
> refuses to install a lower `versionCode`, so a beta numbered above stable can be installed but
> never returned without uninstalling the app — which loses the display's pairing. Equal numbers
> install in both directions, and that is what makes switching back physically possible.

Verified end to end against a live server with two real signed APKs: stable served 1.9.26, beta
served 1.9.27-rc1, an unknown channel fell back to stable, deleting the version file deactivated the
channel mid-run, and the opt-in → serve → switch-back lifecycle produced `offer`, `up-to-date` and
`channel-return` in order.

## 1.9.26

**Android playback fixes for #234, and a way to hand someone a test build without it reverting.**
The YouTube fault below was not specific to the reporter: any playlist containing a YouTube item
stopped rotating at that item, on every Android display, indefinitely.

### Fixed — Android playback
- **A YouTube item now ends on its configured duration.** It never ended at all: images and widgets
  get a timer, ordinary videos end on playback completion, and a YouTube link is played by loading
  an embed into a WebView — which reports no completion, and had no timer armed for it. The item's
  `duration_sec` was passed to the player and never read. The web and Tizen players already timed
  YouTube off its duration; Android was the only player that did not, so this restores parity rather
  than inventing behaviour. Local and remote video are untouched and still end on completion, so
  clips are not cut short.
- **A playlist change is no longer stranded behind an item that never ends.** #157 defers a change
  when the item on screen is dropped from the new list, applying it at the next advance. With a
  YouTube item that advance never came, so assigning a different playlist appeared to be ignored.
  Two guards: an **empty** list is never deferred (clearing a playlist is an operator saying stop,
  not an item rotating out), and a deferral now has a 60-second deadline so no future item type that
  ends on a callback can strand one again.

Verified on an Android 12 emulator against the reporter's exact shape (a 5s image and a long YouTube
video set to 10s): thirteen clean cycles at exactly the configured durations, a playlist swap
applying immediately while the YouTube item was on screen, and a clear stopping playback entirely.

### Fixed — "No playlist" did nothing
- **A display's playlist can now actually be cleared.** The dashboard offered a *No playlist* option
  whose handler discarded the selection (`if (!newPlaylistId) return; // Don't allow deselecting for
  now`) — no request, no change, no error. The guard was honest about why: there was no way to do it.
  `PUT /devices/:id` has never read `playlist_id`, and `POST /playlists/:id/assign` can only set one.
  New `DELETE /api/devices/:id/playlist`, device-scoped because there is no playlist to authorize
  against when clearing, gated by the same ownership check as every other device mutation. Clearing
  an already-clear display is a no-op success, and the empty playlist is pushed to the device so the
  screen stops rather than holding the old content.

### Added — per-display pre-release opt-in
- **"Accept pre-release builds"**, a checkbox beside the existing self-update toggle
  (`devices.ota_beta`, default off). Handing someone a test build was a trap: a prerelease sorts
  *below* its own release (`1.9.25-fix234d` < `1.9.25`), so a sideloaded display asked for updates,
  was correctly told the release was newer, and updated itself straight back off the build it had
  been given — same versionCode, so Android installed it without complaint. Silent, within minutes.
  It cost the #234 reporter an evening of testing code that had already been replaced under them.

  Narrow where it should be: it holds only a prerelease of the core already installed. A plain
  release, a `-patchN` build, an upgrade to a newer core, and a display ahead of the server all
  behave exactly as before, and a fleet that never sets the flag is unaffected. Wide where it must
  be: an opted-in display is exempt from the `superseded-prerelease` guard, which would otherwise
  pin a tester on an old build permanently — opting in must never mean never updating again.

  Note this is an opt-out of being reverted, **not** a second distribution channel: the server still
  serves one APK, so a beta build is still installed by hand.

### Documentation
- The published API reference had drifted to **1.9.0** while 1.9.25 shipped, because
  `bump-version.sh` updated every other version source and not `docs/openapi.yaml`. It now does, and
  a contract test fails if the two diverge.
- A device's two network addresses are documented and told apart — `ip_address` is the public/WAN
  address the server observed on connect, `local_ip` is the display's own LAN address as reported by
  the player — along with the rest of the telemetry block, none of which was in the spec despite
  being returned. `wifi_ssid`'s `"permission"` value is documented as a sentinel, not a network name.
- README catch-up: the public API, why a display might not self-update, what a delete-and-re-pair
  restores (including that a block deliberately survives it), hidden plans, and the optional location
  permission behind the Wi-Fi network name.
- **CHANGELOG backfilled for 1.9.3 through 1.9.25**, which had no entries at all. `bump-version.sh`
  now warns when a release is cut without one.

## 1.9.25

**Android playback and account-admin fixes.** Closes #234 — a playlist that only ever showed its
first item — plus the registration loop feeding it, and three issues found by the same reporter in
an afternoon of testing.

### Fixed — Android playback (#234)
- **A playlist no longer restarts at item one every time the Activity is rebuilt.** `PlaylistController`
  is owned by `MainActivity`, so each rebuild handed it a fresh, empty instance; the playlist then
  arrived, looked like a first load, and playback began from index 0. On a device rebuilding at every
  item boundary the second item held the screen for ~135ms — invisible, which is why it read as "only
  one item plays" rather than "it glitches". Playback position now lives outside the object being
  rebuilt and resumes if the save is recent (cold starts, stale saves and shrunk playlists all still
  begin at item one).
- **A player no longer re-registers itself once per playlist item.** Every advance asked for a
  playlist refresh, and a refresh emits a full `device:register` — so a 10-second image re-registered
  six times a minute, per device, forever, each one running the whole identity path and pushing a
  playlist back down. The heartbeat already refreshes every 60s, so the per-item call was duplicating
  a pull that happens anyway. Measured on the reproduction: 9 registrations for 9 plays → 3.
- **A leaked callback no longer relaunches the app in a loop.** `ProvisioningActivity` left its
  service callbacks attached after pairing, so later events re-entered a finished activity and
  restarted it — a white flash on every cycle, since Android 12+ draws a splash screen on each
  relaunch. Measured: 240 activity starts in 180s → 0.

### Fixed — account administration
- **Unblock now sticks.** Per-device settings are keyed to the hardware and deliberately restore
  `blocked` across a delete + re-pair, so a block cannot be shrugged off by deleting the display.
  Unblock only ever cleared the live copy, so the saved copy put the block straight back on the next
  re-pair and there was no way out from the dashboard. Unblock now clears both; blocking still
  survives a re-pair, which is the property that made this worth getting right.
- **A refused device says why.** A blocked panel sat on "Connecting to server" with nothing surfacing
  the server's rejection.

### Added
- **Every plan is visible to platform admins,** with how many accounts, organizations and displays
  are on each, plus a flag for accounts pointing at a plan that no longer exists. A plan hidden from
  the public pricing page was previously invisible to the operator too.
- **Player permissions can be reviewed and revoked from the setup screen.** Each row stays visible
  once granted and becomes *Manage*, instead of disappearing and leaving no way back.

## 1.9.24

**OTA control for managed panels.** Everything here is about not stranding a display: an operator
override, a retry budget that reflects what a retry actually costs, and a stand-down that only fires
when it should.

### Fixed — OTA
- **Self-OTA now stands down only for a genuine foreign device owner.** The check was broad enough
  that a stock Android panel with no MDM at all logged "self-OTA stands down" and stopped updating.
- **`OTA_ALLOW_MANAGED_DEVICES`** lets an operator override the stand-down when they run an MDM that
  does not distribute the player. Off by default. See the README before enabling — it does not grant
  the ability to install silently.
- **The install retry budget went from 3 attempts to 40, and flagging moved to 3.** Telling an
  operator a panel needs a human and giving up on that panel are separate decisions, and they were
  wired to the same number. A retry is nearly free — the APK is downloaded and signature-checked once
  and reused from cache, so later attempts pull no bytes. Past the budget it settles to about one
  attempt a day, indefinitely; a new version clears the count.
- **"Force update" is now actually forceful, and reports back.** It ignores the back-off, the attempt
  count and the MDM stand-down, and says what happened — including "already up to date", which used
  to return in silence and made a working button look broken.

### Fixed — playback
- **A wipe hands the frame back cleanly at the end,** instead of briefly revealing the outgoing image
  through the transition surface.
- **Turning off follower mode re-arms self-advance,** so a display taken out of a synchronized group
  no longer freezes on whatever was on screen.

## 1.9.23

**Scheduling on a touchscreen, and internationalization.** The weekly calendar becomes directly
manipulable, and a large batch of user-facing strings that were never translated go through `t()`.

### Added
- **The week calendar is directly manipulable** — drag and resize blocks, with grab targets big
  enough for a finger, gestures that work on a touchscreen, pointer handlers bound once rather than
  per render, and a single-day view for when a week will not fit.
- **Schedules that run past midnight draw correctly.**
- **The calendar opens on the working day** and explains what it is for.
- **Empty states tell you what to do next,** based on what the account actually contains.
- **`MAX_FILE_SIZE` is parsed properly** (bytes or a `2GB` / `1500MB` suffix), and the README
  documents the reverse proxy and CDN limits that cap an upload independently — raising the app limit
  alone often changes nothing (#233).
- **An opt-in browser smoke test,** deliberately kept out of `npm test`.

### Fixed
- **Untranslated keys are no longer shipped as user-facing text.**
- **Teams says it is switched off** rather than showing an empty list.
- **Proof-of-play attributes a widget play to the widget that played.**
- **Members is in the nav,** titles reveal on touch, and a stale heartbeat no longer kills a live
  socket.
- **A player re-establishes a socket the server closed.**

## 1.9.22

**Player identity.** Two panels running the same build could collapse into one dashboard row.

### Fixed
- **Each player install gets its own identity.** The web player's fingerprint was derived from
  hardware characteristics alone, so two identical panels produced the same value and merged into a
  single device row. Identity is now per install.
- **A screen-only panel can clear its identity from the URL,** giving a way to split a panel that had
  already merged.
- **Crash reports record where a player crashed,** not only what it said.

## 1.9.21

**Measurement fixes.** Small, all about not lying in the numbers.

### Fixed
- Event-loop lag reports zero for a window with no samples, instead of a stale figure.
- Auth rate-limit rejections are recorded, so they can be measured rather than inferred.
- A device fingerprint is only stored against a device that still exists.

## 1.9.20

**Scheduling across a fleet, and alerting that does not repeat itself.**

### Added
- **Every screen's schedule on one calendar,** rather than one screen at a time.
- **A schedule is stored in the timezone its screen runs in,** so a fleet spanning timezones behaves
  the way an operator means it to.
- **An unpaired player can be recovered without a keyboard** — relevant on signage hardware with a
  remote and no text input.
- **A BrightSign capability probe.**
- Italian translation updated (#232).

### Fixed
- **One alert per outage** instead of one per dedup window.
- Kiosk style values are validated as CSS rather than as HTML.
- A device's OTA rate state is cleared once it proves its identity.

## 1.9.19

### Fixed
- Proof-of-play resolves content references rather than trusting a reported id.
- `sharp` updated to 0.35.x, and the corrupt PNG fixture that update exposed was repaired.

## 1.9.18

### Fixed
- **Device serialization is scoped to what each endpoint actually needs,** rather than returning a
  whole device row everywhere.
- **A solo widget stays mounted** and sizes its keyboard to the viewport.
- Weather-radar example: the map stays centred and bounded, and counts only the warnings on screen.

## 1.9.17

### Added
- **Self-service password reset.**

### Fixed
- **A pairing code expires on device liveness, not row age,** so a slow setup no longer runs out of
  time while the panel is sitting on the code.

## 1.9.16

**Hardening pass.** Findings from an internal auth/authorization review, described here in the same
neutral terms as the commits: this is a public repository and detail that only helps an attacker adds
nothing for an operator deciding whether to upgrade. Upgrade.

### Security / hardening
- Break-glass admin recovery is backed by a revocable, auditable grant.
- Access-gating six-digit codes are generated with a CSPRNG.
- The screenshot route is authorized against the device's workspace.
- Password login is bounded per account, not only per IP.
- The unauthenticated telemetry store is bounded and no longer writes rows.
- `CF-Connecting-IP` is trusted only from a Cloudflare peer, not from any trusted proxy.
- An upload's stored type is derived from file content, and uploads are never served as documents.

### Fixed
- The release tarball keeps `.env.example`, and CI asserts it is there.

## 1.9.15

### Fixed
- **Webpage widgets carry an honest note:** sites that refuse embedding do not work on a device, and
  no client-side signal can reliably tell "blocked" from "loading" (#230).
- The "Reload now" update toast is actually clickable (#229).

### Changed
- Session token resolution centralised across the manual verify sites; the unused `optionalAuth`
  middleware dropped.

## 1.9.14

### Fixed
- **Trial expiry auto-downgrade actually fires** (#228).
- 11 of 13 npm advisories resolved (lockfile only) (#225).

### Added
- Stripe checkout accepts promotion codes (#227).

## 1.9.13

**Content library.** A batch of workflow features for libraries bigger than a handful of files.

### Added
- Multi-file upload (#222), multi-select with batch delete and batch move (#224).
- Server-side search, type filter and sort (#221).
- Subtitle / caption support as a content property (#223).
- **Unstable-connection mode** — caps YouTube at 720p for weak Wi-Fi (#220).
- The Add Display modal shows the server URL, and `/download/apk` links GitHub Releases (#210).

### Fixed
- YouTube ENDED safety net for Shorts and flaky Android TV (#219).
- Visible D-pad focus stroke on the Android setup buttons (#218).
- Uploads respect the current folder (#211).

## 1.9.12

### Added
- **TOTP two-factor authentication** and **email verification on signup**.
- **Proof-of-play on Android and Tizen,** closing the Tizen parity gaps.
- Tizen SSSP install.
- Designer-made widgets can be edited in the designer again, including reconstruction of legacy ones
  (#207).

### Fixed
- Web player cold-start crash from a hoisting error in `renderSeq`.
- The advance timer is reconciled on group/wall mode transitions (#200, #208).
- Weather elements can switch to metric (#206).

## 1.9.11

### Added
- **Transition engine** — GL wipes across the web, Tizen and Android players, including image↔video
  transitions (#204).

### Fixed
- Android supersede wedge and leak, plus a stale-video guard on web and Tizen (#205).

## 1.9.10

**Directory board and widget stability.**

### Added
- Directory board: panel-ring scroll, in-place refresh, per-device frame diagnostic (#203), and
  JSON/CSV import with logo-replaces-title (#195).

### Fixed
- **A zero-duration widget no longer self-loops.** It pegged the Android main thread (#198), and the
  server now floors `duration_sec` so no player can be handed the condition (#199).
- Buffered widget swap and schedule-aware solo-board hold, killing the directory-board black flicker
  (#202); decode-gated image double-buffer does the same for Tizen stills (#193, #187).
- Directory board scroll stutter from a seamless-loop gap mismatch (#197).
- The cross-origin header is set on the route that actually serves content (#196).
- Modals scroll instead of overflowing the viewport (#194).

## 1.9.9

### Fixed
- **Pairing:** closed a deferred-offline reclaim race and made same-code adopt idempotent (#192).

## 1.9.8

### Added
- **Directory-search widget** — interactive search of a directory board, live-synced (#188).
- Dashboard version loading indicator with an immediate first poll (#181).

### Fixed
- YouTube Shorts render 9:16 instead of in a landscape frame (#184, #189).
- A stuck download back-off resets on content change and network reconnect (#170, #190).
- The soft keyboard appears for PIN/URL dialogs over immersive fullscreen (#191).
- Thumbnail images use `data-auth-src` in modals and views (#182), with hydration lazy by default
  (#185).
- Raspberry Pi setup handles both `chromium-browser` and `chromium` package names (#183).

## 1.9.7

### Added
- **SMTP transport** as an alternative to Microsoft Graph for email (#173, #179).

### Fixed
- **A reinstalled panel reclaims its device row** instead of being blocked (#180).

## 1.9.6

### Added
- **Device incident log** — offline cause, network-vs-reboot, display-sleep (#175).
- IndexNow and landing-page optimization (#177); integrations internal linking (#178).

### Fixed
- **Tizen portrait and flipped video via AVPlay hardware-plane rotation** — CSS rotation cannot touch
  the hardware video plane and produced a black screen (#170, #174).
- `/integrations/` is served explicitly so the nav link is not the login page.
- CI uses OS-assigned ephemeral ports for subprocess suites, ending a port-collision flake (#176).

## 1.9.5

**Group sync, device-owner foundation, and agency folders.** The largest release in the 1.9.x line.

### Added
- **Per-group synchronized playback** — every member of a group derives the same (index, position)
  from a server-disciplined clock and a deterministic schedule, so displays start and end each item
  together. Offline-native (no server needed at play time) and split-brain-proof (no leader role).
  Includes snap-on-load, a warm next-clip double buffer, and in-place duration edits (#167).
- **Device-owner tier foundation** — QR provisioning, content expiry, and the tier substrate the
  Tier-2 controls build on (#168).
- **Tier 0/1 system controls with no device-owner dependency** — volume, brightness and screen
  timeout on ordinary panels (#160, #169).
- **Per-token upload folder for agency tokens** — auto-created and subtree-confined (#158, #171).
- **OTA self-update kill switch** — global, per-device, and MDM auto-detect (#166).
- Dashboard version indicator with a GHCR update check (#165).

### Fixed
- **Rotation-aware media** — a portrait photo is upright on both the dashboard and the player
  (#170, #172).
- `bump-version.sh` handles the env-overridable Android version (#168).

## 1.9.4

### Added
- **Hidden settings menu on Android,** opened by a multi-tap BACK/ESC sequence and gated by a PIN;
  the PIN is server-provisioned per device and surfaced on the dashboard, replacing a hardcoded
  `0000` (#152).

### Fixed
- **A player sends its device id and token on reconnect before pairing** (#164).
- Android provisioning and playback robustness.
- Playlist `GET /:id` returns item schedules, so the editor shows them (#156).
- Draft preview runs in a server-side session to bypass CSP (#151).
- Tizen player wedge on a shared `#stage` (same class as #162).

## 1.9.3

**Liveness contract v4 and per-device settings that survive a re-pair.** Follows 1.9.2-patch3.

### Added
- **Exit-signal contract v1** — a player tells the server it is going away, across the server, the
  APK, the `.wgt` and the browser player, so "offline" can distinguish a clean exit from a
  disappearance. Surfaced in the dashboard as an offline annotation with a tooltip, a filter drill-in
  and a list label.
- **Liveness contract v4** — uniform heartbeat acknowledgement, ack-gap tracking, a throttle-aware
  client watchdog, browser lifecycle triggers, and an identity block, implemented across the server,
  the APK, the `.wgt` and the browser player. Includes a three-state dashboard liveness badge.
- **Per-device settings survive delete + re-pair,** keyed to the hardware fingerprint: a re-paired
  panel comes back with its name, orientation, timezone, notes and playlist already set (#150).

### Fixed
- **Legacy `-patchN` builds are treated as released versions,** so the existing fleet is offered
  updates.
- Tizen: watchdog config-proofing, teardown hygiene, dead-screen self-heal, offline snapshot,
  keep-awake re-assert and a suspend/resume handler.
- Dashboard: `device-detail.js` parse and runtime errors that took out the whole view; liveness badge
  filter regression; list-view legibility.
- CSP allows the Cloudflare Web Analytics beacon to load *and* report.

## 1.9.2-patch2

**Server/CMS-only field-safe net for #148 — NO Android APK, players unchanged.** Makes the
server absorb a device that opens duplicate/rapid sockets, so a thrashing PAIRED device
converges to ONE stable connection and stays online. It does **NOT** fix the client opening
duplicate sockets (the APK duplicate-socket root cause — separate track); **#148 is not closed
on this alone.**

### Fixed / hardened — eviction storm (#148)
- **Per-device session-settle debounce.** When a device_id with a LIVE incumbent socket opens
  another socket within a short window (`SESSION_SETTLE_WINDOW_MS`, default 2500ms), the
  duplicate is **soft-refused and the incumbent kept** — so a duplicate burst converges on one
  connection and the device stays online, instead of churning through evictions. This closes
  the gap the reconnect-throttle's **30s post-restart warm-up** leaves open (during warm-up only
  the hard ceiling applies, so a burst passed undamped and each new socket evicted the prior).
  The debounce is **warm-up-independent**.
- **Liveness safeguard:** the incumbent is only kept if its socket is genuinely live; a
  dead/half-open incumbent is replaced — the device is **never stranded offline**.
- **Soft refusal, never a quarantine** (paired-safe); single-session enforcement intact for a
  legitimate move; unpaired/abusive flapping still caught by the existing limiters.

Operational note: a chunk of the observed churn was the warm-up window **re-opening on every
rapid patch redeploy** — the debounce closes that in code, but reducing redeploy frequency
independently reduces warm-up-window exposure.

Server/CMS only; ships no APK (versionCode still increments so a future player build is
OTA-recognized). Docker: `ghcr.io/screentinker/screentinker:1.9.2-patch2` (pre-release —
`:latest` stays at 1.9.2).

## 1.9.2-patch1

**Server/CMS-only connection-lifecycle hardening for #148 — NO Android APK, players stay on
their current builds.** This strictly HELPS and de-risks, but is **NOT a guaranteed #148 fix**:
the MAXHUB client-side reconnect failure and the disconnect synchronizer (edge conntrack /
reporting) are separate, unproven-here tracks that may still require a client update / a Bold
Sophos-edge review — **do not consider #148 fully closed on this patch alone.**

### Fixed / hardened — connection lifecycle (#148)
- **The flap-limiter no longer quarantines legitimate PAIRED devices on reconnect churn.** A
  paired + authenticated device reconnecting is exempt from the 30-min quarantine escalation
  (a brief soft cooldown at most), so a repeated edge/NAT flush behind one SNAT IP can no
  longer be amplified into a self-inflicted fleet-wide lockout. Unpaired/abusive flapping is
  still quarantined (the attacker / unprovisioned-hammering case is unchanged).
- **Marking a device offline now also closes its socket**, so DB-offline can't diverge from
  socket-state into a silent half-open the client is never told about.
- **Faster half-open detection:** ping interval 30s → 15s (the pong TIMEOUT is kept at 30s so
  decode-loaded TV WebKits aren't falsely dropped) → dead-peer detection 60s → 45s on BOTH the
  server AND the client (the client inherits these via the handshake — **no APK needed**).
- **TCP SO_KEEPALIVE** on every connection so a half-open TCP can't persist indefinitely at the
  OS layer.

Server/CMS version only; ships no APK (versionCode still increments so a future player build is
OTA-recognized). Docker: `ghcr.io/screentinker/screentinker:1.9.2-patch1` (pre-release —
`:latest` stays at 1.9.2).

## 1.9.2

**⚠ Major internal hardening release (the "#146" rewrite) — large blast radius.** 1.9.2
rewrites the connection / maintenance / OTA hot paths to kill an event-loop death spiral,
plus adds usage-metering (billing) and web-player fixes. If you bisect a regression to the
1.9.x line, 1.9.2 is the big one. Core invariant introduced: **no synchronous op may block
the event loop for more than ~50ms**, ever. Every new subsystem has an env kill-switch.

### Fixed — maintenance / prune (the death-spiral root cause)
- **Non-blocking, chunked, per-device `device_status_log` prune.** The old whole-table
  `ROW_NUMBER` sort froze boot for 40–48s at ~1M rows → healthcheck fail → restart loop that
  wiped in-memory throttle state → the spiral. Prune is now per-device, indexed, batched with
  `setImmediate` yields (`lib/chunked-prune.js`), async, re-entrant, and band-gated on the
  interval run (the startup prune is intentionally un-gated so a bloated table self-heals on
  first boot without freezing it). All table-growth sweeps (status-log, play-logs,
  provisioning, telemetry, lag) route through the chunked helper. New index
  `idx_devices_provisioning`. **Measured worst-case event-loop gap under the storm harness:
  <300ms across 300k rows (was 40–48s).**

### Fixed — reconnect / flap
- **Per-device flap-rate limiter** (`lib/flap-limiter.js`): a device reconnecting faster than
  `CONNECT_RATE_MAX` (20) per `CONNECT_RATE_WINDOW_MS` (5min) is refused at the register gate,
  keyed via a **SNAT-safe identity chain** (device_id → fingerprint → token → one bounded
  global anon bucket) — **never by IP** (the whole fleet egresses one IP). After repeated
  trips a hard flapper is **quarantined IN-MEMORY for 30min and auto-clears** — it is NOT a
  durable DB block.
- **Operator block kill-switch:** `POST /api/devices/:id/{block,unblock}` + a dashboard
  button; the block check resolves the effective device_id via the identity chain so a
  device_id-less reconnect of a blocked device is still caught. Takes effect on next register,
  no restart.
- Also folded in: false-offline fixes (live-socket liveness beats a lagged heartbeat clock;
  evicted-socket re-arm race) and per-connection fail-fast so one device's handler throw can
  never exit the process.

### Fixed — OTA (SNAT-safe)
- `/api/update/check` early-returns before any filesystem call when there's no offer; APK
  metadata is cached. `/download/apk` gains a **band-aware** global concurrency + rate guard
  that sheds with **503 Retry-After only under elevated/critical loop-lag** — under normal
  band, downloads serve freely (a coordinated fleet rollout is never staggered when healthy).
  All limiting is global/aggregate — **no per-IP limiting** (SNAT).

### Added — telemetry / logging / observability
- Batched `event_loop_lag` inserts (buffered, flushed every 10s) and coalesced high-frequency
  logging (one summarized line per key per 30s; band *changes* stay immediate).
- **Throughput counters** (running total + last-completed-window) in the `/api/status` debug
  block so a flapper/flood shows on the server itself (`flap.refusedLastWindow` climbing while
  `band=normal` = the limiter absorbing it cheaply). The debug block is now **admin-toggleable**
  (Admin tab, persisted, no restart; default follows `STATUS_DEBUG_ENABLED`).
- **`devices_connected`** on `/api/status` (always-on): the live WS-socket count from the
  heartbeat connection map (NOT the lagging `devices.status='online'` column).

### Added — billing (usage metering)
- **Billable Screens** metering per the ByteTinker–Bold agreement — the contractual
  system-of-record. A durable daily rollup (`device_usage_daily`) is accumulated incrementally
  off the heartbeat tick from live presence (retention-independent), pruned chunked. Exposed on
  a **dedicated, admin-gated `GET /api/billing/usage`** route (NOT on `/api/status`; billing is
  revenue data). Readable via an **owner-minted, revocable `billing:read` scoped token**
  (`scripts/mint-billing-token.js`) that authorizes billing-read and nothing else, OR a
  platform-admin session. See [`docs/billing.md`](docs/billing.md).

### Fixed — web player
- **"Unchanged" refresh no longer drops the video.** On a reconnect the server re-emits
  `device:paired` while content is already playing; the player showed the idle "Waiting for
  content…" overlay unconditionally (covering live video; audio kept playing underneath) and
  the following "Playlist unchanged" left it up. Idle now shows only when genuinely idle, and
  an unchanged refresh is a strict no-op that leaves playback exactly as-is.
- Hardened `PlayerMediaHealth` call sites to guard by **method** (not object) so a stale-cached
  player module can't throw `shouldShowIdle is not a function` and abort a socket handler.

### Added — translations
- Italian (`it`) locale updated (#145).


## 1.9.2-beta1 — unreleased

### Fixed — server resilience (#142)
- **A single flapping device can no longer saturate the event loop.** A new
  load-aware, per-device reconnect throttle (`lib/reconnect-throttle.js`) gates
  genuine reconnects *before* the heavy register work (DB writes + playlist build).
  The verdict is per-device; global event-loop lag only multiplies an
  already-flagged device's backoff and never throttles a healthy one. Hard ceiling
  + cold-start warm-up so a full-fleet reconnect after a deploy is never throttled.
- **`device_status_log` growth is bounded.** Added
  `idx_device_status_log_device_ts`, a global retention sweep (`pruneStatusLog`,
  `STATUS_LOG_RETENTION_DAYS` default 3) covering removed/idle devices and the
  `offline_timeout` path, and de-duplicated the table's `CREATE TABLE`.
- **`content-ack` spam de-duplicated.** Repeated identical
  `(device_id, content_id, status)` reports are suppressed within
  `CONTENT_ACK_DEDUP_MS` (default 10s).
- **Provisioning cleanup window corrected.** Unclaimed provisioning devices are now
  swept after 24h (the code used `365 * 86400` — a year — contradicting its own
  comment).

### Added — observability (#142)
- **Event-loop lag telemetry** via `perf_hooks.monitorEventLoopDelay()`. Sampled to
  a bounded `event_loop_lag` table (indexed + pruned, `LAG_TELEMETRY_RETENTION_DAYS`)
  and surfaced on `/api/status` as `loop_lag` (mean/p50/p99/max + band).

### Maintenance
- Operators whose `device_status_log` is already bloated from a pre-1.9.2 deployment
  should reclaim disk with a **one-time manual `VACUUM`** in a maintenance window;
  retention now bounds further growth. Auto-VACUUM is intentionally not enabled.
  See [`docs/maintenance-device-status-log.md`](docs/maintenance-device-status-log.md).

## 1.9.1-beta3 — unreleased

### Fixed — Tizen player
- **#118 Sticky "Not authenticated" banner.** On TV sleep/wake the socket reconnects and
  a heartbeat could fire on the fresh, not-yet-registered socket; the server rejected it
  with `device:auth-error`, which the player showed as a *sticky* toast over still-playing
  content (and, worse, dropped its saved credentials and re-paired). Heartbeats are now
  gated on a per-connection `authenticated` flag (set only between `device:registered` and
  `disconnect`/`auth-error`), the heartbeat timer is stopped on `connect`/`disconnect`/
  `auth-error`, the stale banner is cleared on `device:registered`, and the `auth-error`
  toast is non-sticky so any transient case self-clears.
- **#119 `app_version` stuck at `1.0.0`.** The hardcoded constant made every Tizen device
  report `1.0.0` regardless of the installed `.wgt`. The version now resolves at runtime
  from `config.xml` via the Tizen application API, with a fallback constant that
  `build-wgt.sh` stamps from `config.xml`'s `version=""`.

### Added — Tizen player
- **Video walls (`wall:sync`).** The Tizen player now supports wall membership: when the
  payload carries `wall_config`, a new `WallController` positions the stage (vw/vh) as this
  screen's slice of the wall and drives the single-zone player as leader or follower. The
  leader broadcasts `wall:sync` at 4Hz; followers align their index and keep their video
  locked to the leader's clock with a latency-compensated drift controller (hard-seek past
  0.3s, gentle ±3% playbackRate nudge past 0.05s), and request an immediate position on
  (re)connect via `wall:sync-request`. Mirrors the web player (the Android player has no
  wall support). Per-tile `rotation` is not applied yet (web-player parity). Wall emits are
  gated on auth + connection so a pre-register tick can't trip `device:auth-error`.
- **Multi-zone layouts (Android parity).** The Tizen player now renders assigned layouts,
  not just fullscreen single-zone. A new `ZoneRenderer` (ports the Android `ZoneManager`)
  positions zones by percent geometry with `z_index`/`fit_mode`/background, groups
  assignments by `zone_id` (unassigned content goes to the first zone), and rotates each
  zone independently with the same per-item schedule gating (#74/#75). `app.js` selects the
  renderer from `payload.layout`; single-zone playback is unchanged. (Video walls
  `wall:sync` are still Android-only.)
- **#121 Remote commands.** Added a `device:command` handler (`refresh`, `launch`,
  `screen_on`, `screen_off`, plus honest no-op toasts for `update`/`reboot`/`shutdown`,
  which need B2B/MDM privileges a sideloaded app lacks). Removed the dead `device:reload`
  listener (the server never emitted it) in favour of `device:command` `refresh`.
- **#120 Dashboard preview.** Added `device:screenshot-request` / `device:remote-start` /
  `device:remote-stop`. Images capture for real; `<video>`/YouTube fall back to a status
  card because the TV's hardware video plane and cross-origin iframes can't be read into a
  `<canvas>`. See `tizen/README.md` for the support matrix.
- **#122 Updates / boot.** Documented the supported paths — `.wgt` re-sideload or URL
  Launcher/MDM refresh for updates, and display-level kiosk/URL-Launcher settings for
  auto-launch on boot (there is no in-app OTA or `config.xml` autostart for a sideloaded
  consumer TV web app).

## 1.9.0 — 2026-06-11

### Added
- **Per-playlist-item schedules.** Each playlist item can carry one or more schedule
  blocks — active days, a start/end time-of-day, and optional start/end dates. An item
  plays when the screen's local "now" matches at least one block; an item with no
  blocks always plays. Edit per item via the clock icon in the playlist editor (a badge
  summarises the schedule on each row).
  - **#74 dayparting:** time-of-day + day-of-week windows, including overnight windows
    that cross midnight (a Fri 22:00–02:00 block is active Sat 01:00).
  - **#75 auto-expire:** inclusive start/end dates; an item past its end date stops
    showing automatically — even on offline screens, because evaluation is on-device.
- All three players (web, Android, Tizen) evaluate schedules client-side against their
  own clock, so dayparting and expiry work offline. They share one evaluator contract,
  `shared/schedule-vectors.json` — 39 conformance vectors covering DST (US + AU),
  overnight-wrap day anchoring, timezone correctness, and date boundaries. CI runs the
  vectors against the JS evaluator (node) and the Kotlin port (Gradle/JUnit); the Tizen
  copy is byte-identical to the JS source and checked under node.
- Device detail now shows the screen's reported timezone and clock, with a **clock-skew
  warning** when the device clock differs from the server by more than 2 minutes (a bad
  device clock makes schedules fire at the wrong local time).

### Changed — device-level schedule timezone (behaviour change)
- Device/group **schedule overrides** (the existing calendar feature) are now evaluated
  in each device's effective timezone instead of the server's local time. Previously the
  `schedules.timezone` field was never applied and "07:00" meant the *server's* 07:00.
  Now "07:00" means the *screen's* 07:00 — which is what was intended.
  - **Who is affected:** self-hosters whose server timezone differs from their screens'
    timezone — their existing device schedules will shift to fire at the screens' local
    time. Single-timezone deployments (server and screens in the same zone) are
    unaffected. A device with no timezone set and not reporting one falls back to the
    server clock (unchanged from before).

### Fixed
- **#81 — release APK is now v1 + v2 + v3 signed.** With `minSdk 26`, the Android Gradle
  Plugin defaulted the v1 (JAR) signature *off*, producing a v2-only APK that some
  MDM-managed commercial signage (e.g. MAXHUB via the Pivot MDM) silently removes on the
  next reboot — so screens that power-cycle nightly lost the app and fell back to the
  setup screen. Setting `enableV1Signing = true` had no effect at minSdk ≥ 24; the release
  build now re-signs with `apksigner` and a low `--min-sdk-version` to emit the JAR
  signature alongside v2/v3. Verified to install and run on Android 14+/API 36 as well.

### Notes
- **Scheduling fails open.** If the on-device evaluator ever errors (bad timezone id,
  malformed block), the item **plays** rather than being hidden. A blank screen is worse
  than an over-running promo — this is a guarantee, enforced in all three players.
- Windows are enforced at **item boundaries**: a long item finishes before the schedule
  is re-checked, so it can overshoot its window by up to its own duration.
- **A single video *with a schedule* now re-renders at each loop boundary** so its window
  can be re-evaluated; seamless native looping still applies to unscheduled single videos.
  Deliberate tradeoff — a brief seam each loop for a scheduled lone video, in exchange for
  its daypart/expiry actually being honoured.
- **Re-publish required:** editing a schedule puts the playlist into draft; publish to
  push schedules to devices. Existing published playlists keep playing unchanged until
  re-published.
- Players that predate this release ignore the new fields and keep playing everything
  (graceful degradation) — update players to honour schedules.
