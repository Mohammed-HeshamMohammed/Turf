import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Turf } from "../src/App";
import { ActivityCard, CallbackReminders, CallStatsCard, GlobalSearch } from "../src/components/CrmCards";
import { FollowUpRules } from "../src/components/FollowUpRules";
import { ManyAtOnce } from "../src/components/ListExtras";
import { localDay } from "../src/lib/service";

const today = localDay();

const service = vi.hoisted(() => ({
  recentActivity: vi.fn(async () => [
    { at: new Date().toISOString(), kind: "stage", from: "new", to: "interested", list: "Traced", label: "John Smith", dataset_id: "d1", row_number: 2 },
    {
      at: new Date().toISOString(),
      kind: "call",
      outcome: "no_answer",
      number: "+17135553142",
      list: "Traced",
      label: "John Smith",
      dataset_id: "d1",
      row_number: 2,
    },
  ]),
  callStats: vi.fn(async () => ({
    days: [{ day: "2026-10-13", calls: 1, outcomes: {} }],
    today: 3,
    week: 4,
    calls: 4,
    outcomes: { reached: 1, no_answer: 3 },
    reached_share: 0.25,
  })),
  dueCallbacks: vi.fn(),
  searchEverywhere: vi.fn(async () => [{ dataset_id: "d1", list: "Traced", row_number: 5, label: "Tom Brown · 5 Riverside Dr" }]),
  followUpRules: vi.fn(async () => ({ after_no_answer_days: 2, after_voicemail_days: 3, close_after_misses: 0 })),
  setFollowUpRules: vi.fn(async (rules: object) => ({ after_no_answer_days: 2, after_voicemail_days: 3, close_after_misses: 0, ...rules })),
  setManyLeads: vi.fn(async () => ({ leads: 2 })),
}));
vi.mock("../src/lib/service", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/service")>()), ...service }));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const turf = { projectId: "p", version: 0, manual: {}, callTarget: null, openCall: vi.fn(), fail: vi.fn() } as unknown as Turf;

describe("the CRM cards", () => {
  it("show the recent activity and how the calls went", async () => {
    render(
      <>
        <ActivityCard turf={turf} />
        <CallStatsCard turf={turf} />
      </>,
    );
    expect(await screen.findByText("Recent activity")).toBeTruthy();
    expect(screen.getByText("Stage: New → Interested")).toBeTruthy();
    await userEvent.click(screen.getAllByRole("button", { name: "Open" })[0]);
    expect(turf.openCall).toHaveBeenCalledWith("d1", 2);
    expect(await screen.findByText("Calls made")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
    expect(document.querySelector(".outcome-chips")?.textContent).toBe("Reached 1No answer 3");
  });

  it("bring up a callback whose time has come, once", async () => {
    const callback = {
      lead_key: "a",
      label: "Wei Nguyen",
      on: `${today}T00:00`,
      time: "00:00",
      note: "Wants a call",
      stage: "new",
      dataset_id: "d1",
      list: "Traced",
      row_number: 4,
      due: true,
    };
    const later = { ...callback, lead_key: "b", label: "Later Lee", on: `${today}T23:59`, time: "23:59" };
    service.dueCallbacks.mockResolvedValue({ today, due: [callback, later], coming: [], stages: {} });
    const { unmount } = render(<CallbackReminders turf={turf} />);
    expect(await screen.findByText("Call back Wei Nguyen")).toBeTruthy();
    expect(screen.queryByText("Call back Later Lee")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Call now" }));
    expect(turf.openCall).toHaveBeenCalledWith("d1", 4);
    unmount();
    render(<CallbackReminders turf={turf} />);
    await waitFor(() => expect(service.dueCallbacks).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Call back Wei Nguyen")).toBeNull();
  });

  it("find a row in every list from the title bar", async () => {
    const onOpen = vi.fn();
    render(<GlobalSearch onOpen={onOpen} />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Find in every list" }), "riverside");
    await userEvent.click(await screen.findByRole("button", { name: /Tom Brown/ }));
    expect(service.searchEverywhere).toHaveBeenLastCalledWith("riverside");
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ dataset_id: "d1", row_number: 5 }));
  });

  it("change the follow-up rules", async () => {
    render(<FollowUpRules fail={vi.fn()} />);
    expect(await screen.findByText(/call back 2 days after no answer, 3 after a voicemail/)).toBeTruthy();
    const misses = screen.getByLabelText(/Close a lead as dead/);
    await userEvent.clear(misses);
    await userEvent.type(misses, "4");
    await waitFor(() => expect(service.setFollowUpRules).toHaveBeenLastCalledWith({ close_after_misses: 4 }));
    expect(await screen.findByText(/close a lead after 4 misses in a row/)).toBeTruthy();
  });

  it("change many chosen rows at once", async () => {
    const setMark = vi.fn();
    const onAll = vi.fn();
    render(
      <ManyAtOnce
        datasetId="d1"
        chosen={new Set([2, 3])}
        matching={6}
        onAll={onAll}
        onClear={vi.fn()}
        numbers={() => ["+17135553142", "+17135553142", "+17135558877"]}
        setMark={setMark}
        fail={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Choose all 6 that match" }));
    expect(onAll).toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByLabelText("Set the stage of the chosen leads"), "interested");
    expect(service.setManyLeads).toHaveBeenCalledWith("d1", [2, 3], { stage: "interested" });
    expect(await screen.findByText("2 leads changed.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Do not call" }));
    expect(setMark.mock.calls).toEqual([
      ["+17135553142", "do_not_call"],
      ["+17135558877", "do_not_call"],
    ]);
  });
});
