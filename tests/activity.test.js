import {
  canContinueRecording, closeTabMetadata, endCoverage, markTabLoaded,
  MAX_CONTINUITY_MS, MAX_DISCARD_EVENTS, MAX_USAGE_SESSIONS, observeTab, recordDiscard, startCoverage,
} from "../src/core/activity.js";
import { DEFAULT_SETTINGS, emptyState, normalizeState } from "../src/core/settings.js";
import { checkpointUsage, clearUsage, endLiveRecord, recoverInterruptedUsage, usageSummaryForTab } from "../src/core/usage.js";

export function registerActivityTests(test, equal) {
  const makeState = () => ({ ...emptyState(), settings: { ...DEFAULT_SETTINGS, usageTrackingEnabled: true } });
  const tab = (id, overrides = {}) => ({ id, windowId: 1, discarded: false, url: "https://a.example/page", title: "A", lastAccessed: 100, ...overrides });

  test("activity migration preserves settings and sessions without inventing sleeps or coverage", () => {
    const session = { tabKey: "old", startedAt: 100, endedAt: 200, durationMs: 100 };
    const state = normalizeState({ schemaVersion: 1, settings: { usageTrackingEnabled: true, usageHistoryDays: 30 }, usageSessions: [session] });
    equal(state.schemaVersion, 2);
    equal(state.settings.usageHistoryDays, 30);
    equal(state.usageSessions, [session]);
    equal(state.usageDiscardEvents, []);
    equal(state.usageCoverage.legacyHistory, true);
    equal(state.usageCoverage.recordingStartedAt, null);
    equal(state.usageCoverage.segments, []);
    equal(normalizeState(state).usageCoverage.legacyHistory, true);
    equal(normalizeState({ schemaVersion: 1 }).usageCoverage.legacyHistory, false);
  });

  test("sleep episodes are deduplicated independently of discard popup records", () => {
    const state = makeState();
    observeTab(state, "a", tab(1), 1000, { snapshot: true });
    recordDiscard(state, "a", tab(1), "manual", 1100);
    recordDiscard(state, "a", tab(1, { discarded: true }), "external", 1101);
    equal(state.usageDiscardEvents.length, 1);
    equal(state.usageDiscardEvents[0].source, "manual");
    equal(state.usageDiscardEvents[0].url, "https://a.example/page");
    markTabLoaded(state, "a");
    recordDiscard(state, "a", tab(1), "automatic", 1200);
    equal(state.usageDiscardEvents.length, 2);
    equal(state.usageDiscardEvents[0].eventId !== state.usageDiscardEvents[1].eventId, true);
  });

  test("startup snapshots of sleeping tabs do not create events or invent last active", () => {
    const state = makeState();
    observeTab(state, "a", tab(1, { discarded: true }), 1000, { snapshot: true });
    equal(state.usageDiscardEvents.length, 0);
    equal(state.usageTabMetadata.a.firstObservedAt, 1000);
    equal(state.usageTabMetadata.a.lastActivatedAt, null);
    equal(state.usageTabMetadata.a.lastAccessedAt, 100);
    equal(state.usageTabMetadata.a.lastAccessedSource, "firefox");
    // A later, actual notification is evidence, unlike the startup snapshot.
    recordDiscard(state, "a", tab(1, { discarded: true }), "external", 1100);
    equal(state.usageDiscardEvents.length, 1);
  });

  test("restored tabs preserve first observation; duplicates get independent metadata", () => {
    const state = makeState();
    observeTab(state, "a", tab(1), 1000);
    closeTabMetadata(state, 1, 1100);
    observeTab(state, "a", tab(7), 1200);
    observeTab(state, "duplicate", tab(8), 1200);
    equal(state.usageTabMetadata.a.firstObservedAt, 1000);
    equal(state.usageTabMetadata.a.closedAt, null);
    equal(state.usageTabMetadata.a.tabId, 7);
    equal(state.usageTabMetadata.a.currentObservedSince, 1200);
    equal(state.usageTabMetadata.duplicate.firstObservedAt, 1200);
  });

  test("only a matching clean suspension marker allows recorder continuation", () => {
    const state = makeState();
    state.usageRecorder = { browserSessionId: "browser-1", revision: 7 };
    startCoverage(state, 1000, "recording-enabled");
    checkpointUsage(state, 2000);
    const marker = { browserSessionId: "browser-1", revision: 7 };
    equal(canContinueRecording(state, "browser-1", marker, 3000), true);
    equal(canContinueRecording(state, "browser-2", marker, 3000), false);
    equal(canContinueRecording(state, "browser-1", null, 3000), false);
    equal(canContinueRecording(state, "browser-1", { ...marker, revision: 6 }, 3000), false);
    equal(canContinueRecording(state, "browser-1", marker, 2000 + MAX_CONTINUITY_MS + 1), false);
    endCoverage(state, 2000, "recorder-interrupted");
    startCoverage(state, 3000, "recorder-start");
    equal(state.usageCoverage.segments[0].endedAt, 2000);
    equal(state.usageCoverage.segments[1].startedAt, 3000);
  });

  test("long checkpoint gaps end foreground time at the last trustworthy checkpoint", () => {
    const state = makeState();
    startCoverage(state, 1000, "recording-enabled");
    state.liveUsageRecords.a = { tabKey: "a", tabId: 1, currentSessionStartedAt: 1000, lastCheckpointAt: 2000 };
    state.usageCoverage.segments[0].lastCheckpointAt = 2000;
    const now = 2000 + MAX_CONTINUITY_MS + 1;
    equal(checkpointUsage(state, now), true);
    equal(state.usageSessions[0].endedAt, 2000);
    equal(state.usageSessions[0].durationMs, 1000);
    equal(state.usageCoverage.segments[0].endedAt, 2000);
    equal(state.usageCoverage.segments[1].startedAt, now);
    equal(state.liveUsageRecords.a.currentSessionStartedAt, undefined);
  });

  test("a backwards clock change remains explicit and keeps the current coverage segment last", () => {
    const state = makeState();
    startCoverage(state, 10000, "recording-enabled");
    checkpointUsage(state, 11000);
    equal(checkpointUsage(state, 5000), true);
    equal(state.usageCoverage.segments[0].clockDiscontinuity, true);
    equal(state.usageCoverage.segments.at(-1).startedAt, 5000);
    equal(state.usageCoverage.segments.at(-1).endedAt, null);
    equal(state.usageCoverage.segments.at(-1).clockDiscontinuity, true);
  });

  test("clearing activity removes new collections and their coverage boundaries", () => {
    const state = makeState();
    startCoverage(state, 1000, "recording-enabled");
    recordDiscard(state, "a", tab(1), "external", 1100);
    state.usageSessions.push({ tabKey: "a", startedAt: 1000, endedAt: 1100 });
    clearUsage(state);
    equal(state.usageSessions, []);
    equal(state.usageDiscardEvents, []);
    equal(state.usageTabMetadata, {});
    equal(state.usageCoverage.recordingStartedAt, null);
    equal(state.usageCoverage.segments, []);
    equal(state.settings.usageTrackingEnabled, true);
  });

  test("record caps expose separate incomplete-history boundaries", () => {
    const state = makeState();
    const now = 10 * 86_400_000;
    const start = now - 20_000;
    state.usageSessions = Array.from({ length: MAX_USAGE_SESSIONS + 1 }, (_, i) => ({ tabKey: "a", startedAt: start + i, endedAt: start + i + 1 }));
    state.usageDiscardEvents = Array.from({ length: MAX_DISCARD_EVENTS + 1 }, (_, i) => ({ tabKey: "a", observedAt: start + i }));
    checkpointUsage(state, now);
    equal(state.usageSessions.length, MAX_USAGE_SESSIONS);
    equal(state.usageDiscardEvents.length, MAX_DISCARD_EVENTS);
    equal(state.usageCoverage.incompleteBefore.sessions, start + 2);
    equal(state.usageCoverage.incompleteBefore.discards, start + 1);
    equal(state.usageCoverage.capBefore.sessions, start + 2);
    equal(state.usageCoverage.capBefore.discards, start + 1);
  });

  test("retention prunes closed metadata but retains referenced and open tab identities", () => {
    const state = makeState();
    const day = 86_400_000;
    const now = 20 * day;
    state.settings.usageHistoryDays = 1;
    observeTab(state, "expired", tab(1), day);
    observeTab(state, "referenced", tab(2), day);
    observeTab(state, "open", tab(3), day);
    closeTabMetadata(state, 1, day + 1);
    closeTabMetadata(state, 2, day + 1);
    state.usageSessions = [{ tabKey: "expired", startedAt: day, endedAt: day + 1 }];
    state.usageDiscardEvents = [{ tabKey: "referenced", observedAt: now - 1 }];
    checkpointUsage(state, now);
    equal(state.usageTabMetadata.expired, undefined);
    equal(Boolean(state.usageTabMetadata.referenced), true);
    equal(Boolean(state.usageTabMetadata.open), true);
    equal(state.usageCoverage.incompleteBefore.sessions, now - day);
    state.settings.usageHistoryDays = 365;
    checkpointUsage(state, now);
    equal(state.usageCoverage.incompleteBefore.sessions, now - day);
  });

  test("recorded intervals support tab/site totals and the closed-tab denominator", () => {
    const state = makeState();
    const first = { tabKey: "open", tabId: 1, currentSessionStartedAt: 100, currentUrl: "https://a.example", currentTitle: "A", lastActivatedAt: 100, startReason: "tab-activation" };
    endLiveRecord(state, first, 200, "navigation");
    first.currentSessionStartedAt = 200;
    first.currentUrl = "https://b.example";
    first.startReason = "navigation";
    endLiveRecord(state, first, 300, "tab-closed");
    endLiveRecord(state, { tabKey: "closed", tabId: 2, currentSessionStartedAt: 300, currentUrl: "https://a.example" }, 500, "tab-closed");
    const bySite = {};
    for (const interval of state.usageSessions) {
      const site = new URL(interval.url).hostname;
      bySite[site] = (bySite[site] ?? 0) + interval.durationMs;
    }
    equal(bySite, { "a.example": 300, "b.example": 100 });
    const total = state.usageSessions.reduce((sum, r) => sum + r.durationMs, 0);
    equal(usageSummaryForTab(state, "open", 500).totalActiveMs / total * 100, 50);
    equal(state.usageSessions[1].foregroundActivatedAt, 100);
    equal(state.usageSessions[1].startReason, "navigation");
  });

  test("raw absolute intervals can be split at local midnight and daylight-saving boundaries", () => {
    const state = makeState();
    // Europe/Vienna's spring transition: 2026-03-29 has 23 hours.
    const midnightBefore = Date.parse("2026-03-29T00:00:00+01:00");
    const midnightAfter = Date.parse("2026-03-30T00:00:00+02:00");
    endLiveRecord(state, { tabKey: "a", currentSessionStartedAt: midnightBefore - 60_000, currentUrl: "https://a.example" }, midnightAfter + 60_000, "window-blur");
    const interval = state.usageSessions[0];
    const clipped = (start, end) => Math.max(0, Math.min(interval.endedAt, end) - Math.max(interval.startedAt, start));
    equal(clipped(midnightBefore, midnightAfter), 23 * 3_600_000);
    equal(interval.durationMs, 23 * 3_600_000 + 120_000);
    const autumnBefore = Date.parse("2026-10-25T00:00:00+02:00");
    const autumnAfter = Date.parse("2026-10-26T00:00:00+01:00");
    equal(autumnAfter - autumnBefore, 25 * 3_600_000);
    // Recovery never fabricates the offline tail of such an interval.
    state.liveUsageRecords.a = { tabKey: "a", currentSessionStartedAt: 100, lastCheckpointAt: 200 };
    recoverInterruptedUsage(state);
    equal(state.usageSessions.at(-1).endedAt, 200);
  });
}
