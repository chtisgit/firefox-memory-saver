import { ACTIVITY_SCHEMA_VERSION, emptyActivityState } from "./activity.js";

export const STORAGE_KEY = "memorySaverState";

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  enabled: true,
  inactivityMinutes: 10,
  scanIntervalMinutes: 1,
  minimumLoadedTabsPerWindow: 2,
  minimumLoadedTabsTotal: 0,
  protectPinned: true,
  protectAudible: true,
  allowExternalProtection: true,
  respectAutoDiscardable: false,
  protectedDomains: [],
  usageTrackingEnabled: false,
  usageHistoryDays: 14,
});

const limits = {
  inactivityMinutes: [5, 1440],
  scanIntervalMinutes: [1, 60],
  minimumLoadedTabsPerWindow: [0, 20],
  minimumLoadedTabsTotal: [0, 100],
  usageHistoryDays: [1, 365],
};

function boundedInteger(value, fallback, [minimum, maximum]) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

export function calculateScanInterval(inactivityMinutes) {
  return Math.min(60, Math.ceil(inactivityMinutes / 20));
}

export function normalizeDomain(value) {
  const input = String(value ?? "").trim().toLowerCase();
  if (!input) return null;
  try {
    const candidate = input.includes("://") ? input : `https://${input}`;
    const hostname = new URL(candidate).hostname.replace(/^\.+|\.+$/g, "");
    if (!hostname || hostname.includes(" ")) return null;
    return hostname;
  } catch {
    return null;
  }
}

export function normalizeSettings(value = {}) {
  const domains = Array.isArray(value.protectedDomains)
    ? [...new Set(value.protectedDomains.map(normalizeDomain).filter(Boolean))]
    : [];

  return {
    schemaVersion: 1,
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_SETTINGS.enabled,
    inactivityMinutes: boundedInteger(value.inactivityMinutes, DEFAULT_SETTINGS.inactivityMinutes, limits.inactivityMinutes),
    scanIntervalMinutes: boundedInteger(value.scanIntervalMinutes, DEFAULT_SETTINGS.scanIntervalMinutes, limits.scanIntervalMinutes),
    minimumLoadedTabsPerWindow: boundedInteger(value.minimumLoadedTabsPerWindow, DEFAULT_SETTINGS.minimumLoadedTabsPerWindow, limits.minimumLoadedTabsPerWindow),
    minimumLoadedTabsTotal: boundedInteger(value.minimumLoadedTabsTotal, DEFAULT_SETTINGS.minimumLoadedTabsTotal, limits.minimumLoadedTabsTotal),
    protectPinned: typeof value.protectPinned === "boolean" ? value.protectPinned : DEFAULT_SETTINGS.protectPinned,
    protectAudible: typeof value.protectAudible === "boolean" ? value.protectAudible : DEFAULT_SETTINGS.protectAudible,
    allowExternalProtection: typeof value.allowExternalProtection === "boolean" ? value.allowExternalProtection : DEFAULT_SETTINGS.allowExternalProtection,
    respectAutoDiscardable: typeof value.respectAutoDiscardable === "boolean" ? value.respectAutoDiscardable : DEFAULT_SETTINGS.respectAutoDiscardable,
    protectedDomains: domains,
    usageTrackingEnabled: typeof value.usageTrackingEnabled === "boolean" ? value.usageTrackingEnabled : DEFAULT_SETTINGS.usageTrackingEnabled,
    usageHistoryDays: boundedInteger(value.usageHistoryDays, DEFAULT_SETTINGS.usageHistoryDays, limits.usageHistoryDays),
  };
}

export function emptyState() {
  return {
    schemaVersion: ACTIVITY_SCHEMA_VERSION,
    ...emptyActivityState(),
    settings: { ...DEFAULT_SETTINGS },
    discardRecords: {},
    liveUsageRecords: {},
    usageSessions: [],
    lifetimeDiscardCount: 0,
  };
}

export const SETTINGS_KEY = "memorySaverSettings";
export const RUNTIME_KEY = "memorySaverRuntime";
const saved = new WeakMap();

function operationalState(value = {}) {
  return {
    discardRecords: value.discardRecords && typeof value.discardRecords === "object" ? value.discardRecords : {},
    lifetimeDiscardCount: Number.isInteger(value.lifetimeDiscardCount) && value.lifetimeDiscardCount >= 0 ? value.lifetimeDiscardCount : 0,
  };
}

export async function loadState() {
  const stored = await browser.storage.local.get([SETTINGS_KEY, RUNTIME_KEY]);
  let settings = stored[SETTINGS_KEY];
  let runtime = stored[RUNTIME_KEY];
  if (!settings || !runtime) {
    // Keep preferences and ordinary operational data ONLY. Legacy history is
    // deliberately discarded, never imported into the new history database.
    const legacy = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY] ?? {};
    settings = normalizeSettings(settings ?? legacy.settings);
    runtime = operationalState(runtime ?? legacy);
    await browser.storage.local.set({ [SETTINGS_KEY]: settings, [RUNTIME_KEY]: runtime });
  }
  // Idempotent cleanup also handles interruption after writing the small keys.
  await browser.storage.local.remove(STORAGE_KEY);
  const state = { ...emptyState(), settings: normalizeSettings(settings), ...operationalState(runtime), historyBuffered: true };
  saved.set(state, { settings: JSON.stringify(state.settings), runtime: JSON.stringify(operationalState(state)) });
  return state;
}

export async function loadSettings() {
  const settings = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  return settings ? normalizeSettings(settings) : (await loadState()).settings;
}

export async function saveState(state) {
  const settings = normalizeSettings(state.settings);
  const runtime = operationalState(state);
  const next = { settings: JSON.stringify(settings), runtime: JSON.stringify(runtime) };
  const previous = saved.get(state) ?? {};
  const updates = {};
  if (next.settings !== previous.settings) updates[SETTINGS_KEY] = settings;
  if (next.runtime !== previous.runtime) updates[RUNTIME_KEY] = runtime;
  if (Object.keys(updates).length) await browser.storage.local.set(updates);
  state.settings = settings;
  saved.set(state, next);
  return state;
}
