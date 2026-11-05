import { useEffect, useMemo, useState, type FormEvent } from "react";
import { workspaceRoleName } from "./roles.ts";
import { CurrencySelect } from "./CurrencySelect.tsx";
import { convertMinor, formatMinor, type Rates } from "./currency.ts";
import { useMainCurrency } from "./MainCurrency.tsx";
import type { Auth } from "./auth/auth-client.js";
import { SecondStep, needsSecondStep, useSecondStep } from "./SecondStep.tsx";

/** The dashboard's authed request to the auth service (it adds the token and turns refusals into messages). */
export type Api = (method: string, path: string, body?: object) => Promise<any>;

const moneyDigits = (currency: string) => new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
export const money = (minor: number, currency: string) => new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: moneyDigits(currency) }).format(minor / 10 ** moneyDigits(currency));
const when = (seconds: number) => seconds ? new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Never";
const pct = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : "0%";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function useLoad<T>(request: Api, path: string, again = 0) {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: "", loading: true });
  useEffect(() => {
    let live = true;
    setState(current => ({ ...current, loading: true, error: "" }));
    request("GET", path).then(
      data => live && setState({ data, error: "", loading: false }),
      error => live && setState({ data: null, error: error instanceof Error ? error.message : "Could not load this.", loading: false }),
    );
    return () => { live = false; };
  }, [path, again]);
  return state;
}

/** Bars drawn as plain SVG: no chart library, readable by a screen reader through the title and the list below. */
function Bars({ title, data, format }: { title: string; data: { label: string; value: number }[]; format: (value: number) => string }) {
  const top = Math.max(1, ...data.map(point => point.value));
  const width = 100 / Math.max(1, data.length);
  return <figure className="owner-chart">
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={title}>
      {data.map((point, index) => {
        const height = point.value / top * 36;
        return <rect key={point.label} x={index * width + width * 0.12} y={38 - height} width={width * 0.76} height={Math.max(height, point.value ? 0.6 : 0)} rx="0.6"><title>{`${point.label}: ${format(point.value)}`}</title></rect>;
      })}
    </svg>
    <figcaption><span>{data[0]?.label}</span><span>{data[data.length - 1]?.label}</span></figcaption>
  </figure>;
}

type Plan = { plan: string; name: string; workspaces: number; paying: number; trialing: number; mrr_minor: number; currency: string };
type Overview = {
  people: { accounts: number; staff: number; members: number; new_7_days: number; new_30_days: number; email_verified: number; two_step: number; active_7_days: number; active_30_days: number; signups_by_day: { day: string; count: number }[] };
  plans: Plan[]; most_requested_plan?: Plan; billing_connected: boolean;
  usage: { connected: boolean; minutes_this_month: number; credits_this_month: number; top: { kind: string; label: string; total: number }[] };
  finance?: { currency: string; mrr_minor: number; revenue_this_month_minor: number; revenue_last_month_minor: number; revenue_12_months_minor: number; monthly_costs_minor: number; one_off_costs_minor: number; profit_month_minor: number; roi_percent: number | null; revenue_by_month: { month: string; amount_minor: number }[]; costs_by_category: Record<string, number>; other_currency_costs: number; converted_entries: number; fx_as_of?: string;
    variable_costs: { voip_minor: number; storage_minor: number; fees_minor: number; total_minor: number }; gross_profit_month_minor: number; gross_margin_percent: number | null;
    variable_costs_estimate_month_minor: number; total_monthly_costs_minor: number; rates_entered: number;
    quota: { near_limit: { workspace: string; plan: string; used: number; allowed: number; percent: number }[]; over_allowance_minutes: number; over_allowance_cost_minor: number; workspaces_over_allowance: number } };
};

const categoryNames: Record<string, string> = { hosting: "Hosting", tools: "Tools", marketing: "Marketing", staff_pay: "Staff pay", other: "Other" };

