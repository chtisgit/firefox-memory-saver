import { calculateScanInterval, loadState, normalizeSettings, saveState } from "../core/settings.js";
import { acceptsRecordingEvent, activityId, canContinueRecording, captureRecordingContext, endCoverage, noteObservationError, startCoverage } from "../core/activity.js";
import { hostnameMatches, protectedHostname, protectionReasons, selectEligibleByWindow } from "../core/eligibility.js";
import {
  checkpointUsage,
  clearUsage,
  endUsageForTab,
  endUsageForWindow,
  getTabKey,
  markUsageTabLoaded,
  observeUsageTab,
  recordTabAccess,
  recordUsageDiscard,
  rebindTabKey,
  pruneUsage,
  releaseTabKey,
  recoverInterruptedUsage,
  startUsageSession,
  usageSummaryForTab,
} from "../core/usage.js";

const SCAN_ALARM = "memory-saver-scan";
const USAGE_ALARM = "memory-saver-usage-checkpoint";
const TAB_PROTECTION_KEY = "memorySaverDoNotDiscard";
const AUTO_DISCARD_MANAGED_KEY = "memorySaverManagesAutoDiscardable";
const LAST_SLEEP_KEY = "memorySaverLastSleep";
const MENU_ROOT = "memory-saver-menu";
const MENU_TAB_PROTECTION = "memory-saver-toggle-tab-protection";
const MENU_DOMAIN_PROTECTION = "memory-saver-toggle-domain-protection";
let state;
let queue = Promise.resolve();
let scanRunning = false;
let browserSessionId = null;
let lastPersistedRevision = null;
let recorderHealthy = true;
const discardAttempts = new Map();
const BROWSER_SESSION_KEY = "memorySaverRecorderBrowserSession";
const SUSPENDED_RECORDER_KEY = "memorySaverSuspendedRecorder";

function serialized(task) {
  const result = queue.then(task, task);
  queue = result.catch((error) => {
    recorderHealthy = false;
    if (state?.settings.usageTrackingEnabled) {
      recoverInterruptedUsage(state);
      const previous = state.usageCoverage.segments.at(-1);
      if (previous) endCoverage(state, previous.lastCheckpointAt, "recording-error");
      startCoverage(state, Date.now(), "recording-error-recovery");
    }
    console.error("Memory Saver task failed", error);
  });
  return result;
}

async function persist() {
  if (state.settings.usageTrackingEnabled && checkpointUsage(state)) {
    await startFocusedTab(Date.now(), "recorder-resumed");
  }
  state.usageRecorder.revision += 1;
  state = await saveState(state);
  lastPersistedRevision = state.usageRecorder.revision;
  recorderHealthy = true;
}

async function recorderRuntime() {
  try {
    const stored = await browser.storage.session.get([BROWSER_SESSION_KEY, SUSPENDED_RECORDER_KEY]);
    const sessionId = stored[BROWSER_SESSION_KEY] ?? activityId();
    await browser.storage.session.set({ [BROWSER_SESSION_KEY]: sessionId });
    await browser.storage.session.remove(SUSPENDED_RECORDER_KEY);
    return { sessionId, suspended: stored[SUSPENDED_RECORDER_KEY] };
  } catch (error) {
    // Without a trustworthy browser-session marker, recover conservatively.
    console.warn("Could not read recorder continuity marker", error);
    return { sessionId: activityId(), suspended: null };
  }
}

async function observeOpenTabs(tabs, now, snapshot = false) {
  if (!state.settings.usageTrackingEnabled) return;
  const liveKeys = new Set();
  let allObserved = true;
  for (const tab of tabs) {
    try {
      const metadata = await observeUsageTab(state, tab, now, { snapshot });
      if (metadata) liveKeys.add(metadata.tabKey);
    } catch (error) {
      allObserved = false;
      noteObservationError(state, now);
      console.warn(`Could not observe usage for tab ${tab.id}`, error);
    }
  }
  if (!allObserved) return;
  // Reconcile by persistent key, since numeric Firefox IDs can change or be reused.
  for (const [key, metadata] of Object.entries(state.usageTabMetadata)) {
    if (metadata.closedAt == null && !liveKeys.has(key)) {
      metadata.closedAt = now;
      delete metadata.tabId;
      delete metadata.windowId;
      delete state.liveUsageRecords[key];
    }
  }
}

