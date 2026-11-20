import { Fragment, Suspense, lazy, useEffect, useMemo, useState } from "react";
import type { CallerWhale } from "../App";
import { reachContext } from "../lib/dashboard";
import { placesForMap, useZipCentres, useZipOutlines } from "../lib/geo";
import { marksSource, reachPayload, useListSetups } from "../lib/hooks";
import { formatCell } from "../lib/list-columns";
import {
  AREA_LABELS,
  AREA_LEVELS,
  KIND_LABELS,
  VERDICT_LABELS,
  areaColumns,
  checkedPhoneColumns,
  formatDate,
  formatNumber,
  formatPhone,
  ownColumns,
  readMarks,
} from "../lib/marks";
import { photoColumns, placeColumns } from "../lib/photos";
import { datasetRows, listPage, listSummary, renameDataset, trashDataset, type ListSummary, type PageFilter } from "../lib/service";
import { VERDICTS, type AreaLevel, type Dataset, type DatasetRow, type Verdict } from "../lib/types";
import { AreaMap } from "./AreaMap";
import { Empty, Field, SearchBox, Segmented, VerdictPill } from "./Bits";
import { Icon } from "./Icon";
import { ListDownloads } from "./ListDownloads";
import { ListExports, SavedFilters } from "./ListExtras";
import { ListRowDetail } from "./ListRowDetail";
import { Select } from "./Select";

const StreetMap = lazy(() => import("./StreetMap").then(module => ({ default: module.StreetMap })));

const PAGE = 25;

/**
 * A long list in Lists. It is too long to read whole into the window, so the service counts it (verdicts, flags,
 * areas, where its rows are) and hands over one filtered page at a time. What needs every row of every list at once
 * (owners found in other lists, pictures borrowed from them, each property on its own address on the map) is left
 * out: the map shows the list's rows by ZIP.
 */
