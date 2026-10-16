# HTML bundles

An HTML bundle is a `.zip` (or a W3C `.wgt`) with an `index.html` and its assets, uploaded to the
content library and put in a playlist like any other item. The archive is stored as uploaded; the
server flattens it into one self-contained document (`GET /api/content/:id/bundle`, every asset
inlined as a `data:` URI) and every player mounts that document. Which players do, and how each one
survives an outage, is in [`player-parity.md`](player-parity.md#playback).

What a bundle runs in:

- **An opaque origin.** The web player frames it with `sandbox="allow-scripts"` (no
  `allow-same-origin`); Android and the native player load it with no base URL. It cannot read the
  player's storage, and `fetch()` of its own files fails: they are already inlined.
- **No runtime fetch of its own assets, no streamed embedded video.** Both are traded away so the
  same document plays on every platform. Fetching *public* data (an RSS feed, a weather API) works
  wherever that API allows a `null` origin (CORS `*`).
- **A fixed slot.** It plays for the item's duration, like a widget, unless it asks to be skipped.

## Asking to be skipped

A bundle that has nothing useful to show — a news tile whose cached feed has gone stale while
offline, a calendar with nothing on today — can step aside:

```js
// Anywhere in the bundle's own document.
parent.postMessage({ type: 'screentinker:skip', reason: 'offline' }, '*');
```

The player moves to the next item at once, as if this item's duration had ended, and the item does
**not** count as a play. `reason` is optional.

A tile that has run out of data decides as soon as it knows:

```js
fetch('https://example.com/feed.json')
  .then((r) => r.json())
  .then((feed) => (feed.items.length ? show(feed) : skip('empty feed')))
  .catch(() => skip('offline'));

function skip(reason) {
  parent.postMessage({ type: 'screentinker:skip', reason }, '*');
}
```

### The rules

- **Only the bundle on screen is heard.** The message must come from the bundle's own document — not
  a frame it embeds, not another bundle, not a bundle that has just been replaced. Anything else is
  ignored without a word. The data must be an object whose `type` is exactly `'screentinker:skip'`;
  a string is not accepted.
- **It may arrive at any moment** the item is on screen, including the instant the bundle starts,
  before it has finished loading.
- **Once per item per pass.** A skip is honoured only if the same item has not already skipped since
  the last time any item of that playlist (or zone) ran to its normal end. A later skip is ignored
  and the item plays its full duration. So a playlist in which every item skips does not spin: each
  skips once, the next plays out its duration, and that run starts a new pass. An item that ends in
  under a second does not count as having run.
- **Something else must be playable.** A one-item playlist (or zone), or an item that is the only
  one its schedule allows right now, never skips: there is nothing to skip to, and reloading it
  would only flash. It keeps showing.
- **Not on a shared clock.** On a video wall, in a synced group, and in a wall layout, every screen
  keeps the same timeline; one screen leaving early would break it. The skip is ignored there and
  the item plays its duration.
- **In a layout, a skip moves only its own zone.** The other zones keep their own timers.
- **No play is counted.** The player retracts the play it reported when the item started (the
  server deletes that `play_logs` row; Reports never see it). Offline, the skipped play is simply
  not queued. A server older than the player records the row as incomplete instead.
- **The reason is a label, not a message.** It is cut to one line of at most 64 characters, with
  control characters removed, and written to the screen's device log (the dashboard's live log for
  that screen) under the `bundle` tag, with the item's name. An ignored skip is logged once per
  time the item is shown, saying why.

### Where it works

| player | full screen | in a layout zone |
|---|---|---|
| Web player (browsers, kiosk browsers such as Fully Kiosk, BrightSign, Vega, webOS) | yes | yes |
| Tizen | yes | yes |
| Android app | yes | not yet |
| Raspberry Pi / Windows / macOS (native) | yes, once the bundle's render is cached (from its second play) | yes, same condition |
| Roku | no — a bundle is a still frame rendered by the server | no |

On Android and the native player a skip is honoured only from the cached render they mount
themselves; on the rare fallback where the render could not be fetched and the bundle is loaded by
its URL, it plays its duration.
