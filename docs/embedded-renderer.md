# Embedded Renderer for Digital Signage (E-Paper & MCU Displays)

ScreenTinker includes a dedicated server-side embedded renderer designed for lightweight microcontrollers (MCUs) such as the **ESP32-S3**, **Raspberry Pi Pico W**, or **Seeed Studio reTerminal Sticky** (3.97" B/W E-Paper 800×480 with SSD1677).

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
- **Deep sleep coordination:** The server sends the `X-ST-Expires-In` header telling the MCU exactly how many seconds to deep sleep before waking for the next frame.
- **Battery preservation via HTTP 304:** When content hasn't changed, the server returns `304 Not Modified` on matching `If-None-Match: <etag>`, allowing the MCU to skip power-intensive E-Paper refreshes and SPI transfers.

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

### 2.1 `GET /api/embedded/render`

Fetches the pre-rendered image for the current playlist item.

#### Request Headers & Query
- **`Authorization`**: `Bearer <device_token>` *(device authentication)* or `Bearer st_...` *(API token)*
- **`device_id`** *(query, required)*: The UUID of the device.
- **`If-None-Match`** *(header, optional)*: ETag received in previous request.
- **`format`** *(query, optional)*: Override output format (`x-epd-packed`, `png`, `jpeg`, `bmp`, `raw`).
- **`dither`** *(query, optional)*: Override dithering algorithm (`floyd-steinberg`, `atkinson`, `none`).
- **`mode`** *(query, optional)*: `layout` (forces multi-zone layout rendering), `single` (forces single-item rendering). When omitted, automatically renders in multi-zone layout mode if the device has an assigned multi-zone layout (`zones.length >= 1`), or single-item mode otherwise.
- **`item`** *(query, optional)*: Force a specific playlist item index (0-based integer) for step testing or previewing.
- **`preview`** *(query, optional)*: Set `preview=1` to bypass ETag 304 check and cache read/write (always renders live).

#### Responses
- **`200 OK`**: Binary image body formatted per the device's `screen_profile`.
  - Content-Type: `application/octet-stream` (for `x-epd-packed` or `raw`), `image/png`, `image/jpeg`, or `image/bmp`.
  - Response Headers:
    - `ETag`: `"sha256-hash..."`
    - `X-ST-Expires-In`: Seconds until the current item ends (sleep timer for MCU).
    - `X-ST-Item-Index`: Current playlist item index (0-based) in single mode or `'0'` in layout mode.
    - `X-ST-Total-Items`: Total active items in playlist (in single-item mode).
    - `X-ST-Total-Zones`: Total zones in the layout (in multi-zone layout mode).
    - `X-ST-Layout-Fallback`: Set to `'1'` when automatic layout rendering falls back to single-item mode due to missing browser dependencies.
    - `X-ST-Device-Id`: Device UUID.
    - `X-ST-Content-Id`: Content ID (or Layout ID in layout mode).
    - `X-ST-Layout-Id`: Layout UUID (in layout mode).
- **`304 Not Modified`**: Sent when `If-None-Match` matches the current content digest. Body is empty.
- **`400 Bad Request`**: Device lacks a configured `screen_profile`.
- **`401 Unauthorized`**: Invalid or missing device token.
- **`404 Not Found`**: Device not found or no playlist assigned.
- **`501 Not Implemented`**: Content type or multi-zone layout contains widgets requiring a browser when Chromium is not installed on the server (returned when explicitly requesting `?mode=layout` or `/render-layout`). In default auto mode, the server degrades gracefully to single-item rendering with `X-ST-Layout-Fallback: 1`.

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

## 4. Screen Profiles & Output Formats

A device's screen configuration is stored in the `devices.screen_profile` JSON column.

### Supported Properties
| Property | Type | Values | Description |
|---|---|---|---|
| `width` | `number` | Positive integer (e.g. `800`) | Logical pixel width |
| `height` | `number` | Positive integer (e.g. `480`) | Logical pixel height |
| `rotation` | `number` | `0`, `90`, `180`, `270` | Rotation applied after resize |
| `colorDepth` | `string` | `1bit`, `4bit-gray`, `16bit-rgb565`, `24bit-rgb888` | Color quantization |
| `dither` | `string` | `floyd-steinberg`, `atkinson`, `none` | Dithering algorithm for 1-bit |
| `outputFormat` | `string` | `x-epd-packed`, `bmp`, `raw`, `png`, `jpeg` | Serialization format |

### Output Format Details

- **`x-epd-packed`**: 1-bit MSB-first packed bitstream without row-padding. For an 800×480 screen, this produces exactly `(800 * 480) / 8 = 48,000 bytes`. This can be written directly to SSD1677, SSD1608, or UC8151 controller RAM over SPI.
- **`bmp`**: Standard 1-bit Windows BMP (Bitmap DIB v3) with 2-color palette (Black / White).
- **`png` & `jpeg`**: Rendered raster images with dithering applied (ideal for browser previewing and debugging).
- **`16bit-rgb565`**: 2 bytes per pixel (Little-Endian R5G6B5) for SPI TFT displays (ILI9341, ST7789).

---

## 4. Hardware Presets

| Preset Key | Width | Height | Depth | Notes |
|---|---|---|---|---|
| `seeed-reterminal-sticky` | 800 | 480 | `1bit` | Seeed Studio reTerminal Sticky (SSD1677) |
| `waveshare-7.5in-v2` | 800 | 480 | `1bit` | Waveshare 7.5" e-Paper |
| `waveshare-4.2in-v2` | 400 | 300 | `1bit` | Waveshare 4.2" e-Paper |
| `waveshare-2.9in-v2` | 296 | 128 | `1bit` | Waveshare 2.9" e-Paper |
| `waveshare-1.54in-v2` | 200 | 200 | `1bit` | Waveshare 1.54" e-Paper |
| `waveshare-5.65in-acep` | 600 | 448 | `24bit-rgb888` | 7-color ACeP e-Paper |
| `generic-320x240-rgb565` | 320 | 240 | `16bit-rgb565` | Standard 2.4"/2.8" SPI TFT |
| `generic-128x64-1bit` | 128 | 64 | `1bit` | SSD1306 0.96" OLED |

---

## 5. Reference ESP32 Firmware Implementation (C++ / Arduino)

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
