import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListDownloads } from "../src/components/ListDownloads";

// Exercise the real browser bridge and blob download through the visible controls.
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("project download controls", () => {
  it("retrieves the chosen original or checked version and downloads all bytes", async () => {
    const requests: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const content = "Name,Phone\r\nAna,7135553142\r\n";
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      const result = request.command === "dataset.download"
        ? { filename: request.payload.version === "original" ? "upload.csv" : "checked.csv", size: content.length, mime: "text/csv", hash: "retained-hash" }
        : { data: btoa(content) };
      return { ok: true, json: async () => ({ schema_version: 1, ok: true, result }) };
    }));
    let blob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation(value => { blob = value as Blob; return "blob:download"; });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () { names.push(this.download); });
    const fail = vi.fn();
    render(<ListDownloads datasetId="source-id" checkedId="checked-id" fail={fail} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Download original" }));
    await screen.findByText("Original file downloaded.");
    expect(names).toEqual(["upload.csv"]);
    expect(await blob!.text()).toBe(content);
    expect(requests[0].payload).toEqual({ dataset_id: "source-id", version: "original" });
    await user.click(screen.getByRole("button", { name: "Download checked CSV" }));
    await screen.findByText("Checked CSV downloaded with all rows and result columns.");
    expect(names).toEqual(["upload.csv", "checked.csv"]);
    expect(requests[2].payload).toEqual({ dataset_id: "checked-id", version: "checked" });
    expect(requests[3].payload).toEqual({ dataset_id: "checked-id", version: "checked", hash: "retained-hash", offset: 0 });
    expect(fail).not.toHaveBeenCalled();
  });

  it("shows service errors without reporting a successful download", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ schema_version: 1, ok: false, error: { code: "invalid_request", message: "The saved file is missing" } }) })));
    const fail = vi.fn();
    render(<ListDownloads datasetId="source-id" fail={fail} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Download original" }));
    await waitFor(() => expect(fail).toHaveBeenCalledWith(expect.objectContaining({ message: "The saved file is missing" })));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Download original" }).hasAttribute("disabled")).toBe(false);
  });
});
