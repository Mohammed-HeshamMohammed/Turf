import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import type { Turf } from "../App";
import { AreaMap, type Dot } from "../components/AreaMap";
import { Empty, MiniBars, SearchBox, Segmented } from "../components/Bits";
import { Select } from "../components/Select";
import { copyText, useContextMenu } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { gatherForMap, placeRows, priceColumn, useZipCentres, useZipOutlines } from "../lib/geo";
import { callProgress, contactCoverage, nextSteps, phoneColumnsOf, PROGRESS, REACH, reachContext, reachOf, shareText, type Coverage, type Progress, type ProgressKind, type ReachKind } from "../lib/dashboard";
import { marksSource, useAllRows } from "../lib/hooks";
import { skiptraceSuggest } from "../lib/service";
import {
  AREA_LABELS, AREA_LEVELS, KIND_LABELS, VERDICT_LABELS, areaColumns, checkedPhoneColumns, countAreas, formatDate, formatNumber,
  positionColumns, readMarks,
} from "../lib/marks";
import { VERDICTS, type AreaLevel, type Dataset, type DatasetRow, type SkiptraceSuggestion, type Verdict } from "../lib/types";

// The street map and its library are fetched the first time a map is shown, not when the app starts.
const StreetMap = lazy(() => import("../components/StreetMap").then(module => ({ default: module.StreetMap })));

type Summary = {
  dataset: Dataset;
  rows: DatasetRow[];
  columns: string[];
  checked: boolean;
  hasPhones: boolean;
  callable: number;
  verdicts: Record<Verdict, number>;
  zips: number;
  coverage: Coverage;
  zipColumn?: string;
  zipless: number;
  progress: Progress | null;
  reach: Record<ReachKind, number>;
};

const money = (value: unknown) => `$${formatNumber(Number(value) || 0)}`;