async function beginRecording(now, reason) {
  state.usageRecorder.browserSessionId = browserSessionId;
  startCoverage(state, now, reason);
  await observeOpenTabs(await browser.tabs.query({}), now, true);
  await startFocusedTab(now, reason);
}

function hostnameForMenu(urlValue) {
  try {
    const url = new URL(urlValue);
    return ["http:", "https:"].includes(url.protocol) ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function getTabBoolean(tabId, key) {
  try {
    return await browser.sessions.getTabValue(tabId, key) === true;
  } catch {
    return false;
  }
}

async function setTabBoolean(tabId, key, value) {
  if (value) {
    await browser.sessions.setTabValue(tabId, key, true);
  } else if (browser.sessions.removeTabValue) {
    await browser.sessions.removeTabValue(tabId, key);
  } else {
    await browser.sessions.setTabValue(tabId, key, false);
  }
}

async function reconcileTabDiscardability(tab) {
  if (!Number.isInteger(tab?.id)) return false;
  const [tabProtected, managed] = await Promise.all([
    getTabBoolean(tab.id, TAB_PROTECTION_KEY),
    getTabBoolean(tab.id, AUTO_DISCARD_MANAGED_KEY),
  ]);
  const domainProtected = Boolean(protectedHostname(tab.url, state.settings.protectedDomains));
  const shouldProtect = tabProtected || domainProtected;

  if (shouldProtect) {
    if (tab.autoDiscardable !== false) await browser.tabs.update(tab.id, { autoDiscardable: false });
    if (!managed) await setTabBoolean(tab.id, AUTO_DISCARD_MANAGED_KEY, true);
  } else if (managed) {
    await browser.tabs.update(tab.id, { autoDiscardable: true });
    await setTabBoolean(tab.id, AUTO_DISCARD_MANAGED_KEY, false);
  }
  return tabProtected;
}

async function reconcileAllTabDiscardability() {
  const tabs = await browser.tabs.query({});
  await Promise.all(tabs.map((tab) => reconcileTabDiscardability(tab).catch((error) => {
    console.warn(`Could not update discard protection for tab ${tab.id}`, error);
  })));
}

async function tabsWithProtection(tabs) {
  return Promise.all(tabs.map(async (tab) => ({
    ...tab,
    memorySaverProtected: await getTabBoolean(tab.id, TAB_PROTECTION_KEY),
  })));
}

async function createContextMenus() {
  await browser.menus.removeAll();
  browser.menus.create({ id: MENU_ROOT, title: "Memory Saver", contexts: ["tab"] });
  browser.menus.create({
    id: MENU_TAB_PROTECTION,
    parentId: MENU_ROOT,
    title: "Do not discard this tab",
    contexts: ["tab"],
  });
  browser.menus.create({
    id: MENU_DOMAIN_PROTECTION,
    parentId: MENU_ROOT,
    title: "Do not discard this domain",
    contexts: ["tab"],
  });
}

async function updateContextMenus(tab) {
  const hostname = hostnameForMenu(tab?.url);
  const tabProtected = Number.isInteger(tab?.id) && await getTabBoolean(tab.id, TAB_PROTECTION_KEY);
  const matchingDomain = hostname && state.settings.protectedDomains.find((domain) => hostnameMatches(hostname, domain));
  const exactDomainProtected = matchingDomain === hostname;
  await browser.menus.update(MENU_TAB_PROTECTION, {
    title: tabProtected ? "Allow discarding this tab" : "Do not discard this tab",
  });
  await browser.menus.update(MENU_DOMAIN_PROTECTION, {
    visible: Boolean(hostname),
    enabled: !matchingDomain || exactDomainProtected,
    title: exactDomainProtected
      ? `Allow discarding ${hostname}`
      : matchingDomain
        ? `Protected by ${matchingDomain}`
        : `Do not discard ${hostname ?? "this domain"}`,
  });
  await browser.menus.refresh();
}

async function toggleTabProtection(tab) {
  if (!Number.isInteger(tab?.id)) return;
  const protectedNow = await getTabBoolean(tab.id, TAB_PROTECTION_KEY);
  await setTabBoolean(tab.id, TAB_PROTECTION_KEY, !protectedNow);
  await reconcileTabDiscardability(await browser.tabs.get(tab.id));
}

async function toggleDomainProtection(tab) {
  const hostname = hostnameForMenu(tab?.url);
  if (!hostname) return;
  const domains = state.settings.protectedDomains;
  state.settings.protectedDomains = domains.includes(hostname)
    ? domains.filter((domain) => domain !== hostname)
    : [...domains, hostname];
  await persist();
  await reconcileAllTabDiscardability();
}

async function configureAlarms() {
  await browser.alarms.clear(SCAN_ALARM);
  await browser.alarms.create(SCAN_ALARM, { periodInMinutes: state.settings.scanIntervalMinutes });
  await browser.alarms.clear(USAGE_ALARM);
  if (state.settings.usageTrackingEnabled) {
    await browser.alarms.create(USAGE_ALARM, { periodInMinutes: 5 });
  }
}

async function isWindowFocused(windowId) {
  try {
    return (await browser.windows.get(windowId)).focused;
  } catch {
    return false;
  }
}

async function startFocusedTab(now = Date.now(), reason = "recorder-start") {
  if (!state.settings.usageTrackingEnabled) return;
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && await isWindowFocused(tab.windowId)) await startUsageSession(state, tab, now, reason);
}

async function saveLastSleep(tabId, sleep) {
  try {
    await browser.sessions.setTabValue(tabId, LAST_SLEEP_KEY, sleep);
  } catch (error) {
    console.warn(`Could not save last sleep for tab ${tabId}`, error);
  }
}

async function reconcileRecords() {
  const tabs = await browser.tabs.query({});
  const liveIds = new Set(tabs.map((tab) => String(tab.id)));
  for (const id of Object.keys(state.discardRecords)) {
    const tab = tabs.find((candidate) => String(candidate.id) === id);
    if (!tab?.discarded) delete state.discardRecords[id];
  }
  for (const tab of tabs.filter((candidate) => candidate.discarded && Number.isInteger(candidate.id))) {
    const id = String(tab.id);
    if (!state.discardRecords[id]) {
      state.discardRecords[id] = {
        tabId: tab.id,
        windowId: tab.windowId,
        title: tab.title ?? "",
        url: tab.url ?? "",
        favIconUrl: tab.favIconUrl,
        discardedAt: null,
        lastAccessedAt: tab.lastAccessed,
        reason: "external",
      };
      await saveLastSleep(tab.id, { discardedAt: null, reason: "external" });
    }
  }
  for (const [key, record] of Object.entries(state.liveUsageRecords)) {
    if (!liveIds.has(String(record.tabId)) && !record.currentSessionStartedAt) delete state.liveUsageRecords[key];
  }
  return tabs;
}

async function discardTabs(tabs, reason) {
  const discarded = [];
  let refusedCount = 0;
  let failedCount = 0;
  for (const tab of tabs) {
    let wasDiscarded = false;
    const attempt = { source: reason === "automatic" ? "automatic" : "manual", observedAt: null };
    discardAttempts.set(tab.id, attempt);
    try {
      await browser.tabs.discard(tab.id);
      const confirmed = await browser.tabs.get(tab.id);
      if (!confirmed.discarded) {
        refusedCount += 1;
        continue;
      }
      wasDiscarded = true;
      discarded.push(tab.id);
      state.lifetimeDiscardCount += 1;
      endUsageForTab(state, tab.id, Date.now(), "discarded");
      const discardedAt = attempt.observedAt ?? Date.now();
      await saveLastSleep(tab.id, { discardedAt, reason });
      await recordUsageDiscard(state, confirmed, attempt.source, discardedAt);
      let tabKey;
      if (state.settings.usageTrackingEnabled) tabKey = await getTabKey(tab.id);
      state.discardRecords[String(tab.id)] = {
        tabId: tab.id,
        tabKey,
        windowId: tab.windowId,
        title: tab.title ?? "",
        url: tab.url ?? "",
        favIconUrl: tab.favIconUrl,
        discardedAt,
        lastAccessedAt: tab.lastAccessed,
        reason,
      };
    } catch (error) {
      if (!wasDiscarded) failedCount += 1;
      else if (state.settings.usageTrackingEnabled) noteObservationError(state, Date.now());
      console.warn(`Could not discard tab ${tab.id}`, error);
    } finally {
      discardAttempts.delete(tab.id);
    }
  }
  await persist();
  return { discardedTabIds: discarded, refusedCount, failedCount };
}

async function runScan({ ignoreInactivity = false, windowId, reason = "automatic" } = {}) {
  if (scanRunning || (!state.settings.enabled && !ignoreInactivity)) {
    return { discardedTabIds: [], refusedCount: 0, failedCount: 0 };
  }
  scanRunning = true;
  try {
    const tabs = await tabsWithProtection(await browser.tabs.query({}));
    const selected = selectEligibleByWindow(tabs, state.settings, Date.now(), { ignoreInactivity, windowId });
    return await discardTabs(selected, reason);
  } finally {
    scanRunning = false;
  }
}

async function popupState(targetTabId) {
  const tabs = await tabsWithProtection(await reconcileRecords());
  await persist();
  const [activeTab] = targetTabId === undefined ? await browser.tabs.query({ active: true, currentWindow: true }) : [];
  const currentTab = tabs.find((tab) => tab.id === (targetTabId === undefined ? activeTab?.id : targetTabId));
  const now = Date.now();
  let currentTabDetails = null;
  if (currentTab) {
    let lastSleep = null;
    let usage = null;
    try {
      lastSleep = await browser.sessions.getTabValue(currentTab.id, LAST_SLEEP_KEY);
      if (state.settings.usageTrackingEnabled) {
        usage = usageSummaryForTab(state, await getTabKey(currentTab.id), now);
      }
    } catch (error) {
      console.warn(`Could not read tab details for ${currentTab.id}`, error);
    }
    currentTabDetails = { ...currentTab, protectionReasons: protectionReasons(currentTab, state.settings), lastSleep, usage };
  }
  const discardedTabs = Object.values(state.discardRecords)
    .map((record) => ({ ...record, usage: usageSummaryForTab(state, record.tabKey, now) }))
    .sort((a, b) => b.discardedAt - a.discardedAt);
  const protectedTabs = tabs
    .map((tab) => ({ ...tab, protectionReasons: protectionReasons(tab, state.settings) }))
    .filter((tab) => tab.protectionReasons.length)
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return {
    settings: state.settings,
    discardedTabs,
    protectedTabs,
    eligibleDiscardCount: selectEligibleByWindow(tabs, state.settings, now, { ignoreInactivity: true }).length,
    currentTab: currentTabDetails,
    lifetimeDiscardCount: state.lifetimeDiscardCount,
  };
}

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_POPUP_STATE":
      return { ok: true, data: await popupState(message.targetTabId) };
    case "DISCARD_ELIGIBLE_NOW":
      return { ok: true, data: await runScan({ ignoreInactivity: true, windowId: message.windowId, reason: "manual-eligible" }) };
    case "TOGGLE_TAB_PROTECTION":
      await toggleTabProtection(await browser.tabs.get(message.tabId));
      return { ok: true };
    case "RESTORE_TAB":
      await browser.windows.update(message.windowId, { focused: true });
      await browser.tabs.update(message.tabId, { active: true });
      return { ok: true };
    case "CLOSE_TAB":
      await browser.tabs.remove(message.tabId);
      return { ok: true };
    case "GET_SETTINGS":
      return { ok: true, data: state.settings };
    case "SAVE_SETTINGS": {
      const wasTracking = state.settings.usageTrackingEnabled;
      state.settings = normalizeSettings(message.settings);
      state.settings.scanIntervalMinutes = calculateScanInterval(state.settings.inactivityMinutes);
      if (wasTracking && !state.settings.usageTrackingEnabled) clearUsage(state);
      pruneUsage(state);
      await persist();
      await configureAlarms();
      await reconcileAllTabDiscardability();
      if (!wasTracking && state.settings.usageTrackingEnabled) {
        await beginRecording(Date.now(), "recording-enabled");
        await persist();
      }
      return { ok: true, data: state.settings };
    }
    case "CLEAR_USAGE_DATA":
      clearUsage(state);
      await persist();
      if (state.settings.usageTrackingEnabled) await beginRecording(Date.now(), "history-cleared");
      await persist();
      return { ok: true };
    default:
      return { ok: false, error: "Unknown request." };
  }
}

