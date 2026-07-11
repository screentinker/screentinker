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

The QR payload (for reference / manual builds) is the standard AOSP provisioning JSON:

```json
{
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME":
    "com.remotedisplay.player/.admin.STDeviceAdminReceiver",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION":
    "https://<your-server>/download/apk",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM":
    "s9ZOWAvn3qFYJxaaR0j41ZttQK1r6_XgaTMcB7rIqqI",
  "android.app.extra.PROVISIONING_SKIP_ENCRYPTION": true
}
```

> **Checksum** = URL-safe base64 (no padding) of the SHA-256 of the app's **signing
> certificate** (not the APK bytes) — constant for a given signing key. The value
> above is ScreenTinker's release key. If you re-sign with your own key, regenerate:
> `keytool -exportcert -keystore release-key.jks -alias <alias> | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '='`

## Option C — Zero-touch

Google zero-touch enrollment needs a reseller account — **out of scope** for
self-hosted OSS. Mentioned for completeness; use A or B.

---

## In-app guidance

If a panel is not device owner (and no MDM manages it), the player's **Setup →
Hardware control** screen shows the current tier, the exact ADB one-liner, and the
provisioning QR, and live-rechecks `isDeviceOwnerApp()` so the tier flips as soon as
enrollment succeeds.
