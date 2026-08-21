import { CACHE_KEY, CLIENT_IDS, STATUS_GAP_MS } from "./config.js";
import { fetchPhoneNumberStatus, httpErrorMessage } from "./api.js";
import { escapeHtml } from "./results.js";

let routingRefreshActive = false;
let sortKey = "client";
let sortDir = "asc";

export function uniqueClientIds() {
  const ids = CLIENT_IDS.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);

  return [...new Set(ids)];
}

export function setRoutingSort(key) {
  if (sortKey === key) {
    sortDir = sortDir === "asc" ? "desc" : "asc";
  } else {
    sortKey = key;
    sortDir = "asc";
  }
}

function providerSortValue(value) {
  if (value === "elevenlabs") return 0;
  if (value === "vapi") return 1;

  return null;
}

function compareProviders(leftValue, rightValue, leftId, rightId) {
  const leftRank = providerSortValue(leftValue);
  const rightRank = providerSortValue(rightValue);

  if (leftRank == null && rightRank == null) return leftId - rightId;
  if (leftRank == null) return 1;
  if (rightRank == null) return -1;

  let cmp = leftRank - rightRank;
  if (cmp === 0) cmp = leftId - rightId;

  return sortDir === "asc" ? cmp : -cmp;
}

function sortedClientIds(ids, cache) {
  const copy = [...ids];

  copy.sort((leftId, rightId) => {
    const left = routingEntryFor(leftId, cache);
    const right = routingEntryFor(rightId, cache);

    if (sortKey === "primary") {
      return compareProviders(left.primary, right.primary, leftId, rightId);
    }

    if (sortKey === "fallback") {
      return compareProviders(left.fallback, right.fallback, leftId, rightId);
    }

    return sortDir === "asc" ? leftId - rightId : rightId - leftId;
  });

  return copy;
}

function updateSortHeaders(els) {
  for (const th of els.routingTable.querySelectorAll("th[data-sort]")) {
    const key = th.getAttribute("data-sort");
    if (key === sortKey) {
      th.setAttribute("aria-sort", sortDir === "asc" ? "ascending" : "descending");
    } else {
      th.setAttribute("aria-sort", "none");
    }
  }
}

export function loadRoutingCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);

    if (!raw) return {};

    const parsed = JSON.parse(raw);

    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveRoutingCache(cache) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

function pickFirstString(row, keys) {
  for (const key of keys) {
    const value = row?.[key];

    if (typeof value === "string" && value.trim()) return value.trim();
  }

  return "";
}

function detectProvider(url) {
  if (!url) return "unknown";

  const value = url.toLowerCase();
  const eleven =
    value.includes("elevenlabs")
    || value.includes("11labs");
  const vapi =
    value.includes("vapi.ai")
    || value.includes("rooceptionist")
    || /(?:^|[/.?&=_-])vapi(?:[/.?&=_-]|$)/.test(value)
    || value.includes("vendoroo.ai") && value.includes("/voice-agent/");

  if (eleven && !vapi) return "elevenlabs";
  if (vapi && !eleven) return "vapi";

  return "unknown";
}

export function firstResult(payload) {
  if (Array.isArray(payload?.results) && payload.results.length) return payload.results[0];
  if (payload && typeof payload === "object" && payload.client_id != null) return payload;

  return null;
}

export function summarizeStatusRow(row) {
  const primaryUrl = pickFirstString(row, [
    "voice_url",
    "VoiceUrl",
    "primary_voice_url",
    "voice_primary_url",
  ]);
  const fallbackUrl = pickFirstString(row, [
    "voice_fallback_url",
    "VoiceFallbackUrl",
    "fallback_voice_url",
    "voice_url_fallback",
  ]);

  return {
    client_id: row?.client_id ?? null,
    phone_number: row?.phone_number ?? null,
    api_status: row?.status ?? null,
    reason: row?.reason ?? null,
    elevenlabs_imported: row?.elevenlabs_imported ?? null,
    primary: detectProvider(primaryUrl),
    fallback: detectProvider(fallbackUrl),
    primary_url: primaryUrl || null,
    fallback_url: fallbackUrl || null,
  };
}

export function providerLabel(provider) {
  if (provider === "elevenlabs") return "elevenlabs";
  if (provider === "vapi") return "vapi";

  return "unknown";
}

function providerBadge(provider, url) {
  const key = provider === "elevenlabs" || provider === "vapi" ? provider : "unknown";
  const title = url ? ` title="${escapeHtml(url)}"` : "";

  return `<span class="badge badge-${key}"${title}>${escapeHtml(providerLabel(provider))}</span>`;
}

function formatFetched(iso) {
  if (!iso) return "not fetched";

  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "not fetched";

  const delta = Date.now() - then;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;

  return new Date(then).toLocaleString();
}

