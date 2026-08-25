import { formatDuration, formatRelative } from "../core/time.js";

const elements = {
  enabled: document.querySelector("#enabled"),
  status: document.querySelector("#status-copy"),
  count: document.querySelector("#discarded-count"),
  sleepingView: document.querySelector("#sleeping-view"),
  protectedView: document.querySelector("#protected-view"),
  sleepingViewCount: document.querySelector("#sleeping-view-count"),
  protectedViewCount: document.querySelector("#protected-view-count"),
  lifetime: document.querySelector("#lifetime-count"),
  list: document.querySelector("#tab-list"),
  notice: document.querySelector("#notice"),
  discardWindow: document.querySelector("#discard-window"),
  discardOthers: document.querySelector("#discard-others"),
  settings: document.querySelector("#settings"),
};

let popupState;
let selectedView = "sleeping";

async function request(message) {
  const response = await browser.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? "The extension did not respond.");
  return response.data;
}

function hostname(url) {
  try { return new URL(url).hostname; } catch { return "Unknown site"; }
}

function siteLabel(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname || `${parsed.protocol.replace(":", "")} page`;
  } catch {
    return "Unknown site";
  }
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

function createTabActions(record, primaryLabel = "Restore tab") {
  const primary = createActionButton("restore", primaryLabel, [
    "M4.75 8.5V4.75H8.5",
    "M5.2 7.65A8 8 0 1 1 4.4 14",
  ]);
  const close = createActionButton("close-tab", "Close tab", [
    "M6.75 6.75 17.25 17.25",
    "M17.25 6.75 6.75 17.25",
  ]);

  const actions = document.createElement("div");
  actions.className = "tab-actions";
  actions.append(primary, close);

  primary.addEventListener("click", async () => {
    primary.disabled = true;
    close.disabled = true;
    try {
      await request({ type: "RESTORE_TAB", tabId: record.tabId ?? record.id, windowId: record.windowId });
      window.close();
    } catch (error) {
      showNotice(error.message, true);
      primary.disabled = false;
      close.disabled = false;
    }
  });
  close.addEventListener("click", async () => {
    primary.disabled = true;
    close.disabled = true;
    try {
      await request({ type: "CLOSE_TAB", tabId: record.tabId ?? record.id });
      showNotice("Tab closed.");
      await refresh();
    } catch (error) {
      showNotice(error.message, true);
      primary.disabled = false;
      close.disabled = false;
    }
  });
  return actions;
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

  row.append(icon, copy, createTabActions(record));
  return row;
}

function protectionLabel(reason) {
  return {
    tab: "Protected manually",
    pinned: "Pinned tab",
    audible: "Playing audio",
    "special-page": "Special page",
  }[reason.type] ?? (reason.type === "domain" ? `Protected domain: ${reason.domain}` : "Protected");
}

function createProtectedTabRow(tab) {
  const row = document.createElement("article");
  row.className = "tab-row";

  let icon;
  if (tab.favIconUrl) {
    icon = document.createElement("img");
    icon.src = tab.favIconUrl;
    icon.alt = "";
    icon.className = "favicon";
  } else {
    icon = document.createElement("span");
    icon.className = "favicon fallback";
    icon.textContent = (siteLabel(tab.url)[0] ?? "?").toUpperCase();
  }

  const copy = document.createElement("div");
  copy.className = "tab-copy";
  const title = document.createElement("div");
  title.className = "tab-title";
  title.textContent = tab.title || siteLabel(tab.url) || "Untitled tab";
  title.title = title.textContent;
  const metadata = document.createElement("div");
  metadata.className = "tab-meta";
  const lastAccessed = Number.isFinite(tab.lastAccessed)
    ? `Last accessed ${formatRelative(tab.lastAccessed)}`
    : "Last accessed unknown";
  metadata.textContent = `${siteLabel(tab.url)} · ${lastAccessed} · ${tab.protectionReasons.map(protectionLabel).join(" · ")}`;
  copy.append(title, metadata);
  row.append(icon, copy, createTabActions(tab, "Switch to tab"));
  return row;
}

function renderSelectedList() {
  const sleeping = selectedView === "sleeping";
  const records = sleeping ? popupState.discardedTabs : popupState.protectedTabs;
  elements.sleepingView.classList.toggle("selected", sleeping);
  elements.protectedView.classList.toggle("selected", !sleeping);
  elements.sleepingView.setAttribute("aria-selected", String(sleeping));
  elements.protectedView.setAttribute("aria-selected", String(!sleeping));
  elements.sleepingView.tabIndex = sleeping ? 0 : -1;
  elements.protectedView.tabIndex = sleeping ? -1 : 0;
  elements.list.setAttribute("aria-labelledby", sleeping ? "sleeping-view" : "protected-view");
  elements.list.replaceChildren();

  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = sleeping
      ? "No tabs are currently discarded."
      : "No open tabs are currently protected.";
    elements.list.append(empty);
    return;
  }
  elements.list.append(...records.map(sleeping ? createTabRow : createProtectedTabRow));
}

function render() {
  elements.enabled.checked = popupState.settings.enabled;
  elements.status.textContent = popupState.settings.enabled
    ? `Automatic · after ${formatDuration(popupState.settings.inactivityMinutes * 60_000)}`
    : "Automatic discarding is off";
  elements.count.textContent = String(popupState.discardedTabs.length);
  elements.sleepingViewCount.textContent = String(popupState.discardedTabs.length);
  elements.protectedViewCount.textContent = String(popupState.protectedTabs.length);
  elements.lifetime.textContent = `${popupState.lifetimeDiscardCount} discarded by Memory Saver over time`;
  renderSelectedList();
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

function selectView(view) {
  selectedView = view;
  renderSelectedList();
}

elements.sleepingView.addEventListener("click", () => selectView("sleeping"));
elements.protectedView.addEventListener("click", () => selectView("protected"));
for (const button of [elements.sleepingView, elements.protectedView]) {
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const view = selectedView === "sleeping" ? "protected" : "sleeping";
    selectView(view);
    (view === "sleeping" ? elements.sleepingView : elements.protectedView).focus();
  });
}

refresh().catch((error) => showNotice(error.message, true));
