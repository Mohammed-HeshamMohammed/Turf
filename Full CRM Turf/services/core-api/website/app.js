// Turf's public website: plans, sign-up onto the trial, sign-in with MFA, email confirmation, the account (plan,
// minutes, seats, payments), checkout and team invitations. Everything is enforced by the API; this page only asks.
// User data is only ever written as text (never as HTML), and nothing runs inline, so the server's CSP holds.
//
// Signing in is the auth service's job (./auth-client.js, the same file the CRM uses): this page signs up, signs in
// and confirms email there, then brings its token to Turf's server, which keeps the workspace (organization, plan,
// team). Where auth is comes from the server, so one build works anywhere.

import { createAuth } from "./auth-client.js";

const main = document.getElementById("main");
const nav = document.getElementById("site-nav");
const CRM_URL = "http://localhost:5190/";
const ROLE_NAMES = {
  manager: "Team manager",
  caller: "Caller",
  closer: "Acquisitions / closer",
  researcher: "Data researcher",
  owner: "Business owner",
  solo: "Solo operator",
  client: "Client / partner",
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const service = await fetch("/api/v1/auth/service").then(r => r.json(), () => ({}));
/** Whether a new account may open its own trial here; otherwise only an invitation opens a workspace. */
const SIGNUP_OPEN = service.signup === true;
/** Said wherever a closed server would otherwise offer a trial. */
/** What a sign-in code can be: Firebase has no recovery codes, the auth service does. */
const CODE_HELP = service.firebase ? "From your authenticator app." : "From your authenticator app, or one of your recovery codes.";
const INVITE_ONLY = "Turf is by invitation only: your workspace owner, or Turf, sends you a link.";
// A server that uses Firebase hands its web config here; the bundle with Firebase's SDK is loaded only then.
const auth = service.firebase
  ? await import("./firebase-auth.js").then(m => m.createFirebaseAuth({ sdk: m.firebaseSdk(service.firebase), providers: service.firebase.providers || [] }))
  : createAuth({ base: service.url || "http://localhost:8101" });

/** The organization this browser works in; Turf's server reads it from x-turf-org. */
const organization = () => localStorage.getItem("turf.org") || "";
const setOrganization = id => (id ? localStorage.setItem("turf.org", id) : localStorage.removeItem("turf.org"));

async function api(path, body, retried = false, method = body === undefined ? "GET" : "POST") {
  const token = await auth.accessToken().catch(() => null);
  const org = organization();
  const response = await fetch("/api/v1" + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(token && org ? { "x-turf-org": org } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // A token that expired in flight: refresh once and try again.
  if (response.status === 401 && token && !retried && (await auth.refresh().catch(() => null))) return api(path, body, true, method);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data?.error?.code || "error", data?.error?.message || "Something went wrong");
  return data;
}

/** Builds an element. Strings become text nodes; attributes starting with "on" are listeners. */
function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (key === "class") element.className = value;
    else element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) element.append(child instanceof Node ? child : String(child));
  return element;
}

const money = cents => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0 });
const date = value => new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function show(...nodes) {
  main.replaceChildren(...nodes);
  main.focus({ preventScroll: true });
}

function notice(text, tone = "") {
  return h("div", { class: "notice " + tone, role: tone === "error" ? "alert" : "status" }, text);
}

/** A form whose submit runs `work`; errors show above the button and the button waits while it runs. */
function form(fields, label, work) {
  const status = h("div");
  const button = h("button", { class: "button primary", type: "submit" }, label);
  const element = h("form", {}, ...fields, status, button);
  element.addEventListener("submit", async event => {
    event.preventDefault();
    button.disabled = true;
    status.replaceChildren();
    try {
      await work(Object.fromEntries(new FormData(element)));
    } catch (reason) {
      status.replaceChildren(notice(reason.message, "error"));
    } finally {
      button.disabled = false;
    }
  });
  return element;
}

const input = (label, name, attributes = {}) => h("label", {}, label, h("input", { name, required: true, ...attributes }));

let me = null;
async function refreshMe() {
  me = auth.signedIn() ? await api("/me").catch(() => null) : null;
  // Open the organization this browser used last, or the person's first.
  if (me && me.organizations.length && !me.organizations.some(item => item.id === me.organization_id)) {
    const chosen = me.organizations.find(item => item.id === organization())?.id || me.organizations[0].id;
    setOrganization(chosen);
    me = await api("/me").catch(() => null);
  }
  nav.replaceChildren(
    ...(me
      ? [
          me.platform_role ? h("a", { class: "button", href: "#/admin" }, "Admin") : null,
          h("a", { class: "button", href: "#/account" }, "Account"),
          h("button", { class: "button", onclick: signOut }, "Sign out"),
        ].filter(Boolean)
      : [h("a", { class: "button" + (SIGNUP_OPEN ? "" : " primary"), href: "#/signin" }, "Sign in"), SIGNUP_OPEN ? h("a", { class: "button primary", href: "#/signup" }, "Start free trial") : null].filter(Boolean)),
  );
  return me;
}

async function signOut() {
  await auth.signOut();
  setOrganization("");
  await refreshMe();
  location.hash = "#/";
}

/** An invitation waiting for the person to sign up or sign in (including with Google, which leaves the page). */
const PENDING_JOIN = "turf.join";

