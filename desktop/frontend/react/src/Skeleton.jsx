// Loading placeholders: the shape of each page's records in grey blocks, shown while its code (or its records) arrive, so the screen never goes blank.
// Only what comes from data is a block. A page's title, greeting and description are known at once and are shown as they are; its buttons and
// filters are the page's own, so they appear with it rather than as grey stand-ins.
import { useCrm } from "./context.jsx";
import { personalProfile } from "./model.ts";

const Block = ({ w, h, className = "" }) => <span className={"sk " + className} style={{ width: w, height: h }} />;
const lines = (count, widths = ["100%", "82%", "64%"]) => Array.from({ length: count }, (_, n) => <Block key={n} h={12} w={widths[n % widths.length]} />);

/** The page's real title and description where they do not depend on records; a grey line where they do. */
function Heading({ route }) {
  const { state } = useCrm();
  const parts = String(route || "").split("/");
  const section = parts[0] === "work" ? parts[1] : parts[0];
  const detail = Boolean(parts[parts[0] === "work" ? 2 : 1]);
  const client = state.role === "client";
  const zone = state.settings?.timezone;
  const known = {
    dashboard: state.role === "admin" ? ["Overview", "Access, connections and services."] : client ? ["Your properties", "Your approved records, updates, and next steps in one place."] : ["Good morning, " + personalProfile(state).name.split(" ")[0], null],
    leads: detail ? (parts[2] === "new" ? ["New lead", "The person, the property and who looks after it."] : null) : [client ? "Shared properties" : "Leads", client ? "Only records explicitly shared with your partner workspace." : ""],
    calls: ["Calls", ""],
    deals: detail ? null : ["Deals", ""],
    handoffs: ["Handoffs", "Leads passed between people, waiting to be accepted or declined."],
    tasks: ["Tasks", zone ? "All times shown in " + zone + "." : ""],
    calendar: ["Calendar", zone ? "Appointments and next steps · " + zone : ""],
    inbox: ["Inbox", "Email, SMS and team messages, with leads or phone numbers."],
    mail: ["Mail", "Email with leads and partners, kept apart from chats."],
    lists: detail ? null : ["Source lists", "Imported lists and the leads that came from them."],
    skip: ["Skip Tracing", "Map a list, check its contact details, and review the results."],
    reports: ["Reports", "Based only on the records you can see."],
    settings: ["Settings", "Workspace defaults, access and connections."],
    sync: ["Sync", "Changes waiting to be sent, and any that need your decision."],
    team: ["Team", "Who owns what, and what is waiting on them."],
    personal: [parts[1] === "preferences" ? "Preferences" : "My profile", "Only you see these."],
  }[section];
  // The Leads list has no heading of its own: the sidebar already says where the person is.
  if (section === "leads" && !detail) return null;
  if (!known) return <div className="page-heading"><div className="sk-stack"><Block h={26} w={220} /><Block h={13} w={300} /></div></div>;
  const [title, description] = known;
  // A description that counts records (the overview's "8 active leads") is a grey line until they arrive.
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        {description === null ? <Block h={13} w={260} className="sk-after" /> : description ? <p>{description}</p> : null}
      </div>
    </header>
  );
}

function Metrics({ count = 4 }) {
  return (
    <div className="metrics-grid">
      {Array.from({ length: count }, (_, n) => (
        <div className="card sk-metric" key={n}>
          <Block h={12} w="46%" />
          <Block h={34} w="38%" />
          <Block h={12} w="62%" />
        </div>
      ))}
    </div>
  );
}

function Panel({ rows = 4, title = true }) {
  return (
    <div className="card sk-panel">
      {title && <Block h={18} w="38%" />}
      {Array.from({ length: rows }, (_, n) => (
        <div className="sk-row" key={n}>
          <Block h={36} w={36} className="sk-round" />
          <div className="sk-stack">
            <Block h={13} w={n % 2 ? "58%" : "72%"} />
            <Block h={11} w="40%" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Rows for a table that is still being filled; used inside a page that has already drawn its header. */
export function SkeletonRows({ rows = 8, columns = 5 }) {
  return (
    <div className="sk-table" role="status" aria-busy="true" aria-label="Loading records">
      {Array.from({ length: rows }, (_, row) => (
        <div className="sk-trow" key={row} style={{ gridTemplateColumns: `1.6fr repeat(${columns - 1}, 1fr)` }}>
          {Array.from({ length: columns }, (_, col) => <Block key={col} h={13} w={col ? `${52 + ((row * 7 + col * 13) % 36)}%` : `${64 + ((row * 11) % 28)}%`} />)}
        </div>
      ))}
    </div>
  );
}

const layouts = {
  overview: ({ route }) => (
    <>
      <Heading route={route} />
      <Metrics />
      <div className="sk-two">
        <Panel rows={5} />
        <Panel rows={4} />
      </div>
    </>
  ),
  table: ({ route }) => (
    <>
      <Heading route={route} />
      <div className="card sk-tablecard">
        <SkeletonRows rows={9} />
      </div>
    </>
  ),
  detail: ({ route }) => (
    <>
      <Heading route={route} />
      <div className="sk-two sk-detail">
        <div className="card sk-panel">
          <Block h={18} w="30%" />
          {lines(7)}
        </div>
        <div className="sk-stack">
          <Panel rows={3} />
          <Panel rows={3} />
        </div>
      </div>
    </>
  ),
  split: ({ route }) => (
    <>
      <Heading route={route} />
      <div className="sk-split">
        <Panel rows={7} title={false} />
        <div className="card sk-panel">
          <Block h={20} w="34%" />
          {lines(9, ["92%", "78%", "86%", "60%"])}
          <Block h={90} w="100%" className="sk-block" />
        </div>
      </div>
    </>
  ),
  calendar: ({ route }) => (
    <>
      <Heading route={route} />
      <div className="card sk-calendar">
        {Array.from({ length: 35 }, (_, n) => <Block key={n} h={86} w="100%" className="sk-cell" />)}
      </div>
    </>
  ),
  cards: ({ route }) => (
    <>
      <Heading route={route} />
      <div className="sk-two">
        <div className="card sk-panel">
          <Block h={18} w="36%" />
          {lines(5)}
        </div>
        <div className="card sk-panel">
          <Block h={18} w="30%" />
          {lines(5)}
        </div>
      </div>
    </>
  ),
};

// Which shape each page takes. Anything not listed gets the table, the most common page.
const shapes = { dashboard: "overview", reports: "overview", inbox: "split", mail: "split", calendar: "calendar", settings: "cards", sync: "cards", personal: "cards" };

export function shapeFor(route) {
  const parts = String(route || "").split("/");
  const section = parts[0] === "work" ? parts[1] : parts[0];
  if (section === "leads" && parts[2]) return "detail";
  if (section === "deals" && parts[2]) return "detail";
  if (section === "lists" && parts[1]) return "detail";
  return shapes[section] || "table";
}

/** The whole page, in grey. `route` is the current page path, e.g. "work/leads" or "dashboard". */
export function PageSkeleton({ route }) {
  const Layout = layouts[shapeFor(route)];
  return (
    <div className="sk-page" role="status" aria-busy="true" aria-label="Loading page">
      <Layout route={route} />
    </div>
  );
}