export function LargeListView({ callerwhale, dataset }: { callerwhale: CallerWhale; dataset: Dataset }) {
  const source = marksSource(dataset, callerwhale.datasets);
  const original = dataset.kind === "checked" ? (dataset.parent_dataset_id ?? dataset.id) : dataset.id;
  const setups = useListSetups(callerwhale.datasets, callerwhale.version);
  const [columns, setColumns] = useState<string[] | null>(null);
  const [summary, setSummary] = useState<ListSummary | null>(null);
  const [page, setPage] = useState<{ total: number; rows: DatasetRow[] } | null>(null);
  const [verdict, setVerdict] = useState("all");
  const [flag, setFlag] = useState("all");
  const [column, setColumn] = useState("");
  const [contains, setContains] = useState("");
  const [query, setQuery] = useState("");
  // What is typed is asked for once typing pauses, not for every key.
  const [typed, setTyped] = useState({ contains: "", query: "" });
  const [level, setLevel] = useState<AreaLevel | null>(null);
  const [area, setArea] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [mapping, setMapping] = useState(false);
  const [plain, setPlain] = useState(false);
  const [editing, setEditing] = useState<"rename" | "delete" | null>(null);
  const [newName, setNewName] = useState(dataset.name);
  const [working, setWorking] = useState(false);
  const fail = callerwhale.fail;

  useEffect(() => {
    let live = true;
    datasetRows(source.id, 0, 1).then(first => live && setColumns(first[0] ? Object.keys(first[0].raw) : []), fail);
    return () => {
      live = false;
    };
  }, [source.id, fail]);
  const own = useMemo(() => ownColumns(columns ?? []), [columns]);
  const areas = useMemo(() => areaColumns(columns ?? [], callerwhale.areaMaps[original]), [columns, callerwhale.areaMaps, original]);
  const reach = useMemo(() => reachPayload(reachContext(columns ?? [], setups[original])), [columns, setups, original]);
  const available = AREA_LEVELS.filter(item => areas[item]);
  const activeLevel = level && areas[level] ? level : (available.at(-1) ?? null);

  useEffect(() => {
    const timer = window.setTimeout(() => setTyped({ contains, query }), 350);
    return () => window.clearTimeout(timer);
  }, [contains, query]);

  useEffect(() => {
    if (!columns) return;
    let live = true;
    setSummary(null);
    listSummary(source.id, areas, reach).then(found => live && setSummary(found), fail);
    return () => {
      live = false;
    };
  }, [source.id, columns, areas, reach, callerwhale.manual, fail]);

  const filter: PageFilter = useMemo(
    () => ({ verdict, flag, column, contains: typed.contains, query: typed.query, level: activeLevel, area }),
    [verdict, flag, column, typed, activeLevel, area],
  );
  useEffect(() => {
    if (!columns) return;
    let live = true;
    listPage(source.id, areas, reach, filter, at * PAGE, PAGE).then(found => live && setPage(found), fail);
    return () => {
      live = false;
    };
  }, [source.id, columns, areas, reach, filter, at, callerwhale.manual, fail]);

  const zipValues = useMemo(() => (summary?.areas.zip ?? []).map(item => item.name), [summary]);
  const centres = useZipCentres(zipValues, fail);
  const known = zipValues.filter(value => centres.has(value)).length;
  const mapData = useMemo(
    () => placesForMap(summary?.places ?? [], centres, activeLevel ?? "zip"),
    // `known` changes as ZIP centres arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summary, centres, known, activeLevel],
  );
  const zipOutlines = useZipOutlines(mapData.zips, fail);

  if (!columns || !summary) return <p className="loading">Counting the rows of this long list…</p>;

  const phoneColumns = checkedPhoneColumns(columns);
  const checked = phoneColumns.length > 0;
  const rows = page?.rows ?? [];
  const pictures = photoColumns(rows, own);
  const place = placeColumns(columns, callerwhale.areaMaps[original]);
  const shownColumns = own.filter(name => !/^(zpid|latitude|longitude|image|detail url)$/i.test(name) && !pictures.includes(name)).slice(0, checked ? 4 : 6);
  const pages = Math.max(1, Math.ceil((page?.total ?? 0) / PAGE));
  const filtering = Boolean(area || verdict !== "all" || flag !== "all" || (column && contains) || query);
  const areaList = activeLevel ? (summary.areas[activeLevel] ?? []) : [];
  const areaMax = Math.max(1, ...areaList.slice(0, 200).map(item => item.count));
  const change =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setAt(0);
    };
  const reset = () => {
    setArea(null);
    setVerdict("all");
    setFlag("all");
    setColumn("");
    setContains("");
    setQuery("");
    setAt(0);
  };
  async function act(action: () => Promise<unknown>) {
    setWorking(true);
    try {
      await action();
      await callerwhale.refresh();
      setEditing(null);
    } catch (reason) {
      fail(reason);
    }
    setWorking(false);
  }

  return (
    <section className="list-view">
      <header className="list-head">
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
            {KIND_LABELS[dataset.kind]} · {formatNumber(summary.count)} rows · {own.length} columns · {formatDate(dataset.created_at)} · a long list: counted
            and shown a page at a time
          </p>
          {editing === "delete" ? (
            <p className="notice" role="alertdialog" aria-label="Delete this list">
              <span>
                Delete <strong>{dataset.name}</strong> and its {formatNumber(dataset.row_count)} rows from this project? It can be put back for 30 days, from
                Deleted lists under the lists.
              </span>
              <button type="button" className="button" disabled={working} onClick={() => void act(() => trashDataset(dataset.id))}>
                {working ? "Deleting…" : "Yes, delete it"}
              </button>
              <button type="button" className="button ghost" disabled={working} onClick={() => setEditing(null)}>
                Keep it
              </button>
            </p>
          ) : (
            editing === null && (
              <div className="row list-actions">
                <button type="button" className="button ghost small" onClick={() => (setNewName(dataset.name), setEditing("rename"))}>
                  Rename
                </button>
                <button type="button" className="button ghost small" onClick={() => setEditing("delete")}>
                  Delete
                </button>
                <ListDownloads datasetId={dataset.id} checkedId={source.kind === "checked" ? source.id : undefined} fail={fail} />
                <ListExports datasetId={source.id} checked={checked} fail={fail} />
              </div>
            )
          )}
        </div>
        {checked ? (
          <ul className="verdict-strip">
            {VERDICTS.map(item => (
              <li key={item}>
                <button type="button" aria-pressed={verdict === item} onClick={() => change(setVerdict)(verdict === item ? "all" : item)}>
                  <b>{formatNumber(summary.verdicts[item])}</b>
                  <VerdictPill verdict={item} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="notice">
            <span>No phone checks for this list yet, so its rows have no marks.</span>
            <button type="button" className="button" onClick={() => callerwhale.open("skiptracing", original)}>
              Set up in Skip Tracing
            </button>
          </div>
        )}
      </header>

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
                options={AREA_LEVELS.map(value => ({ value, label: AREA_LABELS[value], disabled: !areas[value] }))}
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
                <strong>This list has no state, city or ZIP column.</strong> Caller Whale does not guess one. Pick the column for each level this list has.
              </p>
            )}
            <div className="row">
              {AREA_LEVELS.map(item => (
                <Field
                  key={item}
                  label={`${AREA_LABELS[item]} column`}
                  value={areas[item] ?? null}
                  optional="None"
                  options={own.map(name => ({ value: name, label: name }))}
                  onChange={value => callerwhale.setAreaMap(original, { ...areas, [item]: value ?? undefined })}
                />
              ))}
            </div>
          </div>
        )}
        {available.length > 0 && (
          <div className="areas-body">
            <ul className="area-list">
              {areaList.slice(0, 200).map(item => (
                <li key={item.name} data-area={item.name}>
                  <button type="button" aria-pressed={area === item.name} onClick={() => change(setArea)(area === item.name ? null : item.name)}>
                    <span>{item.name}</span>
                    <i>
                      <b style={{ width: `${(item.count / areaMax) * 100}%` }} />
                    </i>
                    <em>{formatNumber(item.count)}</em>
                  </button>
                </li>
              ))}
              {areaList.length > 200 && <li className="muted">and {formatNumber(areaList.length - 200)} more</li>}
            </ul>
            <div className="areas-map">
              {mapData.spots.length && !plain ? (
                <Suspense fallback={<AreaMap dots={mapData.spots.map(spot => ({ lon: spot.lon, lat: spot.lat }))} />}>
                  <StreetMap
                    spots={mapData.spots}
                    points={[]}
                    outlines={zipOutlines.outlines}
                    outlineCount={zipOutlines.count}
                    selected={area}
                    hovered={null}
                    onHover={() => undefined}
                    onSelect={name => change(setArea)(area === name ? null : name)}
                    fitKey={`${source.id}:${activeLevel}`}
                    onUnavailable={() => setPlain(true)}
                    cities={mapData.cities}
                    states={mapData.states}
                  />
                </Suspense>
              ) : mapData.spots.length ? (
                <AreaMap dots={mapData.spots.map(spot => ({ lon: spot.lon, lat: spot.lat }))} interactive />
              ) : (
                <Empty title="Nothing to put on the map">Rows are placed by their ZIP code. This list has no ZIP column that is filled in.</Empty>
              )}
            </div>
            <p className="muted map-note">
              A long list is drawn by ZIP: each ZIP at its centre, with how many rows are in it.
              {summary.zipless > 0 && ` ${formatNumber(summary.zipless)} rows have no ZIP and are not on the map.`}
            </p>
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
                  { value: "callable", label: `Has a number to call (${formatNumber(summary.flags.callable)})` },
                  { value: "wrong", label: `Known wrong number (${formatNumber(summary.flags.wrong)})` },
                  { value: "dnc", label: `Do not call (${formatNumber(summary.flags.dnc)})` },
                  { value: "manual", label: `Marked by hand (${formatNumber(summary.flags.manual)})` },
                  ...(summary.flags.repeat || summary.flags.possible
                    ? [
                        { value: "once", label: `Each lead once (${formatNumber(summary.flags.once)})` },
                        { value: "repeat", label: `Repeats another row (${formatNumber(summary.flags.repeat)})` },
                        { value: "possible", label: `Might repeat another row (${formatNumber(summary.flags.possible)})` },
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
          <SavedFilters
            datasetId={dataset.id}
            filtering={filtering}
            current={{ verdict, flag, column, contains, query, level: activeLevel, area }}
            fail={fail}
            onApply={kept => {
              setVerdict(kept.verdict ?? "all");
              setFlag(kept.flag ?? "all");
              setColumn(kept.column ?? "");
              setContains(kept.contains ?? "");
              setQuery(kept.query ?? "");
              setLevel((kept.level as AreaLevel | null) ?? null);
              setArea(kept.area ?? null);
              setAt(0);
            }}
          />
          <SearchBox value={query} onChange={change(setQuery)} placeholder="Search rows" />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                {shownColumns.map(name => (
                  <th key={name}>{name}</th>
                ))}
                {checked && (
                  <>
                    <th>Best phone</th>
                    <th>Combined verdict</th>
                    <th>Flags</th>
                  </>
                )}
                <th>
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const marks = readMarks(row.raw, phoneColumns, callerwhale.manual);
                return (
                  <Fragment key={row.id}>
                    <tr className={openRow === row.id ? "open" : undefined}>
                      <td className="num muted">{row.row_number}</td>
                      {shownColumns.map((name, index) => (
                        <td key={name}>{index === 0 ? <strong>{row.raw[name] ?? "–"}</strong> : formatCell(name, row.raw[name])}</td>
                      ))}
                      {checked && (
                        <>
                          <td>{marks.best ? <strong>{formatPhone(marks.best)}</strong> : <span className="muted">No number to call</span>}</td>
                          <td>
                            <VerdictPill verdict={marks.verdict as Verdict | null} />
                          </td>
                          <td>
                            <div className="flags">
                              {marks.knownWrong && <span className="pill pill-wrong">Wrong number</span>}
                              {marks.doNotCall && <span className="pill pill-wrong">Do not call</span>}
                              {row.raw["Duplicate status"] && <span className="pill pill-none">{row.raw["Duplicate status"]}</span>}
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
                        <td colSpan={shownColumns.length + (checked ? 5 : 2)}>
                          <ListRowDetail
                            row={row}
                            datasetId={source.id}
                            onUpdated={callerwhale.refresh}
                            onError={fail}
                            own={own}
                            phoneColumns={phoneColumns}
                            number={marks.number}
                            manual={callerwhale.manual}
                            onMark={callerwhale.setMark}
                            photos={{ columns: pictures, place, index: new Map() }}
                            owner={null}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {page && !page.total && (
            <Empty title="No rows match">
              {filtering && (
                <button type="button" className="link" onClick={reset}>
                  Clear the filters
                </button>
              )}
            </Empty>
          )}
          {!page && <p className="loading">Reading the rows…</p>}
        </div>
        <footer className="pager">
          <span>
            {formatNumber(page?.total ?? 0)} of {formatNumber(summary.count)} rows
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
            <button type="button" className="button ghost" disabled={at === 0} onClick={() => setAt(at - 1)}>
              Previous
            </button>
            <span>
              Page {at + 1} of {formatNumber(pages)}
            </span>
            <button type="button" className="button ghost" disabled={at >= pages - 1} onClick={() => setAt(at + 1)}>
              Next
            </button>
          </div>
        </footer>
      </article>
    </section>
  );
}
