'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const file = path.join(__dirname, '../dist/native-bridge.js');
const tree = acorn.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 5, locations: true });
function visit(node, parent, grandparent) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'FunctionDeclaration' && parent && parent.type === 'BlockStatement' &&
      (!grandparent || !/Function(?:Declaration|Expression)$/.test(grandparent.type) || grandparent.body !== parent)) {
    throw new Error('Legacy WebKit rejects a function declaration in a nested block at ' + node.loc.start.line);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => visit(child, node, parent));
    else if (value && typeof value === 'object' && value.type) visit(value, node, parent);
  }
}
visit(tree, null, null);
console.log('Native bridge has no legacy-incompatible block function declarations.');
