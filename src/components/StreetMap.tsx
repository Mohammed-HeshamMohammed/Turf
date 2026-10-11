import { useEffect, useRef, useState } from "react";
import { Map as MapLibre, Popup, setWorkerUrl, type ExpressionSpecification, type GeoJSONSource, type LngLatBoundsLike, type MapLayerMouseEvent } from "maplibre-gl";
// The library draws tiles in a background worker, which the bundler has to be pointed at: it packs the worker and
// what it imports into the app, so nothing is fetched from a CDN.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { homeView, isTouchpadScroll, type Dot } from "./AreaMap";

setWorkerUrl(workerUrl);

// The street background is OpenFreeMap's full-colour style (OpenStreetMap data, free, no key): water, parks, farmland and built-up land each have their own colour. In the desktop app every
// piece of it goes through the host (src-tauri/src/mapcache.rs), which keeps a copy on disk, so parts of the map seen
// before still draw without a connection. Only the part of the map being looked at is ever asked for; no list data.
const inDesktop = "__TAURI_INTERNALS__" in window;
const TILES = !inDesktop ? "https://tiles.openfreemap.org" : navigator.userAgent.includes("Windows") ? "http://mapcache.localhost" : "mapcache://localhost";
const STYLE = `${TILES}/styles/liberty`;
// How long to wait for the background, with the window showing, before deciding it cannot be had.
const PATIENCE_MS = 9000;

/** A place properties are gathered at: a ZIP code's area. `area` is what it is called in the Areas list at its current level. */
export type Spot = { zip: string; lat: number; lon: number; shown: number; hidden: number; area: string; /** Shown properties here that have no address of their own on the map yet. */ loose: number };
/** A city or a state: where its properties are on average, and how many the filters show and hide. */
export type Group = { name: string; lat: number; lon: number; shown: number; hidden: number };
export type Outline = { type: string; coordinates: unknown };

// Few rows to many: the app's peach, deepening. Areas with every row filtered out are grey.
const RAMP: ExpressionSpecification = ["interpolate", ["linear"], ["get", "share"], 0, "#f6e6d4", 0.2, "#efc99d", 0.5, "#e2a15c", 0.8, "#c9772d", 1, "#8f4a14"];
const COLOUR: ExpressionSpecification = ["case", ["==", ["get", "shown"], 0], "#cfcfcf", RAMP];
const INK = "#121212";
/**
 * How full a state or city circle is, from 0 to 1, out of every property on the map. Circles close together are merged
 * into one that adds their counts up, so this is worked out from the count the circle itself carries.
 */
const groupShare = (total: number): ExpressionSpecification => ["min", 1, ["sqrt", ["/", ["get", "shown"], Math.max(1, total)]]];
const groupColour = (share: ExpressionSpecification): ExpressionSpecification =>
  ["case", ["==", ["get", "shown"], 0], "#cfcfcf",
    ["interpolate", ["linear"], share, 0, "#f6e6d4", 0.2, "#efc99d", 0.5, "#e2a15c", 0.8, "#c9772d", 1, "#8f4a14"]];
const GROUPS = [["state", "states", "states", 6, 14], ["city", "cities", "cities", 5, 12]] as const;
// ZIP borders are dashed lines: blue, red once the area is chosen, and green while it is pointed at.
const BORDER_BLUE = "#1f5fd6";
const BORDER_RED = "#d6322b";
const BORDER_GREEN = "#1a9d4b";
/** Shapes take over from circles as the map is zoomed in far enough for a ZIP's area to be seen. */
const fadeIn = (to: number): ExpressionSpecification => ["interpolate", ["linear"], ["zoom"], 7, 0, 8.4, to];
/** For the circles: one whose area has an outline fades away as its shape appears; one without stays. Zoom has to be the
 * outermost thing in such a rule, so the choice between the two sits inside it. */
const fadeOutIfOutlined = (from: number): ExpressionSpecification => ["interpolate", ["linear"], ["zoom"], 7, from, 8.4, ["case", ["get", "outlined"], 0, from]];

/**
 * A rounded tag, as an image the map can stretch to fit the words written on it (the two ends keep their shape).
 * Drawn at twice the size for sharp edges.
 */
