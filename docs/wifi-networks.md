# Wi-Fi networks of a screen

Tell an Android screen which Wi-Fi networks it should know, from the dashboard. You need no visit
to the screen. The typical case is a panel that moves, for example in a vehicle that goes from site
to site, or a screen behind a locked-down vendor menu.

The feature is native Android player only (it declares `net.wifi`). Other players do not show the
section.

## Adding a network

1. Open the display → **Controls** → **Wi-Fi networks**.
2. **Add network**. Enter the network name (SSID) and choose the security:
   - **WPA2 (password)**: a password of 8 to 63 characters, or a 64-digit hexadecimal key. The
     hexadecimal key works only where the network is saved (modes owner and direct), not as a
     suggestion.
   - **WPA3 (password)**: Android 10 or newer as a suggestion, Android 11 or newer as a saved
     network.
   - **Open (no password)**.
3. Optional: **Priority** (0–100, higher is preferred) and **Hidden network**, for a network that
   does not broadcast its name.
4. **Save**. If the screen is online, it gets the list at once. Otherwise it gets it the next time
   it connects.

Each row then shows what the screen reported:

| Status | Meaning |
|---|---|
| Saved on the screen | The network is saved on the panel and Android may join it. |
| Suggested to Android | Suggestions mode (see below): Android knows the network but decides itself. |
| Held back | The screen is connected on this network right now. The change waits (see *A screen never strands itself*). |
| Not supported here | For example WPA3 on Android 9, or a hidden network in suggestions mode on Android 10. |
| Failed | Android refused it, or a network with the same name was set up on the screen by hand. A refused change leaves the previous network in place. |
| Not delivered | The server did not send the list: the connection is not HTTPS, or a stored password can no longer be read. |

A screen holds at most 16 managed networks.

## What the screen can do: the mode

The player reports how it can manage networks, and the section says so:

| Mode | When | What it means |
|---|---|---|
| **owner** | The player is the device owner ([provisioning](device-owner-provisioning.md)) | Networks are saved and switched reliably. |
| **direct** | Android 9 or older | Networks are saved directly. |
| **suggestions** | Android 10 or newer, not device owner | **Suggested, not enforced.** Android only lets an ordinary app *suggest* networks. Android may decline them, and the screen may ask once on its own display to allow suggestions. Make the player device owner to manage networks reliably. |
| **unsupported** | No Wi-Fi hardware | Nothing to manage. |

Priority is used for suggestions. For saved networks, Android 8 and newer ignore it and choose by
signal and history.

## Only its own networks

The screen manages only the networks added here. It keeps its own list of them. A network
configured on the panel by hand is never changed or removed. If one with the same name already
exists, the new entry is refused ("set up on the screen by hand") instead of taking it over.

## A screen never strands itself

A wrong password must not take a panel offline that nobody can reach. So:

- New networks are added first, then changes are made, then removals.
- The network the screen is connected on right now is **never** changed or removed. The step is
  held back until the screen is no longer on it, because it moved to another managed network or
  because that connection dropped on its own. A new password for the network in use is therefore
  applied exactly when the old one stops working, for example after the router's password changed.
- On Android 10 and newer, Android hides which Wi-Fi a screen is on unless the player has location
  permission. Without it, the screen cannot tell, so it changes or removes nothing while Wi-Fi is
  its connection. It does those steps when the screen is on Ethernet, or once the player has
  location access. A device owner grants itself that permission.

Removing a screen from the dashboard, or unpairing it, leaves its networks on the panel: a screen
that has lost its pairing still needs a network to be paired again. If the panel is later paired as
a new screen, it lets go of them. They stay on the panel and count as set up by hand from then on.
Moving a screen to another workspace removes the list on the server. On its next connect the screen
drops the networks it managed, except the one it is connected on, which it keeps under the rule
above.

## Passwords and HTTPS

- The password is **write-only**. The dashboard and the API say only whether one is set. Leaving
  the field empty when you edit a network keeps the stored password.
- It is stored encrypted on the server. On the screen it is kept in an Android Keystore-backed
  store, or not kept at all if that store is unavailable. The server sends the list again on every
  connect.
- It never appears in device lists, exports, logs, API tokens or the MCP tools. The Wi-Fi routes
  are for signed-in people only. Every change is written to the activity log with who, which
  screen and which network, never with the password.
- It is not part of an organization export or import, and it is not copied to scale-out replicas.
  A screen connected through a replica is not sent the list.

> ⚠️ **The list is only sent over HTTPS.** The server hands it to a screen only when that screen's
> connection is TLS: either ScreenTinker itself serves HTTPS (`certs/cert.pem`), or a reverse proxy
> on the same machine, on your LAN or Cloudflare terminates TLS and sends `X-Forwarded-Proto: https`.
> The forwarded header is believed only from those proxies, never from any other address. Without
> HTTPS the section says **Not delivered: this screen's connection to the server is not HTTPS**.
>
> An install that only runs on a LAN it trusts end to end can set `WIFI_ALLOW_INSECURE=1`. Wi-Fi
> passwords then cross that LAN in clear text. The server logs a warning at every start, and the
> section says that the setting is on.
