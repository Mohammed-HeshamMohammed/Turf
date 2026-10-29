import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

// Signing in on the site, and the person's account on Caller Whale's server (the core API). Firebase does the signing in; the
// server decides what the person may see: only people Caller Whale invited get a dashboard and the download, and only Caller Whale's
// staff get the admin pages. Nothing here is trusted by the server: every request carries the Firebase ID token and
// the server checks it.

/** Caller Whale's server. Set at build (VITE_TURF_API_URL); in development the core API on its own port. */
export const API = (import.meta.env?.VITE_TURF_API_URL || "http://localhost:8088").replace(/\/$/, "");
const HINT_KEY = "turf.auth.firebase";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let loading = null;
/** The Grafana login proxy's address, once the server has said (null: Grafana is not set up). */
export let grafanaUrl = null;

/** The sign-in client, made once: the server's Firebase web config, then the SDK (a separate, lazily loaded file). */
export function loadAuth() {
  loading ||= (async () => {
    let service;
    try {
      service = await fetch(`${API}/api/v1/auth/service`).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
    } catch {
      loading = null;
      throw new ApiError(0, "offline", "Caller Whale's server cannot be reached. Check your connection and try again.");
    }
    if (!service.firebase) {
      loading = null;
      throw new ApiError(503, "misconfigured", "Sign-in is not set up on Caller Whale's server yet.");
    }
    grafanaUrl = service.grafana || null;
    const { createFirebaseAuth, firebaseSdk } = await import("./auth/sdk.js");
    const sdk = firebaseSdk(service.firebase);
    const auth = createFirebaseAuth({ sdk, providers: service.firebase.providers || [] });
    auth.resetPassword = email => sdk.resetPassword(email);
    auth.providerList = service.firebase.providers || [];
    return auth;
  })();
  return loading;
}

const hinted = () => {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
};

/** A request to Caller Whale's server as the signed-in person. A refused token is refreshed once and tried again. */
export async function request(method, path, body) {
  const auth = await loadAuth();
  const once = async token => {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "offline", "Caller Whale's server cannot be reached. Check your connection and try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data?.error?.code || "error", data?.error?.message || "Something went wrong. Try again.");
    return data;
  };
  const token = await auth.accessToken();
  if (!token) throw new ApiError(401, "signed_out", "Sign in first.");
  try {
    return await once(token);
  } catch (reason) {
    if (reason.status !== 401 || reason.code === "mfa_required") throw reason;
    const fresh = await auth.refresh();
    if (!fresh) throw reason;
    return once(fresh);
  }
}

const SessionContext = createContext(null);

/**
 * status: "unknown" (before the page knows), "signed_out", "signed_in" (with `account`), or "error" (signed in, but
 * the server refused or could not be reached: `error`).
 */
export function SessionProvider({ children }) {
  const [state, setState] = useState({ status: "unknown", account: null, error: null });
  const live = useRef(true);

  const reload = useCallback(async () => {
    try {
      const account = await request("GET", "/api/v1/account");
      if (live.current) setState({ status: "signed_in", account, error: null });
      return account;
    } catch (error) {
      if (error.code === "signed_out") {
        if (live.current) setState({ status: "signed_out", account: null, error: null });
        return null;
      }
      if (live.current) setState({ status: "error", account: null, error });
      throw error;
    }
  }, []);

  const signOut = useCallback(async () => {
    const auth = await loadAuth().catch(() => null);
    await auth?.signOut();
    setState({ status: "signed_out", account: null, error: null });
  }, []);

  useEffect(() => {
    live.current = true;
    // Only someone who signed in on this device loads the SDK on every page.
    if (!hinted() && !/^\/(signin|signup|dashboard|admin)/.test(window.location.pathname)) setState(s => ({ ...s, status: "signed_out" }));
    else reload().catch(() => {});
    return () => {
      live.current = false;
    };
  }, [reload]);

  const value = useMemo(() => ({ ...state, reload, signOut }), [state, reload, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext) || { status: "unknown", account: null, error: null, reload: async () => null, signOut: async () => {} };

/** Where a signed-in person belongs: staff to the admin pages, everyone else to their dashboard. */
export const homeFor = account => (account?.staff ? "/admin" : "/dashboard");

/** Pages a sign-in may send a person back to (`?next=`): never another site, and the admin pages only for staff. */
export function destination(account) {
  const next = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("next") || "";
  if (next === "/dashboard" || (account?.staff && (next === "/admin" || /^\/admin\/grafana(\?|$)/.test(next)))) return next;
  return homeFor(account);
}
