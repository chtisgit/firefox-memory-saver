import { HistoryStore, HISTORY_DATABASE, HISTORY_STORES, idbRequest } from "../src/core/history-store.js";
import { DEFAULT_SETTINGS, emptyState, loadSettings, loadState, saveState, SETTINGS_KEY, RUNTIME_KEY } from "../src/core/settings.js";
import { startCoverage, MAX_USAGE_SESSIONS, MAX_DISCARD_EVENTS } from "../src/core/activity.js";
import { clearUsage } from "../src/core/usage.js";
import { historySnapshot } from "./history-helpers.js";

let counter = 0;
const copy = value => structuredClone(value);
async function fixture(callback) {
  const original = globalThis.indexedDB;
  const name = `${HISTORY_DATABASE}-test-${++counter}`;
  const connections = new Set();
  const operations = [];
  let fail = false;
  globalThis.indexedDB = { open(_name, version) {
    const request = original.open(name, version);
    request.addEventListener('success', () => {
      const db = request.result;
      connections.add(db);
      const transact = db.transaction.bind(db);
      db.transaction = (stores, mode) => {
        const tx = transact(stores, mode);
        const objectStore = tx.objectStore.bind(tx);
        tx.objectStore = key => {
          const store = objectStore(key);
          for (const method of ['get', 'getAll', 'put', 'delete', 'clear', 'count']) {
            const call = store[method].bind(store);
            store[method] = (...args) => {
              operations.push({ store: key, method, value: method === 'put' ? copy(args[0]) : undefined });
              if (fail && key === 'checkpoint' && method === 'put') { fail = false; throw new Error('Injected history write failure'); }
              return call(...args);
            };
          }
          return store;
        };
        return tx;
      };
    });
    return request;
  } };
  const state = { ...emptyState(), settings: { ...DEFAULT_SETTINGS, usageTrackingEnabled: true }, historyBuffered: true };
  const store = new HistoryStore();
  try {
    await store.load(state);
    await callback({ state, store, operations, failNext() { fail = true; },
      async snapshot() { return historySnapshot(globalThis.indexedDB); } });
  } finally {
    for (const db of connections) db.close();
    globalThis.indexedDB = original;
    await idbRequest(original.deleteDatabase(name));
  }
}

