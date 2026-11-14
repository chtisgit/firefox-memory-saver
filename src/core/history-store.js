import { MAX_COVERAGE_SEGMENTS, MAX_DISCARD_EVENTS, MAX_USAGE_SESSIONS, emptyActivityState } from "./activity.js";
import { usageSummaryForTab } from "./usage.js";

export const HISTORY_DATABASE = "memory-saver-history";
export const HISTORY_STORES = ["sessions", "discards", "coverage", "tabs", "live", "checkpoint"];

export function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(db, stores, mode, action) {
  const tx = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? new Error("History transaction aborted"));
    tx.onerror = () => {}; // onabort is the transaction's final result.
  });
  done.catch(() => {});
  try {
    const result = await action(tx);
    await done;
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* already complete/aborted */ }
    await done.catch(() => {});
    throw error;
  }
}

function fingerprints(records) {
  return new Map(Object.entries(records).map(([key, value]) => [key, JSON.stringify(value)]));
}

function changes(records, previous) {
  const next = fingerprints(records);
  return { next, puts: Object.entries(records).filter(([key]) => next.get(key) !== previous.get(key)).map(([, value]) => value),
    deletes: [...previous.keys()].filter(key => !next.has(key)) };
}

function removeCursor(index, range, limit, removed) {
  return new Promise((resolve, reject) => {
    let count = 0;
    const request = index.openCursor(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || count >= limit) return resolve();
      removed(cursor.value);
      cursor.delete();
      count++;
      cursor.continue();
    };
  });
}

// Only unfinished work and open-tab state stay in JS memory. Completed history
// is stored as individual indexed records, never a storage.local JSON snapshot.
export class HistoryStore {
  #db;
  #opening;
  #generation;
  #live = new Map();
  #tabs = new Map();
  #coverage = new Map();
  #sequence = 0;
  #maintenanceAt = 0;
  #days;
  #loaded = false;

  async open() {
    if (this.#db) return this.#db;
    if (!this.#opening) this.#opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(HISTORY_DATABASE, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const [name, key, time] of [["sessions", "sessionId", "endedAt"], ["discards", "eventId", "observedAt"], ["coverage", "id", "lastCheckpointAt"]]) {
          const store = db.createObjectStore(name, { keyPath: key });
          store.createIndex("time", time);
          if (name !== "coverage") store.createIndex("tabKey", "tabKey");
          if (name === "sessions") store.createIndex("tabTime", ["tabKey", "endedAt"]);
          if (name === "coverage") store.createIndex("sequence", "sequence");
        }
        const tabs = db.createObjectStore("tabs", { keyPath: "tabKey" });
        tabs.createIndex("open", "open");
        db.createObjectStore("live", { keyPath: "tabKey" });
        db.createObjectStore("checkpoint");
      };
      request.onerror = () => { this.#opening = null; reject(request.error); };
      request.onsuccess = () => {
        this.#db = request.result;
        this.#db.onversionchange = () => { this.#db.close(); this.#db = null; this.#opening = null; };
        resolve(this.#db);
      };
    });
    return this.#opening;
  }

  async load(state) {
    const db = await this.open();
    const result = await transaction(db, ["checkpoint", "tabs", "live"], "readonly", async tx => {
      const checkpoint = idbRequest(tx.objectStore("checkpoint").get("recorder"));
      const tabs = idbRequest(tx.objectStore("tabs").index("open").getAll(1));
      const live = idbRequest(tx.objectStore("live").getAll());
      return { checkpoint: await checkpoint, tabs: await tabs, live: await live };
    });
    const checkpoint = result.checkpoint;
    if (checkpoint) {
      state.usageCoverage = { ...emptyActivityState().usageCoverage, ...checkpoint.coverage,
        segments: checkpoint.segment ? [checkpoint.segment] : [] };
      state.usageRecorder = checkpoint.recorder;
      this.#sequence = checkpoint.sequence ?? 0;
    }
    state.liveUsageRecords = Object.fromEntries(result.live.map(record => [record.tabKey, record]));
    state.usageTabMetadata = Object.fromEntries(result.tabs.map(({ open, ...record }) => [record.tabKey, record]));
    state.usageSessions = [];
    state.usageDiscardEvents = [];
    this.#loaded = true;
    this.#generation = state.usageCoverage.historyId;
    this.#live = fingerprints(state.liveUsageRecords);
    this.#tabs = fingerprints(state.usageTabMetadata);
    this.#coverage = fingerprints(Object.fromEntries(state.usageCoverage.segments.map(s => [s.id, s])));
  }

