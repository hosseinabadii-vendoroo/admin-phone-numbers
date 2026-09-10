import { EL_KEY_STORAGE, EL_TWILIO_SID_KEY } from "./config.js";
import { escapeHtml } from "./results.js";
import {
  createEnvVar as apiCreateEnvVar,
  createPhoneNumber,
  deletePhoneNumber,
  getElevenlabsUser,
  inviteWorkspaceMember,
  listAgentBranches,
  listPhoneNumbers,
  listWorkspaceMembers,
  paginateAgents,
  paginateEnvVars,
  paginateSecrets,
  updateEnvVar,
  updatePhoneNumber,
} from "./elevenlabs-api.js";

const SEATS = [
  { id: "workspace_admin", label: "Admin" },
  { id: "workspace_member", label: "Full / editor" },
  { id: "workspace_lite_member", label: "Basic / viewer" },
];
const DEFAULT_SEAT = "workspace_lite_member";
const ENV_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

const state = {
  apiKey: "",
  tab: "phones",
  connected: false,
  phones: [],
  agents: [],
  environments: [],
  extraEnvironments: [],
  branchesByAgent: {},
  drafts: {},
  members: [],
  envVars: [],
  envDrafts: {},
  secrets: [],
};

const els = {};
let showBanner = () => {};

function assigned(phone) {
  return phone.assigned_agent || {};
}

function optionList(items, value, labelFn, emptyLabel) {
  const opts = [`<option value="">${escapeHtml(emptyLabel)}</option>`];

  for (const item of items) {
    const id = item.id || item.agent_id || item.secret_id;
    const selected = id === value ? " selected" : "";
    opts.push(`<option value="${escapeHtml(id)}"${selected}>${escapeHtml(labelFn(item))}</option>`);
  }

  if (value && !items.some((item) => (item.id || item.agent_id || item.secret_id) === value)) {
    opts.push(`<option value="${escapeHtml(value)}" selected>${escapeHtml(value)}</option>`);
  }

  return opts.join("");
}

function draftFor(phone) {
  const current = assigned(phone);
  if (state.drafts[phone.phone_number_id]) return state.drafts[phone.phone_number_id];

  const draft = {
    agent_id: current.agent_id || "",
    branch_id: current.branch_id || "",
    environment: current.environment || "",
  };
  state.drafts[phone.phone_number_id] = draft;

  return draft;
}

function isDirty(phone) {
  const current = assigned(phone);
  const draft = draftFor(phone);

  return (
    (current.agent_id || "") !== (draft.agent_id || "")
    || (current.branch_id || "") !== (draft.branch_id || "")
    || (current.environment || "") !== (draft.environment || "")
  );
}

function seatLabel(seatType) {
  const seat = SEATS.find((item) => item.id === seatType);

  return seat ? seat.label : (seatType || "—");
}

function cloneValues(values) {
  const next = {};
  Object.entries(values || {}).forEach(([key, value]) => {
    next[key] = value && typeof value === "object" ? { ...value } : value;
  });

  return next;
}

function envDraft(variable) {
  if (state.envDrafts[variable.id]) return state.envDrafts[variable.id];

  const draft = { values: cloneValues(variable.values) };
  state.envDrafts[variable.id] = draft;

  return draft;
}

function normalizeValues(type, values) {
  const next = {};

  Object.entries(values || {}).forEach(([env, value]) => {
    if (value == null || value === "") {
      next[env] = null;

      return;
    }

    if (type === "secret") {
      next[env] = { secret_id: typeof value === "object" ? value.secret_id : value };
    } else if (type === "auth_connection") {
      next[env] = { auth_connection_id: typeof value === "object" ? value.auth_connection_id : value };
    } else {
      next[env] = typeof value === "object" ? JSON.stringify(value) : value;
    }
  });

  return next;
}

function envDirty(variable) {
  return JSON.stringify(normalizeValues(variable.type, variable.values))
    !== JSON.stringify(normalizeValues(variable.type, envDraft(variable).values));
}

