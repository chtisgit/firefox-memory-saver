import { DEFAULT_SETTINGS, normalizeDomain } from "../core/settings.js";

const form = document.querySelector("#settings-form");
const fields = {
  enabled: document.querySelector("#enabled"),
  inactivityMinutes: document.querySelector("#inactivity"),
  minimumLoadedTabsPerWindow: document.querySelector("#minimum-loaded"),
  minimumLoadedTabsTotal: document.querySelector("#minimum-loaded-total"),
  protectPinned: document.querySelector("#protect-pinned"),
  protectAudible: document.querySelector("#protect-audible"),
  protectedDomains: document.querySelector("#domains"),
  usageTrackingEnabled: document.querySelector("#usage-enabled"),
  usageHistoryDays: document.querySelector("#usage-days"),
};
const status = document.querySelector("#status");

async function request(message) {
  const response = await browser.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? "The extension did not respond.");
  return response.data;
}

function showStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function populate(settings) {
  fields.enabled.checked = settings.enabled;
  fields.inactivityMinutes.value = settings.inactivityMinutes;
  fields.minimumLoadedTabsPerWindow.value = settings.minimumLoadedTabsPerWindow;
  fields.minimumLoadedTabsTotal.value = settings.minimumLoadedTabsTotal;
  fields.protectPinned.checked = settings.protectPinned;
  fields.protectAudible.checked = settings.protectAudible;
  fields.protectedDomains.value = settings.protectedDomains.join("\n");
  fields.usageTrackingEnabled.checked = settings.usageTrackingEnabled;
  fields.usageHistoryDays.value = settings.usageHistoryDays;
  fields.usageHistoryDays.disabled = !settings.usageTrackingEnabled;
}

function readSettings() {
  const rawDomains = fields.protectedDomains.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const invalidDomain = rawDomains.find((domain) => !normalizeDomain(domain));
  if (invalidDomain) throw new Error(`Invalid protected domain: ${invalidDomain}`);
  return {
    schemaVersion: 1,
    enabled: fields.enabled.checked,
    inactivityMinutes: Number(fields.inactivityMinutes.value),
    minimumLoadedTabsPerWindow: Number(fields.minimumLoadedTabsPerWindow.value),
    minimumLoadedTabsTotal: Number(fields.minimumLoadedTabsTotal.value),
    protectPinned: fields.protectPinned.checked,
    protectAudible: fields.protectAudible.checked,
    protectedDomains: rawDomains,
    usageTrackingEnabled: fields.usageTrackingEnabled.checked,
    usageHistoryDays: Number(fields.usageHistoryDays.value),
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  showStatus("Saving…");
  try {
    populate(await request({ type: "SAVE_SETTINGS", settings: readSettings() }));
    showStatus("Settings saved.");
  } catch (error) { showStatus(error.message, true); }
});

document.querySelector("#restore-defaults").addEventListener("click", () => {
  populate(DEFAULT_SETTINGS);
  showStatus("Default values loaded. Select Save settings to apply them.");
});

fields.usageTrackingEnabled.addEventListener("change", () => {
  fields.usageHistoryDays.disabled = !fields.usageTrackingEnabled.checked;
});

document.querySelector("#clear-usage").addEventListener("click", async () => {
  if (!window.confirm("Clear all recorded foreground activity history? This cannot be undone.")) return;
  try {
    await request({ type: "CLEAR_USAGE_DATA" });
    showStatus("Usage data cleared.");
  } catch (error) { showStatus(error.message, true); }
});

request({ type: "GET_SETTINGS" }).then(populate).catch((error) => showStatus(error.message, true));
