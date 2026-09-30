<!--
Thanks for contributing! One template (or one fix) per pull request, please.
Every commit must be signed off: `git commit -s` (see CONTRIBUTING.md, "Sign-off (DCO)").
-->

## What this is

- Template id(s):
- New template / update from `x.y.z` to `x.y.z`:
- Kind: slide / html
- Network hosts declared (html only), and why each is needed:

What it shows, and anything the operator must set up (e.g. "a Weather data source"):

## Author checklist

- [ ] `node <screentinker>/scripts/template-catalog.js build templates -o /tmp/dist` passes
- [ ] `node tools/lint-templates.js templates` passes
- [ ] I rendered it with `tools/render-previews.js` and looked at 1920×1080 and one other shape
- [ ] `version` is bumped for any change to a published template
- [ ] Licence is MIT / Apache-2.0 / BSD / ISC / 0BSD / CC0 / Unlicense, and `LICENSE` is included
- [ ] Every bundled font/image is my own work, CC0/CC-BY or OFL, and listed in `NOTICE` with its source
- [ ] No CDN or hotlinked assets; no `eval` / `new Function`; no minified or obfuscated code
- [ ] No secrets, and no params that invite one
- [ ] It handles empty values and a data source that has not synced yet
- [ ] `README.md` explains every setting; `thumbnail.png` is 16:9, ≤ 200 KB and honest

## Reviewer checklist (a maintainer who is NOT the author)

- [ ] Read **every** line of code in the diff (html templates), not just the summary
- [ ] Network: only the declared hosts are contacted, only for the stated purpose; checked in the
      rendered page's network panel. No analytics, tracking or remote code.
- [ ] Values are written with `textContent`; no HTML built from values
- [ ] No `localStorage`/cookies reliance, no sound, no busy loops; animation is reasonable for a low-end player
- [ ] Licences and `NOTICE` verified against the actual sources of bundled fonts/media
- [ ] Screenshots from the **render** job look right at every size; nothing overflows or is illegible
- [ ] For an update: the diff against the previous version is what the description says, nothing more
- [ ] `revoked.json` / `tools/` / `.github/` changes (if any) have a core maintainer's approval too
