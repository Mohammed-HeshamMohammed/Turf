import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { AreaMap, isTouchpadScroll } from "../src/components/AreaMap";

afterEach(cleanup);

const wheel = (init: Partial<Parameters<typeof isTouchpadScroll>[0]>) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, ...init });

describe("touchpad scrolling", () => {
  it("tells two fingers on a touchpad from a mouse wheel and from a pinch", () => {
    expect(isTouchpadScroll(wheel({ deltaY: 7.5 }))).toBe(true);
    expect(isTouchpadScroll(wheel({ deltaY: 13, deltaX: 4 }))).toBe(true);
    expect(isTouchpadScroll(wheel({ deltaY: 3, deltaX: 0 }))).toBe(true);
    expect(isTouchpadScroll(wheel({ deltaY: 100 }))).toBe(false);
    expect(isTouchpadScroll(wheel({ deltaY: -120 }))).toBe(false);
    expect(isTouchpadScroll(wheel({ deltaY: 3, deltaMode: 1 }))).toBe(false);
    expect(isTouchpadScroll(wheel({ deltaY: 3, ctrlKey: true }))).toBe(false);
  });
});

/** Sends a wheel event with every field set: the test DOM's own WheelEvent drops Ctrl and the pointer position. Returns false when the page was stopped from scrolling. */
function wheelOn(target: Element, fields: Partial<Record<"deltaX" | "deltaY" | "ctrlKey" | "clientX" | "clientY", number | boolean>>) {
  const event = Object.assign(
    new Event("wheel", { bubbles: true, cancelable: true }),
    { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 0, clientY: 0 },
    fields,
  );
  let allowed = true;
  act(() => {
    allowed = target.dispatchEvent(event);
  });
  return allowed;
}

describe("plot map on a touchpad", () => {
  const dots = [
    { lon: -95.4, lat: 29.7 },
    { lon: -95.2, lat: 29.9 },
    { lon: -95.6, lat: 29.5 },
  ];
  const positions = (container: HTMLElement) => [...container.querySelectorAll("circle")].map(circle => Number(circle.getAttribute("cx")));
  /** The test DOM has no layout, so the plot is given the size it is drawn at. */
  const sized = (container: HTMLElement) => {
    const svg = container.querySelector("svg")!;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 520, height: 320, right: 520, bottom: 320, x: 0, y: 0, toJSON: () => ({}) });
    return svg;
  };

  it("moves with two fingers", () => {
    const { container } = render(<AreaMap dots={dots} interactive />);
    const svg = sized(container);
    const before = positions(container);
    // false: the page was stopped from scrolling.
    expect(wheelOn(svg, { deltaX: 30, deltaY: 11 })).toBe(false);
    const after = positions(container);
    expect(after.every(Number.isFinite)).toBe(true);
    expect(after).not.toEqual(before);
  });

  it("zooms smoothly with a pinch", () => {
    const { container } = render(<AreaMap dots={dots} interactive />);
    const svg = sized(container);
    const spread = () => {
      const xs = positions(container);
      return Math.max(...xs) - Math.min(...xs);
    };
    const before = spread();
    expect(wheelOn(svg, { deltaY: -4, ctrlKey: true, clientX: 260, clientY: 160 })).toBe(false);
    const small = spread();
    expect(small).toBeGreaterThan(before);
    expect(small / before).toBeLessThan(1.05);
  });
});

describe("plot map with a mouse wheel", () => {
  it("zooms in and out without Ctrl", () => {
    const { container } = render(
      <AreaMap
        dots={[
          { lon: -95.4, lat: 29.7 },
          { lon: -95.2, lat: 29.9 },
          { lon: -95.6, lat: 29.5 },
        ]}
        interactive
      />,
    );
    const svg = container.querySelector("svg")!;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 520, height: 320, right: 520, bottom: 320, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const spread = () => {
      const xs = [...container.querySelectorAll("circle")].map(circle => Number(circle.getAttribute("cx")));
      return Math.max(...xs) - Math.min(...xs);
    };
    const start = spread();
    expect(wheelOn(svg, { deltaY: -100, clientX: 260, clientY: 160 })).toBe(false);
    const closer = spread();
    expect(closer).toBeGreaterThan(start * 1.2);
    wheelOn(svg, { deltaY: 100, clientX: 260, clientY: 160 });
    expect(spread()).toBeLessThan(closer);
  });
});

