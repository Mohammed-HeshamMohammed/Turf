import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CallOutcomeLog, PhoneChoices } from "../src/components/PhoneChoices";
import { PhoneLookup } from "../src/components/PhoneLookup";
import type { PhoneChoice, SkiptraceConfig } from "../src/lib/types";
import { ownColumns, readMarks } from "../src/lib/marks";

const mocks = vi.hoisted(() => ({ call: vi.fn(), runJob: vi.fn(), watchJob: vi.fn(), cancel: vi.fn() }));
vi.mock("../src/lib/service", () => ({ call: mocks.call, runJob: mocks.runJob, watchJob: mocks.watchJob, cancelSkiptraceJob: mocks.cancel }));
const config: SkiptraceConfig = {
  phone_columns: ["Phone"],
  region: "US",
  country_column: null,
  first_name_column: null,
  last_name_column: null,
  name_column: "Name",
  zip_column: null,
  state_column: null,
  outcome: null,
  signals: {},
};
const settings = {
  provider: "Twilio Lookup v2",
  configured: false,
  enabled: false,
  products: ["line_type_intelligence"],
  unit_cost: null,
  cache_days: 30,
  currency: "USD",
};
const quote = {
  provider: "Twilio Lookup v2",
  unique_numbers: 3,
  cached: 1,
  requests: 2,
  remaining: 0,
  estimated_cost: "0.016",
  currency: "USD",
  products: ["line_type_intelligence"],
  quote_token: "reviewed-cost",
};
const choice: PhoneChoice = {
  number: "+17135553142",
  raw: "7135553142",
  column: "Phone",
  columns: ["Phone"],
  rank: 1,
  extension: null,
  valid_format: true,
  quality: "unverified",
  permission: "blocked_dnc",
  blocked: true,
  type: "mobile",
  recommendation: "Blocked",
  explanations: ["Do not call: active project DNC evidence"],
  warnings: [],
  last_success: null,
  shared: { kind: "not_shared", people: 1, explanation: "No distinct people sharing this number were identified" },
  last_outcome: null,
  lookup: null,
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.call.mockImplementation(async (command: string) => {
    if (command === "phone.lookup_settings") return settings;
    if (command === "phone.configure_lookup") return { ...settings, configured: true, enabled: true, unit_cost: "0.008" };
    if (command === "phone.lookup_preview") return quote;
    if (command === "job.get") return { state: "completed" };
    if (command === "phone.record_outcome") return { id: "event" };
    return [];
  });
  mocks.runJob.mockResolvedValue({ requested: 2, succeeded: 2, failed: 0 });
  mocks.watchJob.mockResolvedValue({ requested: 2, succeeded: 2, failed: 0 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("phone choices and dated calls", () => {
  it("keeps a reviewed recommendation visible alongside the old combined verdict and honors new DNC marks", () => {
    const raw = {
      "Best phone": "+17135553142",
      "Best phone verdict": "wrong",
      "Best phone quality": "suspicious",
      "Best phone permission": "no_recorded_block",
      "Best phone why": "Conflicting dated evidence; review before calling",
      "Best phone from": "Phone",
      "Phone (verdict)": "wrong",
      "Phone (E.164)": "+17135553142",
      "Phone (why)": "Marked wrong number 1 time (old file)",
      "Phone (quality)": "suspicious",
      "Phone (permission)": "no_recorded_block",
      "Phone choices": "[]",
      "Phone evidence warnings": "Review",
    };
    expect(readMarks(raw, ["Phone"], {}).best).toBe("+17135553142");
    expect(readMarks(raw, ["Phone"], {}).verdict).toBe("wrong");
    expect(readMarks(raw, ["Phone"], { "+17135553142": { mark: "do_not_call", at: "2026-10-09" } }).best).toBeNull();
    expect(ownColumns(Object.keys(raw))).toEqual([]);
  });
  it("shows valid quality separately from DNC without recommending a blocked number", () => {
    render(<PhoneChoices raw={{ "Phone choices": JSON.stringify([choice]) }} datasetId="list" rowNumber={2} onSaved={vi.fn(async () => {})} />);
    expect(screen.getByText("Unverified")).toBeTruthy();
    expect(screen.getByText("Do not call")).toBeTruthy();
    expect(screen.getByText("Valid number format", { exact: false })).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.queryByText("First choice")).toBeNull();
  });

  it("records the exact selected alternative and distinguishes voicemail from reaching someone", async () => {
    const onSaved = vi.fn(async () => {});
    render(<CallOutcomeLog numbers={["+17135553142", "+17135554455"]} datasetId="list" rowNumber={2} onSaved={onSaved} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Number called:/ }));
    await user.click(screen.getByRole("option", { name: "(713) 555-4455" }));
    await user.click(screen.getByRole("button", { name: /Call result:/ }));
    await user.click(screen.getByRole("option", { name: "Voicemail" }));
    await user.type(screen.getByLabelText("Notes (optional)"), "Left a message");
    await user.click(screen.getByRole("button", { name: "Save call outcome" }));
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(
        "phone.record_outcome",
        expect.objectContaining({ number: "+17135554455", outcome: "voicemail", dataset_id: "list", row_number: 2, notes: "Left a message" }),
      ),
    );
    expect(onSaved).toHaveBeenCalled();
    expect(await screen.findByText(/Call outcome saved/)).toBeTruthy();
  });

  it("retracts mistaken evidence while retaining visible history", async () => {
    const event = {
      id: "old",
      number: "+17135553142",
      outcome: "no_answer",
      occurred_at: "2026-10-08T12:00:00Z",
      recorded_at: "2026-10-08T12:01:00Z",
      notes: "No answer",
      source: "Caller Whale call log",
      retired_at: null,
      person_key: null,
    };
    mocks.call.mockImplementation(async (command: string) => (command === "phone.outcomes" ? [event] : {}));
    render(<CallOutcomeLog numbers={[event.number]} onSaved={vi.fn(async () => {})} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Retract mistaken record" }));
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith("phone.retract_outcome", { id: "old" }));
    expect(await screen.findByText(/history preserved/)).toBeTruthy();
  });
});