  async save(state, now = Date.now()) {
    if (!this.#loaded) throw new Error("History was not loaded; refusing to overwrite existing records.");
    if (!state.settings.usageTrackingEnabled && this.#generation === null && !this.#live.size && !this.#tabs.size) return;
    const db = await this.open();
    const reset = this.#generation !== state.usageCoverage.historyId;
    const tabs = changes(state.usageTabMetadata, reset ? new Map() : this.#tabs);
    const live = changes(state.liveUsageRecords, reset ? new Map() : this.#live);
    const sessions = state.usageSessions.slice();
    const discards = state.usageDiscardEvents.slice();
    const pending = [...state.usageCoverage.segments, ...sessions, ...discards];
    if (reset) this.#sequence = 0;
    // Retain already assigned sequence numbers when retrying an aborted write.
    for (const record of pending) if (Number.isSafeInteger(record.sequence)) this.#sequence = Math.max(this.#sequence, record.sequence);
    for (const record of pending) record.sequence ??= ++this.#sequence;
    const coverage = changes(Object.fromEntries(state.usageCoverage.segments.map(s => [s.id, s])), reset ? new Map() : this.#coverage);
    const maintain = reset || sessions.length || discards.length || tabs.puts.some(tab => tab.closedAt != null) || coverage.puts.length > 1
      || now - this.#maintenanceAt >= 300000 || this.#days !== state.settings.usageHistoryDays;
    // Work on a copy: an aborted transaction must not advance truncation boundaries.
    const coverageState = structuredClone(state.usageCoverage);
    await transaction(db, HISTORY_STORES, "readwrite", async tx => {
      if (reset) for (const name of HISTORY_STORES) tx.objectStore(name).clear();
      for (const value of sessions) tx.objectStore("sessions").put(value);
      for (const value of discards) tx.objectStore("discards").put(value);
      for (const value of coverage.puts) tx.objectStore("coverage").put(value);
      for (const value of tabs.puts) tx.objectStore("tabs").put({ ...value, open: value.closedAt == null ? 1 : 0 });
      for (const value of live.puts) tx.objectStore("live").put(value);
      for (const key of live.deletes) tx.objectStore("live").delete(key);
      if (maintain) await this.#prune(tx, state.settings.usageHistoryDays, coverageState, now,
        tabs.puts.filter(tab => tab.closedAt != null).map(tab => tab.tabKey));
      const { segments, ...coverageMetadata } = coverageState;
      tx.objectStore("checkpoint").put({ coverage: coverageMetadata, segment: segments.at(-1) ?? null,
        recorder: { ...state.usageRecorder }, sequence: this.#sequence }, "recorder");
    });
    this.#generation = state.usageCoverage.historyId;
    this.#live = live.next;
    this.#tabs = tabs.next;
    state.usageSessions.splice(0, sessions.length);
    state.usageDiscardEvents.splice(0, discards.length);
    const last = coverageState.segments.at(-1);
    state.usageCoverage = { ...coverageState, segments: last ? [last] : [] };
    this.#coverage = fingerprints(last ? { [last.id]: last } : {});
    for (const [key, value] of Object.entries(state.usageTabMetadata)) {
      if (value.closedAt != null) { delete state.usageTabMetadata[key]; this.#tabs.delete(key); }
    }
    if (maintain) { this.#maintenanceAt = now; this.#days = state.settings.usageHistoryDays; }
  }

  async #prune(tx, days, coverage, now, closedKeys) {
    const cutoff = now - days * 86400000;
    const candidates = new Set(closedKeys);
    const advance = (group, key, time) => {
      coverage[group][key] = Math.max(coverage[group][key] ?? 0, time);
      coverage.incompleteBefore[key] = Math.max(coverage.incompleteBefore[key] ?? 0, time);
    };
    for (const [name, key, cap, time] of [["sessions", "sessions", MAX_USAGE_SESSIONS, "endedAt"],
      ["discards", "discards", MAX_DISCARD_EVENTS, "observedAt"], ["coverage", "coverage", MAX_COVERAGE_SEGMENTS, "lastCheckpointAt"]]) {
      const store = tx.objectStore(name);
      if (coverage.recordingStartedAt != null) advance("retentionBefore", key, cutoff);
      const removed = record => { if (record.tabKey) candidates.add(record.tabKey); };
      await removeCursor(store.index("time"), IDBKeyRange.upperBound(cutoff, true), Infinity, removed);
      const excess = (await idbRequest(store.count())) - cap;
      if (excess > 0) await removeCursor(store.index(name === "coverage" ? "sequence" : "time"), undefined, excess, record => {
        removed(record);
        advance("capBefore", key, record[time] + 1);
      });
    }
    for (const key of candidates) {
      const metadata = await idbRequest(tx.objectStore("tabs").get(key));
      if (!metadata || metadata.closedAt == null) continue;
      const sessions = await idbRequest(tx.objectStore("sessions").index("tabKey").count(key));
      const discards = await idbRequest(tx.objectStore("discards").index("tabKey").count(key));
      if (!sessions && !discards) tx.objectStore("tabs").delete(key);
    }
  }

  async tabMetadata(tabKey) {
    const db = await this.open();
    const record = await transaction(db, ["tabs"], "readonly", tx => idbRequest(tx.objectStore("tabs").get(tabKey)));
    if (!record) return null;
    const { open, ...metadata } = record;
    return metadata;
  }

  async summaries(settings, tabKeys, historyId, now = Date.now()) {
    const keys = [...new Set(tabKeys.filter(Boolean))];
    if (!keys.length || !historyId) return {};
    const db = await this.open();
    // One consistent readonly transaction prevents counting a just-completed
    // interval together with an older in-memory copy of that live interval.
    return transaction(db, ["checkpoint", "sessions", "live", "tabs"], "readonly", async tx => {
      const checkpoint = await idbRequest(tx.objectStore("checkpoint").get("recorder"));
      if (checkpoint?.coverage.historyId !== historyId) return {};
      const cutoff = now - settings.usageHistoryDays * 86400000;
      const entries = await Promise.all(keys.map(async key => {
        const sessions = idbRequest(tx.objectStore("sessions").index("tabTime")
          .getAll(IDBKeyRange.bound([key, cutoff], [key, now])));
        const live = idbRequest(tx.objectStore("live").get(key));
        const metadata = idbRequest(tx.objectStore("tabs").get(key));
        const snapshot = { settings, usageSessions: await sessions,
          liveUsageRecords: { [key]: await live }, usageTabMetadata: { [key]: await metadata } };
        return [key, usageSummaryForTab(snapshot, key, now)];
      }));
      return Object.fromEntries(entries);
    });
  }

  async summary(state, tabKey, now = Date.now()) {
    return (await this.summaries(state.settings, [tabKey], state.usageCoverage.historyId, now))[tabKey]
      ?? { totalActiveMs: 0, lastActivatedAt: null };
  }
}