function scalarValue(type, value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (type === "secret") return value.secret_id || "";
  if (type === "auth_connection") return value.auth_connection_id || "";

  return String(value);
}

function collectEnvironments(variables, phones) {
  const names = new Set(["production"]);

  for (const item of variables) {
    Object.keys(item.values || {}).forEach((name) => names.add(name));
  }

  for (const phone of phones) {
    const env = assigned(phone).environment;
    if (env) names.add(env);
  }

  state.extraEnvironments.forEach((name) => names.add(name));

  return ["production", ...[...names].filter((name) => name !== "production").sort((a, b) => a.localeCompare(b))];
}

function apiKey() {
  return String(els.apiKey?.value || "").trim();
}

function persistKey(key) {
  if (els.remember.checked) {
    localStorage.setItem(EL_KEY_STORAGE, key);
    sessionStorage.removeItem(EL_KEY_STORAGE);
  } else {
    localStorage.removeItem(EL_KEY_STORAGE);
    sessionStorage.setItem(EL_KEY_STORAGE, key);
  }
}

function restoreKey() {
  const stored = localStorage.getItem(EL_KEY_STORAGE) || sessionStorage.getItem(EL_KEY_STORAGE);
  if (!stored) return;

  els.apiKey.value = stored;
  els.remember.checked = Boolean(localStorage.getItem(EL_KEY_STORAGE));
}

function setElBusy(on, label) {
  els.busy.classList.toggle("show", on);
  if (label) els.busyLabel.textContent = label;
  els.connectBtn.disabled = on;
}

function setTab(tab) {
  state.tab = tab;
  const tabs = [
    { tab: els.tabPhones, panel: els.viewPhones },
    { tab: els.tabEnvs, panel: els.viewEnvs },
    { tab: els.tabMembers, panel: els.viewMembers },
  ];

  for (const item of tabs) {
    const selected = item.tab.getAttribute("data-tab") === tab;
    item.tab.setAttribute("aria-selected", selected ? "true" : "false");
    item.panel.hidden = !selected;
  }
}

function environmentItems() {
  return state.environments.map((name) => ({ id: name }));
}

async function loadBranches(agentId) {
  if (!agentId) return [];
  if (state.branchesByAgent[agentId]) return state.branchesByAgent[agentId];

  const data = await listAgentBranches(state.apiKey, agentId);
  state.branchesByAgent[agentId] = data.results || [];

  return state.branchesByAgent[agentId];
}