function tagImage(fill: string, edge = "#ffffff") {
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const draw = canvas.getContext("2d")!;
  draw.beginPath();
  draw.roundRect(2, 2, size - 4, size - 4, 22);
  draw.fillStyle = fill;
  draw.fill();
  draw.lineWidth = 3;
  draw.strokeStyle = edge;
  draw.stroke();
  return { image: draw.getImageData(0, 0, size, size), options: { pixelRatio: 2, stretchX: [[22, 26]] as [number, number][], stretchY: [[22, 26]] as [number, number][], content: [14, 10, 34, 38] as [number, number, number, number] } };
}

/** What a card says: a name in bold, and under it how many properties, in plain words. */
const cardText = (name: ExpressionSpecification | string, count: ExpressionSpecification, note?: string): ExpressionSpecification => {
  const small = { "font-scale": 0.85, "text-color": "#6b645c", "text-font": ["literal", ["Noto Sans Regular"]] };
  return ["format", name, { "font-scale": 1, "text-font": ["literal", ["Noto Sans Bold"]] }, "\n", {},
    note ?? ["concat", ["number-format", count, { locale: "en-US" }], ["case", ["==", count, 1], " property", " properties"]], small] as unknown as ExpressionSpecification;
};
const cardLayout = (text: ExpressionSpecification, offset: number, size = 12.5) => ({
  "icon-image": "card", "icon-text-fit": "both" as const, "icon-text-fit-padding": [3, 8, 4, 8] as [number, number, number, number],
  "text-field": text, "text-font": ["Noto Sans Bold"], "text-size": size, "text-anchor": "bottom" as const, "text-offset": [0, offset] as [number, number], "text-justify": "center" as const,
  "symbol-sort-key": ["-", 0, ["get", "shown"]] as unknown as ExpressionSpecification,
});

