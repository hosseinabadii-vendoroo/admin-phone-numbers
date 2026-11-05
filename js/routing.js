import { CACHE_KEY, CLIENT_LIST_KEY, EL_AGENTS_KEY } from "./config.js";
import { fetchPhoneNumberStatus, getRooceptionistClientIds, httpErrorMessage } from "./api.js";
import { listPhoneNumbers } from "./elevenlabs-api.js";
import { getAbHealth, getRouterHealth, refreshAbHealth, refreshRouterHealth } from "./server-health.js";
import { escapeHtml } from "./results.js";

let routingRefreshActive = false;
let sortKey = "client";
let sortDir = "asc";

function loadClientList() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLIENT_LIST_KEY) || "null");

    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveClientList(list) {
  localStorage.setItem(CLIENT_LIST_KEY, JSON.stringify(list));
}

function hasSyncedIds(list) {
  return Array.isArray(list?.ids) && list.ids.length > 0;
}

export function uniqueClientIds() {
  const list = loadClientList();
  if (!hasSyncedIds(list)) return [];

  const ids = list.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);

  return [...new Set(ids)];
}

async function syncClientList(auth) {
  try {
    const ids = await getRooceptionistClientIds(auth);
    saveClientList({ ids, synced_at: new Date().toISOString() });

    return { synced: true, count: ids.length };
  } catch (err) {
    const error = err?.message || String(err);
    const previous = loadClientList();
    const kept = hasSyncedIds(previous) ? { ids: previous.ids, synced_at: previous.synced_at } : {};
    saveClientList({ ...kept, error, failed_at: new Date().toISOString() });

    return { synced: false, error, hasPrevious: hasSyncedIds(kept) };
  }
}

function loadElAgents() {
  try {
    const parsed = JSON.parse(localStorage.getItem(EL_AGENTS_KEY) || "null");

    return parsed && typeof parsed === "object" && parsed.numbers ? parsed : null;
  } catch {
    return null;
  }
}

function clearElAgents() {
  try {
    localStorage.removeItem(EL_AGENTS_KEY);
  } catch {
    // Storage can be blocked; nothing was kept then.
  }
}

/**
 * Fetches the ElevenLabs phone numbers and keeps which agent each one is attached to,
 * keyed by the number's canonical digits. Without a key, or when the fetch fails, the saved
 * data is dropped so an old agent or arm is never shown as if it were current.
 * Returns { error, count }; error is "" on success.
 */
async function syncElAgents(apiKey) {
  if (!apiKey) {
    clearElAgents();

    return { error: "no ElevenLabs API key", count: 0 };
  }

  try {
    const phones = await listPhoneNumbers(apiKey);
    const numbers = {};

    for (const phone of Array.isArray(phones) ? phones : []) {
      const key = nanpPhoneKey(phone.phone_number);
      if (!key) continue;

      const agent = phone.assigned_agent || {};
      numbers[key] = {
        agent_id: agent.agent_id || null,
        agent_name: agent.agent_name || null,
        environment: agent.environment || null,
        label: phone.label || null,
      };
    }

    localStorage.setItem(EL_AGENTS_KEY, JSON.stringify({ numbers, synced_at: new Date().toISOString() }));

    return { error: "", count: Object.keys(numbers).length };
  } catch (err) {
    clearElAgents();

    return { error: err?.message || String(err), count: 0 };
  }
}

const ARM_SUFFIX = "-ab";

function elEntryFor(phone, elAgents) {
  return phone ? elAgents?.numbers[nanpPhoneKey(phone)] || null : null;
}

/** "router" for the control arm, "router_ab" for the treatment arm, null when it can't be told. */
function armOf(entry) {
  if (!entry?.agent_id || !entry.environment) return null;

  return entry.environment.endsWith(ARM_SUFFIX) ? "router_ab" : "router";
}

/**
 * The server names arms after its ENVIRONMENT ("production" / "production-ab"), so the arm for a
 * target comes from the environment the clients' ElevenLabs numbers are already pinned to.
 */
