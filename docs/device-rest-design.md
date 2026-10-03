# Device REST

A screen talking HTTP on the network it is actually plugged into — outbound (parts 1 and 2) and
inbound (part 3).

## Why the server cannot do any of this

Signage sits on the customer's LAN, in a rack, next to the things worth talking to: a PLC, a door
sensor, an occupancy counter, a Crestron or AMX processor, a local Home Assistant. The ScreenTinker
server is frequently in another country, reached through an outbound-only firewall, and has no route
to that `192.168.x.x` at all.

So a server-side implementation of any of this is not a worse version of the feature — it is not the
feature. Proxying an outbound request through the server would fail to connect. Polling from the
server would fail to connect. And on the inbound side, telling an installer to drive the dashboard
means telling them to obtain a browser, a login and a WAN path, which is three things a room control
system does not have and will not be given.

The other half of the reason is the WAN itself. A shop's uplink goes down; the sign keeps playing,
because that is the point of this product. A feature that stops working when the WAN does is a
feature that is absent exactly when someone is standing in front of the screen wondering why.

## The three parts

| | What it is | Direction |
|---|---|---|
| 1 | `http_request` — a command that makes the panel perform one HTTP request and return up to 64 KiB | out |
| 2 | Saved endpoints — named definitions the panel runs on a timer or a player event | out |
| 3 | The local REST door — `GET /api/status` and `POST /api/command` **on the panel** | in |

Part 1 needs an operator holding the dashboard open. Part 2 is the same request without anyone
watching. Part 3 is the other direction entirely, and is the one with a security story worth reading.

## Part 3: the inbound door

`GET /api/status` and `POST /api/command`, served by the panel itself on the trigger HTTP port
(default **8079**).

### It is the same socket as the trigger door, and not the same permission

`TriggerListeners` already opens an inbound HTTP door on that port. Part 3 extends it rather than
opening a second socket, because that file's own header says why: *"BOTH CONVERGE ON ONE HANDLER …
If a transport ever grows its own resolution the two doors drift and only one of them gets the next
security fix."* A second listener on 8787 would have been precisely that.

⚠️ **But sharing the socket must not share the permission.** `triggers_accept_http` means *a LAN host
may put an overlay on this screen*. `local_api_enabled` means *a LAN host may change what this screen
is doing*. They are separate columns, separate routes, separate secrets, and each path inside the
handler is gated on its own flag:

- triggers on, control off → the socket serves triggers; `/api/command` is **404**
- control on, triggers off → the socket serves the control API; a trigger POST is **404**
- both off → the socket does not bind at all

One flag for both would have handed remote control to every site that only ever wanted an emergency
overlay, and the two get enabled months apart, by different people, for different reasons.

### The command set is much smaller than what a token can send

`LocalApi.COMMANDS`: `refresh`, `screen_on`, `screen_off`, `set_volume`, `set_brightness`,
`set_system_brightness`.

The reasoning is about **who the caller is**, not what the panel can do. A dashboard command carries
a session or a `full` API token held by someone who can already see the whole fleet. This one carries
a secret that will be typed into a Crestron program, committed to a site's integration repo, mailed
to a subcontractor, and left in place for the life of the building. It is a room-control credential,
so it gets the room-control command set.

What is deliberately absent, and why:

| Command | Why not |
|---|---|
| `shell`, `install_apk`, `update` | code execution and software installation from a credential that lives in a building's integration repo |
| `set_server_url` | repoints the panel at another server: a complete takeover of the screen from inside the LAN, reversible only by visiting it |
| `http_request` | would make every panel a request relay. The caller is already on the LAN so it is not new *reach* — it is **laundering**: the request arrives at the PLC from the screen, with the screen's credentials, and the audit trail names the screen |
| `launch` | starts an arbitrary app on the panel |
| `settings`, `kiosk_unlock` | the way out of kiosk mode, which is the thing kiosk mode is |
| `set_time`, `set_timezone` | a wrong clock breaks every schedule at once, and the symptom blames the schedule |
| `set_power_schedule` | a definition, not a room action — it belongs to whoever owns the site's operating hours |
| `reboot`, `shutdown` | the genuinely arguable one. Everything on the list above is undone by sending its opposite; these are not. A reboot loop from a stuck automation is a fleet on the floor, and a rebooting panel cannot be told to stop. Adding it later is one line; taking it back is a site visit |

