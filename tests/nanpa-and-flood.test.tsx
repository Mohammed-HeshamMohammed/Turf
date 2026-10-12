import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NanpaBlocks } from "../src/components/NanpaBlocks";
import { FloodLine } from "../src/components/FloodLine";

const mocks = vi.hoisted(() => ({ status: vi.fn(), load: vi.fn(), flood: vi.fn() }));
vi.mock("../src/lib/service", () => ({
  inDesktop: false, nanpaBlocksStatus: mocks.status, nanpaBlocksImport: mocks.load,
  floodZone: mocks.flood, pickNanpaFile: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue({ area_codes: 0, assigned: 0, oldest_days: null, files: [] });
  mocks.load.mockResolvedValue({ area_codes: 1, assigned: 2, free: 1 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("NANPA import", () => {
  it("loads the selected file, refreshes coverage and invalidates the current check", async () => {
    const changed = vi.fn();
    render(<ul><NanpaBlocks onChanged={changed} /></ul>);
    await screen.findByText(/NANPA number blocks not loaded/);
    fireEvent.click(screen.getByRole("button", { name: "Load NANPA file" }));
    fireEvent.change(screen.getByLabelText("Path to the downloaded NANPA file"), { target: { value: "C:\\reports\\codes.tsv" } });
    mocks.status.mockResolvedValue({ area_codes: 1, assigned: 2, oldest_days: 0, files: ["codes.tsv"] });
    fireEvent.click(screen.getByRole("button", { name: "Load", exact: true }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(mocks.load).toHaveBeenCalledWith("C:\\reports\\codes.tsv");
    expect(screen.getByText(/NANPA number blocks: 2 utilized blocks/)).toBeTruthy();
  });
  it("retains import errors and does not report changed evidence", async () => {
    const changed = vi.fn();
    mocks.load.mockRejectedValue(new Error("No number blocks found"));
    render(<ul><NanpaBlocks onChanged={changed} /></ul>);
    fireEvent.click(screen.getByRole("button", { name: "Load NANPA file" }));
    fireEvent.change(screen.getByLabelText("Path to the downloaded NANPA file"), { target: { value: "bad.txt" } });
    fireEvent.click(screen.getByRole("button", { name: "Load", exact: true }));
    expect(await screen.findByText("No number blocks found")).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();
  });
});

describe("property flood zones", () => {
  it("lets a failed request be retried and shows the returned zone", async () => {
    mocks.flood.mockResolvedValueOnce({ unavailable: "Connection reset" }).mockResolvedValue({ zone: "AE", risk: "high", text: "High risk" });
    render(<FloodLine position={[29.76, -95.37]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Flood zone AE")).toBeTruthy();
    expect(mocks.flood).toHaveBeenLastCalledWith(29.76, -95.37, true);
  });
  it("shows missing FEMA data as unknown", async () => {
    mocks.flood.mockResolvedValue({ zone: "", risk: "unknown", text: "No FEMA flood-zone data returned" });
    render(<FloodLine position={[30, -95]} />);
    expect(await screen.findByText("Flood zone unknown")).toBeTruthy();
    expect(screen.queryByText("No flood zone")).toBeNull();
  });
  it("polls in the background and offers retry if FEMA stays pending", async () => {
    vi.useFakeTimers();
    mocks.flood.mockResolvedValue({ pending: true });
    render(<FloodLine position={[30, -95]} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(77_500); });
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    const count = mocks.flood.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(mocks.flood).toHaveBeenCalledTimes(count);
  });
  it("ignores a response for a property that is no longer open", async () => {
    let oldAnswer!: (answer: unknown) => void;
    mocks.flood.mockReturnValueOnce(new Promise(resolve => { oldAnswer = resolve; }))
      .mockResolvedValue({ zone: "X", risk: "low", text: "Moderate or low flood risk" });
    const view = render(<FloodLine position={[29, -95]} />);
    view.rerender(<FloodLine position={[30, -96]} />);
    await screen.findByText("Flood zone X");
    await act(async () => { oldAnswer({ zone: "AE", risk: "high", text: "High risk" }); });
    expect(screen.queryByText("Flood zone AE")).toBeNull();
  });
});
