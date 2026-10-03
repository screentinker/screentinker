# Bundled slide fonts

These five families are shipped with ScreenTinker and served from `/fonts`. They are what the
**Slides** editor offers, and what a slide renders in on every player — a browser, Android, Tizen
and BrightSign alike.

| File | Family | Role | Weight axis | Licence |
| --- | --- | --- | --- | --- |
| `inter.woff2` | [Inter](https://github.com/rsms/inter) | Text | 400–800 | [OFL](OFL-inter.txt) |
| `archivo.woff2` | [Archivo](https://github.com/Omnibus-Type/Archivo) | Display | 400–800 | [OFL](OFL-archivo.txt) |
| `oswald.woff2` | [Oswald](https://github.com/googlefonts/OswaldFont) | Condensed | 300–700 | [OFL](OFL-oswald.txt) |
| `bitter.woff2` | [Bitter](https://github.com/solmatas/BitterPro) | Serif | 400–800 | [OFL](OFL-bitter.txt) |
| `jetbrains-mono.woff2` | [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | Monospace | 400–700 | [OFL](OFL-jetbrains-mono.txt) |

Each family ships twice: `<name>.woff2` covers the **latin** subset and `<name>-ext.woff2` covers
**latin-ext**. Both are declared with the `unicode-range` they were cut against, so a browser
downloads only the one it needs — latin-ext exists so that accented characters render, and a slide
does not say "Zurich" where somebody wrote "Zürich".

They are **variable** fonts: one file spans the whole weight axis, rather than one file per weight.

## Licensing

Every family here is under the [SIL Open Font License 1.1](https://openfontlicense.org/), which
expressly permits bundling and redistribution — including inside a commercial product, and
including serving the file to a browser. That matters because **every install redistributes these**:
when a slide plays, the server ships the font to the player.

Three obligations come with that, and they are conditions of the licence rather than good manners:

1. **The licence travels with the fonts.** The `OFL-*.txt` files here are shipped in the release
   tarball and in the BrightSign payload (both stage `server/` wholesale) and are served at
   `/fonts/OFL-<family>.txt`.
2. **Reserved Font Names are not used on modified versions.** These files are unmodified —
   not subsetted by character, not re-instanced, not renamed. If per-slide subsetting is ever added
   to cut file size, **the output must be given a different family name.**
3. **The fonts are not sold on their own**, which is not something this product does.

⚠️ `scripts/license-check.js` scans **npm dependencies** and cannot see these files. Adding a family
is a licence decision a human has to make. `server/test/slide-fonts.test.js` asserts that every
declared family has both its `.woff2` files and its `OFL.txt` actually present, which is the closest
thing to a mechanical check — it will fail the build if a family is declared without them.

## Adding a family

1. Confirm it is genuinely OFL — the authoritative check is that it lives under `ofl/` in
   [google/fonts](https://github.com/google/fonts), not `apache/` or `ufl/`.
2. Download the `latin` and `latin-ext` variable `woff2` from the `css2` API, and the `OFL.txt`
   from the repo.
3. Add it to `FAMILIES` in `server/lib/slide-fonts.js`. **Take the weight range from the API's
   own `font-weight` declaration** — declaring wider than the file has makes the browser clamp
   silently, so a slide set in 900 renders at 800 with nothing to say why.
4. Run the tests. They will tell you if the files or the licence are missing.
