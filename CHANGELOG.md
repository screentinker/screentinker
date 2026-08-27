# Changelog

## Unreleased

### Fixed — the image picker never opened, and Weather and Social could not be edited

Backported from the 2.0.0 line, where it was found. The escaping sweep of 2026-08-11
(`ec45092`) added `esc()` to three sinks in `frontend/js/views/widgets.js` and imported it
in none of them — `esc` lives in `utils.js`, and that file imported only
`hydrateAuthImages`. Each of those lines threw `ReferenceError: esc is not defined` the
moment it ran:

* `openContentPicker()` threw while building `overlay.innerHTML`, **before**
  `appendChild` — so "+ Add Background Image" and "Choose Logo" on a directory board did
  nothing at all, silently, and the promise behind them never settled
* the **Weather** config form (`esc(config.location)`) rendered empty — the widget could
  not be created or edited
* the **Social** config form (`esc(config.query)`) likewise

Nothing caught it: the reference resolves only when the line runs, so a syntax check
passes, and all three calls sit inside click handlers, so every view still rendered.
Verified in a real browser against this branch — before, Weather and Social render an
empty form and the picker never opens, with three `esc is not defined`; after, all three
work with no page errors.

`test/frontend-shared-helpers.test.js` comes with it: a shared helper a frontend file calls
must be one it imports.

## 1.9.40

A single player fix, backported from the 2.0.0 line. Reported by a self-hosted operator running the
web player in a Chrome kiosk.

### Fixed — a duration-only playlist edit reverted on the next reload (#295)

Change nothing but an item's duration and publish, and a running player picked up the new value —
then reverted to the old one as soon as the page reloaded, because the stale duration was still in
the player's local cache. The in-place update wrote to the live playlist and never wrote it back.

The same fix covers **every per-item field that does not need a restart**, not just duration: mute,
captions, subtitles and title were all being ignored on an otherwise-unchanged playlist. Editing any
of them now takes effect, and a mute change on the item currently on screen applies immediately
rather than at the next loop.

⚠️ **If you are on 1.9.0**, the duration edit did not reach the player at all — that half was fixed
earlier in the 1.9.x line. This release completes it.

Reported, diagnosed and patched by **@stuart-hampl**, who also worked out that duration was not the
only field affected. Thank you.

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
