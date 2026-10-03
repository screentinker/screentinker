# Content approval and version history

Two related features, both per workspace:

1. **Approval workflow** (optional, off by default): nothing goes live in a workspace until an assigned reviewer has approved the exact revision being released.
2. **Version history** (always on): every meaningful save of content, playlists, layouts, slide decks and widgets is recorded, can be previewed and compared, and can be restored into a new draft.

Everything is enforced on the server. The dashboard only reflects what `/api/approvals/settings` and `/api/revisions/...` report.

## The release policy

`server/lib/release-policy.js` is the single gate every live-playback path consults before it changes what screens show:

| Path | Where it is gated |
|------|-------------------|
| Playlist publish (dashboard, API, content-only playlists from the schedule editor) | `lib/releases.releasePlaylist` |
| Slide deck publish | `lib/releases.releaseSlideDeck` |
| Widget edit | `routes/widgets.js` PUT parks the edit in `widgets.draft_config` when approval is on |
| Layout edit (name, size, zones) | `routes/layouts.js` PUT parks in `layouts.draft_zones`; per-zone add/edit/delete routes answer 409 `approval_required` |
| Content file replace | `routes/content.js` parks the new bytes in `content.draft_json` |
| Content playback fields (remote URL, MIME type, captions, subtitle settings, quality ceiling) | `routes/content.js` PUT parks them in `content.draft_json` |
| Playlist item add, edit, remove, duplicate, reorder, schedule | recorded as revisions with their author (the no-self-approval check reads these); the playlist publishes through the gate |
| Agency auto-publish | `routes/agency.js` publishes directly when allowed, otherwise leaves a draft and opens a submission on the token's behalf |

With approval **off**, `assertReleasable` returns `{ mode: 'direct' }` and every path behaves exactly as before. With approval **on**, it returns the approved submission or throws a `ReleaseError` with one of these codes, which the routes send as HTTP 409:

| Code | Meaning |
|------|---------|
| `approval_required` | No submission for this revision. Submit for review first. |
| `awaiting_review` | Submitted, no decision yet. |
| `changes_requested` | A reviewer asked for changes; the comment is in the message. |
| `approval_stale` | The item was edited after approval. Submit again. |
| `deps_changed` | Something the item depends on (content bytes, widget config, nested playlist) changed since approval. Submit again. |
| `approver_ineligible` | The reviewer who approved no longer has reviewer access. The submission is back in the queue. |

Approval is bound to an immutable revision: the submission stores the state hash of the submitted revision and the stamps of its dependencies, and both are rechecked at decision time and again at publish time. The approver is rechecked too: if they were removed from the reviewer list or lost write access between approving and publishing, the release is refused with `approver_ineligible`, and the submission returns to the queue for another review. Removing someone from the reviewer list reopens their pending approvals immediately.

## Not covered by the gate

These are deliberately outside the approval workflow and are listed so nobody assumes otherwise:

- **Organisational edits** on content (name, folder, expiry) and playlist renames apply live. They are recorded in history. Fields that change what a screen shows (remote URL, MIME type, captions, subtitle settings, quality ceiling) are gated.
- **Subtitle file uploads** (`POST /api/content/:id/subtitle`) attach live. Clearing or relabelling a subtitle through the details route is gated.
- **Assignments and schedules**: assigning an already-published playlist to a screen, or changing a schedule slot, is a device operation, not a content release. The playlist itself had to be approved to be published.
- **Mute sync, device settings, triggers**: device control, not content.
- **External URLs and live data sources**: the URL or data-source binding is the authored state and is versioned. The page or feed behind it is live data and is not.
- **Mesh replication** applies whatever the source workspace released. Approval is a property of the source workspace.
- **A slide deck's internal playlist** is the deck's release artefact; approval is on the deck.

## Admin flow

Workspace admins find **Content approval** at the bottom of Members.

- Tick reviewers (only admins and editors are eligible), save, then enable **Require approval before publishing**.
- The toggle cannot be enabled with fewer than two eligible members (there would be nobody to review) or with no reviewer assigned. The card says which.
- Enabling changes nothing that is playing. Existing published content stays published and needs no retroactive approval.
- Disabling asks for confirmation, states how many submissions are pending, cancels them with a comment, keeps their drafts and history, and never auto-publishes.
- Every change is written to the activity log (`approval:enabled`, `approval:disabled`, `approval:reviewers_changed`).
- Removing a reviewer's write access (or removing them from the workspace) revokes their reviewing immediately: eligibility is checked at decision time, not when they were assigned.

