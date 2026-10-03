'use strict';
exports.activate = function activate(api) {
  api.registerWidget({ type: 'too-new', render() { return '<html></html>'; } });
};
