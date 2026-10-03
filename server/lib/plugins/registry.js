'use strict';

/*
 * In-memory registries filled at boot by load.js. Empty when plugins are off.
 * routes/widgets.js and lib/data-sources/service.js consult these; they must
 * stay safe to require on a host that never set PLUGINS_ENABLED.
 */

const { RESERVED_WIDGET_TYPES, RESERVED_DATA_SOURCE_TYPES } = require('./reserved');

let plugins = []; // discovered + load state
const widgets = new Map();      // type -> { pluginId, render, fields, label, icon }
const dataSources = new Map();  // type -> { pluginId, resolve, fields, label, icon }
const routers = new Map();      // pluginId -> express.Router
const hooks = require('./hooks');

function reset() {
  plugins = [];
  widgets.clear();
  dataSources.clear();
  routers.clear();
  hooks.reset();
}

function recordPlugin(info) {
  const existing = plugins.find((p) => p.id === info.id);
  if (existing) {
    Object.assign(existing, info);
    return existing;
  }
  plugins.push(info);
  return info;
}

function listPlugins() {
  return plugins.slice();
}

function getPlugin(id) {
  return plugins.find((p) => p.id === id) || null;
}

function setPluginError(id, error) {
  const p = getPlugin(id);
  if (p) p.error = error;
}

function registerWidget(pluginId, spec) {
  if (!spec || typeof spec.type !== 'string' || typeof spec.render !== 'function') {
    throw new Error('registerWidget requires { type, render }');
  }
  if (RESERVED_WIDGET_TYPES.has(spec.type)) {
    throw new Error(`widget type "${spec.type}" is reserved`);
  }
  if (widgets.has(spec.type)) {
    throw new Error(`widget type "${spec.type}" is already registered`);
  }
  widgets.set(spec.type, {
    pluginId,
    type: spec.type,
    render: spec.render,
    fields: Array.isArray(spec.fields) ? spec.fields : [],
    label: spec.label || spec.type,
    icon: spec.icon || '🔌',
    network: spec.network || null,
  });
}

function registerDataSource(pluginId, spec) {
  if (!spec || typeof spec.type !== 'string' || typeof spec.resolve !== 'function') {
    throw new Error('registerDataSource requires { type, resolve }');
  }
  if (RESERVED_DATA_SOURCE_TYPES.has(spec.type)) {
    throw new Error(`data-source type "${spec.type}" is reserved`);
  }
  if (dataSources.has(spec.type)) {
    throw new Error(`data-source type "${spec.type}" is already registered`);
  }
  dataSources.set(spec.type, {
    pluginId,
    type: spec.type,
    resolve: spec.resolve,
    fields: Array.isArray(spec.fields) ? spec.fields : [],
    label: spec.label || spec.type,
    icon: spec.icon || '🔗',
    network: spec.network || null,
  });
}

function registerRouter(pluginId, router) {
  if (!router) throw new Error('registerRouter requires an Express router');
  routers.set(pluginId, router);
}

function hasWidget(type) { return widgets.has(type); }
function getWidget(type) { return widgets.get(type) || null; }
function listWidgetTypes() {
  return [...widgets.values()].map(({ pluginId, type, fields, label, icon }) => ({
    plugin_id: pluginId, type, fields, label, icon,
  }));
}

function hasDataSource(type) { return dataSources.has(type); }
function getDataSource(type) { return dataSources.get(type) || null; }
function listDataSourceTypes() {
  return [...dataSources.values()].map(({ pluginId, type, fields, label, icon }) => ({
    plugin_id: pluginId, type, fields, label, icon,
  }));
}

function dropPlugin(pluginId) {
  for (const [type, spec] of [...widgets.entries()]) {
    if (spec.pluginId === pluginId) widgets.delete(type);
  }
  for (const [type, spec] of [...dataSources.entries()]) {
    if (spec.pluginId === pluginId) dataSources.delete(type);
  }
  routers.delete(pluginId);
  hooks.dropPlugin(pluginId);
}

function forgetPlugin(id) {
  dropPlugin(id);
  plugins = plugins.filter((p) => p.id !== id);
}

function listRouters() {
  return [...routers.entries()].map(([pluginId, router]) => ({ pluginId, router }));
}

function isAcceptedWidgetType(type) {
  if (RESERVED_WIDGET_TYPES.has(type)) return true;
  return widgets.has(type);
}

function isAcceptedDataSourceType(type) {
  if (RESERVED_DATA_SOURCE_TYPES.has(type)) return true;
  return dataSources.has(type);
}

module.exports = {
  reset,
  recordPlugin,
  listPlugins,
  getPlugin,
  setPluginError,
  registerWidget,
  registerDataSource,
  registerRouter,
  dropPlugin,
  forgetPlugin,
  hasWidget,
  getWidget,
  listWidgetTypes,
  hasDataSource,
  getDataSource,
  listDataSourceTypes,
  listRouters,
  isAcceptedWidgetType,
  isAcceptedDataSourceType,
};