/** After signing in: join a waiting invitation, or open the person's trial if they have no workspace yet. */
async function afterSignIn({ newAccount = false, organizationName = "" } = {}) {
  const invitation = sessionStorage.getItem(PENDING_JOIN);
  if (invitation) {
    sessionStorage.removeItem(PENDING_JOIN);
    const joined = await api("/invitations/join", { token: invitation });
    setOrganization(joined.organization_id);
  } else if (newAccount && SIGNUP_OPEN) {
    const opened = await api("/organizations/trial", { organization: organizationName, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    setOrganization(opened.organization_id);
  }
  await refreshMe();
  if (!me) return (location.hash = "#/signin");
  if (!me.organizations.length) return (location.hash = "#/workspace");
  location.hash = me.mfa.required && !me.mfa.passed ? "#/mfa" : "#/account";
}

// --- Google sign-in -----------------------------------------------------------------------------------------------

/** Sign-in marks. Google's and Apple's are their own logos in their own colours; Apple's and email's follow the text. */
const LOGOS = {
  apple: [["currentColor", "M16.4 12.6c0-2.5 2.1-3.7 2.2-3.8-1.2-1.7-3-2-3.7-2-1.6-.2-3.1.9-3.9.9s-2-.9-3.4-.9c-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.4.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.7-4.2zM13.9 5.1c.7-.9 1.2-2 1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.4-.6 3.1-1.5z"]],
  email: [["currentColor", "M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2.4V17h16V7.4l-7.5 5.2a1 1 0 0 1-1 0L4 7.4zM5.8 7l6.2 4.3L18.2 7H5.8z"]],
  google: [
    ["#4285F4", "M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z"],
    ["#34A853", "M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z"],
    ["#FBBC05", "M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z"],
    ["#EA4335", "M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.8 3.6-4.9 6.7-4.9z"],
  ],
};

function logo(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("aria-hidden", "true");
  for (const [fill, d] of LOGOS[name]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", fill);
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** How someone signs in ("password", "google", "apple"), as its mark with the words for screen readers and on hover. */
const SIGN_IN_NAMES = { password: "email and password", google: "Google", apple: "Apple" };
function signInMark(method) {
  if (!method) return null;
  const label = "Signs in with " + (SIGN_IN_NAMES[method] || method);
  const mark = logo(method === "password" ? "email" : LOGOS[method] ? method : "email");
  mark.setAttribute("width", "16");
  mark.setAttribute("height", "16");
  return h("span", { class: "sign-in-mark", title: label, role: "img", "aria-label": label }, mark);
}

/** A person's name with how they sign in. */
const named = (name, method) => h("span", { class: "named" }, signInMark(method), name);

/** "Continue with Google" for the sign-up and sign-in pages. A provider not set up on the server says so. */
function providerButtons() {
  const status = h("div");
  const known = auth.providers().catch(() => ({}));
  const button = (name, text) =>
    h(
      "button",
      {
        type: "button",
        class: "button provider " + name,
        onclick: async () => {
          if ((await known)[name]) return auth.startProvider(name, "website").catch(reason => status.replaceChildren(notice(reason.message, "error")));
          status.replaceChildren(notice(`${text.replace("Continue with ", "")} sign-in isn't connected on this server yet. Use your email for now.`));
        },
      },
      logo(name),
      text,
    );
  const error = new URLSearchParams(location.search).get("oauth_error");
  if (error) history.replaceState(null, "", location.pathname + location.hash);
  return h(
    "div",
    { class: "stack providers" },
    error ? notice(error, "error") : null,
    button("google", "Continue with Google"),
    status,
    h("div", { class: "or", role: "separator" }, h("span", {}, "or with your email")),
  );
}

// --- Pages ---------------------------------------------------------------------------------------------------------

async function home() {
  const plans = await api("/plans").catch(() => []);
  const describe = {
    trial: ["Try the CRM and the dialer", "One person", "Skip Tracing on your own lists"],
    solo: ["For one operator", "Every CRM workflow", "Skip Tracing, calls, deals and tasks", "No team invitations"],
    business: ["For teams", "Invite agents, managers and researchers", "Roles decide what each person sees and does", "Minutes pooled across the team"],
  };
  show(
    h("h1", {}, "The CRM and dialer for property outreach."),
    h("p", { class: "lead" }, "Import your lists, check every number with Turf's Skip Tracing, call owners, hand qualified sellers to your closers, and track every deal."),
    SIGNUP_OPEN
      ? h("div", { class: "row" }, h("a", { class: "button primary", href: "#/signup" }, "Start the free trial"), h("a", { class: "button", href: "#/signin" }, "Sign in"))
      : h("div", { class: "stack" }, h("p", { class: "muted" }, INVITE_ONLY), h("div", { class: "row" }, h("a", { class: "button primary", href: "#/signin" }, "Sign in"))),
    h(
      "div",
      { class: "grid", "aria-label": "Plans" },
      plans.map(plan =>
        h(
          "section",
          { class: "card" },
          h("h2", {}, plan.name),
          h(
            "div",
            { class: "price" },
            plan.price_cents ? money(plan.price_cents) : "Free",
            h("small", {}, plan.price_cents ? (plan.per_seat ? " per seat / month" : " / month") : ` for ${plan.period_days} days`),
          ),
          h("p", { class: "muted" }, `${plan.included_minutes.toLocaleString()} calling minutes${plan.per_seat ? " per seat" : ""}${plan.price_cents ? " each month" : ""}`),
          h("ul", { class: "ticks" }, (describe[plan.key] || []).map(item => h("li", {}, item))),
          SIGNUP_OPEN ? h("a", { class: "button" + (plan.key === "trial" ? " primary" : ""), href: "#/signup" }, plan.key === "trial" ? "Start free" : "Start with the trial") : null,
        ),
      ),
    ),
  );
}

function signup() {
  if (!SIGNUP_OPEN) {
    return show(
      h(
        "section",
        { class: "card narrow" },
        h("h2", {}, "You need an invitation"),
        h("p", {}, INVITE_ONLY + " Open it to create your account."),
        h("p", { class: "muted" }, "Already have an account? ", h("a", { href: "#/signin" }, "Sign in"), "."),
      ),
    );
  }
  show(
    h(
      "section",
      { class: "card narrow" },
      h("h2", {}, "Start your free trial"),
      h("p", { class: "muted" }, "10 calling minutes over 7 days. No card needed."),
      providerButtons(),
      form(
        [
          input("Your name", "display_name", { autocomplete: "name", maxlength: 120 }),
          input("Work email", "email", { type: "email", autocomplete: "email" }),
          h("label", {}, "Business name (optional)", h("input", { name: "organization", maxlength: 200, autocomplete: "organization" })),
          input("Password", "password", { type: "password", autocomplete: "new-password", minlength: 12 }),
          h("p", { class: "muted" }, "At least 12 characters. Owners also set up a sign-in code app next."),
        ],
        "Create account",
        async values => {
          const answer = await auth.signUp(values.display_name, values.email, values.password);
          sessionStorage.setItem("turf.verify", answer.verification_token || "");
          await afterSignIn({ newAccount: true, organizationName: values.organization });
        },
      ),
    ),
  );
}

function signin() {
  show(
    h(
      "section",
      { class: "card narrow" },
      h("h2", {}, "Sign in"),
      providerButtons(),
      form(
        [input("Email", "email", { type: "email", autocomplete: "email" }), input("Password", "password", { type: "password", autocomplete: "current-password" })],
        "Sign in",
        async values => {
          try {
            await auth.signIn(values.email, values.password);
          } catch (reason) {
            if (reason.code === "mfa_required") return signinCode(values);
            throw reason;
          }
          await afterSignIn();
        },
      ),
      SIGNUP_OPEN ? h("p", { class: "muted" }, "New here? ", h("a", { href: "#/signup" }, "Start a free trial"), ".") : h("p", { class: "muted" }, "New here? " + INVITE_ONLY),
    ),
  );
}

/** Two-step sign-in is on: the same sign-in again with the code. The password stays only in this closure. */
function signinCode(values) {
  show(
    h(
      "section",
      { class: "card narrow" },
      h("h2", {}, "Enter your sign-in code"),
      h("p", { class: "muted" }, CODE_HELP),
      form([input("Code", "code", { autocomplete: "one-time-code", maxlength: 12 })], "Sign in", async more => {
        await auth.signIn(values.email, values.password, more.code.trim());
        await afterSignIn();
      }),
    ),
  );
}

/** Owners and administrators confirm a code from an authenticator app: set one up the first time, then verify. */
async function mfa() {
  if (!(await refreshMe())) return (location.hash = "#/signin");
  if (!me.mfa.required || me.mfa.passed) return (location.hash = "#/account");
  if ((await auth.me()).mfa_enrolled) {
    return show(
      h(
        "section",
        { class: "card narrow" },
        h("h2", {}, "Enter your sign-in code"),
        form([input("6-digit code", "code", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 8 })], "Continue", async values => {
          await auth.verifyMfa(values.code.trim());
          location.hash = "#/account";
        }),
      ),
    );
  }
  const setup = await auth.setupMfa();
  show(
    h(
      "section",
      { class: "card narrow" },
      h("h2", {}, "Protect your account"),
      h("p", {}, "Add Turf to an authenticator app (Google Authenticator, 1Password, Authy) with this key, then enter the code it shows."),
      h("span", { class: "code", "aria-label": "Setup key" }, setup.secret),
      h("p", { class: "muted" }, "Or open this link on your phone: ", h("a", { href: setup.otpauth_url }, "add to authenticator")),
      form([input("6-digit code", "code", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 8 })], "Confirm", async values => {
        const { recovery_codes } = await auth.confirmMfa(values.code.trim());
        // Firebase gives no recovery codes: staff reset a lost authenticator.
        if (!recovery_codes?.length) return (location.hash = "#/account");
        show(
          h(
            "section",
            { class: "card narrow" },
            h("h2", {}, "Keep these recovery codes"),
            h("p", {}, "Each one signs you in once if you lose your phone. They are shown only now."),
            h("div", { class: "codes" }, recovery_codes.map(code => h("span", { class: "code" }, code))),
            h("div", { class: "row" }, h("a", { class: "button primary", href: "#/account" }, "I saved them")),
          ),
        );
      }),
    ),
  );
}

async function verifyEmail(token) {
  try {
    await auth.verifyEmail(token);
    sessionStorage.removeItem("turf.verify");
    // The next token says the email is confirmed, and Turf's server records it.
    if (auth.signedIn()) await auth.refresh().catch(() => null);
    show(h("section", { class: "card narrow" }, h("h2", {}, "Email confirmed"), h("a", { class: "button primary", href: "#/account" }, "Go to your account")));
  } catch (reason) {
    show(h("section", { class: "card narrow" }, notice(reason.message, "error"), h("a", { class: "button", href: "#/account" }, "Back to your account")));
  }
}

async function joinTeam(token) {
  sessionStorage.setItem(PENDING_JOIN, token);
  if (await refreshMe()) {
    return show(
      h(
        "section",
        { class: "card narrow" },
        h("h2", {}, "Join your team on Turf"),
        h("p", {}, "You're signed in as " + me.user.email + ". The invitation must be for this address."),
        form([], "Join the team", async () => afterSignIn()),
        h("p", { class: "muted" }, "Not you? ", h("button", { class: "text", onclick: signOut }, "Sign out"), " and open the link again."),
      ),
    );
  }
  show(
    h(
      "section",
      { class: "card narrow" },
      h("h2", {}, "Join your team on Turf"),
      h("p", { class: "muted" }, "Use the email address the invitation was sent to."),
      providerButtons(),
      form(
        [
          input("Your name", "display_name", { autocomplete: "name", maxlength: 120 }),
          input("Email", "email", { type: "email", autocomplete: "email" }),
          input("Password", "password", { type: "password", autocomplete: "new-password", minlength: 12 }),
        ],
        "Create account and join",
        async values => {
          const answer = await auth.signUp(values.display_name, values.email, values.password);
          sessionStorage.setItem("turf.verify", answer.verification_token || "");
          await afterSignIn();
        },
      ),
      h("p", { class: "muted" }, "Already have a Turf account? ", h("a", { href: "#/signin" }, "Sign in"), " and the invitation is accepted after."),
    ),
  );
}

/** Signed in, with no workspace yet (for example after Google sign-up): start the free trial here. */
async function workspace() {
  if (!(await refreshMe())) return (location.hash = "#/signin");
  if (me.organizations.length) return (location.hash = "#/account");
  if (!SIGNUP_OPEN) {
    return show(
      h(
        "section",
        { class: "card narrow" },
        h("h2", {}, "You need an invitation"),
        h("p", {}, "Turf is by invitation only. Your workspace owner, or Turf, sends you a link; open it while signed in as " + me.user.email + "."),
        me.platform_role ? h("p", {}, h("a", { href: "#/admin" }, "Open the admin dashboard")) : null,
      ),
    );
  }
  show(
    h(
      "section",
      { class: "card narrow" },
      h("h2", {}, "Start your free trial"),
      h("p", { class: "muted" }, "10 calling minutes over 7 days. No card needed."),
      form([h("label", {}, "Business name (optional)", h("input", { name: "organization", maxlength: 200, autocomplete: "organization" }))], "Start the trial", async values =>
        afterSignIn({ newAccount: true, organizationName: values.organization }),
      ),
      h("p", { class: "muted" }, "Invited by a team? Open the link from your invitation email instead."),
    ),
  );
}

async function account() {
  if (!(await refreshMe())) return (location.hash = "#/signin");
  if (!me.organizations.length) return (location.hash = "#/workspace");
  if (me.mfa.required && !me.mfa.passed) return (location.hash = "#/mfa");
  const billing = await api("/billing");
  const org = me.organizations.find(item => item.id === me.organization_id);
  const admin = me.capabilities.includes("admin");
  const sections = [h("h1", {}, org?.name || "Your account"), h("p", { class: "muted named" }, signInMark(me.user.sign_in), me.user.name + " · " + me.user.email)];

  if (admin && !billing.email_verified) {
    const devToken = sessionStorage.getItem("turf.verify");
    sections.push(
      h(
        "div",
        { class: "notice" },
        "Confirm your email address to choose a paid plan. ",
        devToken
          ? h("button", { class: "button", onclick: () => verifyEmail(devToken) }, "Confirm now (development)")
          : h(
              "button",
              {
                class: "button",
                onclick: async event => {
                  const answer = await auth.resendEmail().catch(reason => ({ error: reason.message }));
                  if (answer.verification_token) sessionStorage.setItem("turf.verify", answer.verification_token);
                  event.target.replaceWith(answer.error || "Email sent.");
                  if (answer.verification_token) account();
                },
              },
              "Send the email again",
            ),
      ),
    );
  }
  if (!billing.limited) {
    sections.push(h("section", { class: "card" }, h("h2", {}, "Self-hosted workspace"), h("p", {}, "This organization has no plan limits.")));
    return show(...sections, crmLink());
  }
  const used = billing.minutes_used;
  const share = billing.minutes_included ? Math.min(100, Math.round((used / billing.minutes_included) * 100)) : 100;
  const tone = billing.usable ? (billing.status === "trialing" ? "peach" : "good") : "danger";
  sections.push(
    h(
      "section",
      { class: "card" },
      h("div", { class: "row" }, h("h2", {}, billing.plan.name), h("span", { class: "badge " + tone }, billing.usable ? billing.status : "needs attention")),
      billing.reason ? notice(billing.reason, "error") : h("p", { class: "muted" }, (billing.status === "trialing" ? "Trial ends " : "Renews ") + date(billing.period_end)),
      h(
        "div",
        { class: "stats" },
        h("div", { class: "stat" }, h("strong", {}, billing.minutes_left.toLocaleString()), h("small", {}, "minutes left")),
        h("div", { class: "stat" }, h("strong", {}, used.toLocaleString()), h("small", {}, "minutes used this period")),
        h("div", { class: "stat" }, h("strong", {}, `${billing.seats_taken} / ${billing.seats}`), h("small", {}, "seats taken")),
      ),
      h("div", { class: "meter", role: "meter", "aria-valuenow": share, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": "Minutes used" }, h("span", { style: undefined })),
    ),
  );
  sections.at(-1).querySelector(".meter > span").style.width = share + "%";
  if (admin) sections.push(await upgrade(billing));
  if (admin && billing.plan.can_invite) sections.push(await team(billing));
  if (admin && billing.payments.length)
    sections.push(
      h(
        "section",
        { class: "card" },
        h("h2", {}, "Payments"),
        h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            {},
            h("thead", {}, h("tr", {}, h("th", {}, "Date"), h("th", {}, "Plan"), h("th", {}, "Seats"), h("th", {}, "Amount"), h("th", {}, "Status"))),
            h(
              "tbody",
              {},
              billing.payments.map(payment =>
                h(
                  "tr",
                  {},
                  h("td", {}, date(payment.created_at)),
                  h("td", {}, payment.plan),
                  h("td", {}, String(payment.seats)),
                  h("td", {}, money(payment.amount_cents)),
                  h("td", {}, h("span", { class: "badge " + (payment.status === "paid" ? "good" : payment.status === "failed" ? "danger" : "") }, payment.status)),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  show(...sections, crmLink());
}

function crmLink() {
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "Open Turf"),
    h("p", { class: "muted" }, "Use the Turf CRM in the desktop app, or in your browser. Sign in there with this account."),
    h("a", { class: "button primary", href: CRM_URL }, "Open the CRM"),
  );
}

async function upgrade(billing) {
  const plans = (await api("/plans")).filter(plan => plan.key !== "trial");
  const result = h("div");
  const seats = h("input", { type: "number", name: "seats", min: 2, max: 500, value: Math.max(2, billing.seats_taken), "aria-label": "Business seats" });
  async function buy(plan, count) {
    result.replaceChildren();
    try {
      const checkout = await api("/billing/checkout", { plan, seats: count });
      if (checkout.checkout_url) return (location.href = checkout.checkout_url);
      result.replaceChildren(
        notice(`Checkout started: ${money(checkout.amount_cents)} for ${plan}. No payment provider is connected to this server.`),
        h("p", { class: "muted" }, "In development, confirm the payment as the provider would:"),
        h("span", { class: "code" }, `python services/core-api/scripts/dev_pay.py ${checkout.payment_id} ${checkout.amount_cents}`),
        h("div", { class: "row" }, h("button", { class: "button", onclick: account }, "I paid, refresh")),
      );
    } catch (reason) {
      result.replaceChildren(notice(reason.message, "error"));
    }
  }
  const solo = plans.find(plan => plan.key === "solo");
  const business = plans.find(plan => plan.key === "business");
  return h(
    "section",
    { class: "card" },
    h("h2", {}, billing.plan.key === "trial" ? "Choose a plan" : "Change plan"),
    h(
      "div",
      { class: "grid" },
      solo &&
        h(
          "div",
          {},
          h("h3", {}, solo.name),
          h("p", { class: "muted" }, `${money(solo.price_cents)} / month · ${solo.included_minutes.toLocaleString()} minutes · just you`),
          h("button", { class: "button primary", disabled: !billing.email_verified || billing.seats_taken > 1, onclick: () => buy("solo", 1) }, "Choose Solo"),
        ),
      business &&
        h(
          "div",
          {},
          h("h3", {}, business.name),
          h("p", { class: "muted" }, `${money(business.price_cents)} per seat / month · ${business.included_minutes.toLocaleString()} minutes per seat`),
          h("div", { class: "row" }, h("label", {}, "Seats", seats), h("button", { class: "button primary", disabled: !billing.email_verified, onclick: () => buy("business", Number(seats.value)) }, "Choose Business")),
        ),
    ),
    result,
  );
}

async function team(billing) {
  const [{ members, invitations }, roles] = await Promise.all([api("/admin/members"), api("/admin/roles").catch(() => [])]);
  const choices = (roles.length ? roles.map(role => role.key) : Object.keys(ROLE_NAMES)).filter(key => !["owner", "solo"].includes(key));
  const result = h("div");
  const invite = form(
    [
      input("Email", "email", { type: "email" }),
      h("label", {}, "Role", h("select", { name: "role" }, choices.map(key => h("option", { value: key }, ROLE_NAMES[key] || key)))),
      h("label", {}, "Access lasts (days, optional)", h("input", { name: "days", type: "number", min: 1, max: 3650, placeholder: "No end date" })),
    ],
    "Send invitation",
    async values => {
      const answer = await api("/admin/members", { email: values.email, roles: [values.role], ...(values.days ? { access_days: Number(values.days) } : {}) });
      const link = location.origin + "/#/join?token=" + encodeURIComponent(answer.token);
      result.replaceChildren(notice("Invitation ready. Send this link to them; it works once, for 7 days.", "good"), h("span", { class: "code" }, link));
    },
  );
  return h(
    "section",
    { class: "card stack" },
    h("h2", {}, "Team"),
    h("p", { class: "muted" }, `${billing.seats_taken} of ${billing.seats} seats taken. Each role decides what that person can see and do.`),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Email"), h("th", {}, "Role"), h("th", {}, "Access"), h("th", {}, ""))),
        h(
          "tbody",
          {},
          members.map(member => {
            const owner = member.roles.includes("owner") || member.roles.includes("solo");
            const change = days => async () => {
              await api(`/admin/members/${member.user_id}`, { access_days: days }, false, "PATCH");
              await account();
            };
            return h(
              "tr",
              {},
              h("td", {}, named(member.name, member.sign_in)),
              h("td", {}, member.email),
              h("td", {}, member.roles.map(key => ROLE_NAMES[key] || key).join(", ")),
              h("td", {}, member.expired ? h("span", { class: "badge danger" }, "ended " + date(member.expires_at)) : member.expires_at ? "until " + date(member.expires_at) : "no end date"),
              h("td", {}, owner ? null : h("div", { class: "row" }, small("+30 days", change(30)), member.expires_at ? small("No end", change(0)) : null)),
            );
          }),
          invitations.map(item =>
            h("tr", {}, h("td", { class: "muted" }, "Invited"), h("td", {}, item.email), h("td", {}, item.roles.map(key => ROLE_NAMES[key] || key).join(", ")), h("td", {}, item.access_days ? item.access_days + " days once they join" : "no end date"), h("td", {})),
          ),
        ),
      ),
    ),
    billing.can_invite ? invite : notice("All seats are taken. Add seats above to invite someone else."),
    result,
  );
}

// --- Admin dashboard ---------------------------------------------------------------------------------------------------
//
// For Turf's own people only: the platform owner (the owner of the app) and the system administrators the owner names.
// Nobody gets there by signing up or by an invitation; the API checks every action again, so this page only asks.

const ADMIN_TABS = [
  ["overview", "Overview"],
  ["workspaces", "Workspaces"],
  ["payments", "Payments"],
  ["people", "People"],
  ["staff", "Staff"],
  ["activity", "Activity"],
  ["mine", "My workspace"],
];

const ACTION_NAMES = {
  "workspace.suspended": "suspended a workspace",
  "workspace.reactivated": "reactivated a workspace",
  "workspace.plan_changed": "changed a plan",
  "workspace.created": "opened a staff workspace",
  "person.disabled": "turned off access for",
  "person.enabled": "turned on access for",
  "staff.added": "named a system administrator:",
  "staff.removed": "removed a system administrator:",
};

const small = (label, onclick, tone = "") => h("button", { class: "button small " + tone, type: "button", onclick }, label);

/** Runs a dashboard action, then shows the tab again with what changed. */
async function act(work, tab, done) {
  try {
    await work();
    await admin(tab, done);
  } catch (reason) {
    await admin(tab, null, reason.message);
  }
}

function planStatus(item) {
  if (item.suspended) return h("span", { class: "badge danger" }, "suspended");
  if (!item.status) return h("span", { class: "badge" }, "no limits");
  return h("span", { class: "badge " + (item.status === "active" ? "good" : item.status === "trialing" ? "peach" : "danger") }, item.status);
}

function activityList(events) {
  if (!events.length) return h("p", { class: "muted" }, "Nothing yet.");
  return h(
    "ul",
    { class: "activity" },
    events.map(event =>
      h(
        "li",
        {},
        h("strong", {}, event.actor),
        " ",
        ACTION_NAMES[event.action] || event.action,
        " ",
        event.target ? h("strong", {}, event.target) : null,
        event.detail?.action ? ` (${[event.detail.action, event.detail.plan, event.detail.seats && event.detail.seats + " seats", event.detail.days && event.detail.days + " days"].filter(Boolean).join(", ")})` : null,
        event.detail?.reason ? ` (${event.detail.reason})` : null,
        h("small", { class: "muted" }, " · " + new Date(event.at).toLocaleString()),
      ),
    ),
  );
}

async function adminOverview() {
  const [{ totals, organizations }, { events }] = await Promise.all([api("/platform/organizations"), api("/platform/activity")]);
  const stat = (value, label) => h("div", { class: "stat card" }, h("strong", {}, String(value)), h("small", {}, label));
  return [
    h(
      "div",
      { class: "stats" },
      stat(totals.organizations, "workspaces"),
      stat(totals.paying, "paying"),
      stat(totals.trials, "on the trial"),
      stat(totals.suspended, "suspended"),
      stat(totals.people, "people"),
      stat(money(totals.paid_cents), "paid in total"),
    ),
    h(
      "section",
      { class: "card stack" },
      h("h2", {}, "Newest workspaces"),
      h("ul", { class: "activity" }, organizations.slice(0, 5).map(item => h("li", {}, h("strong", {}, item.name), " ", item.owner_email || "", " ", planStatus(item), h("small", { class: "muted" }, " · " + date(item.created_at))))),
    ),
    h("section", { class: "card stack" }, h("h2", {}, "Latest staff activity"), activityList(events.slice(0, 8))),
  ];
}

function planForm(item) {
  return form(
    [
      h("label", {}, "Plan", h("select", { name: "plan" }, ["trial", "solo", "business"].map(key => h("option", { value: key, selected: key === (item.plan || "business") }, key)))),
      input("Seats", "seats", { type: "number", min: 1, max: 500, value: item.seats || 2 }),
      input("Days", "days", { type: "number", min: 1, max: 3650, value: 30 }),
    ],
    "Set plan",
    values =>
      act(
        () => api(`/platform/organizations/${item.id}/subscription`, { action: "set", plan: values.plan, seats: Number(values.seats), days: Number(values.days) }),
        "workspaces",
        `${item.name} is on ${values.plan} now.`,
      ),
  );
}

async function adminWorkspaces(you) {
  const { organizations } = await api("/platform/organizations");
  const search = h("input", { type: "search", placeholder: "Filter by name or owner", class: "filter" });
  const rows = organizations.map(item => {
    const actions = h(
      "div",
      { class: "row" },
      item.suspended
        ? small("Reactivate", () => act(() => api(`/platform/organizations/${item.id}/suspend`, { suspended: false }), "workspaces", `${item.name} is open again.`))
        : small(
            "Suspend",
            () => {
              const reason = prompt(`Suspend ${item.name}? Its people lose access at once. Reason (kept in the activity log):`);
              if (reason !== null) act(() => api(`/platform/organizations/${item.id}/suspend`, { suspended: true, reason }), "workspaces", `${item.name} is suspended.`);
            },
            "danger",
          ),
      item.plan ? small("+7 days", () => act(() => api(`/platform/organizations/${item.id}/subscription`, { action: "extend", days: 7 }), "workspaces", `${item.name}: 7 more days.`)) : null,
      item.plan ? small("+30 days", () => act(() => api(`/platform/organizations/${item.id}/subscription`, { action: "extend", days: 30 }), "workspaces", `${item.name}: 30 more days.`)) : null,
      you === "owner" && item.plan
        ? small("No limits", () => confirm(`Take ${item.name} off its plan? It will have no seat, minute or time limits.`) && act(() => api(`/platform/organizations/${item.id}/subscription`, { action: "unlimited" }), "workspaces", `${item.name} has no limits now.`))
        : null,
      you === "owner" ? h("details", {}, h("summary", { class: "button small" }, "Set plan"), planForm(item)) : null,
    );
    const row = h(
      "tr",
      {},
      h("td", {}, item.name),
      h("td", {}, item.owner_email || "—"),
      h("td", {}, item.plan || "—"),
      h("td", {}, planStatus(item)),
      h("td", {}, item.minutes_included === null ? "—" : `${item.minutes_used.toLocaleString()} / ${item.minutes_included.toLocaleString()}`),
      h("td", {}, item.seats === null ? "—" : String(item.seats)),
      h("td", {}, String(item.members)),
      h("td", {}, item.period_end ? date(item.period_end) : "—"),
      h("td", {}, money(item.paid_cents)),
      h("td", {}, actions),
    );
    row.dataset.text = `${item.name} ${item.owner_email || ""}`.toLowerCase();
    return row;
  });
  search.addEventListener("input", () => rows.forEach(row => (row.hidden = !row.dataset.text.includes(search.value.trim().toLowerCase()))));
  // Nobody opens a workspace by signing up: staff open it here and send its owner the link.
  const opened = h("div");
  const open = h(
    "section",
    { class: "card" },
    h("h2", {}, "Open a workspace for a customer"),
    form([input("Workspace name", "organization", { maxlength: 200 }), input("Owner's email", "email", { type: "email" })], "Open workspace", async values => {
      const answer = await api("/platform/customers", { organization: values.organization, email: values.email });
      const link = location.origin + "/#/join?token=" + encodeURIComponent(answer.token);
      opened.replaceChildren(notice(`Ready. Send this link to ${values.email}; it makes them the owner, works once, for 7 days.`, "good"), h("span", { class: "code" }, link));
    }),
    opened,
  );
  return [
    h("p", { class: "muted" }, "Every customer workspace. Their CRM records are never shown here."),
    open,
    search,
    h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["Workspace", "Owner", "Plan", "Status", "Minutes", "Seats", "Members", "Period ends", "Paid", ""].map(title => h("th", {}, title)))),
          h("tbody", {}, rows),
        ),
      ),
    ),
  ];
}