export function PlatformOverview({ request, openCosts }: { request: Api; openCosts?: () => void }) {
  const { data, error, loading } = useLoad<Overview>(request, "/v1/admin/overview");
  if (loading && !data) return <p role="status" className="muted">Loading the overview…</p>;
  if (error || !data) return <div className="admin-feedback card" role="alert"><h2>The overview is unavailable</h2><p>{error || "Try again in a moment."}</p></div>;
  const { people, plans, usage, finance } = data;
  const best = data.most_requested_plan;
  return <div className="owner-overview">
    <div className="admin-metrics" aria-label="People">
      <div><span>Members</span><strong>{people.members}</strong><small>{plural(people.new_7_days, "new member")} this week</small></div>
      <div><span>Active in 30 days</span><strong>{people.active_30_days}</strong><small>{pct(people.active_30_days, people.members)} of members · {people.active_7_days} this week</small></div>
      <div><span>Two-step on</span><strong>{pct(people.two_step, people.members)}</strong><small>{people.two_step} of {people.members} members</small></div>
      <div><span>Email confirmed</span><strong>{pct(people.email_verified, people.members)}</strong><small>{people.email_verified} of {people.members} members</small></div>
    </div>
    {finance ? <>
      <div className="admin-metrics" aria-label="Money">
        <div><span>Monthly recurring revenue</span><strong>{money(finance.mrr_minor, finance.currency)}</strong><small>From paying workspaces</small></div>
        <div><span>Revenue this month</span><strong>{money(finance.revenue_this_month_minor, finance.currency)}</strong><small>Last month {money(finance.revenue_last_month_minor, finance.currency)}</small></div>
        <div><span>Monthly profit</span><strong className={finance.profit_month_minor < 0 ? "owner-negative" : undefined}>{money(finance.profit_month_minor, finance.currency)}</strong><small>Recurring revenue minus {money(finance.total_monthly_costs_minor, finance.currency)} costs</small></div>
        <div><span>Return on costs (ROI)</span><strong className={finance.roi_percent !== null && finance.roi_percent < 0 ? "owner-negative" : undefined}>{finance.roi_percent === null ? "—" : `${Math.round(finance.roi_percent)}%`}</strong><small>{finance.roi_percent === null ? "Enter your costs to see it" : "Profit divided by all monthly costs"}</small></div>
      </div>
      {finance.total_monthly_costs_minor === 0 && openCosts && <p className="notice" role="note">No costs entered yet, so profit equals revenue and there is no ROI. <button type="button" className="staff-text-button" onClick={openCosts}>Enter your costs and rates</button></p>}
      <section className="card" aria-labelledby="owner-margin-title">
        <span className="eyebrow">Per customer</span><h2 id="owner-margin-title">What each month's customers cost you</h2>
        {finance.rates_entered === 0 ? <p className="muted">Enter your provider's price per call minute, your storage and the payment fee in the Costs tab, and this shows what your customers' usage costs you. {openCosts && <button type="button" className="staff-text-button" onClick={openCosts}>Enter rates</button>}</p> : <>
          <p className="muted">So far this month: {money(finance.revenue_this_month_minor, finance.currency)} taken, {money(finance.variable_costs.total_minor, finance.currency)} paid out because of it.{finance.gross_margin_percent !== null && <> You keep <strong>{Math.round(finance.gross_margin_percent)}%</strong> of every payment after these costs.</>}</p>
          <ul className="owner-list">
            <li><span>Call minutes<small>VOIP provider, per minute used</small></span><strong>{money(finance.variable_costs.voip_minor, finance.currency)}</strong></li>
            <li><span>Storage and data<small>per GB, as you entered</small></span><strong>{money(finance.variable_costs.storage_minor, finance.currency)}</strong></li>
            <li><span>Payment provider fees<small>percent and fixed part of each payment</small></span><strong>{money(finance.variable_costs.fees_minor, finance.currency)}</strong></li>
            <li><span>Gross profit so far</span><strong className={finance.gross_profit_month_minor < 0 ? "owner-negative" : undefined}>{money(finance.gross_profit_month_minor, finance.currency)}</strong></li>
          </ul></>}
      </section>
      <section className="card" aria-labelledby="owner-quota-title">
        <span className="eyebrow">Minutes bank</span><h2 id="owner-quota-title">Who is close to their minutes</h2>
        <p className="muted">{finance.quota.near_limit.length === 0 ? "Nobody is close to the minutes their plan includes." : `${plural(finance.quota.near_limit.length, "workspace")} at 90% or more of their plan's minutes.`}{finance.quota.over_allowance_minutes > 0 && ` ${finance.quota.over_allowance_minutes.toLocaleString()} minutes have been used past the plans' allowances${finance.quota.over_allowance_cost_minor > 0 ? `, about ${money(finance.quota.over_allowance_cost_minor, finance.currency)} at your per-minute price` : ""}. Those are the minutes to buy for customers.`}</p>
        {finance.quota.near_limit.length > 0 && <ul className="owner-list">{finance.quota.near_limit.map(row => <li key={row.workspace}><span>Workspace {row.workspace}<small>{row.plan} plan</small></span><strong>{row.used.toLocaleString()} of {row.allowed.toLocaleString()} ({Math.round(row.percent)}%)</strong></li>)}</ul>}
      </section>
      {finance.converted_entries > 0 && <p className="notice" role="note">{plural(finance.converted_entries, "cost or rate")} entered in another currency {finance.converted_entries === 1 ? "is" : "are"} counted in {finance.currency}, the currency that earns the most, at the exchange rate of {finance.fx_as_of}.</p>}
      {finance.other_currency_costs > 0 && <p className="notice" role="note">{plural(finance.other_currency_costs, "cost or rate")} in another currency could not be converted (no exchange rate right now) and {finance.other_currency_costs === 1 ? "is" : "are"} not counted.</p>}
    </> : null}
    <section className="admin-overview-panels" aria-label="Trends">
      <div className="card"><span className="eyebrow">Growth</span><h2>New members, last 30 days</h2><p className="muted">{plural(people.new_30_days, "member")} joined in the last 30 days.</p><Bars title="New members per day" data={people.signups_by_day.map(day => ({ label: day.day, value: day.count }))} format={value => plural(value, "member")} /></div>
      {finance && <div className="card"><span className="eyebrow">Revenue</span><h2>Money taken by month</h2><p className="muted">{money(finance.revenue_12_months_minor, finance.currency)} in the last 12 months.</p>{finance.revenue_by_month.length ? <Bars title="Revenue per month" data={finance.revenue_by_month.map(row => ({ label: row.month, value: row.amount_minor }))} format={value => money(value, finance.currency)} /> : <p className="muted">No payments yet.</p>}</div>}
    </section>
    <section className="card owner-plans" aria-labelledby="owner-plans-title">
      <div className="admin-section-heading"><div><span className="eyebrow">Plans</span><h2 id="owner-plans-title">What people ask for</h2><p className="muted">{best ? `${best.name} is the most requested plan, with ${plural(best.workspaces, "workspace")}.` : "Nobody has picked a plan yet."}</p></div></div>
      {!data.billing_connected && <p className="notice" role="note">Billing is not connected to this dashboard yet, so plans, revenue and usage are empty. Set AUTH_BILLING_URL and AUTH_BILLING_TOKEN on the auth service.</p>}
      {plans.length > 0 && <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th scope="col">Plan</th><th scope="col">Workspaces</th><th scope="col">Paying</th><th scope="col">On trial</th><th scope="col">Monthly revenue</th></tr></thead><tbody>{plans.map(plan => <tr key={plan.plan}><td data-label="Plan"><strong>{plan.name}</strong></td><td data-label="Workspaces">{plan.workspaces}</td><td data-label="Paying">{plan.paying}</td><td data-label="On trial">{plan.trialing}</td><td data-label="Monthly revenue">{money(plan.mrr_minor, plan.currency)}</td></tr>)}</tbody></table></div>}
    </section>
    <section className="admin-overview-panels" aria-label="Usage">
      <div className="card"><span className="eyebrow">Usage this month</span><h2>What is being used</h2><ul className="owner-list"><li><span>Call minutes</span><strong>{usage.minutes_this_month.toLocaleString()}</strong></li><li><span>Desktop credits</span><strong>{usage.credits_this_month.toLocaleString()}</strong></li></ul></div>
      <div className="card"><span className="eyebrow">Heaviest users</span><h2>Most usage per member</h2>{usage.top.length ? <ul className="owner-list">{usage.top.slice(0, 8).map((row, index) => <li key={`${row.kind}-${row.label}-${index}`}><span>{row.label}<small>{row.kind === "minutes" ? "call minutes" : "credits"}</small></span><strong>{row.total.toLocaleString()}</strong></li>)}</ul> : <p className="muted">No usage recorded this month.</p>}</div>
    </section>
    {finance && Object.keys(finance.costs_by_category).length > 0 && <section className="card" aria-labelledby="owner-costs-title"><span className="eyebrow">Costs</span><h2 id="owner-costs-title">Where the money goes each month</h2><ul className="owner-list">{Object.entries(finance.costs_by_category).sort((a, b) => b[1] - a[1]).map(([category, amount]) => <li key={category}><span>{categoryNames[category] || category}</span><strong>{money(amount, finance.currency)}</strong></li>)}</ul></section>}
  </div>;
}

