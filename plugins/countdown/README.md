# Countdown widget

Sample ScreenTinker plugin. Counts down to a date and time on a sign.

## Install

1. Copy this folder to your data directory:

   ```
   cp -r plugins/countdown $DATA_DIR/plugins/countdown
   ```

   On a git checkout, the bundled copy under `plugins/countdown` is already discovered when plugins are enabled.

2. Enable plugins on the server (off by default):

   ```
   PLUGINS_ENABLED=true
   ```

3. Restart ScreenTinker.

4. Sign in as a platform admin → **Admin** → **Plugins** → enable **Countdown**. Restart again.

5. **Widgets** → **New widget** → **Countdown**. Set the end time and put the widget on a playlist.

Players pick it up the same way as a clock: the server renders HTML at `/api/widgets/:id/render`.

Plugins are trusted code, same as editing `server/lib`. Do not drop a folder you have not read. Enable/disable requires a restart — the process never `require()`s new code while it is running.
