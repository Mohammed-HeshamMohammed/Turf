import { useEffect, useRef, useState } from "react";
import { Map as MapLibre, Popup, setWorkerUrl, type ExpressionSpecification, type GeoJSONSource, type LngLatBoundsLike, type MapLayerMouseEvent } from "maplibre-gl";
// The library draws tiles in a background worker, which the bundler has to be pointed at: it packs the worker and
// what it imports into the app, so nothing is fetched from a CDN.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { homeView, isTouchpadScroll, type Dot } from "./AreaMap";

setWorkerUrl(workerUrl);

// The street background is OpenFreeMap's light style (OpenStreetMap data, free, no key). In the desktop app every
// piece of it goes through the host (src-tauri/src/mapcache.rs), which keeps a copy on disk, so parts of the map seen
// before still draw without a connection. Only the part of the map being looked at is ever asked for; no list data.
const inDesktop = "__TAURI_INTERNALS__" in window;
const TILES = !inDesktop ? "https://tiles.openfreemap.org" : navigator.userAgent.includes("Windows") ? "http://mapcache.localhost" : "mapcache://localhost";
const STYLE = `${TILES}/styles/positron`;
// How long to wait for the background, with the window showing, before deciding it cannot be had.
const PATIENCE_MS = 9000;

/** A place properties are gathered at: a ZIP code's area. `area` is what it is called in the Areas list at its current level. */
export type Spot = { zip: string; lat: number; lon: number; shown: number; hidden: number; area: string };
export type Outline = { type: string; coordinates: unknown };

// Few rows to many: the app's peach, deepening. Areas with every row filtered out are grey.
const RAMP: ExpressionSpecification = ["interpolate", ["linear"], ["get", "share"], 0, "#f6e6d4", 0.2, "#efc99d", 0.5, "#e2a15c", 0.8, "#c9772d", 1, "#8f4a14"];
const COLOUR: ExpressionSpecification = ["case", ["==", ["get", "shown"], 0], "#cfcfcf", RAMP];
const INK = "#121212";
/** Shapes take over from circles as the map is zoomed in far enough for a ZIP's area to be seen. */
const fadeIn = (to: number): ExpressionSpecification => ["interpolate", ["linear"], ["zoom"], 7, 0, 8.4, to];
/** For the circles: one whose area has an outline fades away as its shape appears; one without stays. Zoom has to be the
 * outermost thing in such a rule, so the choice between the two sits inside it. */
const fadeOutIfOutlined = (from: number): ExpressionSpecification => ["interpolate", ["linear"], ["zoom"], 7, from, 8.4, ["case", ["get", "outlined"], 0, from]];

const point = (lon: number, lat: number, properties: Record<string, unknown> = {}) =>
  ({ type: "Feature" as const, properties, geometry: { type: "Point" as const, coordinates: [lon, lat] } });
// The library's own type for this wants every shape spelled out; what is built here is plain GeoJSON.
const collection = (features: unknown[]) => ({ type: "FeatureCollection", features }) as unknown as Parameters<GeoJSONSource["setData"]>[0];

const boundsOf = (dots: Dot[]): LngLatBoundsLike | null => {
  const view = homeView(dots);
  return view && [[view.minLon, view.minLat], [view.maxLon, view.maxLat]];
};

/**
 * A list on a real street map.
 *
 * Rows placed by ZIP are drawn as their ZIP's area, shaded by how many rows it holds (as a small circle when zoomed
 * far out, or while the outline has not arrived). Rows with a place of their own (`points`) are dots that gather
 * into small counted circles. Pointing at an area names it; clicking one chooses it, as in the Areas list, and the
 * area chosen or pointed at in the list is outlined here.
 */
