import { registerPopupTests } from "./popup.test.js";
import { registerHistoryTests } from "./history.test.js";
import { registerRecorderTests } from "./recorder.test.js";
import { registerActivityTests } from "./activity.test.js";
import { inspectEligibility, protectedHostname, protectionReasons, selectEligibleByWindow, selectEligibleTabs } from "../src/core/eligibility.js";
import { calculateScanInterval, DEFAULT_SETTINGS, normalizeDomain, normalizeSettings } from "../src/core/settings.js";
import { endLiveRecord, getTabKey, pruneUsage, recoverInterruptedUsage, releaseTabKey, usageSummaryForTab } from "../src/core/usage.js";

const tests = [];
const test = (name, callback) => tests.push({ name, callback });
const equal = (actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

function tab(overrides = {}) {
  return {
    id: 1,
    windowId: 1,
    url: "https://example.com/page",
    active: false,
    pinned: false,
    audible: false,
    discarded: false,
    lastAccessed: 0,
    ...overrides,
  };
}

test("normalizes domains and subdomain input", () => {
  equal(normalizeDomain(" HTTPS://Mail.Example.com/path "), "mail.example.com");
  equal(normalizeDomain("not a domain"), null);
});

test("repairs invalid settings conservatively", () => {
  const value = normalizeSettings({ inactivityMinutes: -10, scanIntervalMinutes: 900, protectedDomains: ["Example.com", "example.com"] });
  equal(value.inactivityMinutes, 5);
  equal(value.scanIntervalMinutes, 60);
  equal(value.protectedDomains, ["example.com"]);
  equal(normalizeSettings({ minimumLoadedTabsTotal: -1 }).minimumLoadedTabsTotal, 0);
  equal(normalizeSettings({ minimumLoadedTabsTotal: 2000 }).minimumLoadedTabsTotal, 100);
  equal(normalizeSettings({ minimumLoadedTabsTotal: 100 }).minimumLoadedTabsTotal, 100);
  equal(normalizeSettings({ usageHistoryDays: 365 }).usageHistoryDays, 365);
  equal(normalizeSettings({ usageHistoryDays: 366 }).usageHistoryDays, 365);
  equal(normalizeSettings({ minimumLoadedTabsTotal: 10 }).minimumLoadedTabsTotal, 10);
});

test("uses the MVP automatic-discard defaults", () => {
  equal(DEFAULT_SETTINGS.inactivityMinutes, 10);
  equal(DEFAULT_SETTINGS.scanIntervalMinutes, 1);
  equal(DEFAULT_SETTINGS.usageHistoryDays, 14);
  equal(DEFAULT_SETTINGS.usageTrackingEnabled, false);
  equal(normalizeSettings({}).usageHistoryDays, 14);
  equal(normalizeSettings({ usageHistoryDays: 7 }).usageHistoryDays, 7);
  equal(normalizeSettings({}).minimumLoadedTabsTotal, 0);
});

test("derives the scan interval by rounding up and capping it at 60 minutes", () => {
  equal(calculateScanInterval(5), 1);
  equal(calculateScanInterval(20), 1);
  equal(calculateScanInterval(21), 2);
  equal(calculateScanInterval(1200), 60);
  equal(calculateScanInterval(1440), 60);
});

test("protects active, pinned, audible, internal, and protected-domain tabs", () => {
  const settings = { ...DEFAULT_SETTINGS, protectedDomains: ["example.com"] };
  equal(inspectEligibility(tab({ active: true }), settings).reason, "active");
  equal(inspectEligibility(tab({ pinned: true }), settings).reason, "pinned");
  equal(inspectEligibility(tab({ audible: true }), settings).reason, "audible");
  equal(inspectEligibility(tab({ url: "about:config" }), settings).reason, "unsupported-url");
  equal(inspectEligibility(tab({ url: "https://news.example.com" }), settings).reason, "protected-domain");
  equal(inspectEligibility(tab({ memorySaverProtected: true }), DEFAULT_SETTINGS).reason, "protected-tab");
});

test("matches protected domains including their subdomains", () => {
  equal(protectedHostname("https://news.example.com/story", ["example.com"]), "news.example.com");
  equal(protectedHostname("https://notexample.com", ["example.com"]), null);
  equal(protectedHostname("about:config", ["example.com"]), null);
});

test("identifies durable and rule-based tab protections", () => {
  const settings = { ...DEFAULT_SETTINGS, protectedDomains: ["example.com"] };
  equal(protectionReasons(tab({ memorySaverProtected: true, pinned: true }), settings), [
    { type: "tab" },
    { type: "pinned" },
    { type: "domain", domain: "example.com" },
  ]);
  equal(protectionReasons(tab({ audible: true, url: "about:config" }), settings), [
    { type: "audible" },
    { type: "special-page" },
  ]);
  equal(protectionReasons(tab({ discarded: true, memorySaverProtected: true }), settings), []);
});

test("applies inactivity threshold", () => {
  const now = 10_000_000;
  const settings = { ...DEFAULT_SETTINGS, inactivityMinutes: 60 };
  equal(inspectEligibility(tab({ lastAccessed: now - 59 * 60_000 }), settings, now).reason, "recently-active");
  equal(inspectEligibility(tab({ lastAccessed: now - 60 * 60_000 }), settings, now).eligible, true);
});

test("keeps inactive tabs in addition to the active tab and chooses oldest first", () => {
  const settings = { ...DEFAULT_SETTINGS, minimumLoadedTabsPerWindow: 2 };
  const selected = selectEligibleTabs([
    tab({ id: 1, lastAccessed: 300 }),
    tab({ id: 2, lastAccessed: 100 }),
    tab({ id: 3, lastAccessed: 200 }),
    tab({ id: 4, active: true, lastAccessed: 400 }),
  ], settings, 10_000_000, { ignoreInactivity: true });
  equal(selected.map((item) => item.id), [2]);
});

test("respects global and per-window minimums of inactive unprotected tabs", () => {
  const settings = { ...DEFAULT_SETTINGS, minimumLoadedTabsPerWindow: 2, minimumLoadedTabsTotal: 5 };
  const tabs = [
    tab({ id: 1, windowId: 1, lastAccessed: 10 }),
    tab({ id: 2, windowId: 1, lastAccessed: 20 }),
    tab({ id: 3, windowId: 1, active: true, lastAccessed: 50 }),
    tab({ id: 4, windowId: 2, lastAccessed: 5 }),
    tab({ id: 5, windowId: 2, lastAccessed: 30 }),
    tab({ id: 6, windowId: 2, active: true, lastAccessed: 60 }),
    tab({ id: 7, windowId: 2, discarded: true, lastAccessed: 1 }),
    tab({ id: 8, windowId: 1, lastAccessed: 40 }),
    tab({ id: 9, windowId: 2, lastAccessed: 45 }),
  ];
  const options = { ignoreInactivity: true };
  equal(selectEligibleByWindow(tabs, settings, 100, options).map((item) => item.id), [4]);
  equal(selectEligibleByWindow(tabs, { ...settings, minimumLoadedTabsTotal: 4 }, 100, options).map((item) => item.id), [4, 1]);
  equal(selectEligibleByWindow(tabs, { ...settings, minimumLoadedTabsTotal: 0 }, 100, options).map((item) => item.id), [4, 1]);
  equal(selectEligibleByWindow(tabs, { ...settings, minimumLoadedTabsTotal: 6 }, 100, options), []);
});

test("scoped discards count inactive unprotected tabs in other windows", () => {
  const settings = { ...DEFAULT_SETTINGS, minimumLoadedTabsPerWindow: 1, minimumLoadedTabsTotal: 3 };
  const tabs = [
    tab({ id: 1, windowId: 1, lastAccessed: 20 }),
    tab({ id: 2, windowId: 1, lastAccessed: 30 }),
    tab({ id: 3, windowId: 1, active: true, lastAccessed: 50 }),
    tab({ id: 4, windowId: 2, active: true, lastAccessed: 40 }),
    tab({ id: 5, windowId: 2, discarded: true, lastAccessed: 1 }),
    tab({ id: 6, windowId: 2, lastAccessed: 10 }),
    tab({ id: 7, windowId: 2, lastAccessed: 15 }),
  ];
  equal(selectEligibleByWindow(tabs, settings, 100, { ignoreInactivity: true, windowId: 1 }).map((item) => item.id), [1]);
  equal(selectEligibleByWindow(tabs, settings, 100, { ignoreInactivity: true, windowId: 2 }).map((item) => item.id), [6]);
});

test("zero per-window minimum retains active tabs and respects the total minimum", () => {
  const tabs = [
    tab({ id: 1, windowId: 1, active: true, lastAccessed: 10 }),
    tab({ id: 2, windowId: 1, lastAccessed: 20 }),
    tab({ id: 3, windowId: 2, active: true, lastAccessed: 30 }),
    tab({ id: 4, windowId: 2, lastAccessed: 40 }),
  ];
  const settings = normalizeSettings({ minimumLoadedTabsPerWindow: 0, minimumLoadedTabsTotal: 1 });
  equal(settings.minimumLoadedTabsPerWindow, 0);
  equal(selectEligibleByWindow(tabs, settings, 100, { ignoreInactivity: true }).map((item) => item.id), [2]);
  equal(selectEligibleByWindow(tabs, { ...settings, minimumLoadedTabsTotal: 0 }, 100, { ignoreInactivity: true }).map((item) => item.id), [2, 4]);
});

test("every protection type is excluded from both minimum counts", () => {
  const settings = { ...DEFAULT_SETTINGS, minimumLoadedTabsPerWindow: 1, minimumLoadedTabsTotal: 1, protectedDomains: ["protected.example"] };
  const tabs = [
    tab({ id: 1, active: true }),
    tab({ id: 2, pinned: true }),
    tab({ id: 3, audible: true }),
    tab({ id: 4, memorySaverProtected: true }),
    tab({ id: 5, url: "https://protected.example" }),
    tab({ id: 6, url: "about:config" }),
    tab({ id: 7, discarded: true }),
    tab({ id: 8, lastAccessed: 10 }),
  ];
  equal(selectEligibleByWindow(tabs, settings, 100, { ignoreInactivity: true }), []);
  tabs.push(tab({ id: 9, lastAccessed: 20 }));
  equal(selectEligibleByWindow(tabs, settings, 100, { ignoreInactivity: true }).map((item) => item.id), [8]);
});

test("recent inactive tabs count toward the minimum during automatic scans", () => {
  const now = 10_000_000;
  const settings = { ...DEFAULT_SETTINGS, inactivityMinutes: 5, minimumLoadedTabsPerWindow: 2 };
  const tabs = [
    tab({ id: 1, active: true, lastAccessed: now }),
    tab({ id: 2, lastAccessed: now - 1_000 }),
    tab({ id: 3, lastAccessed: now - 400_000 }),
    tab({ id: 4, lastAccessed: now - 500_000 }),
  ];
  equal(selectEligibleByWindow(tabs, settings, now).map((item) => item.id), [4]);
});

test("switching tabs does not let protected tabs satisfy the inactive minimum", () => {
  const settings = { ...DEFAULT_SETTINGS, minimumLoadedTabsPerWindow: 2 };
  const tabs = [
    tab({ id: 1, active: true }),
    tab({ id: 2, discarded: true }),
    tab({ id: 3, memorySaverProtected: true }),
  ];
  equal(selectEligibleByWindow(tabs, settings, 100, { ignoreInactivity: true }), []);
  tabs[0].active = false;
  tabs[1].active = true;
  tabs[1].discarded = false;
  equal(selectEligibleByWindow(tabs, settings, 100, { ignoreInactivity: true }), []);
});

test("ends usage sessions with non-negative durations", () => {
  const state = { usageSessions: [] };
  const record = { tabKey: "a", tabId: 1, windowId: 2, currentSessionStartedAt: 100, totalActiveMs: 0, currentUrl: "https://example.com", currentTitle: "Example" };
  endLiveRecord(state, record, 50, "tab-switch");
  equal(state.usageSessions[0].durationMs, 0);
});

test("recovers open sessions only through their last checkpoint", () => {
  const state = {
    usageSessions: [],
    liveUsageRecords: {
      a: { tabKey: "a", tabId: 1, windowId: 1, currentSessionStartedAt: 100, lastCheckpointAt: 250, totalActiveMs: 0 },
    },
  };
  recoverInterruptedUsage(state);
  equal(state.usageSessions[0].durationMs, 150);
});

test("prunes expired usage sessions", () => {
  const now = 10 * 86_400_000;
  const state = {
    settings: { usageHistoryDays: 2 },
    usageSessions: [
      { endedAt: now - 3 * 86_400_000 },
      { endedAt: now - 86_400_000 },
    ],
  };
  pruneUsage(state, now);
  equal(state.usageSessions.length, 1);
});

test("usage summary limits completed and ongoing sessions to the history window", () => {
  const day = 86_400_000;
  const now = 10 * day;
  const state = {
    settings: { usageHistoryDays: 2 },
    usageSessions: [
      { tabKey: "a", startedAt: 7 * day, endedAt: 8.5 * day },
      { tabKey: "a", startedAt: 9 * day, endedAt: 9.25 * day },
      { tabKey: "b", startedAt: 9 * day, endedAt: now },
    ],
    liveUsageRecords: { a: { currentSessionStartedAt: 9.5 * day } },
  };
  equal(usageSummaryForTab(state, "a", now).totalActiveMs, 1.25 * day);
});

test("duplicate tab identities are separated while restored identities are retained", async () => {
  const values = new Map([[101, "original"], [102, "original"], [103, "restored"]]);
  globalThis.browser = { sessions: {
    async getTabValue(id) { return values.get(id); },
    async setTabValue(id, _key, value) { values.set(id, value); },
  } };
  try {
    equal(await getTabKey(101, false), "original");
    const duplicateKey = await getTabKey(102, false);
    equal(duplicateKey !== "original", true);
    equal(values.get(102), duplicateKey);
    const state = {
      settings: { usageHistoryDays: 1 },
      liveUsageRecords: {},
      usageSessions: [{ tabKey: "original", startedAt: 100, endedAt: 200 }],
    };
    equal(usageSummaryForTab(state, "original", 300).totalActiveMs, 100);
    equal(usageSummaryForTab(state, duplicateKey, 300).totalActiveMs, 0);
    equal(await getTabKey(103, false), "restored");
    releaseTabKey(103);
    values.set(104, "restored");
    equal(await getTabKey(104, false), "restored");
    equal(await getTabKey(105, false), undefined);
  } finally {
    for (const id of [101, 102, 103, 104, 105]) releaseTabKey(id);
    delete globalThis.browser;
  }
});

registerActivityTests(test, equal);

test("background module loads against the Firefox API contract", async () => {
  const event = { addListener() {} };
  let onMessage;
  let queriedTabs = [];
  const refusedIds = new Set();
  const failedIds = new Set();
  const alarms = [];
  globalThis.browser = {
    storage: {
      local: { async get() { return {}; }, async set() {}, async remove() {} },
      session: { async get() { return {}; }, async set() {}, async remove() {} },
    },
    alarms: { async clear() {}, create(name, options) { alarms.push({ name, ...options }); }, onAlarm: event },
    runtime: { onMessage: { addListener(listener) { onMessage = listener; } }, onInstalled: event },
    tabs: {
      async query(query = {}) {
        return queriedTabs.filter((item) => query.active == null || item.active === query.active);
      },
      async get(id) { return queriedTabs.find((item) => item.id === id); },
      async discard(id) {
        if (failedIds.has(id)) throw new Error("Simulated API error");
        if (!refusedIds.has(id)) queriedTabs.find((item) => item.id === id).discarded = true;
      },
      async update() {},
      async remove() {},
      onActivated: event,
      onCreated: event,
      onUpdated: event,
      onRemoved: event,
      onReplaced: event,
    },
    windows: {
      WINDOW_ID_NONE: -1,
      async get() { return { focused: false }; },
      onFocusChanged: event,
      onRemoved: event,
    },
    sessions: {
      async getTabValue() { return null; },
      async setTabValue() {},
      async removeTabValue() {},
    },
    menus: {
      async removeAll() {},
      create() {},
      async update() {},
      async refresh() {},
      onShown: event,
      onClicked: event,
    },
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values);
  try {
    await import("../src/background/index.js");
    equal((await onMessage({ type: "GET_SETTINGS" })).ok, true);
    const saved = await onMessage({ type: "SAVE_SETTINGS", settings: { ...DEFAULT_SETTINGS, inactivityMinutes: 21 } });
    equal(saved.data.scanIntervalMinutes, 2);
    equal(alarms.filter((alarm) => alarm.name === "memory-saver-scan").at(-1).periodInMinutes, 2);
    queriedTabs = [
      tab({ id: 1, active: true, lastAccessed: Date.now() }),
      tab({ id: 2, lastAccessed: Date.now() }),
      tab({ id: 3, lastAccessed: Date.now() }),
      tab({ id: 4, pinned: true }),
      tab({ id: 5, discarded: true }),
      tab({ id: 6, lastAccessed: Date.now() }),
      tab({ id: 7, lastAccessed: Date.now() }),
    ];
    equal((await onMessage({ type: "GET_POPUP_STATE" })).data.eligibleDiscardCount, 2);
    equal((await onMessage({ type: "DISCARD_ELIGIBLE_NOW" })).data, { discardedTabIds: [2, 3], refusedCount: 0, failedCount: 0 });
    equal((await onMessage({ type: "GET_POPUP_STATE" })).data.eligibleDiscardCount, 0);
    for (const item of queriedTabs.filter((item) => [2, 3].includes(item.id))) item.discarded = false;
    refusedIds.add(2);
    equal((await onMessage({ type: "DISCARD_ELIGIBLE_NOW" })).data, { discardedTabIds: [3], refusedCount: 1, failedCount: 0 });
    queriedTabs.find((item) => item.id === 3).discarded = false;
    refusedIds.add(3);
    equal((await onMessage({ type: "DISCARD_ELIGIBLE_NOW" })).data, { discardedTabIds: [], refusedCount: 2, failedCount: 0 });
    refusedIds.clear();
    failedIds.add(2);
    failedIds.add(3);
    const originalWarn = console.warn;
    try {
      console.warn = () => {};
      equal((await onMessage({ type: "DISCARD_ELIGIBLE_NOW" })).data, { discardedTabIds: [], refusedCount: 0, failedCount: 2 });
    } finally {
      console.warn = originalWarn;
    }
    equal(errors.length, 0);
  } finally {
    console.error = originalError;
    delete globalThis.browser;
  }
});

registerRecorderTests(test, equal);
registerHistoryTests(test, equal);
registerPopupTests(test, equal);

const results = document.querySelector("#results");
let failures = 0;
for (const { name, callback } of tests) {
  const item = document.createElement("li");
  try {
    await callback();
    item.textContent = `PASS — ${name}`;
    item.className = "pass";
  } catch (error) {
    failures += 1;
    item.textContent = `FAIL — ${name}: ${error.message}`;
    item.className = "fail";
  }
  results.append(item);
}
const summary = document.querySelector("#summary");
summary.textContent = failures ? `${failures} of ${tests.length} tests failed` : `All ${tests.length} tests passed`;
summary.className = failures ? "fail" : "pass";
document.title = failures ? "FAIL — Memory Saver tests" : "PASS — Memory Saver tests";
