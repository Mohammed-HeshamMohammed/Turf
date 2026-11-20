import { useEffect, useState } from "react";
import { api } from "./remote/api.ts";
import { Badge, Card, Segmented } from "./ui.jsx";

const RANGES = [
  { id: "today", label: "Today", days: 1 },
  { id: "week", label: "7 days", days: 7 },
  { id: "month", label: "30 days", days: 30 },
];

const ACTIONS = {
  "call.recorded": "Logged a call",
  "lead.created": "Added a lead",
  "lead.updated": "Updated a lead",
  "lead.assigned": "Assigned a lead",
  "lead.archived": "Archived a lead",
  "lead.restored": "Restored a lead",
  "lead.deleted": "Deleted a lead",
  "lead.shared": "Shared a lead",
  "note.added": "Wrote a note",
  "note.edited": "Edited a note",
  "note.deleted": "Deleted a note",
  "task.created": "Created a task",
  "task.updated": "Updated a task",
  "task.completed": "Completed a task",
  "task.deleted": "Deleted a task",
};

const day = date => {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const when = value => (value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");
const ROLE_NAMES = { owner: "Agency owner", solo: "Solo operator", manager: "Team manager", caller: "Caller", closer: "Acquisitions / closer" };

/** What each person the viewer manages did over a range of days, from the server, with their recent activity on demand. An agency
 * owner sees everyone, a team manager the callers and closers of their own teams, anyone else themself. */
export function TeamMonitor() {
  const [range, setRange] = useState("week");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState("");
  const [activity, setActivity] = useState({ user: "", events: [], loading: false, error: "" });

  useEffect(() => {
    let live = true;
    const days = RANGES.find(item => item.id === range).days;
    const to = new Date();
    const from = new Date(to);
    from.setDate(to.getDate() - (days - 1));
    setError("");
    api.memberStats(day(from), day(to)).then(answer => live && setData(answer), reason => live && setError(reason?.message || "The team's numbers could not be loaded."));
    return () => {
      live = false;
    };
  }, [range]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setActivity({ user: open, events: [], loading: true, error: "" });
    api.memberActivity(open).then(
      answer => live && setActivity({ user: open, events: answer.events || [], loading: false, error: "" }),
      reason => live && setActivity({ user: open, events: [], loading: false, error: reason?.message || "Activity could not be loaded." }),
    );
    return () => {
      live = false;
    };
  }, [open]);

  const totals = new Map((data?.totals || []).map(row => [row.user_id, row]));
  const rows = (data?.people || []).map(person => ({ ...person, ...(totals.get(person.user_id) || {}) }));
  const sum = key => rows.reduce((total, row) => total + (row[key] || 0), 0);
  const name = id => rows.find(row => row.user_id === id)?.name || "Member";

  return (
    <Card
      title="Activity"
      subtitle={rows.length > 1 ? "What each person you manage did, counted from their calls, notes and tasks." : "What you did, counted from your calls, notes and tasks."}
      action={<Segmented label="Range" value={range} options={RANGES} onChange={setRange} />}
      className="table-card team-monitor"
    >
      {error ? (
        <p className="notice bad" role="alert">{error}</p>
      ) : !data ? (
        <p className="muted" role="status">Counting…</p>
      ) : (
        <>
          <p className="muted team-monitor-sum">
            {sum("dials").toLocaleString()} calls · {sum("connects").toLocaleString()} reached ({percent(sum("connects"), sum("dials"))}) · {sum("qualified").toLocaleString()} qualified · {sum("tasks_done").toLocaleString()} tasks done
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Calls</th>
                  <th>Reached</th>
                  <th>Qualified</th>
                  <th>Callbacks</th>
                  <th>Wrong / DNC</th>
                  <th>Leads worked</th>
                  <th>Leads held</th>
                  <th>Tasks done</th>
                  <th>Open tasks</th>
                  <th>Last active</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.user_id} className={open === row.user_id ? "selected" : ""}>
                    <td>
                      <button type="button" className="text-link" onClick={() => setOpen(open === row.user_id ? "" : row.user_id)} aria-expanded={open === row.user_id}>
                        {row.name}
                      </button>
                      <small>
                        {row.roles.map(role => ROLE_NAMES[role] || role).join(", ")}
                        {row.team_name ? ` · ${row.team_name}` : ""}
                      </small>
                      {row.suspended && <Badge tone="peach">Suspended</Badge>}
                    </td>
                    <td>{(row.dials || 0).toLocaleString()}</td>
                    <td>
                      {(row.connects || 0).toLocaleString()} <small>{percent(row.connects, row.dials)}</small>
                    </td>
                    <td>{(row.qualified || 0).toLocaleString()}</td>
                    <td>{(row.callbacks || 0).toLocaleString()}</td>
                    <td>
                      {(row.bad_numbers || 0).toLocaleString()} / {(row.do_not_call || 0).toLocaleString()}
                    </td>
                    <td>{(row.leads_worked || 0).toLocaleString()}</td>
                    <td>{(row.leads_held || 0).toLocaleString()}</td>
                    <td>{(row.tasks_done || 0).toLocaleString()}</td>
                    <td>
                      {(row.tasks_open || 0).toLocaleString()}
                      {row.tasks_overdue ? <small> {row.tasks_overdue} overdue</small> : null}
                    </td>
                    <td>{when(row.last_active)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {open && (
            <div className="team-activity" aria-live="polite">
              <h3>Recent activity · {name(open)}</h3>
              {activity.loading ? (
                <p className="muted">Loading…</p>
              ) : activity.error ? (
                <p className="notice bad">{activity.error}</p>
              ) : activity.events.length === 0 ? (
                <p className="muted">Nothing recorded yet.</p>
              ) : (
                <ul>
                  {activity.events.map(event => (
                    <li key={event.id}>
                      <span>
                        {ACTIONS[event.action] || event.action}
                        {event.outcome ? ` · ${event.outcome}` : ""}
                        {event.stage && event.action === "lead.updated" ? ` · ${event.stage}` : ""}
                        {event.lead_name ? ` · ${event.lead_name}` : ""}
                      </span>
                      <small>{when(event.at)}</small>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
