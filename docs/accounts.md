# Accounts: deleting your own

Anyone can delete their own account, at any time, without asking an admin. Google Play requires
this for an app with accounts (the ScreenTinker Manager app), and the privacy policy promises it.

## Where

- **Dashboard, Advanced view:** Settings, the **Delete my account** card
  (`/app#/settings?section=delete-account`).
- **Dashboard, Simple view:** the menu under your name, **Delete my account** (`#/delete-account`).
- **Manager app (Android):** the same menu item inside the app, or **Your servers** → **Delete
  account…** under a server, which opens `#/delete-account` in the app. See
  [manager-app.md](manager-app.md#deleting-an-account).
- **Public explanation:** `/delete-account` (static, `frontend/delete-account.html`). It is the
  URL for the Play listing's "delete account" link. It says how to delete in both places, what is
  deleted, how long backups keep it, and how to ask when you cannot sign in
  (support@screentinker.com on the hosted service; the server's admin when self-hosted). After a
  deletion the dashboard lands on `/account-deleted`.

The card first shows what will be deleted, what will not, and anything that blocks the deletion,
before it asks for a password.

## What is deleted

The data side is `deleteUserCascade` (`server/lib/user-deletion.js`), the same cascade a platform
admin's **Delete user** runs:

- the account (email, name, password hash, single sign-on link, TOTP secret and recovery codes,
  passkeys, preferences, API tokens, Canva connections, which are revoked at Canva);
- every organization they own **that has no other member**, with all of its workspaces, screens,
  content and files on disk, playlists, schedules, walls, widgets, integrations and their
  credentials;
- in organizations they do **not** own, nothing of the organization's: what they made there is
  reassigned to the organization's owner, and their name is removed from it.

Refused, with nothing changed:

| Refusal | HTTP | `code` | What to do |
|---|---|---|---|
| A recovery (break-glass) or support session | 403 | `session_not_eligible` | Sign in as the account holder. |
| The server's last platform admin | 409 | `last_platform_admin` | Make another account a platform admin first (Platform → Users). |
| Owns an organization with other members | 409 | `org_has_other_members` | Transfer ownership or remove the members (Members), then delete. |
| Stripe could not cancel the subscription | 502 | `billing_cancel_failed` | Try again; nothing was deleted. |

On a hosted server (Stripe configured), every live subscription of the account is cancelled
**immediately and before** the delete: the one on the user row, any on the organizations that go,
and any other live one Stripe lists for the customer (a double checkout leaves two). A failure
stops the deletion, so a deleted account is never still being charged. Self-hosted servers have
no billing and skip this.

Sessions end: the account's `token_version` is bumped, then the user row is deleted, so every old
token fails as `user_not_found`; API tokens go with the row (`ON DELETE CASCADE`) and the API-token
middleware refuses a token whose owner is gone.

The audit log keeps one `account_self_deleted` row with `user_id` NULL and the account's internal
id, the number of organizations deleted and of subscriptions cancelled. It keeps no email or name.
If email is configured, a receipt goes to the deleted address.

**Backups** are not rewritten. On screentinker.com database backups are kept 14 days, and uploaded
files can remain in the monthly content archives for up to 12 months (`backup.sh`: 7 daily and 12
monthly content snapshots). Archives are for disaster recovery only and are never used to restore a
deleted account. A self-hosted server keeps what its operator configured
(`scripts/backup.sh` keeps database snapshots 30 days by default).

## Re-authentication

A session alone is not enough: a token taken from an unlocked laptop or by XSS must not be able to
delete the account. The account proves the person is there, in one of two ways
(`server/lib/account-deletion.js`):

- **Password accounts** type the password, plus the TOTP code (or a recovery code) when two-factor
  is on. Wrong passwords count toward the per-account login lockout.
- **Accounts with no password** (single sign-on, or a local account that has none) have nothing to
  type, so they must have **signed in within the last 10 minutes**. Every session token carries
  `auth_time`, the moment of the actual sign-in. Only the sign-in finishers set it (password login,
  TOTP step, passkey, OIDC/SAML callback, the Manager app's SSO hand-off, signup). Re-minted tokens
  (workspace switch, TOTP change, "sign out everywhere else") carry the old value forward, and a
  token from before this change has none, which counts as "not recent". The dialog's **Sign in
  again** signs the browser out, runs the account's own SSO start
  (`/api/auth/(oidc|saml)/<slug>/start`, through the Manager app's browser hand-off inside the app),
  and comes back to the deletion page.

Either way the email address must be typed out as confirmation.

Why not a separate step-up token: the sign-in proof already exists at the identity provider, and
`auth_time` reuses it without a new token type, a new endpoint, or a second credential a provider
would have to be configured for. Ten minutes is long enough to read the page and short enough that
an old session is useless.

## API

Both routes are dashboard-session (JWT) only. An `st_` API token gets 401: like every
`/api/auth` route they are outside the public OpenAPI contract, which says so in its description.

### `GET /api/auth/me/deletion`

What would be deleted and what is in the way. Read-only.

```json
{
  "email": "pat@example.com",
  "blocked": null,
  "reauth": { "method": "password", "totp_required": true, "recent_sign_in": false,
              "window_seconds": 600, "sso_start": null },
  "owned_organizations": [{ "id": "…", "name": "Pat's organization", "shared": false, "members": 1,
                            "workspaces": 1, "screens": 3, "content": 41, "playlists": 2 }],
  "other_organizations": 0,
  "subscription": { "active": true, "status": "active", "plan_id": "pro" }
}
```

`blocked` is `null`, `session_not_eligible`, `last_platform_admin` or `org_has_other_members`.
`reauth.method` is `password` or `recent_sign_in`.

### `DELETE /api/auth/me`

Body: `{ "confirm": "<the account's email>", "password": "…", "code": "123456" }`
(`password` and `code` only for password accounts; `code` only with two-factor on).

| Status | `code` | Meaning |
|---|---|---|
| 200 | | `{ deleted: true, organizations_deleted, subscriptions_cancelled, files_removed }` |
| 400 | `confirm_mismatch` | The typed email does not match. |
| 403 | `reauth_failed` | Wrong password. |
| 403 | `reauth_code_required` | Two-factor code missing or wrong. |
| 403 | `reauth_recent_sign_in_required` | No password, and no sign-in in the last 10 minutes. The body carries `sso_start` and `window_seconds`. |
| 403 | `session_not_eligible` | Recovery or support session. |
| 409 | `last_platform_admin`, `org_has_other_members` | See the table above. |
| 429 | | Rate limit (5 per minute per IP), or the login / TOTP lockout. |
| 502 | `billing_cancel_failed` | Stripe refused; nothing deleted. |

Wrong credentials answer 403, never 401: the dashboard treats a 401 as "signed out".

On a scale-out replica, an account that is only a copy (all its workspaces copied, no password hash
here) is deleted on the primary: both routes forward the request there, like `POST /login` does.
Deleting the copy alone would leave the real account, and its subscription, in place.

Tests: `server/test/account-self-delete.test.js` (real schema, the auth router, a Stripe double)
and `server/test/account-self-delete-server.test.js` (a real `server.js`: rate limit, the public
page and its CSP, the privacy-policy wording, locale parity).
