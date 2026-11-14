# Protect tabs with the Memory Saver client

Use this lightweight JavaScript client to ask Memory Saver to keep tabs loaded.
It is the recommended starting point for other Firefox extension developers:
no dependencies, npm installation, or build step are required.

Your extension can protect **multiple tabs independently**. Each tab's protection
lasts up to one hour per request and can be renewed. Protecting one tab never
releases another tab, and multiple extensions can protect the same tab.

The client and API are in the development sources; the tagged v0.3.0 release
does not include them. Handle unavailable or older installations as shown below.

## Add the client to your extension

Copy [`memory-saver-client.js`](../integrations/memory-saver-client.js) into your
extension, for example as `vendor/memory-saver-client.js`. Retain the MIT license
notice included in the file.

Import it from an ES module in your background script or an extension page:

```js
import { MemorySaverClient, MemorySaverError } from "./vendor/memory-saver-client.js";

const memorySaver = new MemorySaverClient();
```

The client handles Memory Saver's extension ID and message format. No extra
permission is needed just to use it. Obtain target tab IDs using your extension's
own logic. Route content-script requests through your background script.

## Protect and renew tabs

Pass the ID of an existing, loaded tab:

```js
try {
  const lease = await memorySaver.protect(targetTabId, { timeoutSeconds: 3600 });
  // Explicitly request one hour. expiresAt is a Unix timestamp in milliseconds.
  console.info("Protection confirmed until", new Date(lease.expiresAt));
} catch (error) {
  if (!(error instanceof MemorySaverError)) throw error;
  if (error.code === "API_DISABLED") {
    console.info("Memory Saver protection is disabled by the user.");
  } else {
    console.warn("Protection could not be confirmed:", error.code, error.message);
  }
}
```

Only treat protection as confirmed after success and while the returned deadline
is still in the future. A failed call does not confirm protection.

Call the same method for every tab you need. Every acquisition and renewal must
explicitly supply `timeoutSeconds`, an integer from **1 to 3600 seconds**. There
is no default; omitting it returns `INVALID_TIMEOUT` before sending a request:

```js
const firstLease = await memorySaver.protect(firstTabId, { timeoutSeconds: 300 });
const secondLease = await memorySaver.protect(secondTabId, { timeoutSeconds: 3600 });
```

Both tabs remain protected. Calling
`protect(firstTabId, { timeoutSeconds: 300 })` again changes only that tab's
deadline; it neither renews nor releases the second tab. Handle errors
for these calls as in the first example. Each tab needs its own successful request.

## Release protection

Release only the tab you no longer need:

```js
try {
  await memorySaver.release(targetTabId);
} catch (error) {
  console.warn("Release could not be confirmed:", error.code, error.message);
}
```

Your other tabs remain protected. To remove all protections requested by your
extension, use `await memorySaver.releaseAll()` with the same error handling.
Release operations are safe to repeat, including after a tab closes or a lease
expires. They cannot remove manual protection or another extension's requests.

To change from one target to another, protect the new tab and explicitly release
the old one. Acquiring first lets you check success before releasing the old tab.

## Available methods

All methods return Promises. Success returns these objects directly:

| Method | Result |
| --- | --- |
| `getApiInfo()` | `{ apiVersion: 1, maxTimeoutSeconds: 3600 }` |
| `protect(tabId, { timeoutSeconds })` | `{ apiVersion: 1, tabId, expiresAt }` |
| `release(tabId)` | `{ apiVersion: 1, tabId, expiresAt: null }` |
| `releaseAll()` | `{ apiVersion: 1, releasedTabIds: [...] }` |

`getApiInfo()` is optional; every operation checks its response independently.
Use `release(tabId)` for one tab, not `protect(null)` or `release()` without an ID.
Client instances in the same extension share ownership: one instance can release
that extension's leases acquired by another instance. There is no need to create
an instance per tab.

## Keeping protection active

The client does not schedule renewals or retry automatically. Renew each needed
tab before its deadline—for example, request one hour and renew every 15 minutes.
Use `browser.alarms` in event-driven backgrounds rather than relying on
`setInterval` surviving suspension. Always read your current desired set of tabs. Renew
only while your application's current state still justifies protection. A stale
saved list renewed indefinitely defeats the timeout's cleanup safeguard.

This generic background-module example uses the `memorySaver` instance above.
Add `"alarms"` and `"storage"` to your extension's permissions. It serializes
updates and renewals, stores desired tab IDs for the current browser session,
and stops automatic requests when the user disables the API:

