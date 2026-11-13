import {
  activityId, closeTabMetadata, checkpointCoverage, emptyActivityState, endCoverage,
  markTabLoaded, MAX_CONTINUITY_MS, noteTabAccess, observeTab,
  pruneActivity, recordDiscard, startCoverage,
} from "./activity.js";

const TAB_KEY = "memorySaverTabKey";
const keyOwners = new Map();
const tabKeys = new Map();

export async function getTabKey(tabId, create = true) {
  if (tabKeys.has(tabId)) return tabKeys.get(tabId);
  let key = await browser.sessions.getTabValue(tabId, TAB_KEY);
  if ((!key && create) || (key && keyOwners.has(key) && keyOwners.get(key) !== tabId)) {
    key = activityId();
    await browser.sessions.setTabValue(tabId, TAB_KEY, key);
  }
  if (key) {
    keyOwners.set(key, tabId);
    tabKeys.set(tabId, key);
  }
  return key;
}

export async function rebindTabKey(tabId) {
  const key = await getTabKey(tabId, false);
  // Some browser versions can drop extension session values while adopting a tab.
  if (key) await browser.sessions.setTabValue(tabId, TAB_KEY, key);
  return key;
}

export function releaseTabKey(tabId) {
  const key = tabKeys.get(tabId);
  if (keyOwners.get(key) === tabId) keyOwners.delete(key);
  tabKeys.delete(tabId);
}

export async function observeUsageTab(state, tab, now = Date.now(), options = {}) {
  if (!state.settings.usageTrackingEnabled || !Number.isInteger(tab?.id)) return null;
  const key = await getTabKey(tab.id);
  return observeTab(state, key, tab, now, options);
}

export async function recordUsageDiscard(state, tab, source, now = Date.now()) {
  if (!state.settings.usageTrackingEnabled || !Number.isInteger(tab?.id)) return null;
  const boundary = state.usageCoverage?.segments.at(-1)?.startedAt ?? state.usageCoverage?.recordingStartedAt;
  if (boundary != null && now < boundary) return null;
  const key = await getTabKey(tab.id);
  return recordDiscard(state, key, tab, source, now);
}

export async function markUsageTabLoaded(state, tab, now = Date.now()) {
  const metadata = await observeUsageTab(state, tab, now);
  if (metadata) markTabLoaded(state, metadata.tabKey);
}

export function pruneUsage(state, now = Date.now()) {
  pruneActivity(state, now);
}

export function endLiveRecord(state, record, endedAt, endReason) {
  if (record?.currentSessionStartedAt == null) return;
  const safeEnd = Math.max(record.currentSessionStartedAt, endedAt);
  const durationMs = safeEnd - record.currentSessionStartedAt;
  state.usageSessions.push({
    sessionId: activityId(),
    tabKey: record.tabKey,
    tabIdAtTime: record.tabId,
    windowIdAtTime: record.windowId,
    startedAt: record.currentSessionStartedAt,
    endedAt: safeEnd,
    durationMs,
    foregroundActivatedAt: record.lastActivatedAt ?? null,
    startReason: record.startReason ?? "legacy-unknown",
    url: record.currentUrl ?? "",
    title: record.currentTitle ?? "",
    endReason,
  });
  record.totalActiveMs = (record.totalActiveMs ?? 0) + durationMs;
  delete record.currentSessionStartedAt;
  delete record.lastCheckpointAt;
}

