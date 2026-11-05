// Settings, Connections: the AI assistants and tools Caller Whale will connect to. None can be connected yet; each card says so
// plainly instead of pretending. When one is built, its card gets a real button and its status changes to "now".

type Connection = { name: string; what: string; group: "assistants" | "tools" };

const CONNECTIONS: Connection[] = [
  { group: "assistants", name: "Claude", what: "Let Claude read and update your Caller Whale records." },
  { group: "assistants", name: "ChatGPT", what: "Let ChatGPT read and update your Caller Whale records." },
  { group: "assistants", name: "Gemini", what: "Let Gemini read and update your Caller Whale records." },
  { group: "tools", name: "ClickUp", what: "Send tasks and follow-ups from Caller Whale to ClickUp." },
  { group: "tools", name: "Google Meet", what: "Start and log Google Meet calls from a lead." },
  { group: "tools", name: "MyVirtualTracker", what: "Send call and work data to MyVirtualTracker." },
];

function Group({ title, items }: { title: string; items: Connection[] }) {
  return (
    <section className="card profile-card" aria-label={title}>
      <h2>{title}</h2>
      <ul className="settings-list">
        {items.map(item => (
          <li key={item.name}>
            <span><strong>{item.name}</strong><small className="muted">{item.what}</small></span>
            <span className="role-badge is-off">Coming soon</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SettingsConnections() {
  return (
    <div className="settings-stack">
      <Group title="AI assistants" items={CONNECTIONS.filter(item => item.group === "assistants")} />
      <Group title="Tools" items={CONNECTIONS.filter(item => item.group === "tools")} />
    </div>
  );
}
