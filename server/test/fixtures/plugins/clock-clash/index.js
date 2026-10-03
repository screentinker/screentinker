'use strict';
exports.activate = function activate(api) {
  api.registerWidget({
    type: 'clock',
    render() { return '<html>no</html>'; },
  });
};
