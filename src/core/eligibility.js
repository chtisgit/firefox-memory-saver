const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export function hostnameMatches(hostname, protectedDomain) {
  return hostname === protectedDomain || hostname.endsWith(`.${protectedDomain}`);
}

export function inspectEligibility(tab, settings, now = Date.now(), options = {}) {
  const ignoreInactivity = Boolean(options.ignoreInactivity);
  if (!Number.isInteger(tab?.id)) return { eligible: false, reason: "missing-id" };
  if (tab.active) return { eligible: false, reason: "active" };
  if (tab.discarded) return { eligible: false, reason: "already-discarded" };
  if (settings.protectPinned && tab.pinned) return { eligible: false, reason: "pinned" };
  if (settings.protectAudible && tab.audible) return { eligible: false, reason: "audible" };

  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return { eligible: false, reason: "unsupported-url" };
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return { eligible: false, reason: "unsupported-url" };
  if (settings.protectedDomains.some((domain) => hostnameMatches(url.hostname.toLowerCase(), domain))) {
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
  const loadedTabs = tabs.filter((tab) => !tab.discarded);
  const budget = Math.max(0, loadedTabs.length - settings.minimumLoadedTabsPerWindow);
  return tabs
    .filter((tab) => inspectEligibility(tab, settings, now, options).eligible)
    .sort((a, b) => (a.lastAccessed ?? Number.MAX_SAFE_INTEGER) - (b.lastAccessed ?? Number.MAX_SAFE_INTEGER))
    .slice(0, budget);
}

export function selectEligibleByWindow(tabs, settings, now = Date.now(), options = {}) {
  const grouped = new Map();
  for (const tab of tabs) {
    if (!grouped.has(tab.windowId)) grouped.set(tab.windowId, []);
    grouped.get(tab.windowId).push(tab);
  }
  return [...grouped.values()].flatMap((windowTabs) => selectEligibleTabs(windowTabs, settings, now, options));
}