function emptyRoutingEntry(clientId) {
  return {
    client_id: clientId,
    phone_number: null,
    primary: "unknown",
    fallback: "unknown",
    primary_url: null,
    fallback_url: null,
    fetched_at: null,
    rate_limited: false,
    error: null,
    reason: null,
    elevenlabs_imported: null,
  };
}

export function routingEntryFor(clientId, cache) {
  const cached = cache[String(clientId)];
  if (!cached) return emptyRoutingEntry(clientId);

  return { ...emptyRoutingEntry(clientId), ...cached, client_id: clientId };
}

function updateRoutingMeta(els, cache, extra = "") {
  const ids = uniqueClientIds();
  let eleven = 0;
  let vapi = 0;
  let unknown = 0;
  let fetched = 0;
  let limited = 0;

  for (const id of ids) {
    const row = routingEntryFor(id, cache);

    if (row.fetched_at) fetched += 1;
    if (row.rate_limited) limited += 1;

    if (row.primary === "elevenlabs") eleven += 1;
    else if (row.primary === "vapi") vapi += 1;
    else unknown += 1;
  }

  const chips = [
    `<span class="stat">${ids.length} clients</span>`,
    `<span class="stat ok">${eleven} elevenlabs</span>`,
    `<span class="stat info">${vapi} vapi</span>`,
    `<span class="stat skip">${unknown} unknown</span>`,
    `<span class="stat">${fetched} cached</span>`,
  ];

  if (limited) chips.push(`<span class="stat err">${limited} rate-limited</span>`);
  if (extra) chips.push(`<span class="stat">${escapeHtml(extra)}</span>`);
  els.routingMeta.innerHTML = chips.join("");
}

export function setRoutingControlsDisabled(els, on) {
  els.btnRefreshRouting.disabled = on || routingRefreshActive;

  for (const btn of els.routingBody.querySelectorAll("button")) {
    btn.disabled = on || routingRefreshActive;
  }
}

