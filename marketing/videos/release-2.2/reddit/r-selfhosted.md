TITLE:
ScreenTinker 2.2 — self-hosted digital signage that now speaks MCP, so you can point an AI assistant at your own screens

BODY:
I maintain ScreenTinker, an MIT-licensed digital signage server you run yourself. Turn any TV, Pi,
old Android box or browser into a managed screen. No per-screen fees, no cloud dependency — the
players talk to *your* server.

2.2 is mostly about one thing: **every instance now serves a Model Context Protocol endpoint at
`/mcp`.** Point Claude — or anything else that speaks MCP — at your own server with an API token and
ask for things in plain English:

> "Which of my screens are offline?"
> → *Staff Room is offline, last heartbeat 1h ago, reason "silent". The other four are online.*

> "Put the autumn campaign on the lobby screen."
> → it finds the display, builds the playlist, publishes it, assigns it.

I haven't found another signage platform that does this. Short demo (3 min):
https://youtu.be/ihALO26wcVw

**The part I actually care about:** it's a client of your own public API, not a second way into the
database. Every tool call is an HTTP request carrying your token, through the same workspace
isolation and rate limits a `curl` script would hit. There is no second copy of the permission model
to drift out of step with the first.

The tool list is also filtered by the token's scope — a read-only token is shown 10 tools, a full one
21, and the read-only token is never even told the write tools exist, so an assistant holding one
doesn't burn turns discovering what it may not do. 21 tools total, chosen by hand rather than
generated from the 133-operation spec, because a model gets measurably worse at picking the right one
as the list grows.

And an assistant **cannot issue itself a token**. A human makes one in the dashboard. The auth guide
says so in the first paragraph, which saves an agent from hunting for a registration endpoint that
doesn't exist and reading every 401 as "my token is wrong".

Also in 2.2:
- Markdown renditions of every public page (`Accept: text/markdown`, or append `.md`), an RFC 9727
  API catalogue at `/.well-known/api-catalog`, and an auth guide written for something that reads
  rather than clicks.
- E-paper / ESP32 signs documented at last — the server dithers the image to the colours the panel
  actually has, packs it for the controller, and tells the board how long to deep sleep. No browser
  on the device.
- Eleven platforms, each with a setup guide, and a `/download` page built from the players your
  instance actually has — it says plainly when it has none instead of offering a dead link.
- Apple TV is documented as **not supported**, with the reasoning, because people keep asking.
- Device-side HTTP requests and a LAN control door for Crestron/AMX. Both are API-only right now —
  no dashboard page yet, and the video says so rather than pretending otherwise.

**Honest bit:** pointing an assistant at a real instance and reading what came back found three bugs
in my own new feature. The media-library tool returned items with no names and its search matched
nothing — which reads as "your library is empty" rather than as a fault. Renaming a screen sent back
the whole device row including its settings PIN. And asking for a week of uptime returned nothing at
all for a valid date range, which turned out to be a date-parsing bug that had been silently skewing
reports by the server's UTC offset on every self-hosted instance outside UTC. All fixed in 2.2.1,
which is out now. Reading the payload instead of the status code is the whole lesson.

GitHub: https://github.com/screentinker/screentinker
Docs / demo: https://screentinker.com

Disclosure: I'm the developer. Happy to answer anything, including what it doesn't do.
