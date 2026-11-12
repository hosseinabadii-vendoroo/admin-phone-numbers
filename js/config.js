export const CONFIG = {
  baseUrl: "https://api-marketplace.vendoroo.ai/vendoroo-voice-agent",
  token: "",
};

export const CACHE_KEY = "phone-admin:client-routing:v2";
export const CLIENT_LIST_KEY = "phone-admin:client-list:v1";
export const EL_AGENTS_KEY = "phone-admin:el-agents:v1";

export const ELEVENLABS_API = "https://api.elevenlabs.io/v1";
export const EL_KEY_STORAGE = "phone-admin:el-api-key";
export const EL_TWILIO_SID_KEY = "phone-admin:el-twilio-sid";
export const BEARER_TOKEN_STORAGE = "phone-admin:bearer-token";

/** Clients flagged as very high risk; the routing table marks them. */
export const HIGH_RISK_CLIENT_IDS = new Set([
  764, 440, 927, 882, 971, 1004, 556, 581, 438, 798, 580, 835, 553, 765, 723, 543,
  950, 711, 762, 802, 1024, 883, 573, 928, 502, 572, 494, 770, 495, 672, 403,
].map(String));

/** Bulk actions: at most this many clients at once, one request each, with a pause between. */
export const BULK_MAX_CLIENTS = 20;
export const BULK_PAUSE_MS = 1500;
