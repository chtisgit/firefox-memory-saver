import { getTabKey } from "./usage.js";

export const EXTERNAL_API_VERSION = 1;
export const MAX_PROTECTION_SECONDS = 3600;
export const EXTERNAL_PROTECTION_ALARM = "memory-saver-external-protection";
const STORAGE_KEY = "memorySaverExternalProtections";

export class ExternalProtectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExternalProtectionError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new ExternalProtectionError(code, message);
}

// Independent renewable leases per sender ID and tab. Session storage survives
// background suspension, but cannot carry numeric tab IDs into a new session.
export class ExternalProtection {
  leases = [];

  async schedule() {
    await browser.alarms.clear(EXTERNAL_PROTECTION_ALARM);
    if (this.leases.length) {
      await browser.alarms.create(EXTERNAL_PROTECTION_ALARM, {
        when: Math.min(...this.leases.map((lease) => lease.expiresAt)),
      });
    }
  }

  async save(leases) {
    await browser.storage.session.set({ [STORAGE_KEY]: leases });
    this.leases = leases;
    await this.schedule();
  }

  async load(tabs) {
    const stored = (await browser.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
    this.leases = Array.isArray(stored) ? stored : [];
    await this.prune(tabs);
    await this.schedule();
  }

  async prune(tabs, now = Date.now()) {
    const live = new Map(tabs.map((tab) => [tab.id, tab]));
    const valid = [];
    const pairs = new Set();
    for (const lease of this.leases) {
      if (!lease || typeof lease.extensionId !== "string" || !lease.extensionId
        || pairs.has(JSON.stringify([lease.extensionId, lease.tabId])) || !Number.isSafeInteger(lease.tabId) || lease.tabId < 0
        || typeof lease.tabKey !== "string" || !lease.tabKey
        || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= now
        || lease.expiresAt > now + MAX_PROTECTION_SECONDS * 1000
        || !live.has(lease.tabId)) continue;
      if (await getTabKey(lease.tabId, false) !== lease.tabKey) continue;
      valid.push(lease);
      pairs.add(JSON.stringify([lease.extensionId, lease.tabId]));
    }
    if (valid.length !== this.leases.length) {
      await this.save(valid);
      return true;
    }
    return false;
  }

  forTab(tabId, now = Date.now()) {
    return this.leases.filter((lease) => lease.tabId === tabId && lease.expiresAt > now)
      .map(({ extensionId, expiresAt }) => ({ extensionId, expiresAt }));
  }

  async clear() {
    const changed = this.leases.length > 0;
    // Persist an explicit opt-out even if a prior load failed or memory is empty.
    this.leases = [];
    await this.save([]);
    return changed;
  }

  async forgetTab(tabId) {
    const remaining = this.leases.filter((lease) => lease.tabId !== tabId);
    if (remaining.length === this.leases.length) return false;
    // A closed/replaced tab must lose its in-memory leases even if storage fails.
    // Startup validates persisted leases against live tab identities before use.
    this.leases = remaining;
    await this.save(remaining);
    return true;
  }

  async handle(message, sender) {
    if (typeof sender?.id !== "string" || !sender.id || sender.id === browser.runtime.id) {
      reject("INVALID_SENDER", "A request must come from another extension.");
    }
    if (!message || message.apiVersion !== EXTERNAL_API_VERSION) {
      reject("UNSUPPORTED_API_VERSION", "Use apiVersion: 1.");
    }
    if (message.type === "get-api-info") {
      return { apiVersion: EXTERNAL_API_VERSION, maxTimeoutSeconds: MAX_PROTECTION_SECONDS };
    }
    if (message.type === "release-all-protected-tabs") {
      const releasedTabIds = this.leases.filter((item) => item.extensionId === sender.id).map((item) => item.tabId);
      await this.save(this.leases.filter((item) => item.extensionId !== sender.id));
      return { apiVersion: EXTERNAL_API_VERSION, releasedTabIds };
    }
    if (!["set-protected-tab", "release-protected-tab"].includes(message.type)) {
      reject("UNKNOWN_REQUEST", "Unknown external request.");
    }
    const { tabId, timeoutSeconds } = message;
    if (!Number.isSafeInteger(tabId) || tabId < 0) {
      reject("INVALID_TAB_ID", "tabId must be a nonnegative safe integer.");
    }
    const remaining = this.leases.filter((item) => item.extensionId !== sender.id || item.tabId !== tabId);
    if (message.type === "release-protected-tab") {
      // Release is idempotent, including after the target has closed or expired.
      await this.save(remaining);
      return { apiVersion: EXTERNAL_API_VERSION, tabId, expiresAt: null };
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_PROTECTION_SECONDS) {
      reject("INVALID_TIMEOUT", "timeoutSeconds must be an integer from 1 to 3600.");
    }
    let tab;
    try { tab = await browser.tabs.get(tabId); } catch {
      reject("TAB_NOT_FOUND", "The requested tab is not accessible or no longer exists.");
    }
    if (!tab) reject("TAB_NOT_FOUND", "The requested tab is not accessible or no longer exists.");
    if (tab.discarded) reject("TAB_DISCARDED", "Restore the tab before requesting protection.");
    const tabKey = await getTabKey(tabId);
    const lease = { extensionId: sender.id, tabId, tabKey, expiresAt: Date.now() + timeoutSeconds * 1000 };
    // A renewal replaces only this sender/tab pair; all other leases stay intact.
    await this.save([...remaining, lease]);
    return { apiVersion: EXTERNAL_API_VERSION, tabId, expiresAt: lease.expiresAt };
  }
}
