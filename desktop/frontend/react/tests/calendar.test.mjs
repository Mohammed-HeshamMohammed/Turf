// The calendar is shared with the website and the desktop app (shared/calendar): every copy must match the original.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

test("this copy of the calendar matches the original in shared/calendar", () => {
  const sync = join(import.meta.dirname, "..", "..", "..", "..", "shared", "calendar", "sync.mjs");
  execFileSync(process.execPath, [sync, "--check"], { stdio: "pipe" });
});