## Creator and reviewer flow

Draft → Submitted → Approved → Published, with **Changes requested** and **Withdrawn** as side exits.

- Editors save as usual. Under approval, widget, layout and content edits are stored as a draft beside the live version; playlists and decks already had a draft state.
- **Submit for review** (on the item) records a revision, opens a submission, and supersedes any earlier open submission for that item. Editing after submitting invalidates it: a new submission is required.
- **Reviews** in the nav lists open submissions with the submitter, time, affected screens, a preview, and the diff against the live version. Reviewers **Approve** or **Request changes** (a comment is mandatory). The submitter, or anyone who authored a revision in the submitted range, cannot approve it. In a single-user workspace the setting cannot be enabled at all, and the card says why.
- **Approve** records reviewer, decision, time and comment. It does not publish. Anyone with write access then presses **Publish approved version** (or the item's own Publish button). The server rechecks the reviewer's eligibility, the revision hash and the dependency stamps at that moment.
- Two reviewers acting at once: decisions carry a version number, and the loser gets a clear `version_conflict` message rather than a silent overwrite.
- Submitters (and admins) can **Withdraw**.

## Version history

`server/lib/revisions.js` holds one model for all five resource types. Each revision records the workspace, resource, sequence number, time, actor (user, API token, import, mesh sync, restore, or the migration baseline), a summary, the immutable state, its hash, and links to the submission and the publish event.

- Revisions are recorded on meaningful saves, replacements, imports and restores. Identical consecutive states are not duplicated. Per-keystroke autosave never records.
- Replaced content bytes are kept under `<uploads>/.history/<content id>/` so an older revision can still be previewed and restored.
- Secrets in widget config (keys matching api key, secret, token, password, credential, auth) are redacted in every history response.
- **History** on an item lists revisions, previews one (widget render, image or video bytes, playlist items, layout zones, deck slides), compares two, and **Restore**s one. Restore creates a **new draft revision** attributed to the restorer. It never rewrites history and never touches the live version. Under approval, a restored draft goes through review like any other change. For content, the draft carries every captured field except folder, and releasing the draft applies exactly that set, so the released row matches the restored revision.
- **Discarding a draft** removes the pending file only when no revision describes it. A pending file that history references (the restore's own revision, a replaced-file draft) is moved into the retention directory and the revision follows it. The live file is never touched.

### Retention

`server/lib/revision-retention.js` runs daily and keeps, per resource:

- the newest `REVISION_KEEP` revisions (default 20, minimum 3),
- the live revision,
- every revision referenced by any submission (pending or historical),
- the migration baseline.

Retained media files are deleted only when no surviving revision references them. Deleting a content item removes its revisions and its history directory.

## Migration

Runs automatically at startup and is backward compatible:

- `workspaces.require_approval` is added with default 0. Every existing workspace and every new one starts with approval off.
- `revisions`, `submissions` and `workspace_reviewers` tables are created; `widgets.draft_config`, `layouts.draft_zones` and `content.draft_json` are added as nullable columns.
- A one-shot `revisions_baseline_v1` records one baseline revision per existing item from its current state. The actor is recorded as `baseline` (no author is invented) and the timestamp is the row's existing `updated_at` or `created_at`. Published items are marked as such so history shows what was live at that point.
- IDs, schedules, assignments and published snapshots are untouched. Players notice nothing.
- The baseline runs inside a transaction gated by `schema_migrations`, so an interrupted start reruns it cleanly and a second server does not run it twice.

## API

- `GET/PUT /api/approvals/settings` (PUT is admin only)
- `GET /api/approvals/queue?status=open|all|<status>`, `GET /api/approvals/mine`
- `POST /api/approvals/submit` `{ resource_type, resource_id, note }`
- `GET /api/approvals/:id`, `POST /api/approvals/:id/withdraw|approve|request-changes|publish` (`{ comment, version }`)
- `GET /api/revisions/:type/:id`, `.../:rev`, `.../:rev/diff?against=`, `.../:rev/file`, `.../:rev/render`, `POST .../:rev/restore`
- `POST /api/revisions/:type/:id/publish-draft` and `/discard-draft` for widgets, layouts and content

All endpoints require workspace membership; writes require the editor role; settings require admin. Tests live in `server/test/approvals-history.test.js`.
