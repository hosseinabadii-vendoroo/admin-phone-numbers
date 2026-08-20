import { CONFIG } from "./config.js";
import { getPhoneNumberStatus, importElevenlabs, switchPhoneProvider } from "./api.js";
import { renderResults } from "./results.js";
import {
  applyResultsToRoutingCache,
  loadRoutingCache,
  providerLabel,
  refreshOneClient,
  refreshRouting,
  renderRoutingTable,
  routingEntryFor,
  setRoutingControlsDisabled,
  stopRoutingRefresh,
} from "./routing.js";

const els = {
  baseUrl: document.getElementById("baseUrl"),
  token: document.getElementById("token"),
  clientIds: document.getElementById("clientIds"),
  forwardVoice: document.getElementById("forwardVoice"),
  twilioSid: document.getElementById("twilioSid"),
  twilioToken: document.getElementById("twilioToken"),
  banner: document.getElementById("banner"),
  busy: document.getElementById("busy"),
  stats: document.getElementById("stats"),
  emptyState: document.getElementById("emptyState"),
  resultsTable: document.getElementById("resultsTable"),
  resultsBody: document.getElementById("resultsBody"),
  rawBlock: document.getElementById("rawBlock"),
  rawJson: document.getElementById("rawJson"),
  connLabel: document.getElementById("connLabel"),
  connPill: document.getElementById("connPill"),
  authPill: document.getElementById("authPill"),
  confirmDialog: document.getElementById("confirmDialog"),
  confirmText: document.getElementById("confirmText"),
  confirmOk: document.getElementById("confirmOk"),
  confirmCancel: document.getElementById("confirmCancel"),
  btnStatus: document.getElementById("btnStatus"),
  btnImport: document.getElementById("btnImport"),
  btnSwitch: document.getElementById("btnSwitch"),
  btnRefreshRouting: document.getElementById("btnRefreshRouting"),
  routingBusy: document.getElementById("routingBusy"),
  routingBusyLabel: document.getElementById("routingBusyLabel"),
  routingMeta: document.getElementById("routingMeta"),
  routingEmpty: document.getElementById("routingEmpty"),
  routingTable: document.getElementById("routingTable"),
  routingBody: document.getElementById("routingBody"),
};

els.baseUrl.value = CONFIG.baseUrl;
els.token.value = CONFIG.token;
updateHeaderPills();
els.baseUrl.addEventListener("input", updateHeaderPills);
els.token.addEventListener("input", updateHeaderPills);

function readAuth() {
  return {
    baseUrl: els.baseUrl.value,
    token: els.token.value,
  };
}

function updateHeaderPills() {
  const base = els.baseUrl.value.trim();

  if (!base) {
    els.connLabel.textContent = "no base URL";
    els.connPill.classList.remove("live");
  } else {
    try {
      const u = new URL(base);
      els.connLabel.textContent = u.host + u.pathname.replace(/\/$/, "");
      els.connPill.classList.add("live");
    } catch {
      els.connLabel.textContent = "invalid base URL";
      els.connPill.classList.remove("live");
    }
  }

  if (els.token.value.trim()) {
    els.authPill.textContent = "Bearer · configured";
    els.authPill.classList.add("live");
  } else {
    els.authPill.textContent = "Bearer · missing";
    els.authPill.classList.remove("live");
  }
}

function parseClientIds() {
  const raw = els.clientIds.value.trim();
  if (!raw) return [];

  const parts = raw.split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean);
  const ids = [];

  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      throw new Error(`Invalid client ID: "${part}" (digits only)`);
    }

    ids.push(Number(part));
  }

  const unique = [...new Set(ids)];
  if (unique.length > 100) {
    throw new Error("Maximum 100 client IDs per request");
  }

  return unique;
}

function twilioOverride() {
  const sid = els.twilioSid.value.trim();
  const token = els.twilioToken.value.trim();

  if (Boolean(sid) !== Boolean(token)) {
    throw new Error("twilio_account_sid and twilio_auth_token must both be provided or both omitted");
  }

  if (!sid) return null;

  return { twilio_account_sid: sid, twilio_auth_token: token };
}

function selectedProvider() {
  const checked = document.querySelector('input[name="provider"]:checked');

  return checked ? checked.value : "elevenlabs";
}

function setBusy(on) {
  els.busy.classList.toggle("show", on);
  els.btnStatus.disabled = on;
  els.btnImport.disabled = on;
  els.btnSwitch.disabled = on;
  setRoutingControlsDisabled(els, on);
}

function showBanner(type, message) {
  els.banner.className = `banner show ${type}`;
  els.banner.textContent = message;
}

function clearBanner() {
  els.banner.className = "banner";
  els.banner.textContent = "";
}

async function runStatus() {
  clearBanner();
  const ids = parseClientIds();
  if (!ids.length) throw new Error("Enter at least one client ID");

  return getPhoneNumberStatus(readAuth(), ids, twilioOverride());
}

