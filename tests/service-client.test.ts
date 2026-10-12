import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), rpc: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
let client: typeof import("../src/lib/service");

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    const { command, payload } = JSON.parse(options.body);
    const result = await mocks.rpc(command, payload);
    return { ok: true, json: async () => ({ schema_version: 1, ok: true, result }) };
  }));
  client = await import("../src/lib/service");
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("the public service entry point", () => {
  it("retains project and enrichment commands on the same browser transport", async () => {
    mocks.rpc.mockImplementation((command: string, payload: unknown) => ({ command, payload }));
    expect(await client.openProject("C:\\project")).toEqual({ command: "project.open", payload: { path: "C:\\project" } });
    expect(await client.floodZone(29, -95, true)).toEqual({ command: "flood.of", payload: { lat: 29, lon: -95, again: true } });
    expect(await client.nanpaBlocksStatus()).toEqual({ command: "nanpa_blocks.status", payload: {} });
    expect(await client.checkEmails(["owner@example.com"])).toEqual({ command: "emails.check", payload: { addresses: ["owner@example.com"] } });
  });

  it("continues reading rows after a short page and stops only on an empty page", async () => {
    const first = { id: "one", row_number: 2, raw: { Name: "Ada" } };
    const second = { id: "two", row_number: 3, raw: { Name: "Bob" } };
    mocks.rpc.mockResolvedValueOnce([first]).mockResolvedValueOnce([second]).mockResolvedValueOnce([]);
    expect(await client.allRows("list")).toEqual([first, second]);
    expect(mocks.rpc.mock.calls).toEqual([
      ["dataset.rows", { dataset_id: "list", offset: 0, limit: 5000 }],
      ["dataset.rows", { dataset_id: "list", offset: 1, limit: 5000 }],
      ["dataset.rows", { dataset_id: "list", offset: 2, limit: 5000 }],
    ]);
  });

  it("shares setup reads, retries a failed read and invalidates only the saved setup", async () => {
    mocks.rpc.mockRejectedValueOnce(new Error("Offline"));
    await expect(client.skiptraceSuggest("one")).rejects.toMatchObject({ code: "bridge_unavailable" });
    mocks.rpc.mockImplementation((command: string, payload: { dataset_id: string }) => ({ dataset_id: payload.dataset_id, command }));
    const one = client.skiptraceSuggest("one");
    expect(client.skiptraceSuggest("one")).toBe(one);
    await one;
    const two = client.skiptraceSuggest("two");
    await two;
    expect(client.knownSuggestion("one")?.dataset_id).toBe("one");
    const config = { phone_columns: ["Phone"] } as Parameters<typeof client.skiptraceSave>[1];
    await client.skiptraceSave("one", config);
    expect(client.knownSuggestion("one")).toBeNull();
    expect(client.skiptraceSuggest("two")).toBe(two);
    expect(await client.skiptraceSuggest("one")).toEqual({ dataset_id: "one", command: "skiptrace.suggest" });
    await client.skiptraceRemember("one", { called: ["reached"] });
    expect(client.knownSuggestion("two")).toBeNull();
  });

  it("imports a registry through the shared job runner and retains progress", async () => {
    mocks.rpc.mockResolvedValueOnce({ job_id: "import" }).mockResolvedValueOnce({
      state: "completed", result: { numbers: 2, area_codes: ["713"] }, events: [{ id: 1, payload: { stage: "reading_registry", lines: 2 } }],
    });
    const progress = vi.fn();
    expect(await client.dncRegistryImport("codes.txt", progress)).toEqual({ numbers: 2, area_codes: ["713"] });
    expect(progress).toHaveBeenCalledWith(2);
    expect(mocks.rpc.mock.calls).toEqual([
      ["dnc_registry.import", { path: "codes.txt" }], ["job.get", { job_id: "import", after_event_id: 0 }],
    ]);
  });

  it("resumes a job without submitting another one and advances its event cursor", async () => {
    vi.useFakeTimers();
    mocks.rpc.mockResolvedValueOnce({ state: "running", events: [{ id: 7, payload: { stage: "reading" } }] })
      .mockResolvedValueOnce({ state: "completed", result: { rows: 2 } });
    const onStart = vi.fn(), onEvent = vi.fn();
    const job = client.watchJob("existing", { onStart, onEvent });
    await vi.advanceTimersByTimeAsync(500);
    expect(await job).toEqual({ rows: 2 });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({ stage: "reading" });
    expect(mocks.rpc).toHaveBeenLastCalledWith("job.get", { job_id: "existing", after_event_id: 7 });
  });

  it("preserves browser state when area mappings are saved", async () => {
    const marks = { "+17135553142": { mark: "called", at: "2026-10-12" } };
    localStorage.setItem("turf.state", JSON.stringify({ marks, areas: { first: { zip: "ZIP" } } }));
    await client.setAreaColumns("second", { state: "State" });
    expect(await client.turfState()).toEqual({ marks, areas: { first: { zip: "ZIP" }, second: { state: "State" } } });
  });

  it("preserves actionable service errors and failed-job errors", async () => {
    mocks.rpc.mockResolvedValue({ state: "failed", error: "File not found" });
    await expect(client.watchJob("failed")).rejects.toMatchObject({ code: "job_failed", message: "File not found" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ schema_version: 1, ok: false, error: { code: "unknown_command", message: "old service" } }) })));
    await expect(client.nanpaBlocksStatus()).rejects.toMatchObject({ code: "unknown_command", message: "Turf's service is older than its screens. Close Turf and open it again." });
  });

  it("uses the native host for domain calls and local state with the original payloads", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    vi.resetModules();
    const desktop = await import("../src/lib/service");
    mocks.invoke.mockResolvedValueOnce({ schema_version: 1, ok: true, result: { area_codes: 1 } });
    expect(await desktop.nanpaBlocksStatus()).toEqual({ area_codes: 1 });
    expect(mocks.invoke).toHaveBeenLastCalledWith("service_call", { command: "nanpa_blocks.status", payload: {} });
    mocks.invoke.mockResolvedValueOnce({ list: { zip: "ZIP" } });
    await desktop.setAreaColumns("list", { zip: "ZIP" });
    expect(mocks.invoke).toHaveBeenLastCalledWith("turf_set_area_columns", { datasetId: "list", mapping: { zip: "ZIP" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
