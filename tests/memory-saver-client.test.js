import { API_VERSION, MAX_TIMEOUT_SECONDS, MEMORY_SAVER_ID, MemorySaverClient, MemorySaverError } from "../integrations/memory-saver-client.js";
import { recorderHarness } from "./recorder.test.js";

async function expectError(equal, operation, code) {
  try { await operation(); } catch (error) {
    equal(error instanceof MemorySaverError, true);
    equal(error.name, "MemorySaverError");
    equal(error.code, code);
    return error;
  }
  throw new Error(`Expected ${code}`);
}

export function registerClientTests(test, equal) {
  test("standalone client addresses Memory Saver and returns validated API data", async () => {
    const calls = [];
    const runtime = {
      async sendMessage(id, message) {
        equal(this === runtime, true);
        calls.push({ id, message });
        if (message.type === "get-api-info") return { ok: true, data: { apiVersion: 1, maxTimeoutSeconds: 3600 } };
        if (message.type === "release-all-protected-tabs") return { ok: true, data: { apiVersion: 1, releasedTabIds: [456] } };
        return { ok: true, data: { apiVersion: 1, tabId: message.tabId, expiresAt: message.type === "release-protected-tab" ? null : 1800000000000 } };
      },
    };
    const client = new MemorySaverClient({ runtime });
    equal(await client.getApiInfo(), { apiVersion: 1, maxTimeoutSeconds: 3600 });
    equal(await client.protect(123, { timeoutSeconds: MAX_TIMEOUT_SECONDS }), { apiVersion: 1, tabId: 123, expiresAt: 1800000000000 });
    equal(await client.protect(456, { timeoutSeconds: 60 }), { apiVersion: 1, tabId: 456, expiresAt: 1800000000000 });
    equal(await client.release(123), { apiVersion: 1, tabId: 123, expiresAt: null });
    equal(await client.releaseAll(), { apiVersion: 1, releasedTabIds: [456] });
    equal(calls, [
      { id: MEMORY_SAVER_ID, message: { apiVersion: API_VERSION, type: "get-api-info" } },
      { id: MEMORY_SAVER_ID, message: { apiVersion: API_VERSION, type: "set-protected-tab", tabId: 123, timeoutSeconds: MAX_TIMEOUT_SECONDS } },
      { id: MEMORY_SAVER_ID, message: { apiVersion: API_VERSION, type: "set-protected-tab", tabId: 456, timeoutSeconds: 60 } },
      { id: MEMORY_SAVER_ID, message: { apiVersion: API_VERSION, type: "release-protected-tab", tabId: 123 } },
      { id: MEMORY_SAVER_ID, message: { apiVersion: API_VERSION, type: "release-all-protected-tabs" } },
    ]);
  });

  test("client preserves API error codes and explanations without retries", async () => {
    for (const code of ['API_DISABLED', 'INVALID_TAB_ID', 'INVALID_TIMEOUT', 'INVALID_SENDER', 'TAB_NOT_FOUND', 'TAB_DISCARDED', 'INTERNAL_ERROR', 'UNSUPPORTED_API_VERSION', 'FUTURE_ERROR']) {
      let calls = 0;
      const client = new MemorySaverClient({ runtime: { async sendMessage() {
        calls++;
        return { ok: false, error: { code, message: `Explanation for ${code}` } };
      } } });
      const error = await expectError(equal, () => client.protect(123, { timeoutSeconds: MAX_TIMEOUT_SECONDS }), code);
      equal(error.message, `Explanation for ${code}`);
      equal(calls, 1);
    }
  });

  test("client distinguishes transport unavailability and preserves the original cause", async () => {
    const cause = new Error('Receiving end does not exist');
    const client = new MemorySaverClient({ runtime: { async sendMessage() { throw cause; } } });
    equal((await expectError(equal, () => client.getApiInfo(), 'UNAVAILABLE')).cause === cause, true);
    await expectError(equal, () => new MemorySaverClient({ runtime: null }).getApiInfo(), 'UNAVAILABLE');
    await expectError(equal, () => new MemorySaverClient({ runtime: {} }).release(123), 'UNAVAILABLE');
  });

  test("client rejects malformed responses rather than reporting protection", async () => {
    for (const response of [undefined, null, false, [], {}, { ok: 'true' },
      { ok: false, error: 'Old API error' }, { ok: false, error: {} },
      { ok: false, error: { code: 123, message: 'Error' } }, { ok: false, error: { code: 'ERROR', message: '' } },
      { ok: true, data: null }, { ok: true, data: { apiVersion: '1', tabId: 123, expiresAt: 1800000000000 } },
      { ok: true, data: { apiVersion: 1, tabId: 456, expiresAt: 1800000000000 } },
      { ok: true, data: { apiVersion: 1, tabId: 123, expiresAt: '1800000000000' } },
      { ok: true, data: { apiVersion: 1, tabId: 123, expiresAt: 0 } },
      { ok: true, data: { apiVersion: 1, tabId: 123, expiresAt: Infinity } }]) {
      const client = new MemorySaverClient({ runtime: { async sendMessage() { return response; } } });
      await expectError(equal, () => client.protect(123, { timeoutSeconds: MAX_TIMEOUT_SECONDS }), 'INVALID_RESPONSE');
    }
    const client = new MemorySaverClient({ runtime: { async sendMessage() { return { ok: true, data: { apiVersion: 2 } }; } } });
    await expectError(equal, () => client.getApiInfo(), 'UNSUPPORTED_API_VERSION');
  });

  test("client validates discovery and release responses", async () => {
    for (const maxTimeoutSeconds of [undefined, 0, 3601, '3600', 1.5]) {
      const client = new MemorySaverClient({ runtime: { async sendMessage() { return { ok: true, data: { apiVersion: 1, maxTimeoutSeconds } }; } } });
      await expectError(equal, () => client.getApiInfo(), 'INVALID_RESPONSE');
    }
    for (const data of [{ apiVersion: 1 }, { apiVersion: 1, tabId: 456, expiresAt: null }, { apiVersion: 1, tabId: 123, expiresAt: 123 }]) {
      const client = new MemorySaverClient({ runtime: { async sendMessage() { return { ok: true, data }; } } });
      await expectError(equal, () => client.release(123), 'INVALID_RESPONSE');
    }
  });

  test("client rejects malformed release-all confirmations", async () => {
    for (const releasedTabIds of [undefined, null, [123, 123], [-1], [1.5], ["123"]]) {
      const client = new MemorySaverClient({ runtime: { async sendMessage() {
        return { ok: true, data: { apiVersion: 1, releasedTabIds } };
      } } });
      await expectError(equal, () => client.releaseAll(), 'INVALID_RESPONSE');
    }
  });

  test("invalid client arguments are rejected before sending any request", async () => {
    let calls = 0;
    const client = new MemorySaverClient({ runtime: { async sendMessage() { calls++; } } });
    for (const tabId of [undefined, null, -1, 1.5, '123', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expectError(equal, () => client.protect(tabId), 'INVALID_TAB_ID');
      await expectError(equal, () => client.release(tabId), 'INVALID_TAB_ID');
    }
    for (const timeoutSeconds of [undefined, null, 0, -1, 3601, 1.5, '60', NaN, Infinity]) {
      await expectError(equal, () => client.protect(123, { timeoutSeconds }), 'INVALID_TIMEOUT');
    }
    for (const options of [undefined, null, {}]) {
      await expectError(equal, () => client.protect(123, options), 'INVALID_TIMEOUT');
    }
    equal(calls, 0);
  });

  test("client uses browser.runtime by default and performs no work until called", async () => {
    const original = globalThis.browser;
    let calls = 0;
    try {
      globalThis.browser = { runtime: { async sendMessage() { calls++; return { ok: true, data: { apiVersion: 1, maxTimeoutSeconds: 3600 } }; } } };
      const client = new MemorySaverClient();
      equal(calls, 0);
      await client.getApiInfo();
      equal(calls, 1);
    } finally { globalThis.browser = original; }
  });

  test("client interoperates with actual API handlers for multiple tabs, renewal, release, and user opt-out", async () => {
    const h = await recorderHarness({ enabled: false });
    try {
      const runtime = { sendMessage(id, request) {
        equal(id, MEMORY_SAVER_ID);
        return h.external(request, 'client-test@example.org');
      } };
      const client = new MemorySaverClient({ runtime });
      equal((await client.getApiInfo()).maxTimeoutSeconds, 3600);
      equal((await client.protect(2002, { timeoutSeconds: MAX_TIMEOUT_SECONDS })).expiresAt, h.now() + 3600000);
      h.advance(1000);
      equal((await client.protect(2002, { timeoutSeconds: 1 })).expiresAt, h.now() + 1000);
      // Instances share the caller's leases, but each tab has its own lease.
      const otherClient = new MemorySaverClient({ runtime });
      await otherClient.protect(2001, { timeoutSeconds: MAX_TIMEOUT_SECONDS });
      let view = await h.request({ type: 'GET_POPUP_STATE' });
      equal(view.protectedTabs.map(t => t.id), [2001, 2002]);
      await client.release(2002);
      view = await h.request({ type: 'GET_POPUP_STATE' });
      equal(view.protectedTabs.map(t => t.id), [2001]);
      equal(await otherClient.releaseAll(), { apiVersion: 1, releasedTabIds: [2001] });
      equal((await h.request({ type: 'GET_POPUP_STATE' })).protectedTabs, []);
      await expectError(equal, () => client.protect(9999, { timeoutSeconds: MAX_TIMEOUT_SECONDS }), 'TAB_NOT_FOUND');
      await h.request({ type: 'SAVE_SETTINGS', settings: { ...h.state().settings, allowExternalProtection: false } });
      await expectError(equal, () => client.getApiInfo(), 'API_DISABLED');
      await expectError(equal, () => client.protect(2002, { timeoutSeconds: MAX_TIMEOUT_SECONDS }), 'API_DISABLED');
      await expectError(equal, () => client.release(2002), 'API_DISABLED');
      await expectError(equal, () => client.releaseAll(), 'API_DISABLED');
    } finally { await h.dispose(); }
  });
}
