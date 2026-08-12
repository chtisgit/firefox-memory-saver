const TAB_KEY = "memorySaverTabKey";
const MAX_SESSIONS = 10_000;

function createKey() {
  return globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function getTabKey(tabId) {
  let key = await browser.sessions.getTabValue(tabId, TAB_KEY);
  if (!key) {
    key = createKey();
    await browser.sessions.setTabValue(tabId, TAB_KEY, key);
  }
  return key;
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
  const live = state.liveUsageRecords[tabKey];
  const completed = state.usageSessions.filter((session) => session.tabKey === tabKey);
  const completedTotal = completed.reduce((sum, session) => sum + session.durationMs, 0);
  const openTotal = live?.currentSessionStartedAt ? now - live.currentSessionStartedAt : 0;
  const latestCompleted = completed.reduce((latest, session) => Math.max(latest, session.startedAt), 0);
  return {
    totalActiveMs: completedTotal + openTotal,
    lastActivatedAt: live?.lastActivatedAt ?? (latestCompleted || null),
  };
}
