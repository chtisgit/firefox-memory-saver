const TAB_KEY = "memorySaverTabKey";
const MAX_SESSIONS = 10_000;
const keyOwners = new Map();
const tabKeys = new Map();

function createKey() {
  return globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function getTabKey(tabId, create = true) {
  if (tabKeys.has(tabId)) return tabKeys.get(tabId);
  let key = await browser.sessions.getTabValue(tabId, TAB_KEY);
  if ((!key && create) || (key && keyOwners.has(key) && keyOwners.get(key) !== tabId)) {
    key = createKey();
    await browser.sessions.setTabValue(tabId, TAB_KEY, key);
  }
  if (key) {
    keyOwners.set(key, tabId);
    tabKeys.set(tabId, key);
  }
  return key;
}

export function releaseTabKey(tabId) {
  const key = tabKeys.get(tabId);
  if (keyOwners.get(key) === tabId) keyOwners.delete(key);
  tabKeys.delete(tabId);
}

export function pruneUsage(state, now = Date.now()) {
  const cutoff = now - state.settings.usageHistoryDays * 86_400_000;
  state.usageSessions = state.usageSessions
    .filter((session) => session.endedAt >= cutoff)
    .sort((a, b) => a.endedAt - b.endedAt)
    .slice(-MAX_SESSIONS);
}

export function endLiveRecord(state, record, endedAt, endReason) {
  if (!record?.currentSessionStartedAt) return;
  const safeEnd = Math.max(record.currentSessionStartedAt, endedAt);
  const durationMs = safeEnd - record.currentSessionStartedAt;
  state.usageSessions.push({
    tabKey: record.tabKey,
    tabIdAtTime: record.tabId,
    windowIdAtTime: record.windowId,
    startedAt: record.currentSessionStartedAt,
    endedAt: safeEnd,
    durationMs,
    url: record.currentUrl ?? "",
    title: record.currentTitle ?? "",
    endReason,
  });
  record.totalActiveMs = (record.totalActiveMs ?? 0) + durationMs;
  delete record.currentSessionStartedAt;
  delete record.lastCheckpointAt;
}

export async function startUsageSession(state, tab, now = Date.now()) {
  if (!state.settings.usageTrackingEnabled || !Number.isInteger(tab?.id) || tab.discarded) return null;
  const tabKey = await getTabKey(tab.id);
  const existing = state.liveUsageRecords[tabKey];
  if (existing?.currentSessionStartedAt) return existing;
  const record = existing ?? {
    tabKey,
    tabId: tab.id,
    windowId: tab.windowId,
    totalActiveMs: 0,
  };
  Object.assign(record, {
    tabId: tab.id,
    windowId: tab.windowId,
    currentSessionStartedAt: now,
    lastCheckpointAt: now,
    lastActivatedAt: now,
    currentUrl: tab.url ?? "",
    currentTitle: tab.title ?? "",
  });
  state.liveUsageRecords[tabKey] = record;
  return record;
}

export function endUsageForWindow(state, windowId, now, reason) {
  for (const record of Object.values(state.liveUsageRecords)) {
    if (record.windowId === windowId && record.currentSessionStartedAt) {
      endLiveRecord(state, record, now, reason);
    }
  }
}

export function endUsageForTab(state, tabId, now, reason, remove = false) {
  for (const [key, record] of Object.entries(state.liveUsageRecords)) {
    if (record.tabId !== tabId) continue;
    endLiveRecord(state, record, now, reason);
    if (remove) delete state.liveUsageRecords[key];
  }
}

export function checkpointUsage(state, now = Date.now()) {
  for (const record of Object.values(state.liveUsageRecords)) {
    if (record.currentSessionStartedAt) record.lastCheckpointAt = now;
  }
  pruneUsage(state, now);
}

export function recoverInterruptedUsage(state) {
  for (const record of Object.values(state.liveUsageRecords)) {
    if (record.currentSessionStartedAt) {
      endLiveRecord(state, record, record.lastCheckpointAt ?? record.currentSessionStartedAt, "startup-recovery");
    }
  }
}

export function clearUsage(state) {
  state.liveUsageRecords = {};
  state.usageSessions = [];
}

export function usageSummaryForTab(state, tabKey, now = Date.now()) {
  if (!tabKey) return { totalActiveMs: 0, lastActivatedAt: null };
  const cutoff = now - state.settings.usageHistoryDays * 86_400_000;
  const live = state.liveUsageRecords[tabKey];
  const completed = state.usageSessions.filter((session) => session.tabKey === tabKey && session.endedAt >= cutoff);
  const completedTotal = completed.reduce((sum, session) => sum + Math.max(0, session.endedAt - Math.max(session.startedAt, cutoff)), 0);
  const openTotal = live?.currentSessionStartedAt ? Math.max(0, now - Math.max(live.currentSessionStartedAt, cutoff)) : 0;
  const latestCompleted = completed.reduce((latest, session) => Math.max(latest, session.startedAt), 0);
  return {
    totalActiveMs: completedTotal + openTotal,
    lastActivatedAt: live?.lastActivatedAt ?? (latestCompleted || null),
  };
}