describe("optional live phone lookup", () => {
  it("does not call the provider automatically and requires a reviewed request/cost preview", async () => {
    const onUpdated = vi.fn(async () => {});
    render(<PhoneLookup datasetId="list" config={config} projectId="project" onUpdated={onUpdated} />);
    expect(mocks.call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Optional live phone lookup"));
    await screen.findByLabelText("Twilio Account SID");
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview requests and cost" }).hasAttribute("disabled")).toBe(true));
    expect(mocks.runJob).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Twilio Account SID"), "AC" + "a".repeat(32));
    await user.type(screen.getByLabelText("Twilio Auth Token"), "b".repeat(32));
    await user.click(screen.getByRole("checkbox", { name: "Enable optional live lookup on this computer" }));
    await user.click(screen.getByRole("button", { name: "Save provider settings" }));
    await screen.findByText(/Provider settings saved/);
    expect((screen.getByLabelText("Twilio Auth Token") as HTMLInputElement).value).toBe("");
    await user.click(screen.getByRole("button", { name: "Preview requests and cost" }));
    expect(await screen.findByText(/Estimated cost: 0.016 USD/)).toBeTruthy();
    expect(mocks.runJob).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send 2 numbers and run lookup" }));
    await waitFor(() =>
      expect(mocks.runJob).toHaveBeenCalledWith(
        "phone.lookup",
        { dataset_id: "list", config, max_numbers: 100, quote_token: "reviewed-cost" },
        expect.anything(),
      ),
    );
    expect(await screen.findByText(/Lookup finished: 2 succeeded/)).toBeTruthy();
    expect(onUpdated).toHaveBeenCalled();
  });

  it("states unknown cost explicitly instead of calling it free", async () => {
    mocks.call.mockImplementation(async (command: string) => {
      if (command === "phone.lookup_settings") return { ...settings, configured: true, enabled: true };
      if (command === "phone.lookup_preview") return { ...quote, estimated_cost: null };
      return [];
    });
    render(<PhoneLookup datasetId="list" config={config} projectId="project" onUpdated={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByText("Optional live phone lookup"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview requests and cost" }).hasAttribute("disabled")).toBe(false));
    await userEvent.setup().click(screen.getByRole("button", { name: "Preview requests and cost" }));
    expect(await screen.findByText(/Price is unknown: provider charges may apply/)).toBeTruthy();
    expect(mocks.runJob).not.toHaveBeenCalled();
  });

  it("reconnects to the existing job after reload instead of submitting paid requests again", async () => {
    localStorage.setItem("callerwhale.phone.lookup.project.list", "existing-job");
    render(<PhoneLookup datasetId="list" config={config} projectId="project" onUpdated={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByText("Optional live phone lookup"));
    await waitFor(() => expect(mocks.watchJob).toHaveBeenCalledWith("existing-job", expect.anything()));
    await screen.findByText(/Lookup finished/);
    expect(mocks.runJob).not.toHaveBeenCalled();
    expect(localStorage.getItem("callerwhale.phone.lookup.project.list")).toBeNull();
  });
});
