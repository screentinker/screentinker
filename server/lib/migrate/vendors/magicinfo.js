'use strict';

/*
 * Samsung MagicINFO: listed, but NOT importable through its API yet, and here is why (read 2026-11):
 *   https://docs.samsungvx.com/docs/                    (End of Sale / End of Service dates)
 *   https://docs.samsungvx.com/docs/x/NhiUAw            (MagicINFO Server 9 / Cloud Open API)
 *
 * MagicINFO is being retired: On-Premise End of Sale 2026-12-31 (End of Support 2029-12-31), MagicINFO
 * Cloud End of Service 2027-02-28, successor Samsung VXT. People will be moving off it, so the wizard
 * lists it and says plainly what can and cannot come across.
 *
 * The server's REST API (`/MagicInfo/restapi/v2.0/`, token from `POST /auth`) lists content,
 * playlists, content schedules and device groups, but documents NO way to download a content file.
 * Fetching the storage paths anyway would be relying on undocumented behaviour, which this importer
 * does not do (same rule as OptiSigns), and without the files the playlists would arrive empty.
 * Samsung's own backup is a database dump plus the server's runtime folder, an undocumented schema.
 *
 * So, for now: the wizard explains this and offers the generic zip (one folder per playlist, or a
 * playlists.csv). The screens themselves stay: Samsung displays switch from MagicINFO to ScreenTinker
 * in the menu (System > Play Via > URL Launcher, "Custom App" on Tizen 6.5 and later); see
 * docs/migrate.md and /compare/magicinfo-alternative.html. An API importer is a later step, once it
 * can be tested against a real MagicINFO server and the file download is confirmed.
 */

module.exports = {
  id: 'magicinfo',
  name: 'Samsung MagicINFO',
  mode: 'none',
  docs: ['https://docs.samsungvx.com/docs/', 'https://docs.samsungvx.com/docs/x/NhiUAw'],
  fields: [],
  checkCredentials() {
    const e = new Error('MagicINFO cannot be imported through its API yet. Use the zip import.');
    e.userMessage = e.message;
    throw e;
  },
  async open() { throw Object.assign(new Error('not supported'), { userMessage: 'MagicINFO cannot be imported through its API yet.' }); },
};