browser.runtime.onMessage.addListener((message) => serialized(() => handleMessage(message)).catch((error) => ({ ok: false, error: error.message })));

browser.runtime.onInstalled.addListener(() => {
  createContextMenus().catch((error) => console.error("Could not create Memory Saver menus", error));
});

browser.menus.onShown.addListener((_info, tab) => {
  serialized(() => updateContextMenus(tab));
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_TAB_PROTECTION) serialized(() => toggleTabProtection(tab));
  if (info.menuItemId === MENU_DOMAIN_PROTECTION) serialized(() => toggleDomainProtection(tab));
});

browser.alarms.onAlarm.addListener((alarm) => {
  serialized(async () => {
    if (alarm.name === SCAN_ALARM) await runScan();
    if (alarm.name === USAGE_ALARM && state.settings.usageTrackingEnabled) await persist();
  });
});

browser.tabs.onActivated.addListener((info) => {
  const now = Date.now();
  const context = captureRecordingContext(state);
  serialized(async () => {
    delete state.discardRecords[String(info.tabId)];
    if (acceptsRecordingEvent(state, context, now)) {
      const tab = await browser.tabs.get(info.tabId);
      await recordTabAccess(state, tab, now);
      endUsageForWindow(state, info.windowId, now, "tab-switch");
      if (!tab.discarded) await markUsageTabLoaded(state, tab, now);
      if (await isWindowFocused(info.windowId)) await startUsageSession(state, tab, now, "tab-activation");
    }
    await persist();
  });
});

