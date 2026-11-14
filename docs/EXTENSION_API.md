# Memory Saver API for Firefox extension developers

Use this API when your extension needs tabs to remain loaded. Each requesting
extension can protect multiple tabs, with an independent renewable lease of at
most one hour for each tab. Several extensions can protect the same tab.

This document describes API version **1** in the current development sources.
The tagged v0.3.0 release predates this API. Detect support with `get-api-info`
rather than assuming it from the manifest version.

For the recommended JavaScript integration, start with the
[lightweight client guide](EXTENSION_CLIENT.md). This document describes the
underlying messaging protocol for direct integrations and further reference.

## User control

The **Allow other extensions to protect tabs** checkbox under **Protected tabs**
in Memory Saver settings controls this API. It is enabled by default, including
for users upgrading from older versions. Changes apply when settings are saved.

When disabled, all external API requests, including discovery and release
requests, return `API_DISABLED`. Existing external leases are removed; manual
and other protection rules remain intact. Re-enabling the API does not restore
old leases: request protection again. Respect this preference rather than
repeatedly retrying. Requests are still logged when the API is disabled.

## Transport and extension identity

Send requests from your extension's background script or an extension page using
Firefox's [`runtime.sendMessage`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/sendMessage).
Memory Saver's fixed extension ID is:

```js
const MEMORY_SAVER_ID = "@firefox-memory-saver-hero";
```

Memory Saver receives requests through
[`runtime.onMessageExternal`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessageExternal).
No extra permission is needed solely to send these messages. Obtain target tab
IDs through your application's own logic, not URLs or tab indices. Route content
script requests through your background script.

Every request includes numeric `apiVersion: 1`. The actual `sender.id` supplied
by Firefox identifies the owner; caller-supplied owner fields have no effect.
All other extensions may use this narrow API. It does not expose internal
settings, activity history, manual-protection controls, or discard commands.

Every incoming request, including rejected requests, is logged to Memory Saver's
extension console with its actual sender ID and full payload. These diagnostic
messages are not stored as a request history. Open `about:debugging`, select
**This Firefox**, and click **Inspect** for Memory Saver; enable informational
console messages to see them.

## Check API availability

```js
const response = await browser.runtime.sendMessage(MEMORY_SAVER_ID, {
  apiVersion: 1,
  type: "get-api-info",
});
```

Success:

```json
{ "ok": true, "data": { "apiVersion": 1, "maxTimeoutSeconds": 3600 } }
```

Delivery can reject if Memory Saver is absent, disabled, or does not implement
the API. Handle that separately from API error responses. Discovery does not
acquire protection; check every protection request's result.

## Acquire or renew protection

```js
const response = await browser.runtime.sendMessage(MEMORY_SAVER_ID, {
  apiVersion: 1,
  type: "set-protected-tab",
  tabId: targetTabId,
  timeoutSeconds: 3600,
});
```

* `tabId`: a nonnegative safe integer identifying an accessible, loaded tab.
* `timeoutSeconds`: a required integer from **1 to 3600**, inclusive. Invalid
  values are rejected, not clamped.

Success:

```json
{
  "ok": true,
  "data": { "apiVersion": 1, "tabId": 123, "expiresAt": 1800000000000 }
}
```

`expiresAt` is a Unix timestamp in **milliseconds**, calculated when the request
is processed. Renewing sets a new deadline relative to that processing time;
it does not add time to the old deadline. A shorter renewal shortens the lease.

Protection is keyed by **sender ID and tab ID**. Protecting another tab adds a
separate lease; it never releases your other tabs. Renewing a tab updates only
your lease for that tab. There is no one-tab limit per requesting extension.

Wait for `ok: true` before treating protection as confirmed. Already sleeping
tabs return `TAB_DISCARDED`; this API does not restore or activate them. If
needed, restore through your own UI and request protection again. A tab may
still close between request and response. Invalid requests leave existing
leases unchanged, apart from normal expiration.

## Release one tab

```js
const response = await browser.runtime.sendMessage(MEMORY_SAVER_ID, {
  apiVersion: 1,
  type: "release-protected-tab",
  tabId: targetTabId,
});
```

`tabId` must be a nonnegative safe integer. Success:

```json
{ "ok": true, "data": { "apiVersion": 1, "tabId": 123, "expiresAt": null } }
```

This removes only **your lease for that tab**. Your other tabs, other extensions'
requests, and manual or domain protection remain intact. Releasing repeatedly,
after expiration, or after a tab has closed succeeds as well. No timeout is needed.

