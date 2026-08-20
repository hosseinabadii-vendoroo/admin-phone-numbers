import { CACHE_KEY, CLIENT_IDS, STATUS_GAP_MS } from "./config.js";
import { fetchPhoneNumberStatus, httpErrorMessage } from "./api.js";
import { escapeHtml } from "./results.js";

let routingRefreshActive = false;

export function uniqueClientIds() {
  const ids = CLIENT_IDS.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);

  return [...new Set(ids)];
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
  };
}

export function routingEntryFor(clientId, cache) {
  const cached = cache[String(clientId)];
  if (!cached) return emptyRoutingEntry(clientId);

  return { ...emptyRoutingEntry(clientId), ...cached, client_id: clientId };
}

function updateRoutingMeta(els, cache, extra = "") {
  const ids = uniqueClientIds();
  const fetched = ids.filter((id) => cache[String(id)]?.fetched_at).length;
  const limited = ids.filter((id) => cache[String(id)]?.rate_limited).length;
  const parts = [`${ids.length} clients`, `${fetched} cached`];

  if (limited) parts.push(`${limited} rate-limited`);
  if (extra) parts.push(extra);
  els.routingMeta.textContent = parts.join(" · ");
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
    els.routingEmpty.innerHTML = "Add client IDs to <code>js/config.js</code> (<code>CLIENT_IDS</code>), then use Refresh.";
    els.routingTable.hidden = true;
    els.routingBody.innerHTML = "";

    return;
  }

  els.routingEmpty.hidden = true;
  els.routingTable.hidden = false;
  els.routingBody.innerHTML = ids.map((clientId) => {
    const row = routingEntryFor(clientId, cache);
    const primary = row.primary || "unknown";
    const fallback = row.fallback || "unknown";
    const reason = typeof row.reason === "string" ? row.reason.trim() : "";
    const note = row.rate_limited
      ? "Rate limited — skipped until next Refresh"
      : (row.error || reason || "—");
    const elCurrent = primary === "elevenlabs" ? " is-current" : "";
    const vapiCurrent = primary === "vapi" ? " is-current" : "";
    const phone = row.phone_number || "—";
    const fetched = formatFetched(row.fetched_at);

    return `
          <tr data-client-id="${escapeHtml(clientId)}">
            <td class="mono">${escapeHtml(clientId)}</td>
            <td class="mono">${escapeHtml(phone)}</td>
            <td>${providerBadge(primary, row.primary_url)}</td>
            <td>${providerBadge(fallback, row.fallback_url)}</td>
            <td>
              <div class="row-switch" role="group" aria-label="Switch provider for ${escapeHtml(clientId)}">
                <button type="button" data-switch-client="${escapeHtml(clientId)}" data-switch-provider="elevenlabs" class="${elCurrent.trim()}">ElevenLabs</button>
                <button type="button" data-switch-client="${escapeHtml(clientId)}" data-switch-provider="vapi" class="${vapiCurrent.trim()}">Vapi</button>
              </div>
            </td>
            <td class="mono faint">${escapeHtml(fetched)}</td>
            <td class="note-cell">${escapeHtml(note)}</td>
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

      if (result.status === 429) {
        limited += 1;
        skippedThisPass.add(String(clientId));
        upsertRoutingCache(clientId, {
          rate_limited: true,
          error: "HTTP 429 rate limited",
        });
        renderRoutingTable(els);
        continue;
      }

      if (!result.ok) {
        errors += 1;
        upsertRoutingCache(clientId, {
          rate_limited: false,
          error: httpErrorMessage(result.status, result.data, result.text, ""),
        });
        renderRoutingTable(els);
        continue;
      }

      const row = firstResult(result.data);
      if (!row) {
        errors += 1;
        upsertRoutingCache(clientId, {
          rate_limited: false,
          error: "Status response had no result row",
        });
        renderRoutingTable(els);
        continue;
      }

      const summary = summarizeStatusRow(row);
      ok += 1;
      upsertRoutingCache(clientId, {
        ...summary,
        fetched_at: new Date().toISOString(),
        rate_limited: false,
        error: null,
      });
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