browser.tabs.onCreated.addListener((tab) => {
  const now = Date.now();
  const context = captureRecordingContext(state);
  serialized(async () => {
    if (!Number.isInteger(tab.id)) return;
    await getTabKey(tab.id, false);
    if (acceptsRecordingEvent(state, context, now)) {
      await observeUsageTab(state, tab, now);
      await persist();
    }
  });
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!("discarded" in changeInfo) && !("url" in changeInfo) && !("title" in changeInfo)) return;
  const now = Date.now();
  const context = captureRecordingContext(state);
  const attempt = discardAttempts.get(tabId);
  const discardSource = attempt?.source ?? "external";
  if (changeInfo.discarded === true && attempt && attempt.observedAt == null) attempt.observedAt = now;
  serialized(async () => {
    if (changeInfo.discarded === false) {
      delete state.discardRecords[String(tabId)];
      if (acceptsRecordingEvent(state, context, now)) await markUsageTabLoaded(state, tab, now);
    }
    if (changeInfo.discarded === true) {
      if (!state.discardRecords[String(tabId)]) {
        state.discardRecords[String(tabId)] = {
          tabId, windowId: tab.windowId, title: tab.title ?? "", url: tab.url ?? "",
          favIconUrl: tab.favIconUrl, discardedAt: now, lastAccessedAt: tab.lastAccessed,
          reason: "external",
        };
        await saveLastSleep(tabId, { discardedAt: now, reason: "external" });
      }
      // recordUsageDiscard also handles deduplication independently of popup records.
      if (acceptsRecordingEvent(state, context, now)) {
        await recordUsageDiscard(state, tab, discardSource, now);
        endUsageForTab(state, tabId, now, "discarded");
      }
    }
    if (acceptsRecordingEvent(state, context, now)) {
      await observeUsageTab(state, tab, now);
      if (changeInfo.url) {
        const activeRecord = Object.values(state.liveUsageRecords).find((record) => record.tabId === tabId && record.currentSessionStartedAt != null);
        if (activeRecord) {
          endUsageForTab(state, tabId, now, "navigation");
          await startUsageSession(state, tab, now, "navigation");
        }
      } else if ("title" in changeInfo) {
        const record = Object.values(state.liveUsageRecords).find((item) => item.tabId === tabId);
        if (record) record.currentTitle = tab.title ?? "";
      }
      if (changeInfo.discarded === false && tab.active && await isWindowFocused(tab.windowId)) {
        await startUsageSession(state, tab, now, "restored");
      }
    }
    if (changeInfo.url) await reconcileTabDiscardability(tab);
    await persist();
  });
});

