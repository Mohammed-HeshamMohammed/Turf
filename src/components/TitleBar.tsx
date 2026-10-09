import { useEffect, useState, type ReactNode } from "react";

/** True inside the desktop window. In a browser tab there is no window to control, so the buttons are left out. */
const inDesktop = "__TAURI_INTERNALS__" in window;

async function currentWindow() {
  return (await import("@tauri-apps/api/window")).getCurrentWindow();
}

/**
 * The window's own title bar, on the page's own colour: the app's mark (`mark`, a menu button) and name in the corner,
 * the tabs in the middle (`children`),
 * and `end` beside the window buttons. Everything that is not a control drags the window.
 */
export function TitleBar({ title, mark, children, end }: { title: string; mark: ReactNode; children?: ReactNode; end?: ReactNode }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!inDesktop) return;
    let stop: (() => void) | undefined;
    let gone = false;
    void currentWindow().then(async appWindow => {
      setMaximized(await appWindow.isMaximized());
      const unlisten = await appWindow.onResized(async () => setMaximized(await appWindow.isMaximized()));
      if (gone) unlisten(); else stop = unlisten;
    });
    return () => { gone = true; stop?.(); };
  }, []);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-drag" data-tauri-drag-region>
        {mark}
        <span className="brand-name">{title}</span>
      </div>
      {children}
      <div className="titlebar-end" data-tauri-drag-region>
        {end}
        {inDesktop && (
          <div className="titlebar-controls">
            <button className="win-btn" type="button" title="Minimize" aria-label="Minimize" onClick={() => void currentWindow().then(appWindow => appWindow.minimize())}>
              <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="5.5" width="10" height="1" fill="currentColor" /></svg>
            </button>
            <button className="win-btn" type="button" title={maximized ? "Restore" : "Maximize"} aria-label={maximized ? "Restore" : "Maximize"} onClick={() => void currentWindow().then(appWindow => appWindow.toggleMaximize())}>
              <svg viewBox="0 0 12 12" aria-hidden="true">
                {maximized
                  ? <path d="M3.5 3.5V1.5h7v7h-2M1.5 3.5h7v7h-7z" fill="none" stroke="currentColor" strokeWidth="1" />
                  : <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />}
              </svg>
            </button>
            <button className="win-btn win-close" type="button" title="Close" aria-label="Close" onClick={() => void currentWindow().then(appWindow => appWindow.close())}>
              <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
