'use strict';

/**
 * Serve the Certified Hardware page: ScreenTinker's committed entries plus approved community reports.
 *
 * ⚠️ THIS PAGE MUST NEVER FAIL TO SERVE. Reseller agreements name its URL, so a database problem has
 * to degrade rather than error. The fallback is the committed static file, which holds ScreenTinker's
 * own entries — exactly the half that carries contract weight. Losing community reports for a few
 * minutes costs nothing; returning a 500 from a URL named in a contract is a different matter.
 *
 * Rendered output is cached in process and dropped when a submission decision is made, so the usual
 * request does no database work at all.
 */

const express = require('express');
const fs = require('node:fs');
const router = express.Router();
const { db } = require('../db/database');
const { render, loadData, OUT, DATA } = require('../lib/certified-hardware');
const submissions = require('../lib/hardware-submissions');

let cached = null;
let cachedStamp = null;

function invalidate() { cached = null; }

/**
 * The cache is keyed on the data file's mtime as well as being dropped on a decision.
 *
 * ⚠️ Without the mtime check, editing certified-hardware.json and rebuilding shows nothing until
 * the process restarts — the page you are looking at is the one rendered at first request. On prod
 * a deploy restarts anyway, so this is really for whoever is editing the list locally and wondering
 * why their change vanished. One stat per request is nothing next to that confusion.
 */
function stamp() {
  try { return String(fs.statSync(DATA).mtimeMs); } catch { return null; }
}

function build() {
  const data = loadData();
  const community = submissions.publishedDevices(db);
  return render({ ...data, devices: [...data.devices, ...community] });
}

router.get('/', (req, res) => {
  const now = stamp();
  if (cached && now !== cachedStamp) cached = null;
  if (!cached) {
    try {
      cached = build();
      cachedStamp = now;
    } catch (e) {
      console.error('[certified-hardware] falling back to the committed page:', e && e.message);
      return res.sendFile(OUT);
    }
  }
  res.type('html').send(cached);
});

module.exports = router;
module.exports.invalidate = invalidate;
module.exports.build = build;
