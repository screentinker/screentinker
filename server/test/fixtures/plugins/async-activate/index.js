'use strict';
exports.activate = async function activate(api) {
  api.registerWidget({ type: 'async-activate', render() { return '<html></html>'; } });
};
