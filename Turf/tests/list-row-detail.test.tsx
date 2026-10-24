import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListRowDetail } from "../src/components/ListRowDetail";
import { ownerColumns } from "../src/lib/owners";
import { placeColumns } from "../src/lib/photos";
import type { DatasetRow } from "../src/lib/types";

const mocks = vi.hoisted(() => ({ census: vi.fn(), flood: vi.fn(), emails: vi.fn() }));
vi.mock("../src/lib/service", () => ({
  censusArea: mocks.census,
  getLead: async () => ({ lead_key: "a:1", state: null }),
  leadNotes: async () => [],
  setLead: vi.fn(),
  addLeadNote: vi.fn(),
  removeLeadNote: vi.fn(),
  localDay: () => "2026-10-14",
  STAGES: ["new", "contacted", "interested", "not_interested", "dead"],
  STAGE_LABELS: { new: "New", contacted: "Contacted", interested: "Interested", not_interested: "Not interested", dead: "Dead" },
  floodZone: mocks.flood,
  checkEmails: mocks.emails,
  aerialPicture: async () => ({ unavailable: "Offline" }),
  embeddedPicture: vi.fn(),
  setCensusKey: vi.fn(),
  allRows: vi.fn(),
  skiptraceSuggest: vi.fn(),
  call: vi.fn(),
}));
const row: DatasetRow = {
  id: "row",
  dataset_id: "checked",
  row_number: 2,
  raw: {
    Owner: "Ana Lopez",
    Address: "12 Main St",
    Email: "ana@gmial.com",
    Latitude: 29.76,
    Longitude: -95.37,
    Phone: "7135553142",
    Alternate: "7135554455",
    "Phone (E.164)": "+17135553142",
    "Phone (verdict)": "unverified",
    "Phone (why)": "No other evidence",
    "Alternate (E.164)": "+17135554455",
    "Alternate (verdict)": "unverified",
  },
};
const props = {
  row,
  own: ["Owner", "Address", "Email"],
  phoneColumns: ["Phone", "Alternate"],
  number: "+17135553142",
  datasetId: "checked",
  onUpdated: vi.fn(async () => {}),
  onMark: vi.fn(),
  manual: {},
  photos: { columns: [], place: placeColumns(Object.keys(row.raw)), index: new Map() },
  owner: { columns: ownerColumns(Object.keys(row.raw)), index: { byProperty: new Map(), byMailing: new Map() }, datasetId: "checked", mail: null },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.census.mockResolvedValue({ tract: { geoid: "123", name: "Tract 123" } });
  mocks.flood.mockResolvedValue({ zone: "AE", risk: "high", text: "High risk" });
  mocks.emails.mockResolvedValue({ "ana@gmial.com": { verdict: "typo", why: "Misspelling", suggestion: "ana@gmail.com" } });
});
afterEach(cleanup);

describe("expanded list rows", () => {
  it("keeps owner, email, Census and flood information together at the property's coordinates", async () => {
    render(<ListRowDetail {...props} />);
    expect(await screen.findByRole("heading", { name: "Ana Lopez" })).toBeTruthy();
    expect(await screen.findByText("Likely typo")).toBeTruthy();
    expect(screen.getByText("Probably ana@gmail.com")).toBeTruthy();
    expect(await screen.findByText("Tract 123, US Census")).toBeTruthy();
    expect(await screen.findByText("Flood zone AE")).toBeTruthy();
    expect(mocks.census).toHaveBeenCalledWith(29.76, -95.37);
    expect(mocks.flood).toHaveBeenCalledWith(29.76, -95.37, false);
  });

  it("marks the selected alternative number and retains its do-not-call end date control", async () => {
    const user = userEvent.setup();
    const view = render(<ListRowDetail {...props} />);
    await user.click(screen.getByRole("button", { name: /Number to mark:/ }));
    await user.click(screen.getByRole("option", { name: "(713) 555-4455" }));
    await user.click(screen.getByRole("button", { name: "Do not call", exact: true }));
    expect(props.onMark).toHaveBeenCalledWith("+17135554455", "do_not_call");
    view.rerender(<ListRowDetail {...props} manual={{ "+17135554455": { mark: "do_not_call", at: "2026-10-12" } }} />);
    fireEvent.change(screen.getByLabelText("Do-not-call end date (optional)"), { target: { value: "2026-11-01" } });
    expect(props.onMark).toHaveBeenLastCalledWith("+17135554455", "do_not_call", "2026-11-01");
    await user.click(screen.getByRole("button", { name: "Do not call", exact: true }));
    expect(props.onMark).toHaveBeenLastCalledWith("+17135554455", null);
  });
});
