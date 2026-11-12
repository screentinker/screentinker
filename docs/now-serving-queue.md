# Now serving queues

A **Now serving** queue gives your customers a number from a QR code, lets staff call the next number from a phone or tablet, and shows the number being served on your screens. The rest of each screen's layout keeps playing as usual: the number sits in a widget, in whatever layout zone you put it.

- **Customers** scan a QR code. The page gives them a number and shows it next to the number being served, and roughly how many numbers are ahead of them. It updates by itself.
- **Staff** open a staff link on a shared phone or tablet (no account needed), or use the dashboard. A big **Next** button calls the next number; **Call number** calls any number handed out today (skip ahead or call someone back); **Start of day** restarts the numbers.
- **Screens** show the number in a **Now serving** widget, with an optional short chime when a number is called.

It works the same on hosted and self-hosted servers. Everything runs on your ScreenTinker server: the customer and staff pages are plain web pages, and nothing is sent to anyone else.

## Contents

- [1. Create the queue](#1-create-the-queue)
- [2. Put the widget on your screens](#2-put-the-widget-on-your-screens)
- [3. Print the QR code](#3-print-the-qr-code)
- [4. Give staff the link](#4-give-staff-the-link)
- [Daily restart and Start of day](#daily-restart-and-start-of-day)
- [Sound](#sound)
- [Recent activity](#recent-activity)
- [Limits](#limits)
- [Security and privacy](#security-and-privacy)
- [If something looks wrong](#if-something-looks-wrong)

---

## 1. Create the queue

1. In the dashboard, open **Now serving** (in the Create section of the menu; switch to **Advanced** if you do not see it).
2. Press **New queue** and give it a name your customers will recognise, such as "Pharmacy" or "Front desk".

The queue takes the timezone of the browser you created it from. Check it under **Settings** on the queue's card: numbers restart at midnight in that timezone (see [Daily restart](#daily-restart-and-start-of-day)). You can also set the most numbers it hands out in a day (1 to 9999, 999 by default).

Only people who can edit the workspace can create a queue, call numbers or see the staff link. Read-only members see the queue and its QR code, and nothing else.

## 2. Put the widget on your screens

1. Open **Widgets**, press **New widget** and choose **Now serving**.
2. Pick the queue (it is picked for you when there is only one), and optionally change the heading, the colours, and the chime (see [Sound](#sound)).
3. Save it, then use it like any other widget:
   - in a **layout zone**, next to your menus, slides or videos (the number scales to the zone's size), or
   - as an item in a **playlist**, or on its own.

The widget asks the server for the number every 4 seconds. If the server cannot be reached it keeps showing the last number it had; after about 20 seconds without an answer a small dot appears in its corner. It never goes blank and never shows an error. Until the first number is called it shows a dash.

## 3. Print the QR code

On the queue's card, press **Print QR code**. A page opens with the queue's name, "Scan to get your number", the QR code and its address, and your browser's print dialog. **Copy customer link** copies the same address, for a website or a message.

Open the dashboard at the address your customers' phones can reach before printing: the QR code contains the address you are using. The dashboard warns you if that address looks private to your network.

If a printed code should stop working (for example it ended up somewhere it should not be), use **Settings → New QR code**. The old code stops working at once, so print the new one.

What customers see: their number, the number being served, and "About X numbers ahead of you" (the numbers still to be called before theirs; the one being served is not counted), or "You are next". When their number is called the page says it is their turn; if it has already passed, it says so. Opening the link again on the same phone the same day shows the same number instead of taking a new one.

## 4. Give staff the link

Under **Staff link** on the queue's card:

- **Copy** or **Open** the link, and open it on the shared phone or tablet staff will use. Add it to the home screen for one-tap access.
- **Replace** makes a new link. The old one stops working immediately; use this when a device is lost or someone leaves.
- **Turn off** disables the staff link until you make a new one. The dashboard keeps working.

The staff page has the big **Next** button, **Call number**, the **Chime on the screens** switch, **Start of day**, and the recent activity. Anyone holding the staff link can do all of that, so treat it like a key. Signed-in editors can do the same from the dashboard without the link.

## Daily restart and Start of day

Numbers restart at 1 in two ways:

- **Automatically at midnight**, in the queue's timezone. Nothing needs to run at midnight: the first time anyone or anything looks at the queue after midnight (a screen, a phone, a staff page), the new day starts. Screens show a dash until the first number of the day is called.
- **Manually, with Start of day**, on the staff page or the dashboard, whenever you like (for example when you open in the morning, or to clear a queue after a busy event). It asks for confirmation.

Either way every number handed out before stops counting. A customer still holding an old number is told that the queue has started again and can take a new one.

## Sound

The chime is one short two-tone sound, played once each time a number is called (with Next or Call number). It never repeats, never loops, and does not play when a screen first loads or when the day restarts. Two things must both be on:

- **The widget's own chime**: **Play a chime when a number is called**, in the widget's settings, with a **Volume** from 0 to 100%. It is **off by default**.
- **The queue's sound switch**: **Chime on the screens**, on the staff page and on the dashboard. It is on by default, so staff can silence every screen showing the queue (and switch it back on) without editing any widget.

Screens follow the same sound rules as the rest of their content, so the chime does not play when:

- the screen is muted (from the dashboard, or the playlist item is muted), or it is a follower in a video wall, or an emergency alert is playing;
- the browser has not been allowed to play sound. On the **web player**, either click the screen once, or start it with `?autoplay_audio=1` on a kiosk browser that allows sound (see the web player notes).

Today the chime is played by the **web player** (any browser or kiosk browser showing `/player`). The other players (Android, the native Pi and Windows player, Tizen, webOS, BrightSign, Roku) show the number but stay silent.

## Recent activity

The staff page and the dashboard show the last 20 things that happened in the queue, with the time: each number called (Next or Call number), Start of day, the automatic midnight restart, and the sound being switched on or off, and whether it came from the staff link or the dashboard. Older entries are deleted. Taking a number is not recorded there, and nothing about customers is.

## Limits

- At most the queue's daily maximum of numbers a day (999 by default, up to 9999). After that the customer page says no more numbers can be handed out today and to ask a member of staff.
- One network address can take at most 20 new numbers a minute, so nobody can drain the queue. Re-opening the link for a number a phone already holds is never limited.
- Staff actions are limited to 120 a minute per address, and wrong staff links to 20 a minute.

## Security and privacy

- The customer link and the staff link each contain their own random 32-byte key. Neither is the queue's id, and the customer key cannot be used to call numbers.
- The staff key sits after the `#` in the staff link, which browsers never send to a server: it is in no server log and no `Referer`. The staff page sends it in a request header. The server compares it in constant time.
- The pages are sent with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and are not indexed by search engines. Server logs record the route shape only, never the key.
- A number is stored with an optional random id the customer's browser made (so a second scan gets the same number), and nothing else: no address, no device, no name. Tickets are deleted when the day restarts.
- A screen's widget never sees either key; it reads the number through its own widget id.
- Deleting a workspace deletes its queues, tickets and activity. An organization export includes each queue's settings and recent activity, without the keys; an import does not re-create queues (make a new one and print its QR code).

## If something looks wrong

- **The widget shows a dash.** No number has been called yet today, or the widget is not linked to a queue (edit it and pick one), or the queue was deleted.
- **The widget shows a number but a dot in the corner.** The screen cannot reach the server; it will catch up by itself when it can.
- **"This staff link is not valid any more."** It was replaced or turned off. Copy the current one from the dashboard.
- **"This queue link is not active."** The QR code was replaced (Settings → New QR code) or the queue deleted. Print the current code.
- **No chime.** Check the widget's chime and volume, the queue's **Chime on the screens** switch, that the screen is not muted, and that the screen is a web player that has been clicked once or started with `?autoplay_audio=1`.
- **Numbers restarted at the wrong time.** Check the queue's timezone under Settings.
