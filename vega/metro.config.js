const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// babelTransformerPath: stock Metro 0.76 throws "Helpers are not supported by
// the default hub" on this app's async/destructuring. See metro-babel-transformer.js.
module.exports = mergeConfig(getDefaultConfig(__dirname), {
  transformer: {
    babelTransformerPath: path.resolve(__dirname, 'metro-babel-transformer.js'),
  },
});
