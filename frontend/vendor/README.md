# Vendored front-end libraries

Third-party libraries committed directly to the repo (not fetched from a CDN or built
from npm) so self-hosted / air-gapped instances work with no external dependency and no
build step.

## redoc.standalone.js
- **Library:** Redoc — renders the OpenAPI reference served at `/docs`.
- **Version:** 2.3.9
- **Source:** https://cdn.redoc.ly/redoc/v2.3.9/bundles/redoc.standalone.js
- **Why committed:** the API reference must render on offline instances — no CDN, no build step.
- **Regenerate / update:**
  ```sh
  curl -sL https://cdn.redoc.ly/redoc/v2.3.9/bundles/redoc.standalone.js \
    -o frontend/vendor/redoc.standalone.js
  # drop the trailing sourcemap comment (the .map is intentionally not vendored)
  sed -i '/sourceMappingURL=redoc.standalone.js.map/d' frontend/vendor/redoc.standalone.js
  ```
