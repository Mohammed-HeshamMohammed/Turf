import { Fragment, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import type { Turf } from "../App";
import { AreaMap, type Dot } from "../components/AreaMap";
import type { Spot } from "../components/StreetMap";
import { Empty, Field, SearchBox, Segmented, VerdictPill } from "../components/Bits";
import { copyText, useContextMenu, type MenuItem } from "../components/ContextMenu";
import { Select } from "../components/Select";
import { cancelJob, locateAddresses, locatedAddresses, placeRows, streetColumn, useZipCentres, useZipOutlines, type AddressColumns, type LocateProgress, type Located } from "../lib/geo";
import { deleteDataset, renameDataset } from "../lib/service";
import { Icon } from "../components/Icon";
import { ListPicker } from "../components/ListPicker";
import { ListDownloads } from "../components/ListDownloads";
import { PhoneChoices } from "../components/PhoneChoices";
import { marksSource, useRows, useVisited } from "../lib/hooks";
import {
  AREA_LABELS, AREA_LEVELS, KIND_LABELS, MANUAL_LABELS, VERDICT_LABELS, areaColumns, checkedPhoneColumns, countAreas, formatDate,
  formatNumber, formatPhone, ownColumns, positionColumns, readMarks, type Marks,
} from "../lib/marks";
import { VERDICTS, type AreaLevel, type Dataset, type DatasetRow, type ManualMark, type Verdict } from "../lib/types";

// The street map and its library are fetched the first time a map is shown, not when the app starts.
const StreetMap = lazy(() => import("../components/StreetMap").then(module => ({ default: module.StreetMap })));

const PAGE = 25;
const MANUAL: ManualMark[] = ["called", "interested", "wrong_number", "do_not_call"];
const PLUMBING = /^(zpid|latitude|longitude|image|detail url)$/i;

export function Lists({ turf }: { turf: Turf }) {
  const dataset = turf.datasets.find(item => item.id === turf.selectedId) ?? null;
  // Lists looked at lately stay alive behind the one in view, so going back to one is instant and keeps its filters.
  const kept = useVisited(dataset?.id ?? null, turf.datasets.map(item => item.id));
  return (
    <div className="split">
      <ListPicker datasets={turf.datasets} selectedId={turf.selectedId} onSelect={turf.select} onImported={async id => { await turf.refresh(); turf.select(id); }}
        menuFor={item => [
          { label: "Open", disabled: item.id === dataset?.id, onSelect: () => turf.select(item.id) },
          { label: "Check its phones in Skip Tracing", disabled: item.kind === "checked", onSelect: () => turf.open("skiptracing", item.id) },
          { label: "Copy its name", onSelect: () => copyText(item.name) },
        ]} />
      {kept.map(id => (
        <div key={id} className="kept" hidden={id !== dataset?.id}>
          <ListView turf={turf} dataset={turf.datasets.find(item => item.id === id)!} />
        </div>
      ))}
      {!dataset && <Empty title="No lists yet">Import a file here, or save a collected run in DataForge. It appears in this project.</Empty>}
    </div>
  );
}

function ListView({ turf, dataset }: { turf: Turf; dataset: Dataset }) {
  const source = marksSource(dataset, turf.datasets);
  const parent = turf.datasets.find(item => item.id === dataset.parent_dataset_id);
  const rows = useRows(source.id, turf.fail);

  const [level, setLevel] = useState<AreaLevel | null>(null);
  const [area, setArea] = useState<string | null>(null);
  const [mapping, setMapping] = useState(false);
  const [verdict, setVerdict] = useState("all");
  const [flag, setFlag] = useState("all");
  const [column, setColumn] = useState("");
  const [contains, setContains] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [openRow, setOpenRow] = useState<string | null>(null);
  // Renaming and deleting happen in place, in the heading. Deleting asks once more before it does anything.
  const [editing, setEditing] = useState<"rename" | "delete" | null>(null);
  const [newName, setNewName] = useState(dataset.name);
  const [working, setWorking] = useState(false);
  const menu = useContextMenu();
  const copies = turf.datasets.filter(item => item.parent_dataset_id === dataset.id).length;
  const checkedAt = useMemo(() => {
    try { return source.derivation_json ? JSON.parse(source.derivation_json).checked_at as string | undefined : undefined; }
    catch { return undefined; }
  }, [source.derivation_json]);
  async function act(action: () => Promise<unknown>) {
    setWorking(true);
    try {
      await action();
      await turf.refresh();
      setEditing(null);
    } catch (reason) {
      turf.fail(reason);
    }
    setWorking(false);
  }

  const columns = useMemo(() => (rows?.[0] ? Object.keys(rows[0].raw) : []), [rows]);
  const own = useMemo(() => ownColumns(columns), [columns]);
  const phoneColumns = useMemo(() => checkedPhoneColumns(columns), [columns]);
  const areaMap = useMemo(() => areaColumns(columns, turf.areaMaps[dataset.id]), [columns, turf.areaMaps, dataset.id]);
  const position = useMemo(() => positionColumns(columns), [columns]);
  const available = AREA_LEVELS.filter(item => areaMap[item]);
  const activeLevel = level && areaMap[level] ? level : available.at(-1) ?? null;
  const areaColumn = activeLevel ? areaMap[activeLevel] : undefined;

  const marked = useMemo(() => (rows ?? []).map(row => ({ row, marks: readMarks(row.raw, phoneColumns, turf.manual) })), [rows, phoneColumns, turf.manual]);
  const areas = useMemo(() => countAreas(rows ?? [], areaColumn), [rows, areaColumn]);

  // Every filter but the chosen area: the map shades by this, so choosing an area does not grey out the rest.
  const filteredIgnoringArea = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const part = contains.trim().toLowerCase();
    return marked.filter(({ row, marks }) => {
      if (verdict !== "all" && marks.verdict !== verdict) return false;
      if (flag === "wrong" && !marks.knownWrong) return false;
      if (flag === "dnc" && !marks.doNotCall) return false;
      if (flag === "callable" && !marks.best) return false;
      if (flag === "manual" && !marks.manual) return false;
      if (column && part && !String(row.raw[column] ?? "").toLowerCase().includes(part)) return false;
      if (needle && !own.some(name => String(row.raw[name] ?? "").toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [marked, verdict, flag, column, contains, query, own]);
  const filtered = useMemo(
    () => (area && areaColumn ? filteredIgnoringArea.filter(({ row }) => String(row.raw[areaColumn] ?? "").trim() === area) : filteredIgnoringArea),
    [filteredIgnoringArea, area, areaColumn],
  );

  // Where each row goes on the map: its own coordinates, its exact address once looked up, or its ZIP's centre.
  const zipValues = useMemo(() => (areaMap.zip && rows ? [...new Set(rows.map(row => String(row.raw[areaMap.zip!] ?? "").trim()).filter(Boolean))] : []), [rows, areaMap.zip]);
  const centres = useZipCentres(zipValues, turf.fail);
  const known = zipValues.filter(value => centres.has(value)).length;
  const addressColumns = useMemo<AddressColumns | null>(() => {
    const street = streetColumn(own);
    return street && (areaMap.zip || (areaMap.city && areaMap.state)) ? { street, city: areaMap.city, state: areaMap.state, zip: areaMap.zip } : null;
  }, [own, areaMap]);
  const [located, setLocated] = useState<Located | null>(null);
  const [lookups, setLookups] = useState(0);
  const [asking, setAsking] = useState(false);
  // The street background needs the internet. Without it the rows are drawn on a plain plot instead.
  const [plain, setPlain] = useState(false);
  useEffect(() => {
    if (!addressColumns || position) return;
    let current = true;
    locatedAddresses(source.id, addressColumns).then(result => current && setLocated(result), turf.fail);
    return () => { current = false; };
  }, [source.id, addressColumns, position, lookups, turf.fail]);
  const placement = useMemo(
    () => placeRows(rows ?? [], { position, zipColumn: areaMap.zip, stateColumn: areaMap.state, centres, exact: located?.exact, streetColumn: addressColumns?.street }),
    // `known` changes as ZIP centres arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, position, areaMap.zip, areaMap.state, centres, known, located, addressColumns],
  );
  const dots = useMemo(() => {
    const kept = new Set(filtered.map(item => item.row.id));
    return placement.dots.map(dot => ({ lon: dot.lon, lat: dot.lat, dim: !kept.has(dot.rowId) }));
  }, [placement, filtered]);
  // For the street map: rows placed by ZIP are gathered into one spot for each ZIP, counted by whether the filters
  // show them and named by the area they belong to at the level the list is on. Rows with a place of their own stay
  // single points. The area filter itself is left out of the count, so choosing an area does not grey the others.
  const mapData = useMemo(() => {
    const rowsById = new Map((rows ?? []).map(row => [row.id, row]));
    const kept = new Set(filteredIgnoringArea.map(item => item.row.id));
    const spots = new Map<string, Spot>();
    const points: Dot[] = [];
    for (const dot of placement.dots) {
      const shown = kept.has(dot.rowId);
      if (!dot.zip) { points.push({ lon: dot.lon, lat: dot.lat, dim: !shown, label: dot.label }); continue; }
      let spot = spots.get(dot.zip);
      if (!spot) {
        const named = areaColumn ? String(rowsById.get(dot.rowId)?.raw[areaColumn] ?? "").trim() : "";
        spots.set(dot.zip, spot = { zip: dot.zip, lat: dot.lat, lon: dot.lon, shown: 0, hidden: 0, area: named || dot.zip });
      }
      if (shown) spot.shown += 1; else spot.hidden += 1;
    }
    return { spots: [...spots.values()], points, zips: [...spots.keys()] };
  }, [rows, placement, filteredIgnoringArea, areaColumn]);
  const zipOutlines = useZipOutlines(mapData.zips, turf.fail);
  // The area pointed at, in the list or on the map; each outlines it in the other.
  const [hoverArea, setHoverArea] = useState<string | null>(null);
  const areaList = useRef<HTMLUListElement>(null);
  /** Brings an area's line into view inside the list when it is pointed at on the map. Only the list itself moves:
   * the page must never scroll because the pointer passed over something. */
  const pointFromMap = (name: string | null) => {
    setHoverArea(name);
    const list = areaList.current;
    const line = name === null ? null : [...(list?.children ?? [])].find(item => (item as HTMLElement).dataset.area === name) as HTMLElement | undefined;
    if (!list || !line) return;
    // The list is the line's positioning parent (see .area-list), so this is the distance from the list's own top.
    const top = line.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + line.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + line.offsetHeight - list.clientHeight;
  };

  if (!rows) return <p className="loading">Loading rows…</p>;

  const checked = phoneColumns.length > 0;
  const rawPhones = own.filter(name => /phone|mobile|cell/i.test(name));
  const shownColumns = own.filter(name => !PLUMBING.test(name) && !phoneColumns.includes(name)).slice(0, checked ? 4 : 6);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * PAGE, current * PAGE + PAGE);
  const areaMax = Math.max(1, ...areas.map(item => item.count));
  const filtering = Boolean(area || verdict !== "all" || flag !== "all" || (column && contains) || query);
  const reset = () => { setArea(null); setVerdict("all"); setFlag("all"); setColumn(""); setContains(""); setQuery(""); setPage(0); };
  const change = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setPage(0); };

  /** What right-clicking a row offers: the cell under the pointer, the row, and (for a checked list) its number's mark. */
  function rowMenu(row: DatasetRow, marks: Marks, cellColumn: string | undefined): MenuItem[] {
    const value = cellColumn ? String(row.raw[cellColumn] ?? "").trim() : "";
    const number = marks.number;
    const items: MenuItem[] = [];
    if (cellColumn) {
      items.push(
        { label: `Copy this ${cellColumn}`, hint: value.length > 26 ? `${value.slice(0, 26)}…` : value, disabled: !value, onSelect: () => copyText(value) },
        { label: "Show only rows like this", hint: `${cellColumn} contains it`, disabled: !value, onSelect: () => { setColumn(cellColumn); setContains(value); setPage(0); } },
      );
    }
    items.push(
      { label: "Copy the number to call", hint: formatPhone(marks.best), disabled: !marks.best, onSelect: () => copyText(formatPhone(marks.best)) },
      { label: "Copy the whole row", onSelect: () => copyText(own.map(name => row.raw[name] ?? "").join("\t")) },
      { label: openRow === row.id ? "Hide the details" : "Show the details", onSelect: () => setOpenRow(openRow === row.id ? null : row.id) },
    );
    if (checked) {
      items.push("separator");
      // A mark belongs to the number, so a row with no readable number cannot be marked.
      for (const mark of MANUAL) items.push({ label: `Mark: ${MANUAL_LABELS[mark].toLowerCase()}`, checked: marks.manual === mark, disabled: !number, onSelect: () => number && turf.setMark(number, marks.manual === mark ? null : mark) });
      items.push({ label: "Remove the mark", disabled: !number || !marks.manual, onSelect: () => number && turf.setMark(number, null) });
    }
    return items;
  }

  return (
    <section className="list-view">
      <header className="list-head" onContextMenu={event => menu(event, [
        { label: "Rename", onSelect: () => { setNewName(dataset.name); setEditing("rename"); } },
        { label: "Copy the name", onSelect: () => copyText(dataset.name) },
        { label: "Check its phones in Skip Tracing", disabled: dataset.kind === "checked", onSelect: () => turf.open("skiptracing", dataset.id) },
        { label: "Clear the filters", disabled: !filtering, onSelect: reset },
        "separator",
        { label: "Delete this list", danger: true, onSelect: () => setEditing("delete") },
      ])}>
        <div>
          {editing === "rename" ? (
            <form className="row nowrap" onSubmit={event => { event.preventDefault(); void act(() => renameDataset(dataset.id, newName)); }}>
              <input className="input grow" autoFocus value={newName} aria-label="Name of the list" onChange={event => setNewName(event.target.value)} />
              <button type="submit" className="button small" disabled={working || !newName.trim()}>Save</button>
              <button type="button" className="button ghost small" onClick={() => setEditing(null)}>Cancel</button>
            </form>
          ) : <h1>{dataset.name}</h1>}
          <p>
            {KIND_LABELS[dataset.kind]} · {formatNumber(rows.length)} rows · {own.length} columns · {formatDate(dataset.created_at)}
            {parent && <> · checked copy of <button type="button" className="link" onClick={() => turf.select(parent.id)}>{parent.name}</button></>}
          </p>
          {editing === "delete" ? (
            <p className="notice" role="alertdialog" aria-label="Delete this list">
              <span>
                Delete <strong>{dataset.name}</strong> and its {formatNumber(dataset.row_count)} rows from this project? This cannot be undone.
                {copies > 0 && <> {copies === 1 ? "The list made from it stays" : `The ${copies} lists made from it stay`} as {copies === 1 ? "its" : "their"} own.</>}
              </span>
              <button type="button" className="button" disabled={working} onClick={() => void act(() => deleteDataset(dataset.id))}>{working ? "Deleting…" : "Yes, delete it"}</button>
              <button type="button" className="button ghost" disabled={working} onClick={() => setEditing(null)}>Keep it</button>
            </p>
          ) : editing === null && (
            <div className="row list-actions">
              <button type="button" className="button ghost small" onClick={() => { setNewName(dataset.name); setEditing("rename"); }}>Rename</button>
              <button type="button" className="button ghost small" onClick={() => setEditing("delete")}>Delete</button>
              <ListDownloads datasetId={dataset.id} checkedId={source.kind === "checked" ? source.id : undefined} fail={turf.fail} />
            </div>
          )}
        </div>
        {checked ? (
          <ul className="verdict-strip">
            {VERDICTS.map(item => (
              <li key={item}>
                <button type="button" aria-pressed={verdict === item} onClick={() => change(setVerdict)(verdict === item ? "all" : item)}>
                  <b>{formatNumber(marked.filter(entry => entry.marks.verdict === item).length)}</b>
                  <VerdictPill verdict={item} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="notice">
            {rawPhones.length ? (
              <>
                <span>No phone checks for this list yet, so its rows have no marks.</span>
                <button type="button" className="button" onClick={() => turf.open("skiptracing", dataset.id)}>Set up in Skip Tracing</button>
              </>
            ) : <span>This list has no phone columns, so there are no phone marks to show.</span>}
          </div>
        )}
      </header>

      {source.kind === "checked" && <p className="notice" role="status"><span>Showing {source.name}{checkedAt ? `, checked ${new Date(checkedAt).toLocaleString()}` : ""}. Saved verdicts reflect evidence at check time; new marks and DNC expiry may change them.</span><button type="button" className="button ghost" onClick={() => turf.open("skiptracing", parent?.id ?? source.parent_dataset_id ?? dataset.id)}>Review or check again</button></p>}

      <article className="card areas">
        <header>
          <h2>Areas</h2>
          <div className="row">
            {available.length > 0 && (
              <Segmented label="Area level" value={activeLevel ?? "zip"} onChange={value => { setLevel(value); change(setArea)(null); }}
                options={AREA_LEVELS.map(value => ({ value, label: AREA_LABELS[value], disabled: !areaMap[value] }))} />
            )}
            <button type="button" className="round" aria-label="Choose area columns" aria-expanded={mapping} onClick={() => setMapping(!mapping)}><Icon name="sliders" /></button>
          </div>
        </header>

        {(mapping || !available.length) && (
          <div className="mapping">
            {!available.length && <p><strong>This list has no state, city or ZIP column.</strong> Turf does not guess one. Pick the column for each level this list has.</p>}
            <div className="row">
              {AREA_LEVELS.map(item => (
                <Field key={item} label={`${AREA_LABELS[item]} column`} value={areaMap[item] ?? null} optional="None" options={own.map(name => ({ value: name, label: name }))}
                  onChange={value => turf.setAreaMap(dataset.id, { ...areaMap, [item]: value ?? undefined })} />
              ))}
            </div>
          </div>
        )}

        {available.length > 0 && (
          <div className="areas-body">
            <ul className="area-list" ref={areaList}>
              {areas.map(item => (
                <li key={item.name} data-area={item.name}>
                  <button type="button" aria-pressed={area === item.name} className={hoverArea === item.name ? "pointed" : undefined}
                    onMouseEnter={() => setHoverArea(item.name)} onMouseLeave={() => setHoverArea(null)}
                    onClick={() => change(setArea)(area === item.name ? null : item.name)}
                    onContextMenu={event => menu(event, [
                      { label: "Show only this area", disabled: area === item.name, onSelect: () => change(setArea)(item.name) },
                      { label: "Show every area", disabled: !area, onSelect: () => change(setArea)(null) },
                      { label: "Copy", hint: item.name, onSelect: () => copyText(item.name) },
                    ])}>
                    <span>{item.name}</span>
                    <i><b style={{ width: `${(item.count / areaMax) * 100}%` }} /></i>
                    <em>{formatNumber(item.count)}</em>
                  </button>
                </li>
              ))}
            </ul>
            <div className="areas-map">
              {dots.length && !plain ? (
                <Suspense fallback={<AreaMap dots={dots} />}>
                  <StreetMap spots={mapData.spots} points={mapData.points} outlines={zipOutlines.outlines} outlineCount={zipOutlines.count}
                    selected={area} hovered={hoverArea} onHover={pointFromMap} onSelect={name => change(setArea)(area === name ? null : name)}
                    fitKey={`${source.id}:${activeLevel}`} onUnavailable={() => setPlain(true)}
                    findExact={!position && addressColumns && located && located.addresses_to_look_up > 0 ? { count: located.addresses_to_look_up, onClick: () => setAsking(true) } : null} />
                </Suspense>
              ) : dots.length ? <AreaMap dots={dots} interactive /> : <Empty title="Nothing to put on the map">Rows are placed by their ZIP code or their address. This list has no ZIP column that is filled in.</Empty>}
            </div>
            {plain && dots.length > 0 && (
              <p className="muted map-note">
                The street map could not be loaded (it needs the internet), so the rows are on a plain plot.{" "}
                <button type="button" className="link" onClick={() => setPlain(false)}>Try the street map again</button>
              </p>
            )}
            <MapNote placement={placement} located={position ? null : located} columns={position ? null : addressColumns} datasetId={source.id} asking={asking} setAsking={setAsking}
              onLocated={() => setLookups(count => count + 1)} onError={turf.fail} />
          </div>
        )}
      </article>

      <article className="card table-card">
        <div className="filters">
          {checked && (
            <>
              <Select variant="pill" icon="phone" label="Verdict" value={verdict} onChange={change(setVerdict)}
                options={[{ value: "all", label: "Verdict" }, ...VERDICTS.map(item => ({ value: item, label: VERDICT_LABELS[item] }))]} />
              <Select variant="pill" icon="flag" label="Flag" value={flag} onChange={change(setFlag)}
                options={[{ value: "all", label: "Flag" }, { value: "callable", label: "Has a number to call" }, { value: "wrong", label: "Known wrong number" }, { value: "dnc", label: "Do not call" }, { value: "manual", label: "Marked by hand" }]} />
            </>
          )}
          <Select variant="pill" icon="layers" label="Column to filter" value={column} onChange={change(setColumn)} searchable={own.length > 8}
            options={[{ value: "", label: "Column" }, ...own.map(name => ({ value: name, label: name }))]} />
          {column && <input className="text" value={contains} placeholder={`${column} contains…`} aria-label={`${column} contains`} onChange={event => change(setContains)(event.target.value)} />}
          {area && <button type="button" className="chip" onClick={() => change(setArea)(null)}>{area}<Icon name="close" size={14} /></button>}
          <span className="grow" />
          <SearchBox value={query} onChange={change(setQuery)} placeholder="Search rows" />
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                {shownColumns.map(name => <th key={name}>{name}</th>)}
                {checked && <><th>Best phone</th><th>Phone quality</th><th>Combined verdict</th><th>Flags / calling restriction</th></>}
                <th><span className="sr-only">Details</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ row, marks }) => (
                <Fragment key={row.id}>
                  <tr className={openRow === row.id ? "open" : undefined} onContextMenu={event => menu(event, rowMenu(row, marks, (event.target as HTMLElement).closest("td")?.dataset.column))}>
                    <td className="num muted">{row.row_number}</td>
                    {shownColumns.map((name, index) => <td key={name} data-column={name}>{index === 0 ? <strong>{row.raw[name] ?? "–"}</strong> : formatCell(name, row.raw[name])}</td>)}
                    {checked && (
                      <>
                        <td>
                          {marks.best ? <div className="phone-cell"><strong>{formatPhone(marks.best)}{row.raw["Best phone extension"] ? ` ext. ${row.raw["Best phone extension"]}` : ""}</strong><small>{marks.why || "Nothing else is known about it"}</small></div>
                            : <div className="phone-cell"><span className="muted">No number to call</span><small>{marks.why}</small></div>}
                        </td>
                        <td>{row.raw["Best phone quality"] ? <VerdictPill verdict={row.raw["Best phone quality"] as Verdict} /> : <span className="muted">Check again for separate quality</span>}</td>
                        <td><VerdictPill verdict={marks.verdict} /></td>
                        <td>
                          <div className="flags">
                            {marks.knownWrong && <span className="pill pill-wrong">Wrong number</span>}
                            {marks.doNotCall && <span className="pill pill-wrong">Do not call{marks.doNotCallUntil ? ` until ${marks.doNotCallUntil}` : ""}</span>}
                            {marks.manual === "called" && <span className="pill pill-none">Called</span>}
                            {marks.manual === "interested" && <span className="pill pill-corroborated">Interested</span>}
                            {row.raw["Phone evidence warnings"] && <span className="pill pill-suspicious">Review dated evidence</span>}
                          </div>
                        </td>
                      </>
                    )}
                    <td className="num">
                      <button type="button" className="round" aria-label={`Details for row ${row.row_number}`} aria-expanded={openRow === row.id} onClick={() => setOpenRow(openRow === row.id ? null : row.id)}><Icon name="sliders" /></button>
                    </td>
                  </tr>
                  {openRow === row.id && (
                    <tr className="detail">
                      <td colSpan={shownColumns.length + (checked ? 6 : 2)}>
                        <RowDetail row={row} datasetId={source.id} onUpdated={turf.refresh} own={own} phoneColumns={phoneColumns} number={marks.number} manual={turf.manual} onMark={turf.setMark} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {!filtered.length && <Empty title="No rows match">{filtering && <button type="button" className="link" onClick={reset}>Clear the filters</button>}</Empty>}
        </div>

        <footer className="pager">
          <span>{formatNumber(filtered.length)} of {formatNumber(rows.length)} rows{filtering && <> · <button type="button" className="link" onClick={reset}>Clear filters</button></>}</span>
          <div className="row">
            <button type="button" className="button ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button>
            <span>Page {current + 1} of {pages}</span>
            <button type="button" className="button ghost" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</button>
          </div>
        </footer>
      </article>
    </section>
  );
}

/** Under the map: how the rows were placed, which were left off and why, and the lookup of exact addresses. */
function MapNote({ placement, located, columns, datasetId, asking, setAsking, onLocated, onError }: {
  placement: ReturnType<typeof placeRows>; located: Located | null; columns: AddressColumns | null; datasetId: string;
  asking: boolean; setAsking: (asking: boolean) => void;
  onLocated: () => void; onError: (reason: unknown) => void;
}) {
  const [progress, setProgress] = useState<LocateProgress | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const waiting = located?.addresses_to_look_up ?? 0;
  const n = formatNumber;
  const placed = [
    placement.own && `${n(placement.own)} by their own coordinates`,
    placement.exact && `${n(placement.exact)} at their exact address`,
    placement.byZip && `${n(placement.byZip)} at the centre of their ZIP`,
  ].filter(Boolean);
  const left = [
    placement.stateDisagrees && `${n(placement.stateDisagrees)} whose ZIP is not in their state`,
    placement.unknownZip && `${n(placement.unknownZip)} with a ZIP that is not a known area`,
    placement.noZip && `${n(placement.noZip)} with no ZIP`,
  ].filter(Boolean);

  async function locate() {
    if (!columns) return;
    setAsking(false);
    setResult(null);
    setProgress({ done: 0, total: waiting, found: 0 });
    try {
      const done = await locateAddresses(datasetId, columns, setProgress, setJobId);
      setResult(`Looked up ${n(done.looked_up)} addresses: ${n(done.found)} found, ${n(done.not_found)} not matched in their own state and ZIP.`);
    } catch (reason) {
      // Cancelling is not an error. What was found before it stopped is kept either way.
      if (reason instanceof Error && /cancel/i.test(reason.message)) setResult("Stopped. The addresses found so far are kept.");
      else onError(reason);
    }
    setProgress(null);
    setJobId(null);
    onLocated();
  }

  return (
    <div className="map-note">
      {placed.length > 0 && <p><strong>On the map:</strong> {placed.join(", ")}.</p>}
      {left.length > 0 && <p className="muted"><strong>Left off:</strong> {left.join(", ")}.</p>}
      {progress ? (
        <p className="notice" role="status">
          <span>Looking up addresses: {n(progress.done)} of {n(progress.total)} · {n(progress.found)} found</span>
          <button type="button" className="button ghost small" disabled={!jobId} onClick={() => jobId && void cancelJob(jobId).catch(onError)}>Stop</button>
        </p>
      ) : asking ? (
        <p className="notice" role="alertdialog" aria-label="Look up exact addresses" ref={element => element?.scrollIntoView?.({ block: "nearest", behavior: "smooth" })}>
          <span>
            This sends the street, city, state and ZIP of {n(waiting)} addresses to the US Census Bureau&apos;s geocoder over the internet. Names and phone
            numbers are not sent. A long list takes several minutes; you can stop at any time and keep what was found.
          </span>
          <button type="button" className="button small" onClick={() => void locate()}>Send and look up</button>
          <button type="button" className="button ghost small" onClick={() => setAsking(false)}>Not now</button>
        </p>
      ) : columns && waiting > 0 ? (
        <p className="row">
          <button type="button" className="button ghost small" onClick={() => setAsking(true)}>Find exact addresses</button>
          <span className="muted">{n(waiting)} addresses not looked up yet.</span>
        </p>
      ) : null}
      {result && <p className="muted" role="status">{result}</p>}
    </div>
  );
}

function formatCell(name: string, value: string | number | null) {
  if (value === null || value === "") return <span className="muted">–</span>;
  if (/price|value|zestimate/i.test(name) && typeof value === "number") return `$${formatNumber(value)}`;
  return typeof value === "number" && !/zip|year/i.test(name) ? formatNumber(value) : value;
}

function RowDetail({ row, own, phoneColumns, number, manual, onMark, datasetId, onUpdated }: {
  row: DatasetRow; own: string[]; phoneColumns: string[]; number: string | null; manual: Turf["manual"]; onMark: Turf["setMark"];
  datasetId: string; onUpdated: () => Promise<void>;
}) {
  const numbers = [...new Set(phoneColumns.flatMap(column => String(row.raw[`${column} (E.164)`] ?? "").split(";").map(value => value.trim()).filter(value => /^\+\d{6,15}$/.test(value))))];
  const [chosen, setChosen] = useState(number ?? numbers[0] ?? "");
  const activeNumber = numbers.includes(chosen) ? chosen : number ?? numbers[0] ?? "";
  const mark = manual[activeNumber]?.mark ?? null;
  return (
    <div className="row-detail">
      <dl>
        {own.map(name => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{/url/i.test(name) && row.raw[name] ? <a href={String(row.raw[name])} target="_blank" rel="noreferrer">{row.raw[name]}</a> : row.raw[name] ?? "–"}</dd>
          </div>
        ))}
      </dl>
      {phoneColumns.length > 0 && (
        <div className="detail-side">
          <PhoneChoices raw={row.raw} datasetId={datasetId} rowNumber={row.row_number} onSaved={onUpdated} />
          <h3>Phone checks</h3>
          <ul className="phone-checks">
            {phoneColumns.filter(name => row.raw[`${name} (verdict)`]).map(name => (
              <li key={name}>
                <div><strong>{name}</strong> {formatPhone(row.raw[`${name} (E.164)`] ? String(row.raw[`${name} (E.164)`]) : null) || row.raw[name]} <small>{row.raw[`${name} (type)`]}</small></div>
                <VerdictPill verdict={row.raw[`${name} (verdict)`] as never} />
                <p>{row.raw[`${name} (why)`]}</p>
              </li>
            ))}
          </ul>
          <h3>Mark this number</h3>
          {activeNumber ? (
            <>
              {numbers.length > 1 && <Field label="Number to mark" value={activeNumber} onChange={value => setChosen(value ?? "")} options={numbers.map(value => ({ value, label: formatPhone(value) }))} />}
              <div className="mark-buttons">
                {MANUAL.map(item => (
                  <button key={item} type="button" className="button ghost" aria-pressed={mark === item} onClick={() => onMark(activeNumber, mark === item ? null : item)}>
                    {mark === item && <Icon name="check" size={14} />}{MANUAL_LABELS[item]}
                  </button>
                ))}
              </div>
              {mark === "do_not_call" && <label className="field"><span>Do-not-call end date (optional)</span><input className="input" type="date" value={manual[activeNumber]?.until ?? ""} onChange={event => onMark(activeNumber, "do_not_call", event.target.value || null)} /></label>}
              <p className="muted">The mark is kept for {formatPhone(activeNumber)} across this project's lists and used by the next phone check. Called alone does not prove a person answered. Previous marks are kept in history.</p>
            </>
          ) : <p className="muted">This row has no readable number to mark.</p>}
        </div>
      )}
    </div>
  );
}
