// A lead's next step is real work: its earliest open task (a call, a text, an appointment, a follow-up), or the callback set on it.
// A lead with neither gets a suggestion from its stage, which one click turns into a task.

export const STEP_TYPES = ["Call", "Text", "Appointment", "Follow-up"];

const SUGGESTED: Record<string, { title: string; type: string }> = {
  New: { title: "First call", type: "Call" },
  Contacted: { title: "Follow-up call", type: "Follow-up" },
  Interested: { title: "Book an appointment", type: "Appointment" },
  Qualified: { title: "Hand to a closer", type: "Follow-up" },
};

export type NextStep =
  | { kind: "task"; id: string; title: string; type: string; date: string; time: string; assignee: string; overdue: boolean }
  | { kind: "callback"; title: string; type: string; date: string; time: string; overdue: boolean }
  | { kind: "suggested"; title: string; type: string };

type Lead = { id: string; stage?: string; verdict?: string; callbackDate?: string; callback?: string; archived?: boolean };
type Task = { id: string; leadId?: string; done?: boolean; date?: string; time?: string; title: string; type?: string; assignee?: string };

const pad = (n: number) => String(n).padStart(2, "0");
/** The local date and time as text that sorts in time order: 2026-11-15T09:30. */
export function localKey(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
// A step with a date and no time is due by the end of that day.
const dueKey = (date: string, time?: string) => `${date}T${time || "23:59"}`;

export function nextStepOf(lead: Lead, tasks: Task[], now: Date = new Date()): NextStep | null {
  const at = localKey(now);
  const open = tasks
    .filter(task => task.leadId === lead.id && !task.done)
    .sort((a, b) => (a.date ? dueKey(a.date, a.time) : "~").localeCompare(b.date ? dueKey(b.date, b.time) : "~"));
  const task = open[0];
  if (task)
    return {
      kind: "task",
      id: task.id,
      title: task.title,
      type: task.type || "Follow-up",
      date: task.date || "",
      time: task.time || "",
      assignee: task.assignee || "",
      overdue: Boolean(task.date) && dueKey(task.date as string, task.time) < at,
    };
  if (lead.callbackDate)
    return { kind: "callback", title: "Callback", type: "Call", date: lead.callbackDate, time: lead.callback || "", overdue: dueKey(lead.callbackDate, lead.callback) < at };
  if (lead.archived || lead.stage === "Closed" || lead.verdict === "Do not call") return null;
  const suggested = SUGGESTED[lead.stage || "New"];
  return suggested ? { kind: "suggested", ...suggested } : null;
}