## Release all your tabs

```js
const response = await browser.runtime.sendMessage(MEMORY_SAVER_ID, {
  apiVersion: 1,
  type: "release-all-protected-tabs",
});
```

Success lists your active leases removed by this request:

```json
{ "ok": true, "data": { "apiVersion": 1, "releasedTabIds": [123, 456] } }
```

No leases returns an empty list. Other owners' protection is never removed.
Use this explicit operation for cleanup; `tabId: null` is not a valid acquire,
renew, or per-tab release request.

## Renewal and lifecycle

Renew each needed tab independently before its deadline, for example by
requesting one hour and renewing every 15 minutes. Use a Firefox alarm in an
event-driven background script, rather than assuming a JavaScript timer survives
suspension. The [client guide](EXTENSION_CLIENT.md#keeping-protection-active)
includes a generic renewal example.

Read your current desired set of tabs on renewal. Serialize changes with
renewals so old work cannot recreate protection you just released. When changing
that set, release tabs no longer needed and acquire protection for new tabs;
acquisition alone never releases an older target. If another tab must be
protected before releasing the old one, acquire first and verify success.

* Leases survive Memory Saver background suspension/restart within the same
  browser session through `browser.storage.session`, independently of activity
  history. All sender/tab pairs are retained.
* Browser restarts and Memory Saver reloads, updates, or disable/re-enable cycles
  can clear session storage. Reacquire when your extension restores its state;
  do not assume an old deadline guarantees protection survived.
* Closing or replacing a tab removes all leases for that tab, leaving other tabs
  unaffected. Duplication does not copy leases and reused IDs do not inherit
  them. Navigation within a tab retains protection. Replacements need a new request.
* Disabling or uninstalling a requesting extension is not immediately reported
  to this API. Its leases expire at their respective last accepted deadlines.
* Expiration removes only the expired sender/tab lease, even if that sender has
  other leases. It restores normal eligibility, **without immediately discarding**.
* Deadlines are checked during eligibility evaluation even if the expiry alarm
  is delayed. Clock changes can shorten leases; reacquire after a discontinuity.

## Effect and limitations

A valid lease excludes its tab from both automatic and manual discarding by
Memory Saver. Protected tabs stay loaded in addition to the "Keep at least"
allowances and do not count toward those minimums. The popup lists each requesting
extension's ID as a protection reason and refreshes when leases change or expire.
Leases work when activity recording or automatic discarding is disabled.

This API controls **Memory Saver only**. It does not prevent closing, navigation,
crashes, or unloading by Firefox or other extensions. It does not change the
shared native `autoDiscardable` flag. To discourage Firefox's automatic unloading,
your extension can separately use:

```js
await browser.tabs.update(targetTabId, { autoDiscardable: false });
```

Memory Saver also honors this flag if the user enables **Never discard tabs that are not 'autoDiscardable'** in Protected tabs settings. That option is
disabled by default; use this API for explicit, expiring protection regardless
of that preference.

Other extensions' explicit `tabs.discard()` calls can still discard that tab.
The flag has no per-extension ownership; coordinate cleanup carefully. See
[Firefox's discard documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/discard).
Do not add a page `beforeunload` listener solely to cooperate with Memory Saver.

## Error responses

API errors resolve with this shape:

```json
{
  "ok": false,
  "error": { "code": "INVALID_TIMEOUT", "message": "timeoutSeconds must be an integer from 1 to 3600." }
}
```

Use `error.code` for program logic; explanatory messages may change.

| Code | Meaning |
| --- | --- |
| `API_DISABLED` | The user disabled external protection; existing leases have been removed. |
| `INVALID_SENDER` | No other-extension sender identity was supplied. |
| `UNSUPPORTED_API_VERSION` | `apiVersion` is absent or is not numeric `1`. |
| `UNKNOWN_REQUEST` | The request type is not part of this API. |
| `INVALID_TAB_ID` | `tabId` is not a nonnegative safe integer. |
| `INVALID_TIMEOUT` | Timeout is missing or is not an integer from 1 to 3600. |
| `TAB_NOT_FOUND` | The acquire/renew target no longer exists or is inaccessible. |
| `TAB_DISCARDED` | The acquire/renew target is already asleep. |
| `INTERNAL_ERROR` | Storage or another internal operation failed; retry cautiously. |

Requests are processed in arrival order. Serialize overlapping requests when
order matters. A messaging or internal failure after a write can leave the
outcome uncertain; retrying the desired operation is safe. Do not infer success
from a failed request.
