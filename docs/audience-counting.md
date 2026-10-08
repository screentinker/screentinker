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

A look is counted when it **ends**, because only then is its length known. It's attributed to the
item that was on screen when the person started looking.

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

**Export CSV** gives one row per screen, per minute, per item.

## Which players can count

| Player | Counts? | How |
|---|---|---|
| Android (phones, tablets, Android TV / Google TV, Fire TV with a USB camera) | Yes | Camera2 plus Android's built-in face detector. No extra download, and no Google Play services needed |
| Raspberry Pi / Windows (native) | Not yet | Planned. The detector needs OpenCV, which would add about 50 MB to every install |
| Web, Tizen, webOS, BrightSign | No | No camera access a signage player can rely on |

The **Which screens count** list says when a player hasn't reported a camera.

The camera used is the front camera if there is one, then a USB camera, then any camera.

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
