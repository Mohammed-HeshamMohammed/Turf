// Signing in with Turf's auth service, for the website and the CRM (in a browser tab and in the desktop window).
// Plain JavaScript with no dependencies, so the same file serves both. This is the original; the copies in
// services/core-api/website/ and desktop/frontend/react/src/remote/ must stay identical (a test checks).
//
// The access token lives only in memory and is refreshed a minute before it expires. The refresh token is kept in
// the browser's storage so a reload stays signed in. Anything that can run script in the page could read it, so the
// pages that use this must not load scripts from other sites.

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const REFRESH_KEY = "turf.auth.refresh";
const EARLY_MS = 60_000;

export function createAuth({ base, storage = globalThis.localStorage, fetchImpl = (...args) => fetch(...args), now = () => Date.now(), onChange = () => {} }) {
  base = String(base || "").replace(/\/$/, "");
  let access = null;
  let refreshing = null;

  const readRefresh = () => {
    try {
      return storage?.getItem(REFRESH_KEY) || null;
    } catch {
      return null;
    }
  };
  const writeRefresh = value => {
    try {
      if (value) storage?.setItem(REFRESH_KEY, value);
      else storage?.removeItem(REFRESH_KEY);
    } catch {
      /* Not remembered on this device: signed in until the page closes. */
    }
  };

  async function call(method, path, body, token) {
    let response;
    try {
      response = await fetchImpl(base + path, {
        method,
        headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new AuthError(0, "offline", "The sign-in service cannot be reached. Check your connection.");
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) throw new AuthError(response.status, data?.code || "error", data?.error || "Sign-in was refused.");
    return data;
  }

  function keep(tokens) {
    access = { token: tokens.access_token, expiresAt: now() + tokens.expires_in * 1000 };
    if (tokens.refresh_token) writeRefresh(tokens.refresh_token);
    onChange();
    return tokens;
  }

  function forget() {
    const had = access || readRefresh();
    access = null;
    writeRefresh(null);
    if (had) onChange();
  }

  /** New tokens from the refresh token. Several callers at once share one request. */
  function refresh() {
    if (refreshing) return refreshing;
    const token = readRefresh();
    if (!token) return Promise.resolve(null);
    refreshing = call("POST", "/v1/sessions/refresh", { refresh_token: token })
      .then(keep, reason => {
        // The session ended (signed out elsewhere, or the token was copied): this device is signed out too.
        if (reason.status === 401) forget();
        throw reason;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  /** A current access token, refreshed when it is about to expire. Null when nobody is signed in. */
  async function accessToken() {
    if (access && access.expiresAt - EARLY_MS > now()) return access.token;
    if (!readRefresh()) return null;
    await refresh();
    return access?.token ?? null;
  }

  const withToken = async (method, path, body) => call(method, path, body, await accessToken());

  return {
    base,
    signedIn: () => Boolean(access || readRefresh()),
    accessToken,
    refresh,
    signUp: (name, email, password, kind = "browser") => call("POST", "/v1/accounts", { name, email, password, kind }).then(keep),
    /** With two-step sign-in on, the first try answers code "mfa_required"; try again with `code`. */
    signIn: (email, password, code, kind = "browser") => call("POST", "/v1/sessions", { email, password, ...(code ? { code } : {}), kind }).then(keep),
    /** Trades the one-time code a Google or Apple sign-in came back with. */
    exchange: code => call("POST", "/v1/oauth/exchange", { code }).then(keep),
    providers: () => call("GET", "/v1/providers"),
    /** Where to send the browser to sign in with a provider. `target` is website, app or desktop (with `port`). */
    startUrl: (provider, target, port) => `${base}/v1/oauth/${encodeURIComponent(provider)}/start?target=${target}${port ? `&port=${port}` : ""}`,
    me: () => withToken("GET", "/v1/me"),
    setupMfa: () => withToken("POST", "/v1/mfa/setup"),
    /** Turns two-step sign-in on; the session counts as confirmed, and the next token says so. */
    confirmMfa: async code => {
      const answer = await withToken("POST", "/v1/mfa/confirm", { code });
      await refresh();
      return answer;
    },
    /** Confirms a two-step code for this session (after a Google or Apple sign-in). */
    verifyMfa: async code => keep(await withToken("POST", "/v1/mfa/verify", { code })),
    verifyEmail: token => call("POST", "/v1/email/verify", { token }),
    /** A new confirmation link; then a fresh token says whether the email is confirmed. */
    resendEmail: () => withToken("POST", "/v1/email/resend"),
    signOut: async () => {
      const token = readRefresh();
      forget();
      if (token) await call("POST", "/v1/sessions/sign-out", { refresh_token: token }).catch(() => undefined);
    },
  };
}
