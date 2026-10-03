# Signing and publishing the catalog (maintainers)

This is the procedure for turning merged source into a signed catalog that ScreenTinker servers
trust. It is deliberately manual at exactly one point: **the signature is made offline, by a
maintainer, never by CI.**

## The catalog key

| | |
| --- | --- |
| Algorithm | Ed25519 |
| key_id | `e800b0481ec538d0` (first 16 hex of sha256 of the raw 32-byte public key) |
| Public key | compiled into every server: `OFFICIAL_PUBLIC_KEY_PEM` in `server/lib/templates/signing.js` |
| Private key | `~/.config/screentinker/template-catalog-signing-key.pem`, mode `0600`, on the signing maintainer's machine only |
| Cold backup | age-encrypted, printed as a QR sheet (below) |
| Used by | `scripts/template-catalog.js sign` and nothing else |

Check the key before every signing session (prints only public material):

```bash
openssl pkey -in ~/.config/screentinker/template-catalog-signing-key.pem -pubout
# must match OFFICIAL_PUBLIC_KEY_PEM; `verify` below proves the key_id end to end
```

### Why it is not the support key

ScreenTinker already has one Ed25519 key: the **support access** key (`lib/support-access.js`,
`docs/support-access.md`). They are kept separate on purpose, because they have opposite shapes:

- The **support key lives on the internet-facing hosted server**, because that is where support
  tokens are issued — and it is **deliberately powerless on its own**: a token is useless without a
  request code that the customer's own server minted, so stealing the key does not open anybody's
  install.
- The **catalog key's signature alone is the whole trust decision**: it is what lets a template's
  code onto every screen whose owner switched the community library on. There is no second factor.
  So it must be the key that **stays offline**.

Sharing one key would hand the internet-facing support signer the power to publish code to screens,
and would mean rotating either one rotates both. Every signed message is also domain-separated
(`screentinker-template-package/1\n`, `screentinker-template-index/1\n`, support tokens use
`STSUP1`), so a signature made for one purpose can never verify as another — but separate keys are
the real protection.

### Rules for the private key

- Never in a repository, a CI secret, a cloud drive, a chat, a ticket or a terminal transcript.
  Nothing in this procedure prints it.
- Never copied to a ScreenTinker server — no server needs it.
- Signing happens on the maintainer's own machine, from a clean checkout of the screentinker repo at
  a tagged release (the CLI is `scripts/template-catalog.js`).
- If the machine is lost, stolen or compromised, follow **Compromise** below; do not wait.

### Cold backup (paper)

Same procedure as the support key's backup:

1. **The maintainer encrypts the key themselves** — the passphrase is theirs, typed by them, and is
   never written down next to the sheet, stored in a password manager shared with anyone, or seen by
   any script or assistant:
   ```bash
   age -p -o ~/.config/screentinker/template-catalog-signing-key.pem.age \
       ~/.config/screentinker/template-catalog-signing-key.pem
   ```
2. Record the plain key's fingerprint: `sha256sum ~/.config/screentinker/template-catalog-signing-key.pem`.
3. Turn the ciphertext into a QR sheet with the same `make-sheet.sh` recipe used for the support key
   (base64 → QR codes at error-correction level H, chunks prefixed `STTPL-BK-<n>-of-<N>:` → one
   self-contained HTML page carrying the plain key's sha256, the public key and the ciphertext's
   sha256). The script decodes every QR it made with `zbarimg` and refuses to finish unless the
   reassembled ciphertext hashes back to the original.
4. Print it, and store it apart from the machine (a safe, a bank box). Delete the HTML and PNGs.
5. **Test restore** once: scan → reassemble → `base64 -d` → `age -d` → `openssl pkey -pubout` must
   print the published public key.

## Release procedure

Nothing is published until a maintainer has done every step. CI never holds the key.

### 1. CI builds an unsigned dist

A merge to `main` runs `.github/workflows/build.yml`, which checks out the currently published
catalog (`gh-pages`) as `previous/` and runs:

```bash
node screentinker/scripts/template-catalog.js build templates -o dist --previous previous
```

and uploads `dist/` as the workflow artifact `catalog-dist-<sha>`. A dist is:

```
dist/index.json                              UNSIGNED index (serial = unix time, expires = +45 days)
dist/packages/<id>-<version>.sttemplate      one per version; new ones unsigned, older ones copied
                                             from previous/ with their signatures intact
dist/thumbs/<id>-<version>.png               each manifest.thumbnail, for the library grid
```

