# Vendored front-end libraries

Third-party libraries committed directly to the repo (not fetched from a CDN or built
from npm) so self-hosted / air-gapped instances work with no external dependency and no
build step.

**Anything added here ships in the release tarball**, so it must carry its licence notice —
a minified bundle usually has its headers stripped, which is exactly when the notice has to
be kept as a separate file next to it. Record the licence below and add a `<name>.LICENSE`.

## redoc.standalone.js
- **Library:** Redoc — renders the OpenAPI reference served at `/docs`.
- **Version:** 2.3.9
- **Licence:** MIT — Copyright (c) 2015-present, Rebilly, Inc. Full text in
  [`redoc.LICENSE`](redoc.LICENSE). The bundle itself carries no header (stripped by the
  upstream minifier), which is why the notice is kept separately.
- **Source:** https://cdn.redoc.ly/redoc/v2.3.9/bundles/redoc.standalone.js
- **Why committed:** the API reference must render on offline instances — no CDN, no build step.
- **Regenerate / update:**
  ```sh
  curl -sL https://cdn.redoc.ly/redoc/v2.3.9/bundles/redoc.standalone.js \
    -o frontend/vendor/redoc.standalone.js
  # drop the trailing sourcemap comment (the .map is intentionally not vendored)
  sed -i '/sourceMappingURL=redoc.standalone.js.map/d' frontend/vendor/redoc.standalone.js
  ```