type Member = { id: string; name: string; email: string; joined_at: number; last_active: number; email_verified: boolean; two_step: boolean; disabled: boolean; workspaces: number; roles: string[] };

export function MembersTable({ request, canGive = false, auth }: { request: Api; canGive?: boolean; auth?: Auth }) {
  const [reload, setReload] = useState(0);
  const [giving, setGiving] = useState<Member | null>(null);
  const [given, setGiven] = useState("");
  const { data, error, loading } = useLoad<{ members: Member[]; total: number; shown: number }>(request, "/v1/admin/members", reload);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const rows = useMemo(() => (data?.members || []).filter(member => {
    if (!`${member.name} ${member.email}`.toLowerCase().includes(query.trim().toLowerCase())) return false;
    if (filter === "no_two_step") return !member.two_step;
    if (filter === "unconfirmed") return !member.email_verified;
    if (filter === "no_workspace") return member.workspaces === 0;
    if (filter === "inactive") return member.last_active < Date.now() / 1000 - 30 * 86400;
    return true;
  }), [data, query, filter]);
  if (loading && !data) return <p role="status" className="muted">Loading members…</p>;
  if (error || !data) return <div className="admin-feedback card" role="alert"><h2>Members are unavailable</h2><p>{error || "Try again in a moment."}</p></div>;
  return <section className="admin-team card" aria-labelledby="members-title">
    <div className="admin-section-heading"><div><span className="eyebrow">Everyone who is not staff</span><h2 id="members-title">Members</h2><p className="muted">People with a Caller Whale account, their workspaces and how they sign in.{data.total > data.shown ? ` Showing the newest ${data.shown} of ${data.total}.` : ""}</p></div><span className="admin-count">{query || filter !== "all" ? `${rows.length} of ${data.members.length}` : data.total} {data.total === 1 ? "member" : "members"}</span></div>
    <div className="admin-toolbar"><label>Search members<input type="search" placeholder="Name or email" value={query} onChange={event => setQuery(event.target.value)} /></label><label>Show<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Everyone</option><option value="no_two_step">Without two-step</option><option value="unconfirmed">Email not confirmed</option><option value="no_workspace">Not in a workspace</option><option value="inactive">Not seen in 30 days</option></select></label></div>
    {data.members.length === 0 ? <div className="admin-empty"><h3>No members yet</h3><p>People who sign up will appear here.</p></div> : rows.length === 0 ? <div className="admin-empty"><h3>No matches</h3><p>Try a different name, email, or filter.</p><button type="button" className="button raised" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button></div> :
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th scope="col">Member</th><th scope="col">Workspaces</th><th scope="col">Security</th><th scope="col">Joined</th><th scope="col">Last seen</th>{canGive && <th scope="col"><span className="sr-only">Action</span></th>}</tr></thead><tbody>{rows.map(member => <tr key={member.id}>
        <td data-label="Member"><span className="admin-person"><span className="admin-person-avatar" aria-hidden="true">{(member.name || member.email || "?").charAt(0).toUpperCase()}</span><span><strong>{member.name || member.email}</strong><small>{member.email}</small></span></span></td>
        <td data-label="Workspaces">{member.workspaces ? <>{plural(member.workspaces, "workspace")}<small className="owner-sub">{[...new Set(member.roles.map(role => workspaceRoleName(role)))].join(", ")}</small></> : <span className="muted">None</span>}</td>
        <td data-label="Security"><span className={`owner-badge ${member.two_step ? "good" : ""}`}>{member.two_step ? "Two-step on" : "No two-step"}</span> {!member.email_verified && <span className="owner-badge warn">Email not confirmed</span>} {member.disabled && <span className="owner-badge bad">Disabled</span>}</td>
        <td data-label="Joined">{when(member.joined_at)}</td><td data-label="Last seen">{when(member.last_active)}</td>{canGive && <td data-label="Action"><button type="button" className="staff-text-button" onClick={() => { setGiven(""); setGiving(member); }}>Give membership</button></td>}</tr>)}</tbody></table></div>}
    {given && <p className="notice" role="status">{given}</p>}
    {giving && auth && <GiveMembership request={request} auth={auth} member={giving} onClose={() => setGiving(null)} onGiven={text => { setGiving(null); setGiven(text); setReload(count => count + 1); }} />}
  </section>;
}