`--previous` matters: it keeps every earlier version listed (servers pin versions), refuses to
republish an existing version with different bytes, and keeps `serial` strictly increasing. The
previous dist is only trusted as far as its signature: `build` refuses a `--previous` whose
`index.json` is not signed by the official key (`--pubkey <pem>` for another catalog), so a
tampered gh-pages cannot inject history.

### 2. Download it, and check out the reviewed source

```bash
gh run download <run-id> -n catalog-dist-<sha> -D ~/catalog-release/dist
cat ~/catalog-release/dist/BUILT_FROM                                    # commit + CLI ref
git -C ~/src/templates fetch && git -C ~/src/templates checkout <sha>   # the merged commit
git clone --depth 1 -b gh-pages https://github.com/screentinker/templates ~/catalog-release/previous
```

`sign` (step 3) is what enforces "the signed bytes are the reviewed bytes": it rebuilds every
not-yet-signed package from `--source` and refuses to sign anything that differs, or any unsigned
version the source tree does not contain. As an independent cross-check of the whole index, you can
also rebuild it and compare the **package hashes** (index bytes legitimately differ — `serial`,
`generated` and `published` are timestamps):

```bash
ST=~/src/screentinker        # clean checkout at a release tag
node $ST/scripts/template-catalog.js build ~/src/templates/templates -o ~/catalog-release/rebuilt \
     --previous ~/catalog-release/previous
node -e '
  const a = require(process.argv[1]), b = require(process.argv[2]);
  const pins = (i) => i.templates.flatMap((t) => t.versions.map((v) => `${t.id}@${v.version} ${v.sha256}`)).sort();
  const x = pins(a).join("\n"), y = pins(b).join("\n");
  console.log(x); if (x !== y) { console.error("MISMATCH between CI dist and local rebuild"); process.exit(1); }
  console.log("CI dist matches the reviewed source");
' ~/catalog-release/dist/index.json ~/catalog-release/rebuilt/index.json
diff <(jq -S .revoked ~/catalog-release/dist/index.json) <(jq -S . ~/src/templates/revoked.json)
```

Also skim `git log previous-release..<sha>` — every template change in it must have been reviewed by
a second maintainer.

### 3. Sign

```bash
node $ST/scripts/template-catalog.js sign ~/catalog-release/dist \
     --key ~/.config/screentinker/template-catalog-signing-key.pem \
     --source ~/src/templates/templates
# signed N packages and index.json (key_id e800b0481ec538d0)
```

`--source` is required and must be the **reviewed checkout**, never the CI artifact. For every
version that is not signed yet, `sign` rebuilds the package from that source and refuses if the
dist's bytes differ; versions carried over from `--previous` keep the signatures they already had.
Every package must also hash to the sha256 the index pins. Only then is `index.json` signed.

### 4. Verify

```bash
node $ST/scripts/template-catalog.js verify ~/catalog-release/dist
# index.json: SIGNATURE OK
#   packages/…: hash ok, signature ok       (for every version)
```

Without `--pubkey`, `verify` uses the key compiled into that checkout — i.e. what servers trust.
Any `NOT VERIFIED` or `MISMATCH` line, or a non-zero exit, stops the release.

### 5. Publish to GitHub Pages

```bash
cd ~/catalog-release/previous            # the gh-pages checkout
cp ../dist/index.json ../dist/index.json.sig .
mkdir -p packages thumbs
cp ../dist/packages/* packages/ && cp ../dist/thumbs/* thumbs/     # add/overwrite, never delete
git add -A && git commit -s -m "catalog: serial $(jq .serial index.json)" && git push origin gh-pages
```

Publish **all four** — `index.json`, `index.json.sig`, `packages/` and `thumbs/`. `packages/` and
`thumbs/` only ever grow (file names carry the version), so copying over the old tree never removes
a file an older index or an installed server still refers to. Then check the live
site: `curl -s https://screentinker.github.io/templates/index.json | jq .serial` and
`node $ST/scripts/template-catalog.js verify <a wget -m copy of the site>`.

### 6. Offline bundle

```bash
node $ST/scripts/template-catalog.js bundle ~/catalog-release/dist \
     -o ~/catalog-release/screentinker-templates-$(date -u +%Y%m%d).zip
```

