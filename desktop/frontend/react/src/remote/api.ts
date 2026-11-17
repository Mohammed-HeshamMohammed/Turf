// The Caller Whale API over fetch. Signing in is the auth service's job (./auth-client.js): every request here carries its
// access token, and the organization the person is working in. No cookies: the token is the session.

import { createAuth } from "./auth-client.js";

export class ApiError extends Error {
  status: number;
  code: string;
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
  return (remembered("callerwhale.api.url") || import.meta.env?.VITE_CALLERWHALE_API_URL || "").replace(/\/$/, "");
}

/** Caller Whale's server. People never type it: it is fixed when the app is built (VITE_CALLERWHALE_API_URL). */
export const SERVER = (import.meta.env?.VITE_CALLERWHALE_API_URL || "http://localhost:8088").replace(/\/$/, "");

/** Caller Whale's website, where the desktop app sends people to sign in (VITE_CALLERWHALE_SITE_URL). */
export const SITE = (import.meta.env?.VITE_CALLERWHALE_SITE_URL || "https://callerwhale.com").replace(/\/$/, "");

/** The auth service, where people sign in (VITE_CALLERWHALE_AUTH_URL). */
export const AUTH_SERVER = (import.meta.env?.VITE_CALLERWHALE_AUTH_URL || "http://localhost:8101").replace(/\/$/, "");

export function setApiBase(url) {
  remember("callerwhale.api.url", url ? url.replace(/\/$/, "") : "");
}

/** The signed-in person, through the auth service. */
export const auth = createAuth({ base: remembered("callerwhale.auth.url") || AUTH_SERVER });

/** The organization this device works in; sent with every request as x-callerwhale-org. */
export const organization = () => remembered("callerwhale.org");
export const setOrganization = id => remember("callerwhale.org", id || "");

export async function request(method: string, path: string, body?: unknown, { base = apiBase(), timeout = 15000, retried = false, includeOrganization = true }: { base?: string; timeout?: number; retried?: boolean; includeOrganization?: boolean } = {}): Promise<any> {
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
        ...(token && org && includeOrganization ? { "x-callerwhale-org": org } : {}),
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
    if (renewed) return request(method, path, body, { base, timeout, retried: true, includeOrganization });
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

// A browser sometimes leaves a file's type empty: the type is then taken from its extension.
const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", txt: "text/plain", csv: "text/csv",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export function fileType(file: { name: string; type?: string }): string {
  return file.type || FILE_TYPES[file.name.split(".").pop()?.toLowerCase() || ""] || "application/octet-stream";
}