browser.tabs.onDetached?.addListener((tabId) => {
  const now = Date.now();
  const context = captureRecordingContext(state);
  serialized(async () => {
    if (acceptsRecordingEvent(state, context, now)) endUsageForTab(state, tabId, now, "tab-detached");
    await persist();
  });
});

browser.tabs.onAttached?.addListener((tabId) => {
  const now = Date.now();
  const context = captureRecordingContext(state);
  serialized(async () => {
    await rebindTabKey(tabId);
    const tab = await browser.tabs.get(tabId);
    if (acceptsRecordingEvent(state, context, now)) {
      await observeUsageTab(state, tab, now);
      if (tab.active && await isWindowFocused(tab.windowId)) await startUsageSession(state, tab, now, "tab-attached");
    }
    await persist();
  });
});

browser.tabs.onRemoved.addListener((tabId) => {
  const now = Date.now();
  const context = captureRecordingContext(state);
  serialized(async () => {
    delete state.discardRecords[String(tabId)];
    if (acceptsRecordingEvent(state, context, now)) endUsageForTab(state, tabId, now, "tab-closed", true);
    releaseTabKey(tabId);
    await persist();
  });
});

browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  const now = Date.now();
  const context = captureRecordingContext(state);
  serialized(async () => {
    delete state.discardRecords[String(removedTabId)];
    if (acceptsRecordingEvent(state, context, now)) endUsageForTab(state, removedTabId, now, "tab-replaced", true);
    releaseTabKey(removedTabId);
    try {
      const tab = await browser.tabs.get(addedTabId);
      if (acceptsRecordingEvent(state, context, now)) {
        await observeUsageTab(state, tab, now);
        if (tab.active && await isWindowFocused(tab.windowId)) await startUsageSession(state, tab, now, "tab-replaced");
      }
      await reconcileTabDiscardability(tab);
    } catch {
      // Firefox may remove a replacement before its metadata can be queried.
    }
    await reconcileRecords();
    await persist();
  });
});

