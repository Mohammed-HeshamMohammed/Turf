import { describe, expect, it } from "vitest";
import { formatCell } from "../src/lib/list-columns";

describe("how a cell is written in the rows table", () => {
  it("writes a price as money, whether the list kept it as a number or as text", () => {
    expect(formatCell("price", 505000)).toBe("$505,000");
    expect(formatCell("price", "505000")).toBe("$505,000");
    expect(formatCell("List Price", "$1,250,000")).toBe("$1,250,000");
    expect(formatCell("price", "Call for price")).toBe("Call for price");
  });

  it("leaves ZIP codes, years and other text as they are", () => {
    expect(formatCell("zipcode", 78701)).toBe(78701);
    expect(formatCell("zipcode", "78701")).toBe("78701");
    expect(formatCell("living area", 2992)).toBe("2,992");
    expect(formatCell("beds", "4")).toBe("4");
  });
});
