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
  main: document.querySelector("main"),
  list: document.querySelector("#tab-list"),
  notice: document.querySelector("#notice"),
  discardWindow: document.querySelector("#discard-window"),
  currentTabIcon: document.querySelector("#current-tab-icon"),
  currentTabPageTitle: document.querySelector("#current-tab-page-title"),
  currentTabUrl: document.querySelector("#current-tab-url"),
  currentTabSleep: document.querySelector("#current-tab-sleep"),
  currentTabUsage: document.querySelector("#current-tab-usage"),
  currentTabDetailsSeparator: document.querySelector("#current-tab-details-separator"),
  protectTab: document.querySelector("#protect-tab"),
  protectionStatus: document.querySelector("#tab-protection-status"),
  protectionStatusText: document.querySelector("#tab-protection-status-text"),
  settings: document.querySelector("#settings"),
};

let popupState;
let selectedView = "sleeping";
const windowParams = new URLSearchParams(window.location.search);
const standalone = windowParams.has("window");
const targetTabId = standalone && /^\d+$/.test(windowParams.get("tab") ?? "")
  ? Number(windowParams.get("tab"))
  : null;
if (standalone) document.documentElement.classList.add("window-view");

function sizeTabList() {
  if (standalone) return;
  const availableHeight = Math.min(600, screen.availHeight);
  const listTop = elements.list.getBoundingClientRect().top;
  const bottomPadding = parseFloat(getComputedStyle(elements.main).paddingBottom) || 0;
  const height = Math.max(0, Math.min(330, Math.floor(availableHeight - listTop - bottomPadding)));
  const maxHeight = `${height}px`;
  if (elements.list.style.maxHeight !== maxHeight) elements.list.style.maxHeight = maxHeight;
}

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
  const site = document.createElement("span");
  site.className = "tab-url";
  site.textContent = hostname(record.url);
  metadata.append(site, ` · ${Number.isFinite(record.discardedAt) ? formatRelative(record.discardedAt) : "Sleep time unknown"} · ${reasonLabel(record.reason)}${usage}${lastActive}`);
  copy.append(title, metadata);

  row.append(icon, copy, createTabActions(record));
  return row;
}

function protectionLabel(reason) {
  if (reason.type === "extension") return `Protected by extension: ${reason.extensionId}`;
  return {
    tab: "Protected manually",
    pinned: "Pinned tab",
    audible: "Playing audio",
    "special-page": "Special page",
    "auto-discardable": "autoDiscardable is false",
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
  const site = document.createElement("span");
  site.className = "tab-url";
  site.textContent = siteLabel(tab.url);
  metadata.append(site, ` · ${lastAccessed} · ${tab.protectionReasons.map(protectionLabel).join(" · ")}`);
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
  const eligibleCount = popupState.eligibleDiscardCount;
  elements.discardWindow.hidden = !eligibleCount;
  elements.discardWindow.textContent = `Discard ${eligibleCount} now`;
  elements.discardWindow.setAttribute("aria-label", `Discard ${eligibleCount} eligible tab${eligibleCount === 1 ? "" : "s"} now`);
  const currentTab = popupState.currentTab;
  const reasons = currentTab?.protectionReasons ?? [];
  elements.currentTabPageTitle.textContent = currentTab?.title || "Untitled tab";
  elements.currentTabPageTitle.title = currentTab?.title || "";
  elements.currentTabUrl.textContent = currentTab?.url || "URL unavailable";
  elements.currentTabUrl.title = currentTab?.url || "";
  const sleep = currentTab?.lastSleep;
  const sleepTime = Number.isFinite(sleep?.discardedAt) ? formatRelative(sleep.discardedAt).toLowerCase() : "time unknown";
  elements.currentTabSleep.textContent = !currentTab ? "last slept unknown" : sleep
    ? `last slept ${sleepTime}`
    : "no recorded sleep";
  elements.currentTabSleep.title = Number.isFinite(sleep?.discardedAt) ? new Date(sleep.discardedAt).toLocaleString() : "";
  elements.currentTabUsage.hidden = !currentTab || !popupState.settings.usageTrackingEnabled;
  elements.currentTabDetailsSeparator.hidden = elements.currentTabUsage.hidden;
  const days = popupState.settings.usageHistoryDays;
  elements.currentTabUsage.textContent = currentTab?.usage
    ? `${formatDuration(currentTab.usage.totalActiveMs).toLowerCase()} active in the last ${days} day${days === 1 ? "" : "s"}`
    : "active time unknown";
  elements.currentTabIcon.hidden = !currentTab?.favIconUrl;
  if (currentTab?.favIconUrl) elements.currentTabIcon.src = currentTab.favIconUrl;
  else elements.currentTabIcon.removeAttribute("src");
  elements.protectTab.disabled = !currentTab;
  elements.protectTab.hidden = !currentTab || reasons.some((reason) => reason.type !== "tab");
  elements.protectTab.textContent = currentTab?.memorySaverProtected
    ? "Allow discarding this Tab"
    : "Protect this Tab";
  elements.protectionStatus.hidden = !reasons.length;
  elements.protectionStatusText.textContent = reasons.length
    ? `This tab is currently protected. ${reasons.map(protectionLabel).join(" · ")}.${reasons.some((reason) => reason.type === "tab") ? " Manual protection only applies to this tab and is preserved until the tab is closed." : ""}`
    : "";
  renderSelectedList();
  sizeTabList();
}

function showNotice(message, error = false) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle("error", error);
  sizeTabList();
}

