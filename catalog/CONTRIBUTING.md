# Contributing a template

Thank you for building something for other people's screens. A template you contribute here can end
up on thousands of displays in lobbies, shops and factories, maintained by people who will never
read its source — so the bar is "a stranger can trust it", and this document is how we get there.

- [Slide or html?](#slide-or-html)
- [Folder layout](#folder-layout)
- [manifest.json reference](#manifestjson-reference)
- [Parameter types](#parameter-types)
- [Writing a slide template](#writing-a-slide-template)
- [Writing an html template](#writing-an-html-template)
- [Testing locally](#testing-locally)
- [Rules for acceptance](#rules-for-acceptance)
- [Review process](#review-process)
- [Sign-off (DCO)](#sign-off-dco)

## Slide or html?

**Prefer a slide template whenever it can do the job.** A slide template is data: a layout in the
same shape ScreenTinker's slide editor saves (`template` = view, `fields` = text), with
`{{param:…}}` placeholders. No code of yours runs anywhere — the server substitutes the values and
renders it with its own renderer, which clamps every position, size and colour. It works on every
player that shows slides, review is quick, and it can show logos, text, colours, clocks, dates,
countdowns, QR codes, images and live data (`{{ds:…}}`) from the server's data sources.

Write an **html** template when you need something a slide cannot express: continuous animation, a
scrolling ticker, a chart, a layout that reflows. It is real code, it runs on the screen in a
sandbox, and it gets a much closer review.

## Folder layout

```
templates/<id>/
  manifest.json      required — see below; not part of the package's file list
  template.json      slide: the slide document (the default entry)
  index.html         html: the entry document (the default entry), plus its css/js/images/fonts
  thumbnail.png      required for the catalog — 16:9 (480×270 is ideal), png/jpg/webp, ≤ 200 KB
  LICENSE            required — the licence text for this template
  NOTICE             required when you bundle anything you did not write (fonts, images)
  README.md          required — what it is, what each setting does, anything the operator must set up
```

The folder name must equal `manifest.id`. Everything in the folder except `manifest.json` and
dot-files is packed into the template, so do not leave drafts, `.psd` files or `node_modules` in it
(the build refuses unknown file types anyway).

**File limits** (enforced by the build and again by every server): at most 64 files, 1 MB each,
2 MB in total. Paths are up to four folders deep, each segment `[A-Za-z0-9_-][A-Za-z0-9._-]*`
(max 64 characters), no `..`, no dot-files, no two paths that differ only in case. Allowed
extensions: `html css js json svg png jpg jpeg webp gif woff2 txt md`; plus `LICENSE`, `LICENCE` and
`NOTICE` (no extension) at the root.

## manifest.json reference

```json
{
  "id": "lobby-welcome",
  "name": "Lobby welcome",
  "version": "1.0.0",
  "kind": "slide",
  "description": "A calm welcome screen for a reception …",
  "author": "Your Name",
  "homepage": "https://github.com/you/your-template",
  "license": "MIT",
  "tags": ["welcome", "lobby"],
  "orientation": ["landscape"],
  "min_server": "2.2.0",
  "entry": "template.json",
  "thumbnail": "thumbnail.png",
  "network": [],
  "params": [ { "name": "accent", "type": "color", "label": "Accent colour", "default": "#E8A33D" } ]
}
```

| Field | Required | Rules |
| --- | --- | --- |
| `id` | yes | `^[a-z][a-z0-9-]{1,63}$`, equal to the folder name, never reused for something else |
| `name` | yes | ≤ 80 characters, shown in the library |
| `version` | yes | strict `x.y.z` (no `-beta`, no `v`). Every change to a published template is a new, higher version |
| `kind` | yes | `"slide"` or `"html"` |
| `license` | yes | one of `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `0BSD`, `CC0-1.0`, `Unlicense` |
| `description` | — | ≤ 500 characters |
| `author` | — | ≤ 80 characters |
| `homepage` | — | an `https://` URL, ≤ 200 characters |
| `tags` | — | ≤ 12 tags, each `^[a-z0-9][a-z0-9-]{0,23}$` |
| `orientation` | — | non-empty list of `landscape` / `portrait`; default `["landscape"]` |
| `min_server` | — | lowest ScreenTinker version the template works on, `x.y.z`; default `0.0.0`. Servers below it refuse to install |
| `entry` | — | default `template.json` (slide, must be `.json`) or `index.html` (html, must be `.html`); must exist |
| `thumbnail` | — (required here) | a png/jpg/webp in the package; published beside the package for the library |
| `network` | — | html only: ≤ 8 bare hostnames the template may contact (`api.example.com`, `*.example.com`) — no scheme, port, path or IP. The CSP allows exactly `https://` and `wss://` to these |
| `params` | — | ≤ 40 settings the operator fills in (next section) |

Text fields may not contain control characters or bidirectional-override characters. **A key the
server does not know is an error**, not ignored — so a future field with security meaning is never
silently dropped by an older server.

### A parameter

```json
{ "name": "headline", "type": "text", "label": "Headline", "help": "Two lines at most.",
  "required": false, "default": "Welcome", "max": 60 }
```

| Field | Rules |
| --- | --- |
| `name` | `^[a-z][a-z0-9_]{0,39}$`, unique in the template |
| `type` | one of the types below |
| `label` | ≤ 80 characters; defaults to `name` |
| `help` | ≤ 200 characters, shown under the input |
| `required` | `true` = the operator must provide a value (a default counts) |
| `default` | a string, number or boolean, checked exactly like an operator's value — a template whose own default is invalid does not install |
| `options` | `select` only: 1–50 entries, each `"value"` or `{ "value": "…", "label": "…" }` (value ≤ 80 characters) |
| `max` | `text`/`textarea`: maximum length, 1–2000 (defaults 200 / 2000) |
| `min`, `max`, `step` | `number` only |

## Parameter types

| Type | Operator sees | Value | Notes |
| --- | --- | --- | --- |
| `text` | one-line input | string, no line breaks | length ≤ `max` |
| `textarea` | multi-line input | string; `\n` and tab allowed | e.g. one headline per line |
| `color` | colour picker | `#RGB` or `#RRGGBB` | nothing else — no `rgb()`, no names |
| `number` | number input | number | bounded by `min`/`max` |
| `select` | dropdown | one of the option values | |
| `checkbox` | switch | `true` / `false` | defaults to `false` |
| `image` | image picker | `tpl:<path>` (an image in your package) or the id of an image in the operator's content library, or empty | png/jpg/webp/gif/svg; the default is usually a bundled `tpl:logo.png` |
| `timezone` | timezone picker | IANA name like `Europe/London`, or empty (= the screen's clock) | |
| `locale` | language picker | BCP-47 tag like `en`, `de-CH`, or empty (= the screen's language) | |
| `data_source` | data source picker | the slug of a data source in the operator's workspace, or empty | the server fetches the data; see below |

**There is no secret type, on purpose.** An html template can read every value it is given, and CSP
cannot stop a document from navigating itself to `https://anywhere/?q=<value>`. So never ask for an
API key, a password or a private URL. If your template needs authenticated data, the operator
creates a **data source** on their server (which keeps its credentials encrypted server-side) and your
template reads only the resulting public values.

## Writing a slide template

`template.json` is a slide document, exactly the shape ScreenTinker's slide renderer
(`server/lib/slide-render.js`) takes:

```json
{
  "template": {
    "aspect": "16:9",
    "background": "{{param:background}}",
    "elements": [
      { "slot": "headline", "kind": "head", "box": { "x": 6, "y": 38, "w": 58 },
        "style": { "color": "{{param:text_color}}", "size_cqw": 5.1, "weight": 800, "font": "archivo" },
        "motion": { "animation": "slideU", "delay": 0.25, "duration": 0.9, "easing": "soft" } },
      { "slot": "logo", "kind": "image", "fit": "contain", "content_id": "{{param:logo}}",
        "box": { "x": 6, "y": 8, "w": 16, "h": 13 } },
      { "slot": "clock", "kind": "clock", "clock_format": "{{param:clock_format}}",
        "tz": "{{param:timezone}}", "locale": "{{param:locale}}", "box": { "x": 68, "y": 37, "w": 32 },
        "style": { "size_cqw": 6.4, "font": "oswald", "align": "center" } }
    ]
  },
  "fields": { "headline": "{{param:headline}}" }
}
```

- **Elements** (≤ 40): `kind` is `head`, `body`, `stat` (text from `fields[slot]`), `image`
  (`content_id`, `fit: cover|contain`), `rule`, `box` (filled rectangles in `style.color`), `qr`
  (payload from `fields[slot]`, `qr_fg`/`qr_bg`/`qr_ec`), `clock` (`clock_format` `24|24s|12|12s`,
  `tz`, `locale`), `date` (`date_format` `long|short|numeric|weekday`, `tz`, `locale`), `countdown`
  (`target` as an ISO date or epoch ms; `fields[slot]` is the text shown once it passes).
- **Geometry** is in percent of the stage: `box.x/y/w/h`. **Type** is in `size_cqw` (percent of the
  stage width), so a slide looks the same from 720p to 4K. `style`: `color` (hex), `size_cqw`,
  `weight` 100–900, `align` `left|center|right`, `font`, `opacity` 0–1, `radius_cqw`.
- **Fonts** are the five bundled with ScreenTinker (SIL OFL): `inter` (text), `archivo` (display),
  `oswald` (condensed), `bitter` (serif), `jetbrains-mono` (monospace).
- **Motion**: `animation` `fade|slideL|slideR|slideU|slideD|zoom|wipe`, `delay`, `duration`,
  `easing` `ease-out|ease-in|ease-in-out|linear|soft`. ⚠️ Every animation except `wipe` ends at
  `opacity: 1` and holds it, which **overrides `style.opacity`** — give translucent elements no
  motion, or `wipe`.
- **Background**: `background` (hex), `background_content_id` (an image param), `background_dim` 0–1.
- **Placeholders**: `{{param:name}}` can appear in any string. A string that is *only* a
  placeholder becomes the value itself; inside longer text it is spliced in. `image` and `checkbox`
  values only work as a whole string.
- **Live data**: nest the data-source parameter inside a `{{ds:…}}` reference:
  `"{{ds:{{param:weather}}.temperature}}°"`. The server resolves it at render time and re-renders
  the widget whenever the data source syncs. Make the `data_source` param `required: true` — an
  unbound reference renders as its literal text.
- Anything the renderer does not recognise is clamped or dropped, never passed through. You cannot
  inject markup, CSS or script through a slide, and you should not try.

The built-in **Weather** data source (`type: weather`) provides these flat keys, which
`templates/weather-forecast` uses: `location`, `temperature`, `apparent_temperature`, `humidity`,
`wind_speed`, `condition`, `icon` (emoji), `code` (WMO), `units` (`C`/`F`), `updated`, and for each
day `d` = 0 (today) … 5: `day{d}_name`, `day{d}_date`, `day{d}_high`, `day{d}_low`,
`day{d}_condition`, `day{d}_icon`, `day{d}_code`, `day{d}_precip_prob`.

## Writing an html template

Your `index.html` is served to screens as **one self-contained document**:

- Every `src="…"`, `href="…"` and `poster="…"` that points at a file in your package, and every CSS
  `url(…)` in an inline style or a linked stylesheet, is **inlined as a `data:` URI**. So reference
  files with plain relative paths (`<link rel="stylesheet" href="style.css">`,
  `<script src="app.js"></script>`, `url(fonts/inter.woff2)`) and it just works, offline.
- Nothing else is rewritten. A path you build in JavaScript (`img.src = 'icons/' + name`) **will not
  resolve**; neither will `fetch('data.json')`, an ES module `import`, `@import` in CSS, or a worker.
  Use classic scripts, put data in JS, and reference images from HTML/CSS.
- The server prepends a `<meta>` CSP, a `<script id="st-values" type="application/json">` and a tiny
  runtime that defines a frozen `window.ST`:

```js
ST.ready(function () {                 // DOMContentLoaded, or now if already past it
  ST.values.title;                     // each param by name, already validated
  ST.values.logo;                      // image params: a data: URI, or null
  ST.values.weather;                   // data_source params: the slug …
  ST.data.weather.temperature;         // … and ST.data[param] is that source's flat values
  ST.template;                         // { id, version, name }
});
```

- The document runs with `Content-Security-Policy: sandbox allow-scripts; default-src 'none';
  script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data: blob: <network>;
  font-src data: <network>; media-src data: blob: <network>; connect-src <network or 'none'>;
  frame-src 'none'; worker-src 'none'; manifest-src 'none'; object-src 'none'; form-action 'none';
  base-uri 'none'`.
  It is an **opaque origin**: no cookies, no `localStorage` (accessing it throws — wrap it or do not
  use it), no forms, no frames, no popups. (CSP cannot stop WebRTC — `connect-src` does not govern
  ICE and Chromium does not implement `webrtc 'block'` — so rule 8 does.)
- Write to the page with `textContent` / `createElement`, never `innerHTML` with values — the value
  is the operator's, the markup is yours.
- Size everything relative to the viewport (`vh`, `vw`, `%`). Your template may be full screen, a
  zone, portrait or a thin strip. Test at least 1920×1080 and one other shape.
- **Players are modest computers.** Many are Android sticks with a WebView from 2021 (Chrome 91).
  Prefer CSS transforms and opacity for animation, avoid huge blurs and `backdrop-filter`, keep the
  DOM small, offer an "animate" switch for anything heavy, and never spin a busy loop. Feature-test
  anything newer than Chrome 91 (`@supports`) and degrade gracefully.
- **Silent.** Templates never play sound; the player decides which zone owns audio.
- **Empty is a state.** No values, a data source that has not synced yet, an empty headline list —
  show something sensible, never a script error or `undefined`.

## Testing locally

You need a checkout of [screentinker/screentinker](https://github.com/screentinker/screentinker)
(`npm ci` in `server/`) and Node 20.

```bash
ST=../screentinker
# 1. validate and pack everything — the same check CI runs
node $ST/scripts/template-catalog.js build templates -o /tmp/dist
# 2. render every template through the real server code, with a THROWAWAY key
node $ST/scripts/template-catalog.js keygen /tmp/throwaway.pem
openssl pkey -in /tmp/throwaway.pem -pubout -out /tmp/throwaway.pub
node $ST/scripts/template-catalog.js sign /tmp/dist --key /tmp/throwaway.pem --source templates
node $ST/scripts/template-catalog.js bundle /tmp/dist -o /tmp/offline.zip
node tools/render-previews.js --st $ST --bundle /tmp/offline.zip --pubkey /tmp/throwaway.pub \
     --out /tmp/shots --sizes 1920x200 --chrome "$(which chromium || which google-chrome)"
```

`render-previews.js` installs each template into a throwaway server database, renders it exactly as
a server would (including the CSP header), and screenshots it at 1920×1080 with the clock pinned
to 10:09. Templates with a `data_source` param are bound to demo Weather data (sunny, rain, snow).
It fails on any page error, console error or blocked request. `--thumbs templates` rewrites each
`thumbnail.png` from the render.

You can also import a single template into your own test server: zip the folder (with
`manifest.json`) and use *Templates → Import*. It arrives **unverified**; html templates additionally
need *Allow unsigned code templates* switched on — do that only on a test server.

## Rules for acceptance

A pull request is merged only if **all** of these hold.

**Licences**
1. The template's `license` is MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, CC0-1.0 or
   Unlicense, and the folder has a `LICENSE` with that text. **No GPL, LGPL, AGPL, SSPL, "non-commercial"
   or custom licences**, for the template or anything inside it.
2. Bundled images, icons, video posters and other media are your own work or **CC0 / CC-BY**, with
   the source, author and licence of each listed in `NOTICE`.
3. Bundled fonts are **SIL OFL 1.1** (or one of the code licences above), with the OFL text included
   (`fonts/OFL-<family>.txt`) and listed in `NOTICE`. Subset them — a 48 KB latin woff2, not a 900 KB TTF.
4. No logos or trademarks you do not own, except in a placeholder clearly meant to be replaced.

**Code** (html templates)
5. No CDN or hotlinked assets: every script, style, font and image ships in the package. A
   `<script src="https://…">` is refused even if the host is in `network`.
6. No `eval`, `new Function`, `setTimeout`/`setInterval` with a string, `document.write`, or
   dynamically built `<script>` elements.
7. No minified, bundled, transpiled or obfuscated code. Reviewers must be able to read every line
   that runs on a screen. (Readable output of a build step is fine if the source is also in the
   folder — ask first.)
8. Network access only to the hosts in `network`, only over https/wss, only for what the README says
   it is for. Declare the smallest set that works. No analytics, tracking, fingerprinting, ads or
   remote code, ever. No WebRTC (`RTCPeerConnection`), no navigating the page or opening windows to
   send data anywhere.
9. Nothing secret: no API keys in the package, and no params that invite one (see *Parameter
   types*). Everything given to a template is readable by its author.
10. Values are written with `textContent`, never parsed as HTML.

**Quality**
11. It looks good at 1920×1080 and survives at least one other shape (portrait, or a strip zone).
12. It handles empty and missing values, and a data source that has not synced.
13. Silent, reasonable CPU use, and it runs for weeks without a reload (no leaks, no unbounded arrays).
14. `thumbnail.png` is an honest 16:9 picture of the template, ≤ 200 KB.
15. `README.md` explains every setting and any setup (for example "create a Weather data source").

**Updates**
16. Every change to a published template bumps `version` (the build refuses to republish a version
    with different bytes), and the PR describes what changed and why.

## Review process

1. **Automated checks** (`.github/workflows/validate.yml`) run on every pull request:
   - *build* — the real ScreenTinker packer validates every manifest, file, parameter and default,
     exactly as a server will;
   - *lint* — `eval` / `new Function` / string timers, `http(s)://` hosts not declared in `network`,
     missing `LICENSE`/`README.md`, oversized thumbnails, minified-looking files;
   - *render* — every template is installed and rendered through the server code under its real CSP
     and screenshotted; the screenshots are attached to the run for the reviewer.
2. **A human review by a second maintainer who is not the author** (enforced by CODEOWNERS and
   branch protection). They read every line of code, check each rule above, look at the
   screenshots, and for html templates open the rendered page and watch the network panel.
3. **Every update is re-reviewed** the same way. A new version is a new pull request; there is no
   "trusted author" fast path. Packages are built by CI from the reviewed source, and the signing
   maintainer rebuilds them and compares hashes before signing, so what reaches screens is exactly
   what was reviewed.
4. After merge, a maintainer signs and publishes the release offline (SIGNING.md). Your template
   appears on servers with the community library switched on within a day.
5. If a published template turns out to be harmful, it is **revoked** (SIGNING.md, *Revocation*):
   it stops rendering on every server that fetches the next index.

## Sign-off (DCO)

Every commit must be signed off under the [Developer Certificate of Origin 1.1](https://developercertificate.org/):

```bash
git commit -s -m "templates: add menu-board"
```

This adds `Signed-off-by: Your Name <you@example.com>`, which certifies that you wrote the
contribution (or otherwise have the right to submit it under the licence you chose) and that you
understand it will be distributed publicly. Pull requests with unsigned commits fail the DCO check;
`git commit --amend -s` or `git rebase --signoff main` fixes it.