async function runImport() {
  clearBanner();
  const ids = parseClientIds();
  if (!ids.length) throw new Error("Enter at least one client ID");

  return importElevenlabs(readAuth(), ids, els.forwardVoice.checked, twilioOverride());
}

async function runSwitch() {
  clearBanner();
  const ids = parseClientIds();
  if (!ids.length) throw new Error("Enter at least one client ID");

  return switchPhoneProvider(
    readAuth(),
    ids,
    selectedProvider(),
    els.forwardVoice.checked,
    twilioOverride(),
  );
}

async function runRowSwitch(clientId, provider) {
  clearBanner();

  return switchPhoneProvider(
    readAuth(),
    [Number(clientId)],
    provider,
    els.forwardVoice.checked,
    twilioOverride(),
  );
}

async function withUi(fn) {
  setBusy(true);
  try {
    const data = await fn();
    renderResults(els, data);
    applyResultsToRoutingCache(els, data);
    const n = Array.isArray(data?.results) ? data.results.length : 0;
    const errors = (data?.results || []).filter((r) => String(r.status).toLowerCase() === "error").length;

    if (errors) {
      showBanner("error", `Completed with ${errors} error(s) out of ${n} result(s).`);
    } else {
      showBanner("ok", `Done — ${n} result(s).`);
    }
  } catch (err) {
    showBanner("error", err.message || String(err));
  } finally {
    setBusy(false);
  }
}

els.btnStatus.addEventListener("click", () => withUi(runStatus));
els.btnImport.addEventListener("click", () => withUi(runImport));

els.btnRefreshRouting.addEventListener("click", async () => {
  setBusy(true);
  try {
    await refreshRouting(els, readAuth(), twilioOverride(), { clearBanner, showBanner });
  } catch (err) {
    showBanner("error", err.message || String(err));
    stopRoutingRefresh(els);
  } finally {
    setBusy(false);
  }
});

let pendingSwitch = null;

els.btnSwitch.addEventListener("click", () => {
  try {
    const ids = parseClientIds();
    if (!ids.length) throw new Error("Enter at least one client ID");
    twilioOverride();
    const provider = selectedProvider();
    els.confirmText.textContent =
      `Switch ${ids.length} client(s) to "${provider}". This updates live Twilio VoiceUrl + SmsUrl (+ fallbacks).`;
    pendingSwitch = { type: "batch" };
    els.confirmDialog.showModal();
  } catch (err) {
    showBanner("error", err.message || String(err));
  }
});

els.routingBody.addEventListener("click", (event) => {
  const refreshBtn = event.target.closest("[data-refresh-client]");
  if (refreshBtn) {
    if (refreshBtn.disabled) return;

    const clientId = Number(refreshBtn.getAttribute("data-refresh-client"));

    (async () => {
      setBusy(true);
      try {
        await refreshOneClient(els, readAuth(), twilioOverride(), clientId, {
          clearBanner,
          showBanner,
        });
      } catch (err) {
        showBanner("error", err.message || String(err));
      } finally {
        setBusy(false);
      }
    })();

    return;
  }

  const button = event.target.closest("[data-switch-client]");
  if (!button || button.disabled) return;
  if (button.classList.contains("is-current")) return;

  const clientId = Number(button.getAttribute("data-switch-client"));
  const provider = button.getAttribute("data-switch-provider");
  const cache = loadRoutingCache();
  const current = routingEntryFor(clientId, cache).primary;
  const currentLabel = providerLabel(current);

  try {
    twilioOverride();
  } catch (err) {
    showBanner("error", err.message || String(err));

    return;
  }

  els.confirmText.textContent =
    `Switch client ${clientId} from "${currentLabel}" to "${provider}". This updates live Twilio VoiceUrl + SmsUrl (+ fallbacks).`;
  pendingSwitch = { type: "row", clientId, provider };
  els.confirmDialog.showModal();
});

els.confirmCancel.addEventListener("click", () => {
  pendingSwitch = null;
  els.confirmDialog.close();
});

els.confirmOk.addEventListener("click", () => {
  els.confirmDialog.close();
  const pending = pendingSwitch;
  pendingSwitch = null;
  if (!pending) return;

  if (pending.type === "row") {
    withUi(() => runRowSwitch(pending.clientId, pending.provider));

    return;
  }

  withUi(runSwitch);
});

function activateTab(tabId) {
  const tabs = [
    { tab: document.getElementById("tabProvider"), panel: document.getElementById("panelProvider") },
    { tab: document.getElementById("tabBatch"), panel: document.getElementById("panelBatch") },
  ];

  for (const item of tabs) {
    const selected = item.tab.id === tabId;
    item.tab.setAttribute("aria-selected", selected ? "true" : "false");
    item.panel.hidden = !selected;
  }
}

document.getElementById("tabProvider").addEventListener("click", () => activateTab("tabProvider"));
document.getElementById("tabBatch").addEventListener("click", () => activateTab("tabBatch"));

renderRoutingTable(els);
