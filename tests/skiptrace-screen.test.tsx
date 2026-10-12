import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkipTracing } from "../src/tabs/SkipTracing";
import type { Turf } from "../src/App";
import type { SkiptraceConfig, SkiptraceReport, SkiptraceSuggestion } from "../src/lib/types";
import { stableKey } from "../src/lib/skiptrace-workflow";

const mocks = vi.hoisted(() => ({ suggest: vi.fn(), statuses: vi.fn(), save: vi.fn(), scan: vi.fn(), apply: vi.fn(), freshness: vi.fn(), review: vi.fn(), cancel: vi.fn(), watch: vi.fn() }));
vi.mock("../src/lib/service", () => ({
  knownSuggestion: () => null, skiptraceSuggest: mocks.suggest, skiptraceStatuses: mocks.statuses, skiptraceSave: mocks.save,
  skiptraceScan: mocks.scan, skiptraceApply: mocks.apply, skiptraceFreshness: mocks.freshness, skiptraceReview: mocks.review,
  cancelSkiptraceJob: mocks.cancel, watchJob: mocks.watch, markHistory: async () => [], inDesktop: false, importFile: vi.fn(), pickImportFile: vi.fn(), describeLeftOut: () => "",
}));

const config: SkiptraceConfig = { phone_columns: ["Phone"], region: "US", country_column: null, first_name_column: null, last_name_column: null, name_column: "Name", zip_column: null, state_column: null,
  outcome: null, signals: { shared_number: true, business_line: true, area_code_other_state: false, country_mismatch: true } };
const statuses = Array.from({ length: 101 }, (_, i) => ({ key: `status ${i}`, example: `Status ${i}`, count: 1, outcomes: [] }));
const setup: SkiptraceSuggestion = { dataset_id: "list", rows: 101, columns: ["Name", "Phone", "Status"], config, saved: false, roles_confirmed: false,
  outcome_candidates: [{ column: "Status", filled: 101, distinct: 101 }], outcome_column: "Status", statuses,
  outcomes: [{ id: "wrong_number", label: "Wrong number" }, { id: "do_not_call", label: "Do not call" }, { id: "reached", label: "Reached a person" }],
  signals: [{ code: "shared_number", label: "Shared number", measured_only: false }, { code: "business_line", label: "Business line", measured_only: false }, { code: "area_code_other_state", label: "Other state", measured_only: false }, { code: "country_mismatch", label: "Other country", measured_only: false }, { code: "same_as_other_column", label: "Repeats another column", measured_only: true }],
  column_samples: { Name: ["Ada"], Phone: ["7135553142"], Status: ["Status 0"] },
};
const report: SkiptraceReport = { scan_job_id: "scan-1", fingerprint: "fresh", checked_at: "2026-10-09T12:00:00Z", checked_date: "2026-10-09", manual_evidence: {},
  rows: 101, rows_with_phone: 101, rows_with_callable_number: 101, values: 101, verdicts: { wrong: 0, suspicious: 0, unverified: 101, corroborated: 0 },
  row_counts: { all: 101, callable: 101, known_wrong: 0, dnc: 0, needs_review: 101, no_phone: 0 },
  preview: [{ row_number: 2, raw: { Name: "Ada", Phone: "7135553142", "Phone (verdict)": "unverified", "Phone (why)": "", "Phone (E.164)": "+17135553142", "Phone (type)": "landline or mobile", "Best phone": "+17135553142", "Best phone verdict": "unverified", "Best phone from": "Phone" } }],
  added_columns: ["Phone (verdict)", "Phone (why)", "Phone (E.164)", "Phone (type)", "Best phone", "Best phone verdict", "Best phone from"],
  columns: [{ column: "Phone", filled: 101, filled_share: 1, valid: 101, valid_share: 1, distinct: 101, wrong: 0, adds_info: 101, adds_info_share: 1, verdicts: { wrong: 0, suspicious: 0, unverified: 101, corroborated: 0 }, verdict_text: "Useful" }],
  reasons: [{ code: "known_wrong", label: "Example reason", effect: "wrong", count: 0, examples: [{ row: 2, column: "Phone", value: "7135553142", text: "Example" }] }],
  types: { mobile: 101 }, countries: { US: 101 }, repairs: [], signals: [], metadata_version: "9", other_datasets_used: [],
  outcomes: { available: true, rows: {}, baseline_wrong_rate: null, contacted: 0, known_wrong_numbers: 0, do_not_call_numbers: 0, expired_do_not_call_numbers: 0, carried_rows: 0, carried_wrong_number: 0, carried_do_not_call: 0 },
};
const turf: Turf = { projectId: "project", datasets: [{ id: "list", name: "Monthly list", kind: "import", source_filename: "monthly.csv", row_count: 101, column_count: 3, created_at: "2026-10-09", mapping_version: null }], version: 0,
  selectedId: "list", select: vi.fn(), open: vi.fn(), refresh: vi.fn(async () => undefined), manual: {}, legacyManual: {}, importLegacy: vi.fn(async () => undefined), setMark: vi.fn(), areaMaps: {}, setAreaMap: vi.fn(), fail: vi.fn() };

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  mocks.suggest.mockResolvedValue(structuredClone(setup)); mocks.statuses.mockResolvedValue(structuredClone(statuses));
  mocks.save.mockResolvedValue(config); mocks.scan.mockResolvedValue({ report: structuredClone(report) });
  mocks.apply.mockResolvedValue({ dataset_id: "copy", rows: 101, added_columns: report.added_columns });
  mocks.freshness.mockResolvedValue({ fingerprint: "fresh", date: "2026-10-09" });
  mocks.review.mockResolvedValue({ total: 1, rows: report.preview }); mocks.cancel.mockResolvedValue({});
});
afterEach(cleanup);