export function registerHistoryTests(test, equal) {
  test("storage split discards every embedded history collection while retaining preferences and operational data", async () => {
    const original = globalThis.browser;
    const legacy = { settings: { ...DEFAULT_SETTINGS, usageTrackingEnabled: true, usageHistoryDays: 30 },
      lifetimeDiscardCount: 42, discardRecords: { 2: { tabId: 2, discardedAt: 123 } },
      usageSessions: [{ privateHistory: 'old' }], usageDiscardEvents: [{ privateHistory: 'old' }],
      liveUsageRecords: { old: { privateHistory: 'old' } }, usageTabMetadata: { old: { privateHistory: 'old' } },
      usageCoverage: { historyId: 'old' }, usageRecorder: { revision: 99 } };
    const disk = { memorySaverState: legacy };
    const reads = [];
    const writes = [];
    globalThis.browser = { storage: { local: {
      async get(keys) { reads.push(keys); return Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(key => key in disk).map(key => [key, copy(disk[key])])); },
      async set(values) { writes.push(copy(values)); Object.assign(disk, copy(values)); },
      async remove(key) { delete disk[key]; },
    } } };
    try {
      const state = await loadState();
      equal(state.settings.usageHistoryDays, 30);
      equal(state.settings.usageTrackingEnabled, true);
      equal(state.lifetimeDiscardCount, 42);
      equal(state.discardRecords, legacy.discardRecords);
      equal(state.usageSessions, []);
      equal(state.usageDiscardEvents, []);
      equal(state.usageTabMetadata, {});
      equal(state.liveUsageRecords, {});
      equal(state.usageCoverage.historyId, null);
      equal(Object.keys(disk).sort(), [SETTINGS_KEY, RUNTIME_KEY].sort());
      equal(JSON.stringify(disk).includes('privateHistory'), false);
      const count = writes.length;
      state.usageSessions.push({ sessionId: 'new-history', url: 'https://private.example' });
      await saveState(state);
      equal(writes.length, count); // No preference/runtime changes, no storage.local write.
      reads.length = 0;
      await loadSettings();
      equal(reads, [SETTINGS_KEY]);
      await loadState();
      equal(reads.some(key => key === 'memorySaverState'), false);
    } finally { globalThis.browser = original; }
  });

  test("new history flushes individual records and reloads no completed history", async () => fixture(async ({ state, store, operations, snapshot }) => {
    const now = 20 * 86400000;
    startCoverage(state, now, 'test');
    state.usageTabMetadata.a = { tabKey: 'a', tabId: 1, closedAt: null, firstObservedAt: now };
    state.liveUsageRecords.a = { tabKey: 'a', tabId: 1, currentSessionStartedAt: now, lastCheckpointAt: now };
    state.usageSessions.push({ sessionId: 's1', tabKey: 'a', startedAt: now - 1000, endedAt: now, durationMs: 1000 });
    state.usageDiscardEvents.push({ eventId: 'd1', tabKey: 'a', observedAt: now });
    await store.save(state, now);
    equal(state.usageSessions, []);
    equal(state.usageDiscardEvents, []);
    const disk = await snapshot();
    equal(disk.usageSessions.length, 1);
    equal(disk.usageDiscardEvents.length, 1);
    operations.length = 0;
    const reloaded = { ...emptyState(), settings: state.settings, historyBuffered: true };
    await new HistoryStore().load(reloaded);
    equal(reloaded.usageSessions, []);
    equal(reloaded.usageDiscardEvents, []);
    equal(Object.keys(reloaded.usageTabMetadata), ['a']);
    equal(operations.some(op => ['sessions', 'discards', 'coverage'].includes(op.store)), false);
    operations.length = 0;
    state.liveUsageRecords.a.lastCheckpointAt++;
    await store.save(state, now + 1);
    equal(operations.filter(op => op.method === 'put').map(op => op.store).sort(), ['checkpoint', 'live']);
  }));

  test("a large history does not enlarge ordinary writes or get reloaded at startup", async () => fixture(async ({ state, store, operations }) => {
    const now = 20 * 86400000;
    startCoverage(state, now, 'test');
    for (let i = 0; i < 10000; i++) state.usageSessions.push({ sessionId: `session-${i}`, tabKey: `tab-${i % 100}`,
      startedAt: now - 1000, endedAt: now, durationMs: 1000, url: 'https://example.org/' + 'x'.repeat(500) });
    await store.save(state, now);
    operations.length = 0;
    state.usageRecorder.revision++;
    await store.save(state, now + 1);
    equal(operations.filter(op => op.method === 'put').map(op => op.store), ['checkpoint']);
    equal(JSON.stringify(operations).length < 2000, true);
    operations.length = 0;
    await new HistoryStore().load({ ...emptyState(), settings: state.settings, historyBuffered: true });
    equal(operations.some(op => ['sessions', 'discards', 'coverage'].includes(op.store)), false);
    const summary = await store.summary(state, 'tab-7', now);
    equal(summary.totalActiveMs, 100000);
  }));

  test("IndexedDB retention and independent caps keep truncation boundaries and closed metadata correct", async () => fixture(async ({ state, store, snapshot }) => {
    const now = 20 * 86400000;
    state.settings.usageHistoryDays = 1;
    startCoverage(state, now, 'test');
    state.usageTabMetadata.old = { tabKey: 'old', closedAt: now - 1000 };
    state.usageSessions.push({ sessionId: 'expired', tabKey: 'old', startedAt: 1, endedAt: 2 });
    for (let i = 0; i <= MAX_USAGE_SESSIONS; i++) state.usageSessions.push({ sessionId: `s${i}`, tabKey: 'a', startedAt: now - 2, endedAt: now + i });
    for (let i = 0; i <= MAX_DISCARD_EVENTS; i++) state.usageDiscardEvents.push({ eventId: `d${i}`, tabKey: 'a', observedAt: now + i });
    await store.save(state, now);
    const disk = await snapshot();
    equal(disk.usageSessions.length, MAX_USAGE_SESSIONS);
    equal(disk.usageDiscardEvents.length, MAX_DISCARD_EVENTS);
    equal(disk.usageCoverage.capBefore.sessions, now + 1);
    equal(disk.usageCoverage.capBefore.discards, now + 1);
    equal(disk.usageCoverage.retentionBefore.sessions, now - 86400000);
    equal(disk.usageTabMetadata.old, undefined);
  }));

  test("summary queries clip intervals to retention and include the current live interval", async () => fixture(async ({ state, store }) => {
    const now = 20 * 86400000;
    const cutoff = now - 86400000;
    state.settings.usageHistoryDays = 1;
    startCoverage(state, now, 'test');
    state.usageSessions.push({ sessionId: 's', tabKey: 'a', startedAt: cutoff - 1000, endedAt: cutoff + 500, durationMs: 1500 });
    state.usageSessions.push({ sessionId: 'other', tabKey: 'b', startedAt: now - 9999, endedAt: now });
    state.liveUsageRecords.a = { tabKey: 'a', currentSessionStartedAt: now - 1000 };
    await store.save(state, now);
    equal((await store.summary(state, 'a', now)).totalActiveMs, 1500);
  }));

  test("summaries use a coherent committed snapshot and reject a cleared generation", async () => fixture(async ({ state, store }) => {
    const now = 20 * 86400000;
    startCoverage(state, now - 1000, 'test');
    const generation = state.usageCoverage.historyId;
    state.liveUsageRecords.a = { tabKey: 'a', currentSessionStartedAt: now - 1000 };
    await store.save(state, now);
    state.usageSessions.push({ sessionId: 's', tabKey: 'a', startedAt: now - 1000, endedAt: now });
    delete state.liveUsageRecords.a;
    await store.save(state, now);
    // An old JS live snapshot must not be added to the now-completed DB record.
    state.liveUsageRecords.a = { tabKey: 'a', currentSessionStartedAt: now - 1000 };
    equal((await store.summary(state, 'a', now + 100)).totalActiveMs, 1000);
    clearUsage(state);
    startCoverage(state, now, 'cleared');
    await store.save(state, now);
    equal(await store.summaries(state.settings, ['a'], generation, now), {});
    equal(state.usageCoverage.segments[0].sequence, 1);
  }));

  test("history clear and disable remove detailed records atomically", async () => fixture(async ({ state, store, snapshot }) => {
    const now = 20 * 86400000;
    startCoverage(state, now, 'test');
    state.usageSessions.push({ sessionId: 's', tabKey: 'a', startedAt: now - 1000, endedAt: now });
    state.usageDiscardEvents.push({ eventId: 'd', tabKey: 'a', observedAt: now });
    await store.save(state, now);
    clearUsage(state);
    state.settings.usageTrackingEnabled = false;
    await store.save(state, now);
    const disk = await snapshot();
    equal(disk.usageSessions, []);
    equal(disk.usageDiscardEvents, []);
    equal(disk.usageTabMetadata, {});
    equal(disk.usageCoverage.segments, []);
    equal(disk.liveUsageRecords, {});
  }));

  test("failed history transactions preserve committed data and pending records for retry", async () => fixture(async ({ state, store, failNext, snapshot }) => {
    const now = 20 * 86400000;
    startCoverage(state, now, 'test');
    state.usageSessions.push({ sessionId: 'first', tabKey: 'a', startedAt: now - 1000, endedAt: now });
    await store.save(state, now);
    state.usageSessions.push({ sessionId: 'second', tabKey: 'a', startedAt: now, endedAt: now + 1000 });
    failNext();
    let failed = false;
    try { await store.save(state, now + 1000); } catch { failed = true; }
    equal(failed, true);
    equal(state.usageSessions.length, 1);
    equal((await snapshot()).usageSessions.map(s => s.sessionId), ['first']);
    await store.save(state, now + 1000);
    equal((await snapshot()).usageSessions.map(s => s.sessionId), ['first', 'second']);
  }));
}
