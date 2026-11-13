# Firefox Memory Saver — Implementation Plan

Status: In implementation  
Target: Firefox Desktop, Manifest V3  
Initial release: MVP / `0.1.0`

## 1. Objective

Build a small Firefox extension that automatically discards tabs after they have
been inactive for a configurable period. A discarded tab remains in the tab bar
and reloads when selected.

The popup must:

- show all tabs that are currently discarded;
- let the user restore a discarded tab;
- show when and why each tracked tab was discarded;
- show when each discarded tab was last active and its recorded active time; and
- provide manual actions to discard eligible tabs immediately.

The extension must favor predictable behavior over aggressive memory savings.
It must never automatically discard an active, pinned, audible, protected, or
otherwise ineligible tab.

## 2. Product boundaries

### Included in the MVP

- Automatic inactivity-based tab discarding.
- Manual "Discard eligible tabs now" and "Discard other tabs" actions.
- A list of currently discarded tabs in the popup.
- A separate popup view listing currently protected tabs and their protection reasons.
- Restore/focus action for each discarded tab.
- Domain protection list.
- A tab context-menu submenu for per-tab and per-domain protection.
- Configurable inactivity threshold and minimum loaded-tab counts, with a derived scan interval.
- Protection for active, pinned, audible, and special Firefox pages.
- Persistent settings and discard history for the current open tabs.
- Local, bounded foreground active-tab session history.
- Automated unit tests and manual Firefox integration tests.
- A reproducible unsigned ZIP for local testing and AMO submission.

### Not included in the MVP

- Exact or estimated per-tab memory reporting. Both are deferred to future work.
- Claims about reading time, attention, or user engagement. The extension can
  observe foreground tab selection, not whether the user is looking at the page.
- Indefinite browsing-history retention or cloud analytics.
- A native companion application or Native Messaging.
- Synchronization between Firefox profiles or devices.
- Content scripts or access to page contents.
- Closing tabs, bookmarking tabs, or changing Firefox's low-memory preferences.
- Chrome/Safari support.

## 3. Key technical decisions

| Area | Decision | Reason |
| --- | --- | --- |
| Platform | Firefox Manifest V3 | Current extension format; Firefox is the only target. |
| Language | Native JavaScript modules | Directly loadable in Firefox with no build dependency. |
| UI | Vanilla HTML and CSS | The popup is small and does not need a UI framework. |
| Build | None for the MVP | The source tree is the extension artifact; packaging is a ZIP step. |
| Tests | Browser-native test harness | Runs the same ES modules in Firefox with small API mocks. |
| Browser API | Native `browser.*` API | Firefox supports promises natively; no polyfill is needed. |
| Scheduling | `browser.alarms` | Timers remain reliable when the background page is unloaded. |
| Persistence | `browser.storage.local` | Suitable for settings and small tab-record maps. |
| Usage tracking | Foreground activation intervals | Tab and window events provide useful durations without reading page content. |
| Memory figure | Future work; absent from `0.1.0` | Calibration is too much work for the MVP and exact bytes are unavailable. |

## 4. Proposed project structure

```text
firefox-memory-saver/
├── manifest.json
├── icons/
│   └── icon.svg
├── src/
│   ├── background/
│   │   └── index.js
│   ├── core/
│   │   ├── eligibility.js
│   │   ├── settings.js
│   │   ├── time.js
│   │   └── usage.js
│   ├── popup/
│   │   ├── index.html
│   │   ├── index.js
│   │   └── popup.css
│   └── options/
│       ├── index.html
│       ├── index.js
│       └── options.css
├── tests/
│   ├── index.html
│   └── test.js
├── README.md
└── IMPLEMENTATION_PLAN.md
```

The project root is directly loadable as a temporary Firefox extension. Release
packaging includes `manifest.json`, `icons/`, `src/`, and the README.

## 5. Manifest and permissions

The manifest will define:

- `manifest_version: 3`
- an action with `popup/index.html` as its popup;
- a Firefox background script;
- `options_ui` for the settings page;
- `browser_specific_settings.gecko` with a stable extension ID; and
- permissions: `tabs`, `alarms`, `storage`, `sessions`, and `menus`.

No host permissions or content scripts will be requested. The extension can
therefore manage tab metadata without reading or modifying page content.

Permission usage:

