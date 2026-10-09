# View-only display access

Let someone watch what a display is showing from any browser, without pairing anything and without
any control over it. Typical uses: a reception desk watching the lobby screen, a client approving
what plays in their store, a production room keeping an eye on a stage display.

A viewer is **not a display**. It never pairs, never receives commands, never counts toward a plan's
screen limit and never appears in the displays list. The way screens connect today, by pairing code,
by `/player`, or by the web-player (vMix) URL, does not change.

## Turning it on

1. Open the display → **Device Info** → **View-only access**.
2. Tick **Allow view-only access**. A share link is created: `https://<your-server>/view/<token>`.
3. Copy the link and send it to whoever should watch.

Only **workspace admins** (and organization owners/admins) can turn it on, see the link, regenerate it
or change networks. Editors and viewers see whether it is on. API tokens cannot manage it.

| Action | Effect |
|---|---|
| **Regenerate link** | A new link is created; the old one stops working **immediately**. Anyone watching through it sees "This view is no longer available" within a few seconds. |
| Untick **Allow view-only access** | Every viewer (link and network) is disconnected within a few seconds. Ticking it again brings back the **same** link — use Regenerate to revoke it. |
| Remove the display | Its link and networks go with it. |

Every one of these is written to the activity log, with who did it and from where. The token itself
never is.

## Allowed networks (optional)

List network ranges, one per line, e.g. `192.168.1.0/24` or `10.20.0.0/16` (IPv6 works too). Devices
on those networks can open the display's **network address**, `https://<your-server>/view/screen/<display-id>`,
with no link at all. That suits wall-mounted tablets on your own LAN. The share link keeps working from
anywhere.

Ranges are validated when you save. A typo is refused, and so is `0.0.0.0/0`, which would mean
everyone (that is what the share link is for). Up to 32 ranges.

### Behind a reverse proxy

The network check uses the **TCP peer address** only. It does **not** reuse the server's general
proxy trust (which believes every private address), because for an access decision that would let any
host on your LAN claim to be inside a range by sending `X-Forwarded-For`.

If ScreenTinker sits behind nginx, Traefik, Caddy or a load balancer, every viewer appears to come from
that proxy. List it so its `X-Forwarded-For` is believed:

```
VIEW_TRUSTED_PROXIES=127.0.0.1,172.18.0.0/16
```

Comma-separated addresses or CIDRs (the `proxy-addr` names `loopback`, `linklocal` and
`uniquelocal` also work). Only list proxies you run. Cloudflare in front of the server is a proxy
too: list its ranges only if you understand that anyone who can reach Cloudflare can then be judged
by the address Cloudflare reports.

## Turning the feature off for a whole server

```
VIEW_ONLY_ENABLED=false
```

Every `/view` address answers 404, the card disappears from the dashboard, and per-display settings are
kept (switching it back on restores them). Default: on when `SELF_HOSTED=true`, off otherwise.

## What a viewer gets, and what it does not

The viewer is the same web player the screens use, in a read-only mode. It fetches the display's
content every 4 seconds from `/api/view/…/payload` and joins the screen at the item and position the
screen is on.

It receives only what is needed to draw the screen: the playlist items, layout, orientation, background
and default content. It **never** receives:

- the device token, enrolment key or settings PIN;
- trigger or local-API secrets, endpoint headers, emergency codes or the power schedule;
- a meeting-room display's booking capability (room pages render read-only);
- anything about other displays or the workspace.

It opens no socket, sends nothing back, takes no screenshots and shows no device information. It keeps
its storage in memory, so a viewer opened on a computer that also runs a web player cannot disturb it.

Responses are `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, so the link does not leak
to media hosts. `/view` routes are rate-limited per IP (240 requests a minute; one viewer uses 15).

## Old browsers

Add `?legacy=1` (`/view/<token>?legacy=1`) for the ES5 build, the same one `/player/legacy` serves to
older screens.

## Limits

- **Sync.** Each screen runs its own playlist clock. A viewer lines up with the screen whenever the
  screen starts an item, so it is normally within a second, and may run up to one poll (4 s) behind
  after the screen skips or is changed by hand.
- **Main area only.** Multi-zone layouts render, but only the main area is lined up with the screen.
  Side zones run from their own start.
- **Video walls** show as one full-frame picture, not the wall's tiles.
- **After a server restart** a viewer starts at the top of the playlist until the screen's next item.
- **Webpages** that refuse to be framed (`X-Frame-Options`) show a note instead, as in the dashboard
  preview.
