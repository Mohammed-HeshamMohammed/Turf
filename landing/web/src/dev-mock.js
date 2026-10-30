// Development only: sample accounts for looking at the signed-in pages without Caller Whale's server or the auth service.
// Open any page with ?mock=staff, ?mock=customer, ?mock=invited or ?mock=stranger (?mock=off to stop). session.jsx
// reaches this file only under `import.meta.env.DEV`, so a production build never contains it.

const KEY = "callerwhale.mock";

export function mockRole() {
  try {
    const asked = new URLSearchParams(window.location.search).get("mock");
    if (asked === "off") sessionStorage.removeItem(KEY);
    else if (asked) sessionStorage.setItem(KEY, asked);
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

const now = new Date();
const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
const day = n => new Date(monthStart.getTime() + n * 86400000).toISOString().slice(0, 10);
const ago = hours => new Date(now.getTime() - hours * 3600000).toISOString();
const period = { start: monthStart.toISOString(), end: monthEnd.toISOString() };

const usage = {
  period,
  days: [[0, 120], [1, 340], [3, 80], [6, 510], [7, 260], [9, 45], [12, 610], [13, 300]].filter(([n]) => n < now.getUTCDate()).map(([n, credits]) => ({ day: day(n), credits })),
  recent: [
    { at: ago(2), kind: "skip_trace", detail: "Tampa absentee owners", credits: 300 },
    { at: ago(26), kind: "skip_trace", detail: "Orlando probate", credits: 610 },
    { at: ago(70), kind: "skip_trace", detail: "", credits: 45 },
  ],
};

const release = { version: "0.4.0", file: "CallerWhale_0.4.0_x64.msi", size: 100663296 };

const people = [
  { id: "p1", email: "mmeegoo20@gmail.com", name: "Mohamed Magdy", status: "active", sign_in: "google", monthly_credits: 2000, used_this_month: 0, used_total: 0, last_used_at: null, accepted_at: ago(5), emailed_at: ago(30), created_at: ago(30), invited_by: "Mohammed Hesham", registered: true, note: "" },
  { id: "p2", email: "sam@acmehomes.com", name: "Sam Reed", status: "active", sign_in: "password", monthly_credits: 5000, used_this_month: 4210, used_total: 18300, last_used_at: ago(2), accepted_at: ago(900), emailed_at: ago(920), created_at: ago(920), invited_by: "Mohammed Hesham", registered: true, note: "Pilot customer" },
  { id: "p3", email: "lee@keystone.io", name: "Lee Ortiz", status: "invited", sign_in: null, monthly_credits: 1000, used_this_month: 0, used_total: 0, last_used_at: null, accepted_at: null, emailed_at: ago(48), created_at: ago(48), invited_by: "Mohammed Hesham", registered: false, note: "" },
  { id: "p4", email: "ana@brightdoor.com", name: "Ana Keys", status: "suspended", sign_in: "password", monthly_credits: 500, used_this_month: 500, used_total: 2400, last_used_at: ago(200), accepted_at: ago(2000), emailed_at: ago(2100), created_at: ago(2100), invited_by: "Mohammed Hesham", registered: true, note: "Paused at their request" },
  { id: "p5", email: "jordan@flipfast.co", name: "", status: "invited", sign_in: null, monthly_credits: 1000, used_this_month: 0, used_total: 0, last_used_at: null, accepted_at: null, emailed_at: null, created_at: ago(1), invited_by: "Mohammed Hesham", registered: false, note: "" },
];

const accounts = {
  staff: { person: { email: "owner@callerwhale.test", name: "Mohammed Hesham" }, staff: { role: "owner" }, access: null, release },
  customer: {
    person: { email: "sam@acmehomes.com", name: "Sam Reed" },
    staff: null,
    release,
    access: { status: "active", monthly_credits: 5000, used_this_month: 2265, remaining: 2735, period, accepted_at: ago(900), usage },
  },
  invited: { person: { email: "lee@keystone.io", name: "Lee Ortiz" }, staff: null, release, access: { status: "invited", monthly_credits: 1000, used_this_month: 0, remaining: 1000, period, usage: { period, days: [], recent: [] } } },
  stranger: { person: { email: "visitor@example.com", name: "" }, staff: null, access: null, release: null },
};

export const mockAuth = {
  providerList: ["google"],
  accessToken: async () => `x.${btoa(JSON.stringify({ auth_time: Math.floor(Date.now() / 1000) }))}.y`,
  refresh: async () => "mock-token",
  finishProvider: async () => false,
  signIn: async () => {},
  signUp: async () => {},
  signOut: async () => sessionStorage.removeItem(KEY),
  startProvider: async () => {},
  resetPassword: async () => {},
  me: async () => ({ mfa_enrolled: true }),
};

const totals = () => ({
  active: people.filter(p => p.status === "active").length,
  invited: people.filter(p => p.status === "invited").length,
  suspended: people.filter(p => p.status === "suspended").length,
  used_this_month: people.reduce((sum, p) => sum + p.used_this_month, 0),
});

export async function mockRequest(method, path, body) {
  await new Promise(r => setTimeout(r, 250));
  const role = mockRole();
  if (path === "/api/v1/account") return accounts[role] || accounts.stranger;
  if (path === "/api/v1/account/download") return { url: "/#mock-download" };
  if (path === "/api/v1/platform/invitations" && method === "GET") return { invitations: people, totals: totals(), mail: true };
  if (path === "/api/v1/platform/invitations" && method === "POST") {
    people.unshift({ id: `p${people.length + 1}`, status: "invited", sign_in: null, used_this_month: 0, used_total: 0, last_used_at: null, accepted_at: null, emailed_at: ago(0), created_at: ago(0), invited_by: "Mohammed Hesham", registered: false, ...body });
    return {};
  }
  const m = path.match(/^\/api\/v1\/platform\/invitations\/(\w+)(\/\w+)?$/);
  const person = m && people.find(p => p.id === m[1]);
  if (person && m[2] === "/usage") return { usage: person.used_this_month ? usage : { period, days: [], recent: [] } };
  if (person && method === "PATCH") return Object.assign(person, body);
  if (person && method === "DELETE") return people.splice(people.indexOf(person), 1) && {};
  if (person) return {};
  return {};
}
