# Meeting-room displays

A **Room Display** widget turns the screen outside a meeting room into a room sign. It shows:

- a big **Available / In use** state, in colour with an icon and a word, so it reads without the colour
- the meeting in progress and how long is left
- the rest of today's meetings and when the room is next free

On touch screens people can **book the room now** or **end a meeting early**, and they can check in if your organization turns that on.

The calendars stay yours. Each organization brings its own Microsoft 365 app or Google service account, and ScreenTinker never sends a calendar credential to a screen.

## Contents

- [What you need](#what-you-need)
- [Microsoft 365](#microsoft-365)
- [Google Workspace](#google-workspace)
- [ICS calendars (read-only)](#ics-calendars-read-only)
- [Add a room and a display](#add-a-room-and-a-display)
- [What the panel may do](#what-the-panel-may-do)
- [Privacy](#privacy)
- [Which screens can book](#which-screens-can-book)
- [How it behaves offline](#how-it-behaves-offline)
- [Troubleshooting](#troubleshooting)

---

## What you need

| Calendar | Set up by | Book from the panel |
|---|---|---|
| Microsoft 365 room mailbox | an organization admin, under **Settings → Meeting rooms** | yes |
| Google Workspace resource calendar | an organization admin, under **Settings → Meeting rooms** | yes |
| Any calendar published as an ICS address | a workspace admin, when adding the room | no, read-only |

## Microsoft 365

1. In the **Entra admin center**, go to **App registrations → New registration**. A single-tenant registration is fine, and no redirect URI is needed.
2. Under **Certificates & secrets**, create a **client secret** and copy its value.
3. Under **API permissions → Microsoft Graph → Application permissions**, add the permissions below, then grant admin consent:
   - `Calendars.Read` to show rooms
   - `Calendars.ReadWrite` as well, if panels should book, end or release meetings
   - `Place.Read.All` (optional), so **Find rooms** can list your rooms
4. **Scope the app to room mailboxes only (recommended).** Application permissions reach every mailbox in the tenant unless you restrict them. In Exchange Online PowerShell:
   ```powershell
   New-DistributionGroup -Name "ScreenTinker rooms" -Type Security -Members boardroom@contoso.com,huddle1@contoso.com
   New-ApplicationAccessPolicy -AppId <application-id> -PolicyScopeGroupId "ScreenTinker rooms" `
     -AccessRight RestrictAccess -Description "ScreenTinker room displays: room mailboxes only"
   Test-ApplicationAccessPolicy -AppId <application-id> -Identity boardroom@contoso.com
   ```
   Microsoft's newer RBAC for Applications gives the same scoping.
5. In ScreenTinker, go to **Settings → Meeting rooms → Add a calendar connection → Microsoft 365**. Enter:
   - the **tenant ID**: your directory GUID or a verified domain, not `common`
   - the **application (client) ID**
   - the **client secret**
6. Press **Test**. It signs in and, if `Place.Read.All` was granted, counts your rooms. A wrong secret or a missing consent shows Microsoft's own message.

A meeting booked at a panel is created in the **room's own calendar**, organised by the room, with the title "Booked at the room display".

## Google Workspace

1. In Google Cloud, create a **service account** and download a **JSON key**. Enable the **Google Calendar API**.
2. Give the account access in one of two ways:
   - **Share each room's calendar** with the service account's address. Use "See all event details", or "Make changes to events" if panels should book. Leave **Admin to act as** empty.
   - **Domain-wide delegation.** In the Admin console, go to **Security → API controls → Domain-wide delegation** and add the account's client ID with these scopes:
     - `https://www.googleapis.com/auth/calendar.events`, or `.../calendar.events.readonly` for a read-only connection
     - `https://www.googleapis.com/auth/admin.directory.resource.calendar.readonly`, so **Find rooms** can list your rooms
     
     Then enter an admin's address as **Admin to act as**.
3. In ScreenTinker, go to **Settings → Meeting rooms → Add a calendar connection → Google Workspace**, paste the JSON key, and press **Test**.

ScreenTinker keeps only the account address and the private key, both encrypted. It always uses Google's own token endpoint, whatever the key file names.

## ICS calendars (read-only)

Any calendar published as an ICS address works, with no connection:

- Outlook's **Publish calendar**
- Google's **Secret address in iCal format**
- most booking systems

The panel shows the room but can't book, end or release meetings.

Treat the address as a password: anyone who has it can read the calendar. ScreenTinker stores it encrypted and only ever shows its host name.

## Add a room and a display

1. Go to **Widgets → Room Display**, then open **Add a room**.
2. Pick the room's calendar:
   - **A connection:** press **Find rooms** to choose from a list, or type the room's calendar address.
   - **An ICS address:** paste it.
3. Name the room, set its **time zone**, and press **Add room**.
4. Choose a layout. **Follow the screen** turns portrait or landscape with the display. Save the widget, and put it in the playlist of the screen at the door.

**Read the calendar now** checks the room straight away and shows what the panel would say.

## What the panel may do

**Book now** is offered while the room is free:

- 15, 30 or 60 minutes, whichever fit before the next meeting
- **Until hh:mm**, when the gap is shorter than 15 minutes but at least 5

The calendar is re-read before anything is booked, so a meeting someone booked a moment ago wins. A double tap creates one meeting, not two.

**End meeting** shortens a meeting **booked at the panel** so it ends now. Your organization can also let a panel end any meeting (**Settings → Meeting rooms → Let a panel end any meeting early**). The room then **declines** the meeting, or leaves it on Google. The organiser is told, and the meeting itself isn't cancelled for its attendees.

**Check in and auto-release** is off by default. Set **Release a room nobody checks in to** to a number of minutes. A meeting then shows **Check in** for that long after it starts. A meeting nobody checks in to gives the room back, in the same way as above. Some meetings are never released:

- meetings booked at the panel (someone was standing there)
- all-day blocks
- meetings that started before the setting was turned on

Every action is recorded in the activity log with the screen that made it.

Booking is turned off for a room by unticking **Allow booking**, and for a whole connection by marking it **Read only**.

## Privacy

Choose what each room shows under **Meeting titles and organisers**:

| Setting | Shows |
|---|---|
| Show them, except for private meetings (default) | titles and organisers, but "Private meeting" for anything marked private or confidential |
| Never show them | "Reserved" for every meeting |
| Always show them | everything |

Hidden details are removed **on the server**, so they aren't in the page or anything it downloads.

## Which screens can book

| Player | Shows the room | Book / end / check in |
|---|---|---|
| Android (phones, tablets, Android TV, Fire TV) | ✅ | ✅ (touch) |
| Web player (browsers, kiosks, Chromebooks) | ✅ | ✅ (touch or mouse) |
| Raspberry Pi and Windows native player | ✅ | ✅ (touch) |
| Samsung Tizen, LG webOS, BrightSign, Vega | ✅ | read-only |

The page can book only when the player passes it this screen's **panel capability**. The server gives each paired screen its own capability, over that screen's authenticated connection. It is tied to the screen's pairing, so re-pairing or removing the screen cancels it. The player puts it in the part of the address that browsers never send to a server. Screens that don't pass one show the room read-only.

## How it behaves offline

The panel works out free or busy **on the screen itself**, every second, from the schedule it last received. A meeting therefore starts and ends on time even with the network down, and the panel follows the server's clock, not its own.

If the screen hasn't reached the server for three minutes, or the server can't reach the calendar, a note says the schedule shown is the saved one.

The server reads each room's calendar at most once a minute, however many screens show it. It waits longer and longer after errors, up to 15 minutes, and keeps the last good copy meanwhile.

## Troubleshooting

| What you see | Why |
|---|---|
| Test: "AADSTS7000215: Invalid client secret" | The secret's *value* (not its ID) is needed, or it has expired. |
| Test signs in, but the room shows nothing | The app can't read that mailbox. Check consent, and that the ApplicationAccessPolicy includes the room. |
| "The calendar refused that" when booking | The app has `Calendars.Read` but not `Calendars.ReadWrite` (Microsoft), or the calendar isn't shared with "Make changes to events" (Google). |
| **Find rooms** lists nothing (Microsoft) | `Place.Read.All` isn't granted, or the rooms have no place records yet. Type the address instead. |
| **Find rooms**: "needs domain-wide delegation" (Google) | Set **Admin to act as**, or type the resource calendar's address. |
| No booking buttons | The screen's player can't book (see above), booking is off for the room, or the room uses an ICS address. |
| "The stored secret could not be decrypted" | The server's `JWT_SECRET` changed. Enter the secret again. |
