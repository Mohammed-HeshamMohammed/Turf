// The Turf API over fetch. Browser sessions are an HttpOnly cookie, so requests include credentials and every write
// carries the X-Turf-Request header the server requires.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function apiBase() {
  try {
    return (window.localStorage.getItem("turf.api.url") || import.meta.env?.VITE_TURF_API_URL || "").replace(/\/$/, "");
  } catch {
    return import.meta.env?.VITE_TURF_API_URL || "";
  }
}

export function setApiBase(url) {
  try {
    if (url) window.localStorage.setItem("turf.api.url", url.replace(/\/$/, ""));
    else window.localStorage.removeItem("turf.api.url");
  } catch {
    /* Not remembered on this device. */
  }
}

export async function request(method, path, body, { base = apiBase(), timeout = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(base + path, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(method === "GET" ? {} : { "X-Turf-Request": "1" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Unreachable or timed out: the caller treats this as offline.
    throw new ApiError(0, "offline", "The server cannot be reached");
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) throw new ApiError(response.status, data?.error?.code || "error", data?.error?.message || "The server refused the request");
  return data;
}

export const api = {
  me: () => request("GET", "/api/v1/me"),
  login: (email, password) => request("POST", "/api/v1/auth/login", { email, password }),
  logout: () => request("POST", "/api/v1/auth/logout", {}),
  verifyMfa: code => request("POST", "/api/v1/auth/mfa/verify", code.includes("-") ? { recovery_code: code } : { code }),
  setupMfa: () => request("POST", "/api/v1/auth/mfa/setup", {}),
  confirmMfa: code => request("POST", "/api/v1/auth/mfa/confirm", { code }),
  directory: () => request("GET", "/api/v1/directory"),
  teams: () => request("GET", "/api/v1/admin/teams"),
  projects: () => request("GET", "/api/v1/projects"),
  settings: () => request("GET", "/api/v1/settings"),
  snapshot: () => request("GET", "/sync/snapshot", undefined, { timeout: 60000 }),
  pull: (cursor, accessRevision) => request("GET", `/sync/pull?cursor=${cursor}&access_revision=${accessRevision}`),
  push: (operations, accessRevision) => request("POST", "/sync/push", { operations, access_revision: accessRevision }, { timeout: 60000 }),
  op: operation => request("POST", "/api/v1/ops", operation),
  rules: () => request("GET", "/api/v1/rules"),
  saveRule: (id, rule) => request("PUT", "/api/v1/rules/" + id, rule),
};

/** The /events WebSocket URL for an http(s) API base. */
export function eventsUrl(base = apiBase()) {
  const url = new URL(base + "/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
