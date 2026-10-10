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
  const event = Object.assign(new Event("wheel", { bubbles: true, cancelable: true }), { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 0, clientY: 0 }, fields);
  let allowed = true;
  act(() => { allowed = target.dispatchEvent(event); });
  return allowed;
}

describe("plot map on a touchpad", () => {
  const dots = [{ lon: -95.4, lat: 29.7 }, { lon: -95.2, lat: 29.9 }, { lon: -95.6, lat: 29.5 }];
  const positions = (container: HTMLElement) => [...container.querySelectorAll("circle")].map(circle => Number(circle.getAttribute("cx")));
  /** The test DOM has no layout, so the plot is given the size it is drawn at. */
  const sized = (container: HTMLElement) => {
    const svg = container.querySelector("svg")!;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 520, height: 320, right: 520, bottom: 320, x: 0, y: 0, toJSON: () => ({}) });
    return svg;
  };

  it("moves with two fingers and leaves a mouse wheel to the page", () => {
    const { container } = render(<AreaMap dots={dots} interactive />);
    const svg = sized(container);
    const before = positions(container);
    expect(wheelOn(svg, { deltaY: 100 })).toBe(true);
    expect(positions(container)).toEqual(before);
    // false: the page was stopped from scrolling.
    expect(wheelOn(svg, { deltaX: 30, deltaY: 11 })).toBe(false);
    const after = positions(container);
    expect(after.every(Number.isFinite)).toBe(true);
    expect(after).not.toEqual(before);
  });

  it("zooms smoothly with a pinch", () => {
    const { container } = render(<AreaMap dots={dots} interactive />);
    const svg = sized(container);
    const spread = () => { const xs = positions(container); return Math.max(...xs) - Math.min(...xs); };
    const before = spread();
    expect(wheelOn(svg, { deltaY: -4, ctrlKey: true, clientX: 260, clientY: 160 })).toBe(false);
    const small = spread();
    expect(small).toBeGreaterThan(before);
    expect(small / before).toBeLessThan(1.05);
  });
});