export function resolveArm(clientIds, target) {
  const cache = loadRoutingCache();
  const elAgents = loadElAgents();
  const bases = new Set();

  for (const id of clientIds) {
    const entry = elEntryFor(routingEntryFor(id, cache).phone_number, elAgents);
    if (entry?.environment) bases.add(entry.environment.replace(/-ab$/, ""));
  }

  if (!bases.size) {
    return { error: "No ElevenLabs environment known for these clients. Add the ElevenLabs API key and click Refresh all first." };
  }

  if (bases.size > 1) {
    return { error: `These clients are in different environments (${[...bases].join(", ")}). Move them separately.` };
  }

  const [base] = bases;

  return { arm: target === "ab" ? `${base}${ARM_SUFFIX}` : base };
}

export function armLabel(target) {
  return target === "ab" ? "Router AB" : "Router";
}

function abIsDown() {
  return getAbHealth().state === "down";
}

function clientsOnAb() {
  const cache = loadRoutingCache();
  const elAgents = loadElAgents();

  return uniqueClientIds().filter(
    (id) => armOf(elEntryFor(routingEntryFor(id, cache).phone_number, elAgents)) === "router_ab",
  );
}

/**
 * A down Router AB server only matters when clients are on it, so the warning bar shows only then
 * (or when we cannot tell). Otherwise the status is just the small chip in the header.
 */
function abWarning() {
  if (!abIsDown()) return null;

  if (!loadElAgents()) {
    return {
      kind: "warn",
      html: "<strong>Router AB server is down</strong> and the page cannot tell which clients are on it. Add the ElevenLabs API key and click Refresh all.",
    };
  }

  const onAb = clientsOnAb();
  if (!onAb.length) return null;

  return {
    kind: "err",
    html: `<strong>Router AB server is down</strong> and ${onAb.length === 1 ? "this client is" : "these clients are"} on Router AB: ${escapeHtml(onAb.join(", "))}. Switch ${onAb.length === 1 ? "it" : "them"} back to Router, or ask someone with access to bring the server up.`,
  };
}

const PILL_LABELS = { up: "up", down: "off", checking: "checking…", idle: "not checked" };

function renderServerPill(pill, label, name, health) {
  if (!pill) return;

  pill.classList.toggle("live", health.state === "up");
  pill.title = health.detail || "";
  label.textContent = `${name}: ${PILL_LABELS[health.state] || PILL_LABELS.idle}`;
}

function renderServerPills(els) {
  renderServerPill(els.connPill, els.connLabel, "Router", getRouterHealth());
  renderServerPill(els.abPill, els.abLabel, "Router AB", getAbHealth());
}

function renderAbStatus(els) {
  renderServerPills(els);

  const node = els.abStatus;
  if (!node) return;

  const warning = abWarning();

  if (!warning) {
    node.hidden = true;

    return;
  }

  node.className = `routing-source ${warning.kind}`;
  node.innerHTML = `${warning.html} Moving clients to Router AB is turned off until it is back.`;
  node.hidden = false;
}

/** Asks the Router and Router AB servers for their health, redrawing the pills around the calls. */
export async function refreshServerStatus(els, auth) {
  renderAbStatus(els);
  const pending = Promise.all([refreshRouterHealth(auth), refreshAbHealth(auth)]);
  renderAbStatus(els);
  const [router, ab] = await pending;
  renderRoutingTable(els);

  return { router, ab };
}

export function showStaleServerStatus(els) {
  renderAbStatus(els);
}

export async function refreshElAgents(els, apiKey) {
  const { error } = await syncElAgents(apiKey);
  renderRoutingTable(els);

  return error;
}

function armHint(phone, entry, elAgents) {
  if (abIsDown()) {
    return armOf(entry) === "router_ab"
      ? "Router AB server is off and this client is on it: switch it back to Router"
      : "Router AB server is off: only Router can be chosen";
  }
  if (!phone) return "No phone number";
  if (!elAgents) return "Add an ElevenLabs API key and click Refresh all to load this number";
  if (!entry) return "This number is not in the ElevenLabs workspace";
  if (!entry.agent_id) return "No agent assigned in ElevenLabs";

  return `Agent: ${entry.agent_name || entry.agent_id}`;
}