function renderPhones() {
  const phones = state.phones;

  if (!state.apiKey) {
    els.phonePanel.innerHTML = '<div class="empty">Paste an ElevenLabs API key and connect.</div>';

    return;
  }

  const savedSid = localStorage.getItem(EL_TWILIO_SID_KEY) || "";
  const importForm = `
        <form class="composer" id="importPhoneForm">
          <div class="field">
            <label for="importNumber">Phone number</label>
            <input id="importNumber" type="text" required placeholder="+19125550123" />
          </div>
          <div class="field">
            <label for="importLabel">Label</label>
            <input id="importLabel" type="text" required placeholder="rooceptionist | Client" />
          </div>
          <div class="field">
            <label for="importSid">Twilio SID</label>
            <input id="importSid" type="text" required placeholder="ACxxxxxxxx" value="${escapeHtml(savedSid)}" />
          </div>
          <div class="field">
            <label for="importToken">Twilio token</label>
            <input id="importToken" type="password" required autocomplete="off" placeholder="Auth token or API secret" />
          </div>
          <div class="field">
            <label for="importAgent">Agent</label>
            <select id="importAgent">${optionList(state.agents, "", (agent) => agent.name, "Unassigned")}</select>
          </div>
          <label class="check-inline composer-check" for="importSms">
            <input id="importSms" type="checkbox" checked />
            Enable SMS
          </label>
          <button class="btn-primary" type="submit">Import number</button>
        </form>`;

  const rows = phones.map((phone) => {
    const draft = draftFor(phone);
    const dirty = isDirty(phone);
    const branches = state.branchesByAgent[draft.agent_id] || [];

    return `
          <tr class="${dirty ? "dirty" : ""}" data-phone="${escapeHtml(phone.phone_number_id)}">
            <td>
              <div class="cell-title">${escapeHtml(phone.phone_number ?? "")}</div>
              <div class="cell-sub">${escapeHtml(phone.label || "Untitled")}</div>
              <div class="mono faint">${escapeHtml(phone.phone_number_id ?? "")}</div>
            </td>
            <td><span class="badge badge-muted">${escapeHtml(phone.provider || "unknown")}</span></td>
            <td class="ctrl-cell">
              <select class="ctrl" data-phone-field="agent_id">
                ${optionList(state.agents, draft.agent_id, (agent) => agent.name, "Unassigned")}
              </select>
            </td>
            <td class="ctrl-cell">
              <select class="ctrl" data-phone-field="branch_id" ${draft.agent_id ? "" : "disabled"}>
                ${optionList(branches, draft.branch_id, (branch) => branch.name, draft.agent_id ? "Default / none" : "Pick an agent")}
              </select>
            </td>
            <td class="ctrl-cell">
              <select class="ctrl" data-phone-field="environment">
                ${optionList(environmentItems(), draft.environment, (item) => item.id, "Unassigned")}
              </select>
            </td>
            <td class="actions-cell">
              <div class="row-actions">
                <button class="btn-save${dirty ? " dirty" : ""}" data-action="save-phone" type="button" ${dirty ? "" : "disabled"}>Save</button>
                <button class="btn-danger" data-action="delete-phone" type="button">Delete</button>
              </div>
            </td>
          </tr>`;
  }).join("");

  const table = phones.length
    ? `<table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Provider</th>
                <th>Agent</th>
                <th>Branch</th>
                <th>Environment</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`
    : '<div class="empty">No phone numbers yet. Import one above.</div>';

  els.phonePanel.innerHTML = `${importForm}${table}`;
}

function renderMembers() {
  if (!state.apiKey) {
    els.memberPanel.innerHTML = '<div class="empty">Connect to load members.</div>';

    return;
  }

  const members = state.members;

  const rows = members.map((member) => `
          <tr>
            <td>
              <div class="cell-title">${escapeHtml(member.first_name || "—")}</div>
              <div class="mono faint">${escapeHtml(member.user_id || "")}</div>
            </td>
            <td>${escapeHtml(member.email ?? "")}</td>
            <td><span class="badge badge-muted">${escapeHtml(seatLabel(member.seat_type))}</span></td>
            <td>
              ${member.is_owner ? '<span class="badge badge-ok">Owner</span>' : ""}
              ${member.is_locked ? ' <span class="badge badge-muted">Locked</span>' : ""}
            </td>
          </tr>
        `).join("");

  const seatOptions = SEATS
    .map((seat) => `<option value="${escapeHtml(seat.id)}"${seat.id === DEFAULT_SEAT ? " selected" : ""}>${escapeHtml(seat.label)}</option>`)
    .join("");

  els.memberPanel.innerHTML = `
        <form class="composer" id="inviteForm">
          <div class="field">
            <label for="inviteEmail">Invite email</label>
            <input id="inviteEmail" type="email" required placeholder="name@vendoroo.ai" />
          </div>
          <div class="field">
            <label for="inviteSeat">Seat</label>
            <select id="inviteSeat">${seatOptions}</select>
          </div>
          <button class="btn-primary" type="submit">Send invite</button>
        </form>
        ${members.length
          ? `<table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Seat</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`
          : '<div class="empty">No members found. Pending invites are not returned by the API.</div>'}`;
}

function envFieldControl(variable, envName) {
  const draft = envDraft(variable);
  const value = scalarValue(variable.type, draft.values[envName]);
  const fieldId = `env-${variable.id}-${envName}`;

  if (variable.type === "secret") {
    return `<select id="${escapeHtml(fieldId)}" data-env-field="${escapeHtml(envName)}">${optionList(state.secrets, value, (secret) => secret.name, "None")}</select>`;
  }

  if (variable.type === "auth_connection") {
    return `<input id="${escapeHtml(fieldId)}" type="text" data-env-field="${escapeHtml(envName)}" value="${escapeHtml(value)}" placeholder="auth_…" />`;
  }

  return `<input id="${escapeHtml(fieldId)}" type="text" data-env-field="${escapeHtml(envName)}" value="${escapeHtml(value)}" placeholder="${envName === "production" ? "required" : "optional"}" />`;
}

