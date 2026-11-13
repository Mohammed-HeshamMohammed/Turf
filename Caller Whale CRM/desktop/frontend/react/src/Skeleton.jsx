// Loading placeholders: the shape of each page in grey blocks, shown while its code (or its records) arrive, so the screen never goes blank.

const Block = ({ w, h, className = "" }) => <span className={"sk " + className} style={{ width: w, height: h }} />;
const lines = (count, widths = ["100%", "82%", "64%"]) => Array.from({ length: count }, (_, n) => <Block key={n} h={12} w={widths[n % widths.length]} />);

function Heading({ actions = 1 }) {
  return (
    <div className="page-heading">
      <div className="sk-stack">
        <Block h={26} w={190} />
        <Block h={13} w={280} />
      </div>
      <div className="page-actions">{Array.from({ length: actions }, (_, n) => <Block key={n} h={38} w={n ? 112 : 132} className="sk-pill" />)}</div>
    </div>
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
  overview: () => (
    <>
      <Heading />
      <Metrics />
      <div className="sk-two">
        <Panel rows={5} />
        <Panel rows={4} />
      </div>
    </>
  ),
  table: () => (
    <>
      <Heading actions={2} />
      <div className="card sk-tablecard">
        <div className="sk-toolbar">
          <Block h={38} w={260} className="sk-pill" />
          <Block h={38} w={96} className="sk-pill" />
          <Block h={38} w={96} className="sk-pill" />
        </div>
        <SkeletonRows rows={9} />
      </div>
    </>
  ),
  detail: () => (
    <>
      <Heading />
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
  split: () => (
    <>
      <Heading />
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
  calendar: () => (
    <>
      <Heading actions={2} />
      <div className="card sk-calendar">
        {Array.from({ length: 35 }, (_, n) => <Block key={n} h={86} w="100%" className="sk-cell" />)}
      </div>
    </>
  ),
  cards: () => (
    <>
      <Heading actions={1} />
      <div className="sk-two">
        <div className="card sk-panel">
          <Block h={18} w="36%" />
          {lines(5)}
          <Block h={38} w={120} className="sk-pill" />
        </div>
        <div className="card sk-panel">
          <Block h={18} w="30%" />
          {lines(5)}
          <Block h={38} w={120} className="sk-pill" />
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
      <Layout />
    </div>
  );
}