/** A value that changes with zoom: [zoom, value] pairs, keeping only those that rise. */
const byZoom = (pairs: Array<[number, number | ExpressionSpecification]>): ExpressionSpecification => {
  const rising = pairs.filter((pair, index) => index === 0 || pair[0] > pairs[index - 1][0]);
  return ["interpolate", ["linear"], ["zoom"], ...rising.flat()] as unknown as ExpressionSpecification;
};
// The map reads as one picture at every zoom, each level standing for the one below it: states, then cities, then ZIP
// areas, then each property at its own address. A level fades in as the one above fades out.
const STATE_END = 5.6, CITY_START = 4.6, CITY_END = 8.2, ZIP_END = 13, PINS_FROM = 10.8;

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
export function StreetMap({ spots, points, outlines, outlineCount, selected, hovered, onHover, onSelect, fitKey, onUnavailable, lookup, cities = [], states = [] }: {
  spots: Spot[]; points: Dot[];
  /** The same rows gathered by city and by state, for when the map is zoomed out too far to see ZIP areas. */
  cities?: Group[]; states?: Group[];
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
      // Shops, stops and house numbers crowd the properties; the land, water, roads and names stay.
      for (const layer of created.getStyle().layers) {
        const sourceLayer = (layer as { "source-layer"?: string })["source-layer"];
        if (sourceLayer === "poi" || sourceLayer === "housenumber") created.setLayoutProperty(layer.id, "visibility", "none");
      }
      const none: ExpressionSpecification = ["==", ["get", "area"], "\u0000"];
      created.addSource("areas", { type: "geojson", data: collection([]) });
      created.addSource("spots", { type: "geojson", data: collection([]) });
      // States and cities close together on the map merge into one circle that adds their counts up, and come apart as
      // the map is zoomed in, so the numbers never pile on top of each other.
      for (const source of ["cities", "states"]) {
        created.addSource(source, {
          type: "geojson", data: collection([]), cluster: true, clusterRadius: 60, clusterMaxZoom: 12,
          clusterProperties: { shown: ["+", ["get", "shown"]], hidden: ["+", ["get", "hidden"]] },
        });
      }
      // The properties of the area chosen, each as its own mark (never merged into counted circles).
      created.addSource("chosen", { type: "geojson", data: collection([]) });
      created.addSource("points", { type: "geojson", data: collection([]), cluster: true, clusterRadius: 36, clusterMaxZoom: 14 });

      // Whole states and cities, when zoomed out too far for ZIP areas: a dot shaded by how many properties, with a card
      // naming the place and counting them. Places close together merge into one card ("12 cities").
      {
        const { image, options } = tagImage("#ffffff", "#d9d2c8");
        created.addImage("card", image, options);
      }
      for (const [id, source, noun, small, large] of GROUPS) {
        const from = id === "state" ? 0 : CITY_START;
        const to = id === "state" ? STATE_END : CITY_END;
        created.addLayer({
          id, type: "circle", source, minzoom: from, maxzoom: to,
          paint: {
            "circle-color": groupColour(groupShare(1)), "circle-stroke-color": "#ffffff", "circle-stroke-width": 2,
            "circle-radius": ["interpolate", ["linear"], groupShare(1), 0, small, 1, large],
          },
        });
        const name: ExpressionSpecification = ["case", ["has", "point_count"], ["concat", ["to-string", ["get", "point_count"]], ` ${noun}`], ["get", "title"]];
        created.addLayer({
          id: `${id}-count`, type: "symbol", source, minzoom: from, maxzoom: to, filter: [">", ["get", "shown"], 0],
          layout: cardLayout(cardText(name, ["get", "shown"]), -1.1 - large / 24),
          paint: { "text-color": INK },
        });
      }

      // ZIP areas, shaded.
      created.addLayer({ id: "area-fill", type: "fill", source: "areas", paint: { "fill-color": COLOUR, "fill-opacity": fadeIn(0.42) } });
      // A white edge under the dashes keeps them readable over the colours of the land.
      created.addLayer({ id: "area-casing", type: "line", source: "areas", layout: { "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 4, "line-opacity": fadeIn(0.8) } });
      created.addLayer({
        id: "area-edge", type: "line", source: "areas", layout: { "line-join": "round" },
        paint: { "line-color": BORDER_BLUE, "line-width": 2, "line-dasharray": [2.2, 1.4], "line-opacity": fadeIn(1) },
      });
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
      created.addLayer({
        id: "spot-ring", type: "circle", source: "spots", filter: none,
        paint: {
          "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": INK, "circle-stroke-width": 2.2,
          "circle-radius": ["interpolate", ["linear"], ["get", "share"], 0, 6, 1, 14],
          "circle-stroke-opacity": fadeOutIfOutlined(1),
        },
      });
      // What each area is and how many properties it holds, once there is room for it.
      created.addLayer({
        id: "area-count", type: "symbol", source: "spots", minzoom: 9.5, maxzoom: ZIP_END, filter: [">", ["get", "shown"], 0],
        layout: { ...cardLayout(cardText(["get", "title"], ["get", "shown"]), 0.6, 12), "text-anchor": "center", "text-offset": [0, 0] },
        paint: { "text-color": INK },
      });

      // Rows with a place of their own.
      created.addLayer({
        id: "clusters", type: "circle", source: "points", minzoom: PINS_FROM, filter: ["has", "point_count"],
        paint: {
          "circle-color": INK, "circle-opacity": byZoom([[PINS_FROM, 0], [12, 0.86]]), "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5, "circle-stroke-opacity": byZoom([[PINS_FROM, 0], [12, 1]]),
          "circle-radius": ["step", ["get", "point_count"], 9, 25, 11, 200, 13, 2000, 16],
        },
      });
      created.addLayer({
        id: "cluster-count", type: "symbol", source: "points", minzoom: PINS_FROM, filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-allow-overlap": true },
        paint: { "text-color": "#ffffff", "text-opacity": byZoom([[PINS_FROM, 0], [12, 1]]) },
      });
      created.addLayer({
        id: "row", type: "circle", source: "points", minzoom: PINS_FROM, filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3.6, 16, 7], "circle-color": ["case", ["get", "dim"], "#a9a9a9", INK],
          "circle-stroke-color": "#ffffff", "circle-stroke-width": 2, "circle-opacity": byZoom([[PINS_FROM, 0], [12, 1]]), "circle-stroke-opacity": byZoom([[PINS_FROM, 0], [12, 1]]),
        },
      });

      // A property's tag, as on a listings map: its price in a rounded tag over its pin. Tags that would cover each
      // other are left out (the pin underneath stays), so the ones shown can be read.
      for (const [name, fill] of [["tag", INK], ["tag-dim", "#a9a9a9"]] as const) {
        const { image, options } = tagImage(fill);
        created.addImage(name, image, options);
      }
      created.addLayer({
        id: "row-tag", type: "symbol", source: "points", minzoom: 14, filter: ["all", ["!", ["has", "point_count"]], ["!=", ["get", "tag"], ""]],
        layout: {
          "icon-image": ["case", ["get", "dim"], "tag-dim", "tag"], "icon-text-fit": "both", "icon-text-fit-padding": [2, 6, 3, 6],
          "text-field": ["get", "tag"], "text-font": ["Noto Sans Bold"], "text-size": 12.5, "icon-allow-overlap": false, "text-optional": false,
          "symbol-sort-key": ["get", "rank"],
        },
        paint: { "text-color": "#ffffff" },
      });

      // A property's own address, written beside it once zoomed in to street level (when it has no tag of its own).
      created.addLayer({
        id: "row-label", type: "symbol", source: "points", minzoom: 14.5, filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "tag"], ""], ["!=", ["get", "label"], ""]],
        layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-anchor": "top", "text-offset": [0, 0.7] },
        paint: { "text-color": INK, "text-halo-color": "rgba(255,255,255,0.92)", "text-halo-width": 1.5 },
      });

      // Once an area is chosen, every property in it is marked on its own: a price tag where there is a price (tags that
      // would cover each other are left out), a dot everywhere, and the address beside it when close in.
      created.addLayer({
        id: "chosen-row", type: "circle", source: "chosen", minzoom: 8.5,
        paint: {
          // Small and thinly outlined when far out, where a whole area's properties are close together, so they can be told apart.
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.8, 12, 2.6, 14, 4.8, 17, 8], "circle-color": ["case", ["get", "dim"], "#a9a9a9", INK],
          "circle-stroke-color": "#ffffff", "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 13, 1.2, 15, 2],
        },
      });
      created.addLayer({
        id: "chosen-tag", type: "symbol", source: "chosen", minzoom: 12, filter: ["!=", ["get", "tag"], ""],
        layout: {
          "icon-image": ["case", ["get", "dim"], "tag-dim", "tag"], "icon-text-fit": "both", "icon-text-fit-padding": [2, 6, 3, 6],
          "text-field": ["get", "tag"], "text-font": ["Noto Sans Bold"], "text-size": 12.5, "symbol-sort-key": ["get", "rank"],
        },
        paint: { "text-color": "#ffffff" },
      });
      created.addLayer({
        id: "chosen-label", type: "symbol", source: "chosen", minzoom: 15, filter: ["all", ["==", ["get", "tag"], ""], ["!=", ["get", "label"], ""]],
        layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-anchor": "top", "text-offset": [0, 0.7] },
        paint: { "text-color": INK, "text-halo-color": "rgba(255,255,255,0.92)", "text-halo-width": 1.5 },
      });

      // Properties whose address has not been found yet stay at the middle of their ZIP, counted, as hollow circles.
      created.addLayer({
        id: "loose", type: "circle", source: "spots", minzoom: 12, filter: [">", ["get", "loose"], 0],
        paint: {
          "circle-color": "#ffffff", "circle-stroke-color": INK, "circle-stroke-width": 2, "circle-radius": 12,
          "circle-opacity": byZoom([[12, 0], [13, 0.95]]), "circle-stroke-opacity": byZoom([[12, 0], [13, 1]]),
        },
      });
      created.addLayer({
        id: "loose-count", type: "symbol", source: "spots", minzoom: 12, filter: [">", ["get", "loose"], 0],
        layout: cardLayout(cardText(["concat", ["number-format", ["get", "loose"], { locale: "en-US" }], ["case", ["==", ["get", "loose"], 1], " property", " properties"]], ["get", "loose"], "address not found yet"), -1.3, 11.5),
        paint: { "text-color": INK },
      });

      const nameLoose = (event: MapLayerMouseEvent) => {
        const properties = event.features?.[0]?.properties;
        if (!properties) return;
        created.getCanvas().style.cursor = "default";
        tip.setLngLat(event.lngLat).setHTML("<strong></strong><span></span>").addTo(created);
        const element = tip.getElement();
        element.querySelector("strong")!.textContent = String(properties.title);
        element.querySelector("span")!.textContent = `${Number(properties.loose).toLocaleString("en-US")} ${Number(properties.loose) === 1 ? "property" : "properties"} · exact address not found yet`;
      };
      const nameGroup = (noun: string) => (event: MapLayerMouseEvent) => {
        const properties = event.features?.[0]?.properties;
        if (!properties) return;
        created.getCanvas().style.cursor = "pointer";
        const hidden = Number(properties.hidden) ? ` · ${Number(properties.hidden).toLocaleString("en-US")} filtered out` : "";
        tip.setLngLat(event.lngLat).setHTML("<strong></strong><span></span>").addTo(created);
        const element = tip.getElement();
        // A merged circle stands for several places; one that is not merged is a place with a name.
        element.querySelector("strong")!.textContent = properties.cluster ? `${Number(properties.point_count).toLocaleString("en-US")} ${noun}` : String(properties.title);
        element.querySelector("span")!.textContent = `${Number(properties.shown).toLocaleString("en-US")} ${Number(properties.shown) === 1 ? "property" : "properties"}${hidden}`;
      };
      const nameRow = (event: MapLayerMouseEvent) => {
        const properties = event.features?.[0]?.properties;
        if (!properties) return;
        created.getCanvas().style.cursor = created.getZoom() < 17.5 ? "pointer" : "default";
        tip.setLngLat(event.lngLat).setHTML("<strong></strong><span></span>").addTo(created);
        const element = tip.getElement();
        element.querySelector("strong")!.textContent = String(properties.label || "Property");
        element.querySelector("span")!.textContent = properties.tag ? `${properties.tag} · 1 property` : "1 property";
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
      created.on("mousemove", "loose", nameLoose);
      created.on("mouseleave", "loose", () => { created.getCanvas().style.cursor = ""; tip.remove(); });
      // Clicking a state or a city goes in to the next level down.
      for (const [id, source, noun, floor] of [["state", "states", "states", 6.4], ["city", "cities", "cities", 8.8]] as const) {
        created.on("mousemove", id, nameGroup(noun));
        created.on("mouseleave", id, () => { created.getCanvas().style.cursor = ""; tip.remove(); });
        created.on("click", id, (event: MapLayerMouseEvent) => {
          const feature = event.features?.[0];
          if (!feature) return;
          const center = (feature.geometry as unknown as { coordinates: [number, number] }).coordinates;
          if (!feature.properties.cluster) { created.easeTo({ center, zoom: Math.max(created.getZoom() + 2, floor) }); return; }
          // A merged circle opens into the places it stands for.
          void (created.getSource(source) as GeoJSONSource).getClusterExpansionZoom(feature.properties.cluster_id as number).then(zoom => {
            created.easeTo({ center, zoom: Math.min(Math.max(zoom, created.getZoom() + 1), 18) });
          });
        });
      }
      for (const layer of ["row", "row-tag", "chosen-row", "chosen-tag"]) {
        created.on("mousemove", layer, nameRow);
        created.on("mouseleave", layer, leave);
        // Pressing a property zooms in on it, to tell it from the ones around it.
        created.on("click", layer, (event: MapLayerMouseEvent) => {
          const feature = event.features?.[0];
          if (!feature || created.getZoom() >= 17.5) return;
          created.easeTo({ center: (feature.geometry as unknown as { coordinates: [number, number] }).coordinates, zoom: Math.min(created.getZoom() + 2.5, 18), duration: 500 });
        });
      }
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
        loose: spot.loose, looseLabel: spot.loose.toLocaleString("en-US"),
      };
      if (outline) shapes.push({ type: "Feature", properties, geometry: outline });
      circles.push(point(spot.lon, spot.lat, properties));
    }
    (map.current.getSource("areas") as GeoJSONSource).setData(collection(shapes));
    (map.current.getSource("spots") as GeoJSONSource).setData(collection(circles));
    // The properties of the area chosen are marked one by one; the rest stay gathered as before.
    const mark = (dot: Dot) => point(dot.lon, dot.lat, { dim: Boolean(dot.dim), label: dot.label ?? "", tag: dot.tag ?? "", rank: dot.dim ? 1 : 0 });
    const inChosen = (dot: Dot) => selected !== null && dot.area === selected;
    (map.current.getSource("points") as GeoJSONSource).setData(collection(points.filter(dot => !inChosen(dot)).map(mark)));
    (map.current.getSource("chosen") as GeoJSONSource).setData(collection(points.filter(inChosen).map(mark)));
    for (const [id, groups] of [["cities", cities], ["states", states]] as const) {
      (map.current.getSource(id) as GeoJSONSource).setData(collection(groups.map(group => point(group.lon, group.lat, {
        title: group.name, shown: group.shown, hidden: group.hidden,
      }))));
    }
    // Every circle is sized and shaded by its count out of all the properties placed in the places of its kind.
    for (const [id, source, small, large] of GROUPS) {
      const total = (source === "cities" ? cities : states).reduce((sum, group) => sum + group.shown, 0);
      map.current.setPaintProperty(id, "circle-color", groupColour(groupShare(total)));
      map.current.setPaintProperty(id, "circle-radius", ["interpolate", ["linear"], groupShare(total), 0, small, 1, large]);
    }
  }, [ready, spots, points, cities, states, outlines, outlineCount, selected]);

  // What is pointed at and what is chosen stand out by everything else stepping back: the areas that belong stay in
  // full colour and the rest fade.
  useEffect(() => {
    if (!ready || !map.current) return;
    const only = (area: string | null): ExpressionSpecification => ["==", ["get", "area"], area ?? " "];
    const few = (area: string | null) => area !== null && spots.filter(spot => spot.area === area).length <= 2;
    const focus = hovered ?? selected;
    // Zoom has to be the outermost thing in a rule, so "does this one belong" sits inside each step.
    const lit = (value: number, faded: number): ExpressionSpecification | number =>
      focus === null ? value : ["case", ["any", only(hovered), only(selected)], value, faded];
    // The shading is the same for every area except the one chosen, which is left clear so the map shows through it; its
    // red border says which one it is.
    const unlessChosen = (value: ExpressionSpecification | number): ExpressionSpecification => ["case", only(selected), 0, value];
    const unlessOutlined = (value: ExpressionSpecification | number): ExpressionSpecification => ["case", ["get", "outlined"], 0, value];
    // Close in, each property is on the map at its own address, so the ZIP shading steps back to a faint backdrop.
    const backdrop = (value: ExpressionSpecification | number): ExpressionSpecification => ["*", value, 0.3];
    // The borders stay clear when close in: they say where a ZIP ends however far the pins are zoomed.
    const softer = (value: ExpressionSpecification | number): ExpressionSpecification => ["*", value, 0.7];
    // Where the ZIP level begins: at once when there is no city or state level above it to hand over from.
    const zipFrom = cities.length ? CITY_END - 1 : states.length ? CITY_START : 0;
    const zipCircle = (value: number, faded: number) => byZoom([
      ...(zipFrom > 0 ? [[zipFrom, 0], [zipFrom + 1, lit(value, faded)]] as Array<[number, ExpressionSpecification | number]> : [[0, lit(value, faded)]] as Array<[number, ExpressionSpecification | number]>),
      [7, lit(value, faded)], [8.4, unlessOutlined(lit(value, faded))], [ZIP_END - 1, unlessOutlined(lit(value, faded))], [ZIP_END, 0],
    ]);
    map.current.setPaintProperty("area-fill", "fill-opacity", byZoom([[7, 0], [8.4, unlessChosen(0.42)], [ZIP_END - 1.2, unlessChosen(0.42)], [ZIP_END, unlessChosen(backdrop(0.42))]]));
    map.current.setPaintProperty("area-edge", "line-opacity", byZoom([[7, 0], [8.4, lit(1, 0.4)], [ZIP_END - 1.2, lit(1, 0.4)], [ZIP_END, softer(lit(1, 0.4))]]));
    map.current.setPaintProperty("area-casing", "line-opacity", byZoom([[7, 0], [8.4, lit(0.8, 0.25)], [ZIP_END - 1.2, lit(0.8, 0.25)], [ZIP_END, softer(lit(0.8, 0.25))]]));
    map.current.setPaintProperty("spot", "circle-opacity", zipCircle(0.92, 0.2));
    map.current.setPaintProperty("spot", "circle-stroke-opacity", zipCircle(1, 0.25));
    for (const id of ["spot", "spot-ring"]) map.current.setLayerZoomRange(id, zipFrom, ZIP_END);
    // The levels above, each handing over to the next: states to cities to ZIP areas. With no city column the states
    // hand straight to ZIP areas, and with neither the ZIP areas stand alone.
    for (const id of ["city", "city-count"]) map.current.setLayerZoomRange(id, states.length ? CITY_START : 0, CITY_END);
    const fadeOut = (to: number) => byZoom([[0, 1], [to - 1, 1], [to, 0]]);
    const fadeBetween = (from: number, to: number) => byZoom([[from, 0], [from + 1, 1], [to - 1, 1], [to, 0]]);
    const cityFade = states.length ? fadeBetween(CITY_START, CITY_END) : fadeOut(CITY_END);
    for (const [id, property, value] of [
      ["state", "circle-opacity", fadeOut(STATE_END)], ["state", "circle-stroke-opacity", fadeOut(STATE_END)],
      ["state-count", "text-opacity", fadeOut(STATE_END)], ["state-count", "icon-opacity", fadeOut(STATE_END)],
      ["city", "circle-opacity", cityFade], ["city", "circle-stroke-opacity", cityFade],
      ["city-count", "text-opacity", cityFade], ["city-count", "icon-opacity", cityFade],
    ] as const) map.current.setPaintProperty(id, property, value);
    // Borders: blue, red for the area chosen, green for the area pointed at (here or in the list). Every ZIP of an area
    // takes its colour, so a whole city is seen at once.
    map.current.setPaintProperty("area-edge", "line-color", ["case", only(hovered), BORDER_GREEN, only(selected), BORDER_RED, BORDER_BLUE]);
    map.current.setPaintProperty("area-edge", "line-width", ["case", ["any", only(hovered), only(selected)], 3, 2]);
    map.current.setPaintProperty("area-casing", "line-width", ["case", ["any", only(hovered), only(selected)], 5, 4]);
    map.current.setFilter("spot-ring", ["any", only(few(hovered) ? hovered : null), only(few(selected) ? selected : null)]);
  }, [ready, hovered, selected, spots, cities, states]);

  /** Moves to the chosen area, or to every row in view when none is chosen. */
  const fit = () => {
    const { spots: all, points: rows, selected: chosenArea } = latest.current;
    const chosen = chosenArea === null ? [] : all.filter(spot => spot.area === chosenArea);
    // An area chosen is looked at through its own addresses when it has them: close enough to see each property.
    const pins = chosenArea === null ? [] : rows.filter(dot => dot.area === chosenArea);
    const here: Dot[] = pins.length
      ? pins
      : chosen.length
      ? chosen.map(spot => ({ lon: spot.lon, lat: spot.lat }))
      // Each area counts as many times as it has rows (up to a point), so a handful of far-off rows does not set the view.
      : [...all.flatMap(spot => Array<Dot>(Math.min(spot.shown, 400)).fill({ lon: spot.lon, lat: spot.lat })), ...rows.filter(dot => !dot.dim)];
    const bounds = boundsOf(here.length ? here : all.map(spot => ({ lon: spot.lon, lat: spot.lat })));
    if (bounds && map.current) map.current.fitBounds(bounds, { padding: 48, duration: 600, maxZoom: pins.length ? 16 : chosen.length ? 10.8 : 14 });
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
      {outlineCount > 0 && (
        <div className="map-key" aria-hidden="true">
          <span><i className="blue" />ZIP border</span><span><i className="red" />Chosen</span><span><i className="green" />Pointed at</span>
        </div>
      )}
      {spots.length > 0 && (
        <div className="map-legend" aria-hidden="true">
          <span>Fewer properties</span><i /><span>More</span>
        </div>
      )}
    </div>
  );
}
