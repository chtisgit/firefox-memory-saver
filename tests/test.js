import { inspectEligibility, selectEligibleTabs } from "../src/core/eligibility.js";
import { DEFAULT_SETTINGS, normalizeDomain, normalizeSettings } from "../src/core/settings.js";
import { endLiveRecord, pruneUsage, recoverInterruptedUsage } from "../src/core/usage.js";

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
});

test("uses the MVP automatic-discard defaults", () => {
  equal(DEFAULT_SETTINGS.inactivityMinutes, 10);
  equal(DEFAULT_SETTINGS.scanIntervalMinutes, 3);
});

test("protects active, pinned, audible, internal, and protected-domain tabs", () => {
  const settings = { ...DEFAULT_SETTINGS, protectedDomains: ["example.com"] };
  equal(inspectEligibility(tab({ active: true }), settings).reason, "active");
  equal(inspectEligibility(tab({ pinned: true }), settings).reason, "pinned");
  equal(inspectEligibility(tab({ audible: true }), settings).reason, "audible");
  equal(inspectEligibility(tab({ url: "about:config" }), settings).reason, "unsupported-url");
  equal(inspectEligibility(tab({ url: "https://news.example.com" }), settings).reason, "protected-domain");
});

test("applies inactivity threshold", () => {
  const now = 10_000_000;
  const settings = { ...DEFAULT_SETTINGS, inactivityMinutes: 60 };
  equal(inspectEligibility(tab({ lastAccessed: now - 59 * 60_000 }), settings, now).reason, "recently-active");
  equal(inspectEligibility(tab({ lastAccessed: now - 60 * 60_000 }), settings, now).eligible, true);
});

test("keeps the minimum loaded tab budget and chooses oldest first", () => {
  const settings = { ...DEFAULT_SETTINGS, minimumLoadedTabsPerWindow: 2 };
  const selected = selectEligibleTabs([
    tab({ id: 1, lastAccessed: 300 }),
    tab({ id: 2, lastAccessed: 100 }),
    tab({ id: 3, lastAccessed: 200 }),
    tab({ id: 4, active: true, lastAccessed: 400 }),
  ], settings, 10_000_000, { ignoreInactivity: true });
  equal(selected.map((item) => item.id), [2, 3]);
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

test("background module loads against the Firefox API contract", async () => {
  const event = { addListener() {} };
  globalThis.browser = {
    storage: { local: { async get() { return {}; }, async set() {} } },
    alarms: { async clear() {}, create() {}, onAlarm: event },
    runtime: { onMessage: event },
    tabs: {
      async query() { return []; },
      async remove() {},
      onActivated: event,
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
    },
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values);
  try {
    await import("../src/background/index.js");
    equal(errors.length, 0);
  } finally {
    console.error = originalError;
    delete globalThis.browser;
  }
});

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
