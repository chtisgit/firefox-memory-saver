import { formatDuration, formatRelative } from "../core/time.js";

const elements = {
  enabled: document.querySelector("#enabled"),
  status: document.querySelector("#status-copy"),
  count: document.querySelector("#discarded-count"),
  lifetime: document.querySelector("#lifetime-count"),
  list: document.querySelector("#tab-list"),
  notice: document.querySelector("#notice"),
  discardWindow: document.querySelector("#discard-window"),
  discardOthers: document.querySelector("#discard-others"),
  settings: document.querySelector("#settings"),
};

let popupState;

async function request(message) {
  const response = await browser.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? "The extension did not respond.");
  return response.data;
}

function hostname(url) {
  try { return new URL(url).hostname; } catch { return "Unknown site"; }
}

function reasonLabel(reason) {
  return {
    automatic: "Automatic",
    "manual-eligible": "Manual",
    "manual-others": "Manual",
    external: "Firefox or another extension",
  }[reason] ?? "Unknown";
}

function createActionButton(className, label, paths) {
  const button = document.createElement("button");
  button.className = `tab-action ${className}`;
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const pathData of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  }
  button.append(svg);
  return button;
}

function createTabRow(record) {
  const row = document.createElement("article");
  row.className = "tab-row";

  let icon;
  if (record.favIconUrl) {
    icon = document.createElement("img");
    icon.src = record.favIconUrl;
    icon.alt = "";
    icon.className = "favicon";
  } else {
    icon = document.createElement("span");
    icon.className = "favicon fallback";
    icon.textContent = (hostname(record.url)[0] ?? "?").toUpperCase();
  }

  const copy = document.createElement("div");
  copy.className = "tab-copy";
  const title = document.createElement("div");
  title.className = "tab-title";
  title.textContent = record.title || hostname(record.url) || "Untitled tab";
  title.title = title.textContent;
  const metadata = document.createElement("div");
  metadata.className = "tab-meta";
  const usage = popupState.settings.usageTrackingEnabled && record.usage?.totalActiveMs
    ? ` · Active ${formatDuration(record.usage.totalActiveMs)}`
    : "";
  const lastActive = popupState.settings.usageTrackingEnabled && record.usage?.lastActivatedAt
    ? ` · Last active ${formatRelative(record.usage.lastActivatedAt)}`
    : "";
  metadata.textContent = `${hostname(record.url)} · ${formatRelative(record.discardedAt)} · ${reasonLabel(record.reason)}${usage}${lastActive}`;
  copy.append(title, metadata);

  const restore = createActionButton("restore", "Restore tab", [
    "M4.75 8.5V4.75H8.5",
    "M5.2 7.65A8 8 0 1 1 4.4 14",
  ]);
  const close = createActionButton("close-tab", "Close tab", [
    "M6.75 6.75 17.25 17.25",
    "M17.25 6.75 6.75 17.25",
  ]);

  const actions = document.createElement("div");
  actions.className = "tab-actions";
  actions.append(restore, close);

  restore.addEventListener("click", async () => {
    restore.disabled = true;
    close.disabled = true;
    try {
      await request({ type: "RESTORE_TAB", tabId: record.tabId, windowId: record.windowId });
      window.close();
    } catch (error) {
      showNotice(error.message, true);
      restore.disabled = false;
      close.disabled = false;
    }
  });
  close.addEventListener("click", async () => {
    restore.disabled = true;
    close.disabled = true;
    try {
      await request({ type: "CLOSE_TAB", tabId: record.tabId });
      showNotice("Tab closed.");
      await refresh();
    } catch (error) {
      showNotice(error.message, true);
      restore.disabled = false;
      close.disabled = false;
    }
  });
  row.append(icon, copy, actions);
  return row;
}

function render() {
  elements.enabled.checked = popupState.settings.enabled;
  elements.status.textContent = popupState.settings.enabled
    ? `Automatic · after ${formatDuration(popupState.settings.inactivityMinutes * 60_000)}`
    : "Automatic discarding is off";
  elements.count.textContent = String(popupState.discardedTabs.length);
  elements.lifetime.textContent = `${popupState.lifetimeDiscardCount} discarded by Memory Saver over time`;
  elements.list.replaceChildren();
  if (!popupState.discardedTabs.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No tabs are currently discarded.";
    elements.list.append(empty);
    return;
  }
  elements.list.append(...popupState.discardedTabs.map(createTabRow));
}

function showNotice(message, error = false) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle("error", error);
}

async function refresh() {
  popupState = await request({ type: "GET_POPUP_STATE" });
  render();
}

async function runDiscard(type) {
  elements.discardWindow.disabled = true;
  elements.discardOthers.disabled = true;
  showNotice("Checking tabs…");
  try {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    const ids = await request({
      type,
      windowId: type === "DISCARD_OTHER_TABS" ? active?.windowId : undefined,
      activeTabId: active?.id,
    });
    showNotice(ids.length ? `Discarded ${ids.length} tab${ids.length === 1 ? "" : "s"}.` : "No eligible tabs found.");
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    elements.discardWindow.disabled = false;
    elements.discardOthers.disabled = false;
  }
}

elements.enabled.addEventListener("change", async () => {
  try {
    popupState.settings.enabled = elements.enabled.checked;
    popupState.settings = await request({ type: "SAVE_SETTINGS", settings: popupState.settings });
    render();
  } catch (error) { showNotice(error.message, true); }
});
elements.discardWindow.addEventListener("click", () => runDiscard("DISCARD_ELIGIBLE_NOW"));
elements.discardOthers.addEventListener("click", () => runDiscard("DISCARD_OTHER_TABS"));
elements.settings.addEventListener("click", () => browser.runtime.openOptionsPage());

refresh().catch((error) => showNotice(error.message, true));
