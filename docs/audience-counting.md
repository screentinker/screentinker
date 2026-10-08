# Audience counting

Count how many people looked at a screen, and for how long, without recording anyone.

**Off by default.** Nothing counts until an organization owner or admin turns it on for the
organization **and** switches it on for a screen, or for a group of screens.

- [What it counts](#what-it-counts)
- [What it never does](#what-it-never-does)
- [Turning it on](#turning-it-on)
- [The report](#the-report)
- [Which players can count](#which-players-can-count)
- [Accuracy](#accuracy)
- [Before you switch it on: the law and a notice](#before-you-switch-it-on-the-law-and-a-notice)
- [Notice template](#notice-template)

---

## What it counts

For each screen, each minute, and each item that was on screen during that minute:

| Number | Meaning |
|---|---|
| People in view (max, average) | Faces turned towards the screen, at the most and on average |
| Arrivals | Faces that came into view and then left |
| Impressions | Arrivals that looked at the screen for at least the impression time (default **1 second**) |
| How long they looked | How many looks lasted under 2s, 2–5s, 5–15s, 15–30s, 30–60s, and over 60s |
| Time observed | How much of the minute the item was on screen while the camera was counting |

A look is counted when it **ends**, because only then is its length known. It's attributed to the
item that was on screen when the person started looking. If that item has left the screen by
then, its minute carries the look but no observed time.

If the camera stops and starts again within a minute (the screen blanks, the settings change, the
player restarts), the two parts of that minute are sent and kept separately, so neither is lost.

## What it never does

This is enforced in the player **and** on the server.

- **No picture leaves the screen, and none is kept on it.** The player reads a small greyscale
  frame, finds the faces in it, and discards the frame straight away. Frames are never written to
  storage, logged, uploaded or shown. The live view and screenshots never include them.
- **Nobody is recognised.** There is no face recognition, no face "template" or embedding, and
  no ID for a person. A face in view is followed only while it stays in view. Once it leaves,
  nothing about it exists any more, so the same person coming back counts as a new arrival.
- **No age, gender or emotion** is estimated.
- **Only numbers are sent.** The server accepts a fixed set of small whole numbers per minute and
  refuses anything else, so even a modified player couldn't upload more. The database table has
  no column that could hold an image, a face or a person.
- **Counts from a screen that isn't switched on are thrown away.** A screen can't turn counting
  on for itself.

## Turning it on

**Audience** (under Insights) on the dashboard:

1. **Organization settings → Allow audience counting in this organization.** You can also set:
   - **Show a small camera icon** on screens that are counting (on by default).
   - **Frames checked per second** (1–5, default 2).
   - **Seconds of looking that count as an impression** (default 1).
   - **Keep counts for**: retention in days, default 90. Older counts are deleted automatically.
2. **Which screens count:** switch on single screens, or a group to include every screen in it.
3. The first time, the screen asks for camera permission. Someone at the screen allows it once. On
   a device-owner (fully managed) screen the player grants it itself, where Android allows that.

Switching the organization or a screen off stops the camera within seconds. A screen that was
offline at the time stops on its next connection.

## The report

**Audience → Report** shows, for the selected dates:

- impressions, arrivals, average look and the most people at once
- impressions **by hour of day** (in your time zone) and **per day**
- the **look-length histogram**
- **by content**, with plays beside it and impressions per play
- **by screen** and **by playlist**

The dates are days in **your** time zone: a day runs from your midnight to your midnight.

**Average people in view** is weighted by the time observed. An item that was on screen for 10
seconds of a minute counts for 10 seconds, not the whole minute. **Minutes observed** is the total
of that time.

**Plays** and **impressions per play** only count plays that started on a screen, in a minute, when
that screen was counting. A play on a screen without a camera, or while the camera was off, couldn't
have been seen, so it isn't counted.

**Export CSV** gives one row per screen, per minute, per item, with the seconds observed in the last
column. A minute where the camera restarted can have two rows for the same item.

## Which players can count

| Player | Counts? | How |
|---|---|---|
| Android (phones, tablets, Android TV / Google TV, Fire TV with a USB camera) | Yes | Camera2 plus Android's built-in face detector. No extra download, and no Google Play services needed |
| Raspberry Pi / Windows (native) | Yes, with the add-on | A USB webcam plus the optional **audience-counting add-on** (OpenCV and the YuNet face detector, about 54 MB). It's chosen at install time and off by default. See [The add-on for Raspberry Pi and Windows](#the-add-on-for-raspberry-pi-and-windows) |
| Web, Tizen, webOS, BrightSign | No | No camera access a signage player can rely on |

The **Which screens count** list says when a player hasn't reported a camera.

On Android the camera used is the front camera if there is one, then a USB camera, then any
camera. On a Raspberry Pi or Windows player it's the first USB webcam.

### The add-on for Raspberry Pi and Windows

The face detector needs OpenCV, which is too big to put in every player install. So it comes as a
separate add-on, and **you choose it when you install the player. It's off by default.** Without
it, the player plays as normal and doesn't report a camera.

| | How to add it |
|---|---|
| **Windows** | Tick **Audience counting add-on** in the installer. For a silent install, add `/MERGETASKS=audience` (with `/VERYSILENT /SUPPRESSMSGBOXES`; a silent install that can't add the add-on only notes it in the setup log). An upgrade keeps your choice, and running the installer again with the box unticked removes the add-on. |
| **Raspberry Pi** | Answer **y** when the installer asks, or pass `--audience`. On a Pi that's already installed, run `sudo screentinker-pi audience-addon install`. To remove it, use `... remove`. Needs 64-bit Pi OS: a 32-bit Pi OS on a 64-bit kernel isn't enough. |

The add-on is downloaded from **your own ScreenTinker server** and checked against the SHA-256
checksum the server publishes. Nothing is installed if they don't match.

| Platform | Download | Size on disk |
|---|---|---|
| Windows | about 53 MB | about 150 MB |
| Raspberry Pi (64-bit) | about 54 MB | about 145 MB |

It's installed where only an administrator can change it: `C:\Program Files\ScreenTinker\addons\audience`
on Windows, `/usr/lib/screentinker-pi-audience` on a Pi. The player loads code from there, so it must
not be writable by the player's user or the dashboard's remote terminal. The player checks this
before loading it. On a Pi, the folder and every folder above it must belong to root and be
writable only by root, with no symlinks. On Windows, it must be inside the player's install folder.
Otherwise the screen reports that it can't count, and why.

Older players put the Pi add-on in `/opt/screentinker/audience-addon`. It isn't used from there any
more, because an all-in-one Pi gives `/opt/screentinker` to the Pi's user. Run
`sudo screentinker-pi audience-addon install` again, which also deletes the old copy.

**Hosting it (self-hosted servers).** Build it with
`python3 native/packaging/audience/build-addon.py`, which writes
`native/dist/screentinker-audience_<version>_<platform>.zip` for `win-x64-cp312`,
`linux-aarch64-cp313` and `linux-x86_64-cp313`. Put the zips in the server's data directory, next
to the player packages. The platform name includes the Python version, because the add-on only
loads into the Python it was built for: 3.12 for the Windows player, 3.13 on Pi OS Trixie.

**Cameras.**
- On a **Pi**, any USB (UVC) webcam works. A camera module on the ribbon connector doesn't, because
  it needs libcamera, which OpenCV can't read from.
- On **Windows**, the camera must be allowed for desktop apps under **Settings → Privacy & security
  → Camera**.
- To choose a camera other than the first one, set `"audience_camera"` in the player's config file
  to a device path such as `/dev/video2`, or to a camera index on Windows.
- If the camera won't open or stops sending pictures, the player keeps retrying, waiting longer
  each time, up to a minute between tries. Every fifth failed try it looks for cameras again and
  switches to the first one it finds, for example a webcam that was unplugged and plugged back in.
  A camera you set in `"audience_camera"` is never switched.

**How it detects.** The player uses OpenCV's YuNet detector on a 480-pixel-wide greyscale frame and
counts only **frontal** faces: both eyes visible, with the nose between them. This is the same rule
as Android's detector. The counting rules and the data sent are identical to Android's, so a Pi and
an Android screen in the same room report comparable numbers. Checked on a test clip: one face in
view for about 12 seconds gave one arrival and one impression in the 5–15s bucket, with 0.83
people in view on average.

## Accuracy

The detector looks for **frontal faces**, which is what an impression means: someone looking at
the screen. Some things to know:

- Faces in profile, or turned away, aren't counted. That's intended.
- It works best within about 3–4 metres of a 720p camera, in reasonable light.
- Two faces that cross each other can be counted as one look ending and a new one starting.
- Treat the numbers as a **consistent measure for comparing** content, times and screens, not as
  an exact headcount.

Checked on the Android emulator with a test clip showing a face for 8 seconds and then an empty
frame for 4: it reported 5 looks per minute, all in the 5–15s bucket, with 0.62–0.73 people in
view on average (the true value is 0.67).

## Before you switch it on: the law and a notice

The counts aren't biometric data. No face template is created or kept, and the frames are never
stored. **But a camera pointed at the public is still regulated in many places.** Check with your
own adviser before you switch it on. In particular:

- **EU / UK (GDPR):** processing a camera image, even briefly and on the device, can count as
  processing personal data. You need a lawful basis (usually legitimate interests, with an
  assessment), a visible notice, and possibly a DPIA.
- **Illinois (BIPA), Texas, Washington:** these laws regulate biometric identifiers. No identifier
  is created here, but put the notice up anyway.
- **California (CCPA/CPRA)** and other US states: notice at collection.
- **Workplaces:** staff areas often need consultation or a works-council agreement.

Put a notice where people can see it before they're in view.

## Notice template

> **Audience measurement in use**
>
> This screen counts how many people look at it, and for how long, using a camera.
>
> - The counting happens **inside the screen**. No images or video are stored or sent anywhere.
> - **Nobody is identified or recognised.** No facial recognition is used, and no biometric
>   data is created or kept.
> - Only anonymous totals are kept (for example, "12 people looked at this screen between 10:00
>   and 10:01"), for _[90]_ days.
>
> Operated by _[organization name]_. Questions: _[contact]_.
