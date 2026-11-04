# Content requests

A **request form** is a link you share with people who do not have a ScreenTinker account (staff, students, a department, a club) so they can send you something for the screens. What they send lands in the existing review queue, labelled with who sent it, where they want it and for which dates. Nothing they send reaches a screen until someone in the workspace approves it, and approving publishes it through the same release path as any other publish.

This replaces the usual workaround: a file-share upload or a web form outside the signage system, followed by an editor re-entering each request by hand.

## For the people who run the screens

### Make a form

**Advanced view:** *Requests* in the sidebar, *Request forms* tab, *New request form*.

**Simple view:** *Requests from others*, then *Make a request link*. Name the link, tick the screens people may choose, and share it. Simple view makes an open-link form with the default rules below; use Advanced view to change them.

A form has:

| Setting | What it does |
|---|---|
| Title, introduction | Shown at the top of the public page. Plain text. |
| Where requests can go | A list of places, each with a **friendly name** and a screen, group or playlist behind it. Requesters see only the names. A screen or group is resolved to the playlist it plays **when you save the form**; that playlist is what the request is added to. The inbox shows the playlist and how many screens play it. |
| Who can use the link | **Anyone with the link** (the link is the key; name and email are taken as given), **Email in allowed domains** (the requester confirms a six-digit code sent to an address in one of your domains; needs outgoing email), or **Single sign-on** (the requester signs in with your organization's identity provider; needs org SSO with a verified domain). Options the server cannot support are shown greyed out with the reason. |
| Allowed email domains | Required for email mode. For SSO it optionally narrows who may use the form. Exact match: `sub.campus.edu` is not `campus.edu` unless you list it. |
| Extra questions | Audience and notes, each hidden, optional or required. |
| File rules | Images, videos and/or **website links** (websites are off unless you tick them); largest file (MB, capped by the server's `MAX_FILE_SIZE`); minimum width and height; shape (16:9, 9:16, 4:3, 3:4, 1:1, 21:9, or any; 2% tolerance); longest video. |
| Days of notice needed | The earliest start date is today plus this many days (UTC calendar days). |
| Longest run | The longest start-to-end window a request may ask for. |
| Website domains allowed | Optional. With websites on, limits them to these domains and their subdomains: `campus.edu` allows `events.campus.edu`, never `evilcampus.edu` or `campus.edu.evil.com`. Empty means any public website. |
| Seconds an image shows | The dwell time of the item that is added (images and websites). Videos play for their own length. |
| Requests per day | How many requests this form accepts in any 24 hours. |
| Folder | Where the uploaded files are stored in the library. |

A form can be **open**, **paused** (the page says so and takes nothing) or **closed**. **New link** replaces the link's secret code: the old link stops working at once, and anyone half way through on the old link has to start again. Deleting a form removes the way in; requests already sent keep their status links, and anything approved keeps playing until its end date.

Who may do what: workspace admins and editors make and change forms; view-only members can see them. Every change is in the activity log (`request_form:created`, `request_form:updated`, `request_form:link_rotated`, `request_form:deleted`).

### Review requests

Requests appear in two places:

- **Requests** (Advanced) and **Requests from others** (Simple): the inbox, with a preview, the requester, whether their email was verified (and how), the dates, the places and the playlists behind them.
- **Reviews**: the same request, as a submission labelled *Request from name (email)*, with the dates and places.

**Approve and publish** adds the file to each chosen place's playlist as an item scheduled for exactly the requested dates, and publishes those playlists. **Decline** needs a reason; the requester sees it on their status page and, if email is configured, in an email.

Who may decide:

- If the workspace **requires approval** (Members, Content approval), only assigned reviewers decide, exactly as for every other change.
- If it does not, **any admin or editor** may decide a request. A request still needs that explicit decision; turning approval off never publishes or cancels waiting requests.

Before anything is decided, every target is checked. Approval is refused (and nothing is recorded) when a target playlist:

- has **unpublished changes** of its own. Publishing it to add the request would publish someone else's unfinished work, so publish or discard that first;
- has never been published, is a smart playlist, feeds a zone of a layout, or belongs to head office (corporate). These are refused when the form is saved, too.

If a playlist changes between the check and the publish and one target fails, the others still go live; the inbox shows which target failed and why, and **Publish to the remaining screens** retries only those.

### When it ends

Each added item carries a schedule block from the start date to the end date, applied by the screen in its own local time. A website stops when its schedule block ends; its widget stays in the widgets list until someone deletes it. The file also gets a library expiry 38 hours after midnight UTC at the end of its last day, so it is switched off everywhere after the last local day has ended, and the existing expiry sweep republishes the playlists without it. Declined and withdrawn requests have their file switched off immediately; a declined or withdrawn website has its widget deleted (unless someone has since added it to a playlist by hand).

### Websites

A form with **Website links** ticked lets the requester send a web address instead of a file. It becomes a **webpage widget** in the workspace, named after the request, and goes into the same review queue as a file. The inbox shows the host and full address with an **Open website in a new tab** button; the page is not embedded in the dashboard. Approving adds the widget to the targets with the same dated schedule block a file gets, and screens show it live, in the same sandboxed frame as any webpage widget, so the page can change after approval. Check it before approving, and use the domain list when you only want pages from sites you trust.

## For the people sending a request

Open the link you were given. Depending on the form you:

- enter your name and email, or
- enter your name and an address in the listed domains, then the six-digit code emailed to you, or
- sign in with your organization account. No ScreenTinker account is created.

Then say what it is, tick where it should show, pick the first and last day, answer any extra questions, choose the file (or, on a form that takes websites, pick **A website link** and paste the address) and press **Send request**. Large videos upload in small pieces; if the connection drops the upload carries on from where it stopped, and if you reload the page and pick the same file again it resumes.

You get a **reference number** and a **status link**. Keep the link: it shows whether the request is waiting, approved, on the screens, finished or declined (with the reason), and while it is still waiting it lets you withdraw it. If your email was verified you also get an email when it arrives and when it is decided; on an open-link form you get the decision email only.

The page uses the workspace's brand name, logo and colour where the workspace has white-label branding, and follows the browser's language.

## How it works

### Data

| Table | Holds |
|---|---|
| `request_forms` | The form: workspace, secret `code`, status, access mode, domains, targets (JSON, each with the resolved `playlist_id`), extra fields, file rules, timing and quota, folder, creator. |
| `content_requests` | One request: reference, form, workspace, requester name and email and how it was verified, title, audience, notes, dates, chosen targets (snapshot), the content row, the submission, status (`pending`, `approved`, `published`, `rejected`, `cancelled`), decline reason, publish result per target, a keyed hash of the sender's IP, and the sha256 of the status token. |
| `request_tickets` | Proof that a requester passed a form's gate: sha256 of the ticket, form, name, email, how verified, expiry (2 hours). |
| `request_email_challenges` | Hashed six-digit codes for email mode, with attempts and expiry. |
| `submissions.request_id` | Ties a review-queue submission to the request it reviews. |

All are additive migrations in `server/db/database.js`; nothing existing changes shape.

### The path from request to screen

1. The upload is staged with `lib/upload-session` (outside anything served) and sniffed as soon as its first 4 KB arrive.
2. On submit the bytes are sniffed again, measured (image dimensions through the image worker, video dimensions and length through ffprobe) and checked against the form's rules **before** any content row exists. A refused file never touches the library.
3. The file goes through `lib/content-ingest.ingestUploadedFile`, the same ingest a dashboard upload uses, into the form's folder, charged to the form creator's storage allowance (or the organization owner's). It is renamed to the request's title and given its expiry.
4. A submission is opened with `lib/approvals.submit` for the content, with `request_id` set and no submitting user (the requester has no account); its note and the queue columns carry the requester.
5. Approving calls `lib/approvals.decide`. Then, for each target, one dated item is added, the playlist is recorded as a revision attributed to the request, and it is released with `lib/releases.releasePlaylist`, behind `lib/release-policy.assertReleasable`. With approval on, the playlist change gets its own submission (also tagged with the request) decided by the same reviewer in the same action, so the gate sees an approval for exactly the state going live: the target was clean a moment earlier, so the only difference is the one dated item. The content's own submission is then closed as published.
6. Declining calls `decide` with "changes requested" and the reason.

The existing Reviews endpoints hand request submissions to the request handlers: approving one there publishes it, "request changes" declines it, withdrawing it cancels it.

### How this differs from the agency upload portal

| | Agency portal (`routes/agency.js`) | Content requests |
|---|---|---|
| Who | A known third party | Anyone the link reaches (optionally confined by email domain or SSO) |
| Credential | An API token with the `agency` scope | The form's link code, then a two-hour ticket; no account, no token |
| Targets | Playlist ids on the token's allowlist | Friendly names only; the playlists stay on the server |
| Going live | Draft for the admin to publish, or auto-publish | Always an explicit approval; never automatic |
| Tracking | Digest email to admins | Reference number and status link for the requester; decisions emailed |

What carries over is the agency's security model: confinement is one lookup against an allowlist the admin wrote (`validateRequestBody` checks the chosen targets against the form's own list and refuses anything else), uploads go through the shared ingest so the bytes are first-class content, items are dated schedule blocks, and the same guardrails refuse zoned, smart and head-office playlists.

## Abuse controls

| Threat | Control |
|---|---|
| Guessing a form code | 128-bit random codes. Unknown codes and status tokens count against the IP: 20 in 15 minutes locks the IP out of every form for 15 minutes, valid codes included. Rate-limit buckets and log lines use `/r/:code`, never the code. |
| Hammering | Per-IP limits per action inside `routes/request-public.js` (form 60/min, start 10/min, email code 5/min, confirm 10/min, SSO 20/min, upload create 10/min, chunks 1200/min, submit 10/min, status 60/min) under an outer per-IP cap in `server.js` and the global backstop. |
| Flooding a form | Per form per 24 h (the form's quota, counting requests in flight), per email address per form per 24 h (5), per IP per form per 24 h (10), checked before any bytes are accepted and again at submit. At most 2 open uploads per requester and 10 per form. |
| Spraying email | Codes: 3 per address per form per hour, 60 per form per hour, 5 wrong answers kill a code, 15-minute expiry, spent codes keep counting. Receipts go only to verified addresses; open-link forms mail only decisions a person made. |
| Bad files | Declared size capped by the form and by `MAX_FILE_SIZE`, enforced on every chunk; content sniffed at 4 KB and again at submit; allow-list of image/video types (no SVG, no HTML bundles, no audio, no HEIC); dimensions, shape and video length measured before ingest, failing closed when a rule cannot be checked (for example no ffprobe); storage allowance checked at upload and at submit. |
| Hostile website links | Websites are off per form until an admin ticks them, and can be limited to listed domains (suffix match on a dot boundary). Only `http:`/`https:`, at most 2048 characters, no user name or password in the address, and the SSRF gate every server-reachable remote URL passes (`lib/remote-url.validateRemoteUrl`: no localhost, RFC 1918, link-local, `.local` or `.internal`); single-label hosts are refused. The same per-form, per-address and per-IP quotas apply. A refused address creates nothing. The reviewer opens the page in a new tab with `noopener noreferrer`; it is never framed in the dashboard. |
| HTML / script injection | Requester and form text fields refuse markup (`<tag`, entities) instead of cleaning it; everything is rendered with `textContent` or `esc()`; the workspace's custom CSS is not applied to the public page; the logo must be an `https:` or same-origin path. |
| Domain restriction bypass | A strict single-address pattern (one `@`, ASCII hostname) and an exact domain match: `a@campus.edu@evil.test`, `a@campus.edu.evil.test`, `a@sub.campus.edu`, look-alike Unicode and quoted local parts are refused. A ticket earned under a weaker mode is rejected once the form changes mode. |
| Picking a target outside the allowed set | The requester can only name target ids the form handed out; anything else is a 400, never ignored. Approval re-checks that each playlist is still in the workspace. |
| Token leakage | Status tokens travel in the URL **fragment** (`/r/status#<token>`), which browsers do not send to servers, and are POSTed in a body; only their sha256 is stored. The SSO ticket comes back in the fragment too. The page sends `Referrer-Policy: no-referrer` and `noindex`. |
| SSO misuse | An SSO round trip for a form runs the full sign-in verification (PKCE, state, nonce, SAML request binding, issuer, replay), then requires the provider to belong to the form's organization, the address to be one it may assert (`emailAllowedForProvider`) and verified. No user row, session or membership is created. |
| Paused / closed forms | Refuse everything except the status page. |

## API

Workspace side, JWT only (`/api/content-requests`, mounted with tenancy; lookups are by id and workspace, so another workspace's form or request is a 404):

- `GET /options`: screens, groups, playlists and folders for the editor, and whether email and SSO modes are available
- `GET /forms`, `POST /forms`, `GET /forms/:id`, `PUT /forms/:id`, `DELETE /forms/:id`, `POST /forms/:id/rotate`
- `GET /requests?status=pending|approved|published|rejected|cancelled|all&form=`, `GET /requests/:id`
- `POST /requests/:id/approve` `{ comment?, version? }`, `POST /requests/:id/reject` `{ reason }`, `POST /requests/:id/publish` (retry)

Writes need the editor role; deciding follows the rules above.

Public side, no account (`/api/public/requests`):

- `GET /form/:code`
- `POST /form/:code/start` `{ name, email }` (open link)
- `POST /form/:code/verify` `{ name, email }`, `POST /form/:code/verify/confirm` `{ email, code }` (email mode)
- `GET /form/:code/sso` (SSO mode; redirects to the identity provider and back to `/r/<code>#ticket=…`)
- `POST /form/:code/uploads` `{ filename, size }`, `GET|PATCH|DELETE /form/:code/uploads/:id` (resumable; `Upload-Offset` header, raw bytes)
- `POST /form/:code/submit` `{ upload_id, title, targets: [id], start_date, end_date, audience?, notes? }`, or with `url` in place of `upload_id` on a form whose `file_rules.kinds` includes `web`. Website refusals: `type_not_allowed` (415, the form takes no websites), `bad_url`, `url_not_allowed`, `url_domain_not_allowed` (with `domains`), `file_and_url`.
- `POST /status` `{ token }`, `POST /status/cancel` `{ token }`

Upload, submit and the upload-status calls carry the ticket in an `X-Request-Ticket` header. Pages: `/r/<code>` and `/r/status#<token>`.

No new environment variables. Email mode needs outgoing email (SMTP or Microsoft Graph) configured as for the rest of the server; SSO mode needs an organization identity provider with a verified domain (see `docs/sso-setup.md`). Without them those modes are shown as unavailable rather than failing.

Tests: `server/test/content-requests.test.js`.
