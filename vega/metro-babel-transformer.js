/*
 * Metro 0.76's transformer parses, then calls transformFromAstSync with
 * cloneInputAst: false. Babel then tries to emit a helper (array destructuring,
 * async/await) through the default traverse hub and throws
 * "Helpers are not supported by the default hub." transformSync clones the AST
 * and does not throw. The @babel/core export is a non-configurable getter, so
 * this require hook is the seam: only the stock transformer sees the clone.
 */
const Module = require('module');
const origLoad = Module._load;

Module._load = function (request, parent, isMain) {
  const loaded = origLoad.apply(this, arguments);
  if (
    request === '@babel/core' &&
    parent &&
    typeof parent.filename === 'string' &&
    parent.filename.indexOf('metro-react-native-babel-transformer') !== -1
  ) {
    return new Proxy(loaded, {
      get(target, prop, receiver) {
        if (prop === 'transformFromAstSync') {
          return function (ast, code, opts) {
            const next = opts && opts.cloneInputAst === false
              ? Object.assign({}, opts, { cloneInputAst: true })
              : opts;
            return target.transformFromAstSync(ast, code, next);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  return loaded;
};

module.exports = require('metro-react-native-babel-transformer');
