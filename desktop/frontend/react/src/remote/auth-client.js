// Signing in with Caller Whale's auth service, for the website and the CRM (in a browser tab and in the desktop window).
// Plain JavaScript with no dependencies, so the same file serves both. This is the original; the copies in
// services/core-api/website/ and desktop/frontend/react/src/remote/ must stay identical (a test checks).
//
// The access token lives only in memory and is refreshed a minute before it expires. The refresh token is kept in
// the browser's storage so a reload stays signed in. Anything that can run script in the page could read it, so the
// pages that use this must not load scripts from other sites.

export class AuthError extends Error {
  constructor(status, code, message, data = null) {
    super(message);
    this.status = status;
    this.code = code;
    /** What else the server said: for "mfa_required", the `challenge` and the `methods` it may be answered with. */
    this.data = data;
  }
}

const REFRESH_KEY = "callerwhale.auth.refresh";
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
    if (!response.ok) throw new AuthError(response.status, data?.code || "error", data?.error || "Sign-in was refused.", data);
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
    /** Emails a password reset link. The answer is the same for any address. */
    forgotPassword: email => call("POST", "/v1/password/forgot", { email }),
    /** A new password with the code from the reset link; every session of that person ends. */
    resetPassword: (token, password) => call("POST", "/v1/password/reset", { token, new: password }),
    /** Trades the one-time code a Google or Apple sign-in came back with. */
    exchange: code => call("POST", "/v1/oauth/exchange", { code }).then(keep),
    providers: () => call("GET", "/v1/providers"),
    /** Where to send the browser to sign in with a provider. `target` is website, app, landing (the public site) or desktop (with `port`). */
    startUrl: (provider, target, port) => `${base}/v1/oauth/${encodeURIComponent(provider)}/start?target=${target}${port ? `&port=${port}` : ""}`,
    /** This page goes to the provider (through auth) and comes back with `?callerwhale_code=`; `finishProvider` trades it. */
    startProvider: async (provider, target) => {
      globalThis.location.href = `${base}/v1/oauth/${encodeURIComponent(provider)}/start?target=${target}`;
    },
    /** True when this page came back from a provider and is now signed in. Reads the code before anything awaits. */
    finishProvider: async () => {
      const query = new URLSearchParams(globalThis.location?.search || "");
      const code = query.get("callerwhale_code");
      const refused = query.get("oauth_error");
      if (!code && !refused) return false;
      globalThis.history?.replaceState(null, "", globalThis.location.pathname + globalThis.location.hash);
      if (!code) throw new AuthError(400, "oauth_error", refused);
      await call("POST", "/v1/oauth/exchange", { code }).then(keep);
      return true;
    },
    me: () => withToken("GET", "/v1/me"),
    // ---- the second step (docs/plans/second-factor.md) ----
    /**
     * After the password, a person who set up a second step gets `mfa_required` with `error.data = { challenge, methods }`
     * (methods: "totp", "email", "telegram", "push"). `sendCode` asks for an email or Telegram code, or an approval on a
     * device that is already signed in; `answer` finishes the sign-in with the code (or the approval) and keeps the tokens.
     */
    sendCode: (challenge, method, device) => call("POST", "/v1/mfa/challenge/send", { challenge, method, ...(device ? { device } : {}) }),
    answer: (challenge, method, code) => call("POST", "/v1/mfa/challenge/answer", { challenge, method, ...(code ? { code } : {}) }).then(keep),
    /** Where an approval request stands: "pending", "approved", "denied" or "expired". */
    approvalState: challenge => call("POST", "/v1/mfa/challenge/status", { challenge }).then(reply => reply.push),
    /** A step-up on this signed-in session (after Google, or for staff who set nothing up): a challenge and its methods. */
    startStepUp: () => withToken("POST", "/v1/mfa/challenge/start"),
    /** Requests waiting for this signed-in device to approve (it must have passed a second step itself). */
    approvals: () => withToken("GET", "/v1/mfa/approvals").then(reply => reply.approvals),
    decide: (id, approve) => withToken("POST", `/v1/mfa/approvals/${encodeURIComponent(id)}`, { approve }),
    /** What the person has set up, what could be set up, and how many authenticator devices may be on. */
    factors: () => withToken("GET", "/v1/mfa/factors"),
    removeFactor: id => withToken("DELETE", `/v1/mfa/factors/${encodeURIComponent(id)}`),
    setupMfa: () => withToken("POST", "/v1/mfa/totp/setup"),
    /** Adds an authenticator device; a fourth removes the oldest (`removed` names them). The session counts as confirmed. */
    confirmMfa: async (code, label) => {
      const answer = await withToken("POST", "/v1/mfa/totp/confirm", { code, ...(label ? { label } : {}) });
      await refresh();
      return answer;
    },
    /** A one-time link that opens the bot in Telegram and links that chat. */
    linkTelegram: () => withToken("POST", "/v1/mfa/telegram/link"),
    /** Confirms a code from an authenticator device for this session (the older step-up). */
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