export function Dashboard({ turf }: { turf: Turf }) {
  const { datasets, manual } = turf;
  const menu = useContextMenu();
  // A checked copy is the same rows as its list, so only the lists themselves are counted, each read once
  // from wherever its marks are.
  const primary = useMemo(() => datasets.filter(dataset => !(dataset.kind === "checked" && datasets.some(other => other.id === dataset.parent_dataset_id))), [datasets]);
  const sources = useMemo(() => primary.map(dataset => marksSource(dataset, datasets)), [primary, datasets]);
  const allRows = useAllRows(sources, turf.fail);
  // Every ZIP in every list, so rows without their own coordinates can go on the map at their ZIP's centre.
  const zipValues = useMemo(() => {
    const values = new Set<string>();
    for (const source of sources) {
      const rows = allRows?.[source.id] ?? [];
      const column = rows[0] && areaColumns(Object.keys(rows[0].raw), turf.areaMaps[source.id]).zip;
      if (column) for (const row of rows) { const value = String(row.raw[column] ?? "").trim(); if (value) values.add(value); }
    }
    return [...values];
  }, [allRows, sources, turf.areaMaps]);
  const centres = useZipCentres(zipValues, turf.fail);
  // Each list's Skip Tracing setup: its phone columns and what its call statuses mean, settled by Turf or by the person.
  // Reading it needs no phone check.
  const [setups, setSetups] = useState<Record<string, SkiptraceSuggestion | null>>({});
  const listKey = primary.map(dataset => dataset.id).join();
  useEffect(() => {
    let current = true;
    void Promise.all(primary.map(dataset => skiptraceSuggest(dataset.id).then(setup => [dataset.id, setup] as const, () => [dataset.id, null] as const)))
      .then(entries => { if (current) setSetups(Object.fromEntries(entries)); });
    return () => { current = false; };
  // `listKey` stands for `primary`; `version` changes when a list is checked or a status is settled.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, turf.version]);
  const known = zipValues.filter(value => centres.has(value)).length;
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<AreaLevel>("zip");
  // The area pointed at, in the Areas card or on the map; each shows it in the other.
  const [hoverArea, setHoverArea] = useState<string | null>(null);
  // The street background needs the internet (or its saved copy); without it the rows are on a plain plot.
  const [plain, setPlain] = useState(false);

  const data = useMemo(() => {
    if (!allRows) return null;
    const blocked = new Set<string>();
    const summaries: Summary[] = primary.map(dataset => {
      const source = marksSource(dataset, datasets);
      const rows = allRows[source.id] ?? [];
      const columns = rows[0] ? Object.keys(rows[0].raw) : [];
      const phoneColumns = checkedPhoneColumns(columns);
      const verdicts: Record<Verdict, number> = { corroborated: 0, unverified: 0, suspicious: 0, wrong: 0 };
      let callable = 0;
      const checked = phoneColumns.length > 0;
      const context = reachContext(columns, setups[dataset.id]);
      const reach = Object.fromEntries(REACH.map(kind => [kind.id, 0])) as Record<ReachKind, number>;
      for (const row of rows) {
        const marks = readMarks(row.raw, phoneColumns, manual);
        if (marks.verdict) verdicts[marks.verdict] += 1;
        if (marks.best) callable += 1;
        if ((marks.knownWrong || marks.doNotCall) && marks.number) blocked.add(marks.number);
        reach[reachOf(row, context, checked ? Boolean(marks.best) : null)] += 1;
      }
      const zipColumn = areaColumns(columns, turf.areaMaps[dataset.id]).zip;
      const coverage = contactCoverage(rows, columns, phoneColumnsOf(columns, setups[dataset.id]));
      return {
        dataset, rows, columns, checked: phoneColumns.length > 0, callable, verdicts,
        hasPhones: phoneColumns.length > 0 || coverage.phone > 0,
        zips: countAreas(rows, zipColumn).length, coverage, zipColumn,
        zipless: zipColumn ? rows.filter(row => !String(row.raw[zipColumn] ?? "").trim()).length : rows.length,
        progress: callProgress(setups[dataset.id]), reach,
      };
    });
    const total = summaries.reduce((sum, item) => sum + item.rows.length, 0);
    const checkedRows = summaries.reduce((sum, item) => sum + (item.checked ? item.rows.length : 0), 0);
    const callable = summaries.reduce((sum, item) => sum + item.callable, 0);
    const verdicts = Object.fromEntries(VERDICTS.map(verdict => [verdict, summaries.reduce((sum, item) => sum + item.verdicts[verdict], 0)])) as Record<Verdict, number>;
    const dots: Dot[] = [];
    const listings: { row: DatasetRow; dataset: Dataset }[] = [];
    for (const item of summaries) {
      const position = positionColumns(item.columns);
      const areas = areaColumns(item.columns, turf.areaMaps[item.dataset.id]);
      for (const dot of placeRows(item.rows, { position, zipColumn: areas.zip, stateColumn: areas.state, centres }).dots) dots.push(dot);
      if (!position) continue;
      for (const row of item.rows) {
        if (item.dataset.kind === "scrape" && "Price" in row.raw) listings.push({ row, dataset: item.dataset });
      }
    }
    listings.sort((a, b) => Number(a.row.raw["Days on Zillow"] ?? 999) - Number(b.row.raw["Days on Zillow"] ?? 999));
    const phoneRows = summaries.reduce((sum, item) => sum + item.coverage.phone, 0);
    const emailRows = summaries.reduce((sum, item) => sum + item.coverage.email, 0);
    const checkedNothing = summaries.reduce((sum, item) => sum + (item.checked ? Math.max(0, item.coverage.phone - item.callable) : 0), 0);
    const uncheckedPhones = summaries.reduce((sum, item) => sum + (item.checked ? 0 : item.coverage.phone), 0);
    const reach = Object.fromEntries(REACH.map(kind => [kind.id, summaries.reduce((sum, item) => sum + item.reach[kind.id], 0)])) as Record<ReachKind, number>;
    const progress = Object.fromEntries(PROGRESS.map(kind => [kind.id, summaries.reduce((sum, item) => sum + (item.progress?.[kind.id] ?? 0), 0)])) as Record<ProgressKind, number>;
    const withStatus = summaries.filter(item => item.progress);
    const rowsNeedingYou = withStatus.reduce((sum, item) => sum + (item.progress?.rowsNeedingYou ?? 0), 0);
    const steps = nextSteps(summaries.map(item => ({ dataset: item.dataset, rows: item.rows.length, checked: item.checked, phoneRows: item.coverage.phone, zipColumn: item.zipColumn, zipless: item.zipless, progress: item.progress })));
    return {
      summaries, total, checkedRows, callable, verdicts, blocked: blocked.size, dots, listings: listings.slice(0, 3),
      phoneRows, emailRows, checkedNothing, uncheckedPhones, progress, withStatus: withStatus.length, rowsNeedingYou, steps, reach,
    };
  // `known` changes as ZIP centres arrive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, primary, datasets, manual, turf.areaMaps, centres, known, setups]);
  const [view, setView] = useState<"calls" | "checks" | null>(null);

  // For the street map: every list's rows, each at its own place where it has one, and gathered by ZIP, city and state.
  // Areas are named at the level the Areas card is on.
  const mapData = useMemo(() => gatherForMap((data?.summaries ?? []).map(item => {
    const found = areaColumns(item.columns, turf.areaMaps[item.dataset.id]);
    const dots = placeRows(item.rows, { position: positionColumns(item.columns), zipColumn: found.zip, stateColumn: found.state, centres, tagColumn: priceColumn(item.columns) }).dots;
    return { rows: item.rows, dots, columns: found, named: found[level] };
  }), centres),
  // `known` changes as ZIP centres arrive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [data, level, turf.areaMaps, centres, known]);
  const zipOutlines = useZipOutlines(mapData.zips, turf.fail);

  const areas = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>();
    for (const item of data.summaries) {
      const column = areaColumns(item.columns, turf.areaMaps[item.dataset.id])[level];
      for (const area of countAreas(item.rows, column)) counts.set(area.name, (counts.get(area.name) ?? 0) + area.count);
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 7);
  }, [data, level, turf.areaMaps]);

  if (!data) return <p className="loading">Reading rows…</p>;

  const statusOf = (item: Summary) => (item.checked ? "checked" : item.hasPhones ? "unchecked" : "none");
  const needle = query.trim().toLowerCase();
  const shown = data.summaries.filter(item =>
    (kind === "all" || item.dataset.kind === kind) &&
    (status === "all" || statusOf(item) === status) &&
    (!needle || `${item.dataset.name} ${item.dataset.source_filename}`.toLowerCase().includes(needle)));

  const share = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0);
  const verdictTotal = VERDICTS.reduce((sum, verdict) => sum + data.verdicts[verdict], 0);
  const verdictMax = Math.max(1, ...VERDICTS.map(verdict => data.verdicts[verdict]));
  const areaMax = Math.max(1, ...areas.map(area => area.count));
  const anyChecked = data.summaries.some(item => item.checked);
  // Call results show the calls made; rows without a result are counted beside them, not drawn against them.
  const CALLED = PROGRESS.filter(kind => kind.id !== "no_result");
  const called = CALLED.reduce((sum, kind) => sum + data.progress[kind.id], 0);
  const calledMax = Math.max(1, ...CALLED.map(kind => data.progress[kind.id]));
  const statusBlocked = data.progress.do_not_call + data.progress.bad_number;
  // Call results come from the lists themselves; phone verdicts from the person's checks. Show whichever exists.
  const shownView = view ?? (data.withStatus ? "calls" : "checks");
  const shownSpots = mapData.spots;

  return (
    <div className="dashboard">
      <section className="hero">
        <div className="hero-stats">
          <div className="hero-figures">
            <div className="figure">
              <span>Rows in your lists</span>
              <strong>{formatNumber(data.total)}</strong>
            </div>
            <div className="figure">
              <span>Reachable</span>
              <strong>{formatNumber(data.total - data.reach.none)}</strong>
              <small>{formatNumber(data.phoneRows)} by phone · {formatNumber(data.emailRows)} by email{anyChecked ? ` · ${formatNumber(data.callable)} ready to call` : ""}</small>
            </div>
          </div>
          <div className="reach">
            <h2 className="reach-title">How each row can be reached</h2>
            <div className="reach-bar" role="img" aria-label={REACH.map(kind => `${kind.label}: ${formatNumber(data.reach[kind.id])}`).join(", ")}>
              {REACH.map(kind => data.reach[kind.id] ? (
                <i key={kind.id} style={{ flexGrow: data.reach[kind.id], background: kind.color }} title={`${kind.label}: ${formatNumber(data.reach[kind.id])} rows (${shareText(data.reach[kind.id], data.total)}). ${kind.hint}`} />
              ) : null)}
            </div>
            <ul className="reach-legend">
              {REACH.filter(kind => data.reach[kind.id] || kind.id === "ready" && anyChecked).map(kind => (
                <li key={kind.id} title={kind.hint}>
                  <i style={{ background: kind.color }} aria-hidden="true" />
                  <span>{kind.label}</span>
                  <b>{formatNumber(data.reach[kind.id])}</b>
                  <em>{shareText(data.reach[kind.id], data.total)}</em>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="hero-map">
          {data.dots.length && !plain ? (
            <Suspense fallback={<AreaMap dots={data.dots} width={760} height={300} radius={3.4} />}>
              <StreetMap spots={shownSpots} points={mapData.points} outlines={zipOutlines.outlines} outlineCount={zipOutlines.count}
                selected={null} hovered={hoverArea} onHover={setHoverArea} onSelect={() => undefined} fitKey={`all:${datasets.length}`} onUnavailable={() => setPlain(true)} cities={mapData.cities} states={mapData.states} />
            </Suspense>
          ) : data.dots.length ? <AreaMap dots={data.dots} width={760} height={300} radius={3.4} interactive />
            : <Empty title="Nothing on the map yet">Rows are placed by their ZIP code. A list with a ZIP column shows here.</Empty>}
        </div>
      </section>

      <section className="cards">
        <div className="stack">
          <article className="card next-steps">
            <header><h2>Next steps</h2>{data.steps.length > 3 && <span className="count">{data.steps.length}</span>}</header>
            {data.steps.length ? (
              <ul>{data.steps.slice(0, 3).map(step => (
                <li key={step.key}>
                  <div><strong>{step.text}</strong><small>{step.detail}</small></div>
                  <button type="button" className="round" aria-label={`${step.action}: ${step.text}`} onClick={() => turf.open(step.tab, step.datasetId)}><Icon name="arrow" /></button>
                </li>
              ))}</ul>
            ) : <p className="muted">Nothing waiting: every list is checked, every call status is settled, and every row is on the map.</p>}
          </article>
          <article className="card stat">
            <header>
              <h2>Numbers not to call</h2>
              <button type="button" className="round" aria-label="Open Skip Tracing" onClick={() => turf.open("skiptracing")}><Icon name="arrow" /></button>
            </header>
            <div className="stat-body">
              <div>
                <strong>{formatNumber(anyChecked ? data.blocked : statusBlocked)}</strong>
                <span>{anyChecked ? "Wrong or do-not-call numbers in checked lists" : "Rows whose call status says do not call or bad number"}</span>
                {anyChecked && statusBlocked > 0 && <small>{formatNumber(statusBlocked)} rows by call status in all lists</small>}
              </div>
              <MiniBars values={data.summaries.map(item => item.verdicts.wrong)} />
            </div>
          </article>
        </div>

        <article className="card verdicts">
          <header>
            <h2>{shownView === "calls" ? "Call results" : "Phone verdicts"}</h2>
            <Segmented label="Show" value={shownView} onChange={setView} options={[{ value: "calls", label: "Calls" }, { value: "checks", label: "Checks" }]} />
          </header>
          {shownView === "calls" ? (data.withStatus ? <>
            <div className="calls-figures">
              <div><strong>{formatNumber(called)}</strong><span>rows called</span></div>
              <div><strong>{formatNumber(data.progress.no_result)}</strong><span>not called yet</span></div>
            </div>
            {called ? <>
              <p className="bar-list-title">What happened on the calls made</p>
              <ul className="bar-list">
                {CALLED.filter(kind => kind.id !== "unclear" || data.progress.unclear).map(kind => (
                  <li key={kind.id} title={`${kind.label}: ${formatNumber(data.progress[kind.id])} of ${formatNumber(called)} called rows`}>
                    <div><span>{kind.label}</span><b>{formatNumber(data.progress[kind.id])}</b><em>{shareText(data.progress[kind.id], called)}</em></div>
                    {data.progress[kind.id] > 0 && <i style={{ width: `${(data.progress[kind.id] / calledMax) * 100}%` }} />}
                  </li>
                ))}
              </ul>
            </> : <p className="muted">No calls recorded yet in {data.withStatus === 1 ? "the status column" : "the status columns"}.</p>}
            {data.rowsNeedingYou > 0 && <p className="card-note">{formatNumber(data.rowsNeedingYou)} rows have a status that still needs you; they count by its suggested meaning.</p>}
          </> : <Empty title="No call results">A list with a call status column shows how its calls went here, without a phone check.</Empty>)
          : (verdictTotal ? <>
            <div className="calls-figures">
              <div><strong>{formatNumber(verdictTotal)}</strong><span>rows checked</span></div>
              <div><strong>{formatNumber(data.callable)}</strong><span>ready to call</span></div>
            </div>
            <p className="bar-list-title">The best phone in each checked row</p>
            <ul className="bar-list">
              {VERDICTS.map(verdict => (
                <li key={verdict} title={`${VERDICT_LABELS[verdict]}: ${formatNumber(data.verdicts[verdict])} of ${formatNumber(verdictTotal)} checked rows`}>
                  <div><span>{VERDICT_LABELS[verdict]}</span><b>{formatNumber(data.verdicts[verdict])}</b><em>{shareText(data.verdicts[verdict], verdictTotal)}</em></div>
                  {data.verdicts[verdict] > 0 && <i style={{ width: `${(data.verdicts[verdict] / verdictMax) * 100}%` }} />}
                </li>
              ))}
            </ul>
          </> : <Empty title="No list checked yet">Checking a list's phones in Skip Tracing narrows them to the ones worth calling; their verdicts show here.</Empty>)}
        </article>

        <article className="card listings">
          <header>
            <h2>Latest listings</h2>
            {data.listings[0] && <button type="button" className="round" aria-label="Open the listings list" onClick={() => turf.open("lists", data.listings[0].dataset.id)}><Icon name="arrow" /></button>}
          </header>
          {data.listings.length ? (
            <div className="listing-row">
              {data.listings.map(({ row }) => (
                <div className="listing" key={row.id}>
                  <div className="thumb">
                    {row.raw.Image ? <img src={String(row.raw.Image)} alt="" loading="lazy" /> : <Icon name="home" size={44} />}
                    {row.raw["Detail URL"] && (
                      <a className="round dark" href={String(row.raw["Detail URL"])} target="_blank" rel="noreferrer" aria-label={`Open ${row.raw.Street} on Zillow`}><Icon name="arrow" /></a>
                    )}
                  </div>
                  <div className="listing-tags"><span>{row.raw.Status}</span><span>{row.raw["Days on Zillow"]} days</span></div>
                  <div className="listing-title"><strong>{row.raw.Street}</strong><b>{money(row.raw.Price)}</b></div>
                  <p>{row.raw.City}, {row.raw.State} {row.raw.Zip}</p>
                  <div className="listing-chips">
                    <span>{formatNumber(Number(row.raw["Living area (sqft)"]))} sq ft</span>
                    <span>{row.raw.Beds} beds</span>
                    <span>{row.raw.Baths} baths</span>
                  </div>
                </div>
              ))}
            </div>
          ) : <Empty title="No collected listings">A run from the collector extension shows its newest listings here.</Empty>}
        </article>
      </section>

      <section className="bottom">
        <article className="card table-card">
          <div className="filters">
            <Select variant="pill" icon="layers" label="Kind" value={kind} onChange={setKind}
              options={[{ value: "all", label: "Kind" }, ...Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))]} />
            <Select variant="pill" icon="flag" label="Status" value={status} onChange={setStatus}
              options={[{ value: "all", label: "Status" }, { value: "checked", label: "Checked" }, { value: "unchecked", label: "Not checked" }, { value: "none", label: "No phones" }]} />
            <span className="grow" />
            <SearchBox value={query} onChange={setQuery} placeholder="Search lists" />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>List name</th><th>Kind</th><th className="num">Rows</th><th className="num">ZIPs</th><th className="num">Callable</th><th>Status</th><th><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody>
                {shown.map(item => (
                  <tr key={item.dataset.id} onContextMenu={event => menu(event, [
                    { label: "Open in Lists", onSelect: () => turf.open("lists", item.dataset.id) },
                    { label: "Check its phones in Skip Tracing", disabled: !item.hasPhones, hint: item.hasPhones ? undefined : "No phone columns", onSelect: () => turf.open("skiptracing", item.dataset.id) },
                    { label: "Copy its name", onSelect: () => copyText(item.dataset.name) },
                  ])}>
                    <td>
                      <div className="name-cell">
                        <span className="avatar"><Icon name={item.dataset.kind === "scrape" ? "home" : "layers"} /></span>
                        <div><strong>{item.dataset.name}</strong><small>{formatDate(item.dataset.created_at)}</small></div>
                      </div>
                    </td>
                    <td>{KIND_LABELS[item.dataset.kind]}</td>
                    <td className="num">{formatNumber(item.rows.length)}</td>
                    <td className="num">{item.zips || "–"}</td>
                    <td className="num">{item.checked ? `${Math.round(share(item.callable, item.rows.length))}%` : "–"}</td>
                    <td>
                      {item.checked ? <span className="pill pill-corroborated">Checked</span>
                        : item.hasPhones ? <span className="pill pill-suspicious">Not checked</span>
                        : <span className="pill pill-none">No phones</span>}
                    </td>
                    <td className="num"><button type="button" className="round" aria-label={`Open ${item.dataset.name}`} onClick={() => turf.open("lists", item.dataset.id)}><Icon name="arrow" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!shown.length && <Empty title="No lists match">Clear the filters to see every list.</Empty>}
          </div>
        </article>

        <article className="card areas-card">
          <header>
            <h2>Areas</h2>
            <Segmented label="Area level" value={level} onChange={setLevel} options={AREA_LEVELS.map(value => ({ value, label: AREA_LABELS[value] }))} />
          </header>
          <ul className="rank">
            {areas.map(area => (
              <li key={area.name} className={hoverArea === area.name ? "pointed" : undefined} onMouseEnter={() => setHoverArea(area.name)} onMouseLeave={() => setHoverArea(null)}>
                <span>{area.name}</span>
                <i><b style={{ width: `${(area.count / areaMax) * 100}%` }} /></i>
                <em>{formatNumber(area.count)}</em>
              </li>
            ))}
          </ul>
          {!areas.length && <Empty title="No area columns">None of the lists has a column for this level.</Empty>}
        </article>
      </section>
    </div>
  );
}
