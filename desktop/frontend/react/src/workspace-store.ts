// The local workspace (the sample workspace and every list imported into it) lives in IndexedDB, which holds hundreds
// of megabytes; localStorage holds about five, which is what used to cap imports at 2 MB / 200 rows. A workspace saved
// in localStorage by an earlier version moves across the first time this one opens. Server records never come here:
// signed in, they stay in the encrypted offline copy (remote/vault.js).
import Dexie from "dexie";

const LEGACY_KEY = "callerwhale.full-crm.prototype.v1";
const db = new Dexie("callerwhale-crm-workspace");
db.version(1).stores({ workspace: "" });

/** The saved workspace, or null. Never throws: an unavailable store starts from what the caller already has. */
export async function loadWorkspace() {
  try {
    return (await db.table("workspace").get("current")) ?? null;
  } catch {
    return null;
  }
}

/** Saves the whole workspace. Answers false when the browser refused (private window, disk full). */
export async function saveWorkspace(state) {
  try {
    await db.table("workspace").put(state, "current");
    try {
      window.localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* Nothing to clear. */
    }
    return true;
  } catch {
    return false;
  }
}

export async function clearWorkspace() {
  try {
    await db.table("workspace").delete("current");
  } catch {
    /* Already gone. */
  }
}
