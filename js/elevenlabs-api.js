import { ELEVENLABS_API } from "./config.js";

function apiError(payload, fallback) {
  if (payload && typeof payload === "object") {
    const detail = payload.detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && detail.message) return detail.message;
  }

  return fallback;
}

export async function elRequest(apiKey, path, options = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("ElevenLabs API key is required");

  const { method = "GET", body, headers: extraHeaders } = options;
  const headers = {
    Accept: "application/json",
    "xi-api-key": key,
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(extraHeaders || {}),
  };
  const init = { method, headers };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${ELEVENLABS_API}${path}`, init);
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(apiError(data, `Request failed (${response.status})`));
  }

  return data;
}

async function paginate(apiKey, path, listKey, extraParams) {
  const items = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({ page_size: "100", ...(extraParams || {}) });
    if (cursor) params.set("cursor", cursor);
    const page = await elRequest(apiKey, `${path}?${params}`);
    items.push(...(page[listKey] || []));
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);

  return items;
}

export function listPhoneNumbers(apiKey) {
  return elRequest(apiKey, "/convai/phone-numbers");
}

export function createPhoneNumber(apiKey, payload) {
  return elRequest(apiKey, "/convai/phone-numbers", { method: "POST", body: payload });
}

export function updatePhoneNumber(apiKey, phoneId, payload) {
  return elRequest(apiKey, `/convai/phone-numbers/${encodeURIComponent(phoneId)}`, {
    method: "PATCH",
    body: payload,
  });
}

export function deletePhoneNumber(apiKey, phoneId) {
  return elRequest(apiKey, `/convai/phone-numbers/${encodeURIComponent(phoneId)}`, {
    method: "DELETE",
  });
}

export function paginateAgents(apiKey) {
  return paginate(apiKey, "/convai/agents", "agents", { archived: "false" });
}

export function listAgentBranches(apiKey, agentId) {
  return elRequest(apiKey, `/convai/agents/${encodeURIComponent(agentId)}/branches?limit=100`);
}

export function paginateEnvVars(apiKey) {
  return paginate(apiKey, "/convai/environment-variables", "environment_variables");
}

export function createEnvVar(apiKey, payload) {
  return elRequest(apiKey, "/convai/environment-variables", { method: "POST", body: payload });
}

export function updateEnvVar(apiKey, id, payload) {
  return elRequest(apiKey, `/convai/environment-variables/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: payload,
  });
}

export function paginateSecrets(apiKey) {
  return paginate(apiKey, "/convai/secrets", "secrets");
}

export function listWorkspaceMembers(apiKey) {
  return elRequest(apiKey, "/workspace/members");
}

export function inviteWorkspaceMember(apiKey, email, seatType) {
  return elRequest(apiKey, "/workspace/invites/add", {
    method: "POST",
    body: { email, seat_type: seatType },
  });
}

export function getElevenlabsUser(apiKey) {
  return elRequest(apiKey, "/user");
}
