# Embedded Renderer for Digital Signage (E-Paper, Smart LED Matrices & MCU Displays)

ScreenTinker includes a dedicated server-side embedded renderer designed for lightweight microcontrollers (MCUs) such as the **ESP32-S3 / ESP32-C6 / ESP32-C3**, **Raspberry Pi Pico W**, the **Seeed Studio reTerminal Sticky** (3.97" B/W E-Paper 800×480 with SSD1677), the **Seeed Studio reTerminal E-Series** (`E1001` 7.5" Mono, `E1002` 7.3" 6-Color Spectra 6, `E1003` 10.3" 16-Level Grayscale, `E1004` 13.3" 6-Color Spectra 6), the **Seeed Studio XIAO Smart LED Controller** (`seeed-xiao-led` driving WS2812B / SK6812 addressable RGB LED strips and 2D matrices), and the **Elecrow CrowPanel 4.3" HMI Display** (`elecrow-crowpanel-43` 480×272 16-bit RGB565 RGB LCD).

Instead of requiring the display hardware to run a full web browser or render HTML/CSS, the embedded system periodically makes an HTTP `GET` request to the ScreenTinker server and receives a **pre-rendered, pre-dithered binary image** formatted specifically for its display panel.

---

## 1. Key Architectural Concepts

```
┌─────────────────────────┐                         ┌────────────────────────────────────┐
│   Embedded Device       │                         │   ScreenTinker Server              │
│  (e.g. reTerminal)      │                         │                                    │
│                         │   GET /api/embedded/    │                                    │
│ 1. Wake up from sleep   │ ──────────────────────> │ 1. Authenticate device token       │
│ 2. Send token & ETag    │      render             │ 2. Resolve active playlist item    │
│                         │                         │ 3. Check ETag (304 if unchanged)   │
│ 3. Receive 1-bit frame  │ <────────────────────── │ 4. Resize & Dither (FS / Atkinson) │
│    or 304 Not Modified  │   HTTP 200 (48 KB)      │ 5. Pack binary stream (SSD1677)    │
│ 4. Push to E-Paper      │      or 304             │ 6. Send X-ST-Expires-In header     │
│ 5. Deep sleep for N sec │                         └────────────────────────────────────┘
└─────────────────────────┘
```

### Autonomy & Efficiency
- **Zero local state needed:** The server maintains playlist timing and cursor progression (`embedded_cursor` table).
- **Deep sleep coordination:** The server sends the `X-ST-Expires-In` header telling the MCU exactly how many seconds to deep sleep before waking for the next frame. When a screen is in an off-window under its Display Power Schedule, `X-ST-Expires-In` automatically reflects the duration until the morning 'on' edge, allowing devices to sleep for hours uninterrupted.
- **Battery preservation via HTTP 304:** When content hasn't changed or the device is in a scheduled-off window, the server returns `304 Not Modified` on matching `If-None-Match: <etag>`, allowing the MCU to skip power-intensive E-Paper refreshes and SPI transfers.
- **Power schedule coordination:** Fully integrates with weekly Display Power Schedules (`X-ST-Power-State: on` vs `scheduled_off`). Devices sleep through off-hours without wasting battery or causing display wear.
- **Online status while asleep:** Every render answer records when the device is due back (now + `X-ST-Expires-In`). The dashboard and offline alerts count lateness from that moment, so a panel sleeping through a scheduled-off night stays online and only alerts if it misses its wake-up. Firmware should therefore sleep no longer than `X-ST-Expires-In`.

---

## 2. Device Registration, Lifecycle & Token Permanence

### 2.1 Does the Device Token expire or rotate?
**No, the `device_token` is permanent and does NOT rotate or expire automatically.**

Once provisioned, the `device_id` and `device_token` pair acts as a long-lived device credential. The MCU stores both values once in non-volatile storage (**NVS / Flash / EEPROM**) and uses them on every HTTP request.

The token remains valid indefinitely unless an administrator explicitly deletes the display from the ScreenTinker dashboard or re-pairs the device.

---

### 2.2 How to Register a New Embedded Display

There are two supported onboarding methods for embedded firmware:

#### Method A: 6-Digit REST Pairing Flow (Zero Hardcoding / Recommended for End Users)
1. **First Boot (Factory Unpaired State):**
   - The MCU connects to Wi-Fi.
   - The MCU calls `POST /api/embedded/pair/register` (sending only its screen profile and dimensions):
     ```json
     {
       "screen_profile": "seeed-reterminal-sticky",
       "screen_width": 800,
       "screen_height": 480
     }
     ```
   - The server mints a secure CSPRNG 6-digit code (`lib/numeric-code.js`), registers the device in `provisioning` status, creates a cryptographic 32-byte `claim_secret`, and returns:
     ```json
     {
       "status": "ok",
       "device_id": "<UUID>",
       "pairing_code": "545658",
       "claim_secret": "<32_BYTE_HEX>"
     }
     ```
   - The MCU renders the server-assigned 6-digit code on its E-Paper display and keeps `claim_secret` in RAM.
2. **Dashboard Claim:**
   - The user opens the ScreenTinker Web UI, goes to **Displays → Add Display**, and enters the 6-digit code shown on the screen.
3. **Credential Stamping:**
   - The MCU periodically checks `GET /api/embedded/pair/status?device_id=<UUID>` with header `Authorization: Bearer <claim_secret>`.
   - As soon as the user claims the display, the server verifies `claim_secret`, burns it in the database, and responds with:
     ```json
     { "paired": true, "status": "online", "device_id": "<UUID>", "device_token": "<SECRET_TOKEN>" }
     ```
   - The MCU writes `device_id` and `device_token` permanently to Flash/NVS.
4. **Regular Operation:**
   - The MCU enters the ultra-low-power sleep/wake loop, using standard HTTP `GET /api/embedded/render` with its stored `device_token`.

#### Method B: Pre-Provisioned Deployment (Batch Flashing / Fleet Setup)
If flashing devices in bulk:
1. Create or register the display row in ScreenTinker (via dashboard or REST API).
2. Burn the assigned `device_id` and `device_token` directly into the firmware's NVS partition or config header.
3. The MCU starts directly in **Regular Operation** without ever needing the pairing step.

---

### 2.3 Setting the Screen Profile

Once a device is registered, its hardware capabilities and dithering preferences are stored in the `devices.screen_profile` column.

This can be set via the REST API:
```bash
# Set preset for Seeed Studio reTerminal Sticky:
curl -X PUT "http://localhost:3001/api/devices/<DEVICE_ID>" \
  -H "Authorization: Bearer <API_TOKEN_OR_SESSION>" \
  -H "Content-Type: application/json" \
  -d '{"screen_profile": "{\"preset\":\"seeed-reterminal-sticky\"}"}'
```
Or with custom dimensions:
```json
{
  "screen_profile": {
    "width": 800,
    "height": 480,
    "rotation": 0,
    "colorDepth": "1bit",
    "dither": "floyd-steinberg",
    "outputFormat": "x-epd-packed"
  }
}
```

---

## 3. API Endpoints

### 3.1 `GET /api/embedded/render`

Fetches the pre-rendered image for the current playlist item.

#### Request Headers & Query
- **`Authorization`**: `Bearer <device_token>` *(device authentication)* or `Bearer st_...` *(API token)*
- **`device_id`** *(query, required)*: The UUID of the device.
- **`If-None-Match`** *(header, optional)*: ETag received in previous request.
- **`X-ST-Device-Battery`** *(header, optional)*: Battery level as an integer percentage (`0`–`100`). Automatically stored in `device_telemetry` and displayed on the device health card.
- **`X-ST-Power-Source`** *(header, optional)*: Active power source (`usb` or `battery`). Stored in `device_telemetry.power_source` and displayed on the device card.
- **`X-ST-Charging`** *(header, optional)*: Battery charging state (`1` / `true` or `0` / `false`).
- **`X-ST-Device-RSSI`** *(header, optional)*: Wi-Fi signal strength in dBm (e.g. `-65`). Stored in `device_telemetry`.
- **`X-ST-Device-Temperature`** *(header, optional)*: Ambient temperature in degrees Celsius (e.g. `23.5` via SHT40). Stored in `device_telemetry.temperature_c`.
- **`X-ST-Device-Humidity`** *(header, optional)*: Relative humidity percentage (`0`–`100`, e.g. `45.2` via SHT40). Stored in `device_telemetry.humidity`.
- **`X-ST-Device-Orientation`** *(header, optional)*: The orientation the panel is mounted in (`landscape`, `portrait`, `landscape-flipped`, `portrait-flipped`). Remembered for the panel's later polls (`devices.reported_orientation`). See [Orientation and rotation](#orientation-and-rotation).
- **`X-ST-Device-Rotation`** *(header, optional)*: The same as a rotation in degrees (`0`, `90`, `180`, `270`); a rotation alone implies its orientation.
- **`X-ST-Preset`** *(header, optional)*: The board the firmware was built for, as a preset key (e.g. `seeed-reterminal-e1004`). Remembered as `devices.reported_board`; firmware updates are only offered for that board. `X-ST-Device-Model` is read the same way when it holds a preset key.
- **`X-ST-Firmware-Version`** *(header, optional)*: Firmware / client version string (e.g. `1.3.0`). Updates `devices.app_version`.
- **`orientation`** *(query, optional)*: The same as `X-ST-Device-Orientation`, for this request. On a dashboard preview (`preview=1`) or with an API token it is applied to that render only and not remembered.
- **`rotation`** *(query, optional)*: The same as `X-ST-Device-Rotation`, for this request.
- **`format`** *(query, optional)*: Override output format (`x-epd-packed`, `x-epd-gray4`, `x-epd-spectra6`, `x-epd-gray16`, `png`, `jpeg`, `bmp`, `raw`).
- **`dither`** *(query, optional)*: Override dithering algorithm (`floyd-steinberg`, `atkinson`, `none`).
- **`mode`** *(query, optional)*: `layout` (forces multi-zone layout rendering), `single` (forces single-item rendering). When omitted, automatically renders in multi-zone layout mode if the device has an assigned multi-zone layout (`zones.length > 1`), or single-item mode otherwise (inheriting `background_color` from the zone when a 1-zone layout is assigned).
- **`item`** *(query, optional)*: Force a specific playlist item index (0-based integer) for step testing or previewing.
- **`preview`** *(query, optional)*: Set `preview=1` to bypass ETag 304 check and cache read/write (always renders live).

#### Responses
- **`200 OK`**: Binary image body formatted per the device's `screen_profile`.
  - Content-Type: `application/octet-stream` (for `x-epd-packed`, `x-epd-gray4`, `x-epd-spectra6`, `x-epd-gray16`, or `raw`), `image/png`, `image/jpeg`, or `image/bmp`.
  - Response Headers:
    - `ETag`: `"sha256-hash..."`
    - `X-ST-Expires-In`: Seconds until the current item ends, or seconds until morning 'on' window if display power schedule is off (sleep timer for MCU). Raised to at least `profile.minRefreshInterval` while the panel stays on, but never past its next scheduled-off edge.
    - `X-ST-Power-State`: `'on'` or `'scheduled_off'` according to the device's weekly Display Power Schedule.
    - `X-ST-Command`: Optional pending command for the device, at most one per response, sent on every status that carries it (200, 304, 404, 500, 501) and then dropped from the queue:
      - `update <url> <sha256>`: Download and flash a firmware image. `<url>` is always this server's own `/api/embedded/firmware/<preset>/latest.bin` and `<sha256>` (64 hex, always present) is that file's digest; the firmware must refuse to flash anything that does not match it. See [3.8](#38-firmware-distribution--over-the-air-ota-updates).
      - `upload_logs`: Upload the in-memory diagnostic ring buffer to `POST /api/embedded/logs`.
      - `reboot`: Reboot the device microcontroller.
      - Any other queued command type is passed through as its name (e.g. `refresh`). A value that is not printable ASCII or is longer than 512 characters is never sent: it is dropped from the queue and logged.
    - `X-ST-Screen-Width` / `X-ST-Screen-Height`: The dimensions of the frame in this body, as sent (after any server-side rotation).
    - `X-ST-Rotation`: The mount rotation the frame was composed for (`0`, `90`, `180`, `270`). See [Orientation and rotation](#orientation-and-rotation) for what firmware should do with it.
    - `X-ST-Orientation`: The stated orientation, or when none was stated, the shape of the composed frame (`portrait` when it is taller than wide, else `landscape`).
    - `X-ST-Color-Mode`: The active color depth for this frame (`1bit`, `gray4`, `gray16`, `spectra6`, etc.). Sent on both `200` and `304` responses so the firmware can validate payload format.
    - `X-ST-Refresh-Mode`: Server refresh hint (`full` or `partial`). Advises `full` on first render, playlist item/layout transitions, display parameter changes (`orientation`, `colorDepth`, `dither`, `fitMode`, `backgroundColor`), or when `profile.refreshMode === 'always_full'`; advises `partial` for incremental updates on partial-refresh-capable panels.
    - `X-ST-Supports-Partial`: `'1'` if device supports fast partial refresh; `'0'` if full refresh is required.
    - `X-ST-Item-Index`: Current playlist item index (0-based) in single mode or `'0'` in layout mode.
    - `X-ST-Total-Items`: Total active items in playlist (in single-item mode).
    - `X-ST-Total-Zones`: Total zones in the layout (in multi-zone layout mode).
    - `X-ST-Layout-Fallback`: Set to `'1'` when automatic layout rendering falls back to single-item mode due to missing browser dependencies.
    - `X-ST-Device-Id`: Device UUID.
    - `X-ST-Content-Id`: Content ID (or Layout ID in layout mode).
    - `X-ST-Layout-Id`: Layout UUID (in layout mode).

- **`304 Not Modified`**: Sent when `If-None-Match` matches the current content digest. Body is empty. The ETag of a panel that states no orientation is exactly what earlier releases served, so an upgrade does not make every panel redraw.
- **`400 Bad Request`**: Device lacks a configured `screen_profile`.
- **`401 Unauthorized`**: Invalid or missing device token.
- **`404 Not Found`**: Device not found or no playlist assigned.
- **`501 Not Implemented`**: Returned in any mode when no playlist item is natively renderable, or when `?mode=layout` / `/render-layout` is explicitly requested for widgets/webpages and Chromium is not installed on the server. In default auto mode with missing browser dependencies, the server degrades gracefully to single-item rendering with `X-ST-Layout-Fallback: 1`.

---

### 3.2 Multi-Zone Layout Rendering & Zero-Browser Fallback

Devices assigned to multi-zone layouts are automatically composited on the server:
- **Native Image-Only Layouts (Zero Browser):** When all zones contain static images (local uploads or remote image URLs), the multi-zone canvas is composited natively using Jimp with zero external browser dependencies.
- **Dynamic Widgets & Webpage Zones:** When zones include clocks, weather, slides, or web pages, Headless Chromium renders the composite.

> [!NOTE]
> **Full Widget, Slide & Webpage Rendering on E-Paper Displays:**
> - **Native Image Content:** Standard images (PNG, JPEG, WebP, GIF, BMP) and image-only multi-zone layouts are rendered natively using `jimp` with zero external dependencies.
> - **Widgets, Slides & Webpages (via Docker):** Use the pre-configured [`docker-compose.embedded.yml`](../docker-compose.embedded.yml) (built from [`Dockerfile.embedded`](../Dockerfile.embedded)), which includes headless Chromium and fonts out-of-the-box:
>   ```bash
>   docker compose -f docker-compose.embedded.yml up -d --build
>   ```
> - **Widgets, Slides & Webpages (Bare-Metal Linux / VPS):** Simply install Chromium and fonts:
>   ```bash
>   sudo apt-get install -y chromium-browser fonts-liberation fonts-noto-color-emoji
>   ```
> - **Local Development (macOS / Windows):** Automatically detects your installed Google Chrome or Microsoft Edge.

---

### 3.3 `GET /api/embedded/info`

Returns JSON metadata describing device status, screen profile, timing, and playlist configuration.

```json
{
  "device_id": "809f5ab6-4cfd-4f84-8718-1dea8f6e3a7b",
  "device_name": "reTerminal Sticky",
  "screen_profile": {
    "width": 800,
    "height": 480,
    "rotation": 0,
    "colorDepth": "1bit",
    "dither": "floyd-steinberg",
    "outputFormat": "x-epd-packed"
  },
  "playlist": {
    "item_count": 2,
    "current_index": 0
  },
  "current_item": {
    "index": 0,
    "content_id": "f7ab7a40-49bd-406f-873d-43eb5fb26343",
    "content_type": "image/png",
    "expires_in_seconds": 30
  },
  "server_time_utc": "2026-09-03T07:00:00.000Z"
}
```

---

### 3.4 `GET /api/embedded/presets`

Returns the list of built-in hardware presets.

---

### 3.5 `POST /api/embedded/pair/register`

Requests a new unassigned embedded device registration. The server assigns a secure CSPRNG 6-digit pairing code and a 32-byte `claim_secret`.
Rate-limited and protected by `pairLockout`.

#### Request Body
```json
{
  "screen_profile": "seeed-reterminal-sticky",
  "screen_width": 800,
  "screen_height": 480
}
```
`screen_width` / `screen_height` default to the preset's. When `screen_profile` is a preset key, it is also recorded as the board the hardware reports (`devices.reported_board`): the firmware sends the preset it was built for, while `screen_profile` stays an editable setting.

For presets that declare `parameterizedDimensions: true` (`seeed-xiao-led`), passing custom `screen_width` and `screen_height` during registration (within valid bounds: `1..512` per edge and `width * height <= 16384`) automatically stores `{"preset":"seeed-xiao-led","width":W,"height":H}` in `devices.screen_profile` so the device's runtime LED matrix geometry is preserved across subsequent renders and dashboard settings updates. Fixed-geometry e-paper presets always keep their native panel resolution.

#### Response (`200 OK`)
```json
{
  "status": "ok",
  "device_id": "136ee9f6-020a-42fe-8e0c-b7763ee84389",
  "pairing_code": "545658",
  "claim_secret": "9a38f72c19e84b...",
  "message": "Display registered for pairing. Show code on screen."
}
```

---

### 3.6 `GET /api/embedded/pair/status`

Polled by the MCU during setup to detect when the user claims the display in the web dashboard via `POST /api/provision/pair`.
Protected by `pairLockout` and constant-time `claim_secret` validation.

#### Headers / Query
- **`Authorization`** *(header, recommended)*: `Bearer <claim_secret>`
- **`claim_secret`** *(query, fallback)*: The secret token issued at registration.
- **`device_id`** *(query, required)*: The UUID returned by `/pair/register`.

#### Response (`200 OK`)
- **Unclaimed:** `{"paired": false, "status": "provisioning", "pairing_code": "545658"}`
- **Claimed / Paired:** `{"paired": true, "status": "online", "device_id": "<UUID>", "device_token": "<SECRET_TOKEN>"}` *(burns `claim_secret` on delivery)*

---

### 3.7 Device Diagnostic Logs API

Embedded devices keep their recent boot and network events in an in-memory ring buffer (100 entries in `screentinker_mcu`). When asked (`X-ST-Command: upload_logs`) or after repeated sync failures, a device uploads that buffer. The server keeps the newest **20 uploads per device** and prunes older ones on insert.

#### `POST /api/embedded/logs`
**Device token only** (`Authorization: Bearer <device_token>` + `?device_id=` or `X-ST-Device-Id`). An API token of any scope is refused with `403`: only the panel writes its own logs. Rate-limited (`deviceLogsLimiter`: 60 requests / minute per IP). Body limit 256 KB (`413` beyond it); at most 100 entries per upload (`400` beyond it).

- **Body**, either:
  - `application/json`: an object, or a bare array of entries:
    ```json
    {
      "version": "1.3.0",
      "battery": 82,
      "wifi_rssi": -55,
      "logs": [
        { "uptime_ms": 120, "level": "INFO", "tag": "Boot", "msg": "ScreenTinker MCU v1.3.0 booting..." },
        { "uptime_ms": 1820, "level": "INFO", "tag": "Sync", "msg": "HTTP 200 frame received (48000 B)" }
      ]
    }
    ```
    `battery` must be 0-100 and `wifi_rssi` (or `rssi`) -120-0, or the upload is refused with `400`. When absent they are taken from `X-ST-Device-Battery` / `X-ST-Device-RSSI`, and `version` from `X-ST-Firmware-Version`.
  - `text/plain`: one entry per line, stored as `{ "logs": [{ "msg": "<line>", "level": "INFO" }, ...], "log_count": N }`.
- **Response**: `200 OK` with `{"status": "ok", "log_id": 42, "id": 42, "count": 2}`.
- **Live update**: the dashboard socket event `dashboard:embedded-logs` goes to the device's workspace with the upload's **metadata only** (`device_id`, `id`, `log_id`, `log_count`, `size`, `battery`, `wifi_rssi`, `version`, `uploaded_at`). An open device page then fetches the body.

#### `GET /api/embedded/logs` and `GET /api/devices/:id/diagnostic-logs`
- **`GET /api/embedded/logs?device_id=<UUID>&limit=5`**: the device token, or an API token with `read`, `write` or `full` scope in the device's workspace. (No dashboard session: this router takes device and API tokens only.)
- **`GET /api/devices/:id/diagnostic-logs?limit=1`**: the dashboard / public API route (session or `read` token; rate-limited at 300 requests / minute per IP).
- **`limit`** *(query, optional)*: 1-20, default 20; larger values are capped.
- **Response**: `200 OK` with `{ "logs": [ ... ] }`, newest first. Each entry is the stored row: `{ id, device_id, log_json, log_count, battery, wifi_rssi, version, uploaded_at }`, where **`log_json` is the upload as stored JSON text** (parse it to get `logs`).

`GET /api/devices/:id` does not include log bodies: for an embedded device it carries `diagnostic_logs_latest`, the newest upload's `{ id, created_at, size, count }`, or `null`.

---

### 3.8 Firmware Distribution & Over-The-Air (OTA) Updates

ScreenTinker serves firmware for the Seeed reTerminal presets so panels can be updated without a USB cable. Binaries live in `server/firmware/<preset>/` (`firmware.bin` + `version.json`), or under `ST_FIRMWARE_DIR/<preset>/` when that is set. The `:preset` path segment accepts the hyphenated preset key (`seeed-reterminal-e1001`) or the underscored directory name (`seeed_reterminal_e1001`).

`version.json` must carry `version`; without it no update is offered. If it also carries `sha256`, that must match the bytes on disk, or no update is offered (a half-copied binary is never sent).

#### `GET /api/embedded/firmware/:preset/version`
Unauthenticated. Rate-limited (`firmwareLimiter`: 120 requests / 15 minutes per IP).

- **Response (`200 OK`)**:
  ```json
  {
    "preset": "seeed_reterminal_sticky",
    "version": "1.3.0",
    "size": 1072592,
    "sha256": "9d4c2056e9dfceb9f9db99889ebafab69cdc3e0051918465a283c87b6917dd0a",
    "download_url": "/api/embedded/firmware/seeed_reterminal_sticky/latest.bin"
  }
  ```
- **`404`** when there is no binary for that preset.

#### `GET /api/embedded/firmware/:preset/latest.bin`
Streams the binary. Same limiter.
- **Response Headers**: `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="<preset>-firmware.bin"`, `X-ST-Firmware-Version: <version>`, `X-ST-Firmware-SHA256: <sha256>`.

#### Triggering an update
Updates are only ever started by an operator; the server never offers one on its own because a panel reports an older version.

1. **Queue it**: **Update Firmware** on the device page, or `POST /api/devices/:id/command` with `{"type": "update"}` (scope `full`). On a screen head office controls, only the organization's admins may (like `install_apk`). The request's `payload` is ignored: there is no way to name another URL or digest.
2. **Checked at the door**: the update is refused with `409` (socket ack `reason: "rejected"`) and a reason when it could never be delivered:
   - `EMBEDDED_NO_FIRMWARE`: this server has no firmware for the panel's screen profile (any non-Seeed panel);
   - `EMBEDDED_BOARD_MISMATCH`: the panel reports a different board than its screen profile.
   Otherwise it is queued, and the result carries `firmware: { preset, version, board_verified }`. `board_verified: false` means the panel never reported its board (as with `screentinker_mcu` v1.3.0 when it was paired before boards were recorded), so it will get the firmware for its **screen profile**; the dashboard says so.
3. **Delivered on the next poll** as `X-ST-Command: update /api/embedded/firmware/<preset>/latest.bin <sha256>`, unless the board it reports on that poll (`X-ST-Preset`) does not match, in which case it is dropped and logged.
4. **On the device** (`screentinker_mcu`): the image is streamed into the inactive partition while its SHA-256 is computed; a mismatch aborts. After reboot the new image is pending verification and marks itself valid once it fetches its first frame (`200` / `304`); otherwise the bootloader rolls back.
5. **Circuit breaker** (`lib/ota-breaker.js`): if a panel keeps reporting the same older version after 6 offers of the same target (`NO_PROGRESS_LIMIT`), offers stop until the version it reports, or the target, changes.

---

### 3.9 Dashboard Controls & Telemetry Cards

On an embedded device's page (**Displays → select device**):
- **Telemetry**: **Temperature** and **Humidity** cards when the panel reports them (e.g. Sensirion SHT40), battery, power source and Wi-Fi RSSI.
- **Update Firmware**: queues an `update` (see 3.8) and says what will happen: the version queued, or that the panel does not report its board, or why it was refused.
- **Diagnostic Logs**: the newest upload, with **Request Diagnostic Logs** (queues `upload_logs` for the next poll) and **Copy**. It refreshes itself when an upload arrives (`dashboard:embedded-logs`).
- **Display Power Schedule**: the weekly on/off schedule behind `X-ST-Power-State` and the overnight `X-ST-Expires-In`.

When an operator explicitly changes the **Orientation** dropdown on an embedded device's Settings page and saves, `screen_profile.orientation` is updated and `devices.reported_orientation` is cleared to `NULL` so the dashboard setting takes effect immediately (while leaving `devices.orientation`, which defaults to `'landscape'` on every row, ignored unless explicitly changed).

---

## 4. Screen Profiles & Output Formats


A device's screen configuration is stored in the `devices.screen_profile` JSON column.

### Supported Properties
| Property | Type | Values | Description |
|---|---|---|---|
| `width` | `number` | Positive integer (e.g. `800`) | Logical pixel width |
| `height` | `number` | Positive integer (e.g. `480`) | Logical pixel height |
| `parameterizedDimensions` | `boolean` | `true` | Marks presets with user-configurable runtime dimensions (`seeed-xiao-led`); enforces `width <= 512`, `height <= 512`, and `width * height <= 16384` |
| `orientation` | `string` | `landscape`, `portrait`, `landscape-flipped`, `portrait-flipped` | Composition orientation: swaps `width`/`height` when they disagree with it |
| `rotation` | `number` | `0`, `90`, `180`, `270` | Mounting rotation in degrees. A profile's own `rotation` wins over its own `orientation` |
| `mcuTranspose` | `boolean` | `true` | The panel transposes portrait frames itself (see [Orientation and rotation](#orientation-and-rotation)). Set on the E1001-E1004 presets |
| `colorDepth` | `string` | `1bit`, `gray4`, `4bit-gray`, `gray16`, `spectra6`, `16bit-rgb565`, `24bit-rgb888` | Color quantization mode |
| `dither` | `string` | `floyd-steinberg`, `atkinson`, `none` | Dithering algorithm |
| `outputFormat` | `string` | `x-epd-packed`, `x-epd-gray4`, `x-epd-spectra6`, `x-epd-gray16`, `bmp`, `raw`, `png`, `jpeg` | Serialization format |
| `supportsPartialRefresh` | `boolean` | `true`, `false` | Whether display hardware supports partial refresh |
| `refreshMode` | `string` | `smart_partial`, `always_full` | Per-device refresh behavior hint for `X-ST-Refresh-Mode` (`smart_partial` default) |
| `minRefreshInterval` | `number` | Positive integer (seconds) | Minimum polling / refresh interval |

### Output Format Details

- **`x-epd-packed`**: 1-bit MSB-first packed bitstream without row-padding. For an 800×480 screen, this produces exactly `(800 * 480) / 8 = 48,000 bytes`. This can be written directly to SSD1677, SSD1608, or UC8151 controller RAM over SPI.
- **`x-epd-gray4`**: 2bpp MSB-first packed buffer (4 pixels per byte: bits `7..6`, `5..4`, `3..2`, `1..0`), quantized to 4 gray levels (`0` black `#000000`, `1` dark gray `#555555`, `2` light gray `#AAAAAA`, `3` white `#FFFFFF`) using BT.601 luminance and Floyd-Steinberg error diffusion. For an 800×480 screen (`seeed-reterminal-sticky`, `seeed-reterminal-e1001`), this produces `96,000 bytes`. The frame width must be divisible by 4.
- **`x-epd-spectra6`**: 4bpp packed buffer, 2 pixels per byte, the LEFT (even-x) pixel in the HIGH nibble, rows back to back. Quantized to the 6-color Spectra palette by Euclidean distance with Floyd-Steinberg error diffusion in RGB space; the nibble is the controller code (`0` black, `1` white, `2` yellow, `3` red, `5` blue, `6` green; `4` unused). The frame width must be even.
- **`x-epd-gray16`**: 4bpp packed buffer in the same nibble order (high nibble first), 16 gray levels (`0` black ... `15` white) with Floyd-Steinberg error diffusion. The frame width must be even. (`screentinker_mcu` reads `(byte >> 4)` for even x and `(byte & 0x0F)` for odd x, and the IT8951 driver bursts the buffer as is.)
- **`1bit` packing** (`x-epd-packed`, `raw`) accepts any width, odd ones included; rows are packed back to back with no padding.
- **`bmp`**: Standard 1-bit Windows BMP (Bitmap DIB v3) with 2-color palette (Black / White).
- **`png` & `jpeg`**: Rendered raster images with dithering applied (ideal for browser previewing and debugging).
- **`16bit-rgb565`**: 2 bytes per pixel (Little-Endian R5G6B5) for parallel RGB and SPI TFT displays (NV3047, ILI9341, ST7789). Dithering is bypassed (`dither: 'none'`) to preserve clean high-color rendering. Requesting `?format=jpeg` or `?format=png` encodes the rendered frame as a standard image for dashboard live previews.
- **`24bit-rgb888` (`raw`)**: 3 bytes per pixel (`R, G, B` in logical row-major top-left order, no header, `width * height * 3` bytes) for addressable smart RGB LED strips and 2D matrices (`seeed-xiao-led`). Dithering is bypassed (`dither: 'none'`) to preserve crisp pixel art and color gradients. Requesting `?format=jpeg` or `?format=jpg` on a `24bit-rgb888` device encodes the rendered frame as `image/jpeg` for dashboard live previews.

---

### Orientation and rotation

Both the **device** (via its local menu or IMU accelerometer) and the **dashboard** (via the Device Settings tab) can configure orientation. **Nothing changes unless something states an orientation**: a panel with no orientation stated renders its stored `screen_profile` exactly as it always did (same bytes, same ETag).

#### 1. Priority Hierarchy (`resolveOrientationRotation` & `parseProfile`)

When `/api/embedded/render` (or `/info` / `/render-layout`) resolves the orientation for a request, it checks three sources in order from highest to lowest priority:

```
Priority 1 (Highest): Current HTTP Request Header / Query
  └─ X-ST-Device-Orientation / X-ST-Device-Rotation (or ?orientation= / ?rotation=)
       │
       ▼ (if not sent on this request)
Priority 2: Last Device-Reported Orientation in DB
  └─ devices.reported_orientation (remembered from the panel's last poll header;
     never written by a dashboard preview or API token)
       │
       ▼ (if NULL — panel never reported one, or operator cleared it in Dashboard)
Priority 3 (Lowest): Dashboard / Screen Profile Setting
  └─ devices.screen_profile.orientation / rotation (set in Dashboard → Device Settings)
```

*(Note: `devices.orientation`—the general player Settings column that defaults to `'landscape'` on every database row—is never read directly by the embedded renderer.)*

#### 2. How Real-World Scenarios Behave

| Scenario | Behavior |
|---|---|
| **A. Device has IMU auto-rotation ON (or fixed orientation configured on the device) and sends `X-ST-Device-Orientation` on every poll** | **The device wins.** Every time the MCU wakes up and polls `/api/embedded/render` with `X-ST-Device-Orientation` (from its IMU or on-device NVS config), Priority 1 applies immediately and the server updates `devices.reported_orientation` (Priority 2) so dashboard previews match the physical panel. |
| **B. Device does NOT send `X-ST-Device-Orientation` (or only sent it once in the past), and the operator changes Orientation in the Dashboard** | **The Dashboard setting takes effect.** Changing **Orientation** in the dashboard and clicking **Save Settings** (`PUT /api/devices/:id`) writes `screen_profile.orientation = '<new>'` (Priority 3) **and resets `devices.reported_orientation = NULL`** (clearing Priority 2). As long as the device does not override it with an `X-ST-Device-Orientation` header on subsequent polls, the server composes frames in the dashboard-selected orientation. |
| **C. Operator opens Dashboard Settings and edits only Notes / Tags / Color Mode (without changing Orientation)** | **Nothing is overwritten.** The dashboard tracks whether `#deviceOrientation` was actually changed before saving; saving unrelated settings does not touch `screen_profile.orientation` or clear `devices.reported_orientation`. |

#### 3. Who Rotates the Pixels? (Server vs. MCU Transpose)

A stated `portrait` / `portrait-flipped` orientation on a landscape preset (or `landscape` / `landscape-flipped` on a native portrait preset like the 1200×1600 **E1004**) swaps the composition `width` and `height` so widgets, text, and `contain`/`cover` images are laid out upright (`portrait` = 90°, `landscape-flipped` = 180°, `portrait-flipped` = 270°).

How the final binary buffer is oriented depends on whether the device uses **MCU transpose** (`mcuTranspose`):

- **MCU transpose (`mcuTranspose: true`)** — *Used by the `seeed-reterminal-e1001`–`e1004` presets, any custom profile setting `mcuTranspose: true`, and `seeed-reterminal-sticky` when the request or `reported_orientation` states an orientation (`screentinker_mcu` >= 1.3.0)*:
  - The server sends the frame at its **composed dimensions** (e.g. `480×800` for portrait on an `800×480` panel) with `X-ST-Screen-Width: 480`, `X-ST-Screen-Height: 800`, and `X-ST-Rotation: 90` (or `270`).
  - The server applies only the `180°` flip for flipped mounts (`landscape-flipped`, `portrait-flipped`).
  - When `X-ST-Screen-Width` / `X-ST-Screen-Height` differ from the panel's native dimensions, the **MCU firmware transposes the buffer 90° into native controller RAM order**.
- **Server-side rotation (`mcuTranspose: false`)** — *Used by legacy Sticky `v1.2.0` panels (which never send `X-ST-Device-Orientation` headers) when rotated via the Dashboard, and by generic Waveshare / SPI TFT profiles*:
  - The frame is composed at `width × height` (e.g. `480×800`) and then **rotated by the server** into the panel's native pixel order (`800×480`) before bit-packing.
  - `X-ST-Screen-Width` and `X-ST-Screen-Height` report the final rotated dimensions (`800` and `480`). `X-ST-Rotation` is informational only: **firmware must not rotate again**.

---

## 5. Hardware Presets

| Preset Key | Width | Height | Depth | Format | Partial Refresh | Notes |
|---|---|---|---|---|---|---|
| `seeed-reterminal-sticky` | 800 | 480 | `1bit` / `gray4` | `x-epd-packed` / `x-epd-gray4` | Yes (350ms in 1-bit) | Seeed Studio reTerminal Sticky (SSD1677, touch) |
| `seeed-reterminal-e1001` | 800 | 480 | `1bit` / `gray4` | `x-epd-packed` / `x-epd-gray4` | Yes (350ms in 1-bit) | Seeed Studio reTerminal E1001 (7.5" Mono) |
| `seeed-reterminal-e1002` | 800 | 480 | `spectra6` | `x-epd-spectra6` | No (min 30s) | Seeed Studio reTerminal E1002 (7.3" 6-Color Spectra 6) |
| `seeed-reterminal-e1003` | 1872 | 1404 | `gray16` | `x-epd-gray16` | Yes (180ms) | Seeed Studio reTerminal E1003 (10.3" Gray16, touch) |
| `seeed-reterminal-e1004` | 1200 | 1600 | `spectra6` | `x-epd-spectra6` | No (min 60s) | Seeed Studio reTerminal E1004 (13.3" 6-Color Spectra 6) |
| `seeed-xiao-led` | 5 (param.) | 1 (param.) | `24bit-rgb888` | `raw` | Yes (50ms) | Seeed Studio XIAO LED Controller (WS2812B/SK6812 strip/matrix) |
| `elecrow-crowpanel-43` | 480 | 272 | `16bit-rgb565` | `raw` | No (20ms) | Elecrow CrowPanel 4.3" HMI Display (NV3047 RGB LCD, ESP32-S3) |
| `waveshare-7.5in-v2` | 800 | 480 | `1bit` | `x-epd-packed` | - | Waveshare 7.5" e-Paper |
| `waveshare-4.2in-v2` | 400 | 300 | `1bit` | `x-epd-packed` | - | Waveshare 4.2" e-Paper |
| `waveshare-2.9in-v2` | 296 | 128 | `1bit` | `x-epd-packed` | - | Waveshare 2.9" e-Paper |
| `waveshare-1.54in-v2` | 200 | 200 | `1bit` | `x-epd-packed` | - | Waveshare 1.54" e-Paper |
| `waveshare-5.65in-acep` | 600 | 448 | `24bit-rgb888` | `png` | - | 7-color ACeP e-Paper |
| `generic-320x240-rgb565` | 320 | 240 | `16bit-rgb565` | `raw` | - | Standard 2.4"/2.8" SPI TFT |
| `generic-128x64-1bit` | 128 | 64 | `1bit` | `raw` | - | SSD1306 0.96" OLED |

### 5.1 Smart RGB LED Strip & Matrix Mode (`seeed-xiao-led`)

The `seeed-xiao-led` preset turns ScreenTinker into a pixel-art, ticker, and ambient signage server for **Seeed Studio XIAO ESP32-C6 / ESP32-S3 / ESP32-C3** microcontrollers paired with the **Seeed Studio LED Driver Board for XIAO** (SKU 105100021, 5V level-shifted `WS2812B` / `SK6812` output):

- **Parametric Matrix Dimensions (`parameterizedDimensions: true`)**:
  - Defaults to `5×1` (5-LED ambient strip), but supports any runtime strip or 2D matrix resolution configured on the MCU (e.g. `32×8` LED banner, `16×16` grid, `64×64` or `128×64` matrix wall) up to **`512` pixels per edge** and **`16,384` total pixels** (48 KB raw RGB888 payload).
  - During `POST /api/embedded/pair/register`, the MCU sends its configured `screen_width` and `screen_height` from NVS (`led_driver_get_matrix_config()`). The server persists `{"preset":"seeed-xiao-led","width":W,"height":H}` in `devices.screen_profile`.
  - Updating orientation or other settings via `PUT /api/devices/:id` in the dashboard automatically preserves the device's custom `width` and `height`.
- **Wire Protocol & Coordinate Mapping**:
  - `GET /api/embedded/render` returns `Content-Type: application/octet-stream` (`X-ST-Color-Mode: 24bit-rgb888`) containing `width * height * 3` raw RGB888 bytes (`[R0, G0, B0, R1, G1, B1, ...]`) ordered in standard **top-left, row-major** raster sequence.
  - Physical LED wiring topology—**Serpentine** (zig-zag) vs. **Progressive** (linear), **Row-Major** vs. **Column-Major** scanning axis, and **Origin Corner** (`TOP_LEFT`, `TOP_RIGHT`, `BOTTOM_LEFT`, `BOTTOM_RIGHT`)—is translated on the MCU at display-refresh time (`led_matrix_map.h`), keeping the server's render cache independent of physical panel wiring.
- **Dashboard Controls**:
  - Displays a **`24-Bit RGB`** color mode badge and automatically hides the E-Paper dithering selector (`#epdDither`), since LEDs render full 24-bit color without monochrome quantization.
  - Supports live browser previews via `?format=jpeg` (`image/jpeg`).

### 5.2 Elecrow CrowPanel 4.3" RGB LCD Mode (`elecrow-crowpanel-43`)

The `elecrow-crowpanel-43` preset supports the **Elecrow CrowPanel 4.3" HMI Display** (ESP32-S3 with 4MB Flash and 2MB PSRAM) equipped with a 480×272 high-color LCD driven by the NV3047 controller over a 16-bit parallel RGB interface:

- **Resolution & Color Format**: Native `480×272` resolution with `16bit-rgb565` color depth. `GET /api/embedded/render` serves raw Little-Endian RGB565 bytes (`width * height * 2` = 261,120 bytes) with `Content-Type: application/octet-stream`.
- **Live Preview Support**: Dashboard live previews and developer queries using `?format=jpeg` or `?format=png` encode the rendered frame into standard image formats before serving.
- **Dithering Bypass**: Because RGB565 provides high color fidelity (65,536 colors), dithering is bypassed (`dither: 'none'`) and the dashboard dithering dropdown is automatically hidden.
- **Hardware Profile Details**:
  - Default refresh interval: 1s.
  - Full refresh duration: 20ms (instantaneous frame buffer write).
  - Dedicated single-button navigation on the device via the physical `BOOT` button.

---

## 6. Reference ESP32 Firmware Implementation (C++ / Arduino)

For the complete production firmware supporting the **Seeed Studio reTerminal Sticky & E-Series (`E1001`–`E1004`)**, **Seeed Studio XIAO Smart LED Controllers (`ESP32-C6` / `ESP32-S3` / `ESP32-C3`)**, and the **Elecrow CrowPanel 4.3" RGB LCD**—including the [1-Click Universal Browser Web Flasher](https://www.rene-bohne.de/screentinker_mcu/tools/), Captive Portal Wi-Fi onboarding, 6-digit PIN pairing, dynamic LED matrix serpentine/progressive coordinate mapping, PSRAM frame caching, IMU auto-rotation, SHT40 telemetry, dual-partition OTA rollback, and a native SDL2 desktop simulator—see the **[`screentinker_mcu`](https://github.com/renebohne/screentinker_mcu)** repository.

Below is a minimal standalone reference sketch illustrating the core HTTP polling and ETag sleep loop:

```cpp
#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID     = "Your-WiFi-SSID";
const char* WIFI_PASSWORD = "Your-WiFi-Password";
const char* SERVER_URL    = "http://192.168.1.100:3001/api/embedded/render?device_id=YOUR_DEVICE_ID";
const char* DEVICE_TOKEN  = "YOUR_DEVICE_TOKEN";

// Stored in RTC memory across deep sleep cycles
RTC_DATA_ATTR char lastEtag[80] = "";

void fetchAndDisplay() {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(100);
  }

  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  
  if (strlen(lastEtag) > 0) {
    http.addHeader("If-None-Match", lastEtag);
  }

  // Collect custom headers
  const char* headerKeys[] = {"ETag", "X-ST-Expires-In"};
  http.collectHeaders(headerKeys, 2);

  int httpCode = http.GET();
  int sleepSeconds = 60; // Fallback sleep duration

  if (httpCode == HTTP_CODE_NOT_MODIFIED) {
    // 304: Content unchanged — skip E-Paper refresh to save battery
    String expires = http.header("X-ST-Expires-In");
    if (expires.length() > 0) sleepSeconds = expires.toInt();
  } else if (httpCode == HTTP_CODE_OK) {
    // 200: New frame received
    String etag = http.header("ETag");
    if (etag.length() > 0) strncpy(lastEtag, etag.c_str(), sizeof(lastEtag) - 1);
    
    String expires = http.header("X-ST-Expires-In");
    if (expires.length() > 0) sleepSeconds = expires.toInt();

    // Stream 48,000 bytes directly to SSD1677 display driver
    WiFiClient* stream = http.getStreamPtr();
    uint8_t buffer[512];
    while (http.connected() && stream->available()) {
      int len = stream->readBytes(buffer, sizeof(buffer));
      if (len > 0) {
        // Send bytes to EPD SPI controller
        // epd_write_display_ram(buffer, len);
      }
    }
    // Refresh display
    // epd_refresh();
  }

  http.end();
  WiFi.disconnect(true);

  // Sleep until next playlist advance
  esp_sleep_enable_timer_wakeup((uint64_t)sleepSeconds * 1000000ULL);
  esp_deep_sleep_start();
}

void setup() {
  fetchAndDisplay();
}

void loop() {}
```
