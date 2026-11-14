import { HISTORY_DATABASE, idbRequest } from "../src/core/history-store.js";
import { historySnapshot } from "./history-helpers.js";
import { DEFAULT_SETTINGS, emptyState } from "../src/core/settings.js";
import { releaseTabKey } from "../src/core/usage.js";

let instance = 0;
const clone = (value) => structuredClone(value);
const makeTab = (id, overrides = {}) => ({ id, windowId: 1, active: false, discarded: false, autoDiscardable: true,
  title: `Tab ${id}`, url: `https://site${id}.example`, lastAccessed: 1, ...overrides });

// Uses actual background listeners/messages with in-memory Firefox API contracts.
async function recorderHarness({ enabled = true, tabs = [makeTab(2001, { active: true }), makeTab(2002)], diskState, tabValues = {} } = {}) {
  const originalBrowser = globalThis.browser;
  const originalFactory = globalThis.indexedDB;
  const databasePrefix = `recorder-${++instance}-`;
  const connections = new Set();
  const factory = { open(name, version) {
    const request = originalFactory.open(databasePrefix + name, version);
    request.addEventListener('success', () => {
      const db = request.result;
      connections.add(db);
      const transaction = db.transaction.bind(db);
      db.transaction = (stores, mode) => {
        historyTransactions.push({ stores, mode });
        const tx = transaction(stores, mode);
        const hold = mode === 'readwrite' ? historyGate : null;
        if (!hold) return tx;
        return new Proxy(tx, {
          get(target, key) { const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; },
          set(target, key, value) {
            if (key === 'oncomplete') target.oncomplete = event => { heldWriteStarted?.(); hold.promise.then(() => value(event)); };
            else target[key] = value;
            return true;
          },
        });
      };
    });
    return request;
  } };
  globalThis.indexedDB = factory;
  let snapshot;
  let historyGate = null;
  let heldWriteStarted;
  const historyTransactions = [];
  const localWrites = [];
  const originalNow = Date.now;
  const originalError = console.error;
  const errors = [];
  const knownIds = new Set(tabs.map((tab) => tab.id));
  let now = 20 * 86_400_000;
  let disk = { memorySaverState: diskState ?? { ...emptyState(), settings: { ...DEFAULT_SETTINGS,
    minimumLoadedTabsPerWindow: 0, usageTrackingEnabled: enabled } } };
  let session = {};
  let listeners = {};
  let focus = 1;
  let gate = null;
  const values = new Map(Object.entries(tabValues).map(([id, value]) => [Number(id), clone(value)]));
  const refused = new Set();
  Date.now = () => now;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const state = () => clone(snapshot);
  const api = () => ({
    storage: {
      local: {
        async get(keys) {
          if (gate) await gate;
          const names = typeof keys === 'string' ? [keys] : keys ?? Object.keys(disk);
          return Object.fromEntries(names.filter(key => key in disk).map(key => [key, clone(disk[key])]));
        },
        async remove(key) { delete disk[key]; },
        async set(value) { localWrites.push(clone(value)); Object.assign(disk, clone(value)); },
      },
      session: {
        async get() { return clone(session); },
        async set(value) { Object.assign(session, clone(value)); },
        async remove(key) { delete session[key]; },
      },
    },
    runtime: { onMessage: event('message'), onInstalled: event('installed'), onSuspend: event('suspend'), onSuspendCanceled: event('suspendCanceled') },
    alarms: { async clear() {}, async create() {}, onAlarm: event('alarm') },
    tabs: {
      async query(q = {}) { return clone(tabs.filter(tab => (q.active == null || tab.active === q.active)
        && (q.windowId == null || tab.windowId === q.windowId)
        && (!(q.currentWindow || q.lastFocusedWindow) || tab.windowId === focus))); },
      async get(id) { const tab = tabs.find(t => t.id === id); if (!tab) throw new Error('Tab closed'); return clone(tab); },
      async update(id, change) { Object.assign(tabs.find(t => t.id === id), change); },
      async discard(id) { const tab = tabs.find(t => t.id === id); if (!tab) throw new Error('Tab closed');
        if (refused.has(id)) return;
        tab.discarded = true;
        listeners.updated(id, { discarded: true }, clone(tab));
      },
      async remove() {},
      onActivated: event('activated'), onCreated: event('created'), onUpdated: event('updated'), onRemoved: event('removed'), onReplaced: event('replaced'), onDetached: event('detached'), onAttached: event('attached'),
    },
    windows: { WINDOW_ID_NONE: -1, async get(id) { return { focused: id === focus }; }, onFocusChanged: event('focus'), onRemoved: event('windowRemoved') },
    sessions: {
      async getTabValue(id, key) { return clone(values.get(id)?.[key]); },
      async setTabValue(id, key, value) { values.set(id, { ...(values.get(id) ?? {}), [key]: clone(value) }); },
      async removeTabValue(id, key) { if (values.has(id)) delete values.get(id)[key]; },
    },
    menus: { async removeAll() {}, create() {}, async update() {}, async refresh() {}, onShown: event('shown'), onClicked: event('clicked') },
  });
  const request = async message => {
    const response = await listeners.message(message);
    if (!response.ok) throw new Error(response.error);
    snapshot = { ...disk.memorySaverRuntime, settings: disk.memorySaverSettings,
      ...(await historySnapshot(factory)), schemaVersion: 2 };
    return response.data;
  };
  const flush = async () => {
    await listeners.message({ type: '__TEST_QUEUE_BARRIER' });
    await listeners.message({ type: '__TEST_QUEUE_BARRIER' });
    snapshot = { ...disk.memorySaverRuntime, settings: disk.memorySaverSettings,
      ...(await historySnapshot(factory)), schemaVersion: 2 };
  };
  const activate = id => {
    const tab = tabs.find(t => t.id === id);
    for (const candidate of tabs) if (candidate.windowId === tab.windowId) candidate.active = candidate.id === id;
    const slept = tab.discarded;
    tab.discarded = false;
    tab.lastAccessed = now;
    listeners.activated({ tabId: id, windowId: tab.windowId });
    if (slept) listeners.updated(id, { discarded: false }, clone(tab));
  };
  const load = async ({ resetSession = false, wakeActivation } = {}) => {
    for (const id of knownIds) releaseTabKey(id);
    if (resetSession) session = {};
    let release;
    if (wakeActivation) gate = new Promise(resolve => { release = resolve; });
    for (const db of connections) db.close();
    connections.clear();
    listeners = {};
    globalThis.browser = api();
    await import(`../src/background/index.js?recorder-test=${++instance}`);
    if (wakeActivation) { activate(wakeActivation); gate = null; release(); }
    await flush();
  };
  try { await load(); } catch (error) {
    Date.now = originalNow; console.error = originalError; globalThis.browser = originalBrowser; globalThis.indexedDB = originalFactory; throw error;
  }
  return {
    state, request, flush, load, tabs, values, refused,
    historyTransactions, localWrites,
    rawMessage(message) { return listeners.message(message); },
    localState() { return clone(disk); },
    holdHistoryWrites() {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { heldWriteStarted = resolve; });
      historyGate = { promise };
      return { started, release() { historyGate = null; release(); } };
    },
    advance(ms) { now += ms; }, now: () => now,
    activate,
    emit(name, ...args) { listeners[name](...args); },
    key(id) { return values.get(id)?.memorySaverTabKey; },
    focus(id) { focus = id; listeners.focus(id); },
    update(id, change) { const tab = tabs.find(t => t.id === id); Object.assign(tab, change); listeners.updated(id, change, clone(tab)); },
    create(tab, copiedFrom) {
      knownIds.add(tab.id);
      if (copiedFrom) values.set(tab.id, clone(values.get(copiedFrom)));
      tabs.push(tab); listeners.created(clone(tab));
    },
    close(id) { tabs.splice(tabs.findIndex(t => t.id === id), 1); listeners.removed(id); },
    async dispose() {
      await flush();
      for (const id of knownIds) releaseTabKey(id);
      Date.now = originalNow; console.error = originalError; globalThis.browser = originalBrowser; globalThis.indexedDB = originalFactory;
      for (const db of connections) db.close();
      await idbRequest(originalFactory.deleteDatabase(databasePrefix + HISTORY_DATABASE));
      if (errors.length) throw new Error(errors.join('\n'));
    },
  };
}

