import { useEffect, useState } from "react";
import { closeMainWindow, dragThisWindow, inDesktopApp, minimizeWindow, toggleMaximizeWindow, watchMaximized } from "./popout.js";

/** Elements that must keep working as controls and so never start a window drag. */
export const NO_DRAG = "button, input, a, select, textarea, label, [role=button], [role=combobox], [role=switch], .global-search";

/** Starts dragging the window from any empty part of the title area; a double click maximises or restores it. */
export const windowDrag = {
  onMouseDown: event => {
    if (inDesktopApp() && event.button === 0 && !event.target.closest(NO_DRAG)) dragThisWindow().catch(() => {});
  },
  onDoubleClick: event => {
    if (inDesktopApp() && !event.target.closest(NO_DRAG)) toggleMaximizeWindow().catch(() => {});
  },
};

/**
 * The desktop window's own title bar: the app's name, free space that drags the window, and minimise, maximise and close.
 * In a browser tab there is no window to control, so nothing is drawn.
 */
export function WindowStrip({ title }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let stop;
    let gone = false;
    watchMaximized(setMaximized).then(unlisten => (gone ? unlisten() : (stop = unlisten)));
    return () => {
      gone = true;
      stop?.();
    };
  }, []);
  if (!inDesktopApp()) return null;
  return (
    <div className="window-strip" {...windowDrag}>
      <span className="window-strip-title">{title}</span>
      <div className="window-controls">
        <button type="button" className="win-btn" title="Minimize" aria-label="Minimize" onClick={() => minimizeWindow()}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="win-btn"
          title={maximized ? "Restore" : "Maximize"}
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={() => toggleMaximizeWindow()}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            {maximized ? (
              <path d="M3.5 3.5V1.5h7v7h-2M1.5 3.5h7v7h-7z" fill="none" stroke="currentColor" strokeWidth="1" />
            ) : (
              <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
            )}
          </svg>
        </button>
        <button type="button" className="win-btn win-close" title="Close" aria-label="Close" onClick={() => closeMainWindow()}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
