const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export function hostnameMatches(hostname, protectedDomain) {
  return hostname === protectedDomain || hostname.endsWith(`.${protectedDomain}`);
}

export function protectedHostname(urlValue, protectedDomains) {
  try {
    const url = new URL(urlValue);
    if (!ALLOWED_SCHEMES.has(url.protocol)) return null;
    const hostname = url.hostname.toLowerCase();
    return protectedDomains.some((domain) => hostnameMatches(hostname, domain)) ? hostname : null;
  } catch {
    return null;
  }
}

export function protectionReasons(tab, settings) {
  if (!Number.isInteger(tab?.id) || tab.discarded) return [];

  const reasons = [];
  if (tab.memorySaverProtected) reasons.push({ type: "tab" });
  if (settings.protectPinned && tab.pinned) reasons.push({ type: "pinned" });
  if (settings.protectAudible && tab.audible) reasons.push({ type: "audible" });

  try {
    const url = new URL(tab.url);
    if (!ALLOWED_SCHEMES.has(url.protocol)) {
      reasons.push({ type: "special-page" });
    } else {
      const hostname = url.hostname.toLowerCase();
      const domain = settings.protectedDomains.find((candidate) => hostnameMatches(hostname, candidate));
      if (domain) reasons.push({ type: "domain", domain });
    }
  } catch {
    reasons.push({ type: "special-page" });
  }

  return reasons;
}

export function inspectEligibility(tab, settings, now = Date.now(), options = {}) {
  const ignoreInactivity = Boolean(options.ignoreInactivity);
  if (!Number.isInteger(tab?.id)) return { eligible: false, reason: "missing-id" };
  if (tab.active) return { eligible: false, reason: "active" };
  if (tab.discarded) return { eligible: false, reason: "already-discarded" };
  if (tab.memorySaverProtected) return { eligible: false, reason: "protected-tab" };
  if (settings.protectPinned && tab.pinned) return { eligible: false, reason: "pinned" };
  if (settings.protectAudible && tab.audible) return { eligible: false, reason: "audible" };

  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return { eligible: false, reason: "unsupported-url" };
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return { eligible: false, reason: "unsupported-url" };
  if (protectedHostname(tab.url, settings.protectedDomains)) {
    return { eligible: false, reason: "protected-domain" };
  }

  if (!ignoreInactivity) {
    if (!Number.isFinite(tab.lastAccessed)) return { eligible: false, reason: "unknown-last-access" };
    const inactiveFor = now - tab.lastAccessed;
    if (inactiveFor < settings.inactivityMinutes * 60_000) return { eligible: false, reason: "recently-active" };
  }
  return { eligible: true };
}

export function selectEligibleTabs(tabs, settings, now = Date.now(), options = {}) {
  return selectEligibleByWindow(tabs, settings, now, options);
}

export function selectEligibleByWindow(tabs, settings, now = Date.now(), options = {}) {
  const loadedCounts = new Map();
  // Count inactive, unprotected tabs even when they have not reached the timeout.
  const loadedTabs = tabs.filter((tab) => inspectEligibility(tab, settings, now, { ignoreInactivity: true }).eligible);
  for (const tab of loadedTabs) {
    loadedCounts.set(tab.windowId, (loadedCounts.get(tab.windowId) ?? 0) + 1);
  }
  let budget = Math.max(0, loadedTabs.length - (settings.minimumLoadedTabsTotal ?? 0));
  const candidates = tabs
    .filter((tab) => (options.windowId == null || tab.windowId === options.windowId)
      && inspectEligibility(tab, settings, now, options).eligible)
    .sort((a, b) => (a.lastAccessed ?? Number.MAX_SAFE_INTEGER) - (b.lastAccessed ?? Number.MAX_SAFE_INTEGER));
  const selected = [];
  for (const tab of candidates) {
    if (!budget) break;
    const windowCount = loadedCounts.get(tab.windowId) ?? 0;
    if (windowCount <= settings.minimumLoadedTabsPerWindow) continue;
    selected.push(tab);
    loadedCounts.set(tab.windowId, windowCount - 1);
    budget -= 1;
  }
  return selected;
}