async function refresh() {
  popupState = await request({ type: "GET_POPUP_STATE", ...(standalone ? { targetTabId } : {}) });
  render();
}

async function runDiscard() {
  elements.discardWindow.disabled = true;
  showNotice("Checking tabs…");
  try {
    const { discardedTabIds, refusedCount, failedCount } = await request({ type: "DISCARD_ELIGIBLE_NOW" });
    const messages = [];
    if (discardedTabIds.length) {
      messages.push(`Discarded ${discardedTabIds.length} tab${discardedTabIds.length === 1 ? "" : "s"}.`);
    } else if (!refusedCount) {
      messages.push(failedCount ? "No tabs discarded." : "No eligible tabs found.");
    }
    if (refusedCount) messages.push(`Firefox refused to discard ${refusedCount} tab${refusedCount === 1 ? "" : "s"}.`);
    if (failedCount) messages.push(`Could not discard ${failedCount} tab${failedCount === 1 ? "" : "s"} due to an error.`);
    showNotice(messages.join(" "));
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    elements.discardWindow.disabled = false;
  }
}

elements.enabled.addEventListener("change", async () => {
  try {
    popupState.settings.enabled = elements.enabled.checked;
    popupState.settings = await request({ type: "SAVE_SETTINGS", settings: popupState.settings });
    render();
  } catch (error) { showNotice(error.message, true); }
});
elements.currentTabIcon.addEventListener("error", () => { elements.currentTabIcon.hidden = true; });
elements.protectTab.addEventListener("click", async () => {
  const tabId = popupState?.currentTab?.id;
  if (!Number.isInteger(tabId)) return;
  elements.protectTab.disabled = true;
  try {
    await request({ type: "TOGGLE_TAB_PROTECTION", tabId });
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    elements.protectTab.disabled = !popupState?.currentTab;
  }
});
elements.discardWindow.addEventListener("click", runDiscard);
elements.settings.addEventListener("click", () => browser.runtime.openOptionsPage());

function selectView(view) {
  selectedView = view;
  renderSelectedList();
  sizeTabList();
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

if (!standalone) {
  const resizeObserver = new ResizeObserver(sizeTabList);
  resizeObserver.observe(elements.main);
  window.addEventListener("resize", sizeTabList);
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "EXTERNAL_PROTECTION_CHANGED") {
    refresh().catch((error) => showNotice(error.message, true));
  }
});

refresh().catch((error) => showNotice(error.message, true));
