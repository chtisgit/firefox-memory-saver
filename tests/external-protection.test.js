import { recorderHarness, makeTab } from "./recorder.test.js";
import { EXTERNAL_PROTECTION_ALARM } from "../src/core/external-protection.js";

const protect = (tabId, timeoutSeconds = 3600) => ({ apiVersion: 1, type: "set-protected-tab", tabId, timeoutSeconds });
const releaseAll = () => ({ apiVersion: 1, type: "release-all-protected-tabs" });
const release = tabId => ({ apiVersion: 1, type: "release-protected-tab", tabId });
const popup = (h) => h.request({ type: "GET_POPUP_STATE", targetTabId: 2002 });

export function registerExternalProtectionTests(test, equal) {
  test("a temporary lease-read failure does not abort startup and is retried before discarding", async () => {
    const h = await recorderHarness();
    try {
      await h.external(protect(2002));
      h.alarms.clear();
      h.leaseReadFailures.push(new Error("Temporary session read failure"));
      await h.load();
      equal(h.alarms.has("memory-saver-scan"), true);
      equal(h.alarms.has("memory-saver-usage-checkpoint"), true);
      equal(h.warnings.length, 1);
      equal((await h.request({ type: "DISCARD_ELIGIBLE_NOW" })).discardedTabIds, []);
      equal((await popup(h)).protectedTabs.map(t => t.id), [2002]);
    } finally { await h.dispose(); }
  });

  test("disabling after a failed startup read clears stored leases before re-enabling", async () => {
    const h = await recorderHarness({ enabled: false });
    try {
      await h.external(protect(2002));
      h.leaseReadFailures.push(new Error("Temporary session read failure"));
      await h.load();
      await h.request({ type: "SAVE_SETTINGS", settings: { ...h.state().settings, allowExternalProtection: false } });
      await h.request({ type: "SAVE_SETTINGS", settings: { ...h.state().settings, allowExternalProtection: true } });
      equal((await popup(h)).protectedTabs, []);
      equal((await popup(h)).eligibleDiscardCount, 1);
    } finally { await h.dispose(); }
  });

  test("native storage errors return a valid INTERNAL_ERROR without changing accepted leases", async () => {
    const h = await recorderHarness();
    try {
      await h.external(protect(2002));
      const previous = (await popup(h)).currentTab.protectionReasons;
      const failure = Object.assign(new Error("Simulated quota failure"), { code: 22 });
      h.leaseWriteFailures.push(failure);
      const response = await h.external(protect(2002, 60));
      equal(response.ok, false);
      equal(response.error.code, "INTERNAL_ERROR");
      equal(typeof response.error.message, "string");
      equal((await popup(h)).currentTab.protectionReasons, previous);
      equal((await h.external(protect(2002, 60))).ok, true);
    } finally { await h.dispose(); }
  });

  test("tab-close bookkeeping continues if persisting external lease removal fails", async () => {
    const h = await recorderHarness({ tabs: [makeTab(2001, { active: true }), makeTab(2002), makeTab(2003)] });
    try {
      h.activate(2002); await h.flush();
      await h.external(protect(2002));
      await h.external(protect(2003));
      const originalKey = h.key(2002);
      h.advance(1000);
      h.leaseWriteFailures.push(new Error("Simulated session-storage write failure"));
      h.close(2002); await h.flush();
      equal(h.state().usageTabMetadata[originalKey].closedAt, h.now());
      h.values.delete(2002);
      h.create(makeTab(2002)); await h.flush();
      equal(h.key(2002) !== originalKey, true);
      equal((await popup(h)).protectedTabs.map(t => t.id), [2003]);
      equal(h.warnings.length, 1);
      await h.load(); // The old persisted lease must not attach to the reused ID.
      equal((await popup(h)).protectedTabs.map(t => t.id), [2003]);
    } finally { await h.dispose(); }
  });

  test("upgrading older saved settings enables the API without replacing existing preferences", async () => {
    const h = await recorderHarness({ diskState: { settings: {
      enabled: false, inactivityMinutes: 45, usageTrackingEnabled: false,
      minimumLoadedTabsPerWindow: 3, protectedDomains: ["keep.example"],
    } } });
    try {
      equal(h.state().settings.allowExternalProtection, true);
      equal(h.state().settings.inactivityMinutes, 45);
      equal(h.state().settings.minimumLoadedTabsPerWindow, 3);
      equal(h.state().settings.protectedDomains, ["keep.example"]);
      equal((await h.external(protect(2002))).ok, true);
    } finally { await h.dispose(); }
  });

  test("disabling the API clears external leases, preserves manual protection, and persists across restart", async () => {
    const h = await recorderHarness({ enabled: false });
    try {
      await h.external(protect(2002));
      await h.external(protect(2002), "second@example.org");
      await h.request({ type: "TOGGLE_TAB_PROTECTION", tabId: 2002 });
      const saved = await h.request({ type: "SAVE_SETTINGS", settings: { ...h.state().settings, allowExternalProtection: false } });
      equal(saved.allowExternalProtection, false);
      equal((await popup(h)).currentTab.protectionReasons, [{ type: "tab" }]);
      equal(h.alarms.has(EXTERNAL_PROTECTION_ALARM), false);
      for (const message of [{ apiVersion: 1, type: "get-api-info" }, protect(2002), releaseAll()]) {
        equal((await h.external(message)).error.code, "API_DISABLED");
      }
      equal(h.apiLogs.at(-1)[1].request, releaseAll());
      await h.load();
      equal(h.state().settings.allowExternalProtection, false);
      equal((await h.external(protect(2002))).error.code, "API_DISABLED");
      await h.request({ type: "SAVE_SETTINGS", settings: { ...h.state().settings, allowExternalProtection: true } });
      equal((await popup(h)).currentTab.protectionReasons, [{ type: "tab" }]);
      await h.request({ type: "TOGGLE_TAB_PROTECTION", tabId: 2002 });
      equal((await popup(h)).eligibleDiscardCount, 1);
      equal((await h.external(protect(2002))).ok, true);
      equal((await popup(h)).eligibleDiscardCount, 0);
    } finally { await h.dispose(); }
  });

  test("every external API request is logged with its actual sender, including rejected requests", async () => {
    const h = await recorderHarness({ enabled: false });
    try {
      const requests = [
        { apiVersion: 1, type: "get-api-info" },
        protect(2002),
        protect(2002, 60),
        releaseAll(),
        { apiVersion: 1, type: "unknown-request", senderId: "spoofed@example.org" },
      ];
      for (const request of requests) await h.external(request, "client@example.org");
      await h.external(null, null);
      equal(h.apiLogs, [
        ...requests.map(request => ["Memory Saver external API request", { senderId: "client@example.org", request }]),
        ["Memory Saver external API request", { senderId: null, request: null }],
      ]);
    } finally { await h.dispose(); }
  });

  test("external API discovers protocol support without exposing internal actions", async () => {
    const h = await recorderHarness({ enabled: false });
    try {
      equal(await h.external({ apiVersion: 1, type: "get-api-info" }), {
        ok: true, data: { apiVersion: 1, maxTimeoutSeconds: 3600 },
      });
      equal((await h.external({ apiVersion: 1, type: "DISCARD_ELIGIBLE_NOW" })).error.code, "UNKNOWN_REQUEST");
      equal((await popup(h)).eligibleDiscardCount, 1);
    } finally { await h.dispose(); }
  });

  test("external leases block manual and automatic discards even when recording is disabled", async () => {
    const h = await recorderHarness({ enabled: false });
    try {
      const expiresAt = h.now() + 3600000;
      equal(await h.external(protect(2002)), { ok: true, data: { apiVersion: 1, tabId: 2002, expiresAt } });
      const view = await popup(h);
      equal(view.eligibleDiscardCount, 0);
      equal(view.currentTab.protectionReasons, [{ type: "extension", extensionId: "sidebar@example.org", expiresAt }]);
      equal(view.protectedTabs.map(t => t.id), [2002]);
      equal(h.alarms.get(EXTERNAL_PROTECTION_ALARM), { when: expiresAt });
      equal((await h.request({ type: "DISCARD_ELIGIBLE_NOW" })).discardedTabIds, []);
      h.emit('alarm', { name: 'memory-saver-scan' }); await h.flush();
      equal(h.tabs.find(t => t.id === 2002).discarded, false);
      // This API does not take ownership of the browser's shared native flag.
      equal(h.tabs.find(t => t.id === 2002).autoDiscardable, true);
      equal(h.state().usageTabMetadata, {});
      equal(h.notifications.some(n => n.type === 'EXTERNAL_PROTECTION_CHANGED'), true);
    } finally { await h.dispose(); }
  });

  test("external API rejects invalid senders, versions, targets, and timeouts without changing protection", async () => {
    const h = await recorderHarness();
    try {
      await h.external(protect(2002));
      equal((await h.external(protect(2002), null)).error.code, "INVALID_SENDER");
      equal((await h.external(protect(2002), "@firefox-memory-saver-hero")).error.code, "INVALID_SENDER");
      equal((await h.external({ ...protect(2002), apiVersion: 2 })).error.code, "UNSUPPORTED_API_VERSION");
      equal((await h.external(null)).error.code, "UNSUPPORTED_API_VERSION");
      for (const timeout of [null, 0, -1, 3601, 1.5, "60", Infinity]) {
        equal((await h.external(protect(2002, timeout))).error.code, "INVALID_TIMEOUT");
      }
      equal((await h.external({ apiVersion: 1, type: "set-protected-tab", tabId: 2002 })).error.code, "INVALID_TIMEOUT");
      for (const id of [undefined, -1, 1.5, "2002"]) {
        equal((await h.external(protect(id))).error.code, "INVALID_TAB_ID");
      }
      equal((await h.external(protect(9999))).error.code, "TAB_NOT_FOUND");
      equal((await popup(h)).eligibleDiscardCount, 0);
      equal((await popup(h)).currentTab.protectionReasons.length, 1);
    } finally { await h.dispose(); }
  });

  test("renewing replaces only one deadline and protecting another tab preserves existing leases", async () => {
    const h = await recorderHarness({ tabs: [makeTab(2001, { active: true }), makeTab(2002), makeTab(2003)] });
    try {
      await h.external(protect(2002, 60));
      h.advance(30000);
      equal((await h.external(protect(2002, 60))).data.expiresAt, h.now() + 60000);
      h.advance(30000);
      equal((await popup(h)).eligibleDiscardCount, 1);
      await h.external(protect(2003, 120));
      equal((await popup(h)).protectedTabs.map(t => t.id), [2002, 2003]);
      equal((await popup(h)).eligibleDiscardCount, 0);
      equal((await h.request({ type: 'DISCARD_ELIGIBLE_NOW' })).discardedTabIds, []);
      equal((await h.external(protect(9999))).error.code, 'TAB_NOT_FOUND');
      equal((await popup(h)).protectedTabs.map(t => t.id), [2002, 2003]);
      h.advance(30000); // The renewed tab 2002 reaches its own deadline.
      equal((await popup(h)).protectedTabs.map(t => t.id), [2003]);
      equal((await h.request({ type: 'DISCARD_ELIGIBLE_NOW' })).discardedTabIds, [2002]);
      equal(h.tabs.find(t => t.id === 2003).discarded, false);
    } finally { await h.dispose(); }
  });

  test("owners cannot release each other's leases or manual protection", async () => {
    const h = await recorderHarness();
    try {
      await h.request({ type: 'TOGGLE_TAB_PROTECTION', tabId: 2002 });
      await h.external(protect(2002), 'first@example.org');
      await h.external(protect(2002), 'second@example.org');
      // An owner field in the payload cannot impersonate the sender.
      await h.external({ ...releaseAll(), extensionId: 'second@example.org' }, 'first@example.org');
      const reasons = (await popup(h)).currentTab.protectionReasons;
      equal(reasons.map(r => r.type), ['tab', 'extension']);
      equal(reasons[1].extensionId, 'second@example.org');
      await h.external(releaseAll(), 'second@example.org');
      equal((await popup(h)).currentTab.protectionReasons, [{ type: 'tab' }]);
      equal(h.alarms.has(EXTERNAL_PROTECTION_ALARM), false);
      equal((await h.external(releaseAll())).data, { apiVersion: 1, releasedTabIds: [] });
    } finally { await h.dispose(); }
  });

  test("per-tab release and release-all affect only the caller's requested leases", async () => {
    const h = await recorderHarness({ tabs: [makeTab(2001, { active: true }), makeTab(2002), makeTab(2003), makeTab(2004)] });
    try {
      await h.external(protect(2002));
      await h.external(protect(2003));
      await h.external(protect(2004));
      await h.external(protect(2002), "other@example.org");
      equal((await h.external(release(2003))).data, { apiVersion: 1, tabId: 2003, expiresAt: null });
      equal((await popup(h)).protectedTabs.map(t => t.id), [2002, 2004]);
      equal((await h.external(release(2003))).ok, true);
      equal((await h.external(release(9999))).ok, true);
      equal((await h.external(release(null))).error.code, "INVALID_TAB_ID");
      equal((await h.external({ apiVersion: 1, type: "set-protected-tab", tabId: null })).error.code, "INVALID_TAB_ID");
      equal((await h.external(releaseAll())).data, { apiVersion: 1, releasedTabIds: [2002, 2004] });
      equal((await popup(h)).protectedTabs.map(t => t.id), [2002]);
      equal((await popup(h)).currentTab.protectionReasons.map(r => r.extensionId), ["other@example.org"]);
    } finally { await h.dispose(); }
  });

  test("multiple leases for one owner survive restart and closing one tab preserves the others", async () => {
    const h = await recorderHarness({ enabled: false, tabs: [makeTab(2001, { active: true }), makeTab(2002), makeTab(2003)] });
    try {
      await h.external(protect(2002, 1));
      await h.external(protect(2003, 60));
      await h.load();
      equal((await popup(h)).protectedTabs.map(t => t.id), [2002, 2003]);
      h.close(2002); await h.flush();
      equal((await popup(h)).protectedTabs.map(t => t.id), [2003]);
      equal(h.alarms.get(EXTERNAL_PROTECTION_ALARM), { when: h.now() + 60000 });
      await h.external(protect(2001, 1));
      h.advance(1000);
      h.emit('alarm', { name: EXTERNAL_PROTECTION_ALARM }); await h.flush();
      equal((await popup(h)).protectedTabs.map(t => t.id), [2003]);
      equal((await h.request({ type: 'DISCARD_ELIGIBLE_NOW' })).discardedTabIds, []);
    } finally { await h.dispose(); }
  });

  test("expired leases stop affecting eligibility even without an alarm", async () => {
    const h = await recorderHarness();
    try {
      await h.external(protect(2002, 1));
      h.advance(999);
      equal((await popup(h)).eligibleDiscardCount, 0);
      h.advance(1);
      equal((await popup(h)).eligibleDiscardCount, 1);
      equal((await popup(h)).protectedTabs, []);
      equal(h.tabs.find(t => t.id === 2002).discarded, false);
      equal(h.alarms.has(EXTERNAL_PROTECTION_ALARM), false);
      equal((await h.request({ type: 'DISCARD_ELIGIBLE_NOW' })).discardedTabIds, [2002]);
    } finally { await h.dispose(); }
  });

  test("expiry alarm removes only expired owners and schedules the next deadline without discarding", async () => {
    const h = await recorderHarness();
    try {
      await h.external(protect(2002, 1), 'first@example.org');
      await h.external(protect(2002, 60), 'second@example.org');
      h.advance(1000);
      h.emit('alarm', { name: EXTERNAL_PROTECTION_ALARM }); await h.flush();
      equal((await popup(h)).currentTab.protectionReasons.map(r => r.extensionId), ['second@example.org']);
      equal(h.alarms.get(EXTERNAL_PROTECTION_ALARM), { when: h.now() + 59000 });
      equal(h.tabs.find(t => t.id === 2002).discarded, false);
    } finally { await h.dispose(); }
  });

  test("external protections are additional to the keep-loaded minimums", async () => {
    const h = await recorderHarness({ tabs: [makeTab(2001, { active: true }), makeTab(2002), makeTab(2003), makeTab(2004)] });
    try {
      await h.request({ type: 'SAVE_SETTINGS', settings: { ...h.state().settings, minimumLoadedTabsPerWindow: 1, minimumLoadedTabsTotal: 1 } });
      await h.external(protect(2002));
      equal((await popup(h)).eligibleDiscardCount, 1);
      equal((await h.request({ type: 'DISCARD_ELIGIBLE_NOW' })).discardedTabIds, [2003]);
      equal(h.tabs.filter(t => !t.discarded).map(t => t.id), [2001, 2002, 2004]);
    } finally { await h.dispose(); }
  });

  test("leases survive background restart but not a browser-session reset, and never transfer to duplicates", async () => {
    const h = await recorderHarness({ enabled: false });
    try {
      await h.external(protect(2002));
      h.create(makeTab(2003), 2002); await h.flush();
      equal((await popup(h)).protectedTabs.map(t => t.id), [2002]);
      await h.load();
      equal((await popup(h)).protectedTabs.map(t => t.id), [2002]);
      await h.load({ resetSession: true });
      equal((await popup(h)).protectedTabs, []);
    } finally { await h.dispose(); }
  });

  test("closing or replacing a tab clears its lease and reused IDs do not inherit it", async () => {
    const h = await recorderHarness({ enabled: false });
    try {
      await h.external(protect(2002));
      h.close(2002); await h.flush();
      h.values.delete(2002);
      h.create(makeTab(2002)); await h.flush();
      equal((await popup(h)).eligibleDiscardCount, 1);
      await h.external(protect(2002));
      h.tabs.splice(h.tabs.findIndex(t => t.id === 2002), 1);
      h.create(makeTab(2003));
      h.emit('replaced', 2003, 2002); await h.flush();
      equal((await popup(h)).protectedTabs, []);
      equal(h.alarms.has(EXTERNAL_PROTECTION_ALARM), false);
    } finally { await h.dispose(); }
  });

  test("clearing history and disabling automatic discarding do not remove an external lease", async () => {
    const h = await recorderHarness();
    try {
      await h.external(protect(2002));
      await h.request({ type: 'CLEAR_USAGE_DATA' });
      await h.request({ type: 'SAVE_SETTINGS', settings: { ...h.state().settings, enabled: false, usageTrackingEnabled: false } });
      equal((await popup(h)).eligibleDiscardCount, 0);
      equal((await popup(h)).protectedTabs.map(t => t.id), [2002]);
      await h.external(releaseAll());
      equal((await popup(h)).eligibleDiscardCount, 1);
      equal((await h.request({ type: 'DISCARD_ELIGIBLE_NOW' })).discardedTabIds, [2002]);
    } finally { await h.dispose(); }
  });

  test("already sleeping tabs cannot acquire a lease and expiry is checked on background restart", async () => {
    const h = await recorderHarness({ enabled: false, tabs: [makeTab(2001, { active: true }), makeTab(2002), makeTab(2003, { discarded: true })] });
    try {
      await h.external(protect(2002, 1));
      equal((await h.external(protect(2003))).error.code, 'TAB_DISCARDED');
      equal((await popup(h)).protectedTabs.map(t => t.id), [2002]);
      h.advance(1000);
      await h.load();
      equal((await popup(h)).protectedTabs, []);
    } finally { await h.dispose(); }
  });
}
