import { HISTORY_DATABASE, HISTORY_STORES, idbRequest } from "../src/core/history-store.js";
import { emptyActivityState } from "../src/core/activity.js";

// Tests may inspect all history; production startup and UI never use this path.
export async function historySnapshot(factory = indexedDB) {
  const db = await idbRequest(factory.open(HISTORY_DATABASE, 1));
  const tx = db.transaction(HISTORY_STORES, "readonly");
  const rows = Object.fromEntries(await Promise.all(HISTORY_STORES.map(async name => [name,
    name === "checkpoint" ? await idbRequest(tx.objectStore(name).get("recorder")) : await idbRequest(tx.objectStore(name).getAll())])));
  db.close();
  const base = emptyActivityState();
  return { ...base, usageSessions: rows.sessions.sort((a, b) => a.sequence - b.sequence), usageDiscardEvents: rows.discards.sort((a, b) => a.sequence - b.sequence),
    usageTabMetadata: Object.fromEntries(rows.tabs.map(({ open, ...row }) => [row.tabKey, row])),
    liveUsageRecords: Object.fromEntries(rows.live.map(row => [row.tabKey, row])),
    usageCoverage: { ...base.usageCoverage, ...rows.checkpoint?.coverage, segments: rows.coverage.sort((a, b) => a.sequence - b.sequence) },
    usageRecorder: rows.checkpoint?.recorder ?? base.usageRecorder };
}
