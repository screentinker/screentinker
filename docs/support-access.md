# Support access

How ScreenTinker support gets into a self-hosted instance: **only when you ask, for a few hours,
visibly, and revocably.** Nothing about it is automatic, and there is no standing account.

## The rule it is built around

A vendor-signed token that every install accepts would be a key to every install. So a token on
its own is worthless here — it must name a **request code that your instance generated**, and that
code is single-use. Our signature proves the token came from us; your request code proves you
asked. Without a fresh code from you, our key mints nothing usable anywhere.

## The flow

1. **You** (an admin) open *Settings → Support Access* and click **Generate support request code**.
   You get a code like `K7QP-M3XW-2VHT-9RDC`, valid for 24 hours, single use. Send it to support
   with your ticket.
2. **We** sign a support token against that code, for a stated number of hours (1–72, normally 4)
   and a stated reason.
3. **We** open your login page, expand *Support Access* at the bottom, and paste the token.
   Your instance checks the signature against the public key it ships with, checks the code is
   one it issued and still open, consumes the code, and opens a session.
4. **You** see the session under *Settings → Support Access → Active support sessions* — who
   issued it, why, when it was first used and from where, when it expires — with an **End session**
   button. Ending it takes effect on the very next request the session makes.

Every step lands in your activity log: `support_request_created`, `support_login`,
`support_login_failed`, `support_session_revoked`.

## What a support session can and cannot do

The session is a `platform_operator` — cross-organisation staff, not an owner. It can see and act in
your workspaces the way an engineer needs to (devices, playlists, content, logs, settings). It
**cannot** manage users or roles, touch billing, delete organisations or workspaces, change
branding, or mint further support access. Any owner-level endpoint added later denies it
automatically, because it is outside `PLATFORM_ROLES`.

The session's own token expires exactly when the grant does; there is nothing to clean up.

## Trusting a different support desk (or none)

The public key in `server/lib/support-access.js` is ScreenTinker's. If you run your own support
organisation, or simply do not want ours to be able to redeem tokens even with your consent, set
`SUPPORT_PUBLIC_KEY` to a key of your own (PEM, `\n` accepted for newlines) and our tokens verify
nowhere on your install. `node scripts/support-keygen.js <private-key-path>` produces a pair.

To issue tokens, an instance needs the matching private key in `SUPPORT_SIGNING_KEY_FILE`. Only
then does *Settings → Support Access* show the token generator, and only to platform admins; on
every other instance `POST /api/auth/support/generate` does not exist (404).

## Endpoints

| Method | Path | Who | What |
|---|---|---|---|
| `POST` | `/api/auth/support/request` | admin | mint a request code |
| `GET` | `/api/auth/support/status` | admin | open requests, live sessions, `can_issue` |
| `DELETE` | `/api/auth/support/request/:code` | admin | withdraw a request |
| `DELETE` | `/api/auth/support/grant/:jti` | admin | end a session |
| `POST` | `/api/auth/support` | nobody (the token is the credential) | redeem a token → session. 5/min per IP |
| `POST` | `/api/auth/support/generate` | platform admin, issuing instance only | sign a token against a request code |

## Token format

`STSUP1.<base64url payload>.<base64url Ed25519 signature>` — deliberately not a JWT: no algorithm
field to confuse, and unmistakable in a log. Payload: `v`, `iss`, `sub` (customer name), `req`
(request code), `reason`, `by` (issuer email), `jti`, `iat`, `exp`.