async function start() {
  render(<SkipTracing turf={turf} />);
  await screen.findByRole("heading", { name: "Monthly list" });
  const user = userEvent.setup();
  const allFields = screen.queryByRole("button", { name: /^All fields/ });
  if (allFields) await user.click(allFields);
  return user;
}
async function scan(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /3\s*Warning signs/ }));
  await user.click(screen.getByRole("button", { name: "Check phone numbers" }));
  await screen.findByRole("heading", { name: "What needs attention?" });
  await waitFor(() => expect((within(document.querySelector(".wizard-nav") as HTMLElement).getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false));
}

describe("the complete five-step process", () => {
  it("filters wide source-column lists and searches every field", async () => {
    const extra = Array.from({ length: 16 }, (_, index) => `Column ${index + 1}`);
    mocks.suggest.mockResolvedValue({ ...setup, columns: [...setup.columns, ...extra] });
    const user = await start();
    expect(document.querySelectorAll(".skiptrace-column-row")).toHaveLength(19);
    await user.click(screen.getByRole("button", { name: /^Mapped/ }));
    expect(document.querySelectorAll(".skiptrace-column-row")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /^Other fields/ }));
    expect(document.querySelectorAll(".skiptrace-column-row")).toHaveLength(17);
    await user.type(screen.getByRole("searchbox", { name: "Find a column" }), "Column 14");
    expect(document.querySelectorAll(".skiptrace-column-row")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^All fields/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("assigns phone and context roles in the same list without duplicate mappings", async () => {
    mocks.suggest.mockResolvedValue({ ...setup, columns: ["First Name", "Last Name", "Address", "City", "State", "Zip", "Contact", "Other State"], config: { ...config, phone_columns: [], name_column: null, first_name_column: "First Name", last_name_column: "Last Name", state_column: "State", zip_column: "Zip" } });
    const user = await start();
    expect(document.querySelectorAll(".skiptrace-column-row")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Role for First Name: Owner first name" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Role for Contact: Not used in this step" }));
    await user.click(screen.getByRole("option", { name: "Phone number", exact: true }));
    expect((within(document.querySelector(".wizard-nav") as HTMLElement).getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Role for Other State: Not used in this step" }));
    await user.click(screen.getByRole("option", { name: "Property state", exact: true }));
    expect(screen.getByRole("button", { name: "Role for State: Not used in this step" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Role for Address: Not used in this step" }));
    await user.click(screen.getByRole("option", { name: "Property street address", exact: true }));
    await user.click(screen.getByRole("button", { name: "Role for City: Not used in this step" }));
    await user.click(screen.getByRole("option", { name: "Phone number", exact: true }));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("turf.skiptrace.draft.project.list")!).state;
      expect(saved.base.phone_columns).toEqual(["Contact", "City"]);
      expect(saved.base.state_column).toBe("Other State");
      expect(saved.base.address_column).toBe("Address");
      expect(saved.called).toBe("Contact");
    });
    await user.click(screen.getByRole("button", { name: "Role for Contact: Phone number" }));
    await user.click(screen.getByRole("option", { name: "Not used in this step", exact: true }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("turf.skiptrace.draft.project.list")!).state.called).toBe("City"));
  });

  it("keeps secondary owner names and mailing roles separate and saves phone associations", async () => {
    mocks.suggest.mockResolvedValue({ ...setup, columns: ["Name", "Second Owner", "Phone", "Other Phone", "Mailing City", "Vacant?", "Status"] });
    const user = await start();
    await user.click(screen.getByRole("button", { name: "Add another owner" }));
    await user.click(screen.getByRole("button", { name: "Role for Second Owner: Not used in this step" }));
    await user.click(screen.getByRole("option", { name: "Owner full name", exact: true }));
    expect(screen.getByRole("button", { name: "Role for Name: Owner full name" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Owner for Second Owner: Owner 2" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Role for Other Phone: Not used in this step" }));
    await user.click(screen.getByRole("option", { name: "Phone number", exact: true }));
    expect(screen.getByRole("button", { name: "Owner for Other Phone: Owner not assigned" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Owner for Other Phone: Owner not assigned" }));
    await user.click(screen.getByRole("option", { name: "Owner 2", exact: true }));
    await user.click(screen.getByRole("button", { name: "Role for Mailing City: Not used in this step" }));
    await user.click(screen.getByRole("option", { name: "Mailing city", exact: true }));
    await user.click(screen.getByRole("button", { name: "Owner for Mailing City: Owner 1" }));
    await user.click(screen.getByRole("option", { name: "Owner 2", exact: true }));
    await user.click(screen.getByRole("button", { name: "Role for Vacant?: Not used in this step" }));
    await user.click(screen.getByRole("option", { name: "Vacancy / vacant", exact: true }));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("turf.skiptrace.draft.project.list")!).state.base;
      expect(saved.name_column).toBe("Name");
      expect(saved.additional_owners[0]).toMatchObject({ name_column: "Second Owner", mailing_city_column: "Mailing City" });
      expect(saved.phone_owner_map).toEqual({ Phone: 0, "Other Phone": 1 });
      expect(saved.vacancy_column).toBe("Vacant?");
    });
    await user.click(screen.getByRole("button", { name: "Remove Owner 2" }));
    await user.click(screen.getByRole("button", { name: "Owner for Other Phone: Owner not assigned" }));
    await user.click(screen.getByRole("option", { name: "Owner 1", exact: true }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("turf.skiptrace.draft.project.list")!).state.base.phone_owner_map["Other Phone"]).toBe(0));
  });

  it("keeps identifier-looking columns from being accepted without review", async () => {
    mocks.suggest.mockResolvedValue({ ...setup, columns: ["APN", "Name", "Phone", "Status"], config: { ...config, phone_columns: ["APN"] }, column_samples: { ...setup.column_samples, APN: ["6117-016-011"] } });
    const user = await start();
    const next = within(document.querySelector(".wizard-nav") as HTMLElement).getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(screen.getByText(/name looks like an identifier/)).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "I verified these are phone numbers" }));
    expect(next.disabled).toBe(false);
  });

  it("uses dialer results without showing credential setup and saves mappings without a scan", async () => {
    const user = await start();
    expect(screen.queryByLabelText("Twilio Account SID")).toBeNull();
    expect(screen.queryByText("Optional live phone lookup")).toBeNull();
    await user.click(within(document.querySelector(".wizard-nav") as HTMLElement).getByRole("button", { name: "Next" }));
    expect(screen.queryByRole("heading", { name: "Use your existing dialer's results" })).toBeNull();
    await user.click(screen.getByText("Import or map a dialer export"));
    expect(screen.getByRole("heading", { name: "Use your existing dialer's results" })).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "Status 0: Wrong number" }));
    await user.click(screen.getByRole("button", { name: "Save outcome mappings" }));
    expect(await screen.findByText(/Dialer mappings saved/)).toBeTruthy();
    expect(mocks.save.mock.calls[0][1].outcome.map["status 0"]).toEqual(["wrong_number"]);
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(turf.refresh).toHaveBeenCalled();
  });
  it("shows column samples and makes status 101 searchable and intentionally ignorable", async () => {
    const user = await start();
    expect(screen.getByText("7135553142")).toBeTruthy();
    await user.click(within(document.querySelector(".wizard-nav") as HTMLElement).getByRole("button", { name: "Next" }));
    await user.type(screen.getByRole("searchbox", { name: "Search call statuses" }), "Status 100");
    const table = screen.getByRole("table", { name: "What each status means" });
    expect(within(table).getByText("Status 100")).toBeTruthy();
    await user.click(within(table).getByRole("button", { name: "Ignore" }));
    expect(within(table).getByText("Intentionally ignored")).toBeTruthy();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("turf.skiptrace.draft.project.list")!).state.reviewed).toContain("status 100"));
    await user.click(within(document.querySelector(".wizard-nav") as HTMLElement).getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Check phone numbers" }));
    await waitFor(() => expect(mocks.save.mock.calls[0][1].outcome.map["status 100"]).toEqual([]));
  });

  it("keeps every report section, reviews exact rows, and saves the reviewed scan", async () => {
    const user = await start(); await scan(user);
    for (const heading of ["Results", "Which phone columns are worth using", "Why numbers got their verdict", "Do the warning signs predict wrong numbers here?", "What was found in the numbers", "Marks made in Turf"]) expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    const columnReport = document.querySelector('[id="columns-list"]') as HTMLDetailsElement;
    expect(columnReport.open).toBe(false);
    await user.click(within(columnReport).getByText("Which phone columns are worth using"));
    expect(columnReport.open).toBe(true);
    await user.click(screen.getByRole("button", { name: /Rows needing review/ }));
    await waitFor(() => expect(mocks.review).toHaveBeenCalledWith("scan-1", "needs_review", 0, undefined));
    await user.click(within(document.querySelector(".wizard-nav") as HTMLElement).getByRole("button", { name: "Next" }));
    expect(screen.getByText(/A new list with all 101 rows and the results added/)).toBeTruthy();
    expect(screen.getByText(/101 of 101 rows have one/)).toBeTruthy();
    const preview = screen.getByText("Preview the checked copy").closest("details") as HTMLDetailsElement;
    expect(preview.open).toBe(false);
    await user.click(screen.getByText("Preview the checked copy"));
    expect(preview.open).toBe(true);
    expect(screen.getByRole("table", { name: /First 1 rows of this exact check/ })).toBeTruthy();
    expect(within(document.querySelector(".wizard-nav") as HTMLElement).getByRole("button", { name: "Save checked copy" })).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Name of the checked copy" }), "Reviewed October");
    await user.click(screen.getByRole("button", { name: "Save checked copy" }));
    await waitFor(() => expect(mocks.apply.mock.calls[0].slice(0, 4)).toEqual(["list", config, "Reviewed October", "scan-1"]));
    await screen.findByText("Saved 101 rows with 7 new columns as a new list.");
    expect(within(document.querySelector(".wizard-nav") as HTMLElement).queryByRole("button", { name: "Save checked copy" })).toBeNull();
    expect(within(document.querySelector(".wizard-nav") as HTMLElement).getByRole("button", { name: "Open in Lists" })).toBeTruthy();
  });

  it("restores the draft after the screen is unmounted, including deliberate ignores", async () => {
    const user = await start();
    await user.click(within(document.querySelector(".wizard-nav") as HTMLElement).getByRole("button", { name: "Next" }));
    await user.type(screen.getByRole("searchbox", { name: "Search call statuses" }), "Status 100");
    await user.click(screen.getByRole("button", { name: "Ignore" }));
    cleanup();
    render(<SkipTracing turf={turf} />);
    await screen.findByRole("heading", { name: "Use call results, if you have them" });
    await waitFor(() => expect(mocks.statuses).toHaveBeenCalled());
    const input = screen.getByRole("searchbox", { name: "Search call statuses" });
    await user.type(input, "Status 100");
    expect(await screen.findByText("Intentionally ignored")).toBeTruthy();
  });

  it("refuses a template with missing columns without changing the setup", async () => {
    localStorage.setItem("turf.skiptrace.templates.project", JSON.stringify([{ id: "template", name: "Another export", config: { ...config, phone_columns: ["Missing phone"] }, at: "2026-10-09" }]));
    const user = await start();
    fireEvent.click(screen.getByText("Reuse or save a setup template"));
    await user.click(screen.getByRole("button", { name: /Saved setup:/ }));
    await user.click(screen.getByRole("option", { name: "Another export" }));
    await user.click(screen.getByRole("button", { name: "Apply and review" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Missing phone"));
    expect(screen.getByRole("button", { name: "Role for Phone: Phone number" })).toBeTruthy();
  });

  it("blocks saving when project evidence has changed since the check", async () => {
    const user = await start(); await scan(user);
    mocks.freshness.mockResolvedValue({ fingerprint: "changed", date: "2026-10-09" });
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText(/project evidence changed after this check/)).toBeTruthy();
    expect((within(document.querySelector(".wizard-nav") as HTMLElement).getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("shows progress, freezes setup during a check, and requests cancellation", async () => {
    let rejectScan: (reason: Error) => void = () => undefined;
    mocks.scan.mockImplementation((_id, _config, watch) => {
      watch.onStart("running-job"); watch.onEvent({ stage: "checking_phones", completed: 250, total: 1000 });
      return new Promise((_resolve, reject) => { rejectScan = reject; });
    });
    const user = await start();
    await user.click(screen.getByRole("button", { name: /3\s*Warning signs/ }));
    await user.click(screen.getByRole("button", { name: "Check phone numbers" }));
    expect(await screen.findByRole("progressbar", { name: "Phone check progress" })).toBeTruthy();
    const setupFieldset = screen.getByRole("group", { name: "Phone-check setup" });
    expect((setupFieldset as HTMLFieldSetElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(mocks.cancel).toHaveBeenCalledWith("running-job");
    rejectScan(new Error("The job was cancelled"));
    await screen.findByRole("alert");
    await waitFor(() => expect((setupFieldset as HTMLFieldSetElement).disabled).toBe(false));
  });

  it("a saved scan can be resumed after reload without checking again", async () => {
    const draft = { base: config, outcomeColumn: null, called: "Phone", meaning: {}, reviewed: [], step: 4, copyName: "Restored copy", report, scannedWith: stableKey(config) };
    localStorage.setItem("turf.skiptrace.draft.project.list", JSON.stringify({ version: 1, state: draft }));
    const user = await start();
    await screen.findByRole("heading", { name: "Save the checked copy" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Save checked copy" }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole("button", { name: "Save checked copy" }));
    await waitFor(() => expect(mocks.apply).toHaveBeenCalled());
    expect(mocks.scan).not.toHaveBeenCalled();
  });

  it("reconnects to a running scan after reload and keeps its completed report", async () => {
    const draft = { base: config, outcomeColumn: null, called: "Phone", meaning: {}, reviewed: [], step: 2, copyName: "", report: null, scannedWith: null,
      activeJob: { id: "running-job", kind: "scan", configKey: stableKey(config) } };
    localStorage.setItem("turf.skiptrace.draft.project.list", JSON.stringify({ version: 1, state: draft }));
    mocks.watch.mockResolvedValue({ report });
    await start();
    await screen.findByRole("heading", { name: "What needs attention?" });
    expect(mocks.watch.mock.calls[0][0]).toBe("running-job");
    expect(mocks.scan).not.toHaveBeenCalled();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("turf.skiptrace.draft.project.list")!).state.activeJob).toBeNull());
  });

  it("keeps compatible DNC combinations and prevents a status being both wrong and reached", async () => {
    const user = await start();
    await user.click(within(document.querySelector(".wizard-nav") as HTMLElement).getByRole("button", { name: "Next" }));
    await user.click(screen.getByLabelText("Edit meanings for Status 0"));
    await user.click(screen.getByRole("checkbox", { name: "Status 0: Wrong number" }));
    await user.click(screen.getByRole("checkbox", { name: "Status 0: Do not call" }));
    await user.click(screen.getByRole("checkbox", { name: "Status 0: Reached a person" }));
    expect((screen.getByRole("checkbox", { name: "Status 0: Wrong number" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Status 0: Do not call" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Status 0: Reached a person" }) as HTMLInputElement).checked).toBe(true);
  });
  it("shows what each warning sign needs and offers what the last check measured", async () => {
    const measured = (code: string, predictive: boolean) => ({ code, label: code, contacted: 120, wrong: 30, wrong_rate: 0.25, lift: predictive ? 2 : 1, counted: true, measured_only: false, predictive, enough_data: true });
    mocks.scan.mockResolvedValue({ report: { ...structuredClone(report), signals: [measured("shared_number", false), measured("business_line", true)] } });
    const user = await start();
    await user.click(screen.getByRole("button", { name: /3\s*Warning signs/ }));
    expect(screen.getByText("Compares Name")).toBeTruthy();
    expect(screen.getByText("Can't work yet: needs a country, zip or state column")).toBeTruthy();
    await scan(user);
    await user.click(screen.getByRole("button", { name: /3\s*Warning signs/ }));
    expect(screen.getByText(/suggests turning off “Shared number”/)).toBeTruthy();
    expect(screen.getByText("In this list it predicts wrong numbers: 2× as often")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Use what the data shows" }));
    expect((screen.getByRole("checkbox", { name: "Shared number" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("button", { name: "Use what the data shows" })).toBeNull();
  });
  it("puts every checked row in one group and opens the rows of a group", async () => {
    const groups = { group_look: 4, group_blocked: 2, group_ready: 0, group_unknown: 95, group_no_phone: 0 };
    mocks.scan.mockResolvedValue({ report: { ...structuredClone(report), row_counts: { ...report.row_counts, callable: 99, known_wrong: 0, dnc: 2, ...groups } } });
    const user = await start();
    await scan(user);
    expect(screen.getByText((_, element) => element?.className === "results-headline" && /99 of 101 rows have a number you can call; 4 of them need a look first\./.test(element.textContent ?? ""))).toBeTruthy();
    expect(screen.getByText("2 rows contain a do-not-call number. When another number in the same row is fine, it becomes the best phone; a blocked number never does.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /^0\s*Ready/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Review the 4 to look at" }));
    await waitFor(() => expect(mocks.review).toHaveBeenCalledWith("scan-1", "group_look", 0, undefined));
  });
  it("can skip call outcomes explicitly before checking", async () => {
    const user = await start();
    await user.click(within(document.querySelector(".wizard-nav") as HTMLElement).getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Continue without call outcomes" }));
    expect(screen.getByRole("heading", { name: "Warning signs" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Check phone numbers" }));
    await waitFor(() => expect(mocks.scan.mock.calls[0][1].outcome).toBeNull());
  });
});