describe("naming placed properties", () => {
  it("carries a row's street address to its spot on the map", async () => {
    const { placeRows } = await import("../src/lib/geo");
    const rows = [{ id: "a", row_number: 1, raw: { Street: " 12 Olive St ", Zip: "91706" } }] as never;
    const placement = placeRows(rows, { position: null, zipColumn: "Zip", centres: new Map(), exact: { "1": [34.08, -117.97] }, streetColumn: "Street" });
    expect(placement.dots).toEqual([{ lat: 34.08, lon: -117.97, rowId: "a", zip: "91706", label: "12 Olive St", exact: true }]);
  });
});

describe("the levels of the map", () => {
  it("counts every property in its ZIP, city and state however it was placed", async () => {
    const { gatherForMap } = await import("../src/lib/geo");
    const row = (id: string, city: string, zip: string) => ({ id, row_number: Number(id), raw: { City: city, State: "ca", Zip: zip } });
    const rows = [row("1", "Baldwin Park", "91706"), row("2", "Baldwin Park", "91706"), row("3", "Irwindale", "91706")] as never;
    const columns = { zip: "Zip", city: "City", state: "State" };
    const dots = [
      { lat: 34.08, lon: -117.97, rowId: "1", zip: "91706", exact: true, label: "12 Olive St" },
      { lat: 34.09, lon: -117.96, rowId: "2", zip: "91706" },
      { lat: 34.1, lon: -117.95, rowId: "3", zip: "91706" },
    ];
    const map = gatherForMap([{ rows, dots, columns, kept: new Set(["1", "2"]) }], new Map([["91706", { lat: 34.09, lon: -117.96, states: ["CA"] }]]));
    expect(map.points).toEqual([{ lon: -117.97, lat: 34.08, dim: false, label: "12 Olive St", area: "91706" }]);
    expect(map.spots).toEqual([expect.objectContaining({ zip: "91706", shown: 2, hidden: 1, loose: 1, lat: 34.09 })]);
    expect(map.cities.map(city => [city.name, city.shown, city.hidden])).toEqual([
      ["Baldwin Park, CA", 2, 0],
      ["Irwindale, CA", 0, 1],
    ]);
    expect(map.states).toEqual([expect.objectContaining({ name: "CA", shown: 2, hidden: 1 })]);
  });
});

describe("price tags", () => {
  it("writes prices the way a listings map does and finds the price column", async () => {
    const { priceTag, priceColumn } = await import("../src/lib/geo");
    expect(priceTag(425000)).toBe("$425K");
    expect(priceTag("$1,080,000")).toBe("$1.08M");
    expect(priceTag("2000000")).toBe("$2.00M");
    expect(priceTag(950)).toBe("$950");
    expect(priceTag("")).toBeUndefined();
    expect(priceTag("n/a")).toBeUndefined();
    expect(priceTag(null)).toBeUndefined();
    expect(priceColumn(["Name", "Street", "List Price"])).toBe("List Price");
    expect(priceColumn(["Name", "Zestimate"])).toBe("Zestimate");
    expect(priceColumn(["Name", "Phone"])).toBeUndefined();
  });

  it("puts a row's price on its place", async () => {
    const { placeRows } = await import("../src/lib/geo");
    const rows = [{ id: "a", row_number: 1, raw: { Street: "12 Olive St", Zip: "91706", Price: "$425,000" } }] as never;
    const { dots } = placeRows(rows, {
      position: null,
      zipColumn: "Zip",
      centres: new Map(),
      exact: { "1": [34.08, -117.97] },
      streetColumn: "Street",
      tagColumn: "Price",
    });
    expect(dots[0].tag).toBe("$425K");
  });
});
