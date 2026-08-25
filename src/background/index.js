import { loadState, normalizeSettings, saveState } from "../core/settings.js";
import { hostnameMatches, protectedHostname, protectionReasons, selectEligibleByWindow } from "../core/eligibility.js";
import {
  checkpointUsage,
  clearUsage,
  endUsageForTab,
  endUsageForWindow,
  getTabKey,
  pruneUsage,
  recoverInterruptedUsage,
  startUsageSession,
  usageSummaryForTab,
} from "../core/usage.js";

const SCAN_ALARM = "memory-saver-scan";
const USAGE_ALARM = "memory-saver-usage-checkpoint";
const TAB_PROTECTION_KEY = "memorySaverDoNotDiscard";
const AUTO_DISCARD_MANAGED_KEY = "memorySaverManagesAutoDiscardable";
const MENU_ROOT = "memory-saver-menu";
const MENU_TAB_PROTECTION = "memory-saver-toggle-tab-protection";
const MENU_DOMAIN_PROTECTION = "memory-saver-toggle-domain-protection";
let state;
let queue = Promise.resolve();
let scanRunning = false;

function serialized(task) {
  const result = queue.then(task, task);
  queue = result.catch((error) => console.error("Memory Saver task failed", error));
  return result;
}

async function persist() {
  state = await saveState(state);
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

async function startFocusedTab(now = Date.now()) {
  if (!state.settings.usageTrackingEnabled) return;
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && await isWindowFocused(tab.windowId)) await startUsageSession(state, tab, now);
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
        discardedAt: Date.now(),
        lastAccessedAt: tab.lastAccessed,
        reason: "external",
      };
    }
  }
  for (const [key, record] of Object.entries(state.liveUsageRecords)) {
    if (!liveIds.has(String(record.tabId)) && !record.currentSessionStartedAt) delete state.liveUsageRecords[key];
  }
  return tabs;
}

async function discardTabs(tabs, reason) {
  const discarded = [];
  for (const tab of tabs) {
    try {
      await browser.tabs.discard(tab.id);
      const confirmed = await browser.tabs.get(tab.id);
      if (!confirmed.discarded) continue;
      let tabKey;
      if (state.settings.usageTrackingEnabled) tabKey = await getTabKey(tab.id);
      state.discardRecords[String(tab.id)] = {
        tabId: tab.id,
        tabKey,
        windowId: tab.windowId,
        title: tab.title ?? "",
        url: tab.url ?? "",
        favIconUrl: tab.favIconUrl,
        discardedAt: Date.now(),
        lastAccessedAt: tab.lastAccessed,
        reason,
      };
      state.lifetimeDiscardCount += 1;
      endUsageForTab(state, tab.id, Date.now(), "discarded");
      discarded.push(tab.id);
    } catch (error) {
      console.warn(`Could not discard tab ${tab.id}`, error);
    }
  }
  await persist();
  return discarded;
}

async function runScan({ ignoreInactivity = false, windowId, reason = "automatic" } = {}) {
  if (scanRunning || (!state.settings.enabled && !ignoreInactivity)) return [];
  scanRunning = true;
  try {
    const tabs = await tabsWithProtection(await browser.tabs.query(windowId == null ? {} : { windowId }));
    const selected = selectEligibleByWindow(tabs, state.settings, Date.now(), { ignoreInactivity });
    return await discardTabs(selected, reason);
  } finally {
    scanRunning = false;
  }
}

async function popupState() {
  const tabs = await tabsWithProtection(await reconcileRecords());
  await persist();
  const now = Date.now();
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
    lifetimeDiscardCount: state.lifetimeDiscardCount,
  };
}

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_POPUP_STATE":
      return { ok: true, data: await popupState() };
    case "DISCARD_ELIGIBLE_NOW":
      return { ok: true, data: await runScan({ ignoreInactivity: true, windowId: message.windowId, reason: "manual-eligible" }) };
    case "DISCARD_OTHER_TABS":
      return { ok: true, data: await runScan({ ignoreInactivity: true, windowId: message.windowId, reason: "manual-others" }) };
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
      if (wasTracking && !state.settings.usageTrackingEnabled) clearUsage(state);
      pruneUsage(state);
      await persist();
      await configureAlarms();
      await reconcileAllTabDiscardability();
      if (!wasTracking && state.settings.usageTrackingEnabled) {
        await startFocusedTab();
        await persist();
      }
      return { ok: true, data: state.settings };
    }
    case "CLEAR_USAGE_DATA":
      clearUsage(state);
      await persist();
      await startFocusedTab();
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
    if (alarm.name === USAGE_ALARM && state.settings.usageTrackingEnabled) {
      checkpointUsage(state);
      await persist();
    }
  });
});

browser.tabs.onActivated.addListener((info) => {
  serialized(async () => {
    delete state.discardRecords[String(info.tabId)];
    if (state.settings.usageTrackingEnabled && await isWindowFocused(info.windowId)) {
      const now = Date.now();
      endUsageForWindow(state, info.windowId, now, "tab-switch");
      await startUsageSession(state, await browser.tabs.get(info.tabId), now);
    }
    await persist();
  });
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!("discarded" in changeInfo) && !("url" in changeInfo)) return;
  serialized(async () => {
    const now = Date.now();
    if (changeInfo.discarded === false) delete state.discardRecords[String(tabId)];
    if (changeInfo.discarded === true) endUsageForTab(state, tabId, now, "discarded");
    if (changeInfo.url && state.settings.usageTrackingEnabled) {
      const activeRecord = Object.values(state.liveUsageRecords).find((record) => record.tabId === tabId && record.currentSessionStartedAt);
      if (activeRecord) {
        endUsageForTab(state, tabId, now, "navigation");
        await startUsageSession(state, tab, now);
      }
    }
    if (changeInfo.url) await reconcileTabDiscardability(tab);
    await persist();
  });
});

browser.tabs.onRemoved.addListener((tabId) => {
  serialized(async () => {
    delete state.discardRecords[String(tabId)];
    endUsageForTab(state, tabId, Date.now(), "tab-closed", true);
    await persist();
  });
});

browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  serialized(async () => {
    const now = Date.now();
    delete state.discardRecords[String(removedTabId)];
    endUsageForTab(state, removedTabId, now, "navigation", true);
    try {
      const tab = await browser.tabs.get(addedTabId);
      if (tab.active && state.settings.usageTrackingEnabled && await isWindowFocused(tab.windowId)) {
        await startUsageSession(state, tab, now);
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
  serialized(async () => {
    const now = Date.now();
    for (const record of Object.values(state.liveUsageRecords)) {
      if (record.currentSessionStartedAt) endUsageForWindow(state, record.windowId, now, "window-blur");
    }
    if (windowId !== browser.windows.WINDOW_ID_NONE && state.settings.usageTrackingEnabled) {
      const [tab] = await browser.tabs.query({ active: true, windowId });
      if (tab) await startUsageSession(state, tab, now);
    }
    await persist();
  });
});

browser.windows.onRemoved.addListener((windowId) => {
  serialized(async () => {
    endUsageForWindow(state, windowId, Date.now(), "window-blur");
    await persist();
  });
});

async function initialize() {
  state = await loadState();
  recoverInterruptedUsage(state);
  pruneUsage(state);
  await reconcileRecords();
  await reconcileAllTabDiscardability();
  await configureAlarms();
  await startFocusedTab();
  await persist();
}

serialized(initialize);
