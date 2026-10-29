import { useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { Crosshair, MapPin } from "@phosphor-icons/react";
import { useCrm } from "./context.jsx";
import { locateLabel, useLeadPlaces } from "./useLeadPlaces.js";
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
function leadPopup(lead, open) {
  const box = document.createElement("div");
  box.className = "map-popup";
  const line = (tag, text, className) => {
    if (!text) return;
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    box.append(element);
  };
  line("strong", lead.value > 0 ? money(lead.value) : lead.address, "map-popup-title");
  if (lead.value > 0) line("span", lead.address);
  line("small", [lead.city, lead.region, lead.zip].filter(Boolean).join(", "));
  line("span", propertyFacts(lead).join(" · "), "map-popup-facts");
  line("span", lead.name, "map-popup-owner");
  line("small", [lead.stage, lead.phone, lead.geo?.precision === "zip" ? "ZIP area · approximate" : ""].filter(Boolean).join(" · "));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button primary";
  button.textContent = "Open lead";
  button.addEventListener("click", open);
  box.append(button);
  return box;
}

const placeOf = lead => (lead.geo && Number.isFinite(lead.geo.lat) && Number.isFinite(lead.geo.lng) ? lead.geo : null);

export function LeadsMap({ leads }) {
  const { state, navigate } = useCrm();
  const host = useRef(null);
  const mapRef = useRef(null);
  const leafletRef = useRef(null);
  const layerRef = useRef(null);
  const pinsRef = useRef(new Map());
  // The lead whose card is open on the map. Pins are redrawn whenever the map moves (opening a card near the edge
  // moves it), so the open card is opened again on its new pin.
  const openRef = useRef(null);
  const redrawing = useRef(false);
  const cardsRef = useRef(new Map());
  const [view, setView] = useState(null); // the map's bounds, as [[south, west], [north, east]]
  const [onlyInView, setOnlyInView] = useState(true);
  const [hovered, setHovered] = useState(null);
  const [selected, setSelected] = useState(null);
  // Leads sharing one spot (a ZIP centre, or one building): chosen from their bubble, they are what the list shows.
  const [spot, setSpot] = useState(null);
  const [mapState, setMapState] = useState("Loading map");
  const places = useLeadPlaces(leads);
  const { engine, locating, locate, exact, notFound, toLocate, unplaced } = places;
  const placed = useMemo(() => leads.filter(placeOf), [leads]);
  useEffect(() => setSpot(null), [exact]);

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
    redrawing.current = true;
    layer.clearLayers();
    redrawing.current = false;
    pinsRef.current.clear();
    const bounds = L.latLngBounds(view).pad(0.25);
    const inView = placed.filter(lead => bounds.contains([lead.geo.lat, lead.geo.lng]));
    const zoom = map.getZoom();
    const groups = new Map();
    for (const lead of inView) {
      const point = map.project([lead.geo.lat, lead.geo.lng], zoom);
      const key = zoom >= UNGROUP_AT ? lead.geo.lat.toFixed(6) + "," + lead.geo.lng.toFixed(6) : Math.floor(point.x / CELL) + ":" + Math.floor(point.y / CELL);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(lead);
    }
    for (const members of groups.values()) {
      if (members.length > 1) {
        const lat = members.reduce((sum, lead) => sum + lead.geo.lat, 0) / members.length;
        const lng = members.reduce((sum, lead) => sum + lead.geo.lng, 0) / members.length;
        const size = members.length >= 1000 ? 56 : members.length >= 100 ? 48 : 40;
        const first = members[0].geo;
        const oneSpot = members.every(lead => Math.abs(lead.geo.lat - first.lat) < 1e-6 && Math.abs(lead.geo.lng - first.lng) < 1e-6);
        const approximate = members.every(lead => lead.geo.precision !== "address");
        L.marker([lat, lng], {
          icon: L.divIcon({
            className: "map-cluster-icon",
            html: `<span class="map-cluster${approximate ? " is-approximate" : ""}">${members.length.toLocaleString()}</span>`,
            iconSize: [size, size],
          }),
          keyboard: true,
          title: oneSpot ? members.length + " leads at this spot · show them" : members.length + " leads here · zoom in",
        })
          .on("click", () => {
            // Leads on one spot never separate by zooming: list them instead.
            if (oneSpot) setSpot({ ids: new Set(members.map(lead => lead.id)), approximate, count: members.length });
            else map.fitBounds(L.latLngBounds(members.map(lead => [lead.geo.lat, lead.geo.lng])).pad(0.2), { maxZoom: UNGROUP_AT });
          })
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
        .bindPopup(() => leadPopup(lead, () => navigate("work/leads/" + lead.id)), { closeButton: true, autoPanPadding: [24, 24], maxWidth: 280 })
        .on("click", () => {
          // The lead's card comes forward in the list too: leave a spot list it is not part of.
          setSpot(current => (current && !current.ids.has(lead.id) ? null : current));
          setSelected(lead.id);
        })
        .on("mouseover", () => setHovered(lead.id))
        .on("mouseout", () => setHovered(current => (current === lead.id ? null : current)))
        .on("popupopen", () => (openRef.current = lead.id))
        .on("popupclose", () => !redrawing.current && openRef.current === lead.id && (openRef.current = null))
        .addTo(layer);
      pinsRef.current.set(lead.id, marker);
    }
    const open = openRef.current && pinsRef.current.get(openRef.current);
    if (open) {
      // Opened again where it already fits: no second move of the map.
      open.getPopup().options.autoPan = false;
      open.openPopup();
      open.getPopup().options.autoPan = true;
    }
  }, [placed, view, navigate]);

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
    const card = selected && cardsRef.current.get(selected);
    const list = card?.parentElement;
    if (!card || !list) return;
    const top = card.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + card.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTo({ top: Math.max(0, top - 8), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [selected]);

  function focusLead(lead) {
    setSelected(lead.id);
    const place = placeOf(lead);
    if (place && mapRef.current) mapRef.current.setView([place.lat, place.lng], Math.max(mapRef.current.getZoom(), UNGROUP_AT), { animate: true });
  }

  const listed = useMemo(() => {
    let found;
    if (spot) found = leads.filter(lead => spot.ids.has(lead.id));
    else if (!onlyInView || !view) found = leads;
    else {
      const [[south, west], [north, east]] = view;
      found = placed.filter(lead => lead.geo.lat >= south && lead.geo.lat <= north && lead.geo.lng >= west && lead.geo.lng <= east);
    }
    // The lead picked on the map leads the list, so its card is always on screen.
    const picked = selected && found.findIndex(lead => lead.id === selected);
    return picked > 0 ? [found[picked], ...found.slice(0, picked), ...found.slice(picked + 1)] : found;
  }, [leads, placed, view, onlyInView, spot, selected]);
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
              {locateLabel(places)}
            </Button>
          )}
        </div>
      </div>
      {engine && exact === 0 && placed.length > 0 && toLocate.length > 0 && !locating && (
        <p className="notice subtle">
          Leads are on their ZIP code's centre for now, so each ZIP shows as one bubble. Find exact locations puts every lead on its own address.
        </p>
      )}
      {engine === false && (
        <p className="notice subtle">Placing leads by their address needs Caller Whale's engine (the desktop app). Leads with coordinates are shown.</p>
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
          {spot ? (
            <div className="leads-map-spot" role="status">
              <span>
                <strong>{spot.count.toLocaleString()} leads at one spot</strong>
                {spot.approximate && <small>Their ZIP code's centre: only the ZIP is known so far.</small>}
              </span>
              <Button onClick={() => setSpot(null)}>Show all in view</Button>
            </div>
          ) : (
            <p className="muted leads-map-list-count">
              {listed.length.toLocaleString()} {onlyInView ? "in this area" : "leads"}
            </p>
          )}
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
                {/* The price leads, as on a property search; a list without prices leads with the address. */}
                {lead.value > 0 ? (
                  <>
                    <span className="map-card-price">{money(lead.value)}</span>
                    <span className="map-card-facts">{propertyFacts(lead).join(" · ")}</span>
                    <span className="map-card-address">{lead.address}</span>
                  </>
                ) : (
                  <>
                    <span className="map-card-price is-address">{lead.address}</span>
                    <span className="map-card-facts">{propertyFacts(lead).join(" · ")}</span>
                  </>
                )}
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