function envField(variable, envName) {
  const draft = envDraft(variable);
  const value = scalarValue(variable.type, draft.values[envName]);
  const canClear = envName !== "production";
  const fieldId = `env-${variable.id}-${envName}`;
  const clear = canClear && value
    ? `<button class="btn-ghost btn-tiny" data-action="clear-env-value" data-env="${escapeHtml(envName)}" type="button">Clear</button>`
    : "";

  return `
            <div class="field env-value-field">
              <div class="env-value-label">
                <label for="${escapeHtml(fieldId)}">${escapeHtml(envName)}${envName === "production" ? " *" : ""}</label>
                ${clear}
              </div>
              ${envFieldControl(variable, envName)}
            </div>`;
}

function renderEnvs() {
  if (!state.apiKey) {
    els.envPanel.innerHTML = '<div class="empty">Connect to load environment variables.</div>';

    return;
  }

  const variables = state.envVars;

  const cards = variables.map((variable) => {
    const dirty = envDirty(variable);
    const fields = state.environments
      .map((envName) => envField(variable, envName))
      .join("");

    return `
          <article class="env-card${dirty ? " dirty" : ""}" data-var="${escapeHtml(variable.id)}">
            <div class="env-card-hd">
              <div>
                <div class="cell-title">${escapeHtml(variable.label)}</div>
                <div class="mono faint">${escapeHtml("{{system__env_" + variable.label + "}}")}</div>
              </div>
              <div class="row-actions">
                <button class="btn-save${dirty ? " dirty" : ""}" data-action="save-env" type="button" ${dirty ? "" : "disabled"}>Save</button>
              </div>
            </div>
            <div class="env-card-bd">
              ${fields}
            </div>
          </article>`;
  }).join("");

  const chips = state.environments
    .map((name) => `<span class="chip${name === "production" ? " prod" : ""}">${escapeHtml(name)}</span>`)
    .join("");

  els.envPanel.innerHTML = `
        <div class="panel-hint">Each variable lists environment values vertically. Production is required. Add a named environment, fill values, then save. Clearing a non-production value removes that environment from the variable.</div>
        ${variables.length
          ? `<div class="env-list">${cards}</div>`
          : '<div class="empty">No environment variables yet.</div>'}
        <div class="env-create">
          <div class="env-create-grid">
            <div class="composer env-composer">
              <div class="field">
                <label for="newEnvName">New environment</label>
                <input id="newEnvName" type="text" placeholder="rooceptionist" />
              </div>
              <button class="btn-ghost" type="button" data-action="add-environment">Add environment</button>
            </div>
            <form class="composer env-composer" id="createVarForm">
              <div class="field">
                <label for="newVarLabel">New string variable</label>
                <input id="newVarLabel" type="text" required placeholder="server_host" />
              </div>
              <div class="field">
                <label for="newVarProd">Production value</label>
                <input id="newVarProd" type="text" required placeholder="api.example.com" />
              </div>
              <button class="btn-primary" type="submit">Create</button>
            </form>
          </div>
          <div class="chips">${chips}</div>
        </div>`;
}

function render() {
  renderPhones();
  renderMembers();
  renderEnvs();
}

function updateWorkspaceMeta(who) {
  if (!state.connected) {
    els.workspaceMeta.innerHTML = "";

    return;
  }

  const label = who || "workspace";
  els.workspaceMeta.innerHTML = `<span class="stat ok">${escapeHtml(`Connected as ${label}`)}</span>`;
}

