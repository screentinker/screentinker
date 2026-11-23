# Curbside pickup

**Curbside pickup** lets customers tell you they have arrived in your car park, so staff can bring the order out. Each parking spot has its own QR code. The customer scans it, types their order number and taps **I'm here**. Staff see the car on a phone or tablet (or in the dashboard), press **We got you** so the customer knows someone is coming, and **Done** when the order has been handed over. A **Curbside** widget can show the cars on your screens.

- **Customers** scan the code on their spot. They type an order number (and, if they like, a short note such as the colour of the car) and tap **I'm here**. The page then shows their status and updates by itself: waiting, then "We got you" once staff have seen them, then done. They can cancel.
- **Staff** open a staff link on a shared phone or tablet (no account needed), or use the dashboard. They see the cars waiting, oldest first, with the spot, the order number, the note and how long each has waited.
- **Screens** show the cars in a **Curbside** widget as order number, spot and status ("Order 1234 · Spot 4 · On the way"), with an optional short chime.

It is standalone: there is no connection to a till or an ordering system, and there is no name field anywhere. It works the same on hosted and self-hosted servers. Everything runs on your ScreenTinker server, and nothing is sent to anyone else.

## Contents

- [1. Create the location](#1-create-the-location)
- [2. Print the QR codes](#2-print-the-qr-codes)
- [3. Give staff the link](#3-give-staff-the-link)
- [4. Put the widget on your screens](#4-put-the-widget-on-your-screens)
- [Change the words](#change-the-words)
- [What customers see](#what-customers-see)
- [One car per spot](#one-car-per-spot)
- [End of the day](#end-of-the-day)
- [Sound](#sound)
- [Limits](#limits)
- [Security and privacy](#security-and-privacy)
- [If something looks wrong](#if-something-looks-wrong)

---

## 1. Create the location

1. In the dashboard, open **Curbside pickup** (in the Create section of the menu; switch to **Advanced** if you do not see it).
2. Press **New location** and give it a name your customers will recognise, such as "Main St Pizza".
3. Say how many parking spots it has. Type a number (for example `8` gives spots 1 to 8), or type your own labels separated by commas (for example `A1, A2, B1, B2`).

You can change the name, the timezone and the spots later under **Settings** on the location's card. Spot labels can be up to 12 characters each, up to 200 spots. **Or number them 1 to** fills the list with 1 to N for you.

The location takes the timezone of the browser you created it from. Open check-ins close at midnight in that timezone (see [End of the day](#end-of-the-day)).

Only people who can edit the workspace can create a location, mark cars as seen or done, change the words or see the staff link. Read-only members see the location, the cars waiting and the QR codes, and nothing else.

## 2. Print the QR codes

On the location's card, press **Print QR codes**. A page opens with one card per spot, each with the location's name, the heading, the spot label in large print, the QR code and a short instruction ("Scan with your phone camera, type your order number and tap I'm here"), and your browser's print dialog. Two cards fit across a page; cut them out and put each one at its spot.

Open the dashboard at the address your customers' phones can reach before printing: the QR codes contain the address you are using. The dashboard warns you if that address looks private to your network.

**Copy customer link** copies a link without a spot, for a website or a sign at the entrance: that page asks the customer to choose their spot from a list.

If printed codes should stop working, use **Settings → New QR codes**. The old codes stop working at once, so print the new ones. After you change the spot labels, print the codes again too.

## 3. Give staff the link

Under **Staff link** on the location's card:

- **Copy** or **Open** the link, and open it on the shared phone or tablet staff will use. Add it to the home screen for one-tap access.
- **Replace** makes a new link. The old one stops working immediately; use this when a device is lost or someone leaves.
- **Turn off** disables the staff link until you make a new one. The dashboard keeps working.

The staff page lists the cars waiting, oldest first. Each car shows its spot, order number, note, and how long it has waited, coloured green (under 5 minutes), yellow (5 to 10 minutes) and red (10 minutes or more). The buttons:

- **We got you**: the customer's page changes to your "We got you" message and the screens show the order as **On the way**.
- **Done**: the car leaves the list, and the customer's page shows your "done" message.

Press **Sound for new cars** on the staff page to hear a short chime (and feel a vibration, on phones that support it) whenever a new car checks in. The tap is also what lets the browser play sound; the setting is remembered on that device.

Anyone holding the staff link can do all of that, so treat it like a key. Signed-in editors can do the same from the dashboard without the link.

## 4. Put the widget on your screens

The quickest way: press **Show on a screen** on the location's card. It makes the location's Curbside widget (or finds it) and adds it to the playlist you choose.

Or do it yourself:

1. Open **Widgets**, press **New widget** and choose **Curbside**.
2. Pick the location (it is picked for you when there is only one), how many cars it shows at once (1 to 20, 8 by default; more than that shows "+N"), the colours, and the chime (see [Sound](#sound)).
3. Save it, then use it like any other widget: in a **layout zone** next to your menus or videos (the text scales to the zone's size), as an item in a **playlist**, or on its own.

The widget shows each car as the order number, the spot and the status (**Waiting**, or **On the way** once staff pressed We got you), oldest first. It never shows a name (there is none) and never shows the customer's note, which is for staff only. With no cars it shows "No cars waiting".

It asks the server every 4 seconds. If the server cannot be reached it keeps showing the last list it had; after about 20 seconds without an answer a small dot appears in its corner. It never goes blank and never shows an error.

## Change the words

Every word on the customer page, and every label on the screen widget, can be changed per location. Open **Words on the customer page and the screens** on the location's card. Each box shows the default; leave a box empty to keep the default, type your own text to replace it, and press **Save words**. **Use all defaults** clears them all.

Customer page: the heading, the instructions, the spot label, "Choose your parking spot" (on a link without a spot), the order number and note labels, the **I'm here** button, the waiting message, the "We got you" message, the done message, the "this spot is taken" message, the cancel button, the cancelled message, the **Check in again** button, and the "keep this page open" note.

Screen widget: the heading, the words before the order number ("Order") and the spot ("Spot"), the two statuses ("Waiting", "On the way"), and the text shown when no cars are waiting.

In the messages, `{spot}` and `{order}` are replaced with the customer's spot and order number, for example "Thanks! Please stay in spot {spot}." This is also how you translate the pages: type the words in your customers' language.

Everything is plain text. If you type `<b>` you will see `<b>` on the page; nothing you type is ever treated as HTML. Each text has a length limit (shown by the box), and line breaks become spaces.

## What customers see

1. The location name, the heading, their spot in large print and the instructions.
2. **Order number** (required, up to 20 characters: letters, digits, spaces and `# . _ / -`) and an optional note (up to 80 characters).
3. After **I'm here**: the waiting message, their order number, and a **Cancel my check-in** button. The page updates by itself every few seconds.
4. When staff press **We got you**: the "We got you" message.
5. When staff press **Done**: the done message, and a **Check in again** button for a later visit.

Opening the link again on the same phone shows the same check-in instead of starting a new one. A double tap or a slow network never makes two check-ins.

## One car per spot

A spot can have only one open check-in at a time. Another phone that opens the same spot's code sees your "this spot is taken" message, and its **I'm here** button stays disabled until the spot is free again (when staff press Done, or the customer cancels). This is enforced by the server's database, so two phones tapping at the same moment still get one check-in.

A phone that already has an open check-in gets that check-in back, whichever spot's code it scans.

## End of the day

Nothing needs to run at midnight. The first time anyone or anything looks at the location after midnight in its timezone (a screen, a phone, the staff page), check-ins still open from the day before are closed (they are not shown to anyone any more) and their spots are free. Check-ins are kept for 7 days and then deleted, so staff and support can look back over the week if they need to. A daily clean-up does the same for locations nobody opened.

## Sound

On the **screens**, the widget's chime is off by default. Switch on **Play a chime** in the widget's settings and choose when: when staff press **We got you** (the default), when a car arrives, or both, at a **Volume** from 0 to 100%. It plays once per change, never repeats, and never plays for the cars already on the list when a screen starts.

It uses the same sound path as the "Now serving" widget ([Now serving queues: Sound](now-serving-queue.md#sound)), so the same rules apply: no chime on a muted screen or playlist item, on a video wall follower, or during an emergency alert, and at most one chime every 3 seconds. On the **web player** it needs sound allowed (click the screen once, or start it with `?autoplay_audio=1` on a kiosk browser that allows sound); webOS and BrightSign run the web player. Android, Samsung Tizen and the native Pi and Windows player honour the same request from a widget, so the chime should play there too, but the end-to-end tests cover the web player only. **Roku** shows widgets as a picture the server draws and its chime only follows Now serving queues, so a Roku stays silent for curbside. Samsung SSSP3 does not show this widget.

On the **staff page**, see [Give staff the link](#3-give-staff-the-link).

## Limits

- One network address can make at most 20 new check-ins a minute, and cancel at most 20. Re-opening the page for a check-in a phone already has is never limited.
- Staff actions are limited to 120 a minute per address, and wrong staff links to 20 a minute.
- Up to 200 spots per location.

## Security and privacy

- The customer link and the staff link each contain their own random 32-byte key. Neither is the location's id, and the customer key cannot be used to mark cars as seen or done.
- The staff key sits after the `#` in the staff link, which browsers never send to a server: it is in no server log and no `Referer`. The staff page sends it in a request header, and the server compares it in constant time.
- Each customer's browser makes a random id and keeps it, and sends it in a request header (never in the address). It is how the page finds the same check-in again, and the only thing that can cancel it.
- The pages are sent with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and are not indexed by search engines. Server logs record the route shape only, never a key.
- A check-in stores the spot, the order number, the optional note, the times, the status and that random browser id. Nothing else: no name, no phone number, no address, no device. Check-ins are deleted after 7 days.
- A screen's widget never sees either key and never sees the note; it reads the order numbers, spots and statuses through its own widget id.
- Everything a customer or an admin types is shown as text everywhere (pages, widget, dashboard) and never treated as HTML.
- Deleting a location deletes its check-ins. Deleting a workspace deletes its locations and check-ins. An organization export includes each location's settings and words, without the keys, and no check-ins; an import does not re-create locations (make a new one and print its QR codes).

## If something looks wrong

- **The widget shows "No cars waiting" but there are cars.** Check that the widget is linked to the right location (edit it and pick one).
- **The widget shows cars but a dot in the corner.** The screen cannot reach the server; it will catch up by itself when it can.
- **"This staff link is not valid any more."** It was replaced or turned off. Copy the current one from the dashboard.
- **"This curbside link is not active."** The QR codes were replaced (Settings → New QR codes) or the location deleted. Print the current codes.
- **A customer says their spot is taken.** Someone else has an open check-in there. Press Done on that car if it has left, or ask the customer to use another spot.
- **The spot on a printed code no longer exists.** The spot labels were changed after printing; the page asks the customer to choose a spot. Print the codes again.
- **No chime.** On a screen: check the widget's chime, its volume and when it plays, that the screen is not muted, and that the player is one that chimes (see [Sound](#sound)). On the staff page: tap **Sound for new cars** so it says "on".
- **Check-ins closed at the wrong time.** Check the location's timezone under Settings.
