export function httpErrorMessage(status, data, text, statusText) {
  const detail = data?.detail ?? data?.message ?? text ?? statusText;
  const detailText = typeof detail === "string" ? detail : JSON.stringify(detail);

  return `HTTP ${status}: ${detailText}`;
}

export async function fetchJson(auth, method, path, body) {
  const base = String(auth?.baseUrl || "").trim().replace(/\/$/, "");
  let token = String(auth?.token || "").trim();

  if (!base) throw new Error("Base URL is required");
  if (!token) throw new Error("Bearer token is required");

  if (/^bearer\s+/i.test(token)) {
    token = token.replace(/^bearer\s+/i, "").trim();
  }

  if (!token) throw new Error("Bearer token is required");

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const init = { method, headers };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return { ok: response.ok, status: response.status, data, text };
}

export async function apiRequest(auth, method, path, body) {
  const result = await fetchJson(auth, method, path, body);

  if (!result.ok) {
    throw new Error(httpErrorMessage(result.status, result.data, result.text, ""));
  }

  return result.data;
}

function statusQuery(clientIds, twilio) {
  const params = new URLSearchParams({ client_ids: clientIds.join(",") });

  if (twilio) {
    params.set("twilio_account_sid", twilio.twilio_account_sid);
    params.set("twilio_auth_token", twilio.twilio_auth_token);
  }

  return `/api/admin/phone-numbers/phone-number-status?${params}`;
}

export function fetchPhoneNumberStatus(auth, clientIds, twilio) {
  return fetchJson(auth, "GET", statusQuery(clientIds, twilio));
}

export function getPhoneNumberStatus(auth, clientIds, twilio) {
  return apiRequest(auth, "GET", statusQuery(clientIds, twilio));
}

export function importElevenlabs(auth, clientIds, forwardVoice, twilio) {
  const body = {
    client_ids: clientIds,
    forward_voice: forwardVoice,
  };

  if (twilio) Object.assign(body, twilio);

  return apiRequest(auth, "POST", "/api/admin/phone-numbers/import-elevenlabs", body);
}

export function switchPhoneProvider(auth, clientIds, provider, forwardVoice, twilio) {
  const body = {
    client_ids: clientIds,
    provider,
    forward_voice: forwardVoice,
  };

  if (twilio) Object.assign(body, twilio);

  return apiRequest(auth, "POST", "/api/admin/phone-numbers/switch-phone-provider", body);
}
