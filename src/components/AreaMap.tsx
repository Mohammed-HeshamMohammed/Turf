import { useEffect, useId, useMemo, useRef, useState } from "react";

export type Dot = { lon: number; lat: number; dim?: boolean; label?: string; /** The area it belongs to at the level the list is on, as the Areas list names it. */ area?: string; /** What its tag on the street map says: its price, when the list has one. */ tag?: string };

/** The part of the world in view, in degrees. */
type View = { minLon: number; maxLon: number; minLat: number; maxLat: number };

const CELL = 5;
const PAD = 22;

/**
 * Whether a wheel event comes from two fingers on a touchpad rather than a mouse wheel. A wheel turns in whole notches
 * (a pixel delta that is a multiple of 100 or 120, or in lines), a touchpad in small uneven steps, often sideways too.
 * Pinching a touchpad arrives as a wheel with Ctrl held, which is not this.
 */
export function isTouchpadScroll(event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey">): boolean {
  if (event.ctrlKey || event.metaKey || event.deltaMode !== 0) return false;
  if (event.deltaX !== 0) return true;
  const notch = Math.abs(event.deltaY);
  return notch !== 0 && !(Number.isInteger(notch) && (notch % 100 === 0 || notch % 120 === 0));
}

/** The value a given share of the way through a sorted list. */
const at = (sorted: number[], share: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))];

/**
 * The view a map opens with: where nearly all the rows are. One row a thousand miles from the rest would otherwise
 * shrink everything else to a speck, so the furthest one in a hundred on each side is left outside (and counted).
 */
export function homeView(dots: Dot[]): View | null {
  if (!dots.length) return null;
  const lons = dots.map(dot => dot.lon).sort((a, b) => a - b);
  const lats = dots.map(dot => dot.lat).sort((a, b) => a - b);
  const trim = dots.length >= 100 ? 0.01 : 0;
  let [minLon, maxLon, minLat, maxLat] = [at(lons, trim), at(lons, 1 - trim), at(lats, trim), at(lats, 1 - trim)];
  // Room around the edge, and never a view so tight that one spot fills the plot.
  const spanLon = Math.max(maxLon - minLon, 0.02);
  const spanLat = Math.max(maxLat - minLat, 0.02);
  [minLon, maxLon] = [(minLon + maxLon) / 2 - spanLon * 0.56, (minLon + maxLon) / 2 + spanLon * 0.56];
  [minLat, maxLat] = [(minLat + maxLat) / 2 - spanLat * 0.56, (minLat + maxLat) / 2 + spanLat * 0.56];
  return { minLon, maxLon, minLat, maxLat };
}