The bundle holds `index.json`, `index.json.sig` and every package (no thumbnails — offline servers
read them from the packages). Attach it to a GitHub release of this repository named after the
serial, with its sha256 in the release notes. It needs no signature of its own: a server verifies the
index inside it with the compiled-in key.

### Heartbeat re-sign

An index expires 45 days after it is built, after which servers show the catalog as **stale** (a
frozen mirror or a blocked update is visible, not silent). Even with no template changes, run a
build (`workflow_dispatch` on build.yml) and steps 2–6 **at least once a month**.

## Revocation

Use it when a published version is harmful, broken on screens, or infringing.

1. Add an entry to `revoked.json` in a pull request (reviewed like any other change):
   ```json
   [
     { "id": "news-ticker", "versions": ["1.2.0"], "sha256": [],
       "reason": "1.2.0 freezes Android players after ~6 hours; install 1.2.1" },
     { "id": "evil-clock", "versions": ["*"],
       "sha256": ["<64 hex of the package, from index.json>"],
       "reason": "sends values to an undeclared host" }
   ]
   ```
   - `id` + `versions` (`"*"` = every version) matches installs from this catalog;
   - `sha256` matches those exact package bytes **from any catalog, including unsigned local
     imports** — use it for anything malicious;
   - `reason` (≤ 300 characters) is shown to server admins. Say what to do next.

   ⚠️ Entries are validated strictly — `id` must match `^[a-z][a-z0-9-]{1,63}$`, `versions` must
   be `"*"` or `x.y.z`, `sha256` must be lower-case 64-hex — and **a malformed entry makes servers
   refuse the whole index**, which would freeze every server on the previous one. The *lint* job
   checks the file; `build` refuses it too.
2. Merge, then run the full release procedure (build → check → sign → verify → publish → bundle).
   `build` copies `revoked.json` into the index.
3. What servers do: on the next fetch (daily, or *Check now*) every matching install turns
   **revoked** — its widgets render a black page and the admin sees the reason — regardless of any
   update setting. The library stops offering that version; installing it, or importing its package
   by hand, is refused. Removing the entry in a later index reinstates installs **from this catalog**
   that it had revoked. (An unsigned local copy revoked by `sha256` stays revoked; an admin
   uninstalls it.)
4. For something urgent, tell operators directly as well (release notes, Discord, the mailing list):
   air-gapped servers only learn about a revocation from the next offline bundle.

## Key rotation (planned)

Do it when a maintainer leaves, when the key's storage changes, or every few years.

1. `node scripts/template-catalog.js keygen ~/.config/screentinker/template-catalog-signing-key-2.pem`
   and make its cold backup.
2. Ship a **ScreenTinker server release** with the new public key in `OFFICIAL_PUBLIC_KEY_PEM`. When a
   server boots with a different official key it drops its cached index and resets its serial floor
   (the old index was verified under the old key).
3. The server trusts exactly one official key, and `index.json.sig` carries one signature, so an
   index cannot be valid for old and new servers at once. Until enough servers run the new release,
   keep publishing the old-key catalog at the current URL and the new-key catalog at a new path, and
   make the release in step 2 point at that path. (Supporting two official keys during a transition
   would remove this step — a server change, not a catalog one.)
4. When the old-key catalog is retired, destroy the old private key and its paper backup.

## Compromise

If the private key may have been copied — lost laptop, malware, an accidental paste — assume an
attacker can sign any index and any package that every server with the community library enabled
will accept.

1. **Stop**: do not sign anything else with it.
2. **Rotate now**: new key (above), and a ScreenTinker **security release** with the new public key,
   announced as such. That is the only thing that removes the old key's power; nothing in the
   catalog can revoke the key that signs the catalog.
3. The rollback floor works against us here: a stolen key can publish an index with a huge `serial`
   that the real catalog can never exceed. Servers reset the floor only when their official key
   changes — one more reason step 2 is the fix.
4. **Tell operators** to (a) upgrade, (b) until then switch *Community library* off, and (c) review
   installed templates against the last known-good index (by sha256).
5. From the new key's first index, revoke by `sha256` anything signed during the exposure window
   that was not in a reviewed release.
6. Write up what happened in `SECURITY.md` of both repositories.

`TEMPLATE_CATALOG_PUBLIC_KEY` on a server overrides the compiled-in key; operators who cannot upgrade
immediately can set it to the new public key and restart.