```js
const RENEW_ALARM = "memory-saver-renewal";
const STATE_KEY = "memorySaverProtectionTargets";
let pending = Promise.resolve();

function serialize(task) {
  const result = pending.then(task, task);
  pending = result.catch(() => {});
  return result;
}

function reportFailure(error) {
  console.warn("Memory Saver protection is unconfirmed:", error.code, error.message);
}

async function syncProtection() {
  const stored = await browser.storage.session.get(STATE_KEY);
  const { tabIds = [], paused = false } = stored[STATE_KEY] ?? {};
  if (paused) return;
  if (!tabIds.length) {
    await browser.alarms.clear(RENEW_ALARM);
    return;
  }
  await browser.alarms.create(RENEW_ALARM, { periodInMinutes: 15 });
  for (const tabId of tabIds) {
    try {
      await memorySaver.protect(tabId, { timeoutSeconds: 3600 });
    } catch (error) {
      reportFailure(error);
      if (["API_DISABLED", "INVALID_RESPONSE", "UNSUPPORTED_API_VERSION"].includes(error.code)) {
        await browser.storage.session.set({ [STATE_KEY]: { tabIds, paused: true } });
        await browser.alarms.clear(RENEW_ALARM);
        break;
      }
      // Failure for one tab must not stop renewals for healthy tabs.
    }
  }
}

// Call when your application's desired set changes. Pass [] to stop all renewals.
function setProtectionTargets(tabIds) {
  if (!Array.isArray(tabIds) || tabIds.some(id => !Number.isSafeInteger(id) || id < 0)) {
    return Promise.reject(new TypeError("Expected an array of tab IDs."));
  }
  const next = [...new Set(tabIds)];
  return serialize(async () => {
    const stored = await browser.storage.session.get(STATE_KEY);
    const previous = stored[STATE_KEY]?.tabIds ?? [];
    await browser.storage.session.set({ [STATE_KEY]: { tabIds: next, paused: false } });
    if (!next.length) await browser.alarms.clear(RENEW_ALARM);
    for (const tabId of previous.filter(id => !next.includes(id))) {
      try { await memorySaver.release(tabId); } catch (error) { reportFailure(error); }
    }
    await syncProtection();
  });
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RENEW_ALARM) serialize(syncProtection).catch(reportFailure);
});

// Reconcile when this module starts, including after background suspension.
serialize(syncProtection).catch(reportFailure);
```

Call `await setProtectionTargets(currentTabIds)` when your application's desired
set changes, including when protected tabs close, and handle rejected Promises.
Pass an empty array when no tabs need protection. This example owns its saved
set; avoid mixing it with separate direct client calls for those same tabs.

Each successful renewal confirms only that tab; inspect/report per-tab failures
rather than presenting an entire batch as protected. Failed release attempts are
logged and stop being renewed; their leases can remain until their own deadlines.
For applications needing confirmed immediate release, retry those releases before
reporting them as released.

The example pauses on user opt-out or API incompatibility. After resolving that
condition, an explicit `setProtectionTargets(...)` resumes requests. Do not call
it repeatedly to bypass a user's opt-out. After a browser restart, let your own
state-restoration logic choose valid current tab IDs and supply them again;
`storage.session` does not carry numeric IDs into a new browser session.

## Handling errors

Failures throw `MemorySaverError`; use its `code` to decide what to do:

| Code | What to do |
| --- | --- |
| `UNAVAILABLE` | Memory Saver or its API could not be reached. Continue without confirmed protection. |
| `API_DISABLED` | The user disabled **Allow other extensions to protect tabs**. Do not keep retrying automatically. |
| `TAB_NOT_FOUND` / `TAB_DISCARDED` | The acquire/renew target is inaccessible, closed, or asleep. Recheck it; the client does not restore tabs. |
| `INVALID_TAB_ID` / `INVALID_TIMEOUT` | Correct your arguments. |
| `INVALID_RESPONSE` / `UNSUPPORTED_API_VERSION` | The installed API is incompatible or returned an unexpected response. |
| `INTERNAL_ERROR` | Retry cautiously while needed; do not assume success. |

Unknown API codes are preserved in `error.code`; treat them as unconfirmed
operations. Firefox cannot always distinguish an absent extension from an older
one without the API. Delivery failures preserve the original `error.cause`.

## What protection covers

Each lease blocks Memory Saver's automatic and manual discarding for its tab and
appears in the Protected tabs list. It does not prevent closing, Firefox's native
unloading, or another extension discarding the tab. Expiration makes a tab
eligible under normal rules again; it does not immediately discard it.

The user can disable external protection in Memory Saver's Protected tabs
settings, removing all external requests. Protection is independent of activity
recording. Requests are logged in Memory Saver's extension console with your
extension ID and full payload. Closing or replacing a tab removes only that
tab's leases; your other tabs remain protected. Reacquire after browser restarts
or Memory Saver reloads/updates, which can clear leases.

See the [API reference](EXTENSION_API.md) for the full protocol, lifecycle rules,
error list, and Firefox's separate native-unloading controls.
