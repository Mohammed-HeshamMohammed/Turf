import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NanpaBlocks } from "../src/components/NanpaBlocks";
import { DncRegistry } from "../src/components/DncRegistry";
import { FloodLine } from "../src/components/FloodLine";

const mocks = vi.hoisted(() => ({ status: vi.fn(), load: vi.fn(), flood: vi.fn(), dncStatus: vi.fn(), dncLoad: vi.fn(), pick: vi.fn(), desktop: false }));
vi.mock("../src/lib/service", () => ({
  get inDesktop() {
    return mocks.desktop;
  },
  nanpaBlocksStatus: mocks.status,
  nanpaBlocksImport: mocks.load,
  floodZone: mocks.flood,
  pickNanpaFile: mocks.pick,
  dncRegistryStatus: mocks.dncStatus,
  dncRegistryImport: mocks.dncLoad,
  pickRegistryFile: mocks.pick,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop = false;
  mocks.dncStatus.mockResolvedValue({ area_codes: [], numbers: 0, max_age_days: 31 });
  mocks.status.mockResolvedValue({ area_codes: 0, assigned: 0, oldest_days: null, files: [] });
  mocks.load.mockResolvedValue({ area_codes: 1, assigned: 2, free: 1 });
});

describe("shared registry controls", () => {
  it("retains DNC progress and refreshes coverage only after a completed import", async () => {
    const changed = vi.fn();
    let finish!: (result: unknown) => void;
    mocks.dncLoad.mockImplementation((_path: string, progress: (lines: number) => void) => {
      progress(25_000);
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    render(
      <ul>
        <DncRegistry onChanged={changed} />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Load a file" }));
    fireEvent.change(screen.getByLabelText("Path to the downloaded registry file"), { target: { value: "registry.zip" } });
    fireEvent.click(screen.getByRole("button", { name: "Load", exact: true }));
    expect(await screen.findByText("Reading… 25,000 lines")).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Load", exact: true }).hasAttribute("disabled")).toBe(true);
    mocks.dncStatus.mockResolvedValue({ area_codes: [{ area_code: "713", age_days: 0, out_of_date: false }], numbers: 2, max_age_days: 31 });
    await act(async () => {
      finish({ area_codes: ["713"], numbers: 2 });
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(screen.getByText(/National Do Not Call Registry: 2 numbers for 713/)).toBeTruthy();
  });

  it("does not import or invalidate evidence when the desktop picker is cancelled", async () => {
    mocks.desktop = true;
    mocks.pick.mockResolvedValue(null);
    const changed = vi.fn();
    render(
      <ul>
        <NanpaBlocks onChanged={changed} />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Load NANPA file" }));
    await waitFor(() => expect(mocks.pick).toHaveBeenCalledOnce());
    expect(mocks.load).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Path to the downloaded NANPA file")).toBeNull();
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("NANPA import", () => {
  it("loads the selected file, refreshes coverage and invalidates the current check", async () => {
    const changed = vi.fn();
    render(
      <ul>
        <NanpaBlocks onChanged={changed} />
      </ul>,
    );
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
    render(
      <ul>
        <NanpaBlocks onChanged={changed} />
      </ul>,
    );
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(77_500);
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    const count = mocks.flood.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.flood).toHaveBeenCalledTimes(count);
  });
  it("ignores a response for a property that is no longer open", async () => {
    let oldAnswer!: (answer: unknown) => void;
    mocks.flood
      .mockReturnValueOnce(
        new Promise(resolve => {
          oldAnswer = resolve;
        }),
      )
      .mockResolvedValue({ zone: "X", risk: "low", text: "Moderate or low flood risk" });
    const view = render(<FloodLine position={[29, -95]} />);
    view.rerender(<FloodLine position={[30, -96]} />);
    await screen.findByText("Flood zone X");
    await act(async () => {
      oldAnswer({ zone: "AE", risk: "high", text: "High risk" });
    });
    expect(screen.queryByText("Flood zone AE")).toBeNull();
  });
});
