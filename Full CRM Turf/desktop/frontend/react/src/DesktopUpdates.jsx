import { useEffect, useSyncExternalStore } from "react";
import { desktopUpdater } from "./updates.js";

const HALF_HOUR = 30 * 60 * 1000;
let lastCheck = 0;

/** Desktop only: available at sign-in too, so a broken sign-in never prevents an update. */
export function DesktopUpdates({ beforeInstall }) {
  const state = useSyncExternalStore(desktopUpdater.subscribe, desktopUpdater.getSnapshot);
  useEffect(() => {
    const check = () => {
      if (Date.now() - lastCheck < 5 * 60 * 1000) return;
      lastCheck = Date.now();
      void desktopUpdater.check();
    };
    check();
    const timer = setInterval(check, HALF_HOUR);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
    };
  }, []);
  const busy = ["checking", "downloading", "installing"].includes(state.status);
  const message = state.error || (state.version ? `Version ${state.version} is available` : state.status === "current" ? "You're up to date" : "");
  const label =
    state.status === "checking"
      ? "Checking…"
      : state.status === "downloading"
        ? `Downloading${state.progress === null ? "…" : ` ${state.progress}%`}`
        : state.status === "installing"
          ? "Restarting…"
          : state.version
            ? "Install and restart"
            : "Check for updates";
  return (
    <div className="desktop-updates">
      <span className="desktop-update-message" role="status" title={message}>
        {message}
      </span>
      <button type="button" disabled={busy} onClick={() => (state.version ? desktopUpdater.install(beforeInstall) : desktopUpdater.check(true))}>
        {label}
      </button>
    </div>
  );
}
