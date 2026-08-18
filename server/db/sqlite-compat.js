'use strict';

/*
 * A better-sqlite3-shaped façade over Node's built-in node:sqlite.
 *
 * WHY THIS EXISTS. BrightSignOS 10 ships /usr/bin/node v24.15.0, and Node 24 has node:sqlite built
 * in. better-sqlite3 is the last native dependency in the tree; on a player it is the only thing
 * that would need a cross-compiled binary, and it is the one piece that can turn a deploy into a
 * node-gyp build on a device with three slow cores. Dropping to the built-in removes that whole
 * class of problem — no ABI, no prebuild matrix, no preflight rebuild, no toolchain.
 *
 * WHY A SHIM RATHER THAN A REWRITE. The API is 95% identical where it matters. There are 1501
 * db.prepare() call sites in this server and every one of them uses .get/.all/.run, which node:sqlite
 * provides with the same shapes — including bare named parameters, which is the thing that would
 * otherwise have forced a sweep. Exactly three things are missing: .pragma(), .transaction() and
 * .pluck(). Those are 57, 45 and 2 call sites respectively, and they are all mechanical. A façade
 * turns a 1600-site migration into a 100-line file.
 *
 * ⚠️ FOREIGN KEYS: THE ONE REAL BEHAVIOUR CHANGE.
 *
 * node:sqlite turns foreign key enforcement ON by default; better-sqlite3 leaves it at SQLite's
 * default, which is OFF. This database has been running with them OFF, which is why
 * pruneProvisioningDevices() silently orphans child rows instead of cascading — the declared
 * ON DELETE CASCADEs are inert today.
 *
 * So this defaults to OFF: matching what the data has always experienced. Turning them on is a
 * REAL change to deletion semantics across every table with a declared cascade, and it deserves to
 * be its own change, with its own soak, rather than a silent side effect of swapping a driver.
 * Pass { enableForeignKeyConstraints: true } when you mean it.
 */

const { DatabaseSync } = require('node:sqlite');

/* Not implemented on purpose. Throwing beats silently doing something subtly different. */
function unsupported(name, why) {
  return () => {
    throw new Error(`sqlite-compat: ${name}() is not implemented${why ? ` — ${why}` : ''}`);
  };
}

class Statement {
  constructor(stmt, sql) {
    this._stmt = stmt;
    this._pluck = false;
    this.source = sql;
    // better-sqlite3 accepts bare keys for :named / @named / $named parameters. node:sqlite can
    // too, but only when asked — and this is what keeps the 1501 existing call sites untouched.
    try { stmt.setAllowBareNamedParameters(true); } catch (e) { /* older node, already default */ }
  }

  /*
   * Normalise the call shape, and — the load-bearing part — turn `undefined` into `null`.
   *
   * better-sqlite3 binds undefined as SQL NULL. node:sqlite REFUSES it:
   *   TypeError [ERR_INVALID_ARG_TYPE]: Provided value cannot be bound to SQLite parameter N.
   *
   * This server relies on the permissive behaviour, and there is a test that says so out loud
   * ("undefined really does become NULL rather than throwing, so the write did succeed"). An
   * optional field that simply is not present — the overwhelmingly common case in device_info
   * payloads — arrives as undefined, and under the strict rule every one of those writes throws.
   * Left unhandled it does not look like a binding bug: registration fails, the socket never
   * completes, and a dozen unrelated timing tests fail four seconds later.
   *
   * Also handles a single array (better-sqlite3 accepts args bare or as one array) and named
   * parameter objects, whose VALUES need the same treatment while the object itself must not be
   * spread.
   */
  _args(args) {
    const list = (args.length === 1 && Array.isArray(args[0])) ? args[0] : args;
    return Array.prototype.map.call(list, (v) => {
      if (v === undefined) return null;
      if (v && typeof v === 'object' && !Buffer.isBuffer(v) && !ArrayBuffer.isView(v)) {
        let copy = null;
        for (const k of Object.keys(v)) {
          if (v[k] === undefined) { copy = copy || { ...v }; copy[k] = null; }
        }
        return copy || v;
      }
      return v;
    });
  }

  get(...args) {
    const row = this._stmt.get(...this._args(args));
    if (!this._pluck || row === undefined) return row;
    const k = Object.keys(row);
    return k.length ? row[k[0]] : undefined;
  }

  all(...args) {
    const rows = this._stmt.all(...this._args(args));
    if (!this._pluck) return rows;
    return rows.map((r) => { const k = Object.keys(r); return k.length ? r[k[0]] : undefined; });
  }

