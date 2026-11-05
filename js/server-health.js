import { fetchJson } from "./api.js";

const TIMEOUT_MS = 8000;
const IDLE = { state: "idle", detail: "", checkedAt: null };

let routerHealth = IDLE;
let abHealth = IDLE;

/** Router AB runs as a second deployment next to the main one: the same URL with "-ab" added. */
export function abBaseUrl(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");

  return base ? `${base}-ab` : "";
}

export function getRouterHealth() {
  return routerHealth;
}

export function getAbHealth() {
  return abHealth;
}

/** Back to "not checked", for when the Base URL or token changed and the last result is stale. */
export function resetServerHealth() {
  routerHealth = IDLE;
  abHealth = IDLE;
}

/** Calls GET /health on a server. It is up only when it answers 200 with status "ok". */
async function checkHealth(auth, baseUrl) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  const result = (state, detail = "") => ({ state, detail, checkedAt: new Date().toISOString() });

  try {
    const response = await fetchJson({ ...auth, baseUrl }, "GET", "/health", undefined, controller.signal);

    if (response.status === 200 && response.data?.status === "ok") return result("up");

    return result("down", response.ok ? "unexpected response" : `HTTP ${response.status}`);
  } catch (err) {
    if (err?.name === "AbortError") return result("down", `no answer in ${TIMEOUT_MS / 1000}s`);
    if (err instanceof TypeError) return result("down", "not reachable");

    return result("down", err?.message || String(err));
  } finally {
    window.clearTimeout(timer);
  }
}

export async function refreshRouterHealth(auth) {
  routerHealth = { ...routerHealth, state: "checking" };
  routerHealth = await checkHealth(auth, String(auth?.baseUrl || "").trim().replace(/\/+$/, ""));

  return routerHealth;
}

export async function refreshAbHealth(auth) {
  abHealth = { ...abHealth, state: "checking" };
  abHealth = await checkHealth(auth, abBaseUrl(auth?.baseUrl));

  return abHealth;
}
