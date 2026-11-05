/** One update operation at a time, shared by the sign-in and workspace title bars. */
export function createUpdater({ check, restart, prepareInstall = async () => {} }) {
  let state = { status: "idle", version: "", progress: null, error: "" };
  let pending = null;
  let downloaded = false;
  let busy = false;
  const listeners = new Set();
  const publish = patch => {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener());
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async check(manual = false) {
      if (busy) return;
      busy = true;
      const before = state;
      if (manual || !pending) publish({ status: "checking", error: "" });
      try {
        const update = await check({ timeout: 20000 });
        if (pending && pending !== update) await pending.close().catch(() => {});
        pending = update;
        downloaded = false;
        publish({
          status: update ? "available" : "current",
          version: update?.version || "",
          progress: null,
          error: "",
        });
      } catch {
        // Background network failures never cover an already available update or interrupt work.
        if (manual)
          publish({
            status: "error",
            error: "Could not check for updates. Check your connection and try again.",
          });
        else publish(before);
      } finally {
        busy = false;
      }
    },
    async install(beforeInstall = async () => {}) {
      if (busy || !pending) return;
      busy = true;
      try {
        await beforeInstall();
        if (!downloaded) {
          publish({ status: "downloading", progress: null, error: "" });
          let received = 0;
          let total = 0;
          await pending.download(event => {
            if (event.event === "Started") total = event.data.contentLength || 0;
            if (event.event === "Progress") received += event.data.chunkLength;
            publish({
              progress: total ? Math.min(100, Math.round((received / total) * 100)) : null,
            });
          });
          downloaded = true;
        }
        // Calls or edits may have started during the download. Check and flush again before Windows exits.
        await beforeInstall();
        publish({ status: "installing", error: "" });
        await prepareInstall();
        await pending.install();
        await restart();
      } catch (error) {
        publish({
          status: "error",
          error: error?.message || "The update could not be installed. Try again.",
        });
      } finally {
        busy = false;
      }
    },
  };
}

export const desktopUpdater = createUpdater({
  check: async options => (await import("@tauri-apps/plugin-updater")).check(options),
  restart: async () => (await import("@tauri-apps/plugin-process")).relaunch(),
  prepareInstall: async () => (await import("@tauri-apps/api/core")).invoke("prepare_update"),
});
