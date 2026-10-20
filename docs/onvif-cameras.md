# ONVIF cameras

ONVIF is the standard most security cameras speak. With it, ScreenTinker can find cameras on the
network, ask a camera for its stream address, use its snapshot as the item's thumbnail and, on a
camera that has it, pan, tilt and zoom.

A camera added this way is an ordinary **live stream** (`video/rtsp`) item. Every screen that plays
RTSP or RTSPS today plays it, with no player update needed. What ONVIF adds is how the item gets
made and kept up to date.

## Adding a camera

**Add content → ONVIF camera.**

1. **Reach the cameras from.** Cameras are on a private network, so something on that network has
   to talk to them:
   - **A screen** on the cameras' network (Android or the Raspberry Pi / Windows player, 3.0.2 or
     later). The server sends its requests through that screen. This is how a hosted server, which
     can't see your LAN, reaches your cameras.
   - **This server**, if it runs on the same network. Only offered when an administrator opened
     private networks to the server (see [Allowing the server itself](#allowing-the-server-itself)).
2. **Search the network** (WS-Discovery) and pick a camera, or type its address: `192.168.1.20`,
   `cam.local:8080`, or a full `http://…/onvif/device_service` URL.
3. **Username and password**, then **Connect**. ScreenTinker reads the camera's clock first:
   ONVIF cameras refuse a sign-in more than a few seconds off their own time, so a camera with the
   wrong date still works.
4. Choose the **stream**. The first one is usually the full-quality stream; a sub-stream saves
   bandwidth on a small zone. A stream marked **PTZ** can be steered.
5. **Add camera**. The stream address is resolved now and stored with the camera's credentials,
   which is how every player opens an authenticated RTSP stream.

## After it's added

The item's **Edit details** has an **ONVIF camera** section. Everything in it acts on the camera at
once; nothing waits for **Save**.

- **New snapshot**: the camera's current picture becomes the thumbnail.
- **Ask for the stream address again**: after the camera changed IP address, firmware or
  password. A failed attempt changes nothing.
- **Change the camera password**: checked against the camera before it's stored, so a typo is
  refused rather than saved.
- **Pan, tilt and zoom** (PTZ cameras): hold an arrow to move, let go to stop. Each move tells the
  camera to stop by itself after one second, so a lost "stop" (a closed laptop, a dropped Wi-Fi)
  can't leave it turning. **Home** and the camera's own **presets** are there too.

## The password

- It's stored on the server **encrypted** (`content.onvif_secret`, the same encryption as other
  stored keys) and is **never sent back** to a browser, not even masked: the dashboard only knows
  whether one is stored.
- The stream address the screens open carries the credentials, as any camera URL does. In the
  dashboard it's shown with the password as stars, like every other camera address.
- Changing the server's `JWT_SECRET` makes stored ONVIF passwords unreadable (as with other stored
  keys). Enter them again under **Change the camera password**.

## A screen as the bridge: what it may do

A screen relays for the server, and that's all it does. The player itself enforces these limits,
whatever the server asks:

| Operation | What the screen does |
| --- | --- |
| `probe` | Sends the standard WS-Discovery Probe (multicast `239.255.255.250:3702`, or one host's `:3702`) and returns the replies: at most 64, 64 KB each. |
| `soap` | POSTs a SOAP request (at most 64 KB) to a camera and returns the reply (at most 1 MB). |
| `get` | Fetches a snapshot image (at most 2 MB). |

- **Private addresses only:** 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, fc00::/7 and
  fe80::/10.
  - Never loopback, never the cloud metadata address, never a public address.
  - Every address a name resolves to must be private, and the screen connects to the address it
    checked.
- Only `content-type` and `authorization` headers are passed on. Redirects are not followed.
- At most 4 operations at once.
- `onvif_relay` is **not** a command anyone can send through the REST API or a screen's local API.
  Only the server's own ONVIF code sends it, and never to an offline screen.

The ONVIF routes (`/api/onvif/…`) are for signed-in people only, not API tokens: they reach into
your network through your screens. Changing a camera needs a role above viewer.

## Allowing the server itself

The server reaches private addresses only where an administrator allowed it
([outbound-requests.md](outbound-requests.md)):

- `OUTBOUND_ALLOW_PRIVATE=1`: the server may search and reach every camera on its networks.
- `OUTBOUND_ALLOW_HOSTS=192.168.1.0/24` (or names): the server may reach those cameras by address,
  but **Search the network** stays off. Discovery is a multicast to the whole LAN.

A hosted server never sets either; use a screen.

## Notes

- **Authentication:** ONVIF's WS-Security UsernameToken on every request. Cameras that also want
  HTTP Digest (several Hikvision, Dahua and Axis firmwares) get both. Snapshots use Digest or Basic,
  whichever the camera asks for.
- **Media and Media2:** older cameras answer Media (ver10), newer ones may offer only Media2
  (ver20). Both are handled, as is firmware without `GetServices`.
- **Addresses cameras get wrong:** a camera behind NAT, or with several interfaces, often
  advertises service addresses you can't reach, or a stream at `0.0.0.0`. ScreenTinker keeps
  each service's port and path but uses the host you reached the camera on.
- **No ONVIF events or recordings:** this is live view, snapshots and PTZ.
- API: `GET /api/onvif/bridges`, `POST /api/onvif/discover {via, host?}`,
  `POST /api/onvif/inspect {via, xaddr|host, username, password}`, `POST /api/onvif/cameras`,
  `GET /api/onvif/cameras/:id`, `POST /api/onvif/cameras/:id/{refresh,snapshot,ptz}`,
  `GET /api/onvif/cameras/:id/presets`. A refused camera password is `422` with
  `code: "not-authorized"`, never `401` (that would sign the person out of the dashboard).