browser.windows.onFocusChanged.addListener((windowId) => {
  const now = Date.now();
  const context = captureRecordingContext(state);
  serialized(async () => {
    if (!acceptsRecordingEvent(state, context, now)) return;
    for (const record of Object.values(state.liveUsageRecords)) {
      if (record.currentSessionStartedAt != null) endUsageForWindow(state, record.windowId, now, "window-blur");
    }
    if (windowId !== browser.windows.WINDOW_ID_NONE && state.settings.usageTrackingEnabled) {
      const [tab] = await browser.tabs.query({ active: true, windowId });
      if (tab) await startUsageSession(state, tab, now, "window-focus");
    }
    await persist();
  });
});

browser.windows.onRemoved.addListener((windowId) => {
  const now = Date.now();
  const context = captureRecordingContext(state);
  serialized(async () => {
    if (acceptsRecordingEvent(state, context, now)) endUsageForWindow(state, windowId, now, "window-closed");
    await persist();
  });
});

// A best-effort marker authorizes continuation only after a clean idle suspension.
// If this write cannot complete, the next startup falls back to the disk checkpoint.
browser.runtime.onSuspend?.addListener(() => {
  if (!state?.settings.usageTrackingEnabled || !recorderHealthy || lastPersistedRevision == null) return;
  browser.storage.session?.set({
    [SUSPENDED_RECORDER_KEY]: { browserSessionId, revision: lastPersistedRevision },
  }).catch((error) => console.warn("Could not mark recorder suspension", error));
});

