# Local activity recording

This release collects the raw data needed by the planned Summary, By website,
and Timeline views. It does not implement those views. Recording remains opt-in
and off by default. New/default configurations retain up to 14 days; existing
saved retention preferences are preserved.

## Storage and the history reset

Settings live in the small `browser.storage.local.memorySaverSettings` entry.
`memorySaverRuntime` contains only current sleeping-tab records and the lifetime
discard counter. Neither entry contains foreground sessions, detailed discard
events, recorder intervals, tab observation history, or coverage history.

Detailed history uses the `memory-saver-history` IndexedDB database (database
version 1; activity record schema 2):

| Object store | Key / contents | Indexes |
| --- | --- | --- |
| `sessions` | `sessionId`; completed foreground intervals, including closed tabs | End time, tab key, compound tab key/end time |
| `discards` | `eventId`; confirmed sleep transitions | Observation time, tab key |
| `coverage` | Segment `id`; recording coverage intervals | Checkpoint time, sequence |
| `tabs` | `tabKey`; observation, access, activation, closure, and discard-episode metadata | Open/closed status |
| `live` | `tabKey`; ongoing intervals and their current URL/title/checkpoint | Primary key |
| `checkpoint` | `recorder`; coverage boundaries, current segment, browser token, revision, sequence counter | Primary key |

Completed sessions and sleep events are appended as individual records. Updated
live intervals and tab metadata are written only when changed. History changes
and their recorder checkpoint commit in one transaction; failed transactions
leave pending records available for retry. Clearing resets the collection in a
single transaction. Sequence numbers preserve per-collection observation order,
including tied timestamps; they do not claim to reproduce every browser action.

Startup reads the recorder checkpoint and open-tab state, not completed history.
Memory holds open-tab metadata, live intervals, one current coverage segment,
and small pending write buffers. Closed-tab metadata is read by key only when a
restored tab needs it. Per-tab summaries use the compound tab/time index.
Retention and caps delete records through indexes rather than loading all
history into a JavaScript object.

**There is no history migration.** On first use of this storage layout, settings
and ordinary operational data are extracted from the old `memorySaverState`
entry, then that entry is removed with all its embedded history. Existing
foreground sessions, detailed sleep events, tab metadata, and coverage start
fresh. No old records are copied into IndexedDB. The recording preference and
retention preference are preserved; recording restarts if previously enabled.
The old large entry must be read once to retain settings, but is never read on
subsequent startup after cleanup succeeds.

`discardRecords`, `memorySaverLastSleep`, manual protection, persistent tab keys,
and the lifetime discard counter keep their independent operational roles.

Settings reads fetch only their small dedicated entry. Popup base reads bypass
the recorder queue and perform no persistence; optional usage summaries are
requested separately after its controls render. Normal recorder writes never
resubmit the complete history to `browser.storage.local`.

## Identity and tab metadata

`memorySaverTabKey`, stored with Firefox's tab session data, is the join key.
Numeric tab/window IDs address current tabs and are diagnostic historical fields;
they must not be used to join records across browser sessions.

Recording registers every accessible open tab, including sleeping and protected
tabs that have never been foregrounded. Navigation keeps the key. Duplicates get
new keys when a copied key is already claimed. Restored tabs can reclaim an
unclaimed key and their retained history. Tab adoption between windows rebinds
the key into Firefox session data. History retained in the new database follows
restored identities; history removed by the storage reset is not reconstructed.

Metadata includes:

* `firstObservedAt`: when this recording history first observed the identity;
  this is not a claim about when the tab was originally created.
* `currentObservedSince`: the start of the current observed presence, reset when
  a known closed tab is restored. Keep this distinct from first observation when
  assessing whether a currently open tab has enough history.
* `lastActivatedAt` and `lastActivationSource`: observed foreground activation or
  focus time. Navigation and checkpoint continuation do not manufacture a new
  activation.
* `lastForegroundObservedAt`: foreground observation at recorder startup/recovery
  when the actual activation time is unknown.
* `lastAccessedAt` and `lastAccessedSource`: Firefox's available selection
  timestamp or an observed activation, including activation in an unfocused
  window. Missing, zero, and future Firefox timestamps are not treated as known.
* `lastObservedAt`, current `tabId`/`windowId`, and `closedAt`. Closing removes the
  live addressing fields but keeps referenced history; reopening clears closure.
* `isDiscarded` and `discardEpisodeRecorded`: deduplicate a sleep episode even
  when popup discard records are reconciled or history caps prune old events.

Current titles, URLs, protection reasons, window membership, and state for a
future open-tab table should still come from Firefox's current tab snapshot.
Metadata does not store a second complete copy of every tab's URL/title history.

## Foreground intervals

Completed intervals preserve the existing `tabKey`, `tabIdAtTime`,
`windowIdAtTime`, `startedAt`, `endedAt`, `durationMs`, `url`, `title`, and
`endReason`, a unique `sessionId`, `startReason`, and `foregroundActivatedAt`
(nullable). Persisted records also carry a sequence number.

Only the selected tab in the focused window accrues foreground time. Activation,
focus changes, navigation, discard, closure, and detachment end or start the
appropriate interval. Navigation splits URL attribution but retains activation
provenance. Refocusing can start a new foreground interval. A wake after discard
starts recording once the tab is loaded and foregrounded.

A checkpoint updates the ongoing interval without creating a false activation.
Intervals are absolute epoch-millisecond timestamps, not stored local dates,
percentages, or website totals. Retain intervals overlapping the retention cutoff
and clip them at read time. The legacy `totalActiveMs` accumulator on a live
record is not a reporting-period total; derive totals from retained intervals.

