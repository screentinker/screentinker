# JSON API data source

Poll a JSON HTTP endpoint. Fields land on slides and widgets as `{{ds:your_slug.field}}`.

Enable plugins (`PLUGINS_ENABLED=true`), restart, platform admin → **Plugins** → enable **JSON API**, restart again. Then **Data sources** → **JSON API**.

The request goes through ScreenTinker's SSRF guard — loopback, link-local, and cloud-metadata targets are refused, the same way iCal is. Authorization headers stay on the server; viewers never see them.

Flattening turns `{ "weather": { "temp": 18 } }` into `weather_temp`. Arrays get `_count` plus `_0`, `_1`, … (capped at 20). Optional JSON path (`data` or `items.0`) picks a subtree first.

Keys must match `[a-zA-Z0-9_]+` — that is what `{{ds:slug.key}}` accepts.