browser.runtime.onSuspendCanceled?.addListener(() => {
  browser.storage.session?.remove(SUSPENDED_RECORDER_KEY)
    .catch((error) => console.warn("Could not clear recorder suspension", error));
});

async function reconcileRecorderForeground(checkpoints = new Map()) {
  if (!state.settings.usageTrackingEnabled) return;
  const now = Date.now();
  const tabs = await browser.tabs.query({});
  for (const record of Object.values(state.liveUsageRecords)) {
    if (record.currentSessionStartedAt == null) continue;
    const tab = tabs.find((item) => item.id === record.tabId);
    const sameTab = tab && await getTabKey(tab.id) === record.tabKey;
    const sameForeground = sameTab && tab.active && !tab.discarded
      && await isWindowFocused(tab.windowId) && record.currentUrl === tab.url;
    if (!sameForeground) {
      const saved = checkpoints.get(record.tabKey);
      const checkpoint = saved?.startedAt === record.currentSessionStartedAt
        ? saved.checkpointAt : record.lastCheckpointAt;
      endUsageForTab(state, record.tabId, checkpoint, "foreground-uncertain");
      const previous = state.usageCoverage.segments.at(-1);
      if (previous) endCoverage(state, Math.min(previous.lastCheckpointAt, checkpoint), "foreground-uncertain");
      startCoverage(state, now, "recorder-start");
    }
  }
  await observeOpenTabs(tabs, now, true);
  await startFocusedTab(now);
  await persist();
}

async function initialize() {
  state = await loadState();
  const runtime = await recorderRuntime();
  browserSessionId = runtime.sessionId;
  const now = Date.now();
  const tabs = await browser.tabs.query({});
  for (const tab of tabs.filter((item) => Number.isInteger(item.id)).sort((a, b) => a.id - b.id)) {
    try {
      await getTabKey(tab.id, false);
    } catch (error) {
      console.warn(`Could not check tab identity for ${tab.id}`, error);
    }
  }
  const continuation = state.settings.usageTrackingEnabled
    && canContinueRecording(state, browserSessionId, runtime.suspended, now);
  const checkpoints = new Map(Object.entries(state.liveUsageRecords).map(([key, record]) => [key, {
    startedAt: record.currentSessionStartedAt, checkpointAt: record.lastCheckpointAt ?? record.currentSessionStartedAt,
  }]));
  if (!state.settings.usageTrackingEnabled) {
    // Also remove any legacy detailed history left behind while tracking was off.
    clearUsage(state);
  } else {
    if (!continuation) {
      recoverInterruptedUsage(state);
      const previous = state.usageCoverage.segments.at(-1);
      if (previous) endCoverage(state, previous.lastCheckpointAt, "recorder-interrupted");
      startCoverage(state, now, "recorder-start");
      await observeOpenTabs(tabs, now, true);
      await startFocusedTab(now);
    }
    state.usageRecorder.browserSessionId = browserSessionId;
  }
  pruneUsage(state, now);
  await reconcileRecords();
  await reconcileAllTabDiscardability();
  await configureAlarms();
  if (continuation) {
    // Wake-triggering activation/focus/navigation events are already queued. Let
    // them close the old interval at their captured event time before reconciling.
    // Do not checkpoint the old foreground state until those events run.
    serialized(() => reconcileRecorderForeground(checkpoints));
  } else {
    await persist();
  }
}

serialized(initialize);