export function StreetMap({ spots, points, outlines, outlineCount, selected, hovered, onHover, onSelect, fitKey, onUnavailable, lookup }: {
  spots: Spot[]; points: Dot[];
  /** Outlines by ZIP, filled in as they arrive; `outlineCount` says how many are in, so the map redraws when more land. */
  outlines: Map<string, Outline | null>; outlineCount: number;
  selected: string | null; hovered: string | null; onHover: (area: string | null) => void; onSelect: (area: string) => void;
  fitKey: string; onUnavailable: () => void;
  /** While the properties' exact addresses are being looked up: how far along it is. They appear as pins as they are found. */
  lookup?: string | null;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const [ready, setReady] = useState(false);
  const latest = useRef({ spots, points, selected, onHover, onSelect, onUnavailable });
  latest.current = { spots, points, selected, onHover, onSelect, onUnavailable };

  useEffect(() => {
    if (!holder.current) return;
    let created: MapLibre;
    try {
      created = new MapLibre({
        container: holder.current, style: STYLE, bounds: [[-125, 24], [-66, 50]],
        maxZoom: 18, dragRotate: false, pitchWithRotate: false, attributionControl: { compact: true },
        // The wheel zooms and pinching a touchpad zooms; two fingers on a touchpad move the map (below).
      });
    } catch {
      // No WebGL, for instance.
      latest.current.onUnavailable();
      return;
    }
    created.touchZoomRotate.disableRotation();
    // Heard before the map's own handling (capture), which would zoom on a touchpad's scrolling.
    const scrollWithTouchpad = (event: WheelEvent) => {
      if (!isTouchpadScroll(event)) return;
      event.preventDefault();
      event.stopPropagation();
      created.panBy([event.deltaX, event.deltaY], { animate: false });
    };
    const frame = holder.current;
    frame.addEventListener("wheel", scrollWithTouchpad, { capture: true, passive: false });
    // Only time spent with the window showing counts: a hidden window draws nothing, so the map cannot finish
    // loading there, and that is not a missing connection.
    let waited = 0;
    const giveUp = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      waited += 500;
      if (waited >= PATIENCE_MS) {
        window.clearInterval(giveUp);
        latest.current.onUnavailable();
      }
    }, 500);
    const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 10, className: "map-tip" });

    created.on("load", () => {
      window.clearInterval(giveUp);
      const none: ExpressionSpecification = ["==", ["get", "area"], "\u0000"];
      created.addSource("areas", { type: "geojson", data: collection([]) });
      created.addSource("spots", { type: "geojson", data: collection([]) });
      created.addSource("points", { type: "geojson", data: collection([]), cluster: true, clusterRadius: 36, clusterMaxZoom: 15 });

      // ZIP areas, shaded.
      created.addLayer({ id: "area-fill", type: "fill", source: "areas", paint: { "fill-color": COLOUR, "fill-opacity": fadeIn(0.62) } });
      created.addLayer({ id: "area-edge", type: "line", source: "areas", paint: { "line-color": "#ffffff", "line-width": 1, "line-opacity": fadeIn(0.9) } });
      // The same areas as circles: every one when zoomed far out, and always for a ZIP whose outline is not here.
      created.addLayer({
        id: "spot", type: "circle", source: "spots",
        paint: {
          "circle-color": COLOUR, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.2,
          "circle-radius": ["interpolate", ["linear"], ["get", "share"], 0, 3.5, 1, 11],
          "circle-opacity": fadeOutIfOutlined(0.9),
          "circle-stroke-opacity": fadeOutIfOutlined(1),
        },
      });
      // The area pointed at, here or in the list, and the area chosen.
      created.addLayer({ id: "area-hover", type: "line", source: "areas", filter: none, paint: { "line-color": INK, "line-width": 1.6, "line-opacity": fadeIn(1) } });
      created.addLayer({ id: "area-chosen-fill", type: "fill", source: "areas", filter: none, paint: { "fill-color": INK, "fill-opacity": fadeIn(0.14) } });
      created.addLayer({ id: "area-chosen", type: "line", source: "areas", filter: none, paint: { "line-color": INK, "line-width": 2.6 } });
      created.addLayer({
        id: "spot-ring", type: "circle", source: "spots", filter: none,
        paint: {
          "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": INK, "circle-stroke-width": 2.2,
          "circle-radius": ["interpolate", ["linear"], ["get", "share"], 0, 6, 1, 14],
          "circle-stroke-opacity": fadeOutIfOutlined(1),
        },
      });
      // How many rows, written on each area once there is room for it.
      created.addLayer({
        id: "area-count", type: "symbol", source: "spots", minzoom: 9.5, filter: [">", ["get", "shown"], 0],
        layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 11.5 },
        paint: { "text-color": INK, "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.4 },
      });

      // Rows with a place of their own.
      created.addLayer({
        id: "clusters", type: "circle", source: "points", filter: ["has", "point_count"],
        paint: {
          "circle-color": INK, "circle-opacity": 0.86, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5,
          "circle-radius": ["step", ["get", "point_count"], 9, 25, 11, 200, 13, 2000, 16],
        },
      });
      created.addLayer({
        id: "cluster-count", type: "symbol", source: "points", filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-allow-overlap": true },
        paint: { "text-color": "#ffffff" },
      });
      created.addLayer({
        id: "row", type: "circle", source: "points", filter: ["!", ["has", "point_count"]],
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3.6, 16, 7], "circle-color": ["case", ["get", "dim"], "#a9a9a9", INK], "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
      });

      // A property's own address, written beside it once zoomed in to street level.
      created.addLayer({
        id: "row-label", type: "symbol", source: "points", minzoom: 14.5, filter: ["all", ["!", ["has", "point_count"]], ["!=", ["get", "label"], ""]],
        layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-anchor": "top", "text-offset": [0, 0.7] },
        paint: { "text-color": INK, "text-halo-color": "rgba(255,255,255,0.92)", "text-halo-width": 1.5 },
      });

      const nameRow = (event: MapLayerMouseEvent) => {
        const properties = event.features?.[0]?.properties;
        if (!properties) return;
        created.getCanvas().style.cursor = "default";
        tip.setLngLat(event.lngLat).setHTML("<strong></strong><span></span>").addTo(created);
        const element = tip.getElement();
        element.querySelector("strong")!.textContent = String(properties.label || "Property");
        element.querySelector("span")!.textContent = "1 property";
      };
      const name = (event: MapLayerMouseEvent) => {
        const properties = event.features?.[0]?.properties;
        if (!properties) return;
        created.getCanvas().style.cursor = "pointer";
        latest.current.onHover(String(properties.area));
        const hidden = Number(properties.hidden) ? ` · ${Number(properties.hidden).toLocaleString("en-US")} filtered out` : "";
        tip.setLngLat(event.lngLat).setHTML("<strong></strong><span></span>").addTo(created);
        // Set as text, never as markup: an area's name comes from the list's own data.
        const element = tip.getElement();
        element.querySelector("strong")!.textContent = String(properties.title);
        element.querySelector("span")!.textContent = `${Number(properties.shown).toLocaleString("en-US")} ${Number(properties.shown) === 1 ? "property" : "properties"}${hidden}`;
      };
      const leave = () => {
        created.getCanvas().style.cursor = "";
        latest.current.onHover(null);
        tip.remove();
      };
      for (const layer of ["area-fill", "spot"]) {
        created.on("mousemove", layer, name);
        created.on("mouseleave", layer, leave);
        created.on("click", layer, (event: MapLayerMouseEvent) => {
          const area = event.features?.[0]?.properties?.area;
          if (area !== undefined) latest.current.onSelect(String(area));
        });
      }
      created.on("click", "clusters", (event: MapLayerMouseEvent) => {
        const feature = event.features?.[0];
        if (!feature) return;
        void (created.getSource("points") as GeoJSONSource).getClusterExpansionZoom(feature.properties.cluster_id as number).then(zoom => {
          created.easeTo({ center: (feature.geometry as unknown as { coordinates: [number, number] }).coordinates, zoom: Math.min(zoom, 18) });
        });
      });
      created.on("mousemove", "row", nameRow);
      created.on("mouseleave", "row", leave);
      created.on("mouseenter", "clusters", () => { created.getCanvas().style.cursor = "pointer"; });
      created.on("mouseleave", "clusters", () => { created.getCanvas().style.cursor = ""; });
      setReady(true);
    });
    // The background failing before anything is drawn means there is none to be had; a single missing tile does not.
    created.on("error", () => {
      if (!created.getSource("areas") && waited >= 1500) {
        window.clearInterval(giveUp);
        latest.current.onUnavailable();
      }
    });
    map.current = created;
    // The holder can change size without the window doing so (a list with more areas, a hidden tab shown again).
    const resize = new ResizeObserver(() => created.resize());
    resize.observe(holder.current);
    return () => {
      window.clearInterval(giveUp);
      frame.removeEventListener("wheel", scrollWithTouchpad, { capture: true });
      resize.disconnect();
      tip.remove();
      created.remove();
      map.current = null;
    };
  }, []);

  // The areas and rows, whenever they, the filters or the outlines change.
  useEffect(() => {
    if (!ready || !map.current) return;
    const most = Math.max(1, ...spots.map(spot => spot.shown));
    const shapes = [];
    const circles = [];
    for (const spot of spots) {
      const outline = outlines.get(spot.zip);
      const properties = {
        area: spot.area, title: spot.area === spot.zip ? spot.zip : `${spot.zip} · ${spot.area}`, shown: spot.shown, hidden: spot.hidden,
        // Spread by square root, so a few very full areas do not leave every other one the palest shade.
        share: Math.sqrt(spot.shown / most), label: spot.shown.toLocaleString("en-US"), outlined: Boolean(outline),
      };
      if (outline) shapes.push({ type: "Feature", properties, geometry: outline });
      circles.push(point(spot.lon, spot.lat, properties));
    }
    (map.current.getSource("areas") as GeoJSONSource).setData(collection(shapes));
    (map.current.getSource("spots") as GeoJSONSource).setData(collection(circles));
    (map.current.getSource("points") as GeoJSONSource).setData(collection(points.map(dot => point(dot.lon, dot.lat, { dim: Boolean(dot.dim), label: dot.label ?? "" }))));
  }, [ready, spots, points, outlines, outlineCount]);

  // What is pointed at and what is chosen stand out by everything else stepping back: the areas that belong stay in
  // full colour and the rest fade. An outline is added only when the area is one or two ZIPs; around every ZIP of a
  // whole city or state, outlines pile into a black mass.
  useEffect(() => {
    if (!ready || !map.current) return;
    const only = (area: string | null): ExpressionSpecification => ["==", ["get", "area"], area ?? " "];
    const few = (area: string | null) => area !== null && spots.filter(spot => spot.area === area).length <= 2;
    const focus = hovered ?? selected;
    // Zoom has to be the outermost thing in a rule, so "does this one belong" sits inside each step.
    const lit = (value: number, faded: number): ExpressionSpecification | number =>
      focus === null ? value : ["case", ["any", only(hovered), only(selected)], value, faded];
    const zoomed = (far: ExpressionSpecification | number, near: ExpressionSpecification | number): ExpressionSpecification =>
      ["interpolate", ["linear"], ["zoom"], 7, far, 8.4, near];
    const unlessOutlined = (value: ExpressionSpecification | number): ExpressionSpecification => ["case", ["get", "outlined"], 0, value];
    map.current.setPaintProperty("area-fill", "fill-opacity", zoomed(0, lit(0.62, 0.16)));
    map.current.setPaintProperty("area-edge", "line-opacity", zoomed(0, lit(0.9, 0.35)));
    map.current.setPaintProperty("spot", "circle-opacity", zoomed(lit(0.92, 0.2), unlessOutlined(lit(0.92, 0.2))));
    map.current.setPaintProperty("spot", "circle-stroke-opacity", zoomed(lit(1, 0.25), unlessOutlined(lit(1, 0.25))));
    map.current.setFilter("area-hover", only(hovered !== selected && few(hovered) ? hovered : null));
    map.current.setFilter("area-chosen", only(few(selected) ? selected : null));
    map.current.setFilter("area-chosen-fill", only(few(selected) ? selected : null));
    map.current.setFilter("spot-ring", ["any", only(few(hovered) ? hovered : null), only(few(selected) ? selected : null)]);
  }, [ready, hovered, selected, spots]);

  /** Moves to the chosen area, or to every row in view when none is chosen. */
  const fit = () => {
    const { spots: all, points: rows, selected: chosenArea } = latest.current;
    const chosen = chosenArea === null ? [] : all.filter(spot => spot.area === chosenArea);
    const here: Dot[] = chosen.length
      ? chosen.map(spot => ({ lon: spot.lon, lat: spot.lat }))
      // Each area counts as many times as it has rows (up to a point), so a handful of far-off rows does not set the view.
      : [...all.flatMap(spot => Array<Dot>(Math.min(spot.shown, 400)).fill({ lon: spot.lon, lat: spot.lat })), ...rows.filter(dot => !dot.dim)];
    const bounds = boundsOf(here.length ? here : all.map(spot => ({ lon: spot.lon, lat: spot.lat })));
    if (bounds && map.current) map.current.fitBounds(bounds, { padding: 48, duration: 600, maxZoom: chosen.length ? 10.8 : 14 });
  };

  // Moves when another list is shown, when its rows first arrive, and when an area is chosen or let go.
  const has = spots.length + points.length > 0;
  useEffect(() => {
    if (ready && has) fit();
    // `fit` reads the latest rows itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fitKey, has, selected]);

  return (
    <div className="street-map">
      <div ref={holder} className="street-map-canvas" role="img" aria-label="The list's areas on a street map" />
      <div className="map-controls">
        <button type="button" aria-label="Zoom in" onClick={() => map.current?.zoomIn()}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => map.current?.zoomOut()}>−</button>
        <button type="button" aria-label="Back to where the rows are" onClick={fit}>⟲</button>
      </div>
      {lookup && <p className="map-hint" role="status">{lookup}</p>}
      {spots.length > 0 && (
        <div className="map-legend" aria-hidden="true">
          <span>Fewer properties</span><i /><span>More</span>
        </div>
      )}
    </div>
  );
}
