// Recording primitives only. Activity views can derive tab/site/day aggregates later.
export const ACTIVITY_SCHEMA_VERSION = 2;
export const MAX_USAGE_SESSIONS = 10_000;
export const MAX_DISCARD_EVENTS = 10_000;
export const MAX_COVERAGE_SEGMENTS = 10_000;
export const MAX_CONTINUITY_MS = 10 * 60_000;

export function activityId() {
  return globalThis.crypto?.randomUUID?.() ?? `activity-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function emptyActivityState() {
  return {
    usageDiscardEvents: [],
    usageTabMetadata: {},
    usageCoverage: {
      historyId: null,
      recordingStartedAt: null,
      legacyHistory: false,
      segments: [],
      incompleteBefore: { sessions: null, discards: null, coverage: null },
      retentionBefore: { sessions: null, discards: null, coverage: null },
      capBefore: { sessions: null, discards: null, coverage: null },
    },
    usageRecorder: { browserSessionId: null, revision: 0 },
  };
}

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function normalizeActivityState(value = {}) {
  const initial = emptyActivityState();
  const coverage = object(value.usageCoverage) ? value.usageCoverage : {};
  const recorder = object(value.usageRecorder) ? value.usageRecorder : {};
  return {
    usageDiscardEvents: Array.isArray(value.usageDiscardEvents) ? value.usageDiscardEvents : [],
    usageTabMetadata: object(value.usageTabMetadata) ? value.usageTabMetadata : {},
    usageCoverage: {
      ...initial.usageCoverage,
      ...coverage,
      legacyHistory: coverage.legacyHistory === true || (value.schemaVersion !== ACTIVITY_SCHEMA_VERSION
        && (value.usageSessions?.length > 0 || Object.keys(value.liveUsageRecords ?? {}).length > 0)),
      segments: Array.isArray(coverage.segments) ? coverage.segments : [],
      incompleteBefore: { ...initial.usageCoverage.incompleteBefore, ...(object(coverage.incompleteBefore) ? coverage.incompleteBefore : {}) },
      retentionBefore: { ...initial.usageCoverage.retentionBefore, ...(object(coverage.retentionBefore) ? coverage.retentionBefore : {}) },
      capBefore: { ...initial.usageCoverage.capBefore, ...(object(coverage.capBefore) ? coverage.capBefore : {}) },
    },
    usageRecorder: {
      browserSessionId: typeof recorder.browserSessionId === 'string' ? recorder.browserSessionId : null,
      revision: Number.isSafeInteger(recorder.revision) ? recorder.revision : 0,
    },
  };
}

export function ensureActivityState(state) {
  if (!state.usageCoverage || !state.usageTabMetadata || !state.usageDiscardEvents || !state.usageRecorder) {
    Object.assign(state, normalizeActivityState(state));
  }
}

export function observeTab(state, tabKey, tab, now, { snapshot = false } = {}) {
  ensureActivityState(state);
  const metadata = state.usageTabMetadata[tabKey] ?? {
    tabKey,
    firstObservedAt: now,
    currentObservedSince: now,
    lastActivatedAt: state.liveUsageRecords?.[tabKey]?.lastActivatedAt ?? null,
    lastActivationSource: state.liveUsageRecords?.[tabKey]?.lastActivatedAt != null ? "legacy" : null,
    lastForegroundObservedAt: null,
    lastAccessedAt: null,
    lastAccessedSource: null,
    isDiscarded: Boolean(tab.discarded),
    discardEpisodeRecorded: false,
  };
  if (metadata.closedAt != null) metadata.currentObservedSince = now;
  Object.assign(metadata, { tabId: tab.id, windowId: tab.windowId, lastObservedAt: now, closedAt: null });
  if (snapshot) {
    if (metadata.isDiscarded !== Boolean(tab.discarded)) metadata.discardEpisodeRecorded = false;
    metadata.isDiscarded = Boolean(tab.discarded);
  }
  if (Number.isFinite(tab.lastAccessed) && tab.lastAccessed > 0 && tab.lastAccessed <= now
    && (metadata.lastAccessedAt == null || tab.lastAccessed > metadata.lastAccessedAt)) {
    metadata.lastAccessedAt = tab.lastAccessed;
    metadata.lastAccessedSource = 'firefox';
  }
  state.usageTabMetadata[tabKey] = metadata;
  return metadata;
}

export function noteTabAccess(metadata, now) {
  metadata.lastAccessedAt = Math.max(metadata.lastAccessedAt ?? now, now);
  metadata.lastAccessedSource = 'activation-observed';
}

export function recordDiscard(state, tabKey, tab, source, now) {
  // An actual transition notification/API confirmation establishes a new tab as loaded
  // before that transition. Startup snapshots instead use observeTab(snapshot: true).
  const metadata = observeTab(state, tabKey, { ...tab, discarded: false }, now);
  if (metadata.isDiscarded && metadata.discardEpisodeRecorded) return null;
  metadata.isDiscarded = true;
  metadata.discardEpisodeRecorded = true;
  const event = {
    eventId: activityId(), tabKey, observedAt: now,
    tabIdAtTime: tab.id, windowIdAtTime: tab.windowId,
    url: tab.url ?? '', title: tab.title ?? '', source,
  };
  state.usageDiscardEvents.push(event);
  return event;
}

export function markTabLoaded(state, tabKey) {
  const metadata = state.usageTabMetadata?.[tabKey];
  if (metadata) {
    metadata.isDiscarded = false;
    metadata.discardEpisodeRecorded = false;
  }
}

export function closeTabMetadata(state, tabId, now) {
  for (const metadata of Object.values(state.usageTabMetadata ?? {})) {
    if (metadata.tabId === tabId && metadata.closedAt == null) {
      metadata.closedAt = now;
      delete metadata.tabId;
      delete metadata.windowId;
    }
  }
}

export function captureRecordingContext(state) {
  return state ? { enabled: state.settings.usageTrackingEnabled, historyId: state.usageCoverage?.historyId } : null;
}

export function acceptsRecordingEvent(state, context, now) {
  if (!state.settings.usageTrackingEnabled || state.usageCoverage.recordingStartedAt == null) return false;
  if (context && (!context.enabled || context.historyId !== state.usageCoverage.historyId)) return false;
  return now >= (state.usageCoverage.segments.at(-1)?.startedAt ?? state.usageCoverage.recordingStartedAt);
}

export function noteObservationError(state, now) {
  const segment = state.usageCoverage?.segments.at(-1);
  if (!segment) return;
  segment.observationErrors = true;
  segment.observationErrorsFrom = Math.min(segment.observationErrorsFrom ?? now, now);
  segment.observationErrorsThrough = Math.max(segment.observationErrorsThrough ?? now, now);
}

export function checkpointCoverage(state, now) {
  ensureActivityState(state);
  if (!state.settings.usageTrackingEnabled) return;
  const segment = state.usageCoverage.segments.at(-1);
  if (segment && segment.endedAt == null) segment.lastCheckpointAt = Math.max(segment.lastCheckpointAt, now);
}

export function startCoverage(state, now, reason) {
  ensureActivityState(state);
  if (state.usageCoverage.historyId == null) state.usageCoverage.historyId = activityId();
  if (state.usageCoverage.recordingStartedAt == null) state.usageCoverage.recordingStartedAt = now;
  const last = state.usageCoverage.segments.at(-1);
  if (last && last.endedAt == null) return last;
  const segment = { id: activityId(), startedAt: now, lastCheckpointAt: now, endedAt: null, startReason: reason };
  state.usageCoverage.segments.push(segment);
  return segment;
}

export function endCoverage(state, now, reason) {
  const segment = state.usageCoverage?.segments.at(-1);
  if (!segment || segment.endedAt != null) return;
  segment.endedAt = Math.max(segment.startedAt, now);
  segment.lastCheckpointAt = segment.endedAt;
  segment.endReason = reason;
}

export function canContinueRecording(state, browserSessionId, suspended, now) {
  const coverage = state.usageCoverage?.segments.at(-1);
  return Boolean(browserSessionId && suspended
    && suspended.browserSessionId === browserSessionId
    && state.usageRecorder?.browserSessionId === browserSessionId
    && suspended.revision === state.usageRecorder.revision
    && coverage && coverage.endedAt == null
    && now >= coverage.lastCheckpointAt
    && now - coverage.lastCheckpointAt <= MAX_CONTINUITY_MS);
}

function advanceBoundary(boundaries, key, timestamp) {
  boundaries[key] = Math.max(boundaries[key] ?? 0, timestamp);
}

export function pruneActivity(state, now) {
  ensureActivityState(state);
  const cutoff = now - state.settings.usageHistoryDays * 86_400_000;
  const boundaries = state.usageCoverage.incompleteBefore;
  if (state.usageCoverage.recordingStartedAt != null || state.usageSessions.length
    || state.usageDiscardEvents.length || state.usageCoverage.segments.length) {
    for (const key of ['sessions', 'discards', 'coverage']) {
      advanceBoundary(boundaries, key, cutoff);
      advanceBoundary(state.usageCoverage.retentionBefore, key, cutoff);
    }
  }
  const prune = (records, time, cap, key) => {
    const retained = records.filter((record) => Number.isFinite(time(record)) && time(record) >= cutoff);
    // Coverage retains observation order even when the wall clock moves backwards.
    if (key !== "coverage") retained.sort((a, b) => time(a) - time(b));
    if (retained.length > cap) {
      const removed = retained.splice(0, retained.length - cap);
      // Ties at the cutoff may leave only some records at this millisecond.
      const removedThrough = removed.reduce((latest, record) => Math.max(latest, time(record)), 0) + 1;
      advanceBoundary(boundaries, key, removedThrough);
      advanceBoundary(state.usageCoverage.capBefore, key, removedThrough);
    }
    return retained;
  };
  state.usageSessions = prune(state.usageSessions, (r) => r.endedAt, MAX_USAGE_SESSIONS, 'sessions');
  state.usageDiscardEvents = prune(state.usageDiscardEvents, (r) => r.observedAt, MAX_DISCARD_EVENTS, 'discards');
  state.usageCoverage.segments = prune(state.usageCoverage.segments,
    (r) => r.endedAt ?? r.lastCheckpointAt, MAX_COVERAGE_SEGMENTS, 'coverage');
  const referencedKeys = new Set([
    ...state.usageSessions.map((r) => r.tabKey),
    ...state.usageDiscardEvents.map((r) => r.tabKey),
    ...Object.keys(state.liveUsageRecords ?? {}),
  ]);
  for (const [key, metadata] of Object.entries(state.usageTabMetadata)) {
    if (metadata.closedAt != null && !referencedKeys.has(key)) delete state.usageTabMetadata[key];
  }
}
