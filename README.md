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
- A minimum number of loaded tabs retained independently in each window.
- Popup actions for discarding eligible tabs and restoring discarded tabs.
- Reconciliation with tabs discarded by Firefox or other extensions.
- Optional foreground active-tab session tracking, disabled by default.

Memory quantities are intentionally not shown. Firefox does not expose exact
per-tab memory usage to ordinary WebExtensions, and estimates are future work.

## Load in Firefox

1. Open `about:debugging`.
2. Select **This Firefox**.
3. Select **Load Temporary Add-on**.
4. Choose this project's `manifest.json`.

Firefox 128 or newer is required. Temporary extensions are removed when Firefox
closes.

## Run the unit tests

Open `tests/index.html` in Firefox. The page runs browser-independent tests for
settings normalization, eligibility, selection budgets, and usage-session logic.

## Package

From the project root:

```sh
zip -r memory-saver-0.1.0.zip manifest.json icons src README.md
```

The resulting archive is unsigned. AMO signing is required for normal Firefox
installation.

## Privacy

The extension does not transmit data and does not inject scripts into webpages.
Its settings and discard records stay in `browser.storage.local`.

Detailed foreground activity tracking is optional and off by default. If enabled,
the extension stores URLs, titles, timestamps, and foreground durations locally
for 7 days by default (configurable from 1 to 30 days, with a 10,000-session cap).
This is active-tab time, not proof of attention or interaction. Disabling the
feature or choosing **Clear usage data** deletes its activity history.

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for architecture, milestones,
and acceptance criteria.
