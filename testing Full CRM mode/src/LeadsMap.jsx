import { useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { Crosshair, MapPin } from "@phosphor-icons/react";
import { useCrm } from "./context.jsx";
import { engineAvailable, locatable, locateAddresses, zipPlaces } from "./engine.js";
import { Badge, Button, Checkbox, Status, money, propertyFacts, useShowMore } from "./ui.jsx";

// The leads map, in the manner of a property search map: a pin for every lead with its price, nearby pins grouped
// into a count when zoomed out, and the list beside it showing what is in view. Pointing at a card lights its pin;
// choosing a pin brings its card forward. Leads are placed from their own coordinates, their address (looked up once,
// when asked) or, at once and approximately, their ZIP code's centre.

const CELL = 64; // pins closer than this many pixels are grouped
const UNGROUP_AT = 16; // from this zoom every pin stands alone

const short = value => {
  if (!(value > 0)) return "";
  if (value >= 1e6) return "$" + (value / 1e6).toFixed(value >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (value >= 1e3) return "$" + Math.round(value / 1e3) + "K";
  return "$" + Math.round(value);
};
const pinLabel = lead => short(lead.value) || (lead.beds != null ? lead.beds + " bd" : "");
const placeOf = lead => (lead.geo && Number.isFinite(lead.geo.lat) && Number.isFinite(lead.geo.lng) ? lead.geo : null);

export function LeadsMap({ leads }) {
  const { state, dispatch, navigate, notify } = useCrm();
  const host = useRef(null);
  const mapRef = useRef(null);
  const leafletRef = useRef(null);
  const layerRef = useRef(null);
  const pinsRef = useRef(new Map());
  const cardsRef = useRef(new Map());
  const [view, setView] = useState(null); // the map's bounds, as [[south, west], [north, east]]
  const [onlyInView, setOnlyInView] = useState(true);
  const [hovered, setHovered] = useState(null);
  const [selected, setSelected] = useState(null);
  const [engine, setEngine] = useState(null);
  const [locating, setLocating] = useState(null);
  const [mapState, setMapState] = useState("Loading map");
  const zipTried = useRef(new Set());

  const placed = useMemo(() => leads.filter(placeOf), [leads]);
  const exact = placed.filter(lead => lead.geo.precision === "address").length;
  const toLocate = useMemo(() => leads.filter(lead => locatable(lead) && lead.geo?.precision !== "address" && !lead.geo?.notFound), [leads]);
  const notFound = leads.filter(lead => lead.geo?.notFound && lead.geo?.precision !== "address").length;
  const unplaced = leads.length - placed.length;

  useEffect(() => {
    let live = true;
    engineAvailable().then(value => live && setEngine(value));
    return () => {
      live = false;
    };
  }, []);

  // Leads with a ZIP but no place yet go on the map at once, approximately, from the ZIP file shipped with Turf.
  useEffect(() => {
    if (!engine) return;
    const waiting = leads.filter(lead => !placeOf(lead) && lead.zip && !zipTried.current.has(lead.id));
    if (!waiting.length) return;
    waiting.forEach(lead => zipTried.current.add(lead.id));
    zipPlaces(waiting).then(
      places => Object.keys(places).length && dispatch({ type: "LOCATE", places }),
      () => {},
    );
  }, [engine, leads, dispatch]);

  async function locate() {
    setLocating({ done: 0, total: toLocate.length });
    try {
      const { places, notFound: missed } = await locateAddresses(toLocate, {
        onStage: event => event.total && setLocating({ done: event.done || 0, total: event.total }),
      });
      dispatch({ type: "LOCATE", places, notFound: missed });
      const found = Object.keys(places).length;
      notify(
        `Located ${found.toLocaleString()} of ${toLocate.length.toLocaleString()} addresses` +
          (missed.length ? ` · ${missed.length.toLocaleString()} not found` : ""),
      );
    } catch (reason) {
      notify("Addresses could not be located: " + reason.message);
    } finally {
      setLocating(null);
    }
  }

  // The map itself, once.
  useEffect(() => {
    if (!state.online || !host.current) return undefined;
    let map,
      disposed = false;
    const pins = pinsRef.current;
    import("leaflet")
      .then(L => {
        if (disposed) return;
        leafletRef.current = L;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        map = L.map(host.current, { zoomControl: true, zoomAnimation: !reduce, fadeAnimation: !reduce, markerZoomAnimation: !reduce }).setView(
          [39.5, -98.35],
          4,
        );
        mapRef.current = map;
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        })
          .on("tileerror", () => !disposed && setMapState("Map tiles unavailable · the list still works"))
          .on("tileload", () => !disposed && setMapState("Ready"))
          .addTo(map);
        layerRef.current = L.layerGroup().addTo(map);
        const report = () => {
          const bounds = map.getBounds();
          setView([
            [bounds.getSouth(), bounds.getWest()],
            [bounds.getNorth(), bounds.getEast()],
          ]);
        };
        map.on("moveend zoomend", report);
        new ResizeObserver(() => map.invalidateSize({ animate: false })).observe(host.current);
        report();
      })
      .catch(() => !disposed && setMapState("The map could not load · the list still works"));
    return () => {
      disposed = true;
      map?.remove();
      mapRef.current = null;
      layerRef.current = null;
      pins.clear();
    };
  }, [state.online]);

  // Frame every lead once the first places are known.
  const framed = useRef(false);
  useEffect(() => {
    const map = mapRef.current,
      L = leafletRef.current;
    if (!map || !L || framed.current || !placed.length) return;
    framed.current = true;
    map.fitBounds(L.latLngBounds(placed.map(lead => [lead.geo.lat, lead.geo.lng])).pad(0.1), { maxZoom: 15, animate: false });
  }, [placed, mapState]);

  // Pins for what is in view, grouped by distance on screen; redrawn whenever the view or the leads change.
  useEffect(() => {
    const map = mapRef.current,
      L = leafletRef.current,
      layer = layerRef.current;
    if (!map || !L || !layer || !view) return;
    layer.clearLayers();
    pinsRef.current.clear();
    const bounds = L.latLngBounds(view).pad(0.25);
    const inView = placed.filter(lead => bounds.contains([lead.geo.lat, lead.geo.lng]));
    const zoom = map.getZoom();
    const groups = new Map();
    for (const lead of inView) {
      const point = map.project([lead.geo.lat, lead.geo.lng], zoom);
      const key = zoom >= UNGROUP_AT ? lead.id : Math.floor(point.x / CELL) + ":" + Math.floor(point.y / CELL);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(lead);
    }
    for (const members of groups.values()) {
      if (members.length > 1) {
        const lat = members.reduce((sum, lead) => sum + lead.geo.lat, 0) / members.length;
        const lng = members.reduce((sum, lead) => sum + lead.geo.lng, 0) / members.length;
        const size = members.length >= 1000 ? 56 : members.length >= 100 ? 48 : 40;
        L.marker([lat, lng], {
          icon: L.divIcon({
            className: "map-cluster-icon",
            html: `<span class="map-cluster">${members.length.toLocaleString()}</span>`,
            iconSize: [size, size],
          }),
          keyboard: true,
          title: members.length + " leads here · zoom in",
        })
          .on("click", () => map.fitBounds(L.latLngBounds(members.map(lead => [lead.geo.lat, lead.geo.lng])).pad(0.2), { maxZoom: UNGROUP_AT }))
          .addTo(layer);
        continue;
      }
      const lead = members[0];
      const label = pinLabel(lead);
      const pin = document.createElement("span");
      pin.className =
        "map-pin" + (label ? "" : " is-dot") + (lead.geo.precision === "zip" ? " is-approximate" : "") + (lead.verdict === "Do not call" ? " is-blocked" : "");
      pin.textContent = label;
      const marker = L.marker([lead.geo.lat, lead.geo.lng], {
        icon: L.divIcon({ className: "map-pin-icon", html: pin, iconSize: null }),
        keyboard: true,
        title: lead.name + " · " + lead.address,
        riseOnHover: true,
      })
        .on("click", () => setSelected(lead.id))
        .on("mouseover", () => setHovered(lead.id))
        .on("mouseout", () => setHovered(current => (current === lead.id ? null : current)))
        .addTo(layer);
      pinsRef.current.set(lead.id, marker);
    }
  }, [placed, view]);

  // A lead pointed at or chosen in either place lights up in both.
  useEffect(() => {
    for (const [id, marker] of pinsRef.current) {
      const element = marker.getElement()?.querySelector(".map-pin");
      element?.classList.toggle("is-hot", id === hovered || id === selected);
      if (id === hovered || id === selected) marker.setZIndexOffset(1000);
      else marker.setZIndexOffset(0);
    }
  }, [hovered, selected, view, placed]);
  useEffect(() => {
    if (selected) cardsRef.current.get(selected)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  function focusLead(lead) {
    setSelected(lead.id);
    const place = placeOf(lead);
    if (place && mapRef.current) mapRef.current.setView([place.lat, place.lng], Math.max(mapRef.current.getZoom(), UNGROUP_AT), { animate: true });
  }

  const listed = useMemo(() => {
    if (!onlyInView || !view) return leads;
    const [[south, west], [north, east]] = view;
    return placed.filter(lead => lead.geo.lat >= south && lead.geo.lat <= north && lead.geo.lng >= west && lead.geo.lng <= east);
  }, [leads, placed, view, onlyInView]);
  const [cards, more] = useShowMore(listed, 50);

  return (
    <section className="leads-map view-in" aria-label="Leads map">
      <div className="leads-map-bar">
        <div className="leads-map-counts" role="status">
          <strong>{placed.length.toLocaleString()}</strong> of {leads.length.toLocaleString()} leads on the map
          {exact > 0 && <span> · {exact.toLocaleString()} at their address</span>}
          {placed.length - exact > 0 && <span> · {(placed.length - exact).toLocaleString()} in their ZIP area</span>}
          {notFound > 0 && <span> · {notFound.toLocaleString()} addresses not found</span>}
          {unplaced > 0 && <span> · {unplaced.toLocaleString()} without a location</span>}
        </div>
        <div className="row">
          <Checkbox label="List what's on the map" checked={onlyInView} onChange={event => setOnlyInView(event.target.checked)} />
          {engine && toLocate.length > 0 && (
            <Button variant="primary" icon={Crosshair} disabled={Boolean(locating)} onClick={locate}>
              {locating
                ? `Locating… ${locating.done.toLocaleString()} of ${locating.total.toLocaleString()}`
                : `Find exact locations (${toLocate.length.toLocaleString()})`}
            </Button>
          )}
        </div>
      </div>
      {engine === false && (
        <p className="notice subtle">Placing leads by their address needs Turf's engine (the desktop app). Leads with coordinates are shown.</p>
      )}
      <div className="leads-map-layout">
        <div className="leads-map-surface">
          {state.online ? (
            <div ref={host} className="leads-map-canvas" aria-label="Map of leads" />
          ) : (
            <div className="property-map-offline">
              <MapPin size={32} />
              <strong>The map needs a connection</strong>
              <p>The list beside it still works.</p>
            </div>
          )}
          {state.online && mapState !== "Ready" && <div className="property-map-status">{mapState}</div>}
        </div>
        <div className="leads-map-list" aria-label="Leads in view">
          <p className="muted leads-map-list-count">
            {listed.length.toLocaleString()} {onlyInView ? "in this area" : "leads"}
          </p>
          {!listed.length && <p className="muted">No leads in this part of the map. Zoom out or move the map.</p>}
          {cards.map(lead => (
            <article
              key={lead.id}
              ref={element => (element ? cardsRef.current.set(lead.id, element) : cardsRef.current.delete(lead.id))}
              className={"map-card" + (lead.id === selected ? " is-selected" : "") + (lead.id === hovered ? " is-hot" : "")}
              onMouseEnter={() => setHovered(lead.id)}
              onMouseLeave={() => setHovered(current => (current === lead.id ? null : current))}
            >
              <button type="button" className="map-card-main" onClick={() => focusLead(lead)}>
                <span className="map-card-price">{lead.value > 0 ? money(lead.value) : <span className="muted">No value in the list</span>}</span>
                <span className="map-card-facts">{propertyFacts(lead).join(" · ")}</span>
                <span className="map-card-address">{lead.address}</span>
                <small>{[lead.city, lead.region, lead.zip].filter(Boolean).join(", ")}</small>
                <small className="map-card-owner">{lead.name}</small>
              </button>
              <div className="map-card-foot">
                <Status value={lead.stage} />
                {lead.geo?.precision === "zip" && <Badge>ZIP area</Badge>}
                {!placeOf(lead) && <Badge>Not on the map</Badge>}
                <Button onClick={() => navigate("work/leads/" + lead.id)}>Open</Button>
              </div>
            </article>
          ))}
          {more}
        </div>
      </div>
      <p className="property-map-note muted">
        Exact places come from the US Census Bureau: only street, city, state and ZIP are sent, when you choose Find exact locations, and each address is looked
        up once. ZIP-area pins are approximate.
      </p>
    </section>
  );
}