async function adminPeople(you, query = "") {
  const { people } = await api("/platform/people?q=" + encodeURIComponent(query));
  const finder = form([input("Email or name", "q", { type: "search", value: query, required: false })], "Search", async values => {
    const nodes = await adminPeople(you, values.q || "");
    show(...adminFrame("people", you, nodes));
  });
  const canChange = person => person.platform_role !== "owner" && person.id !== me.user.id && (!person.platform_role || you === "owner");
  return [
    finder,
    h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["Name", "Email", "Workspaces", "Turf role", "Access", ""].map(title => h("th", {}, title)))),
          h(
            "tbody",
            {},
            people.map(person =>
              h(
                "tr",
                {},
                h("td", {}, named(person.name, person.sign_in)),
                h("td", {}, person.email),
                h("td", {}, person.workspaces.map(w => `${w.name} (${w.roles.map(key => ROLE_NAMES[key] || key).join(", ")})`).join("; ") || "—"),
                h("td", {}, person.platform_role === "owner" ? h("span", { class: "badge peach" }, "Platform owner") : person.platform_role ? h("span", { class: "badge good" }, "System administrator") : "—"),
                h("td", {}, person.disabled ? h("span", { class: "badge danger" }, "off") : "on"),
                h(
                  "td",
                  {},
                  canChange(person)
                    ? person.disabled
                      ? small("Turn on", () => act(() => api(`/platform/people/${person.id}/access`, { disabled: false }), "people", `${person.email} can use Turf again.`))
                      : small("Turn off", () => confirm(`Turn off ${person.email}'s access to Turf?`) && act(() => api(`/platform/people/${person.id}/access`, { disabled: true }), "people", `${person.email} can no longer use Turf.`), "danger")
                    : null,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ];
}

async function adminPayments() {
  const { payments, totals } = await api("/platform/payments");
  const stat = (cents, label) => h("div", { class: "stat card" }, h("strong", {}, money(cents)), h("small", {}, label));
  const tone = { paid: "good", pending: "peach", failed: "danger", refunded: "" };
  return [
    h("div", { class: "stats" }, stat(totals.paid_cents, "paid"), stat(totals.pending_cents, "waiting"), stat(totals.failed_cents, "failed"), stat(totals.refunded_cents, "refunded")),
    h(
      "section",
      { class: "card" },
      payments.length
        ? h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              {},
              h("thead", {}, h("tr", {}, ["Date", "Workspace", "Paid by", "Plan", "Seats", "Amount", "Status", "Provider"].map(title => h("th", {}, title)))),
              h(
                "tbody",
                {},
                payments.map(item =>
                  h(
                    "tr",
                    {},
                    h("td", {}, date(item.paid_at || item.created_at)),
                    h("td", {}, item.organization),
                    h("td", {}, item.payer_email || "—"),
                    h("td", {}, item.plan),
                    h("td", {}, String(item.seats)),
                    h("td", {}, money(item.amount_cents)),
                    h("td", {}, h("span", { class: "badge " + (tone[item.status] || "") }, item.status)),
                    h("td", {}, item.provider),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted" }, "No payments yet. Card details never reach Turf: only the provider's reference and the amount."),
    ),
  ];
}

async function adminStaff(you) {
  const { staff } = await api("/platform/staff");
  const add =
    you === "owner"
      ? h(
          "section",
          { class: "card stack" },
          h("h2", {}, "Name a system administrator"),
          h("p", { class: "muted" }, "They must have signed in to Turf once. System administrators see every workspace and can suspend, extend and turn access off, but cannot name staff, set plans or touch your account."),
          form([input("Email", "email", { type: "email" })], "Make system administrator", values =>
            act(() => api("/platform/staff", { email: values.email, role: "admin" }), "staff", `${values.email} is a system administrator now.`),
          ),
        )
      : notice("Only the platform owner names or removes system administrators.");
  return [
    h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["Name", "Email", "Role", ""].map(title => h("th", {}, title)))),
          h(
            "tbody",
            {},
            staff.map(person =>
              h(
                "tr",
                {},
                h("td", {}, named(person.name, person.sign_in)),
                h("td", {}, person.email, person.disabled ? h("span", { class: "badge danger" }, " off") : null),
                h("td", {}, person.platform_role === "owner" ? "Platform owner" : "System administrator"),
                h(
                  "td",
                  {},
                  you === "owner" && person.platform_role === "admin"
                    ? small("Remove", () => confirm(`Remove ${person.email} as system administrator?`) && act(() => api("/platform/staff", { email: person.email, role: null }), "staff", `${person.email} is no longer staff.`), "danger")
                    : null,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    add,
  ];
}

async function adminActivity() {
  const { events } = await api("/platform/activity");
  return [h("section", { class: "card stack" }, h("p", { class: "muted" }, "Everything Turf's staff changed from this dashboard, newest first."), activityList(events))];
}

async function adminMine() {
  const { organizations } = await api("/platform/organizations");
  const mine = organizations.filter(item => !item.plan && item.owner_email === me.user.email);
  if (mine.length)
    return [
      h(
        "section",
        { class: "card stack" },
        h("h2", {}, mine[0].name),
        h("p", {}, "Your own workspace has no plan, so no limits: invite as many callers and CRM users as you need from your account's Team section, and set their roles there."),
        h("div", { class: "row" }, h("a", { class: "button primary", href: "#/account", onclick: () => setOrganization(mine[0].id) }, "Manage its team"), crmLink()),
      ),
    ];
  return [
    h(
      "section",
      { class: "card stack" },
      h("h2", {}, "Open your workspace"),
      h("p", { class: "muted" }, "A workspace of Turf's own, with no seat, minute or time limits, for your callers and anyone you give CRM access."),
      form([input("Workspace name", "organization", { value: "Turf HQ" })], "Open workspace", async values => {
        const { organization_id } = await api("/platform/workspace", { organization: values.organization });
        setOrganization(organization_id);
        await refreshMe();
        await admin("mine", "Your workspace is open.");
      }),
    ),
  ];
}

function adminFrame(tab, you, nodes, done = null, failed = null) {
  return [
    h(
      "div",
      { class: "row spread" },
      h("h1", {}, "Admin"),
      h(
        "div",
        { class: "row" },
        service.grafana ? h("a", { class: "button", href: "#/admin/grafana" }, "Open Grafana") : null,
        h("span", { class: "badge " + (you === "owner" ? "peach" : "good") }, you === "owner" ? "Platform owner" : "System administrator"),
      ),
    ),
    h("nav", { class: "tabs", "aria-label": "Admin sections" }, ADMIN_TABS.map(([key, label]) => h("a", { href: "#/admin?tab=" + key, class: key === tab ? "active" : null, "aria-current": key === tab ? "page" : null }, label))),
    done ? notice(done, "good") : null,
    failed ? notice(failed, "error") : null,
    ...nodes,
  ].filter(Boolean);
}

async function admin(tab = "overview", done = null, failed = null) {
  if (!(await refreshMe())) return (location.hash = "#/signin");
  if (me.mfa.required && !me.mfa.passed) return (location.hash = "#/mfa");
  if (!me.platform_role) return show(notice("This page is for Turf's own staff.", "error"));
  const you = me.platform_role;
  if (!ADMIN_TABS.some(([key]) => key === tab)) tab = "overview";
  const build = { overview: adminOverview, workspaces: () => adminWorkspaces(you), people: () => adminPeople(you), payments: adminPayments, staff: () => adminStaff(you), activity: adminActivity, mine: adminMine }[tab];
  show(...adminFrame(tab, you, await build(), done, failed));
}

/**
 * Hands a member of staff over to Grafana: posts their token to the Grafana login proxy, which asks this server
 * whether they are staff and opens its own session (docs/plans/grafana-access.md). A form post, so the token is never
 * in a URL. The proxy sends people here when they have no session, with the page to go back to in `return`.
 */
async function grafana(back) {
  if (!service.grafana) return show(notice("Grafana is not set up on this server.", "error"));
  if (!(await refreshMe())) return (location.hash = "#/signin");
  if (me.mfa.required && !me.mfa.passed) return (location.hash = "#/mfa");
  if (!me.platform_role) return show(notice("Grafana is for Turf's own staff.", "error"));
  const token = await auth.accessToken();
  if (!token) return (location.hash = "#/signin");
  const handoff = h(
    "form",
    { method: "post", action: service.grafana + "/_turf/session" },
    h("input", { type: "hidden", name: "token", value: token }),
    h("input", { type: "hidden", name: "return", value: back.startsWith("/") ? back : "/" }),
  );
  show(h("section", { class: "card narrow" }, h("h2", {}, "Opening Grafana"), h("p", { class: "muted" }, "Checking your access…"), handoff));
  // Back from Grafana lands on the dashboard, not here again.
  history.replaceState(null, "", location.pathname + "#/admin");
  // The proxy takes a sign-in only from this site's origin. Under this site's Referrer-Policy (same-origin) a post to
  // another site says its origin is "null", so this page, which is leaving, says its origin (and nothing more).
  document.head.append(h("meta", { name: "referrer", content: "strict-origin" }));
  handoff.submit();
}

// --- Routing ---------------------------------------------------------------------------------------------------------

async function route() {
  const [path, query] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  try {
    if (path === "/signup") return signup();
    if (path === "/signin") return signin();
    if (path === "/mfa") return await mfa();
    if (path === "/account") return await account();
    if (path === "/admin/grafana") return await grafana(params.get("return") || "/");
    if (path === "/admin" || path === "/platform") return await admin(params.get("tab") || "overview");
    if (path === "/verify") return await verifyEmail(params.get("token") || "");
    if (path === "/join") return await joinTeam(params.get("token") || "");
    if (path === "/workspace") return await workspace();
    return await home();
  } catch (reason) {
    if (reason instanceof ApiError && reason.code === "mfa_required") return (location.hash = "#/mfa");
    if (reason instanceof ApiError && reason.status === 401) return (location.hash = "#/signin");
    show(notice(reason.message, "error"));
  }
}

window.addEventListener("hashchange", route);
// A link to the page already open (e.g. "Go to your account" shown on the account route) fires no hashchange.
document.addEventListener("click", event => {
  const link = event.target.closest?.("a[href^='#/']");
  if (link && link.getAttribute("href") === location.hash) {
    event.preventDefault();
    route();
  }
});
/** Back from Google with an authenticator set up: the sign-in waits for its code. */
function providerCode() {
  show(
    h(
      "section",
      { class: "card narrow" },
      h("h2", {}, "Enter your sign-in code"),
      h("p", { class: "muted" }, CODE_HELP),
      form([input("6-digit code", "code", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 8 })], "Sign in", async values => {
        await auth.verifyMfa(values.code.trim());
        await afterSignIn();
      }),
    ),
  );
}

// Back from Google: finish that sign-in, then the page carries on.
auth.finishProvider().then(
  back => (back ? afterSignIn() : refreshMe().then(route)),
  reason => (reason.code === "mfa_required" ? providerCode() : show(notice(reason.message, "error"))),
);
