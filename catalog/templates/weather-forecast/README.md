# Weather forecast

Current conditions and a five-day forecast, laid out as a slide. The numbers come from one of your
own **Weather data sources** — your server fetches the weather (Open-Meteo by default, no key
needed) and the template only arranges it.

**Kind:** slide (declarative — no code runs). Works on every ScreenTinker player that shows slides.

![preview](thumbnail.png)

## Before you use it

Create a data source of type **Weather** (Data Sources → New → Weather) with your location, units
and language. Then pick it in this template's **Weather data source** setting. Units (°C/°F) and
all the words follow the data source's language: day names, the weather conditions and the labels
("Feels like", "Today", "Updated"…). The server has those words in Danish, Dutch, English, French,
German, Hindi, Italian, Japanese, Portuguese, Simplified Chinese and Spanish; any other language
gets English. Needs ScreenTinker 3.0.2 or later.

## Settings

| Setting | Type | Default |
| --- | --- | --- |
| Weather data source | data source (required) | — |
| Location name | text (60) | `Local weather` |
| Temperature suffix | text (4) | `°` (use `°C` or `°F` if you prefer) |
| Accent / Background / Text colour | colour | `#6CC4F0` / `#0B1D2E` / `#FFFFFF` |
| Clock timezone / Date language / Clock format | timezone / locale / select | the screen's own / 24-hour |

## How it reads the data

Every value is a `{{ds:<source>.<key>}}` reference, built from the chosen source as
`{{ds:{{param:weather}}.temperature}}`. It uses `icon`, `temperature`, `condition`,
`apparent_temperature`, `humidity`, `day0_high/low/precip_text` (today) and `day1…day5`
`_name/_icon/_high/_low`, plus `updated` and the `label_feels_like`, `label_humidity`, `label_today`
and `label_updated` words. The icons are the data source's emoji, drawn by the
player's own emoji font.

Licence: MIT (see `LICENSE`).