The panel enforces this list. The server's `LOCAL_API_COMMANDS` is documentation — the server is not
in the request path — and `server/test/local-api-allowlist.test.js` holds the two to each other,
because two copies of a security decision in two languages will otherwise drift silently.

### ⚠️ The firewall implication, stated plainly

Enabling this **opens a listening TCP port on the customer's network**. Anything that can route to
the panel can reach it. There is no TLS (the panel has no certificate for its own LAN address, and
the gear calling it frequently has no TLS support at all — AMX NetLinx has none anywhere in the
language), so the secret crosses the segment in cleartext and anyone able to capture traffic can
read it.

That is the same exposure the trigger door already carries, and the mitigations are the same:

- **Off by default**, per device, and off is the state a screen ships in.
- **Segment it.** If the network the panel is on is not one you would hand a room-control key to,
  the port should not be reachable from it. Put signage on its own VLAN.
- **Per-device secrets.** A compromise is one screen, not an estate, and rotation is one call.
- **Rate limited** on the panel — 2/s per source, burst 5, 10/s globally — which does not stop a
  determined flood from a LAN (nothing on the panel can) but bounds the work one causes, so a chatty
  or hostile sender cannot turn a screen into a strobe.
- **A 16-character floor** on the secret, because this is guessable offline as fast as the limiter
  allows, forever, with no lockout and no audit trail.

The honest summary: this is a feature you turn on for one screen, on a network you control, because
a room control system needs it. It is not a feature to enable fleet-wide because it might be handy.

### The reply is written before the command runs

`screen_off` blanks the panel and `refresh` tears down the WebView. Running either while still
holding the response would hand a control system a dropped connection on a command that **worked** —
and a control system reads a dropped connection as failure and retries, so one operator action
becomes four. The socket is flushed and closed first, then the command is dispatched.

### Everything reaches one dispatcher

`WebSocketService.dispatchCommand` was extracted from the `device:command` handler for this. A LAN
command and a dashboard command are the same command, decided in the same `when (type)`. The
alternative — a second dispatch behind the local door — is two implementations of every command the
door accepts, drifting in the direction where one door does something the other does not.

### Known limitation: the door is Activity-scoped

The trigger stack is assembled in `MainActivity`, because the trigger overlay is a `View` and cannot
live anywhere else. The control door shares its socket, so it shares that lifetime: if the Activity
is destroyed, the door closes until it comes back.

In practice a signage panel holds its Activity for weeks and process death restarts it. The case to
watch is a screen inside a scheduled-off window — which is also the case where `screen_on` matters
most. Moving the socket to the foreground service is the fix, and it is a larger change than this
one. It is written down here so the next person finds it stated rather than discovers it.

## Status body

`GET /api/status` answers: `device_id`, `name`, `app_version`, `connected` (to the ScreenTinker
server), `screen` (`on` / `scheduled_off`), `uptime_ms`.

⚠️ Nothing secret, and the exclusions are deliberate: not the device token, not the trigger secret,
not the local API secret, not the settings PIN, and **not the server URL** — a screen in a lobby
should not tell the lobby's network who runs it.

## Enabling it

```
POST /api/devices/:id/local-api-secret   { "rotate": true }   -> the secret, once, to a human
POST /api/devices/:id/local-api          { "enabled": true }
```

Enabling without a secret is refused at the door rather than accepted. The panel would answer
`503 no_secret_configured` to every request, but an operator who ticks a box and walks away believes
the door is open — and a working configuration and a quietly dead one look identical from the
dashboard.

Then, from the LAN:

```
curl -H 'Authorization: Bearer <secret>' http://<panel>:8079/api/status
curl -H 'Authorization: Bearer <secret>' -d '{"type":"screen_off"}' http://<panel>:8079/api/command
```

`?secret=<secret>` works instead of the header, for AMX NetLinx and Extron Global Scripter, which
cannot set a request header at all. ⚠️ It is a real cost, not a free convenience: a query secret lands
in proxy logs and diagnostics on the way. The panel logs a warning the first time one arrives, once,
so a site that *can* send a header finds out that it should.

## Platforms

Android only. `net.http_request` is in no capability baseline, so a fielded player is refused the
outbound command rather than sent something it would drop; the inbound door simply does not exist on
the other players. The web player has its own trigger HTTP door (`startTriggerHttp` in
`server/player/index.html`) and part 3 has deliberately **not** been added to it yet — that door is
reachable from a browser tab, which is a different threat model and wants its own thinking.