type Cost = { id: string; label: string; category: string; amount_minor: number; currency: string; interval: string; note: string };

export function CostsManager({ request, auth, saved }: { request: Api; auth: Auth; saved?: string }) {
  const main = useMainCurrency(() => request("GET", "/v1/fx"), saved);
  const [again, setAgain] = useState(0);
  const { data, error, loading } = useLoad<{ costs: Cost[] }>(request, "/v1/admin/costs", again);
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState("hosting");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [interval, setInterval] = useState("monthly");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const second = useSecondStep(auth, "Changing your costs needs a code entered just now.");
  const add = (event: FormEvent) => {
    event.preventDefault();
    const digits = moneyDigits(currency.toUpperCase().length === 3 ? currency.toUpperCase() : "USD");
    const minor = Math.round(Number(amount) * 10 ** digits);
    if (!Number.isFinite(minor) || minor <= 0) { setMessage("Enter an amount above zero."); return Promise.resolve(); }
    return second.guard(async () => {
      setBusy(true); setMessage("");
      try {
        await request("POST", "/v1/admin/costs", { label, category, amount_minor: minor, currency: currency.toUpperCase(), interval, note });
        setLabel(""); setAmount(""); setNote(""); setAgain(count => count + 1);
      } catch (problem) {
        if (needsSecondStep(problem)) { setBusy(false); throw problem; }
        setMessage(problem instanceof Error ? problem.message : "Could not save that cost.");
      }
      setBusy(false);
    });
  };
  const remove = (id: string) => second.guard(async () => {
    setBusy(true); setMessage("");
    try { await request("DELETE", `/v1/admin/costs/${id}`); setAgain(count => count + 1); }
    catch (problem) {
      if (needsSecondStep(problem)) { setBusy(false); throw problem; }
      setMessage(problem instanceof Error ? problem.message : "Could not remove that cost.");
    }
    setBusy(false);
  });
  const costs = data?.costs || [];
  const monthly = costs.filter(cost => cost.currency === (costs[0]?.currency || "USD")).reduce((sum, cost) => sum + (cost.interval === "monthly" ? cost.amount_minor : cost.interval === "yearly" ? Math.floor(cost.amount_minor / 12) : 0), 0);
  return <div className="owner-costs">
    <section className="admin-manage card" aria-labelledby="costs-title">
      <div><span className="eyebrow">Owner and cofounders only</span><h2 id="costs-title">Running costs</h2><p className="muted">What it costs to run Caller Whale. The overview uses these to work out profit and return. Staff pay can be entered here too.</p></div>
      {second.prompt}<form className="staff-form" onSubmit={add}>
        <div className="staff-fields">
          <label>Name<input required maxLength={80} value={label} onChange={event => setLabel(event.target.value)} placeholder="Server, ads, designer…" /></label>
          <label>Type<select value={category} onChange={event => setCategory(event.target.value)}>{Object.entries(categoryNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
          <label>Amount<input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" /></label>
          <CurrencySelect label="Currency" value={currency} onChange={setCurrency} required />
          <label>Paid<select value={interval} onChange={event => setInterval(event.target.value)}><option value="monthly">Every month</option><option value="yearly">Every year</option><option value="once">Once</option></select></label>
          <label>Note (optional)<input maxLength={200} value={note} onChange={event => setNote(event.target.value)} /></label>
          <button className="button primary" disabled={busy}>{busy ? "Saving…" : "Add cost"}</button>
        </div>
        {message && <p className="notice bad" role="alert">{message}</p>}
      </form>
    </section>
    <RatesManager request={request} auth={auth} main={main} />
    <section className="admin-team card" aria-labelledby="costs-list-title">
      <div className="admin-section-heading"><div><h2 id="costs-list-title">Costs entered</h2><p className="muted">{costs.length ? `About ${money(monthly, costs[0]?.currency || "USD")} a month in ${costs[0]?.currency || "USD"}.` : "Nothing yet."}</p></div></div>
      {loading && !data ? <p role="status" className="muted">Loading…</p> : error ? <p className="notice bad" role="alert">{error}</p> : costs.length === 0 ? <div className="admin-empty"><h3>No costs yet</h3><p>Add what you pay for, and the overview will show profit and return.</p></div> :
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th scope="col">Cost</th><th scope="col">Type</th><th scope="col">Amount</th><th scope="col">Paid</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead><tbody>{costs.map(cost => <tr key={cost.id}>
          <td data-label="Cost"><strong>{cost.label}</strong>{cost.note && <small className="owner-sub">{cost.note}</small>}</td><td data-label="Type">{categoryNames[cost.category] || cost.category}</td><td data-label="Amount">{money(cost.amount_minor, cost.currency)}{inMain(cost.amount_minor, cost.currency, main)}</td><td data-label="Paid">{cost.interval === "monthly" ? "Every month" : cost.interval === "yearly" ? "Every year" : "Once"}</td>
          <td data-label="Action"><button type="button" className="staff-text-button" disabled={busy} onClick={() => void remove(cost.id)}>Remove</button></td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}

type Rate = { id: string; label: string; kind: string; rate_micros: number; quantity: number; percent_bp: number; fixed_micros: number; currency: string; note: string };
const kindNames: Record<string, string> = { minute: "Per call minute", gb: "Per GB of storage or data", payment_fee: "Payment provider fee" };
const toMicros = (text: string) => Math.round(Number(text) * 1_000_000);
const fromMicros = (micros: number, currency: string) => new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(micros / 1_000_000);

/** The costs that follow customers: what the provider charges per call minute and per GB, and the payment provider's cut of each payment. */
function RatesManager({ request, auth, main }: { request: Api; auth: Auth; main: { currency: string; rates: Rates | null } }) {
  const [again, setAgain] = useState(0);
  const { data, error, loading } = useLoad<{ rates: Rate[] }>(request, "/v1/admin/rates", again);
  const [kind, setKind] = useState("minute");
  const [label, setLabel] = useState("");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [percent, setPercent] = useState("");
  const [fixed, setFixed] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const second = useSecondStep(auth, "Changing your rates needs a code entered just now.");
  const add = (event: FormEvent) => {
    event.preventDefault();
    return second.guard(async () => {
    setBusy(true); setMessage("");
    try {
      await request("POST", "/v1/admin/rates", {
        label, kind, currency: currency.toUpperCase(),
        ...(kind === "payment_fee" ? { percent_bp: Math.round(Number(percent || 0) * 100), fixed_micros: toMicros(fixed || "0") } : { rate_micros: toMicros(price), ...(kind === "gb" ? { quantity: Math.round(Number(quantity || 0)) } : {}) }),
      });
      setLabel(""); setPrice(""); setQuantity(""); setPercent(""); setFixed(""); setAgain(count => count + 1);
    } catch (problem) {
      if (needsSecondStep(problem)) { setBusy(false); throw problem; }
      setMessage(problem instanceof Error ? problem.message : "Could not save that rate.");
    }
    setBusy(false);
    });
  };
  const remove = (id: string) => second.guard(async () => {
    setBusy(true); setMessage("");
    try { await request("DELETE", `/v1/admin/rates/${id}`); setAgain(count => count + 1); }
    catch (problem) {
      if (needsSecondStep(problem)) { setBusy(false); throw problem; }
      setMessage(problem instanceof Error ? problem.message : "Could not remove that rate.");
    }
    setBusy(false);
  });
  const rates = data?.rates || [];
  return <section className="admin-manage card" aria-labelledby="rates-title">
    <div><span className="eyebrow">Costs that follow customers</span><h2 id="rates-title">What you pay when customers pay or use the service</h2><p className="muted">Each plan sells unlimited calls on a real minutes allowance. Enter what your provider charges per minute (including the extra minutes you buy for customers near their limit), your storage price and the payment fee. The overview multiplies these by what customers actually used and paid this month.</p></div>
    {second.prompt}<form className="staff-form" onSubmit={add}>
      <div className="staff-fields">
        <label>What for<select value={kind} onChange={event => setKind(event.target.value)}>{Object.entries(kindNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label>Name<input required maxLength={80} value={label} onChange={event => setLabel(event.target.value)} placeholder={kind === "minute" ? "VOIP provider" : kind === "gb" ? "Storage" : "Paddle fee"} /></label>
        {kind === "payment_fee" ? <>
          <label>Percent of each payment<input inputMode="decimal" value={percent} onChange={event => setPercent(event.target.value.replace(/[^0-9.]/g, ""))} placeholder="5" /></label>
          <label>Plus a fixed amount per payment<input inputMode="decimal" value={fixed} onChange={event => setFixed(event.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.50" /></label>
        </> : <>
          <label>{kind === "minute" ? "Price of one minute" : "Price of one GB"}<input required inputMode="decimal" value={price} onChange={event => setPrice(event.target.value.replace(/[^0-9.]/g, ""))} placeholder={kind === "minute" ? "0.0085" : "0.02"} /></label>
          {kind === "gb" && <label>GB used each month<input required inputMode="numeric" value={quantity} onChange={event => setQuantity(event.target.value.replace(/\D/g, ""))} placeholder="50" /></label>}
        </>}
        <CurrencySelect label="Currency" value={currency} onChange={setCurrency} required />
        <button className="button primary" disabled={busy}>{busy ? "Saving…" : "Add rate"}</button>
      </div>
      {message && <p className="notice bad" role="alert">{message}</p>}
    </form>
    {loading && !data ? <p role="status" className="muted">Loading…</p> : error ? <p className="notice bad" role="alert">{error}</p> : rates.length > 0 && <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th scope="col">Rate</th><th scope="col">For</th><th scope="col">Price</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead><tbody>{rates.map(rate => <tr key={rate.id}>
      <td data-label="Rate"><strong>{rate.label}</strong></td><td data-label="For">{kindNames[rate.kind] || rate.kind}</td>
      <td data-label="Price">{rate.kind === "payment_fee" ? `${rate.percent_bp / 100}%${rate.fixed_micros ? ` + ${fromMicros(rate.fixed_micros, rate.currency)}` : ""} per payment` : rate.kind === "gb" ? `${fromMicros(rate.rate_micros, rate.currency)} × ${rate.quantity.toLocaleString()} GB a month` : `${fromMicros(rate.rate_micros, rate.currency)} a minute`}{rate.kind !== "payment_fee" && main.rates && rate.currency !== main.currency && main.rates.rates[rate.currency] && main.rates.rates[main.currency] ? <small className="owner-sub">≈ {fromMicros(Math.round(rate.rate_micros * main.rates.rates[main.currency] / main.rates.rates[rate.currency]), main.currency)}{rate.kind === "gb" ? " per GB" : " a minute"}</small> : null}</td>
      <td data-label="Action"><button type="button" className="staff-text-button" disabled={busy} onClick={() => void remove(rate.id)}>Remove</button></td></tr>)}</tbody></table></div>}
  </section>;
}

type PlanOption = { key: string; name: string; price_minor: number; currency: string; price: string };
const paymentNames: Record<string, string> = { trial: "Trial", free: "Free", manual: "Paid manually" };

/** An owner or cofounder gives a person a plan they arranged with them: it opens their own workspace and starts the plan in billing. */
function GiveMembership({ request, auth, member, onClose, onGiven }: { request: Api; auth: Auth; member: Member; onClose: () => void; onGiven: (text: string) => void }) {
  const { data, error } = useLoad<{ plans: PlanOption[] }>(request, "/v1/admin/plans");
  const { data: catalog } = useLoad<{ workspace: { key: string; name: string; assignable: boolean }[] }>(request, "/v1/roles");
  const [plan, setPlan] = useState("");
  const [payment, setPayment] = useState("trial");
  const [role, setRole] = useState("owner");
  const [days, setDays] = useState("14");
  const [months, setMonths] = useState("12");
  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const plans = data?.plans || [];
  const chosen = plans.find(option => option.key === (plan || plans[0]?.key));
  // The roles that open a workspace are the ones a membership can give; the catalog says which, so nothing is listed twice or invented here.
  const roles = (catalog?.workspace || []).filter(entry => !entry.assignable);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!chosen) return;
    setBusy(true); setMessage(""); setConfirming(false);
    try {
      const digits = moneyDigits(chosen.currency);
      const answer = await request("POST", "/v1/admin/memberships", {
        user_id: member.id, plan: chosen.key, payment, role,
        ...(payment === "trial" ? { days: Number(days) } : { months: Number(months) }),
        ...(payment === "manual" && amount.trim() ? { amount_minor: Math.round(Number(amount) * 10 ** digits) } : {}),
      });
      const who = member.name || member.email;
      onGiven(`${who} now has the ${answer.plan_name || chosen.name} plan (${paymentNames[payment].toLowerCase()})${answer.workspace_created ? " in a new workspace" : " in their workspace"}.`);
    } catch (problem) {
      // Giving a membership needs a second step done just now: ask for the code here, and give it as soon as it is accepted.
      if (needsSecondStep(problem)) setConfirming(true);
      else setMessage(problem instanceof Error ? problem.message : "Could not give that membership.");
    }
    setBusy(false);
  };
  if (confirming) return <section className="admin-manage card" aria-labelledby="give-title">
    <div><span className="eyebrow">Membership</span><h2 id="give-title">Give {member.name || member.email} a plan</h2></div>
    <SecondStep auth={auth} reason="Giving a plan needs a code entered just now." onDone={() => void submit()} onCancel={onClose} />
  </section>;
  return <section className="admin-manage card" aria-labelledby="give-title">
    <div><span className="eyebrow">Membership</span><h2 id="give-title">Give {member.name || member.email} a plan</h2><p className="muted">This opens their own workspace (or uses the one they have) and starts the plan. Their role is the one they hold in that workspace. Everyone else on their team is invited into it afterwards.</p></div>
    {error ? <p className="notice bad" role="alert">{error}</p> : <form className="staff-form" onSubmit={submit}>
      <div className="staff-fields">
        <label>Plan<select value={plan || plans[0]?.key || ""} onChange={event => setPlan(event.target.value)} required>{plans.map(option => <option key={option.key} value={option.key}>{option.name}{option.price ? ` · ${money(option.price_minor, option.currency)} a month` : ""}</option>)}</select></label>
        <label>How it is paid<select value={payment} onChange={event => setPayment(event.target.value)}>{Object.entries(paymentNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label>Their role<select value={role} onChange={event => setRole(event.target.value)}>{(roles.length ? roles : [{ key: "owner", name: "Agency owner" }, { key: "solo", name: "Solo operator" }]).map(entry => <option key={entry.key} value={entry.key}>{entry.name}</option>)}</select></label>
        {payment === "trial" ? <label>Trial length (days)<input inputMode="numeric" required value={days} onChange={event => setDays(event.target.value.replace(/\D/g, ""))} /></label> : <label>For how many months<input inputMode="numeric" required value={months} onChange={event => setMonths(event.target.value.replace(/\D/g, ""))} /></label>}
        {payment === "manual" && chosen && <label>Amount they paid ({chosen.currency})<input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value.replace(/[^0-9.]/g, ""))} placeholder={`${(chosen.price_minor * Number(months || 1) / 10 ** moneyDigits(chosen.currency)).toFixed(moneyDigits(chosen.currency))}`} /></label>}
        <button className="button primary" disabled={busy || !chosen}>{busy ? "Giving…" : "Give membership"}</button>
        <button type="button" className="button raised" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      {payment === "manual" && <p className="muted">Leave the amount empty to record the plan's price for those months. The payment counts as revenue in the overview.</p>}
      {message && <p className="notice bad" role="alert">{message}</p>}
    </form>}
  </section>;
}

/** A cost in another currency also read in the person's main currency, at today's rate, under the amount. */
function inMain(minor: number, currency: string, main: { currency: string; rates: Rates | null }) {
  if (currency === main.currency) return null;
  const converted = convertMinor(minor, currency, main.currency, main.rates);
  return converted === null ? null : <small className="owner-sub">≈ {formatMinor(converted, main.currency)}</small>;
}
