# Provisioning a panel as ScreenTinker device owner (#161)

Device owner is an **optional power-up**. Without it the app runs fully at Tier 0/1
(normal signage). With it, the panel unlocks Tier-2 controls that have no cheaper
reliable path on a non-rooted device:

- **Silent app updates** — no "Install / Update?" dialog over content (the fix for #155)
- **Clean reboot** / scheduled reboot (real reboot, not the power-menu)
- **Silent kiosk lock-task**, disable status bar / keyguard
- **Set time / timezone**, block uninstall

There is **one** device owner per device. If an MDM (e.g. Pivot) is already owner,
ScreenTinker **cannot** also be owner — it degrades to Tier 0/1 and the MDM owns
updates/reboots. See #166 (self-OTA stands down under a foreign device owner).

Component to enroll:

```
com.remotedisplay.player/.admin.STDeviceAdminReceiver
```

---

## Option A — ADB (primary path for self-hosted operators)

Fastest and most reliable. **Constraints — all must hold or `set-device-owner` fails:**

- **No accounts on the device** (remove every Google/other account first).
- Device is **freshly set up / factory-reset**, ideally right after first boot.
- Done **before provisioning completes** (before other device-owner-capable apps enroll).
- The ScreenTinker APK is already **installed**.

```bash
# 1. Install the app (skip if already installed)
adb install -r ScreenTinker.apk

# 2. Make it device owner
adb shell dpm set-device-owner com.remotedisplay.player/.admin.STDeviceAdminReceiver
```

Success prints `Success: Device owner set to ...`. Verify:

```bash
adb shell dumpsys device_policy | grep -i "device owner"
```

To remove later (self-hosted): `adb shell dpm remove-active-admin com.remotedisplay.player/.admin.STDeviceAdminReceiver`
(a true device owner generally requires a **factory reset** to fully clear).

USB debugging must be on: Settings → About → tap Build number 7× → Developer
options → USB debugging.

---

## Option B — QR provisioning (operator-friendly, no ADB cable)

Best non-expert path. The dashboard generates the QR (Devices → a panel →
**Provision as device owner**), which carries the DPC component, the APK download
URL, and the **signing-cert checksum** so the freshly-enrolled device pulls a
verifiable APK.

On the panel:

1. **Factory reset** the device.
2. On the setup-wizard **Welcome** screen, tap the screen **6 times** in the same spot.
3. The device offers to scan a QR (it downloads a QR reader if needed). **Scan the
   dashboard QR.**
4. It downloads + installs ScreenTinker and sets it as device owner, then finishes setup.
   The panel then **self-configures** (see "After enrollment" below) and lands on a pairing
   code — enter that code in the dashboard and you're done.

The QR payload (for reference / manual builds) is the standard AOSP provisioning JSON:

```json
{
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME":
    "com.remotedisplay.player/.admin.STDeviceAdminReceiver",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION":
    "https://<your-server>/download/apk",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM":
    "s9ZOWAvn3qFYJxaaR0j41ZttQK1r6_XgaTMcB7rIqqI",
  "android.app.extra.PROVISIONING_SKIP_ENCRYPTION": true,
  "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": { "server_url": "https://<your-server>" }
}
```

> **Checksum** = URL-safe base64 (no padding) of the SHA-256 of the app's **signing
> certificate** (not the APK bytes) — constant for a given signing key. The dashboard now
> **computes it from the served APK** at QR-generation time, so it's always correct for
> whatever build is on disk (the response's `checksum_source` is `apk` when derived, or
> `fallback` when no APK is present). To compute by hand:
> `keytool -exportcert -keystore release-key.jks -alias <alias> | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '='`
>
> **Compliance handler required.** Android 12+ aborts QR provisioning after install unless the
> DPC answers `ADMIN_POLICY_COMPLIANCE` (symptom: *"something went wrong, contact your IT
> admin"*). ScreenTinker ships that handler (`admin/ProvisioningActivity`); `adb set-device-owner`
> skips this flow, which is why the ADB path never needed it.
>
> **`server_url`** in the admin-extras bundle is delivered to the player after enrollment; it
> pre-fills the server URL and auto-advances to the pairing code (no typing). Optional and
> additive — a build/install that ignores it is unaffected.

## After enrollment — what's automatic vs. the one manual step

On becoming owner the app applies an **onboarding policy** (`STPolicy.applyOnboardingPolicy`, all
device-owner APIs, all no-ops off-owner) so a fresh panel **skips the manual first-run wizard**:

- **HOME launcher** set via `addPersistentPreferredActivity` (no "set default launcher" tap; no
  reliance on the display-over-apps / full-screen-intent boot path — handy where an OEM disables them).
- **Kiosk lock-task** package pre-whitelisted; **notifications** permission granted; server URL seeded.
- Unknown-sources is moot (owner silent-installs).

**Accessibility is the lone exception — and cannot be automated.** It powers the Tier-2 remote
screen-view + tap/swipe only (not playback/OTA/kiosk). Android exposes **no** API — not even to a
device owner — to enable an accessibility service; it always needs a human toggle or ADB. On
Android 13+ a provisioning-installed app is also gated by **Enhanced Confirmation Mode ("restricted
settings")**, which a true device owner *should* be exempt from but some OEM builds (e.g. KB1001)
don't honor. Two ways to enable it:

- **Manual (once per panel):** Settings → Apps → ScreenTinker → **⋮ → Allow restricted settings**,
  then Settings → Accessibility → ScreenTinker → **On**. Persists across reboots/OTA.
- **ADB during staging (zero-UI):**
  ```bash
  adb shell appops set com.remotedisplay.player ACCESS_RESTRICTED_SETTINGS allow   # clears the ECM gate
  adb shell settings put secure enabled_accessibility_services com.remotedisplay.player/.service.PowerAccessibilityService
  adb shell settings put secure accessibility_enabled 1
  ```
  (Shell holds `WRITE_SECURE_SETTINGS`; the app can't, by design.)

## Option C — Zero-touch

Google zero-touch enrollment needs a reseller account — **out of scope** for
self-hosted OSS. Mentioned for completeness; use A or B.

---

## In-app guidance

If a panel is not device owner (and no MDM manages it), the player's **Setup →
Hardware control** screen shows the current tier, the exact ADB one-liner, and the
provisioning QR, and live-rechecks `isDeviceOwnerApp()` so the tier flips as soon as
enrollment succeeds.