/** A request whose body or answer is a file rather than JSON (a lead's documents). */
async function sendFile(method: string, path: string, file?: Blob, type?: string): Promise<Response> {
  const token = await auth.accessToken().catch(() => null);
  const org = organization();
  let response;
  try {
    response = await fetch(apiBase() + path, {
      method,
      headers: {
        ...(type ? { "Content-Type": type } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(token && org ? { "x-callerwhale-org": org } : {}),
      },
      body: file,
    });
  } catch {
    throw new ApiError(0, "offline", "The server cannot be reached");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(response.status, data?.error?.code || "error", data?.error?.message || "The server refused the request");
  }
  return response;
}

export const api = {
  /** A lead's documents: listed, uploaded (up to 10 MB, internal or shared with clients), downloaded and removed. */
  files: {
    list: (leadId: string): Promise<any> => request("GET", `/api/v1/leads/${encodeURIComponent(leadId)}/files`),
    upload: async (leadId: string, file: File, visibility: string): Promise<any> =>
      (await sendFile("POST", `/api/v1/leads/${encodeURIComponent(leadId)}/files?name=${encodeURIComponent(file.name)}&visibility=${encodeURIComponent(visibility)}`, file, fileType(file))).json(),
    download: async (id: string): Promise<Blob> => (await sendFile("GET", `/api/v1/files/${encodeURIComponent(id)}`)).blob(),
    remove: (id: string): Promise<any> => request("DELETE", `/api/v1/files/${encodeURIComponent(id)}`),
  },
  /** The learning copy of imported lists: whether it is on for this workspace, and the administrator's choice. */
  learningStatus: (): Promise<any> => request("GET", "/api/v1/learning"),
  learningOptOut: (): Promise<any> => request("POST", "/api/v1/learning/opt-out", {}),
  learningOptIn: (): Promise<any> => request("POST", "/api/v1/learning/opt-in", {}),
  me: (select = false) => request("GET", "/api/v1/me", undefined, { includeOrganization: select }),
  /** The person's invitation from Caller Whale (activated on the first visit with a confirmed email), credits and download. */
  account: () => request("GET", "/api/v1/account"),
  /**
   * Spends credits before a metered action; refused (402) when the month's are used up. `requestId` makes a retry
   * count once. People Caller Whale did not invite this way have no credit limit ({ limited: false }).
   */
  useCredits: (kind, credits, requestId, detail = "") => request("POST", "/api/v1/credits/use", { kind, credits, request_id: requestId, detail }),
  /** A new trial workspace for the signed-in person (one per person). */
  startTrial: (organizationName, timezone) => request("POST", "/api/v1/organizations/trial", { organization: organizationName || "", timezone: timezone || "" }),
  /** Whether a new account may open its own trial on this server, or must be given access by an owner or Caller Whale. */
  signupOpen: () => request("GET", "/api/v1/auth/service").then(data => data?.signup === true),
  directory: () => request("GET", "/api/v1/directory"),
  /** My account's picture, kept with my name so the rest of the team sees the same face. */
  setPicture: (avatar: string): Promise<any> => request("PUT", "/api/v1/me/picture", { avatar }, { includeOrganization: false }),
  teams: () => request("GET", "/api/v1/admin/teams"),
  // Giving leads to people (crm-core assign.go): who the viewer may give leads to, starting a run, and following it.
  assignTargets: (): Promise<any> => request("GET", "/api/v1/assignments/targets"),
  startAssignment: (body: unknown): Promise<any> => request("POST", "/api/v1/assignments", body),
  assignment: (id: string): Promise<any> => request("GET", `/api/v1/assignments/${encodeURIComponent(id)}`),
  memberStats: (from: string, to: string): Promise<any> => request("GET", `/api/v1/stats/members?from=${from}&to=${to}`),
  memberActivity: (user: string, before = 0): Promise<any> => request("GET", `/api/v1/stats/members/${encodeURIComponent(user)}/activity${before ? `?before=${before}` : ""}`),
  projects: () => request("GET", "/api/v1/projects"),
  deleteProject: (id: string): Promise<any> => request("DELETE", `/api/v1/projects/${id}`, undefined, { timeout: 120000 }),
  settings: () => request("GET", "/api/v1/settings"),
  // Not cut off at a minute: giving up and asking again made the server start the same heavy read over and over.
  /** The workspace's records; with `limit` a page of the leads, and `after` (the "next" of the page before) the page that follows. */
  snapshot: (page?: { limit?: number; after?: string }) => {
    const query = new URLSearchParams();
    if (page?.limit) query.set("limit", String(page.limit));
    if (page?.after) query.set("after", page.after);
    return request("GET", "/sync/snapshot" + (query.size ? "?" + query : ""), undefined, { timeout: 300000 });
  },
  /** One page of the workspace's leads (optionally of one stage, or matching a search), for the Leads list of a big workspace. */
  browseLeads: ({ term = "", stage = "", offset = 0, limit = 25, count = true, project = "", callable = false, email = false, sort = "" }: { term?: string; stage?: string; offset?: number; limit?: number; count?: boolean; project?: string; callable?: boolean; email?: boolean; sort?: string }): Promise<any> =>
    request("GET", `/api/v1/leads/search?q=${encodeURIComponent(term)}&stage=${encodeURIComponent(stage)}&offset=${offset}&limit=${limit}${count ? "" : "&count=0"}${project ? "&project=" + encodeURIComponent(project) : ""}${callable ? "&callable=1" : ""}${email ? "&email=1" : ""}${sort ? "&sort=" + encodeURIComponent(sort) : ""}`),
  /** Leads of a big workspace beyond the snapshot's window: by name, phone, email or address. */
  /** What hangs off one lead (tasks, notes, calls, handoffs, deals): asked for when a lead outside this device's window is opened. */
  leadDetails: (id: string): Promise<any> => request("GET", `/api/v1/leads/${encodeURIComponent(id)}/details`),
  searchLeads: (term: string): Promise<any> => request("GET", `/api/v1/leads/search?q=${encodeURIComponent(term)}&limit=100`),
  pull: (cursor, accessRevision) => request("GET", `/sync/pull?cursor=${cursor}&access_revision=${accessRevision}`),
  push: (operations, accessRevision) => request("POST", "/sync/push", { operations, access_revision: accessRevision }, { timeout: 60000 }),
  op: operation => request("POST", "/api/v1/ops", operation),
  rules: () => request("GET", "/api/v1/rules"),
  saveRule: (id, rule) => request("PUT", "/api/v1/rules/" + id, rule),
  /** List uploads (docs/plans/crm-core-and-imports.md). The pieces themselves go through remote/imports.ts. */
  imports: {
    start: (body): Promise<any> => request("POST", "/api/v1/imports", body),
    list: (kind = "lead_list"): Promise<any[]> => request("GET", `/api/v1/imports?kind=${encodeURIComponent(kind)}`),
    get: (id: string): Promise<any> => request("GET", `/api/v1/imports/${id}`),
    rows: (id: string, offset = 0): Promise<any> => request("GET", `/api/v1/imports/${id}/rows?offset=${offset}`),
    complete: (id: string): Promise<any> => request("POST", `/api/v1/imports/${id}/complete`),
    mapping: (id: string, body): Promise<any> => request("PUT", `/api/v1/imports/${id}/mapping`, body),
    duplicates: (id: string, offset = 0): Promise<any> => request("GET", `/api/v1/imports/${id}/duplicates?offset=${offset}`),
    decide: (id: string, body): Promise<any> => request("POST", `/api/v1/imports/${id}/duplicates`, body),
    merge: (id: string): Promise<any> => request("POST", `/api/v1/imports/${id}/merge`),
    preview: (id: string): Promise<any> => request("GET", `/api/v1/imports/${id}/preview`),
    cleared: (id: string, field: string, offset = 0): Promise<any> => request("GET", `/api/v1/imports/${id}/cleared?field=${encodeURIComponent(field)}&offset=${offset}`),
    columnsAgain: (id: string): Promise<any> => request("POST", `/api/v1/imports/${id}/columns-again`),
    merges: (id: string, offset = 0): Promise<any> => request("GET", `/api/v1/imports/${id}/merges?offset=${offset}`),
    undoMerge: (id: string, row: number): Promise<any> => request("POST", `/api/v1/imports/${id}/rows/${row}/undo-merge`),
    applyCalls: (id: string): Promise<any> => request("POST", `/api/v1/imports/${id}/apply-calls`),
    retry: (id: string): Promise<any> => request("POST", `/api/v1/imports/${id}/retry`),
    cancel: (id: string): Promise<any> => request("POST", `/api/v1/imports/${id}/cancel`),
    remove: (id: string): Promise<any> => request("DELETE", `/api/v1/imports/${id}`),
  },
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
  return ["callerwhale.v1", ...(token ? [`bearer.${token}`] : []), ...(org ? [`org.${org}`] : [])];
}

