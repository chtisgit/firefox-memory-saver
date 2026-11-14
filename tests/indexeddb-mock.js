// Small Node-only IndexedDB contract double. Browser tests use native IndexedDB.
// Models asynchronous requests, indexes, cursor deletion, transaction ordering,
// and rollback; no application/history logic lives here.
const copy = value => structuredClone(value);
function compare(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = compare(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
export class TestKeyRange {
  constructor(lower, upper, lowerOpen = false, upperOpen = false) { Object.assign(this, { lower, upper, lowerOpen, upperOpen }); }
  includes(key) { return (this.lower === undefined || compare(key, this.lower) > (this.lowerOpen ? 0 : -1))
    && (this.upper === undefined || compare(key, this.upper) < (this.upperOpen ? 0 : 1)); }
  static upperBound(upper, open = false) { return new this(undefined, upper, false, open); }
  static bound(lower, upper, lowerOpen = false, upperOpen = false) { return new this(lower, upper, lowerOpen, upperOpen); }
}
function matches(query, key) { return query === undefined || (query instanceof TestKeyRange ? query.includes(key) : compare(query, key) === 0); }
const pathKey = (value, path) => Array.isArray(path) ? path.map(key => value[key]) : value[path];

class Source {
  constructor(tx, name, index = null) { Object.assign(this, { tx, name, indexName: index }); }
  get definition() { return this.tx.data.get(this.name); }
  rows(query) {
    const def = this.definition;
    const path = this.indexName ? def.indexes.get(this.indexName) : def.keyPath;
    return [...def.rows.entries()].map(([primary, value]) => ({ primary, value, key: path ? pathKey(value, path) : primary }))
      .filter(row => row.key !== undefined && matches(query, row.key)).sort((a, b) => compare(a.key, b.key) || compare(a.primary, b.primary));
  }
  index(name) { return new Source(this.tx, this.name, name); }
  createIndex(name, keyPath) { this.definition.indexes.set(name, keyPath); }
  get(key) { return this.tx.request(() => this.definition.rows.get(key)); }
  getAll(query) { return this.tx.request(() => this.rows(query).map(row => row.value)); }
  count(query) { return this.tx.request(() => this.rows(query).length); }
  put(value, key) {
    const captured = copy(value);
    return this.tx.request(() => {
      this.tx.writable();
      const primary = key ?? pathKey(captured, this.definition.keyPath);
      if (primary === undefined) throw new Error('DataError: missing key');
      this.definition.rows.set(primary, captured);
      return primary;
    });
  }
  delete(key) { return this.tx.request(() => { this.tx.writable(); this.definition.rows.delete(key); }); }
  clear() { return this.tx.request(() => { this.tx.writable(); this.definition.rows.clear(); }); }
  openCursor(query) {
    const request = {};
    let rows;
    let offset = 0;
    const next = () => this.tx.request(() => {
      rows ??= this.rows(query);
      const row = rows[offset++];
      return row ? { value: copy(row.value), key: row.key, primaryKey: row.primary,
        delete: () => this.delete(row.primary), continue: next } : null;
    }, request, false);
    next();
    return request;
  }
}

class Transaction {
  constructor(database, names, mode) {
    this.database = database;
    this.names = Array.isArray(names) ? names : [names];
    this.mode = mode;
    this.pending = 0;
    this.started = false;
    this.finished = false;
    this.jobs = [];
    const before = database.tail;
    database.tail = new Promise(resolve => { this.release = resolve; });
    before.then(() => {
      if (this.finished) return;
      this.data = new Map(this.names.map(name => [name, copy(database.stores.get(name))]));
      this.started = true;
      for (const job of this.jobs) queueMicrotask(job);
      this.check();
    });
  }
  objectStore(name) { if (!this.names.includes(name)) throw new Error('NotFoundError'); return new Source(this, name); }
  writable() { if (this.mode !== 'readwrite') throw new Error('ReadOnlyError'); }
  request(operation, request = {}, cloneResult = true) {
    if (this.finished) throw new Error('TransactionInactiveError');
    this.pending++;
    const run = () => {
      if (this.finished) return;
      try {
        const value = operation();
        request.result = cloneResult ? copy(value) : value;
        request.onsuccess?.({ target: request });
      } catch (error) { request.error = error; request.onerror?.({ target: request }); this.abort(error); }
      this.pending--;
      this.check();
    };
    if (this.started) queueMicrotask(run); else this.jobs.push(run);
    return request;
  }
  check() {
    // IndexedDB commits after the task's Promise microtasks have drained.
    setTimeout(() => {
      if (!this.started || this.finished || this.pending) return;
      this.finished = true;
      if (this.mode === 'readwrite') for (const name of this.names) this.database.stores.set(name, this.data.get(name));
      this.oncomplete?.(); this.release();
    });
  }
  abort(error = new Error('AbortError')) {
    if (this.finished) throw new Error('InvalidStateError');
    this.error = error; this.finished = true;
    queueMicrotask(() => { this.onabort?.(); this.release(); });
  }
}

export class TestIDBFactory {
  databases = new Map();
  open(name, version = 1) {
    const request = { listeners: [], addEventListener(type, fn) { this.listeners.push([type, fn]); } };
    queueMicrotask(() => {
      let database = this.databases.get(name);
      const upgrade = !database;
      if (!database) {
        database = { stores: new Map(), tail: Promise.resolve(), version };
        this.databases.set(name, database);
      }
      request.result = {
        createObjectStore(storeName, options = {}) {
          database.stores.set(storeName, { keyPath: options.keyPath, indexes: new Map(), rows: new Map() });
          return { createIndex(index, keyPath) { database.stores.get(storeName).indexes.set(index, keyPath); } };
        },
        transaction(names, mode = 'readonly') { return new Transaction(database, names, mode); },
        close() {},
      };
      if (upgrade) request.onupgradeneeded?.();
      for (const [type, fn] of request.listeners) if (type === 'success') fn();
      request.onsuccess?.();
    });
    return request;
  }
  deleteDatabase(name) { const request = {}; queueMicrotask(() => { this.databases.delete(name); request.onsuccess?.(); }); return request; }
}
