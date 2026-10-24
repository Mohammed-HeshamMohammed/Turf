import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Turf } from "../src/App";
import { LeadPanel } from "../src/components/LeadPanel";
import { CallbacksCard, ListExports } from "../src/components/ListExtras";
import { callingWindow } from "../src/lib/calling";

const service = vi.hoisted(() => ({
  leadNotes: vi.fn(async () => [{ id: "n1", note: "Wants $240k", at: "2026-10-14T10:00:00+00:00" }]),
  addLeadNote: vi.fn(async () => [{ id: "n2", note: "Call after closing", at: "2026-10-14T11:00:00+00:00" }]),
  removeLeadNote: vi.fn(async () => []),
  setLead: vi.fn(async (_row: unknown, change: Record<string, unknown>) => ({ stage: "new", callback_on: null, callback_note: "", ...change })),
  getLead: vi.fn(),
  dueCallbacks: vi.fn(),
  exportList: vi.fn(),
}));
vi.mock("../src/lib/service", () => ({
  ...service,
  localDay: (when = new Date("2026-10-14T12:00:00")) =>
    `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`,
  STAGES: ["new", "contacted", "interested", "not_interested", "dead"],
  STAGE_LABELS: { new: "New", contacted: "Contacted", interested: "Interested", not_interested: "Not interested", dead: "Dead" },
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("when a number may be called", () => {
  // 14 October 2026, 13:30 in Greenwich: half past eight in the morning in Houston, half past six in Los Angeles.
  const now = new Date("2026-10-14T13:30:00Z");
  it("says the time there, and when it is too early or too late", () => {
    expect(callingWindow(["America/Chicago"], now)).toMatchObject({ state: "ok", text: "8:30 am there" });
    expect(callingWindow(["America/Los_Angeles"], now)).toMatchObject({ state: "closed", text: "6:30 am there: too early to call (8 am to 9 pm)" });
    expect(callingWindow(["America/New_York"], new Date("2026-10-15T01:05:00Z"))).toMatchObject({ state: "closed", time: "9:05 pm" });
  });
  it("is inside the window only when it is in every zone the number could be in, and says when it cannot tell", () => {
    expect(callingWindow(["America/Chicago", "America/Los_Angeles"], now).state).toBe("closed");
    expect(callingWindow([], now)).toMatchObject({ state: "unknown", text: "The time there is not known" });
    expect(callingWindow(["Not/AZone"], now).state).toBe("unknown");
  });
});

describe("where a lead stands", () => {
  it("sets the stage, a callback and a note on the lead", async () => {
    const onChanged = vi.fn();
    render(<LeadPanel datasetId="list" rowNumber={7} state={undefined} onChanged={onChanged} onError={() => undefined} />);
    expect(await screen.findByText("Wants $240k")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Interested" }));
    expect(service.setLead).toHaveBeenCalledWith({ dataset_id: "list", row_number: 7 }, { stage: "interested" });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "In a week" }));
    expect(service.setLead.mock.calls[1][1]).toMatchObject({ callback_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    await userEvent.type(screen.getByLabelText("Note on this lead"), "Call after closing");
    await userEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(service.addLeadNote).toHaveBeenCalledWith({ dataset_id: "list", row_number: 7 }, "Call after closing");
    expect(await screen.findByText("Call after closing")).toBeTruthy();
  });
});

describe("callbacks on the Dashboard", () => {
  const callback = {
    lead_key: "a:1",
    label: "John Smith · 12 Main St",
    on: "2026-10-14",
    note: "wants an offer",
    stage: "interested",
    dataset_id: "copy",
    list: "Traced",
    row_number: 2,
    due: true,
  };
  it("lists the callbacks that are due and opens the lead in Calls", async () => {
    service.dueCallbacks.mockResolvedValue({
      today: "2026-10-14",
      due: [callback],
      coming: [{ ...callback, lead_key: "a:2", on: "2026-10-20", due: false }],
      stages: {},
    });
    const turf = { version: 0, projectId: "p", callTarget: null, openCall: vi.fn() } as unknown as Turf;
    render(<CallbacksCard turf={turf} />);
    expect(await screen.findByText("Callbacks due")).toBeTruthy();
    expect(screen.getByText("1 due · 1 later")).toBeTruthy();
    expect(screen.getByText(/Today · Interested · Traced · wants an offer/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Call John Smith · 12 Main St" }));
    expect(turf.openCall).toHaveBeenCalledWith("copy", 2);
  });
  it("is not there when nothing is waiting", async () => {
    service.dueCallbacks.mockResolvedValue({ today: "2026-10-14", due: [], coming: [], stages: {} });
    const { container } = render(<CallbacksCard turf={{ version: 0, projectId: "p", callTarget: null } as unknown as Turf} />);
    await waitFor(() => expect(service.dueCallbacks).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

describe("handing a list on", () => {
  it("saves the call list and says what was left out, and waits for a check before offering it", async () => {
    service.exportList.mockResolvedValue({ token: "t", filename: "Traced (to call).csv", size: 10, rows: 5, left_out: { no_number: 2, repeats: 1, stage: 0 } });
    const { rerender } = render(<ListExports datasetId="copy" checked fail={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Call list" }));
    await userEvent.click(screen.getByRole("button", { name: "Save the call list" }));
    expect(await screen.findByText("Traced (to call).csv: 5 rows. Left out: 2 with no number to call, 1 repeating another lead.")).toBeTruthy();
    expect(service.exportList).toHaveBeenCalledWith("calls", "copy", { skip_stages: undefined });
    await userEvent.click(screen.getByRole("button", { name: "Mail list" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Leave out PO boxes" }));
    await userEvent.click(screen.getByRole("button", { name: "Save the mail list" }));
    expect(service.exportList).toHaveBeenLastCalledWith("mail", "copy", { absentee_only: false, no_phone_only: false, skip_po_boxes: true });
    rerender(<ListExports datasetId="list" checked={false} fail={() => undefined} />);
    expect((screen.getByRole("button", { name: "Call list" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
