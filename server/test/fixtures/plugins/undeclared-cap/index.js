// Declares only the "widget" capability but tries to mount a router. The loader must refuse the
// whole plugin (capabilities are a grant, not a label) and roll back its widget registration.
const express = require('express');
module.exports = {
  activate(api) {
    api.registerWidget({ render: () => '<!DOCTYPE html><html><body>ok</body></html>' });
    api.registerRouter(express.Router()); // not granted -> must throw
  },
};