- `tabs`: query tab state and call `browser.tabs.discard()`;
- `alarms`: run the inactivity scan and usage checkpoint periodically;
- `storage`: persist settings, discard records, and bounded usage history; and
- `sessions`: attach an opaque extension-owned identity to each tab so restored
  tabs can be recognized without confusing reused numeric tab IDs, and retain
  per-tab discard protection across normal session restoration; and
- `menus`: expose tab and domain discard protection in the tab context menu.

## 6. Data model

All persisted data will be versioned so future releases can migrate it.

```ts
interface Settings {
  schemaVersion: 1;
  enabled: boolean;
  inactivityMinutes: number;
  scanIntervalMinutes: number;
  minimumLoadedTabsPerWindow: number;
  minimumLoadedTabsTotal: number;
  protectPinned: boolean;
  protectAudible: boolean;
  protectedDomains: string[];
  usageTrackingEnabled: boolean;
  usageHistoryDays: number;
}

type DiscardReason = "automatic" | "manual-eligible" | "manual-others" | "external";

interface DiscardRecord {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  favIconUrl?: string;
  discardedAt: number;
  lastAccessedAt?: number;
  reason: DiscardReason;
}

type SessionEndReason =
  | "tab-switch"
  | "window-blur"
  | "navigation"
  | "tab-closed"
  | "discarded"
  | "startup-recovery";

interface UsageSession {
  tabKey: string;
  tabIdAtTime: number;
  windowIdAtTime: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  url: string;
  title: string;
  endReason: SessionEndReason;
}

interface TabUsageRecord {
  tabKey: string;
  tabId: number;
  windowId: number;
  currentSessionStartedAt?: number;
  lastCheckpointAt?: number;
  lastActivatedAt?: number;
  totalActiveMs: number;
}

interface StoredState {
  schemaVersion: 1;
  settings: Settings;
  discardRecords: Record<string, DiscardRecord>;
  liveUsageRecords: Record<string, TabUsageRecord>;
  usageSessions: UsageSession[];
  lifetimeDiscardCount: number;
}
```

Tab IDs only live for the current browser session. Each tab receives a random
`tabKey` stored with `sessions.setTabValue()`, which survives Firefox's normal
close/restore flow. On startup, live records must still be reconciled with the
actual open tabs. Completed usage sessions are retained for a configurable,
bounded period (default: 7 days) and deleted immediately when the user chooses
"Clear usage data."

## 7. Eligibility rules

Eligibility is implemented as a pure function so it is easy to test. A tab is
eligible for automatic discard only when every condition below is true:

1. Automation is enabled.
2. The tab has a numeric ID and a normal web URL.
3. The tab is not active.
4. The tab is not already discarded.
5. The tab is not pinned when pinned-tab protection is enabled.
6. The tab is not audible when audible-tab protection is enabled.
7. Its hostname does not match the protected-domain list.
8. Its `lastAccessed` time is older than the configured threshold.
9. Discarding it will not reduce the window below the configured minimum
    number of loaded tabs.

URLs with schemes such as `about:`, `moz-extension:`, `file:`, and `view-source:`
will be protected by default. If Firefox refuses a discard, the failure will be
handled and logged without creating a discard record.

Manual actions use the same safety checks, except that they do not apply the
inactivity threshold. Firefox cannot discard the active tab. The MVP therefore
offers "Discard eligible tabs now" and "Discard other tabs" rather than changing
focus behind the user's back to support a "Discard this tab" action.

## 8. Automatic discard flow

1. On installation/startup, load and validate settings.
2. Create or refresh a named periodic alarm.
3. When the alarm fires, query all tabs.
4. Calculate the loaded-tab budgets for each window and for all windows,
   counting only inactive, unprotected loaded tabs, regardless of their age.
5. Sort eligible tabs by `lastAccessed`, oldest first.
6. Select only as many tabs as both minimum-loaded-tabs rules permit.
7. Call `browser.tabs.discard(tabId)` one tab at a time so failures are isolated.
8. Re-query the tab to confirm that Firefox marked it as discarded.
9. Create a `DiscardRecord` only after confirmation.
10. Notify an open popup to refresh its list and summary.

Running scans are protected by an in-memory lock. If another alarm fires while a
scan is active, the second scan exits rather than issuing duplicate discards.

## 9. Tab event handling and reconciliation

Background listeners:

- `tabs.onActivated`: update discard state and rotate foreground usage sessions.
- `tabs.onUpdated`: react when the `discarded`, URL, title, or favicon state
  changes; split a foreground session on top-level URL changes.