function elArmCell(clientId, phone, elAgents) {
  const entry = elEntryFor(phone, elAgents);
  const current = armOf(entry);
  const noData = !entry?.environment;
  const title = ` title="${escapeHtml(armHint(phone, entry, elAgents))}"`;
  const button = (target, arm) => {
    const stuck = current === "router_ab" && arm === "router_ab" && abIsDown();
    const cls = stuck ? ' class="is-current is-alert"' : current === arm ? ' class="is-current"' : "";
    const off = noData || (target === "ab" && abIsDown());
    const attrs = off ? " disabled data-arm-unavailable" : "";

    return `<button type="button" data-arm-client="${escapeHtml(clientId)}" data-arm-target="${target}"${cls}${attrs}>${armLabel(target)}</button>`;
  };

  return `<div class="row-switch" role="group" aria-label="Move client ${escapeHtml(clientId)} to an arm"${title}>${button("control", "router")}${button("ab", "router_ab")}</div>`;
}

function renderClientSource(els) {
  const list = loadClientList();
  const notice = els.routingSource;
  const synced = hasSyncedIds(list);

  if (synced && !list.error) {
    notice.className = "routing-source ok";
    notice.textContent =
      `Clients are synced with Marketplace: ${list.ids.length} active, Rooceptionist-enabled clients, loaded ${formatFetched(list.synced_at)}.`;
  } else if (synced) {
    notice.className = "routing-source warn";
    notice.textContent =
      `Loading clients from Marketplace failed (${list.error}). You are seeing the last synced list (${list.ids.length} clients, loaded ${formatFetched(list.synced_at)}).`;
  } else if (list?.error) {
    notice.className = "routing-source warn";
    notice.textContent = `Loading clients from Marketplace failed (${list.error}). There is no client list to show yet.`;
  } else {
    notice.className = "routing-source";
    notice.textContent = "Click Refresh all to load clients from Marketplace.";
  }

  notice.hidden = false;
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
  if (value === "vapi_native") return 1;
  if (value === "vapi") return 2;

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

function armRank(phone, elAgents) {
  const arm = armOf(elEntryFor(phone, elAgents));

  if (arm === "router") return 0;
  if (arm === "router_ab") return 1;

  return null;
}

function compareArms(leftRank, rightRank, leftId, rightId) {
  if (leftRank == null && rightRank == null) return leftId - rightId;
  if (leftRank == null) return 1;
  if (rightRank == null) return -1;

  let cmp = leftRank - rightRank;
  if (cmp === 0) cmp = leftId - rightId;

  return sortDir === "asc" ? cmp : -cmp;
}

function sortedClientIds(ids, cache, elAgents) {
  const copy = [...ids];

  copy.sort((leftId, rightId) => {
    const left = routingEntryFor(leftId, cache);
    const right = routingEntryFor(rightId, cache);

    if (sortKey === "arm") {
      return compareArms(armRank(left.phone_number, elAgents), armRank(right.phone_number, elAgents), leftId, rightId);
    }

    if (sortKey === "primary") {
      return compareProviders(left.primary, right.primary, leftId, rightId);
    }

    if (sortKey === "primary_sms") {
      return compareProviders(smsProviderFromRow(left, "primary_sms"), smsProviderFromRow(right, "primary_sms"), leftId, rightId);
    }

    if (sortKey === "fallback_sms") {
      return compareProviders(smsProviderFromRow(left, "fallback_sms"), smsProviderFromRow(right, "fallback_sms"), leftId, rightId);
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

function detectSmsProvider(url) {
  if (!url) return "unknown";

  const value = url.toLowerCase();

  if (value.includes("elevenlabs")) return "elevenlabs";
  if (value.includes("vapi")) return "vapi_native";
  if (value.includes("marketplace")) return "vapi";

  return "unknown";
}

function smsProviderFromRow(row, key) {
  const urlKey = key === "fallback_sms" ? "fallback_sms_url" : "primary_sms_url";
  const url = row?.[urlKey];

  if (url) return detectSmsProvider(url);

  return row?.[key] || "unknown";
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
  const primarySmsUrl = pickFirstString(row, [
    "sms_url",
    "SmsUrl",
    "primary_sms_url",
    "sms_primary_url",
  ]);
  const fallbackSmsUrl = pickFirstString(row, [
    "sms_fallback_url",
    "SmsFallbackUrl",
    "fallback_sms_url",
    "sms_url_fallback",
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
    primary_sms: detectSmsProvider(primarySmsUrl),
    fallback_sms: detectSmsProvider(fallbackSmsUrl),
    primary_sms_url: primarySmsUrl || null,
    fallback_sms_url: fallbackSmsUrl || null,
  };
}

export function providerLabel(provider) {
  if (provider === "elevenlabs") return "elevenlabs";
  if (provider === "vapi_native") return "vapi native";
  if (provider === "vapi") return "vapi";

  return "unknown";
}

function formatStatusReason(reason) {
  if (typeof reason !== "string") return "";

  const value = reason.trim();
  if (value === "twilio_list_failed") return "Twilio inventory list failed";
  if (value === "twilio_number_not_found") return "Twilio number not found";
  if (value === "client_not_found") return "Client not found";
  if (value === "no_assigned_phone_number") return "No assigned phone number";
  if (value === "invalid_assigned_phone_number") return "Invalid assigned phone number";

  return value;
}

function providerBadge(provider, url) {
  const key = provider === "elevenlabs" || provider === "vapi" || provider === "vapi_native"
    ? (provider === "vapi_native" ? "vapi" : provider)
    : "unknown";
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
    primary_sms: "unknown",
    fallback_sms: "unknown",
    primary_sms_url: null,
    fallback_sms_url: null,
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
    btn.disabled = on || routingRefreshActive || btn.hasAttribute("data-arm-unavailable");
  }
}

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

const PHONE_EXTENSION = /\s*(?:;?\s*ext(?:ension)?\.?\s*=?|x|#)\s*\d+\s*$/i;

const KEYPAD_LETTERS = {
  a: "2", b: "2", c: "2",
  d: "3", e: "3", f: "3",
  g: "4", h: "4", i: "4",
  j: "5", k: "5", l: "5",
  m: "6", n: "6", o: "6",
  p: "7", q: "7", r: "7", s: "7",
  t: "8", u: "8", v: "8",
  w: "9", x: "9", y: "9", z: "9",
};

/**
 * Reduces typed phone input to the digits a caller would dial: drops "ext 12" / "x12" / "#12",
 * and turns vanity letters into keypad digits ("1-800-FLOWERS") when the input also has digits.
 */
function phoneQueryDigits(query) {
  const withoutExtension = query.replace(PHONE_EXTENSION, "");
  const hasDigits = /\d/.test(withoutExtension);
  const dialed = hasDigits
    ? withoutExtension.toLowerCase().replace(/[a-z]/g, (letter) => KEYPAD_LETTERS[letter])
    : withoutExtension;

  return digitsOnly(dialed);
}

/**
 * Canonical "1NXXNXXXXXX" form for US/Canada numbers, so input with or without the +1
 * country code is a substring of it. Non-NANP numbers fall back to their raw digits.
 */
function nanpPhoneKey(phone) {
  const digits = digitsOnly(phone);
  if (digits.length === 10) return `1${digits}`;

  return digits;
}

const MIN_PHONE_DIGITS = 7;

function isClientIdQuery(query) {
  return /^\d+$/.test(query) && query.length < MIN_PHONE_DIGITS;
}

function matchesPhone(phone, query) {
  if (!phone) return false;

  const value = String(phone).toLowerCase();
  if (value.includes(query.toLowerCase())) return true;

  const digits = phoneQueryDigits(query);

  return Boolean(digits) && nanpPhoneKey(value).includes(digits);
}

/**
 * A plain number shorter than a phone number is read as a client ID and must match exactly.
 * Formatted or longer input, or a short number no client has as its ID, searches phone numbers.
 */
function filterClientIds(ids, cache, query) {
  if (!query) return ids;

  if (isClientIdQuery(query)) {
    const exact = ids.filter((id) => id === Number(query));
    if (exact.length) return exact;
  }

  return ids.filter((id) => matchesPhone(routingEntryFor(id, cache).phone_number, query));
}

export function renderRoutingTable(els) {
  const ids = uniqueClientIds();
  const cache = loadRoutingCache();
  const elAgents = loadElAgents();
  updateRoutingMeta(els, cache);
  renderClientSource(els);
  renderAbStatus(els);

  if (!ids.length) {
    els.routingEmpty.hidden = false;
    els.routingEmpty.textContent = "No clients to show. Click Refresh all to load clients from Marketplace.";
    els.routingTable.hidden = true;
    els.routingBody.innerHTML = "";
    els.routingSearchCount.textContent = "";

    return;
  }

  const query = els.routingSearch.value.trim();
  const visibleIds = filterClientIds(sortedClientIds(ids, cache, elAgents), cache, query);
  els.routingSearchCount.textContent = query ? `${visibleIds.length} of ${ids.length} clients` : "";

  if (!visibleIds.length) {
    els.routingEmpty.hidden = false;
    els.routingEmpty.textContent = `No clients match "${query}".`;
    els.routingTable.hidden = true;
    els.routingBody.innerHTML = "";

    return;
  }

  els.routingEmpty.hidden = true;
  els.routingTable.hidden = false;
  updateSortHeaders(els);
  els.routingBody.innerHTML = visibleIds.map((clientId) => {
    const row = routingEntryFor(clientId, cache);
    const primary = row.primary || "unknown";
    const fallback = row.fallback || "unknown";
    const primarySms = smsProviderFromRow(row, "primary_sms");
    const switchTitle = `Primary voice: ${providerLabel(primary)} · Fallback voice: ${providerLabel(fallback)}`;
    const fallbackSms = smsProviderFromRow(row, "fallback_sms");
    const reason = formatStatusReason(row.reason);
    const note = row.rate_limited
      ? "Rate limited — skipped until the next refresh"
      : (row.error || reason || "—");
    const elCurrent = primary === "elevenlabs" ? " is-current" : "";
    const vapiCurrent = primary === "vapi" ? " is-current" : "";
    const phone = row.phone_number || "—";
    // Labels look like "production | Name": show only the name after the first pipe.
    const elLabel = elEntryFor(row.phone_number, elAgents)?.label || "";
    const elName = elLabel.includes("|") ? elLabel.slice(elLabel.indexOf("|") + 1).trim() : elLabel.trim();
    const nameTitle = elName ? ` title="${escapeHtml(elName)}"` : "";
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
            <td class="mono"${nameTitle}>${escapeHtml(clientId)}</td>
            <td class="mono"${nameTitle}>${escapeHtml(phone)}</td>
            <td class="switch-cell">
              <div class="row-switch" role="group" aria-label="Switch provider for ${escapeHtml(clientId)}" title="${escapeHtml(switchTitle)}">
                <button type="button" data-switch-client="${escapeHtml(clientId)}" data-switch-provider="elevenlabs" class="${elCurrent.trim()}">ElevenLabs</button>
                <button type="button" data-switch-client="${escapeHtml(clientId)}" data-switch-provider="vapi" class="${vapiCurrent.trim()}">Vapi</button>
              </div>
            </td>
            <td class="switch-cell">${elArmCell(clientId, row.phone_number, elAgents)}</td>
            <td class="cell-middle">${providerBadge(primarySms, row.primary_sms_url)}</td>
            <td class="cell-middle">${providerBadge(fallbackSms, row.fallback_sms_url)}</td>
            <td class="note-cell">${noteMarkup}</td>
          </tr>
        `;
  }).join("");

  setRoutingControlsDisabled(els, false);
}

export function upsertRoutingCache(clientId, patch) {
  const cache = loadRoutingCache();
  const current = routingEntryFor(clientId, cache);
  cache[String(clientId)] = { ...current, ...patch, client_id: clientId };
  saveRoutingCache(cache);

  return cache;
}

function replaceRoutingCache(clientId, entry) {
  const cache = loadRoutingCache();
  cache[String(clientId)] = { ...emptyRoutingEntry(clientId), ...entry, client_id: clientId };
  saveRoutingCache(cache);

  return cache;
}

export function applyResultsToRoutingCache(els, payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const allowed = new Set(uniqueClientIds().map(String));

  for (const row of results) {
    if (row?.client_id == null) continue;
    if (!allowed.has(String(row.client_id))) continue;
    if (isTwilioListFailed(row)) continue;

    if (isClientStatusMiss(row)) {
      replaceRoutingCache(row.client_id, missCacheEntry(row.client_id, row));
      continue;
    }

    upsertRoutingCache(row.client_id, cachePatchFromStatusRow(row.client_id, row));
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

  if (isTwilioListFailed(row)) {
    return "error";
  }

  if (isClientStatusMiss(row)) {
    replaceRoutingCache(clientId, missCacheEntry(clientId, row));

    return "error";
  }

  upsertRoutingCache(clientId, cachePatchFromStatusRow(clientId, row));

  return "ok";
}

function statusReason(row) {
  return typeof row?.reason === "string" ? row.reason.trim() : "";
}

function isTwilioListFailed(row) {
  return statusReason(row) === "twilio_list_failed";
}

const CLEAR_CACHE_REASONS = new Set([
  "twilio_number_not_found",
  "client_not_found",
  "no_assigned_phone_number",
  "invalid_assigned_phone_number",
]);

function isClientStatusMiss(row) {
  if (isTwilioListFailed(row)) return false;

  return CLEAR_CACHE_REASONS.has(statusReason(row));
}

function missCacheEntry(clientId, row) {
  const summary = summarizeStatusRow(row);

  return {
    ...emptyRoutingEntry(clientId),
    phone_number: summary.phone_number,
    api_status: summary.api_status,
    reason: summary.reason,
    fetched_at: new Date().toISOString(),
  };
}

function cachePatchFromStatusRow(clientId, row) {
  const summary = summarizeStatusRow(row);

  if (isClientStatusMiss(row)) {
    return missCacheEntry(clientId, row);
  }

  return {
    ...summary,
    fetched_at: new Date().toISOString(),
    rate_limited: false,
    error: null,
  };
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
      showBanner("error", cached.error || formatStatusReason(cached.reason) || `Failed to refresh client ${clientId}`);
    } else {
      showBanner("ok", `Updated client ${clientId} in the browser cache.`);
    }
  } finally {
    els.routingBusy.classList.remove("show");
    els.routingBusyLabel.textContent = "Refreshing…";
    renderRoutingTable(els);
  }
}

export async function refreshRouting(els, auth, twilio, { clearBanner, showBanner, elApiKey }) {
  routingRefreshActive = true;
  els.routingBusy.classList.add("show");
  setRoutingControlsDisabled(els, true);
  clearBanner();
  els.routingBusyLabel.textContent = "Loading clients from Marketplace…";

  try {
    const sync = await syncClientList(auth);
    renderClientSource(els);

    if (!sync.synced && !sync.hasPrevious) {
      throw new Error(`Loading clients from Marketplace failed (${sync.error})`);
    }

    if (!sync.synced) {
      showBanner("info", `Loading clients from Marketplace failed (${sync.error}). Using the last synced client list.`);
    }

    const ids = uniqueClientIds();

    els.routingBusyLabel.textContent = "Loading ElevenLabs agents and checking Router AB…";
    const [el] = await Promise.all([syncElAgents(elApiKey), refreshAbHealth(auth), refreshRouterHealth(auth)]);
    const elError = el.error;
    const elNote = !elError
      ? ` ElevenLabs agents updated (${el.count} numbers).`
      : elApiKey
        ? ` ElevenLabs agents could not be loaded (${elError}), so the ElevenLabs agent column is empty.`
        : " No ElevenLabs API key, so the ElevenLabs agent column is empty.";

    const abNote = () => (abWarning() ? " Router AB server is down, see the warning above the table." : "");
    els.routingBusyLabel.textContent = `Refreshing ${ids.length} clients…`;
    const result = await fetchPhoneNumberStatus(auth, ids, twilio);

    if (result.status === 429) {
      showBanner("info", `Status refresh hit the rate limit. Cache was not updated.${elNote}${abNote()}`);
      return;
    }

    if (!result.ok) {
      showBanner("error", `${httpErrorMessage(result.status, result.data, result.text, "")}.${elNote}${abNote()}`);
      return;
    }

    const rows = Array.isArray(result.data?.results) ? result.data.results : [];
    const listFailed = rows.some(isTwilioListFailed);
    const misses = rows.filter(isClientStatusMiss);
    const ok = rows.filter((row) => !isTwilioListFailed(row) && !isClientStatusMiss(row)).length;

    applyResultsToRoutingCache(els, result.data);

    if (listFailed && misses.length) {
      showBanner(
        "info",
        `Status refresh done — ${ok} cached · ${misses.length} cleared · Twilio list failed for the rest (cache kept).${elNote}${abNote()}`,
      );
    } else if (listFailed) {
      showBanner("error", `Twilio inventory list failed. Previous cache was kept.${elNote}${abNote()}`);
    } else if (misses.length) {
      showBanner("info", `Status refresh done — ${ok} cached · ${misses.length} cleared (not found / skipped).${elNote}${abNote()}`);
    } else {
      showBanner(elError || abWarning() ? "info" : "ok", `Status refresh done — ${ok} cached.${elNote}${abNote()}`);
    }
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
