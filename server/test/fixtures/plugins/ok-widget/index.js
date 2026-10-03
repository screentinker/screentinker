'use strict';
exports.activate = function activate(api) {
  api.registerWidget({
    type: 'ok-widget',
    render(config, ctx) {
      const h = ctx.escapeHtml(String((config && config.headline) || 'Hello'));
      return `<!DOCTYPE html><html><body>OK:${h}</body></html>`;
    },
  });
};