- `tabs.onRemoved`: close usage and delete the corresponding live records.
- `tabs.onReplaced`: move or reconcile the record if Firefox replaces a tab ID.
- `windows.onFocusChanged`: rotate sessions when Firefox gains or loses focus.
- `windows.onRemoved`: close usage and remove stale live records for the window.
- `runtime.onStartup`: recreate alarms and reconcile all records.
- `runtime.onInstalled`: initialize defaults and create the alarm.

Reconciliation queries every open tab and treats Firefox's current `discarded`
flag as the source of truth:

- stored record + discarded tab: retain and refresh metadata;
- stored record + loaded/missing tab: delete the record;
- discarded tab + no stored record: create an "externally discarded" display
  record without incrementing the extension's lifetime count.

## 10. Active-tab usage tracking

### What can be measured

Firefox exposes tab activation and window-focus events. The extension can use
them to record intervals during which a tab is selected in the focused Firefox
window. For each tab, the MVP can record:

- each foreground session's start and end timestamp;
- the duration and reason the session ended;
- the URL and title observed for that interval;
- the most recent activation time; and
- aggregate foreground time within the retention period.

This is **active-tab time**, not proof of reading, interaction, or attention. A
user may walk away while Firefox remains focused. Conversely, background audio
or downloads do not count as foreground time. The UI and documentation must use
this precise terminology.

### Session lifecycle

1. At startup, find Firefox's focused normal window and its active tab.
2. Start a session when `tabs.onActivated` selects a tab in the focused window.
3. End the previous session in that window at the same timestamp.
4. On `windows.onFocusChanged`, end the old focused window's session. When a
   Firefox window gains focus, start a session for its active tab.
5. On a top-level navigation, end the old URL segment and immediately start a
   new segment for the same tab if it remains foregrounded.
6. End a session when its tab is closed or discarded.
7. Persist session starts immediately and checkpoint an open session with a
   dedicated five-minute alarm. After a crash or shutdown, close an orphaned
   session at its last checkpoint rather than counting the entire offline period.
8. Prune completed sessions older than `usageHistoryDays` on startup, on alarm,
   and after settings changes.

Events can arrive close together, so session start/end operations must be
idempotent. A `(tabKey, startedAt)` pair identifies a session. Durations are
derived from timestamps using a single captured
`now` value per event and are never allowed to become negative.

### Privacy and retention

Usage tracking is opt-in and disabled by default. Its data remains in
`browser.storage.local`; it is never transmitted. The default retention after
opt-in is 7 days, configurable from 1 to 365 days. Settings provide a one-click
"Clear usage data" action. Disabling tracking closes the current session and
deletes all usage history. The privacy notice must explain that URLs, titles,
timestamps, and foreground durations are stored locally.

In addition to time-based retention, keep at most 10,000 completed sessions and
prune the oldest entries first. This protects storage if a user switches or
navigates unusually often.

Tab IDs are not stable across browser restarts. A random opaque `tabKey` stored
with `sessions.setTabValue()` identifies a restored tab without using its URL as
an identity. A newly created tab receives a new key, so Firefox reusing a numeric
ID cannot attach old history to an unrelated tab.

The MVP will not request the `idle` permission. Consequently, time may be
overcounted when the machine is idle while Firefox stays focused. Adding optional
idle detection can be evaluated later if users need more accurate engagement
approximations.

## 11. Popup specification

Target size: approximately 380 px wide, with a maximum-height scrolling list.

### Header

- Extension name.
- Automation on/off toggle.
- Settings button.

### Summary

- Count of tabs currently discarded.
- Count discarded by this extension.
- Number of tabs discarded during the current browser session.

### Actions

- `Discard eligible tabs now`: applies safety rules but ignores inactivity age.
- `Discard other tabs in this window`: retains the active tab and applies all
  other protections.

Buttons show progress and are disabled while a discard operation is active.

### Discarded-tab list

Each row contains:

- favicon with a generated fallback;
- title, falling back to hostname or "Untitled tab";
- hostname;
- relative discard time;
- automatic/manual/external reason;
- last foreground-active time;
- foreground-active duration within the retained period; and
- `Restore` button.

Selecting `Restore` activates the tab with `browser.tabs.update(tabId,
{ active: true })`, focuses its window, and lets Firefox reload it naturally.

Default sorting is most recently discarded first. Empty, loading, and error
states must be designed explicitly.

## 12. Options-page specification

Settings:

- Enable automatic discarding.
- Discard after: 5 minutes to 24 hours (default: 10 minutes).
- Scan interval: the inactivity threshold divided by 20, rounded up and capped at 60 minutes (default: 1 minute).
- Keep at least: 0 to 20 loaded tabs per window.
- Keep at least: 0 to 100 loaded tabs in total (default: 0, no additional limit).
- Protect pinned tabs.
- Protect audible tabs.
- Protected domains, one hostname per entry.
- Record detailed foreground tab activity (off by default).
- Usage-history retention: 1 to 365 days (default: 7).
- Clear locally stored usage data.
- Reset settings.

Domain entries are normalized to lowercase hostnames. Invalid entries produce an
inline validation message and are not saved. Subdomain behavior will be explicit:
protecting `example.com` also protects `*.example.com`.

Saving settings recalculates the scan interval from the inactivity threshold and recreates the alarm immediately.

## 13. Background/UI message protocol

The popup and options page communicate with the background script through typed
runtime messages:

```ts
type Request =
  | { type: "GET_POPUP_STATE" }
  | { type: "DISCARD_ELIGIBLE_NOW"; windowId?: number }
  | { type: "RESTORE_TAB"; tabId: number; windowId: number }
  | { type: "CLOSE_TAB"; tabId: number }
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; settings: Settings }
  | { type: "CLEAR_USAGE_DATA" };
```

Responses use a discriminated success/error shape. User-facing errors must be
plain language; underlying API errors may also be logged for debugging.

## 14. Implementation milestones

### Milestone 1 — Scaffold and loadable package

- [x] Choose a no-build native-module structure after confirming Node/npm is not
  available in the implementation environment.
- [x] Add manifest, extension ID, icon, popup, and options entries.
- [x] Document direct loading, browser tests, and ZIP packaging.
- [ ] Verify the unpacked project manually through `about:debugging`.

Exit criteria: the project loads through `about:debugging`, the toolbar action
opens a popup, and the options page opens without manifest or console errors.

### Milestone 2 — Settings and domain model

- [x] Define the state shape, defaults, validation, and schema versioning.
- [x] Implement storage loading, repair of invalid values, and saving.
- [x] Implement protected-domain normalization and matching.
- [x] Add unit tests for defaults and validation.

Exit criteria: settings survive a browser restart and invalid stored values fall
back safely.

### Milestone 3 — Eligibility and discard engine

- [x] Implement pure eligibility rules.
- [x] Implement per-window loaded-tab budgeting.
- [x] Implement oldest-first selection.
- [x] Implement confirmed, failure-isolated discard operations.
- [x] Add unit tests for the primary exclusions and boundary conditions.

Exit criteria: only eligible tabs are discarded in manual Firefox tests.

### Milestone 4 — Scheduler and lifecycle

- [x] Create/recreate the periodic alarm.
- [x] Add background initialization and the scan lock.
- [x] Add tab/window listeners and record reconciliation.
- [ ] Test startup, tab closure, tab restoration, and externally discarded tabs.

Exit criteria: automation continues after restarting Firefox and records never
retain closed or restored tabs.

### Milestone 5 — Popup

- [x] Build summary, toggle, action buttons, and list states.
- [x] Render discarded-tab rows from reconciled background state.
- [x] Implement restore and focus behavior.
- [x] Add native keyboard controls, focus states, and status announcements.

Exit criteria: the popup accurately reflects Firefox's current discarded state
and all actions work without reopening the popup.

### Milestone 6 — Active-tab usage tracking

- [x] Implement activation, window-focus, navigation, close, and discard session
  boundaries.
- [x] Add checkpointing and startup recovery for interrupted sessions.
- [x] Implement time/count retention pruning and clear-data behavior.
- [x] Add last-active and retained foreground-time values to popup state.
- [ ] Add tests for event ordering, duplicate events, recovery, and retention.

Exit criteria: recorded sessions reflect foreground tab intervals, survive a
normal restart, recover conservatively after interruption, and remain bounded by
the retention setting.

### Milestone 7 — Options UI

- [x] Implement all settings controls and validation.
- [x] Recreate the alarm when scheduling settings change.
- [x] Apply protected-domain edits to subsequent scans.
- [x] Implement retention and clear-usage-data controls.

Exit criteria: every exposed setting has a tested effect on background behavior.

### Milestone 8 — Release hardening

- [x] Add the initial icon, accessible focus states, and responsive options layout.
- [ ] Test with multiple windows, private windows, pinned tabs, audio, containers,
  restored sessions, and at least 100 open tabs.