async function connect() {
  const key = apiKey();
  if (!key) {
    showBanner("error", "Enter an ElevenLabs API key first.");

    return;
  }

  state.apiKey = key;
  setElBusy(true, "Loading workspace…");
  els.phonePanel.innerHTML = '<div class="empty loading"><span class="spinner"></span> Loading workspace…</div>';

  try {
    const [userResult, phones, agents, envVars, members, secrets] = await Promise.all([
      getElevenlabsUser(key).catch(() => null),
      listPhoneNumbers(key),
      paginateAgents(key),
      paginateEnvVars(key).catch(() => []),
      listWorkspaceMembers(key).catch(() => []),
      paginateSecrets(key).catch(() => []),
    ]);

    state.phones = Array.isArray(phones) ? phones : [];
    state.agents = agents;
    state.envVars = envVars;
    state.members = Array.isArray(members) ? members : [];
    state.secrets = secrets;
    state.drafts = {};
    state.envDrafts = {};
    state.branchesByAgent = {};
    state.environments = collectEnvironments(state.envVars, state.phones);
    state.connected = true;

    const who = (userResult && (userResult.first_name || userResult.email || userResult.user_id)) || "workspace";
    updateWorkspaceMeta(who);
    els.connectBtn.textContent = "Refresh";
    persistKey(key);

    const agentIds = [...new Set(state.phones.map((phone) => assigned(phone).agent_id).filter(Boolean))];
    await Promise.all(agentIds.map((id) => loadBranches(id)));
    render();
    showBanner("ok", "Loaded ElevenLabs workspace.");
  } catch (error) {
    state.connected = false;
    updateWorkspaceMeta();
    els.connectBtn.textContent = "Connect";
    els.phonePanel.innerHTML = `<div class="empty error">${escapeHtml(error.message)}</div>`;
    showBanner("error", error.message);
  } finally {
    setElBusy(false, "Working…");
  }
}

async function refreshPhones() {
  const phones = await listPhoneNumbers(state.apiKey);
  state.phones = Array.isArray(phones) ? phones : [];
  const agentIds = [...new Set(state.phones.map((phone) => assigned(phone).agent_id).filter(Boolean))];
  await Promise.all(agentIds.map((id) => loadBranches(id)));
  renderPhones();
}

async function importPhone(payload) {
  await createPhoneNumber(state.apiKey, payload);
  localStorage.setItem(EL_TWILIO_SID_KEY, payload.sid);
  showBanner("ok", `Imported ${payload.phone_number}.`);
  await refreshPhones();
}

async function deletePhone(phoneId) {
  const phone = state.phones.find((item) => item.phone_number_id === phoneId);
  if (!phone) return;

  const label = phone.phone_number + (phone.label ? ` (${phone.label})` : "");
  if (!window.confirm(`Remove ${label} from this ElevenLabs workspace?`)) return;

  await deletePhoneNumber(state.apiKey, phoneId);
  delete state.drafts[phoneId];
  state.phones = state.phones.filter((item) => item.phone_number_id !== phoneId);
  renderPhones();
  showBanner("ok", `Deleted ${phone.phone_number}.`);
}

async function savePhone(phoneId) {
  const phone = state.phones.find((item) => item.phone_number_id === phoneId);
  if (!phone) return;

  const draft = draftFor(phone);

  try {
    const updated = await updatePhoneNumber(state.apiKey, phoneId, {
      agent_id: draft.agent_id || null,
      branch_id: draft.branch_id || null,
      environment: draft.environment || null,
    });
    const index = state.phones.findIndex((item) => item.phone_number_id === phoneId);
    if (index >= 0) state.phones[index] = updated;
    delete state.drafts[phoneId];
    renderPhones();
    showBanner("ok", `Updated ${updated.phone_number || "number"}.`);
  } catch (error) {
    showBanner("error", error.message);
    renderPhones();
  }
}

async function inviteMember(email, seatType) {
  await inviteWorkspaceMember(state.apiKey, email, seatType);
  showBanner("ok", `Invite sent to ${email}.`);
}

