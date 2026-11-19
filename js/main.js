import {
  BEARER_TOKEN_STORAGE,
  BULK_MAX_CLIENTS,
  BULK_PAUSE_MS,
  BULK_SWITCH_BATCH_SIZE,
  CONFIG,
  EL_KEY_STORAGE,
} from "./config.js";
import { bindStoredSecret } from "./credentials.js";
import { assignArm, getPhoneNumberStatus, importElevenlabs, switchPhoneProvider } from "./api.js";
import { renderResults } from "./results.js";
import {
  applyResultsToRoutingCache,
  armLabel,
  clearSelection,
  getSelectedClientIds,
  loadRoutingCache,
  providerLabel,
  refreshServerStatus,
  refreshElAgents,
  refreshOneClient,
  refreshRouting,
  renderRoutingTable,
  resolveArm,
  routingEntryFor,
  toggleAllVisibleSelected,
  setRoutingControlsDisabled,
  setRoutingLocked,
  setRoutingSort,
  setSelectedRange,
  toggleSelected,
  showStaleServerStatus,
  stopRoutingRefresh,
} from "./routing.js";
import { initElevenlabs } from "./elevenlabs.js";
import { getAbHealth, resetServerHealth } from "./server-health.js";

const els = {
  baseUrl: document.getElementById("baseUrl"),
  token: document.getElementById("token"),
  clientIds: document.getElementById("clientIds"),
  forwardVoice: document.getElementById("forwardVoice"),
  twilioSid: document.getElementById("twilioSid"),
  twilioToken: document.getElementById("twilioToken"),
  toasts: document.getElementById("toasts"),
  busy: document.getElementById("busy"),
  stats: document.getElementById("stats"),
  emptyState: document.getElementById("emptyState"),
  resultsTable: document.getElementById("resultsTable"),
  resultsBody: document.getElementById("resultsBody"),
  rawBlock: document.getElementById("rawBlock"),
  rawJson: document.getElementById("rawJson"),
  connLabel: document.getElementById("connLabel"),
  connPill: document.getElementById("connPill"),
  confirmDialog: document.getElementById("confirmDialog"),
  confirmTitle: document.getElementById("confirmTitle"),
  confirmText: document.getElementById("confirmText"),
  confirmOk: document.getElementById("confirmOk"),
  confirmCancel: document.getElementById("confirmCancel"),
  btnStatus: document.getElementById("btnStatus"),
  btnImport: document.getElementById("btnImport"),
  btnSwitch: document.getElementById("btnSwitch"),
  btnArmPreview: document.getElementById("btnArmPreview"),
  btnArmApply: document.getElementById("btnArmApply"),
  btnRefreshRouting: document.getElementById("btnRefreshRouting"),
  routingBusy: document.getElementById("routingBusy"),
  routingBusyLabel: document.getElementById("routingBusyLabel"),
  routingMeta: document.getElementById("routingMeta"),
  routingSource: document.getElementById("routingSource"),
  abStatus: document.getElementById("abStatus"),
  abPill: document.getElementById("abPill"),
  abLabel: document.getElementById("abLabel"),
  routingEmpty: document.getElementById("routingEmpty"),
  routingTable: document.getElementById("routingTable"),
  routingBody: document.getElementById("routingBody"),
  routingSearch: document.getElementById("routingSearch"),
  routingSelectAll: document.getElementById("routingSelectAll"),
  bulkBar: document.getElementById("bulkBar"),
  bulkCount: document.getElementById("bulkCount"),
  routingSearchCount: document.getElementById("routingSearchCount"),
  elApiKey: document.getElementById("elApiKey"),
};

els.baseUrl.value = CONFIG.baseUrl;
els.token.value = CONFIG.token;
bindStoredSecret(els.token, document.getElementById("rememberToken"), BEARER_TOKEN_STORAGE);
bindStoredSecret(els.elApiKey, document.getElementById("rememberElKey"), EL_KEY_STORAGE);
function markServersStale() {
  resetServerHealth();
  showStaleServerStatus(els);
}

