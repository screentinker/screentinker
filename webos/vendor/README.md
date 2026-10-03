# LG SCAP library (not redistributed)

`index.html` loads these files from this directory:

- `cordova.webos.js`
- `power.js`, `storage.js`, `deviceInfo.js`, `configuration.js`

They are LG's Signage Common Application Platform (SCAP) JavaScript library, shipped with the
webOS Signage SDK at https://webossignage.developer.lge.com (free registration). Copy them here
before running `build-ipk.sh`. LG's licence does not allow us to ship them in this repository.

Without them the app still runs and plays content; it simply reports no power or update
capabilities, and the dashboard hides those buttons for the screen.