function patchValues(variable) {
  const original = variable.values || {};
  const normalized = normalizeValues(variable.type, envDraft(variable).values);
  const values = {};
  const keys = new Set([...Object.keys(original), ...Object.keys(normalized)]);

  keys.forEach((key) => {
    const value = normalized[key];
    const empty = value == null || value === ""
      || (typeof value === "object" && !value.secret_id && !value.auth_connection_id);

    if (empty) {
      if (key !== "production" && Object.prototype.hasOwnProperty.call(original, key)) values[key] = null;

      return;
    }

    values[key] = value;
  });

  return values;
}

async function saveEnvVar(id) {
  const variable = state.envVars.find((item) => item.id === id);
  if (!variable) return;

  const values = patchValues(variable);
  if (!values.production) {
    showBanner("error", "Production value is required.");

    return;
  }

  try {
    const updated = await updateEnvVar(state.apiKey, id, { values });
    const index = state.envVars.findIndex((item) => item.id === id);
    if (index >= 0) state.envVars[index] = updated;
    delete state.envDrafts[id];
    state.environments = collectEnvironments(state.envVars, state.phones);
    renderEnvs();
    renderPhones();
    showBanner("ok", `Saved ${updated.label}.`);
  } catch (error) {
    showBanner("error", error.message);
    renderEnvs();
  }
}

async function createVariable(label, productionValue) {
  const created = await apiCreateEnvVar(state.apiKey, {
    type: "string",
    label,
    values: { production: productionValue },
  });
  state.envVars.push(created);
  state.environments = collectEnvironments(state.envVars, state.phones);
  renderEnvs();
  renderPhones();
  showBanner("ok", `Created ${created.label}.`);
}

async function ensureBranches(agentId, phoneId) {
  if (!agentId) {
    renderPhones();

    return;
  }

  await loadBranches(agentId);
  const draft = state.drafts[phoneId];

  if (draft && draft.agent_id === agentId && !draft.branch_id) {
    const main = (state.branchesByAgent[agentId] || []).find((branch) => branch.name.toLowerCase() === "main");
    if (main) draft.branch_id = main.id;
  }

  renderPhones();
}