els.baseUrl.addEventListener("input", markServersStale);
els.token.addEventListener("input", markServersStale);

function readAuth() {
  return {
    baseUrl: els.baseUrl.value,
    token: els.token.value,
  };
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

function selectedArmTarget() {
  const checked = document.querySelector('input[name="arm"]:checked');

  return checked ? checked.value : "control";
}

function setConfirm({ title, text, okLabel }) {
  els.confirmTitle.textContent = title;
  els.confirmText.textContent = text;
  els.confirmOk.textContent = okLabel;
}

function setBusy(on) {
  els.busy.classList.toggle("show", on);
  els.btnStatus.disabled = on;
  els.btnImport.disabled = on;
  els.btnSwitch.disabled = on;
  els.btnArmPreview.disabled = on;
  els.btnArmApply.disabled = on;
  setRoutingControlsDisabled(els, on);
}

const TOAST_MS = { error: 6000, info: 4500, ok: 4000 };
const TOAST_TITLE = { error: "Error", info: "Notice", ok: "Success" };
const TOAST_MARK = { error: "!", info: "i", ok: "✓" };

function dismissToast(toast) {
  if (!toast || toast.classList.contains("out")) return;

  window.clearTimeout(Number(toast.dataset.timerId || 0));
  toast.classList.add("out");
  window.setTimeout(() => toast.remove(), 280);
}

function showBanner(type, message) {
  const kind = TOAST_TITLE[type] ? type : "info";
  const toast = document.createElement("div");
  toast.className = `toast ${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");

  const icon = document.createElement("div");
  icon.className = "toast-icon";
  icon.textContent = TOAST_MARK[kind];

  const body = document.createElement("div");
  body.className = "toast-body";
  const title = document.createElement("strong");
  title.textContent = TOAST_TITLE[kind];
  const text = document.createElement("p");
  text.textContent = message;
  body.append(title, text);

  const close = document.createElement("button");
  close.className = "toast-close";
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => dismissToast(toast));

  const progress = document.createElement("div");
  progress.className = "toast-progress";

  toast.append(icon, body, close, progress);
  els.toasts.append(toast);

  // The timer and the progress bar both pause while the toast is hovered or focused.
  let remaining = TOAST_MS[kind];
  let startedAt = 0;
  let paused = true;

  const resume = () => {
    if (!paused) return;

    paused = false;
    startedAt = Date.now();
    toast.dataset.timerId = String(window.setTimeout(() => dismissToast(toast), remaining));
  };

  const pause = () => {
    if (paused) return;

    paused = true;
    window.clearTimeout(Number(toast.dataset.timerId || 0));
    remaining = Math.max(remaining - (Date.now() - startedAt), 0);
  };

  toast.addEventListener("mouseenter", pause);
  toast.addEventListener("mouseleave", resume);
  toast.addEventListener("focusin", pause);
  toast.addEventListener("focusout", resume);
  resume();
}

function clearBanner() {
  for (const toast of [...els.toasts.children]) {
    dismissToast(toast);
  }
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

/**
 * Why a client's number can't take ElevenLabs calls yet, or "" when it can. Read from a
 * phone-number-status row: the number must be imported to ElevenLabs and have an agent.
 * `elevenlabs_imported: null` means the server couldn't reach ElevenLabs, so it's unknown.
 */
function elevenlabsNotReadyReason(row) {
  if (!row) return "No status returned for this client";
  if (String(row.status).toLowerCase() !== "ok") return row.reason || `Status: ${row.status}`;
  if (row.elevenlabs_imported == null) return "ElevenLabs could not be reached, so readiness is unknown";
  if (row.elevenlabs_imported === false) return "Number is not imported to ElevenLabs";
  if (!row.elevenlabs_agent_id) return "No agent assigned in ElevenLabs";

  return "";
}

/** Extra confirm-dialog sentence for switches to ElevenLabs. */
function elevenlabsReadyNote(provider, { single = false } = {}) {
  if (provider !== "elevenlabs") return "";

  return single
    ? " It is checked first: if the number isn't imported to ElevenLabs or has no agent, nothing changes."
    : " Clients whose number isn't imported to ElevenLabs or has no agent are checked first and skipped.";
}

/**
 * Re-reads phone-number-status for `ids` and splits them into clients ready for ElevenLabs and
 * skipped rows (status "skipped", with the reason). The switch endpoint doesn't check this, so
 * every switch to ElevenLabs from this page goes through here first.
 */
async function checkElevenlabsReady(ids, twilio) {
  const data = await getPhoneNumberStatus(readAuth(), ids, twilio);
  const rows = Array.isArray(data?.results) ? data.results : [];
  applyResultsToRoutingCache(els, { results: rows });

  const byId = new Map(rows.map((row) => [Number(row.client_id), row]));
  const ready = [];
  const skipped = [];

  for (const id of ids) {
    const row = byId.get(Number(id));
    const reason = elevenlabsNotReadyReason(row);

    if (reason) {
      // local_skip: made by this page, not the server, so it must not overwrite the routing cache.
      skipped.push({ client_id: id, phone_number: row?.phone_number ?? null, status: "skipped", reason, local_skip: true });
    } else {
      ready.push(id);
    }
  }

  return { ready, skipped };
}

async function runSwitch() {
  clearBanner();
  const ids = parseClientIds();
  if (!ids.length) throw new Error("Enter at least one client ID");

  const provider = selectedProvider();
  const twilio = twilioOverride();
  let toSwitch = ids;
  let skipped = [];

  if (provider === "elevenlabs") {
    ({ ready: toSwitch, skipped } = await checkElevenlabsReady(ids, twilio));
    if (!toSwitch.length) return { action: "switch_phone_provider", provider, results: skipped };
  }

  const data = await switchPhoneProvider(readAuth(), toSwitch, provider, els.forwardVoice.checked, twilio);

  return { ...data, results: [...skipped, ...(Array.isArray(data?.results) ? data.results : [])] };
}

const bulkUi = {
  box: document.getElementById("bulkProgress"),
  title: document.getElementById("bulkProgressTitle"),
  detail: document.getElementById("bulkProgressDetail"),
  fill: document.getElementById("bulkProgressFill"),
  stop: document.getElementById("bulkStop"),
};
let bulkStopRequested = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function showBulkProgress(title, done, total, detail) {
  bulkUi.box.hidden = false;
  bulkUi.title.textContent = title;
  bulkUi.detail.textContent = `${done} of ${total} done · ${total - done} remaining${detail ? ` · ${detail}` : ""}`;
  bulkUi.fill.style.width = `${(done / total) * 100}%`;
}

/** Waits between requests, counting down in the progress bar. Returns early if Stop was pressed. */
async function bulkPause(title, done, total) {
  for (let left = BULK_PAUSE_MS; left > 0 && !bulkStopRequested; left -= 250) {
    showBulkProgress(title, done, total, `next in ${(left / 1000).toFixed(1)}s`);
    await sleep(Math.min(250, left));
  }
}

/**
 * Runs the clients in requests of `batchSize`, in order, with a pause between requests.
 * `step(chunk)` gets an array of client IDs and resolves to the result rows, or throws. A 429 or
 * Stop ends the run; clients that were not done, failed, or are in `skipped` stay selected so you
 * can run them again.
 */
async function runBulk(title, ids, step, { onRows, batchSize = 1, skipped = [] } = {}) {
  clearBanner();
  bulkStopRequested = false;
  bulkUi.stop.disabled = false;
  setRoutingLocked(true);
  setBusy(true);

  const rows = [...skipped];
  let done = 0;
  let endedBy = "";

  try {
    for (let start = 0; start < ids.length; start += batchSize) {
      if (bulkStopRequested) {
        endedBy = "stopped";
        break;
      }

      const chunk = ids.slice(start, start + batchSize);
      const label = chunk.length === 1 ? `client ${chunk[0]}…` : `${chunk.length} clients…`;
      showBulkProgress(title, done, ids.length, label);

      try {
        const batch = await step(chunk);
        rows.push(...batch);
        if (onRows) onRows(batch);

        for (const id of chunk) {
          const failed = batch.some(
            (row) => Number(row.client_id) === Number(id) && String(row.status).toLowerCase() === "error",
          );
          if (!failed) toggleSelected(id, false);
        }
      } catch (err) {
        const message = err.message || String(err);
        rows.push(...chunk.map((id) => ({ client_id: id, status: "error", reason: message })));

        if (/^HTTP 429/.test(message)) {
          endedBy = "rate limit";
          break;
        }
      }

      done += chunk.length;
      if (done < ids.length) await bulkPause(title, done, ids.length);
    }
  } finally {
    bulkUi.box.hidden = true;
    setRoutingLocked(false);
    setBusy(false);
    renderRoutingTable(els);
  }

  renderResults(els, { action: title, results: rows });

  const failed = rows.filter((row) => String(row.status).toLowerCase() === "error").length;
  const left = ids.length - done;
  const skippedNote = skipped.length
    ? ` ${skipped.length} skipped, not ready on ElevenLabs (still selected, reasons in the results).`
    : "";

  if (endedBy) {
    showBanner("error", `Stopped (${endedBy}) after ${done} of ${ids.length}. ${left} left, still selected.${failed ? ` ${failed} failed.` : ""}${skippedNote}`);
  } else if (failed) {
    showBanner("error", `Finished ${ids.length}: ${failed} failed (still selected).${skippedNote}`);
  } else if (skipped.length) {
    showBanner("info", `Done: ${ids.length} client(s) switched.${skippedNote}`);
  } else {
    showBanner("ok", `Done: ${ids.length} client(s).`);
  }
}

async function runBulkProvider(ids, provider) {
  const twilio = twilioOverride();
  const title = `Switching to ${provider}`;
  let toSwitch = ids;
  let skipped = [];

  if (provider === "elevenlabs") {
    clearBanner();
    setBusy(true);
    try {
      ({ ready: toSwitch, skipped } = await checkElevenlabsReady(ids, twilio));
    } finally {
      setBusy(false);
      renderRoutingTable(els);
    }

    if (!toSwitch.length) {
      renderResults(els, { action: title, results: skipped });
      showBanner("error", `None of the ${ids.length} selected client(s) is ready on ElevenLabs. Nothing was switched; reasons are in the results.`);

      return;
    }
  }

  await runBulk(
    title,
    toSwitch,
    async (chunk) => {
      const data = await switchPhoneProvider(readAuth(), chunk, provider, els.forwardVoice.checked, twilio);

      return Array.isArray(data?.results) ? data.results : [];
    },
    {
      onRows: (batch) => applyResultsToRoutingCache(els, { results: batch }),
      batchSize: BULK_SWITCH_BATCH_SIZE,
      skipped,
    },
  );
}

async function runBulkArm(ids, target) {
  try {
    if (target === "ab") {
      const { ab } = await refreshServerStatus(els, readAuth());

      if (ab.state === "down") {
        throw new Error(`Router AB server is down (${ab.detail}). Moving clients to Router AB is off until it is back.`);
      }
    }

    const resolved = resolveArm(ids, target);
    if (resolved.error) throw new Error(resolved.error);

    await runBulk(
      `Moving to ${armLabel(target)}`,
      ids,
      async (chunk) => {
        const data = await assignArm(readAuth(), chunk, resolved.arm, false);

        return Array.isArray(data?.results) ? data.results : [];
      },
    );

    const elError = await refreshElAgents(els, els.elApiKey.value.trim());
    if (elError) showBanner("info", `Moved, but the ElevenLabs data was not refreshed: ${elError}`);
  } catch (err) {
    showBanner("error", err.message || String(err));
  }
}

async function runRowSwitch(clientId, provider) {
  clearBanner();
  const twilio = twilioOverride();

  if (provider === "elevenlabs") {
    const { skipped } = await checkElevenlabsReady([Number(clientId)], twilio);
    if (skipped.length) throw new Error(`Client ${clientId} was not switched: ${skipped[0].reason}.`);
  }

  return switchPhoneProvider(readAuth(), [Number(clientId)], provider, els.forwardVoice.checked, twilio);
}

/**
 * Moves clients to an A/B arm. Kept apart from withUi: assign-arm rows carry no webhook fields,
 * so they must not go into the provider routing cache.
 */
async function runArm(clientIds, target, { dryRun, summary = false }) {
  clearBanner();

  if (target === "ab") {
    const { ab } = await refreshServerStatus(els, readAuth());

    if (ab.state === "down") {
      throw new Error(`Router AB server is down (${ab.detail}). Moving clients to Router AB is off until it is back; moving to Router is still allowed.`);
    }
  }

  const resolved = resolveArm(clientIds, target);
  if (resolved.error) throw new Error(resolved.error);

  const data = await assignArm(readAuth(), clientIds, resolved.arm, dryRun);
  const results = Array.isArray(data?.results) ? data.results : [];

  if (summary) {
    renderResults(els, {
      action: dryRun ? "assign_arm (preview)" : "assign_arm",
      provider: resolved.arm,
      results,
    });
  }

  const errors = results.filter((row) => String(row.status).toLowerCase() === "error");

  if (errors.length) {
    const first = errors[0];
    showBanner("error", `${errors.length} of ${results.length} failed — client ${first.client_id}: ${first.reason || "error"}`);
  } else if (dryRun) {
    const changes = results.filter((row) => row.status === "would_update").length;
    showBanner("info", `Preview for ${armLabel(target)} (${resolved.arm}): ${changes} would change, ${results.length - changes} unchanged.`);
  } else {
    showBanner("ok", `Moved ${results.length} client(s) to ${armLabel(target)} (${resolved.arm}).`);
  }

  if (!dryRun) {
    const elError = await refreshElAgents(els, els.elApiKey.value.trim());
    if (elError) showBanner("info", `Moved, but the ElevenLabs data was not refreshed: ${elError}`);
  }
}

function runArmUi(clientIds, target, options) {
  setBusy(true);
  runArm(clientIds, target, options)
    .catch((err) => showBanner("error", err.message || String(err)))
    .finally(() => setBusy(false));
}

async function withUi(fn) {
  setBusy(true);
  try {
    const data = await fn();
    const results = Array.isArray(data?.results) ? data.results : [];
    renderResults(els, data);
    applyResultsToRoutingCache(els, { ...data, results: results.filter((r) => !r.local_skip) });
    const n = results.length;
    const errors = results.filter((r) => String(r.status).toLowerCase() === "error").length;
    const notReady = results.filter((r) => r.local_skip).length;

    if (errors) {
      showBanner("error", `Completed with ${errors} error(s) out of ${n} result(s).`);
    } else if (notReady) {
      showBanner("info", `Done — ${n - notReady} switched, ${notReady} skipped: not ready on ElevenLabs (reasons in the results).`);
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
    await refreshRouting(els, readAuth(), twilioOverride(), {
      clearBanner,
      showBanner,
      elApiKey: els.elApiKey.value.trim(),
    });
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
    setConfirm({
      title: "Switch live provider?",
      text: `Switch ${ids.length} client(s) to "${provider}". This updates live Twilio VoiceUrl + SmsUrl (+ fallbacks).${elevenlabsReadyNote(provider)}`,
      okLabel: "Switch now",
    });
    pendingSwitch = { type: "batch" };
    els.confirmDialog.showModal();
  } catch (err) {
    showBanner("error", err.message || String(err));
  }
});

els.btnArmPreview.addEventListener("click", () => {
  try {
    const ids = parseClientIds();
    if (!ids.length) throw new Error("Enter at least one client ID");
    runArmUi(ids, selectedArmTarget(), { dryRun: true, summary: true });
  } catch (err) {
    showBanner("error", err.message || String(err));
  }
});

els.btnArmApply.addEventListener("click", () => {
  try {
    const ids = parseClientIds();
    if (!ids.length) throw new Error("Enter at least one client ID");
    const target = selectedArmTarget();
    if (target === "ab" && getAbHealth().state === "down") {
      throw new Error("Router AB server is down. Moving clients to Router AB is off; choose Router instead.");
    }

    const resolved = resolveArm(ids, target);
    if (resolved.error) throw new Error(resolved.error);

    setConfirm({
      title: "Move to arm?",
      text: `Move ${ids.length} client(s) to ${armLabel(target)} (${resolved.arm}). This changes the agent and environment on their live ElevenLabs numbers.`,
      okLabel: "Move now",
    });
    pendingSwitch = { type: "arm", clientIds: ids, target, summary: true };
    els.confirmDialog.showModal();
  } catch (err) {
    showBanner("error", err.message || String(err));
  }
});

els.routingBody.addEventListener("click", (event) => {
  const armBtn = event.target.closest("[data-arm-client]");
  if (armBtn) {
    if (armBtn.disabled || armBtn.classList.contains("is-current")) return;

    const clientId = Number(armBtn.getAttribute("data-arm-client"));
    const target = armBtn.getAttribute("data-arm-target");
    const resolved = resolveArm([clientId], target);

    if (resolved.error) {
      showBanner("error", resolved.error);

      return;
    }

    setConfirm({
      title: "Move to arm?",
      text: `Move client ${clientId} to ${armLabel(target)} (${resolved.arm}). This changes the agent and environment on its live ElevenLabs number.`,
      okLabel: "Move now",
    });
    pendingSwitch = { type: "arm", clientIds: [clientId], target, summary: false };
    els.confirmDialog.showModal();

    return;
  }

  const importBtn = event.target.closest("[data-import-client]");
  if (importBtn) {
    if (importBtn.disabled) return;

    const clientId = Number(importBtn.getAttribute("data-import-client"));

    (async () => {
      setBusy(true);
      try {
        twilioOverride();
        const data = await importElevenlabs(
          readAuth(),
          [clientId],
          els.forwardVoice.checked,
          twilioOverride(),
        );
        applyResultsToRoutingCache(els, data);
        const row = (data?.results || []).find((item) => Number(item.client_id) === clientId);
        const failed = row && String(row.status).toLowerCase() === "error";

        if (failed) {
          showBanner("error", row.reason || `Import failed for client ${clientId}`);
        } else {
          await refreshOneClient(els, readAuth(), twilioOverride(), clientId, {
            clearBanner,
            showBanner,
          });
        }
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

  setConfirm({
    title: "Switch live provider?",
    text: `Switch client ${clientId} from "${currentLabel}" to "${provider}". This updates live Twilio VoiceUrl + SmsUrl (+ fallbacks).${elevenlabsReadyNote(provider, { single: true })}`,
    okLabel: "Switch now",
  });
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

  if (pending.type === "arm") {
    runArmUi(pending.clientIds, pending.target, { dryRun: false, summary: pending.summary });

    return;
  }

  if (pending.type === "row") {
    withUi(() => runRowSwitch(pending.clientId, pending.provider));

    return;
  }

  if (pending.type === "bulk") {
    runBulkProvider(pending.clientIds, pending.provider).catch((err) => showBanner("error", err.message || String(err)));

    return;
  }

  if (pending.type === "bulkArm") {
    runBulkArm(pending.clientIds, pending.target);

    return;
  }

  withUi(runSwitch);
});

function activateTab(tabId) {
  const tabs = [
    { tab: document.getElementById("tabProvider"), panel: document.getElementById("panelProvider") },
    { tab: document.getElementById("tabBatch"), panel: document.getElementById("panelBatch") },
    { tab: document.getElementById("tabElevenlabs"), panel: document.getElementById("panelElevenlabs") },
  ];

  for (const item of tabs) {
    const selected = item.tab.id === tabId;
    item.tab.setAttribute("aria-selected", selected ? "true" : "false");
    item.panel.hidden = !selected;
  }
}

document.getElementById("tabProvider").addEventListener("click", () => activateTab("tabProvider"));
document.getElementById("tabBatch").addEventListener("click", () => activateTab("tabBatch"));
document.getElementById("tabElevenlabs").addEventListener("click", () => activateTab("tabElevenlabs"));

els.routingTable.querySelector("thead").addEventListener("click", (event) => {
  const th = event.target.closest("th[data-sort]");
  if (!th) return;

  setRoutingSort(th.getAttribute("data-sort"));
  renderRoutingTable(els);
});

// Row checkboxes. Shift-click ticks (or unticks) everything between this row and the last one clicked.
let lastCheckedId = null;

els.routingBody.addEventListener("click", (event) => {
  const box = event.target.closest("[data-select-client]");
  if (!box) return;

  const id = box.getAttribute("data-select-client");

  let capped = false;

  if (event.shiftKey && lastCheckedId !== null) {
    capped = setSelectedRange(lastCheckedId, id, box.checked);
  } else {
    capped = !toggleSelected(id, box.checked);
  }

  if (capped) showBanner("info", `You can select at most ${BULK_MAX_CLIENTS} clients at a time.`);

  lastCheckedId = id;
  renderRoutingTable(els);
});

els.routingSelectAll.addEventListener("change", () => {
  if (toggleAllVisibleSelected()) {
    showBanner("info", `Selected the first ${BULK_MAX_CLIENTS}. You can select at most ${BULK_MAX_CLIENTS} clients at a time.`);
  }

  renderRoutingTable(els);
});

bulkUi.stop.addEventListener("click", () => {
  bulkStopRequested = true;
  bulkUi.stop.disabled = true;
});

document.getElementById("bulkClear").addEventListener("click", () => {
  clearSelection();
  renderRoutingTable(els);
});

els.bulkBar.addEventListener("click", (event) => {
  const providerBtn = event.target.closest("[data-bulk-provider]");
  const armBtn = event.target.closest("[data-bulk-arm]");
  if (!providerBtn && !armBtn) return;

  const ids = getSelectedClientIds();

  try {
    if (!ids.length) throw new Error("Select at least one client");
    if (ids.length > BULK_MAX_CLIENTS) throw new Error(`Select at most ${BULK_MAX_CLIENTS} clients (${ids.length} selected)`);

    if (providerBtn) {
      twilioOverride();
      const provider = providerBtn.getAttribute("data-bulk-provider");

      setConfirm({
        title: "Switch live provider?",
        text: `Switch ${ids.length} selected client(s) to "${provider}", ${BULK_SWITCH_BATCH_SIZE} per request with a short pause between. This updates live Twilio VoiceUrl + SmsUrl (+ fallbacks).${elevenlabsReadyNote(provider)}`,
        okLabel: "Switch now",
      });
      pendingSwitch = { type: "bulk", clientIds: ids, provider };
    } else {
      const target = armBtn.getAttribute("data-bulk-arm");
      const resolved = resolveArm(ids, target);
      if (resolved.error) throw new Error(resolved.error);

      setConfirm({
        title: "Move to arm?",
        text: `Move ${ids.length} selected client(s) to ${armLabel(target)} (${resolved.arm}), one at a time with a short pause between. This changes the agent and environment on their live ElevenLabs numbers.`,
        okLabel: "Move now",
      });
      pendingSwitch = { type: "bulkArm", clientIds: ids, target };
    }

    els.confirmDialog.showModal();
  } catch (err) {
    showBanner("error", err.message || String(err));
  }
});

els.routingSearch.addEventListener("input", () => renderRoutingTable(els));
els.routingSearch.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !els.routingSearch.value) return;

  els.routingSearch.value = "";
  renderRoutingTable(els);
});

initElevenlabs({ showBanner });
renderRoutingTable(els);
refreshServerStatus(els, readAuth());
