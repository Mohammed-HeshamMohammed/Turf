// Turf's public website: plans, sign-up onto the trial, sign-in with MFA, email confirmation, the account (plan,
// minutes, seats, payments), checkout and team invitations. Everything is enforced by the API; this page only asks.
// User data is only ever written as text (never as HTML), and nothing runs inline, so the server's CSP holds.

const main = document.getElementById("main");
const nav = document.getElementById("site-nav");
const CRM_URL = "http://localhost:5190/";
const ROLE_NAMES = {
  manager: "Team manager",
  caller: "Caller",
  closer: "Acquisitions / closer",
  researcher: "Data researcher",
  admin: "System administrator",
  client: "Client / partner",
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, body) {
  const response = await fetch("/api/v1" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Turf-Request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
  me = await api("/me").catch(() => null);
  nav.replaceChildren(
    ...(me
      ? [
          me.platform_admin ? h("a", { class: "button", href: "#/platform" }, "Customers") : null,
          h("a", { class: "button", href: "#/account" }, "Account"),
          h("button", { class: "button", onclick: signOut }, "Sign out"),
        ].filter(Boolean)
      : [h("a", { class: "button", href: "#/signin" }, "Sign in"), h("a", { class: "button primary", href: "#/signup" }, "Start free trial")]),
  );
  return me;
}

async function signOut() {
  await api("/auth/logout", {}).catch(() => undefined);
  await refreshMe();
  location.hash = "#/";
}

// --- Google sign-in -----------------------------------------------------------------------------------------------

const LOGOS = {
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

/** "Continue with Google" for the sign-up and sign-in pages. A provider not set up on the server says so. */
function providerButtons() {
  const status = h("div");
  const known = api("/auth/providers").catch(() => ({}));
  const button = (name, text) =>
    h(
      "button",
      {
        type: "button",
        class: "button provider " + name,
        onclick: async () => {
          if ((await known)[name]) return (location.href = `/api/v1/auth/oauth/${name}/start?target=website`);
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
    h("div", { class: "row" }, h("a", { class: "button primary", href: "#/signup" }, "Start the free trial"), h("a", { class: "button", href: "#/signin" }, "Sign in")),
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
          h("a", { class: "button" + (plan.key === "trial" ? " primary" : ""), href: "#/signup" }, plan.key === "trial" ? "Start free" : "Start with the trial"),
        ),
      ),
    ),
  );
}

function signup() {
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
          const answer = await api("/auth/signup", { ...values, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
          sessionStorage.setItem("turf.verify", answer.verification_token || "");
          await refreshMe();
          location.hash = "#/mfa";
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
          const answer = await api("/auth/login", values);
          await refreshMe();
          location.hash = answer.mfa_required ? "#/mfa" : "#/account";
        },
      ),
      h("p", { class: "muted" }, "New here? ", h("a", { href: "#/signup" }, "Start a free trial"), "."),
    ),
  );
}

