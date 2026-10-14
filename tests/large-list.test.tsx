import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Turf } from "../src/App";
import { LargeListView } from "../src/components/LargeListView";
import type { Dataset } from "../src/lib/types";

const service = vi.hoisted(() => ({
  datasetRows: vi.fn(async () => [{ id: "r2", row_number: 2, raw: { "Owner Name": "John Smith", City: "Houston", Zip: "77008", Phone: "(713) 555-3142" } }]),
  listSummary: vi.fn(async () => ({
    count: 60000,
    columns: ["Owner Name", "City", "Zip", "Phone"],
    checked: false,
    verdicts: { corroborated: 0, unverified: 0, suspicious: 0, wrong: 0 },
    callable: 0,
    flags: { callable: 0, wrong: 0, dnc: 0, manual: 0, repeat: 0, once: 60000, possible: 0 },
    blocked_numbers: 0,
    reach: { phone: 48000, mail: 12000 },
    coverage: { phone: 48000, severalPhones: 0, email: 0, neither: 12000 },
    zipless: 0,
    areas: {
      city: [
        { name: "Houston", count: 36000 },
        { name: "Austin", count: 24000 },
      ],
      zip: [
        { name: "77008", count: 36000 },
        { name: "78704", count: 24000 },
      ],
    },
    places: [],
  })),
  listPage: vi.fn(async (_id: string, _areas: unknown, _reach: unknown, filter: { area?: string | null }, offset: number) => ({
    total: filter.area ? 24000 : 60000,
    rows: [
      {
        id: `r${offset + 2}`,
        row_number: offset + 2,
        raw: { "Owner Name": filter.area ? "Ann Lee" : "John Smith", City: filter.area ? "Austin" : "Houston", Zip: "77008", Phone: "" },
      },
    ],
  })),
  skiptraceSuggest: vi.fn(async () => null),
  renameDataset: vi.fn(),
  trashDataset: vi.fn(),
  savedFilters: vi.fn(async () => []),
  saveFilter: vi.fn(),
  exportList: vi.fn(),
  downloadDataset: vi.fn(),
  zipCentres: vi.fn(async () => ({})),
  zipOutlines: vi.fn(async () => ({})),
  call: vi.fn(async () => ({})),
  getLead: vi.fn(async () => ({ lead_key: "a", state: null })),
  leadNotes: vi.fn(async () => []),
}));
vi.mock("../src/lib/service", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/service")>()), ...service }));

afterEach(cleanup);

const turf = {
  datasets: [{ id: "big", name: "Big leads", kind: "import", row_count: 60000, created_at: "2026-10-14T00:00:00Z" } as unknown as Dataset],
  areaMaps: {},
  version: 0,
  manual: {},
  fail: vi.fn(),
  refresh: vi.fn(),
  open: vi.fn(),
  setMark: vi.fn(),
  setAreaMap: vi.fn(),
} as unknown as Turf;

describe("a long list in Lists", () => {
  it("shows the service's counts and one page of rows, and asks for another page or area", async () => {
    render(<LargeListView turf={turf} dataset={turf.datasets[0]} />);
    expect(await screen.findByText(/60,000 rows · 4 columns/)).toBeTruthy();
    expect(await screen.findByText("John Smith")).toBeTruthy();
    expect(screen.getByText("60,000 of 60,000 rows")).toBeTruthy();
    expect(screen.getByText("Page 1 of 2,400")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(service.listPage.mock.lastCall?.[4]).toBe(25));
    // The areas are shown by ZIP first, as a list with a ZIP column is; by city on asking.
    expect(screen.getByRole("button", { name: /78704/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "City" }));
    await userEvent.click(screen.getByRole("button", { name: /Austin/ }));
    expect(await screen.findByText("Ann Lee")).toBeTruthy();
    expect(service.listPage.mock.lastCall?.[3]).toMatchObject({ level: "city", area: "Austin" });
    expect(service.listPage.mock.lastCall?.[4]).toBe(0);
  });
});