export function renderRoutingTable(els) {
  const ids = uniqueClientIds();
  const cache = loadRoutingCache();
  updateRoutingMeta(els, cache);

  if (!ids.length) {
    els.routingEmpty.hidden = false;
    els.routingEmpty.innerHTML = "Add client IDs to <code>js/config.js</code> (<code>CLIENT_IDS</code>), then use Refresh all.";
    els.routingTable.hidden = true;
    els.routingBody.innerHTML = "";

    return;
  }

  els.routingEmpty.hidden = true;
  els.routingTable.hidden = false;
  updateSortHeaders(els);
  els.routingBody.innerHTML = sortedClientIds(ids, cache).map((clientId) => {
    const row = routingEntryFor(clientId, cache);
    const primary = row.primary || "unknown";
    const fallback = row.fallback || "unknown";
    const reason = typeof row.reason === "string" ? row.reason.trim() : "";
    const note = row.rate_limited
      ? "Rate limited — skipped until the next refresh"
      : (row.error || reason || "—");
    const elCurrent = primary === "elevenlabs" ? " is-current" : "";
    const vapiCurrent = primary === "vapi" ? " is-current" : "";
    const phone = row.phone_number || "—";
    const fetched = formatFetched(row.fetched_at);
    const noteEmpty = !row.rate_limited && !row.error && !reason;
    let noteMarkup = `<span class="note-alert">${escapeHtml(note)}</span>`;

    if (noteEmpty && row.elevenlabs_imported === true) {
      noteMarkup = escapeHtml("Imported to elevenlabs");
    } else if (noteEmpty && row.elevenlabs_imported === false) {
      noteMarkup = `<button type="button" class="btn-ghost btn-row-refresh btn-import-el" data-import-client="${escapeHtml(clientId)}">Import to elevenlabs</button>`;
    } else if (noteEmpty) {
      noteMarkup = escapeHtml("—");
    }

    return `
          <tr data-client-id="${escapeHtml(clientId)}">
            <td class="mono">${escapeHtml(clientId)}</td>
            <td class="mono">${escapeHtml(phone)}</td>
            <td class="cell-middle">${providerBadge(primary, row.primary_url)}</td>
            <td class="cell-middle">${providerBadge(fallback, row.fallback_url)}</td>
            <td class="switch-cell">
              <div class="row-switch" role="group" aria-label="Switch provider for ${escapeHtml(clientId)}">
                <button type="button" data-switch-client="${escapeHtml(clientId)}" data-switch-provider="elevenlabs" class="${elCurrent.trim()}">ElevenLabs</button>
                <button type="button" data-switch-client="${escapeHtml(clientId)}" data-switch-provider="vapi" class="${vapiCurrent.trim()}">Vapi</button>
              </div>
            </td>
            <td>
              <div class="row-fetched">
                <span class="mono faint">${escapeHtml(fetched)}</span>
                <button type="button" class="btn-ghost btn-row-refresh" data-refresh-client="${escapeHtml(clientId)}">Refresh</button>
              </div>
            </td>
            <td class="note-cell">${noteMarkup}</td>
          </tr>
        `;
  }).join("");

  setRoutingControlsDisabled(els, false);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function upsertRoutingCache(clientId, patch) {
  const cache = loadRoutingCache();
  const current = routingEntryFor(clientId, cache);
  cache[String(clientId)] = { ...current, ...patch, client_id: clientId };
  saveRoutingCache(cache);

  return cache;
}

export function applyResultsToRoutingCache(els, payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const allowed = new Set(uniqueClientIds().map(String));

  for (const row of results) {
    if (row?.client_id == null) continue;
    if (!allowed.has(String(row.client_id))) continue;

    const summary = summarizeStatusRow(row);
    upsertRoutingCache(row.client_id, {
      ...summary,
      fetched_at: new Date().toISOString(),
      rate_limited: false,
      error: null,
    });
  }

  if (uniqueClientIds().length) renderRoutingTable(els);
}

function applyStatusFetchResult(clientId, result) {
  if (result.status === 429) {
    upsertRoutingCache(clientId, {
      rate_limited: true,
      error: "HTTP 429 rate limited",
    });

    return "limited";
  }

  if (!result.ok) {
    upsertRoutingCache(clientId, {
      rate_limited: false,
      error: httpErrorMessage(result.status, result.data, result.text, ""),
    });

    return "error";
  }

  const row = firstResult(result.data);
  if (!row) {
    upsertRoutingCache(clientId, {
      rate_limited: false,
      error: "Status response had no result row",
    });

    return "error";
  }

  const summary = summarizeStatusRow(row);
  upsertRoutingCache(clientId, {
    ...summary,
    fetched_at: new Date().toISOString(),
    rate_limited: false,
    error: null,
  });

  return "ok";
}

export async function refreshOneClient(els, auth, twilio, clientId, { clearBanner, showBanner }) {
  if (routingRefreshActive) return;

  clearBanner();
  els.routingBusy.classList.add("show");
  els.routingBusyLabel.textContent = `Refreshing ${clientId}…`;

  try {
    const result = await fetchPhoneNumberStatus(auth, [clientId], twilio);
    const outcome = applyStatusFetchResult(clientId, result);

    if (outcome === "limited") {
      showBanner("info", `Client ${clientId} hit the rate limit. Cache was not updated.`);
    } else if (outcome === "error") {
      const cached = routingEntryFor(clientId, loadRoutingCache());
      showBanner("error", cached.error || `Failed to refresh client ${clientId}`);
    } else {
      showBanner("ok", `Updated client ${clientId} in the browser cache.`);
    }
  } finally {
    els.routingBusy.classList.remove("show");
    els.routingBusyLabel.textContent = "Refreshing…";
    renderRoutingTable(els);
  }
}

export async function refreshRouting(els, auth, twilio, { clearBanner, showBanner }) {
  const ids = uniqueClientIds();
  if (!ids.length) throw new Error("CLIENT_IDS is empty — paste client IDs in js/config.js");

  routingRefreshActive = true;
  els.routingBusy.classList.add("show");
  setRoutingControlsDisabled(els, true);
  clearBanner();

  let ok = 0;
  let limited = 0;
  let errors = 0;

  try {
    const skippedThisPass = new Set();

    for (let index = 0; index < ids.length; index += 1) {
      const clientId = ids[index];
      els.routingBusyLabel.textContent = `Refreshing ${index + 1}/${ids.length}…`;
      updateRoutingMeta(els, loadRoutingCache(), `${index}/${ids.length}`);

      if (skippedThisPass.has(String(clientId))) continue;

      const result = await fetchPhoneNumberStatus(auth, [clientId], twilio);
      const outcome = applyStatusFetchResult(clientId, result);

      if (outcome === "limited") {
        limited += 1;
        skippedThisPass.add(String(clientId));
      } else if (outcome === "error") {
        errors += 1;
      } else {
        ok += 1;
      }

      renderRoutingTable(els);

      if (index < ids.length - 1) {
        await sleep(STATUS_GAP_MS);
      }
    }

    const parts = [`Status refresh done — ${ok} cached`];
    if (limited) parts.push(`${limited} rate-limited (skipped)`);
    if (errors) parts.push(`${errors} error(s)`);
    showBanner(errors || limited ? "info" : "ok", parts.join(" · "));
  } finally {
    routingRefreshActive = false;
    els.routingBusy.classList.remove("show");
    els.routingBusyLabel.textContent = "Refreshing…";
    renderRoutingTable(els);
  }
}

export function stopRoutingRefresh(els) {
  routingRefreshActive = false;
  els.routingBusy.classList.remove("show");
  renderRoutingTable(els);
}