export function registerRecorderTests(test, equal) {
  test("settings and popup base reads bypass a blocked history write and perform no persistence", async () => {
    const h = await recorderHarness();
    const hold = h.holdHistoryWrites();
    try {
      h.advance(1000); h.activate(2002);
      await hold.started;
      const writesBefore = h.localWrites.length;
      const transactionsBefore = h.historyTransactions.length;
      const response = await Promise.race([
        Promise.all([h.rawMessage({ type: 'GET_SETTINGS' }), h.rawMessage({ type: 'GET_POPUP_STATE' })]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('UI read waited for recorder history')), 1000)),
      ]);
      equal(response[0].ok, true);
      equal(response[1].ok, true);
      equal(response[1].data.currentTab.id, 2002);
      equal(response[1].data.currentTab.usage, null);
      equal(h.localWrites.length, writesBefore);
      equal(h.historyTransactions.length, transactionsBefore);
      equal(Object.keys(h.localState()).sort(), ['memorySaverRuntime', 'memorySaverSettings']);
    } finally { hold.release(); await h.dispose(); }
  });

  test("popup activity summaries use the indexed history request and include ongoing activity", async () => {
    const h = await recorderHarness();
    try {
      h.advance(1000); h.activate(2002); await h.flush();
      h.advance(2000);
      const response = await h.request({ type: 'GET_TAB_USAGE', tabIds: [2001, 2002, 9999] });
      equal(response[2001].totalActiveMs, 1000);
      equal(response[2002].totalActiveMs, 2000);
      equal(response[9999], undefined);
      const local = h.localState();
      equal(JSON.stringify(local).includes('usageSessions'), false);
      equal(JSON.stringify(local).includes('liveUsageRecords'), false);
    } finally { await h.dispose(); }
  });

  test("recording is opt-in, registers sleeping/protected tabs, and clears every detailed collection", async () => {
    const h = await recorderHarness({ enabled: false, tabs: [makeTab(2001, { active: true }), makeTab(2002, { discarded: true }), makeTab(2003, { pinned: true })] });
    try {
      equal(h.state().usageTabMetadata, {});
      await h.request({ type: 'SAVE_SETTINGS', settings: { ...h.state().settings, usageTrackingEnabled: true } });
      equal(Object.keys(h.state().usageTabMetadata).length, 3);
      equal(h.state().usageDiscardEvents.length, 0);
      equal(h.state().usageTabMetadata[h.key(2002)].lastActivatedAt, null);
      h.advance(1000);
      h.update(2003, { discarded: true });
      await h.flush();
      equal(h.state().usageDiscardEvents.length, 1);
      await h.request({ type: 'SAVE_SETTINGS', settings: { ...h.state().settings, usageTrackingEnabled: false } });
      equal(h.state().usageDiscardEvents, []);
      equal(h.state().usageTabMetadata, {});
      equal(h.state().usageSessions, []);
      equal(h.state().usageCoverage.segments, []);
      h.update(2002, { discarded: false });
      h.update(2002, { discarded: true });
      await h.flush();
      equal(h.state().usageDiscardEvents, []);
    } finally { await h.dispose(); }
  });

  test("background records manual/automatic/external sleeps once and excludes refusals", async () => {
    const h = await recorderHarness({ tabs: [makeTab(2001, { active: true }), makeTab(2002), makeTab(2003)] });
    try {
      h.advance(1000);
      const result = await h.request({ type: 'DISCARD_ELIGIBLE_NOW' });
      await h.flush();
      equal(result.discardedTabIds, [2002, 2003]);
      equal(h.state().usageDiscardEvents.map(e => e.source), ['manual', 'manual']);
      h.update(2002, { discarded: false }); await h.flush();
      h.advance(1000);
      h.update(2002, { discarded: true }); await h.flush();
      equal(h.state().usageDiscardEvents.map(e => e.source), ['manual', 'manual', 'external']);
      h.update(2003, { discarded: false }); await h.flush();
      h.refused.add(2003);
      equal((await h.request({ type: 'DISCARD_ELIGIBLE_NOW' })).refusedCount, 1);
      equal(h.state().usageDiscardEvents.length, 3);
      h.refused.clear();
      h.emit('alarm', { name: 'memory-saver-scan' }); await h.flush();
      equal(h.state().usageDiscardEvents.at(-1).source, 'automatic');
    } finally { await h.dispose(); }
  });

  test("navigation preserves actual activation time and attributes foreground time to the recorded URL", async () => {
    const h = await recorderHarness();
    try {
      h.advance(1000); h.activate(2002); await h.flush();
      h.advance(1000); h.activate(2001); await h.flush();
      const activation = h.state().usageTabMetadata[h.key(2001)].lastActivatedAt;
      h.advance(1000); h.update(2001, { url: 'https://different.example/page', title: 'Different' }); await h.flush();
      equal(h.state().usageTabMetadata[h.key(2001)].lastActivatedAt, activation);
      equal(h.state().liveUsageRecords[h.key(2001)].startReason, 'navigation');
      h.advance(1000); h.focus(-1); await h.flush();
      const sessions = h.state().usageSessions.filter(s => s.tabKey === h.key(2001));
      equal(sessions.at(-1).url, 'https://different.example/page');
      equal(sessions.at(-2).url, 'https://site2001.example');
      equal(Object.values(h.state().liveUsageRecords).filter(r => r.currentSessionStartedAt != null).length, 0);
    } finally { await h.dispose(); }
  });

  test("clean background suspension preserves the interval through its wake-triggering activation", async () => {
    const h = await recorderHarness();
    try {
      const start = h.now();
      const key = h.key(2001);
      h.advance(30_000); h.emit('alarm', { name: 'memory-saver-usage-checkpoint' }); await h.flush();
      h.emit('suspend');
      h.advance(30_000);
      await h.load({ wakeActivation: 2002 });
      const sessions = h.state().usageSessions.filter(s => s.tabKey === key);
      equal(sessions.at(-1).endedAt, start + 60_000);
      equal(sessions.at(-1).durationMs, 60_000);
      equal(h.state().usageCoverage.segments.length, 1);
      equal(h.state().liveUsageRecords[h.key(2002)].currentSessionStartedAt, start + 60_000);
    } finally { await h.dispose(); }
  });

  test("unclean recorder reload and browser restart leave coverage gaps instead of offline foreground time", async () => {
    const h = await recorderHarness();
    try {
      const first = h.now();
      h.advance(1000); h.emit('alarm', { name: 'memory-saver-usage-checkpoint' }); await h.flush();
      h.advance(1000);
      await h.load();
      equal(h.state().usageSessions[0].endedAt, first + 1000);
      equal(h.state().usageCoverage.segments[0].endedAt, first + 1000);
      equal(h.state().usageCoverage.segments[1].startedAt, first + 2000);
      h.emit('suspend');
      h.advance(1000);
      await h.load({ resetSession: true });
      equal(h.state().usageCoverage.segments.at(-2).endedAt, first + 2000);
      equal(h.state().usageCoverage.segments.at(-1).startedAt, first + 3000);
      equal(h.state().usageTabMetadata[h.key(2001)].firstObservedAt, first);
    } finally { await h.dispose(); }
  });

  test("closed sleeping tabs keep history and restored/duplicated tabs get correct identities", async () => {
    const h = await recorderHarness();
    try {
      h.update(2002, { discarded: true }); await h.flush();
      const key = h.key(2002);
      const first = h.state().usageTabMetadata[key].firstObservedAt;
      h.advance(1000); h.close(2002); await h.flush();
      equal(h.state().usageDiscardEvents.length, 1);
      equal(h.state().usageTabMetadata[key].closedAt, h.now());
      h.create(makeTab(2020), 2002); await h.flush();
      equal(h.key(2020), key);
      equal(h.state().usageTabMetadata[key].firstObservedAt, first);
      h.create(makeTab(2030), 2020); await h.flush();
      equal(h.key(2030) !== key, true);
      equal(h.state().usageTabMetadata[h.key(2030)].firstObservedAt, h.now());
      await h.request({ type: 'CLEAR_USAGE_DATA' });
      equal(h.state().usageDiscardEvents, []);
      equal(h.state().usageSessions, []);
      equal(h.state().usageCoverage.segments.length, 1);
      equal(h.state().usageCoverage.recordingStartedAt, h.now());
      equal(Object.keys(h.state().usageTabMetadata).length, 3);
    } finally { await h.dispose(); }
  });
  test("moving a tab preserves its key and records the new window without a false activation", async () => {
    const h = await recorderHarness();
    try {
      const key = h.key(2001);
      h.advance(1000); h.emit('detached', 2001); await h.flush();
      h.tabs.find(t => t.id === 2001).windowId = 2;
      // Simulate an adoption that lost Firefox's stored extension tab value.
      delete h.values.get(2001).memorySaverTabKey;
      h.focus(2); await h.flush();
      h.emit('attached', 2001); await h.flush();
      equal(h.key(2001), key);
      equal(h.state().usageTabMetadata[key].windowId, 2);
      equal(h.state().liveUsageRecords[key].windowId, 2);
    } finally { await h.dispose(); }
  });

  test("queued events from a cleared history cannot repopulate the new history at the same timestamp", async () => {
    const h = await recorderHarness();
    try {
      const clearing = h.request({ type: 'CLEAR_USAGE_DATA' });
      h.update(2002, { discarded: true });
      await clearing;
      await h.flush();
      equal(h.state().usageDiscardEvents, []);
      equal(h.state().usageSessions, []);
      equal(h.state().usageCoverage.recordingStartedAt, h.now());
    } finally { await h.dispose(); }
  });

  test("upgrading an enabled legacy recorder preserves preferences but starts fresh history", async () => {
    const now = 20 * 86_400_000;
    const legacy = {
      schemaVersion: 1,
      settings: { ...DEFAULT_SETTINGS, usageTrackingEnabled: true, usageHistoryDays: 30 },
      usageSessions: [{ tabKey: 'legacy-a', startedAt: now - 4000, endedAt: now - 3000, durationMs: 1000, url: 'https://old.example' }],
      liveUsageRecords: { 'legacy-a': { tabKey: 'legacy-a', tabId: 2001, windowId: 1,
        currentSessionStartedAt: now - 2000, lastCheckpointAt: now - 1000, lastActivatedAt: now - 2000, currentUrl: 'https://site2001.example' } },
    };
    const h = await recorderHarness({ diskState: legacy, tabValues: { 2001: { memorySaverTabKey: 'legacy-a' } } });
    try {
      equal(h.state().schemaVersion, 2);
      equal(h.state().settings.usageHistoryDays, 30);
      equal(h.state().usageSessions, []);
      equal(h.state().usageCoverage.legacyHistory, false);
      equal(h.state().usageCoverage.recordingStartedAt, now);
      equal(h.state().usageTabMetadata['legacy-a'].lastActivationSource, null);
      equal(h.state().usageDiscardEvents, []);
    } finally { await h.dispose(); }
  });

  test("upgrading while recording is disabled removes legacy detailed data and keeps ordinary state", async () => {
    const h = await recorderHarness({ diskState: { schemaVersion: 1,
      settings: { ...DEFAULT_SETTINGS, usageTrackingEnabled: false }, lifetimeDiscardCount: 17,
      usageSessions: [{ tabKey: 'legacy-a', startedAt: 100, endedAt: 200 }],
      liveUsageRecords: { 'legacy-a': { tabKey: 'legacy-a', tabId: 2001, currentSessionStartedAt: 100 } },
    }, tabValues: { 2001: { memorySaverDoNotDiscard: true, memorySaverLastSleep: { discardedAt: 50, reason: 'manual-eligible' } } } });
    try {
      equal(h.state().usageSessions, []);
      equal(h.state().liveUsageRecords, {});
      equal(h.state().usageTabMetadata, {});
      equal(h.state().usageCoverage.recordingStartedAt, null);
      equal(h.state().lifetimeDiscardCount, 17);
      equal(h.values.get(2001).memorySaverDoNotDiscard, true);
      equal(h.values.get(2001).memorySaverLastSleep.discardedAt, 50);
    } finally { await h.dispose(); }
  });

}
