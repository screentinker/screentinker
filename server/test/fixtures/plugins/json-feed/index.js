'use strict';
exports.activate = function activate(api) {
  api.registerDataSource({
    type: 'json-feed',
    async resolve(config) {
      return { hello: (config && config.hello) || 'world' };
    },
  });
};
