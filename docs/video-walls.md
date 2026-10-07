# Video walls

A video wall is several screens arranged as one picture. Since this release a wall behaves like a
single screen: it can take a layout with zones, take turns across its screens, be scheduled, take
commands, and be watched live.

## Arranging the screens

**Video Walls → (a wall)**. The canvas is the wall as the audience sees it.

- Drag displays from *Available displays* onto the canvas and place each where it hangs.
- **Snapping:** a screen snaps to the edges and centre lines of the other screens and of the player
  box, and to "one bezel apart" using the H/V bezel values. A pink guide line shows while it holds.
  Hold **Alt** to place freely. Arrow keys nudge by 1 px (Shift: 10 px).
- A panel hung sideways: select it and set *How this panel is mounted*. The content is turned for
  you; there is no need for pre-rotated video.
- The dashed **PLAYER** box is the area content plays in. Each screen shows the part of it that
  overlaps the screen.

## Zones on a wall

Pick a layout under **Zones** (or **One zone per screen**, which builds one zone over each screen).
The layout's zones are percentages of the PLAYER box, so a zone can sit on one screen, cross a
bezel, or cover the whole wall. They are drawn over the canvas so you can see where each lands.

**Edit zones** opens the layout editor on the wall's real shape, with the screens outlined, and
zones snap to the screen seams.

Below the layout, the wall playlist's items are listed by zone: pick each item's zone, its length,
and its order within the zone (↑ ↓). Publish when done.

### Timing: every zone runs on one shared clock

Each zone plays its own items in a loop, and every screen works out where each zone is from the
same server-synchronised clock. No screen is in charge, the wall stays in step without the server
once it has its playlist, and a zone that crosses a bezel shows the same frame on both screens.

Zones that add up to the same total stay locked to each other. That is how screens take turns:

| Zone | Items | Loop |
|---|---|---|
| Screen 1 | Video A (30 s), Hold – freeze (60 s) | 90 s |
| Screen 2 | Hold – freeze (30 s), Video B (60 s) | 90 s |

plays A on screen 1, then B on screen 2 while screen 1 holds A's last frame, then A again.

### Hold items

A **hold** shows nothing new for its duration:

- **Freeze** keeps the last frame of the item before it, paused.
- **Blank** clears to the zone's background colour.

Add one from **Content → Hold**, or **+ Hold** on a zone in the wall editor. Holds work everywhere,
not only on walls: full screen, in zones and in synced groups.

## Watching a wall

- **Live** at the top of the wall page shows every panel's latest screenshot where the panel hangs,
  refreshed every 5 s. Screenshots never change what is playing.
- The wall's card on **Displays** shows the same picture, refreshed every 30 s, with each panel's
  status underneath.

## Commands

**Send to all panels…** on the wall page: screen on/off, restart app, check for update, reboot,
shut down. The result counts per panel how many received it, were offline, or cannot do it.

## Schedules

On **Schedule**, choose **Video wall** as the target. While the schedule runs, its playlist and
layout are the wall's, on every panel at once.

- Every panel follows the wall's schedules only, on one clock (the leader's time zone, else the
  first panel that reports one), so the wall never switches one screen at a time.
- A schedule on a single panel of a wall is refused ("schedule the wall instead"). Older schedules
  written on a panel stay visible in the calendar, marked, so they can be removed; they no longer run.

## Which players support what

Every current player declares both `playback.wall_zones` and `playback.hold`: web (and webOS,
Vega and BrightSign, which run it), Android, Tizen, and the Pi/Windows native player. How far each
has been tried is in `player-parity.md` — notably nothing has run on a Samsung TV, a BrightSign, a
Pi or Windows yet; Android was checked on the emulator.

A panel whose player lacks wall zones plays the wall playlist across the whole wall instead; the
wall editor names those panels. A player that lacks holds is never sent them.

## Limits

- Triggers cannot target a wall yet; they target a screen or a group.
- Every panel decodes the full source of each zone it can see. A screen skips zones that do not
  touch it, but a zone covering the whole wall is decoded in full by every panel.
