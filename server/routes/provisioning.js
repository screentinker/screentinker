const express = require('express');
const router = express.Router();
const { db } = require('../db/database');

// Provision (pair) a device by entering its pairing code
router.post('/', (req, res) => {
  const { pairing_code } = req.body;
  if (!pairing_code) return res.status(400).json({ error: 'pairing_code required' });

  const device = db.prepare('SELECT * FROM devices WHERE pairing_code = ?').get(pairing_code);
  if (!device) return res.status(404).json({ error: 'No device found with that pairing code' });

  // Clear pairing code and set online
  db.prepare(`
    UPDATE devices SET pairing_code = NULL, status = 'online', updated_at = strftime('%s','now')
    WHERE id = ?
  `).run(device.id);

  const updated = db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id);
  res.json(updated);
});

module.exports = router;