/** How degrees become plot units for a view: longitude is squeezed by the latitude so shapes are not stretched. */
function projection(view: View, width: number, height: number) {
  const squeeze = Math.cos((((view.minLat + view.maxLat) / 2) * Math.PI) / 180);
  const spanX = (view.maxLon - view.minLon) * squeeze;
  const spanY = view.maxLat - view.minLat;
  const scale = Math.min((width - PAD * 2) / spanX, (height - PAD * 2) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  return {
    scale, squeeze,
    x: (lon: number) => offsetX + (lon - view.minLon) * squeeze * scale,
    y: (lat: number) => height - offsetY - (lat - view.minLat) * scale,
  };
}

/**
 * Rows on a plain plot. No map tiles are loaded. Rows that fall on the same spot (every row placed at one ZIP's
 * centre, or a long list on a small plot) are drawn as one dot that grows with how many it stands for, so a list of
 * any length draws quickly. With `interactive`, the wheel (or pinching a touchpad) zooms, dragging or two
 * fingers on a touchpad move, and a double click goes back.
 */
export function AreaMap({ dots, width = 520, height = 320, radius = 3.2, interactive = false }: {
  dots: Dot[]; width?: number; height?: number; radius?: number; interactive?: boolean;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const home = useMemo(() => homeView(dots), [dots]);
  // null: the opening view, which follows the rows as filters change. Set once the person zooms or moves.
  const [chosen, setChosen] = useState<View | null>(null);
  const view = chosen ?? home;

  const drawn = useMemo(() => {
    if (!view) return { points: [], outside: 0 };
    const { x, y } = projection(view, width, height);
    // One dot for each small square of the plot, kept apart for the rows in view and the rows filtered out.
    const cells = new Map<string, { x: number; y: number; dim: boolean; count: number }>();
    let outside = 0;
    for (const dot of dots) {
      const px = x(dot.lon);
      const py = y(dot.lat);
      if (px < 0 || px > width || py < 0 || py > height) { outside += 1; continue; }
      const key = `${Math.round(px / CELL)},${Math.round(py / CELL)},${dot.dim ? 1 : 0}`;
      const cell = cells.get(key);
      if (cell) {
        cell.x += (px - cell.x) / (cell.count += 1);
        cell.y += (py - cell.y) / cell.count;
      } else cells.set(key, { x: px, y: py, dim: Boolean(dot.dim), count: 1 });
    }
    // Filtered-out rows first, then the largest, so small dots in view are never covered.
    return { points: [...cells.values()].sort((a, b) => Number(b.dim) - Number(a.dim) || b.count - a.count), outside };
  }, [dots, view, width, height]);

  /** Zooms by a factor around a point of the plot (in plot units), keeping that point where it is. */
  const zoom = (factor: number, px = width / 2, py = height / 2) => {
    if (!view) return;
    const { scale, squeeze, x, y } = projection(view, width, height);
    const lon = view.minLon + (px - x(view.minLon)) / (squeeze * scale);
    const lat = view.minLat + (y(view.minLat) - py) / scale;
    const span = (view.maxLon - view.minLon) * factor;
    // Between a street and the whole country.
    if (span < 0.004 || span > 80) return;
    setChosen({
      minLon: lon - (lon - view.minLon) * factor, maxLon: lon + (view.maxLon - lon) * factor,
      minLat: lat - (lat - view.minLat) * factor, maxLat: lat + (view.maxLat - lat) * factor,
    });
  };
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  /** Moves the view by a distance in plot units. */
  const pan = (dx: number, dy: number) => {
    if (!view) return;
    const { scale, squeeze } = projection(view, width, height);
    const lon = dx / (squeeze * scale);
    const lat = dy / scale;
    setChosen({ minLon: view.minLon + lon, maxLon: view.maxLon + lon, minLat: view.minLat - lat, maxLat: view.maxLat - lat });
  };
  const panRef = useRef(pan);
  panRef.current = pan;

  // The wheel is listened to directly: React's own wheel listener cannot stop the page from scrolling.
  useEffect(() => {
    const element = svg.current;
    if (!interactive || !element) return;
    const onWheel = (event: WheelEvent) => {
      const box = element.getBoundingClientRect();
      if (isTouchpadScroll(event)) {
        // Two fingers on a touchpad move the map, as they do on a street map.
        event.preventDefault();
        panRef.current((event.deltaX / box.width) * width, (event.deltaY / box.height) * height);
        return;
      }
      event.preventDefault();
      // Zooms by how far the wheel or the pinch went: a pinch arrives as many small steps, and is followed closely; a
      // notch of a mouse wheel is one gentler step.
      const rate = Math.abs(event.deltaY) >= 100 ? 0.0025 : 0.01;
      const factor = Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * rate);
      zoomRef.current(factor, ((event.clientX - box.left) / box.width) * width, ((event.clientY - box.top) / box.height) * height);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [interactive, width, height]);

  const drag = useRef<{ x: number; y: number; view: View } | null>(null);
  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!interactive || !view || event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, view };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const start = drag.current;
    if (!start) return;
    const box = event.currentTarget.getBoundingClientRect();
    const { scale, squeeze } = projection(start.view, width, height);
    const lon = (((event.clientX - start.x) / box.width) * width) / (squeeze * scale);
    const lat = (((event.clientY - start.y) / box.height) * height) / scale;
    setChosen({ minLon: start.view.minLon - lon, maxLon: start.view.maxLon - lon, minLat: start.view.minLat + lat, maxLat: start.view.maxLat + lat });
  };
  const endDrag = () => { drag.current = null; };

  // Each map has its own grid pattern: a pattern inside a hidden map cannot be borrowed by a visible one.
  const grid = `grid${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <div className={interactive ? "map-frame interactive" : "map-frame"}>
      <svg ref={svg} className="area-map" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${dots.length.toLocaleString("en-US")} properties plotted`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onDoubleClick={() => interactive && setChosen(null)}>
        <defs>
          <pattern id={grid} width="34" height="34" patternUnits="userSpaceOnUse">
            <path d="M34 0H0V34" fill="none" stroke="var(--line)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={width} height={height} fill={`url(#${grid})`} />
        {drawn.points.map((point, index) => (
          <circle key={index} cx={point.x} cy={point.y} r={Math.min(10, radius + Math.log2(point.count) * 0.6)} className={point.dim ? "dot dim" : point.count > 1 ? "dot many" : "dot"} />
        ))}
      </svg>
      {interactive && (
        <div className="map-controls">
          <button type="button" aria-label="Zoom in" onClick={() => zoom(0.6)}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => zoom(1 / 0.6)}>−</button>
          <button type="button" aria-label="Back to where the rows are" disabled={!chosen} onClick={() => setChosen(null)}>⟲</button>
        </div>
      )}
      {drawn.outside > 0 && <p className="map-outside">{drawn.outside.toLocaleString("en-US")} {drawn.outside === 1 ? "property is" : "properties are"} outside this view</p>}
    </div>
  );
}