- [ ] Set private browsing to unsupported in the manifest and document that
  decision; reconsider only after the normal-window lifecycle is proven stable.
- [ ] Run typecheck, unit tests, production build, and package inspection.
- [ ] Write README, privacy statement, testing instructions, and AMO listing copy.
- [ ] Produce the unsigned release ZIP.

Exit criteria: all acceptance criteria below pass and the packaged artifact loads
as a temporary Firefox add-on.

## 15. Test strategy

### Unit tests

- Every eligibility exclusion independently and in combination.
- Inactivity threshold equality and missing `lastAccessed` values.
- Oldest-first selection and minimum-loaded-tab budgets per window.
- Domain normalization, exact matches, and subdomain matches.
- Discard success, refusal, tab disappearance, and partial batch failure.
- Record creation, reconciliation, cleanup, and external discards.
- Settings validation and schema migration.
- Usage session boundaries, totals, retention, recovery, and deletion.
- Runtime message validation and error responses.

Browser APIs will be wrapped in small adapters and mocked in tests. Core policy
functions will not import browser globals directly.

### Manual Firefox matrix

- One window and multiple windows.
- Normal windows, plus confirmation that the extension is unavailable in private
  windows as declared by the manifest.
- Active, pinned, audible, muted, and already-discarded tabs.
- Pages with unsaved-form / `beforeunload` protection.
- Firefox internal and extension pages.
- Tabs from different container identities.
- Browser restart with session restoration.
- Alarm firing while the popup is closed.
- Manual actions while an automatic scan is running.
- Large sessions of at least 100 tabs.

## 16. Acceptance criteria for `0.1.0`

1. An eligible inactive tab is automatically discarded after the configured
   threshold, allowing for one scan interval of delay.
2. Active, pinned, audible, protected-domain, internal, and already-discarded
   tabs are not automatically discarded.
3. The per-window and total minimum loaded-tab counts are respected when the
   extension selects tabs to discard.
4. Firefox API refusals do not create records or stop the rest of a scan.
5. The popup lists all currently discarded tabs and removes rows after tabs are
   restored or closed.
6. Restore focuses the correct window and tab.
7. Manual bulk actions obey all safety protections except inactivity age.
8. Settings persist and take effect without restarting Firefox.
9. Foreground session timestamps and durations respond correctly to tab changes,
   window focus changes, navigation, closure, and discard.
10. Usage history is stored locally, pruned to the configured retention period,
    and can be cleared by the user.
11. Externally discarded tabs are identified as external rather than credited to
    the extension.
12. The extension requests no host permissions and reads no page content.
13. No memory-savings number or estimate appears in the MVP.
14. Typecheck, unit tests, production build, and temporary-add-on smoke test pass.

## 17. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A web app loses transient state after reload. | Conservative defaults, pinned/domain protection, clear onboarding, and Firefox's own discard refusal handling. |
| Alarm and tab events race. | Scan lock, post-discard confirmation, idempotent record updates, and reconciliation. |
| Stored tab IDs become stale after restart. | Treat live `tabs.query()` results as source of truth on every startup. |
| Usage time is mistaken for attention. | Label it foreground active-tab time and document idle-time limitations. |
| Usage history becomes sensitive or unbounded. | Opt-in local-only storage, 7-day default, 30-day cap, pruning, and one-click deletion. |
| Shutdown inflates an open session. | Periodic checkpoints and conservative startup recovery at the last checkpoint. |
| Large tab sessions make the popup slow. | Compute state in the background, render incrementally if needed, and cap expensive DOM work. |
| Special Firefox pages reject API operations. | Exclude non-web schemes and handle every discard call independently. |

## 18. Recommended implementation order

Implement milestones 1–5 first. Add bounded active-tab usage tracking in milestone
6 once discard tracking and popup reconciliation are stable. Finish with settings
polish and release hardening. Memory estimation is not on the MVP critical path.

This ordering validates the core value—safe automatic discarding and reliable
restoration—before adding richer local activity history.

## 19. Future work: memory-savings estimates

Memory estimates are explicitly excluded from `0.1.0`. The standard Firefox
WebExtensions API exposes whether a tab is discarded but not the exact memory it
used or the number of bytes released. Network size, DOM size, and JavaScript heap
are not equivalent substitutes.

A future release may investigate a conservative, clearly labeled range using a
documented calibration set and Firefox's development-only `about:unloads` data.
That work requires its own validation and product decision. Until then, the UI
will report discarded-tab counts only and will not imply a memory quantity.
