// The Turf API over fetch. Signing in is the auth service's job (./auth-client.js): every request here carries its
// access token, and the organization the person is working in. No cookies: the token is the session.

import { createAuth } from "./auth-client.js";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const remembered = key => {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
};
const remember = (key, value) => {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    /* Not remembered on this device. */
  }
};

export function apiBase() {
  return (remembered("turf.api.url") || import.meta.env?.VITE_TURF_API_URL || "").replace(/\/$/, "");
}

/** Turf's server. People never type it: it is fixed when the app is built (VITE_TURF_API_URL). */
export const SERVER = (import.meta.env?.VITE_TURF_API_URL || "http://localhost:8088").replace(/\/$/, "");

/** The auth service, where people sign in (VITE_TURF_AUTH_URL). */
export const AUTH_SERVER = (import.meta.env?.VITE_TURF_AUTH_URL || "http://localhost:8101").replace(/\/$/, "");

export function setApiBase(url) {
  remember("turf.api.url", url ? url.replace(/\/$/, "") : "");
}

/** The signed-in person, from the auth service. */
export const auth = createAuth({ base: remembered("turf.auth.url") || AUTH_SERVER });

/** The organization this device works in; sent with every request as x-turf-org. */
export const organization = () => remembered("turf.org");
export const setOrganization = id => remember("turf.org", id || "");

export async function request(method, path, body, { base = apiBase(), timeout = 15000, retried = false } = {}) {
  const token = await auth.accessToken().catch(() => null);
  const org = organization();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(token && org ? { "x-turf-org": org } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Unreachable or timed out: the caller treats this as offline.
    throw new ApiError(0, "offline", "The server cannot be reached");
  } finally {
    clearTimeout(timer);
  }
  // A token that expired in flight: refresh once and try again.
  if (response.status === 401 && token && !retried) {
    const renewed = await auth.refresh().catch(() => null);
    if (renewed) return request(method, path, body, { base, timeout, retried: true });
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
  /** A new trial workspace for the signed-in person (one per person). */
  startTrial: (organizationName, timezone) => request("POST", "/api/v1/organizations/trial", { organization: organizationName || "", timezone: timezone || "" }),
  /** Joins the organization of an invitation for this person's email. */
  joinInvitation: token => request("POST", "/api/v1/invitations/join", { token }),
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

/**
 * A browser cannot put headers on a WebSocket, so the token and organization travel in its subprotocol list, which
 * the server reads (and, unlike the address, does not log).
 */
export function socketProtocols(token, org = organization()) {
  return ["turf.v1", ...(token ? [`bearer.${token}`] : []), ...(org ? [`org.${org}`] : [])];
}

/** The token from an invitation link (…#/join?token=…), or the token itself when that is what was pasted. */
export function invitationToken(text) {
  const value = String(text || "").trim();
  const match = value.match(/[?&]token=([^&#\s]+)/);
  return match ? decodeURIComponent(match[1]) : value;
}