export async function startUsageSession(state, tab, now = Date.now(), startReason = "tab-activation") {
  if (!state.settings.usageTrackingEnabled || !Number.isInteger(tab?.id) || tab.discarded) return null;
  now = Math.max(now, state.usageCoverage?.segments.at(-1)?.startedAt ?? now);
  const metadata = await observeUsageTab(state, tab, now);
  const tabKey = metadata.tabKey;
  const existing = state.liveUsageRecords[tabKey];
  if (existing?.currentSessionStartedAt != null) return existing;
  const record = existing ?? { tabKey, tabId: tab.id, windowId: tab.windowId, totalActiveMs: 0 };
  if (["tab-activation", "window-focus", "recording-enabled"].includes(startReason)) {
    metadata.lastActivatedAt = now;
    metadata.lastActivationSource = startReason;
    metadata.lastForegroundObservedAt = now;
  } else if (startReason !== "navigation") {
    metadata.lastForegroundObservedAt = now;
  }
  Object.assign(record, {
    tabId: tab.id,
    windowId: tab.windowId,
    currentSessionStartedAt: now,
    lastCheckpointAt: now,
    lastActivatedAt: metadata.lastActivatedAt ?? record.lastActivatedAt ?? null,
    startReason,
    currentUrl: tab.url ?? "",
    currentTitle: tab.title ?? "",
  });
  state.liveUsageRecords[tabKey] = record;
  return record;
}

export async function recordTabAccess(state, tab, now = Date.now()) {
  const metadata = await observeUsageTab(state, tab, now);
  if (metadata) noteTabAccess(metadata, now);
}

export function endUsageForWindow(state, windowId, now, reason) {
  for (const record of Object.values(state.liveUsageRecords)) {
    if (record.windowId === windowId && record.currentSessionStartedAt != null) {
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
  if (remove) closeTabMetadata(state, tabId, now);
}

export function checkpointUsage(state, now = Date.now()) {
  const segment = state.usageCoverage?.segments.at(-1);
  const gap = segment && segment.endedAt == null
    && (now < segment.lastCheckpointAt || now - segment.lastCheckpointAt > MAX_CONTINUITY_MS);
  if (gap) {
    const clockChanged = now < segment.lastCheckpointAt;
    if (clockChanged) segment.clockDiscontinuity = true;
    recoverInterruptedUsage(state);
    endCoverage(state, segment.lastCheckpointAt, clockChanged ? "clock-change" : "checkpoint-gap");
    const next = startCoverage(state, now, clockChanged ? "clock-change" : "recorder-resumed");
    if (clockChanged) next.clockDiscontinuity = true;
  }
  for (const record of Object.values(state.liveUsageRecords)) {
    if (record.currentSessionStartedAt != null) record.lastCheckpointAt = Math.max(record.currentSessionStartedAt, now);
  }
  checkpointCoverage(state, now);
  pruneUsage(state, now);
  return Boolean(gap);
}

export function recoverInterruptedUsage(state) {
  for (const record of Object.values(state.liveUsageRecords)) {
    if (record.currentSessionStartedAt != null) {
      endLiveRecord(state, record, record.lastCheckpointAt ?? record.currentSessionStartedAt, "startup-recovery");
    }
  }
}

export function clearUsage(state) {
  state.liveUsageRecords = {};
  state.usageSessions = [];
  Object.assign(state, emptyActivityState());
}

export function usageSummaryForTab(state, tabKey, now = Date.now()) {
  if (!tabKey) return { totalActiveMs: 0, lastActivatedAt: null };
  const cutoff = now - state.settings.usageHistoryDays * 86_400_000;
  const live = state.liveUsageRecords[tabKey];
  const completed = state.usageSessions.filter((session) => session.tabKey === tabKey && session.endedAt >= cutoff);
  const completedTotal = completed.reduce((sum, session) => sum + Math.max(0, session.endedAt - Math.max(session.startedAt, cutoff)), 0);
  const openTotal = live?.currentSessionStartedAt != null ? Math.max(0, now - Math.max(live.currentSessionStartedAt, cutoff)) : 0;
  const metadata = state.usageTabMetadata?.[tabKey];
  const latestCompleted = completed.reduce((latest, session) => Math.max(latest, session.foregroundActivatedAt ?? session.startedAt), 0);
  return {
    totalActiveMs: completedTotal + openTotal,
    // The UI says "last active": a later foreground observation is evidence of
    // activity, while metadata still distinguishes it from an actual activation.
    lastActivatedAt: Math.max(metadata?.lastActivatedAt ?? 0, live?.lastActivatedAt ?? 0,
      metadata?.lastForegroundObservedAt ?? 0, latestCompleted) || null,
  };
}
