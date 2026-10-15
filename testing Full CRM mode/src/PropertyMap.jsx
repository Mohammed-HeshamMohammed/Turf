import { useEffect, useMemo, useRef, useState } from "react";
import { MapPin, ArrowsOut, ArrowUpRight } from "@phosphor-icons/react";
import { useCrm } from "./context.jsx";
import { recordLocation, mapSearchUrl } from "./locations.js";
import { Badge, Button } from "./ui.jsx";
import "leaflet/dist/leaflet.css";

export function PropertyMap({ rows, title = "Property map", mappings, compact = false }) {
  const { state, navigate } = useCrm();
  const host = useRef(null),
    mapRef = useRef(null),
    layers = useRef(new Map()),
    fit = useRef(() => {});
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("All locations");
  const [status, setStatus] = useState("Loading map");
  const [retry, setRetry] = useState(0);
  const records = useMemo(
    () =>
      rows.map(row => ({
        row,
        ...recordLocation(
          row,
          state.datasets.find(item => item.id === row.datasetId),
          mappings,
        ),
      })),
    [rows, state.datasets, mappings],
  );
  const shown = useMemo(
    () =>
      records.filter(
        item =>
          filter === "All locations" || (filter === "Coordinates" ? item.kind === "coordinates" : filter === "City areas" ? item.kind === "area" : !item.point),
      ),
    [records, filter],
  );
  const chosen = shown.find(item => item.row.id === selected) || shown[0];

  useEffect(() => {
    if (!state.online || !host.current) return;
    const markerLayers = layers.current;
    let disposed = false,
      map,
      observer;
    import("leaflet")
      .then(L => {
        if (disposed) return;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        map = L.map(host.current, { scrollWheelZoom: false, zoomAnimation: !reduce, fadeAnimation: !reduce }).setView([25, 0], 2);
        mapRef.current = map;
        setStatus("Loading map");
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        })
          .on("tileerror", () => !disposed && setStatus("Map tiles unavailable · records remain available below"))
          .on("tileload", () => !disposed && setStatus(current => (current.startsWith("Map tiles unavailable") ? current : "Ready")))
          .addTo(map);
        markerLayers.clear();
        const groups = new Map();
        shown
          .filter(item => item.point)
          .forEach(item => {
            const key = item.kind + ":" + item.point.join(",");
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
          });
        groups.forEach(group => {
          const item = group[0];
          const marker =
            item.kind === "area"
              ? L.circle(item.point, { radius: 7000, color: "#a76321", fillColor: "#f1bf88", fillOpacity: 0.25, weight: 2, dashArray: "5 5" })
              : L.circleMarker(item.point, { radius: 9, color: "white", fillColor: "#151515", fillOpacity: 1, weight: 3 });
          const popup = document.createElement("div");
          const heading = document.createElement("strong");
          heading.textContent = group.length > 1 ? `${group.length} records at this ${item.kind === "area" ? "city area" : "coordinate"}` : item.row.name;
          const detail = document.createElement("p");
          detail.textContent = item.kind === "area" ? "Approximate area only. These are not property pins." : item.address || item.point.join(", ");
          popup.append(heading, detail);
          marker
            .bindPopup(popup)
            .on("click", () => setSelected(item.row.id))
            .addTo(map);
          if (group.length > 1) marker.bindTooltip(String(group.length), { permanent: true, direction: "center", className: "property-map-count" });
          group.forEach(record => markerLayers.set(record.row.id, marker));
        });
        const points = shown.filter(item => item.point);
        fit.current = () => {
          if (points.length)
            map.fitBounds(L.latLngBounds(points.map(item => item.point)).pad(0.15), {
              padding: [35, 35],
              maxZoom: points.some(item => item.kind === "area") ? 10 : 15,
              animate: false,
            });
          else map.setView([25, 0], 2, { animate: false });
        };
        fit.current();
        observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
        observer.observe(host.current);
      })
      .catch(() => !disposed && setStatus("Map could not load · records remain available below"));
    return () => {
      disposed = true;
      observer?.disconnect();
      map?.remove();
      mapRef.current = null;
      fit.current = () => {};
      markerLayers.clear();
    };
  }, [shown, state.online, retry]);

  function choose(item) {
    setSelected(item.row.id);
    if (item.point && mapRef.current) {
      mapRef.current.setView(item.point, item.kind === "area" ? 10 : 15, { animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches });
      layers.current.get(item.row.id)?.openPopup();
    }
  }
  const searchUrl = chosen && mapSearchUrl(chosen);
  return (
    <section className={"card property-map " + (compact ? "is-compact" : "")} aria-label={title}>
      <header>
        <div>
          <h2>
            <MapPin size={22} />
            {title}
          </h2>
          <p className="muted">
            {records.filter(item => item.kind === "coordinates").length} with coordinates · {records.filter(item => item.kind === "area").length} in city areas
            · {records.filter(item => !item.point).length} need a location
          </p>
        </div>
        <Button icon={ArrowsOut} disabled={!state.online} onClick={() => fit.current()}>
          Fit records
        </Button>
      </header>
      <div className="property-map-toolbar">
        <label>
          Show{" "}
          <select aria-label={title + " location filter"} value={filter} onChange={event => setFilter(event.target.value)}>
            {["All locations", "Coordinates", "City areas", "Needs location"].map(option => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </label>
        <small>Solid dots: supplied coordinates. Dashed areas: approximate cities.</small>
      </div>
      <div className="property-map-layout">
        <div className="property-map-surface">
          {state.online ? (
            <div ref={host} className="property-map-canvas" aria-label="Interactive property map" />
          ) : (
            <div className="property-map-offline">
              <MapPin size={32} />
              <strong>Map tiles need a connection</strong>
              <p>Your records and location evidence stay available.</p>
            </div>
          )}
          {state.online && status !== "Ready" && (
            <div className="property-map-status" role="status">
              {status}
              {status.includes("unavailable") || status.includes("could not") ? <button onClick={() => setRetry(retry + 1)}>Retry map</button> : null}
            </div>
          )}
          {state.online && status === "Ready" && !shown.some(item => item.point) && (
            <div className="property-map-empty" role="status">
              {shown.length
                ? "No usable coordinates in this view. Records remain below; use an address search or supply location fields."
                : "No records match this view."}
            </div>
          )}
        </div>
        <div className="property-map-records" aria-label={title + " records"}>
          {!shown.length && <p className="muted">No records in this view. Change the location filter or your list filters.</p>}
          {shown.map(item => (
            <button key={item.row.id} aria-pressed={chosen?.row.id === item.row.id} onClick={() => choose(item)}>
              <strong>{item.row.name}</strong>
              <span>{item.address || "No address supplied"}</span>
              <small>
                {item.label}
                {item.invalid ? " · Check invalid/incomplete coordinates" : ""}
              </small>
            </button>
          ))}
        </div>
      </div>
      {chosen && (
        <div className="property-map-detail">
          <div>
            <strong>{chosen.row.name}</strong>
            <p>
              {chosen.point && chosen.kind === "coordinates"
                ? chosen.point.join(", ") + " · Source supplied; not independently verified"
                : chosen.label + ". No exact property location has been confirmed."}
            </p>
          </div>
          <div className="row">
            {searchUrl && (
              <a className="button" href={searchUrl} target="_blank" rel="noreferrer">
                Search address on OpenStreetMap <ArrowUpRight size={16} />
              </a>
            )}
            <Button onClick={() => navigate("work/leads/" + chosen.row.id)}>Open record</Button>
          </div>
        </div>
      )}
      <div className="property-map-note">
        <Badge>{rows.length} visible records</Badge>
        <span>No address is automatically geocoded. Search opens OpenStreetMap only when you choose it. Missing locations stay in the record list.</span>
      </div>
    </section>
  );
}
