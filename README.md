# Memory Saver for Firefox

Memory Saver automatically unloads inactive tabs while leaving them in Firefox's
tab bar. Selecting a discarded tab restores it normally.

The current implementation is an MVP and uses native WebExtension modules with
no build step or third-party runtime dependencies.

Raster artwork is stored with Git LFS. Contributors should install Git LFS and
run `git lfs install` before cloning or checking out the project. SVG files remain
ordinary text Git objects.

## Features

- Configurable automatic discarding based on Firefox's `lastAccessed` timestamp.
- Protection for active, pinned, audible, internal, and allowlisted-domain tabs.
- A tab context-menu submenu for protecting one tab or its entire domain.
- Minimum numbers of loaded tabs retained in each window and across all windows.
- Popup views listing sleeping and protected tabs, with live counts for both.
- Current-tab last-sleep and optional active-time details.
- Popup actions for discarding eligible tabs and restoring discarded tabs.
- Reconciliation with tabs discarded by Firefox or other extensions.
- Optional foreground activity and confirmed tab-discard recording, disabled by default.

Memory quantities are intentionally not shown. Firefox does not expose exact
per-tab memory usage to ordinary WebExtensions, and estimates are future work.
The scan interval is calculated when settings are saved: the discard timeout
divided by 20, rounded up to a whole minute and capped at 60 minutes.
The loaded-tab minimums count only inactive, unprotected loaded tabs. Active
and protected tabs are kept in addition to these minimums. The limits apply to
discards initiated by Memory Saver; Firefox,
other extensions, or closing tabs can reduce the number of loaded tabs below
those limits. The total minimum defaults to 0, adding no restriction unless set.

## Load in Firefox

1. Open `about:debugging`.
2. Select **This Firefox**.
3. Select **Load Temporary Add-on**.
4. Choose this project's `manifest.json`.

Firefox 140 or newer is required on desktop. Firefox for Android is not supported:
the extension does not appear to work well there, and it seems less necessary
because Firefox and Android appear to unload background tabs more aggressively
than Firefox on desktop. Temporary extensions are removed when Firefox closes.

## Run the unit tests

Open `tests/index.html` in Firefox, or run `node tests/run.mjs` with Node.js 22
or newer. Both run the same suite for settings normalization, eligibility,
selection budgets, history reset/storage/retention, and recorder event handling.
Browser tests use native IndexedDB; Node uses an asynchronous IndexedDB contract
double. No dependency installation is required.
The recorder integration tests use mocked Firefox APIs; a real Firefox smoke test
across an extension reload and browser restart is also required before publishing.

## Package

From the project root:

```sh
./build.sh
```

This creates `memory-saver.zip`, replacing any previous build. The resulting
archive is unsigned; AMO signing is required for normal Firefox installation.

## Privacy

The extension does not transmit data and does not inject scripts into webpages.
Settings and current discard records use separate small entries in
`browser.storage.local`; detailed activity history uses indexed records in
IndexedDB. Opening the popup does not save history, and optional activity totals
load separately from its controls. Per-tab discard
protection is stored in Firefox session data so it follows a normally restored tab.
The most recent observed sleep time and cause are also stored in the tab's Firefox
session data, independently of optional usage tracking. If a tab is discovered
already asleep, its actual sleep time is unknown.

Detailed activity tracking is optional and off by default. If enabled, the
extension records URLs, titles, foreground intervals, confirmed sleep events,
per-tab observation/access metadata, and recording coverage locally. This prepares
history for planned review tools that can help explain browsing patterns, which
tabs sleep and how often, and which tabs to protect. It may also support more
intelligent automatic discarding in future versions; those views and decisions
are not implemented yet.

History is kept for 14 days by default (configurable from 1 to 365 days), with
independent 10,000-record caps for foreground sessions and sleep events. Coverage
records identify known interruptions and truncation rather than treating missing
data as zero. Observation metadata for open tabs can retain known last-access
and activation times beyond the detailed-history cutoff; closed metadata expires
when its last retained record does. This is active-tab time, not proof of
attention or interaction. Disabling the feature or confirming **Clear usage data**
deletes its detailed activity history. No detailed history is collected while
recording is disabled. See [Activity recording](docs/ACTIVITY_RECORDING.md) for
the schema, storage layout, and recovery behavior.

The switch to IndexedDB deliberately resets history previously embedded in the
old settings/state entry. There is no history migration. Saved settings, the
recording preference, manual protection, recent sleep metadata, and lifetime
discard count are preserved; detailed recording starts fresh if enabled.

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for architecture, milestones,
and acceptance criteria.