/** Owners and administrators confirm a code from an authenticator app: set one up the first time, then verify. */
async function mfa() {
  if (!(await refreshMe())) return (location.hash = "#/signin");
  if (!me.mfa.required || me.mfa.passed) return (location.hash = "#/account");
  if (me.mfa.enrolled) {
    return show(
      h(
        "section",
        { class: "card narrow" },
        h("h2", {}, "Enter your sign-in code"),
        form([input("6-digit code", "code", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 8 })], "Continue", async values => {
          await api("/auth/mfa/verify", values);
          location.hash = "#/account";
        }),
      ),
    );
  }
  const setup = await api("/auth/mfa/setup", {});
  show(
    h(
      "section",
      { class: "card narrow" },
      h("h2", {}, "Protect your account"),
      h("p", {}, "Add Turf to an authenticator app (Google Authenticator, 1Password, Authy) with this key, then enter the code it shows."),
      h("span", { class: "code", "aria-label": "Setup key" }, setup.secret),
      h("p", { class: "muted" }, "Or open this link on your phone: ", h("a", { href: setup.otpauth_url }, "add to authenticator")),
      form([input("6-digit code", "code", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 8 })], "Confirm", async values => {
        const { recovery_codes } = await api("/auth/mfa/confirm", values);
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
    await api("/auth/verify-email", { token });
    sessionStorage.removeItem("turf.verify");
    show(h("section", { class: "card narrow" }, h("h2", {}, "Email confirmed"), h("a", { class: "button primary", href: "#/account" }, "Go to your account")));
  } catch (reason) {
    show(h("section", { class: "card narrow" }, notice(reason.message, "error"), h("a", { class: "button", href: "#/account" }, "Back to your account")));
  }
}

function joinTeam(token) {
  show(
    h(
      "section",
      { class: "card narrow" },
      h("h2", {}, "Join your team on Turf"),
      form(
        [
          input("Your name", "display_name", { autocomplete: "name" }),
          input("Password", "password", { type: "password", autocomplete: "new-password", minlength: 12 }),
          h("p", { class: "muted" }, "Already have a Turf account with this email? Enter its password."),
        ],
        "Join",
        async values => {
          const answer = await api("/auth/invitations/accept", { ...values, token });
          await refreshMe();
          location.hash = answer.mfa_required ? "#/mfa" : "#/account";
        },
      ),
    ),
  );
}

async function account() {
  if (!(await refreshMe())) return (location.hash = "#/signin");
  if (me.mfa.required && !me.mfa.passed) return (location.hash = "#/mfa");
  const billing = await api("/billing");
  const org = me.organizations.find(item => item.id === me.organization_id);
  const admin = me.capabilities.includes("admin");
  const sections = [h("h1", {}, org?.name || "Your account"), h("p", { class: "muted" }, me.user.name + " · " + me.user.email)];

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
                  const answer = await api("/auth/verify-email/resend", {}).catch(reason => ({ error: reason.message }));
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
        h("span", { class: "code" }, `python backend/scripts/dev_pay.py ${checkout.payment_id} ${checkout.amount_cents}`),
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
    ],
    "Send invitation",
    async values => {
      const answer = await api("/admin/members", { email: values.email, roles: [values.role] });
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
        h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Email"), h("th", {}, "Role"))),
        h(
          "tbody",
          {},
          members.map(member => h("tr", {}, h("td", {}, member.name), h("td", {}, member.email), h("td", {}, member.roles.map(key => ROLE_NAMES[key] || key).join(", ")))),
          invitations.map(item => h("tr", {}, h("td", { class: "muted" }, "Invited"), h("td", {}, item.email), h("td", {}, item.roles.map(key => ROLE_NAMES[key] || key).join(", ")))),
        ),
      ),
    ),
    billing.can_invite ? invite : notice("All seats are taken. Add seats above to invite someone else."),
    result,
  );
}

/** For Turf's own administrators: every customer organization, its plan, minutes, seats and what it has paid. */
async function platform() {
  if (!(await refreshMe())) return (location.hash = "#/signin");
  if (me.mfa.required && !me.mfa.passed) return (location.hash = "#/mfa");
  if (!me.platform_admin) return show(notice("This page is for Turf's platform administrators.", "error"));
  const { organizations, totals } = await api("/platform/organizations");
  const status = item => (item.status ? h("span", { class: "badge " + (item.status === "active" ? "good" : item.status === "trialing" ? "peach" : "danger") }, item.status) : h("span", { class: "badge" }, "no limits"));
  show(
    h("h1", {}, "Customers"),
    h("p", { class: "muted" }, "Every organization on this Turf server. Their CRM records are never shown here."),
    h(
      "div",
      { class: "stats" },
      h("div", { class: "stat card" }, h("strong", {}, String(totals.organizations)), h("small", {}, "organizations")),
      h("div", { class: "stat card" }, h("strong", {}, String(totals.paying)), h("small", {}, "paying")),
      h("div", { class: "stat card" }, h("strong", {}, String(totals.trials)), h("small", {}, "on the trial")),
      h("div", { class: "stat card" }, h("strong", {}, money(totals.paid_cents)), h("small", {}, "paid in total")),
    ),
    h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h(
            "thead",
            {},
            h("tr", {}, ["Organization", "Owner", "Plan", "Status", "Minutes used", "Seats", "Members", "Period ends", "Paid", "Joined"].map(title => h("th", {}, title))),
          ),
          h(
            "tbody",
            {},
            organizations.map(item =>
              h(
                "tr",
                {},
                h("td", {}, item.name),
                h("td", {}, item.owner_email || "—"),
                h("td", {}, item.plan || "—"),
                h("td", {}, status(item)),
                h("td", {}, item.minutes_included === null ? "—" : `${item.minutes_used.toLocaleString()} / ${item.minutes_included.toLocaleString()}`),
                h("td", {}, item.seats === null ? "—" : String(item.seats)),
                h("td", {}, String(item.members)),
                h("td", {}, item.period_end ? date(item.period_end) : "—"),
                h("td", {}, money(item.paid_cents)),
                h("td", {}, date(item.created_at)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
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
    if (path === "/platform") return await platform();
    if (path === "/verify") return await verifyEmail(params.get("token") || "");
    if (path === "/join") return joinTeam(params.get("token") || "");
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
refreshMe().then(route);