function bindEvents() {
  els.connectBtn.addEventListener("click", () => {
    connect();
  });

  els.apiKey.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      connect();
    }
  });

  els.tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) setTab(tab.getAttribute("data-tab"));
  });

  els.panel.addEventListener("submit", async (event) => {
    if (event.target.id === "importPhoneForm") {
      event.preventDefault();
      const phoneNumber = document.getElementById("importNumber").value.trim();
      const label = document.getElementById("importLabel").value.trim();
      const sid = document.getElementById("importSid").value.trim();
      const token = document.getElementById("importToken").value.trim();
      const agentId = document.getElementById("importAgent").value;
      const enableSms = document.getElementById("importSms").checked;
      const payload = {
        provider: "twilio",
        phone_number: phoneNumber,
        label,
        sid,
        token,
        enable_sms: enableSms,
      };
      if (agentId) payload.agent_id = agentId;

      try {
        await importPhone(payload);
        document.getElementById("importNumber").value = "";
        document.getElementById("importLabel").value = "";
        document.getElementById("importToken").value = "";
      } catch (error) {
        showBanner("error", error.message);
      }
    }

    if (event.target.id === "inviteForm") {
      event.preventDefault();
      const email = document.getElementById("inviteEmail").value.trim();
      const seat = document.getElementById("inviteSeat").value;

      try {
        await inviteMember(email, seat);
        event.target.reset();
        document.getElementById("inviteSeat").value = DEFAULT_SEAT;
      } catch (error) {
        showBanner("error", error.message);
      }
    }

    if (event.target.id === "createVarForm") {
      event.preventDefault();
      const label = document.getElementById("newVarLabel").value.trim();
      const production = document.getElementById("newVarProd").value.trim();

      try {
        await createVariable(label, production);
        event.target.reset();
      } catch (error) {
        showBanner("error", error.message);
      }
    }
  });

  els.panel.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (!action) return;

    const kind = action.getAttribute("data-action");

    if (kind === "save-phone") {
      action.disabled = true;
      savePhone(action.closest("tr").getAttribute("data-phone"));
    }

    if (kind === "delete-phone") {
      action.disabled = true;
      deletePhone(action.closest("tr").getAttribute("data-phone")).finally(() => {
        if (action.isConnected) action.disabled = false;
      });
    }

    if (kind === "save-env") {
      action.disabled = true;
      saveEnvVar(action.closest("[data-var]").getAttribute("data-var"));
    }

    if (kind === "add-environment") {
      const input = document.getElementById("newEnvName");
      const name = (input.value || "").trim();

      if (!ENV_NAME.test(name)) {
        showBanner("error", "Use a lowercase name like rooceptionist or staging.");

        return;
      }

      if (!state.environments.includes(name)) state.extraEnvironments.push(name);
      state.environments = collectEnvironments(state.envVars, state.phones);
      input.value = "";
      renderEnvs();
      renderPhones();
    }

    if (kind === "clear-env-value") {
      const row = action.closest("[data-var]");
      const variable = state.envVars.find((item) => item.id === row.getAttribute("data-var"));
      const envName = action.getAttribute("data-env");
      envDraft(variable).values[envName] = null;
      renderEnvs();
    }
  });

  els.panel.addEventListener("change", async (event) => {
    const phoneField = event.target.getAttribute("data-phone-field");

    if (phoneField) {
      const phoneId = event.target.closest("tr").getAttribute("data-phone");
      const draft = state.drafts[phoneId] || draftFor(state.phones.find((item) => item.phone_number_id === phoneId));
      draft[phoneField] = event.target.value;

      if (phoneField === "agent_id") {
        draft.branch_id = "";
        await ensureBranches(draft.agent_id, phoneId);

        return;
      }

      renderPhones();
    }

    const envField = event.target.getAttribute("data-env-field");

    if (envField) {
      const variable = state.envVars.find((item) => item.id === event.target.closest("[data-var]").getAttribute("data-var"));
      const draft = envDraft(variable);

      if (variable.type === "secret") {
        draft.values[envField] = event.target.value ? { secret_id: event.target.value } : null;
      } else if (variable.type === "auth_connection") {
        draft.values[envField] = event.target.value ? { auth_connection_id: event.target.value } : null;
      } else {
        draft.values[envField] = event.target.value;
      }

      renderEnvs();
    }
  });

  els.panel.addEventListener("input", (event) => {
    if (event.target.getAttribute("data-env-field")) {
      const row = event.target.closest("[data-var]");
      const variable = state.envVars.find((item) => item.id === row.getAttribute("data-var"));
      const envName = event.target.getAttribute("data-env-field");
      const draft = envDraft(variable);

      if (variable.type === "auth_connection") {
        draft.values[envName] = event.target.value ? { auth_connection_id: event.target.value } : null;
      } else if (variable.type === "string") {
        draft.values[envName] = event.target.value;
      }

      const button = row.querySelector("[data-action='save-env']");
      const dirty = envDirty(variable);
      button.disabled = !dirty;
      button.classList.toggle("dirty", dirty);
      row.classList.toggle("dirty", dirty);
    }
  });
}

export function initElevenlabs(callbacks) {
  showBanner = callbacks.showBanner;
  els.apiKey = document.getElementById("elApiKey");
  els.remember = document.getElementById("rememberElKey");
  els.connectBtn = document.getElementById("btnElConnect");
  els.panel = document.getElementById("panelElevenlabs");
  els.tabs = document.getElementById("elTabs");
  els.tabPhones = document.getElementById("elTabPhones");
  els.tabMembers = document.getElementById("elTabMembers");
  els.tabEnvs = document.getElementById("elTabEnvs");
  els.viewPhones = document.getElementById("elViewPhones");
  els.viewMembers = document.getElementById("elViewMembers");
  els.viewEnvs = document.getElementById("elViewEnvs");
  els.phonePanel = document.getElementById("elPhonePanel");
  els.memberPanel = document.getElementById("elMemberPanel");
  els.envPanel = document.getElementById("elEnvPanel");
  els.workspaceMeta = document.getElementById("elWorkspaceMeta");
  els.busy = document.getElementById("elBusy");
  els.busyLabel = document.getElementById("elBusyLabel");

  restoreKey();
  bindEvents();
  render();
}