## Sleep events

Each `usageDiscardEvents` record contains:

```text
eventId, tabKey, observedAt, tabIdAtTime, windowIdAtTime,
url, title, source (automatic | manual | external)
```

A shared transition recorder handles automatic/manual API confirmations and
external `tabs.onUpdated` notifications. During an API attempt the callback's
captured time/source are retained; the confirmation and subsequent notification
produce one event. A wake resets the episode so sleeping again can create another.
The confirmation's current tab URL/title is used for attribution.

Refused or failed attempts are not sleep events. A tab discovered already asleep
at startup is a snapshot with an unknown sleep time, not an event at startup.
An external event time is when the transition was observed, not an inferred exact
internal Firefox timestamp. Clearing usage does not fabricate an event for a tab
that is still sleeping when a fresh recording history begins.

## Coverage and recovery

`usageCoverage.historyId` distinguishes recording generations, so queued events
from before Clear usage data cannot repopulate a new history, even if timestamps
fall in the same millisecond. `recordingStartedAt` marks the initial boundary;
`legacyHistory` remains false for fresh histories; no old records are imported. A segment has
`id`, `startedAt`, `lastCheckpointAt`, `endedAt` (null while open), `startReason`,
and, once ended, `endReason`. `observationErrors` flags failed tab observations;
`observationErrorsFrom`/`observationErrorsThrough` bound the affected interval so a
future view can qualify the relevant period. Gaps between segments are unknown
recording periods, not measured inactivity.

Checkpoints occur at five-minute alarms and persisted activity changes.
`browser.storage.session` holds a browser-session token and a best-effort clean
suspension marker containing the last successfully persisted revision. That
storage survives event-page suspension but not browser shutdown. See Mozilla's
[storage.session reference](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session).

Continuation requires matching tokens/revisions, a clean suspension marker, and
a checkpoint no more than ten minutes old. Queued wake-triggering events run
before foreground reconciliation, so switching tabs while the event page is
suspended can end the previous interval at the captured activation time. If the
current foreground tab/URL cannot be reconciled, recovery falls back to the last
trustworthy checkpoint and starts a new segment.

Absent/stale markers, process crashes, restarts, clock discontinuities, and long
checkpoint gaps are recovered conservatively. Close the old interval/coverage at
the last checkpoint and begin a new observation segment. Do not fill offline or
uncertain time with fabricated foreground usage. Pending writes at an unexpected
shutdown can still lose data after the last persisted checkpoint. The clean
suspension marker is best-effort; if it cannot be written, recovery is conservative.
A recording-task error also breaks coverage rather than silently claiming it is
complete. This is observed foreground time, not a perfect audit or attention metric.

## Retention, caps, and clearing

Sessions and sleep events each have an independent 10,000-record cap. Coverage
segments are also bounded at 10,000. Pruning uses the configured 1–365-day
retention period, preserving boundary-overlapping foreground intervals.

`usageCoverage` maintains per-collection `retentionBefore`, `capBefore`, and
combined `incompleteBefore` boundaries for `sessions`, `discards`, and `coverage`.
These boundaries only advance: increasing retention cannot recover deleted data.
If a cap cuts through records sharing a timestamp, the boundary advances past
that millisecond to indicate partial data. A future view must intersect these
bounds with coverage segments and each tab's observed-presence metadata before
classifying a zero as reliable or a tab as rarely used.

Closed-tab metadata is removed once no retained session/event references it.
Open-tab observation metadata can outlive the detailed-history cutoff, allowing
known last access/activation to be reported without retaining old browsing URLs.

Disabling tracking clears completed/ongoing sessions, sleep events, tab metadata,
and coverage data. Clear usage data does the same after confirmation, then starts
a fresh boundary and snapshots currently open tabs if recording remains enabled.
The independent non-history last-sleep metadata and manual protection remain.
No detailed activity records are collected while recording is disabled.

## Deriving the planned metrics later

* Tab time: sum clipped completed intervals plus the ongoing interval up to a
  single reference time; join by persistent key, not current URL.
* Active-time share: divide by all recorded foreground time in the same period,
  including closed tabs; use unavailable rather than divide by zero.
* Sleep count: count confirmed events in the period, with sleep-coverage limits.
* Website totals: group each interval/event by its own URL's hostname, allowing
  one tab to contribute to multiple websites over its history.
* Daily totals: split absolute intervals at local calendar boundaries, including
  23/25-hour daylight-saving days. No daily aggregate is collected separately.
* Stale tabs: use current Firefox `lastAccessed`, with unknown values explicit;
  missing foreground sessions alone never prove a tab has not been accessed.
* Low-usage protected tabs: combine current protections with activity, last access,
  current observed presence, and sufficiently complete recording coverage.
* Timeline: merge completed/ongoing intervals and confirmed sleep events, including
  retained closed-tab records. It does not claim to record every browser action.

## Verification

Tests exercise the deliberate old-history reset, small settings/runtime writes,
indexed history persistence, transaction rollback, large-history behavior,
retention/caps, coverage, duplicate sleep episodes, tab metadata, and test-only
tab/website/day calculations. Background
integration tests drive mocked Firefox event/message/storage APIs for opt-in/out,
clearing, source attribution, refusals, navigation, focus, tab movement, clean
suspension, unexpected reload, restart, closure, restoration, and duplication.

Node tests use an asynchronous IndexedDB contract double; browser tests use native
IndexedDB. Neither Node timings nor mocked Firefox event tests establish actual
Firefox UI latency. A live Firefox smoke test is still needed before publishing;
headless Firefox crashes in the implementation environment before loading tests.
