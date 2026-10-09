# Canva

Import Canva designs into the content library, and keep them up to date. When someone changes a
design in Canva, the screens that show it pick up the new version.

- [Set up the Canva integration](#set-up-the-canva-integration)
- [Connect your Canva account](#connect-your-canva-account)
- [Import a design](#import-a-design)
- [Keeping designs in sync](#keeping-designs-in-sync)
- [Privacy and security](#privacy-and-security)
- [Troubleshooting](#troubleshooting)

---

## Set up the Canva integration

ScreenTinker talks to Canva through a **Canva integration**, which is an app you create in the
Canva Developer Portal. You only need to do this once. It can be set up in either of two places:

- **For your organization** (org owners and admins): Settings → **Canva integration**. Use this to
  bring your own Canva Enterprise or Teams integration.
- **For the whole server** (operators): set `CANVA_CLIENT_ID` and `CANVA_CLIENT_SECRET` in the
  environment and restart. Every organization without its own integration uses this one.

An organization's own integration takes priority over the server's.

### Create the integration in Canva

1. Go to the [Canva Developer Portal](https://www.canva.com/developers/integrations/connect-api)
   and create a **Connect API** integration (a public integration if people outside your Canva
   team will connect, otherwise private).
2. Under **Scopes**, enable:
   - `design:meta:read`: list designs and read their titles and pages
   - `design:content:read`: export designs
   - `profile:read`: show whose Canva account is connected
3. Under **Authentication**, add this **redirect URL**. Settings shows the exact value for your
   server:
   ```
   https://<your-server>/api/canva/callback
   ```
4. Copy the **client ID**, generate a **client secret**, and paste both into Settings → Canva
   integration (or into the environment variables above). Press **Test**.

The secret is stored encrypted and never shown again. To change it, type a new one. Leave the
field empty to keep the current secret.

> **Test** checks the client ID and secret with Canva. It can't check the redirect URL or scopes;
> the first **Connect Canva** does that.

---

## Connect your Canva account

In **Content**, choose **Add content → Canva**, then **Connect Canva**. Sign in to Canva and allow
access, and you come back to the library connected. Each person connects their own Canva account. ScreenTinker
sees only the designs that account can see in Canva.

**Disconnect** revokes the access at Canva. Items you already imported stay in the library, but
they stop updating.

---

## Import a design

**Add from Canva** opens your designs, newest first, with search.

1. Choose a design.
2. Choose the pages you want, and a format:
   - **Images (one per page)**: each page becomes its own PNG item. Best for menus, posters and
     slides.
   - **Video (MP4)**: the pages you chose become one video. Use this for designs with animation
     or video.
3. Optionally, tick **Also create a playlist in page order**.
4. Press **Import**. Canva renders the export, which can take from a few seconds to a few
   minutes for long videos.

Imported items count toward your storage like any upload, and they behave like any other content:
tags, folders, scheduling, approvals and version history all apply.

---

## Keeping designs in sync

Imported items show **Linked to Canva**. ScreenTinker checks linked designs every 30 minutes. When
a design has changed in Canva, it exports the linked pages again and replaces the items' files.

- **Sync now** on an item checks immediately. If that item is already syncing, wait for it to
  finish and try again. Through the API, `{"force": true}` re-exports even an unchanged design;
  only the person who imported the item, or a workspace or organization admin, can force a sync.
- A design that hasn't changed isn't exported again, and nothing is rewritten.
- A replacement works exactly like **Replace file**. Screens download the new version, version
  history keeps the old one, and **if your workspace requires approval, the new version waits as a
  draft** until it's approved.
- Sync uses the Canva account of the person who imported the item. If that person disconnects,
  or loses access to the design, the badge shows **last sync failed**. Hover over it to see the
  reason.
- If you delete a page in Canva that an item is linked to, that item reports the problem and
  keeps showing the last version.
- A sync can only change what the person who imported the item could change with **Replace
  file**. The item stops syncing, keeps its last version, and shows **last sync failed** when:
  - that person's account is deleted;
  - they are no longer an editor or admin of the workspace;
  - head office uses the item in a corporate playlist, and that person isn't allowed to change
    corporate content. Someone who can (an organization admin) can import the design again.

---

## Privacy and security

- **Tokens and secrets:** Canva tokens and the integration secret are stored encrypted. No API
  response ever includes them.
- **API tokens:** the Canva endpoints accept a signed-in dashboard session only. A ScreenTinker
  API token can't use someone's Canva connection.
- **Sign-in:** Connect uses OAuth 2.0 with PKCE. The sign-in is tied to the browser that started
  it.
- **Downloads:** export files are downloaded only from canva.com addresses.

---

## Troubleshooting

| Message | What to do |
|---|---|
| "Canva is not set up" | An org admin adds the integration in Settings, or an operator sets `CANVA_CLIENT_ID` / `CANVA_CLIENT_SECRET`. |
| Canva shows an error about the redirect URL | The redirect URL in the Canva integration must match the one in Settings exactly, including `https` and the host. If you use a reverse proxy, set `APP_URL`. |
| "Canva did not accept this client ID and secret" | Generate a new secret in the Developer Portal and save it again. |
| "Connect Canva again" | The Canva connection expired or was revoked. Press **Connect Canva**. |
| "Canva is rate-limiting requests" | Wait a minute and try again. |
