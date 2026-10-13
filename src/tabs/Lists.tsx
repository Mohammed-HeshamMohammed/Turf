import { ListRowDetail } from "../components/ListRowDetail";
import { MapNote } from "../components/MapNote";
import { dullColumns, formatCell } from "../lib/list-columns";
import { Fragment, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import type { Turf } from "../App";
import { AreaMap } from "../components/AreaMap";
import { Empty, Field, SearchBox, Segmented, VerdictPill } from "../components/Bits";
import { copyText, useContextMenu, type MenuItem } from "../components/ContextMenu";
import { Select } from "../components/Select";
import {
  gatherForMap,
  locateAddresses,
  locatedAddresses,
  placeRows,
  priceColumn,
  streetColumn,
  useZipCentres,
  useZipOutlines,
  type AddressColumns,
  type Located,
} from "../lib/geo";
import { deleteDataset, renameDataset } from "../lib/service";
import { Icon } from "../components/Icon";
import { ListPicker } from "../components/ListPicker";
import { ListDownloads } from "../components/ListDownloads";
import { marksSource, useListSetups, useOwnerIndex, usePhotoIndex, useRows, useVisited } from "../lib/hooks";
import { photoColumns, photosFor, placeColumns } from "../lib/photos";
import { PropertyPhoto } from "../components/PropertyPhoto";
import {
  AREA_LABELS,
  AREA_LEVELS,
  KIND_LABELS,
  MANUAL_MARKS,
  MANUAL_LABELS,
  VERDICT_LABELS,
  areaColumns,
  checkedPhoneColumns,
  countAreas,
  formatDate,
  formatNumber,
  formatPhone,
  ownColumns,
  positionColumns,
  readMarks,
  type Marks,
} from "../lib/marks";
import { VERDICTS, type AreaLevel, type Dataset, type DatasetRow, type Verdict } from "../lib/types";

// The street map and its library are fetched the first time a map is shown, not when the app starts.
const StreetMap = lazy(() => import("../components/StreetMap").then(module => ({ default: module.StreetMap })));

const PAGE = 25;
const PLUMBING = /^(zpid|latitude|longitude|image|detail url)$/i;

export function Lists({ turf }: { turf: Turf }) {
  const dataset = turf.datasets.find(item => item.id === turf.selectedId) ?? null;
  // Lists looked at lately stay alive behind the one in view, so going back to one is instant and keeps its filters.
  const kept = useVisited(
    dataset?.id ?? null,
    turf.datasets.map(item => item.id),
  );
  return (
    <div className="split">
      <ListPicker
        datasets={turf.datasets}
        selectedId={turf.selectedId}
        onSelect={turf.select}
        onImported={async id => {
          await turf.refresh();
          turf.select(id);
        }}
        menuFor={item => [
          { label: "Open", disabled: item.id === dataset?.id, onSelect: () => turf.select(item.id) },
          { label: "Check its phones in Skip Tracing", disabled: item.kind === "checked", onSelect: () => turf.open("skiptracing", item.id) },
          { label: "Copy its name", onSelect: () => copyText(item.name) },
        ]}
      />
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
    try {
      return source.derivation_json ? (JSON.parse(source.derivation_json).checked_at as string | undefined) : undefined;
    } catch {
      return undefined;
    }
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
  const dull = useMemo(() => dullColumns(own, rows?.map(row => row.raw) ?? []), [own, rows]);
  // Pictures: the list's own picture columns, and the project's photos by place for rows that have none.
  const photoCols = useMemo(() => photoColumns(rows ?? [], own), [rows, own]);
  const place = useMemo(() => placeColumns(columns, turf.areaMaps[dataset.id]), [columns, turf.areaMaps, dataset.id]);
  const photoIndex = usePhotoIndex(turf.datasets, turf.areaMaps, turf.fail);
  // Owners: what the name and mail show, and what other lists in the project have for the same owner.
  const setups = useListSetups(turf.datasets, turf.version);
  const owners = useOwnerIndex(turf.datasets, setups, turf.areaMaps, turf.fail);
  const ownerCols = owners?.lists.find(item => item.dataset.id === dataset.id)?.columns ?? null;
  // Mailing addresses, looked up with the same free US Census geocoder as the map: one the Census cannot find is worth a look.
  const mailColumns = useMemo<AddressColumns | null>(() => {
    const mail = ownerCols?.mail;
    return mail?.street && (mail.zip || (mail.city && mail.state)) ? { street: mail.street, city: mail.city, state: mail.state, zip: mail.zip } : null;
  }, [ownerCols]);
  const [mailLocated, setMailLocated] = useState<Located | null>(null);
  const [mailLookups, setMailLookups] = useState(0);
  const [mailProgress, setMailProgress] = useState<string | null>(null);
  useEffect(() => {
    if (!mailColumns) return;
    let current = true;
    locatedAddresses(source.id, mailColumns).then(result => current && setMailLocated(result), turf.fail);
    return () => {
      current = false;
    };
  }, [source.id, mailColumns, mailLookups, turf.fail]);
  const lookUpMail = async () => {
    if (!mailColumns) return;
    setMailProgress("Starting…");
    try {
      const result = await locateAddresses(
        source.id,
        mailColumns,
        progress => setMailProgress(`${progress.done} of ${progress.total} looked up`),
        () => undefined,
      );
      setMailProgress(`${result.found} of ${result.looked_up} mailing addresses found`);
      setMailLookups(count => count + 1);
    } catch (reason) {
      setMailProgress(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const phoneColumns = useMemo(() => checkedPhoneColumns(columns), [columns]);
  const areaMap = useMemo(() => areaColumns(columns, turf.areaMaps[dataset.id]), [columns, turf.areaMaps, dataset.id]);
  const position = useMemo(() => positionColumns(columns), [columns]);
  const available = AREA_LEVELS.filter(item => areaMap[item]);
  const activeLevel = level && areaMap[level] ? level : (available.at(-1) ?? null);
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
      // A lead written more than once: its repeats alone, or the list with each lead once (the kept row stays).
      const repeats = String(row.raw["Duplicate status"] ?? "").startsWith("Duplicate of");
      if (flag === "repeat" && !repeats) return false;
      if (flag === "once" && repeats) return false;
      if (flag === "possible" && !String(row.raw["Duplicate status"] ?? "").startsWith("Possible")) return false;
      if (
        column &&
        part &&
        !String(row.raw[column] ?? "")
          .toLowerCase()
          .includes(part)
      )
        return false;
      if (
        needle &&
        !own.some(name =>
          String(row.raw[name] ?? "")
            .toLowerCase()
            .includes(needle),
        )
      )
        return false;
      return true;
    });
  }, [marked, verdict, flag, column, contains, query, own]);
  const filtered = useMemo(
    () => (area && areaColumn ? filteredIgnoringArea.filter(({ row }) => String(row.raw[areaColumn] ?? "").trim() === area) : filteredIgnoringArea),
    [filteredIgnoringArea, area, areaColumn],
  );

  // Where each row goes on the map: its own coordinates, its exact address once looked up, or its ZIP's centre.
  const zipValues = useMemo(
    () => (areaMap.zip && rows ? [...new Set(rows.map(row => String(row.raw[areaMap.zip!] ?? "").trim()).filter(Boolean))] : []),
    [rows, areaMap.zip],
  );
  const centres = useZipCentres(zipValues, turf.fail);
  const known = zipValues.filter(value => centres.has(value)).length;
  const addressColumns = useMemo<AddressColumns | null>(() => {
    const street = streetColumn(own);
    return street && (areaMap.zip || (areaMap.city && areaMap.state)) ? { street, city: areaMap.city, state: areaMap.state, zip: areaMap.zip } : null;
  }, [own, areaMap]);
  const [located, setLocated] = useState<Located | null>(null);
  const [lookups, setLookups] = useState(0);
  const [lookup, setLookup] = useState<string | null>(null);
  // The street background needs the internet. Without it the rows are drawn on a plain plot instead.
  const [plain, setPlain] = useState(false);
  useEffect(() => {
    if (!addressColumns || position) return;
    let current = true;
    locatedAddresses(source.id, addressColumns).then(result => current && setLocated(result), turf.fail);
    return () => {
      current = false;
    };
  }, [source.id, addressColumns, position, lookups, turf.fail]);
  const placement = useMemo(
    () =>
      placeRows(rows ?? [], {
        position,
        zipColumn: areaMap.zip,
        stateColumn: areaMap.state,
        centres,
        exact: located?.exact,
        streetColumn: addressColumns?.street,
        tagColumn: priceColumn(own),
      }),
    // `known` changes as ZIP centres arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, position, areaMap.zip, areaMap.state, centres, known, located, addressColumns, own],
  );
  const dots = useMemo(() => {
    const kept = new Set(filtered.map(item => item.row.id));
    return placement.dots.map(dot => ({ lon: dot.lon, lat: dot.lat, dim: !kept.has(dot.rowId) }));
  }, [placement, filtered]);
  // For the street map: each property at its own address, and the same rows gathered by ZIP, city and state. Areas are
  // named at the level the list is on. The area filter itself is left out of the count, so choosing an area does not
  // grey the others.
  const mapData = useMemo(
    () =>
      gatherForMap(
        [{ rows: rows ?? [], dots: placement.dots, columns: areaMap, named: areaColumn, kept: new Set(filteredIgnoringArea.map(item => item.row.id)) }],
        centres,
      ),
    // `known` changes as ZIP centres arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, placement, filteredIgnoringArea, areaColumn, areaMap, centres, known],
  );
  const zipOutlines = useZipOutlines(mapData.zips, turf.fail);
  // The area pointed at, in the list or on the map; each outlines it in the other.
  const [hoverArea, setHoverArea] = useState<string | null>(null);
  const areaList = useRef<HTMLUListElement>(null);
  /** Brings an area's line into view inside the list when it is pointed at on the map. Only the list itself moves:
   * the page must never scroll because the pointer passed over something. */
  const pointFromMap = (name: string | null) => {
    setHoverArea(name);
    const list = areaList.current;
    const line = name === null ? null : ([...(list?.children ?? [])].find(item => (item as HTMLElement).dataset.area === name) as HTMLElement | undefined);
    if (!list || !line) return;
    // The list is the line's positioning parent (see .area-list), so this is the distance from the list's own top.
    const top = line.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + line.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + line.offsetHeight - list.clientHeight;
  };

  if (!rows) return <p className="loading">Loading rows…</p>;

  const checked = phoneColumns.length > 0;
  const hasDuplicates = columns.includes("Duplicate status");
  const rawPhones = own.filter(name => /phone|mobile|cell/i.test(name));
  const shownColumns = own
    .filter(name => !PLUMBING.test(name) && !phoneColumns.includes(name) && !dull.has(name) && !photoCols.includes(name))
    .slice(0, checked ? 4 : 6);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * PAGE, current * PAGE + PAGE);
  const showPhotos =
    photoCols.length > 0 || visible.some(({ row }) => photosFor(row, [], place, photoIndex, located?.exact?.[String(row.row_number)]).photos.length > 0);
  const areaMax = Math.max(1, ...areas.map(item => item.count));
  const filtering = Boolean(area || verdict !== "all" || flag !== "all" || (column && contains) || query);
  const reset = () => {
    setArea(null);
    setVerdict("all");
    setFlag("all");
    setColumn("");
    setContains("");
    setQuery("");
    setPage(0);
  };
  const change =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setPage(0);
    };

  /** What right-clicking a row offers: the cell under the pointer, the row, and (for a checked list) its number's mark. */
  function rowMenu(row: DatasetRow, marks: Marks, cellColumn: string | undefined): MenuItem[] {
    const value = cellColumn ? String(row.raw[cellColumn] ?? "").trim() : "";
    const number = marks.number;
    const items: MenuItem[] = [];
    if (cellColumn) {
      items.push(
        { label: `Copy this ${cellColumn}`, hint: value.length > 26 ? `${value.slice(0, 26)}…` : value, disabled: !value, onSelect: () => copyText(value) },
        {
          label: "Show only rows like this",
          hint: `${cellColumn} contains it`,
          disabled: !value,
          onSelect: () => {
            setColumn(cellColumn);
            setContains(value);
            setPage(0);
          },
        },
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
      for (const mark of MANUAL_MARKS)
        items.push({
          label: `Mark: ${MANUAL_LABELS[mark].toLowerCase()}`,
          checked: marks.manual === mark,
          disabled: !number,
          onSelect: () => number && turf.setMark(number, marks.manual === mark ? null : mark),
        });
      items.push({ label: "Remove the mark", disabled: !number || !marks.manual, onSelect: () => number && turf.setMark(number, null) });
    }
    return items;
  }

  return (
    <section className="list-view">
      <header
        className="list-head"
        onContextMenu={event =>
          menu(event, [
            {
              label: "Rename",
              onSelect: () => {
                setNewName(dataset.name);
                setEditing("rename");
              },
            },
            { label: "Copy the name", onSelect: () => copyText(dataset.name) },
            { label: "Check its phones in Skip Tracing", disabled: dataset.kind === "checked", onSelect: () => turf.open("skiptracing", dataset.id) },
            { label: "Clear the filters", disabled: !filtering, onSelect: reset },
            "separator",
            { label: "Delete this list", danger: true, onSelect: () => setEditing("delete") },
          ])
        }
      >
        <div>
          {editing === "rename" ? (
            <form
              className="row nowrap"
              onSubmit={event => {
                event.preventDefault();
                void act(() => renameDataset(dataset.id, newName));
              }}
            >
              <input className="input grow" autoFocus value={newName} aria-label="Name of the list" onChange={event => setNewName(event.target.value)} />
              <button type="submit" className="button small" disabled={working || !newName.trim()}>
                Save
              </button>
              <button type="button" className="button ghost small" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <h1>{dataset.name}</h1>
          )}
          <p>
            {KIND_LABELS[dataset.kind]} · {formatNumber(rows.length)} rows · {own.length} columns · {formatDate(dataset.created_at)}
            {parent && (
              <>
                {" "}
                · checked copy of{" "}
                <button type="button" className="link" onClick={() => turf.select(parent.id)}>
                  {parent.name}
                </button>
              </>
            )}
          </p>
          {editing === "delete" ? (
            <p className="notice" role="alertdialog" aria-label="Delete this list">
              <span>
                Delete <strong>{dataset.name}</strong> and its {formatNumber(dataset.row_count)} rows from this project? This cannot be undone.
                {copies > 0 && (
                  <>
                    {" "}
                    {copies === 1 ? "The list made from it stays" : `The ${copies} lists made from it stay`} as {copies === 1 ? "its" : "their"} own.
                  </>
                )}
              </span>
              <button type="button" className="button" disabled={working} onClick={() => void act(() => deleteDataset(dataset.id))}>
                {working ? "Deleting…" : "Yes, delete it"}
              </button>
              <button type="button" className="button ghost" disabled={working} onClick={() => setEditing(null)}>
                Keep it
              </button>
            </p>
          ) : (
            editing === null && (
              <div className="row list-actions">
                <button
                  type="button"
                  className="button ghost small"
                  onClick={() => {
                    setNewName(dataset.name);
                    setEditing("rename");
                  }}
                >
                  Rename
                </button>
                <button type="button" className="button ghost small" onClick={() => setEditing("delete")}>
                  Delete
                </button>
                <ListDownloads datasetId={dataset.id} checkedId={source.kind === "checked" ? source.id : undefined} fail={turf.fail} />
              </div>
            )
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
                <button type="button" className="button" onClick={() => turf.open("skiptracing", dataset.id)}>
                  Set up in Skip Tracing
                </button>
              </>
            ) : (
              <span>This list has no phone columns, so there are no phone marks to show.</span>
            )}
          </div>
        )}
      </header>

      {source.kind === "checked" && (
        <p className="notice" role="status">
          <span>
            Showing {source.name}
            {checkedAt ? `, checked ${new Date(checkedAt).toLocaleString()}` : ""}. Saved verdicts reflect evidence at check time; new marks and DNC expiry may
            change them.
          </span>
          <button type="button" className="button ghost" onClick={() => turf.open("skiptracing", parent?.id ?? source.parent_dataset_id ?? dataset.id)}>
            Review or check again
          </button>
        </p>
      )}

      <article className="card areas">
        <header>
          <h2>Areas</h2>
          <div className="row">
            {available.length > 0 && (
              <Segmented
                label="Area level"
                value={activeLevel ?? "zip"}
                onChange={value => {
                  setLevel(value);
                  change(setArea)(null);
                }}
                options={AREA_LEVELS.map(value => ({ value, label: AREA_LABELS[value], disabled: !areaMap[value] }))}
              />
            )}
            <button type="button" className="round" aria-label="Choose area columns" aria-expanded={mapping} onClick={() => setMapping(!mapping)}>
              <Icon name="sliders" />
            </button>
          </div>
        </header>

        {(mapping || !available.length) && (
          <div className="mapping">
            {!available.length && (
              <p>
                <strong>This list has no state, city or ZIP column.</strong> Turf does not guess one. Pick the column for each level this list has.
              </p>
            )}
            <div className="row">
              {AREA_LEVELS.map(item => (
                <Field
                  key={item}
                  label={`${AREA_LABELS[item]} column`}
                  value={areaMap[item] ?? null}
                  optional="None"
                  options={own.map(name => ({ value: name, label: name }))}
                  onChange={value => turf.setAreaMap(dataset.id, { ...areaMap, [item]: value ?? undefined })}
                />
              ))}
            </div>
          </div>
        )}

        {available.length > 0 && (
          <div className="areas-body">
            <ul className="area-list" ref={areaList}>
              {areas.map(item => (
                <li key={item.name} data-area={item.name}>
                  <button
                    type="button"
                    aria-pressed={area === item.name}
                    className={hoverArea === item.name ? "pointed" : undefined}
                    onMouseEnter={() => setHoverArea(item.name)}
                    onMouseLeave={() => setHoverArea(null)}
                    onClick={() => change(setArea)(area === item.name ? null : item.name)}
                    onContextMenu={event =>
                      menu(event, [
                        { label: "Show only this area", disabled: area === item.name, onSelect: () => change(setArea)(item.name) },
                        { label: "Show every area", disabled: !area, onSelect: () => change(setArea)(null) },
                        { label: "Copy", hint: item.name, onSelect: () => copyText(item.name) },
                      ])
                    }
                  >
                    <span>{item.name}</span>
                    <i>
                      <b style={{ width: `${(item.count / areaMax) * 100}%` }} />
                    </i>
                    <em>{formatNumber(item.count)}</em>
                  </button>
                </li>
              ))}
            </ul>
            <div className="areas-map">
              {dots.length && !plain ? (
                <Suspense fallback={<AreaMap dots={dots} />}>
                  <StreetMap
                    spots={mapData.spots}
                    points={mapData.points}
                    outlines={zipOutlines.outlines}
                    outlineCount={zipOutlines.count}
                    selected={area}
                    hovered={hoverArea}
                    onHover={pointFromMap}
                    onSelect={name => change(setArea)(area === name ? null : name)}
                    fitKey={`${source.id}:${activeLevel}`}
                    onUnavailable={() => setPlain(true)}
                    lookup={lookup}
                    cities={mapData.cities}
                    states={mapData.states}
                  />
                </Suspense>
              ) : dots.length ? (
                <AreaMap dots={dots} interactive />
              ) : (
                <Empty title="Nothing to put on the map">
                  Rows are placed by their ZIP code or their address. This list has no ZIP column that is filled in.
                </Empty>
              )}
            </div>
            {plain && dots.length > 0 && (
              <p className="muted map-note">
                The street map could not be loaded (it needs the internet), so the rows are on a plain plot.{" "}
                <button type="button" className="link" onClick={() => setPlain(false)}>
                  Try the street map again
                </button>
              </p>
            )}
            <MapNote
              placement={placement}
              located={position ? null : located}
              columns={position ? null : addressColumns}
              datasetId={source.id}
              onStatus={setLookup}
              onLocated={() => setLookups(count => count + 1)}
              onError={turf.fail}
            />
          </div>
        )}
      </article>

      <article className="card table-card">
        <div className="filters">
          {checked && (
            <>
              <Select
                variant="pill"
                icon="phone"
                label="Verdict"
                value={verdict}
                onChange={change(setVerdict)}
                options={[{ value: "all", label: "Verdict" }, ...VERDICTS.map(item => ({ value: item, label: VERDICT_LABELS[item] }))]}
              />
              <Select
                variant="pill"
                icon="flag"
                label="Flag"
                value={flag}
                onChange={change(setFlag)}
                options={[
                  { value: "all", label: "Flag" },
                  { value: "callable", label: "Has a number to call" },
                  { value: "wrong", label: "Known wrong number" },
                  { value: "dnc", label: "Do not call" },
                  { value: "manual", label: "Marked by hand" },
                  ...(hasDuplicates
                    ? [
                        { value: "once", label: "Each lead once (repeats left out)" },
                        { value: "repeat", label: "Repeats another row" },
                        { value: "possible", label: "Might repeat another row" },
                      ]
                    : []),
                ]}
              />
            </>
          )}
          <Select
            variant="pill"
            icon="layers"
            label="Column to filter"
            value={column}
            onChange={change(setColumn)}
            searchable={own.length > 8}
            options={[{ value: "", label: "Column" }, ...own.map(name => ({ value: name, label: name }))]}
          />
          {column && (
            <input
              className="text"
              value={contains}
              placeholder={`${column} contains…`}
              aria-label={`${column} contains`}
              onChange={event => change(setContains)(event.target.value)}
            />
          )}
          {area && (
            <button type="button" className="chip" onClick={() => change(setArea)(null)}>
              {area}
              <Icon name="close" size={14} />
            </button>
          )}
          <span className="grow" />
          <SearchBox value={query} onChange={change(setQuery)} placeholder="Search rows" />
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                {showPhotos && (
                  <th>
                    <span className="sr-only">Photo</span>
                  </th>
                )}
                {shownColumns.map(name => (
                  <th key={name}>{name}</th>
                ))}
                {checked && (
                  <>
                    <th>Best phone</th>
                    <th>Phone quality</th>
                    <th>Combined verdict</th>
                    <th>Flags / calling restriction</th>
                  </>
                )}
                <th>
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ row, marks }) => (
                <Fragment key={row.id}>
                  <tr
                    className={openRow === row.id ? "open" : undefined}
                    onContextMenu={event => menu(event, rowMenu(row, marks, (event.target as HTMLElement).closest("td")?.dataset.column))}
                  >
                    <td className="num muted">{row.row_number}</td>
                    {showPhotos && (
                      <td className="photo-cell">
                        {(() => {
                          const found = photosFor(row, photoCols, place, photoIndex, located?.exact?.[String(row.row_number)]);
                          return found.photos.length ? (
                            <PropertyPhoto photos={found.photos} label={`Row ${row.row_number}`} borrowed={found.borrowed} className="thumb" />
                          ) : null;
                        })()}
                      </td>
                    )}
                    {shownColumns.map((name, index) => (
                      <td key={name} data-column={name}>
                        {index === 0 ? <strong>{row.raw[name] ?? "–"}</strong> : formatCell(name, row.raw[name])}
                      </td>
                    ))}
                    {checked && (
                      <>
                        <td>
                          {marks.best ? (
                            <div className="phone-cell">
                              <strong>
                                {formatPhone(marks.best)}
                                {row.raw["Best phone extension"] ? ` ext. ${row.raw["Best phone extension"]}` : ""}
                              </strong>
                              <small>{marks.why || "Nothing else is known about it"}</small>
                            </div>
                          ) : (
                            <div className="phone-cell">
                              <span className="muted">No number to call</span>
                              <small>{marks.why}</small>
                            </div>
                          )}
                        </td>
                        <td>
                          {row.raw["Best phone quality"] ? (
                            <VerdictPill verdict={row.raw["Best phone quality"] as Verdict} />
                          ) : (
                            <span className="muted">Check again for separate quality</span>
                          )}
                        </td>
                        <td>
                          <VerdictPill verdict={marks.verdict} />
                        </td>
                        <td>
                          <div className="flags">
                            {marks.knownWrong && <span className="pill pill-wrong">Wrong number</span>}
                            {marks.doNotCall && (
                              <span className="pill pill-wrong">Do not call{marks.doNotCallUntil ? ` until ${marks.doNotCallUntil}` : ""}</span>
                            )}
                            {marks.manual === "called" && <span className="pill pill-none">Called</span>}
                            {marks.manual === "interested" && <span className="pill pill-corroborated">Interested</span>}
                            {row.raw["Phone evidence warnings"] && <span className="pill pill-suspicious">Review dated evidence</span>}
                            {row.raw["Duplicate status"] && row.raw["Duplicate status"] !== "Keep" && (
                              <span
                                className={String(row.raw["Duplicate status"]).startsWith("Possible") ? "pill pill-suspicious" : "pill pill-none"}
                                title={String(row.raw["Duplicate why"] ?? "")}
                              >
                                {row.raw["Duplicate status"]}
                              </span>
                            )}
                            {row.raw["Duplicate status"] === "Keep" && (
                              <span className="pill pill-none" title={String(row.raw["Duplicate why"] ?? "")}>
                                Kept of {row.raw["Duplicate group"]}
                              </span>
                            )}
                          </div>
                        </td>
                      </>
                    )}
                    <td className="num">
                      <button
                        type="button"
                        className="round"
                        aria-label={`Details for row ${row.row_number}`}
                        aria-expanded={openRow === row.id}
                        onClick={() => setOpenRow(openRow === row.id ? null : row.id)}
                      >
                        <Icon name="sliders" />
                      </button>
                    </td>
                  </tr>
                  {openRow === row.id && (
                    <tr className="detail">
                      <td colSpan={shownColumns.length + (checked ? 6 : 2) + (showPhotos ? 1 : 0)}>
                        <ListRowDetail
                          row={row}
                          datasetId={source.id}
                          onUpdated={turf.refresh}
                          own={own}
                          phoneColumns={phoneColumns}
                          number={marks.number}
                          manual={turf.manual}
                          onMark={turf.setMark}
                          photos={{ columns: photoCols, place, index: photoIndex, exact: located?.exact?.[String(row.row_number)] }}
                          owner={
                            owners && ownerCols
                              ? {
                                  columns: ownerCols,
                                  index: owners.index,
                                  datasetId: dataset.id,
                                  mail: mailColumns
                                    ? {
                                        found: Boolean(mailLocated?.exact[String(row.row_number)]),
                                        missing: Boolean(mailLocated?.not_found?.includes(row.row_number)),
                                        waiting: mailLocated?.addresses_to_look_up ?? 0,
                                        progress: mailProgress,
                                        lookUp: lookUpMail,
                                      }
                                    : null,
                                }
                              : null
                          }
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {!filtered.length && (
            <Empty title="No rows match">
              {filtering && (
                <button type="button" className="link" onClick={reset}>
                  Clear the filters
                </button>
              )}
            </Empty>
          )}
        </div>

        <footer className="pager">
          <span>
            {formatNumber(filtered.length)} of {formatNumber(rows.length)} rows
            {filtering && (
              <>
                {" "}
                ·{" "}
                <button type="button" className="link" onClick={reset}>
                  Clear filters
                </button>
              </>
            )}
          </span>
          <div className="row">
            <button type="button" className="button ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>
              Previous
            </button>
            <span>
              Page {current + 1} of {pages}
            </span>
            <button type="button" className="button ghost" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
              Next
            </button>
          </div>
        </footer>
      </article>
    </section>
  );
}
