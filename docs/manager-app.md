# ScreenTinker Manager (Android)

`android-admin/` is **ScreenTinker Manager**, a phone app for keeping screens up to date. Package:
`com.screentinker.manager`. It is a separate project from the player app (`android/`,
`com.remotedisplay.player`).

The app is a small native shell around the dashboard's **Simple view**. It needs a **3.0+** server.
Everything the user sees inside it is the server's own Simple view, so web changes reach the app
without an app update.

## What it does

- **Your servers.** screentinker.com and/or any self-hosted servers. Each new server is checked
  (`/api/status`, version 3.0 or newer) before it is saved. Tap a server to switch, or Remove it.
  Each server keeps its own sign-in, because WebView storage is per origin.
- **The Simple view, full screen.** Add a screen, change what a screen shows, upload photos, your
  team (invites), help. The dashboard recognises the app by its user agent
  (`ScreenTinkerManager/<version>`) and the `window.STManager` bridge, and stays in Simple view.
- **Phone extras:**
  - Uploads use Android's photo picker (no storage permission).
  - **Share → ScreenTinker Manager** ("Show on a screen") from Photos or Gallery uploads the files
    and opens "Which screens should show it?".
  - Invite links go through Android's share sheet.
- **Share my screen** (3.0, no account needed): the phone's screen on any ScreenTinker screen, from
  the screen's QR, the `/share` page's **Share my screen with the ScreenTinker app**, the first
  screen's **Share my screen to a meeting-room screen**, or the launcher shortcut — or, signed in,
  from the Simple view's **Share my screen**. It shows *"Share your screen to <host>?"* before
  Android's capture prompt, runs in a foreground service with a Stop notification, and needs
  Android 8+. Native (MediaProjection + libwebrtc), because a WebView cannot capture the screen.
  Details: [screen-share.md](screen-share.md#phones-camera-and-the-android-app).
- **Opens in the browser instead:** Advanced, Admin and Account settings open in a Custom Tab (the
  phone's browser), as do links to other sites. Advanced turns on the Advanced view for that account
  in the browser (`#/switch-advanced`).
- **Not in the app:** plans, upgrade prompts and the self-hosted sponsor ask. Google Play's payments
  policy restricts selling subscriptions or soliciting donations outside Play billing. The same
  account sees them in a browser.
- **Review:** when a workspace requires review, the Simple flows submit changes for review and say
  "Sent for review". They never claim content is showing before a reviewer approves it.

## Single sign-on

Google and most identity providers refuse to sign in inside an app's web view (Google returns
`disallowed_useragent`). So the app runs the whole sign-in in the phone's browser (a Custom Tab)
and takes the session back securely:

1. **Start.** An SSO button in the app (or any `/api/auth/(oidc|saml)/<slug>/start` the web view
   tries to open, which the app intercepts) makes the app create a random **verifier**, kept in the
   app. The browser opens the server's start URL with
   `?app_challenge=BASE64URL(SHA-256(verifier))`. The challenge rides in the server's signed login
   transaction.
2. **Finish.** The provider returns to the server as usual. The server finishes the login but,
   instead of the web claim cookie, redirects to `screentinker-manager://sso?code=…`. The code is
   random, single-use, valid for 2 minutes, and stored hashed (`app_sso_codes`). It carries nothing
   itself.
3. **Swap.** The app posts `{code, verifier}` to `POST /api/auth/sso/app-exchange` (rate-limited)
   and gets the session. Another app that intercepts the `screentinker-manager://` link holds a code
   it cannot use without the verifier, and any wrong attempt burns the code.

Nothing has to be registered with the identity provider for the app: the provider still returns to
the server's normal callback URL. Tested on the Android 16 emulator with a standard OIDC provider,
from the button in the app to signed in as the provider's user.

## Deleting an account

Google Play requires that an account can be deleted from inside the app. Two ways in, both opening
the server's own **Delete my account** page (`#/delete-account`) in the app's web view:

- the menu under your name in the Simple view → **Delete my account**;
- **Your servers** → **Delete account…** under a server (asks first, then opens that server at
  `#/delete-account`; `MainActivity.EXTRA_ROUTE` accepts only that route).

The page asks for the email address typed out and the password (plus the two-factor code). A
single sign-on account taps **Sign in again**, which runs the usual browser hand-off below and
returns to the page; it then has 10 minutes to finish. Nothing native talks to the deletion API, so
the checks are exactly the dashboard's. After the deletion the web view shows `/account-deleted`.
The Play listing's deletion link is `https://screentinker.com/delete-account`. Details:
[accounts.md](accounts.md).

## Building

The build needs JDK 17 and the Android SDK with `platforms;android-36`.

```
cd android-admin
./gradlew assembleDebug                      # app/build/outputs/apk/debug/app-debug.apk
VERSION_CODE=1 VERSION_NAME=1.0.0 \
MANAGER_KEYSTORE=/path/upload.jks MANAGER_KEYSTORE_PASSWORD=… \
MANAGER_KEY_ALIAS=upload MANAGER_KEY_PASSWORD=… \
./gradlew bundleRelease                      # app/build/outputs/bundle/release/app-release.aab
```

- `targetSdk 36`: Google Play requires new apps to target the latest Android release.
- `minSdk 26`: Android 8.0 or later.
- Release builds are minified. The keystore is never committed (`*.jks` / `*.keystore` are ignored).
- Debug builds enable WebView inspection (Chrome DevTools via `adb forward`), which the emulator
  tests use. Release builds do not.

## Play Store submission checklist

- **App name:** ScreenTinker Manager.
- **Graphics:** `android-admin/store/feature-graphic.jpg` (1024×500) and
  `android-admin/store/screenshots/phone-1..6.png` (1080×1920, in listing order). They are real
  captures of Simple view with the Manager app's user agent, on a demo workspace (a fictional café);
  the captions are added around them. Retake them when Simple view changes noticeably.
- **Listing text:** `android-admin/store/listing.md` (name, short and full description). The
  GitHub Sponsors link lives there, not in the app: Play's payments policy covers in-app asks.
- **Icons:** `android-admin/store/icon-512.png` is the store icon. The launcher icons are generated
  in `res/mipmap-*`. They use the player's TV plus a green edit badge, so the two apps are told apart.
- **Data safety:** the app sends the user's sign-in and the photos and videos they choose to the
  server they chose, and, while the person shares their screen, the screen's picture peer to peer to
  the ScreenTinker screen they confirmed (never stored, never through a third party). The code
  scanner is Google Play services' (it returns only the scanned text). No ads, no analytics SDK.
- **Account deletion (Data safety → "Delete account" URL):** `https://screentinker.com/delete-account`.
  In-app: Simple view menu → **Delete my account**, or **Your servers** → **Delete account…**
  (see [Deleting an account](#deleting-an-account)).
- **Permissions:** `INTERNET`, and for **Share my screen**: `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_MEDIA_PROJECTION` (Play Console asks for a declaration and a short video of
  the feature: start a share from a screen's QR, show it on the screen, stop it from the
  notification), `POST_NOTIFICATIONS`, `MODIFY_AUDIO_SETTINGS` and `ACCESS_NETWORK_STATE` (libwebrtc).
  No camera or microphone permission.
- **Size:** libwebrtc makes the universal APK ~44 MB; the Play bundle splits it per CPU, so a phone
  downloads roughly a quarter of that.
- **Cleartext traffic:** allowed for user-entered servers (self-hosted on a LAN is often
  `http://192.168…`), and forbidden for screentinker.com (`res/xml/network_security_config.xml`).
- **Sign-in:** email and password, plus every single sign-on provider the server offers (Google,
  Microsoft, any OIDC provider, SAML, organization SSO). See below.
- **screentinker.com must run 3.0** before the app is useful there: on 2.6 the server check says it
  is too old.

## Testing

`android-admin` has no unit tests yet. It was exercised end to end on an Android 16 (API 36)
emulator (Pixel 7 image):

- first-run server choice;
- sign-up and the setup guide inside the app;
- the native photo picker;
- sharing from Google Photos;
- Advanced opening Chrome;
- two servers with switch-back, still signed in;
- an invite shared through the share sheet.