  run(...args) {
    // node:sqlite already returns { changes, lastInsertRowid } as NUMBERS, matching
    // better-sqlite3's default (non-safeIntegers) behaviour. Verified, not assumed.
    return this._stmt.run(...this._args(args));
  }

  iterate(...args) { return this._stmt.iterate(...this._args(args)); }

  /* better-sqlite3 returns `this` so it chains: db.prepare(sql).pluck().get(id) */
  pluck(toggle = true) { this._pluck = toggle !== false; return this; }

  /* .raw() is setReturnArrays under a different name. */
  raw(toggle = true) { this._stmt.setReturnArrays(toggle !== false); return this; }

  columns() { return this._stmt.columns(); }

  safeIntegers(toggle = true) { this._stmt.setReadBigInts(toggle !== false); return this; }

  expand() { throw new Error('sqlite-compat: .expand() is not implemented (no call sites use it)'); }
}

class Database {
  constructor(filename, options = {}) {
    this._db = new DatabaseSync(filename, {
      // See the header. Default OFF to match what this database has always run with; the swap to
      // node:sqlite must not quietly change what DELETE does.
      enableForeignKeyConstraints: options.enableForeignKeyConstraints === true,
      ...(options.readonly || options.readOnly ? { readOnly: true } : {}),
      ...(typeof options.timeout === 'number' ? { timeout: options.timeout } : {}),
    });
    this.name = filename;
    this.open = true;
    this._txDepth = 0;
  }

  prepare(sql) { return new Statement(this._db.prepare(sql), sql); }

  exec(sql) { this._db.exec(sql); return this; }

  /*
   * better-sqlite3's .pragma(). Two forms are used in this codebase:
   *   db.pragma('foreign_keys = ON')          -> a write, no result wanted
   *   db.pragma('foreign_keys', {simple:true}) -> a read of a single value
   * The general form returns rows, as better-sqlite3 does.
   */
  pragma(sql, options = {}) {
    const text = `PRAGMA ${sql}`;
    // An assignment has no result set. Running it through prepare().all() works for most pragmas
    // but throws for some, so writes go through exec().
    if (/=/.test(sql) && !options.simple) { this._db.exec(text); return undefined; }
    const rows = this._db.prepare(text).all();
    if (!options.simple) return rows;
    if (!rows.length) return undefined;
    const k = Object.keys(rows[0]);
    return k.length ? rows[0][k[0]] : undefined;
  }

  /*
   * better-sqlite3's .transaction(fn) returns a CALLABLE that runs fn inside a transaction and
   * returns its value, rolling back on throw. Nesting matters: this codebase has 45 call sites and
   * some nest, so an inner call must use a SAVEPOINT rather than a second BEGIN — SQLite has no
   * nested transactions and would throw "cannot start a transaction within a transaction".
   */
  transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('sqlite-compat: transaction() expects a function');
    const self = this;
    const wrapper = function (...args) {
      const nested = self._txDepth > 0;
      const name = `sp_${self._txDepth}`;
      self._db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
      self._txDepth++;
      try {
        const out = fn.apply(this, args);
        self._txDepth--;
        self._db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
        return out;
      } catch (e) {
        self._txDepth--;
        try {
          self._db.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK');
          if (nested) self._db.exec(`RELEASE ${name}`);
        } catch (e2) { /* the rollback itself failing must not mask the original error */ }
        throw e;
      }
    };
    // better-sqlite3 exposes these variants. Only the default is used here, but code that reaches
    // for .immediate() should get a transaction rather than "undefined is not a function".
    wrapper.default = wrapper;
    wrapper.deferred = wrapper;
    wrapper.immediate = wrapper;
    wrapper.exclusive = wrapper;
    return wrapper;
  }

  get inTransaction() { return this._txDepth > 0; }

  function(name, ...rest) {
    const fn = rest.pop();
    const opts = rest.pop() || {};
    return this._db.function(name, opts, fn);
  }

  aggregate(name, opts) { return this._db.aggregate(name, opts); }

  close() { this.open = false; return this._db.close(); }

  loadExtension(...a) { this._db.enableLoadExtension(true); return this._db.loadExtension(...a); }

  serialize() { return this._db.serialize(); }

  backup = unsupported('backup', 'node:sqlite has no online backup API; copy the file instead');
  table = unsupported('table', 'virtual tables are not used here');
  unsafeMode = unsupported('unsafeMode');
}

module.exports = Database;
module.exports.Database = Database;
