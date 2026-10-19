// The caption bar can leave the app window and float over the whole screen. That needs a second window, which only the
// desktop app can open; in a browser the bar stays inside the page. The two windows share one live feed over a BroadcastChannel.

export const inDesktopApp = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

export const CAPTIONS_CHANNEL = "turf-captions";
export const CAPTIONS_ROUTE = "#/captions-window";

const CAPTIONS_LABEL = "captions";

/** Opens the floating caption window, or brings the one that is already open forward. */
export async function openCaptionsWindow(onClosed) {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(CAPTIONS_LABEL);
  if (existing) {
    await existing.show();
    return existing;
  }
  const window_ = new WebviewWindow(CAPTIONS_LABEL, {
    url: "index.html" + CAPTIONS_ROUTE,
    title: "Live captions",
    width: 800,
    height: 240,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    shadow: false,
    focus: false,
  });
  window_.once("tauri://error", () => onClosed?.());
  window_.once("tauri://destroyed", () => onClosed?.());
  return window_;
}

export async function closeCaptionsWindow() {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(CAPTIONS_LABEL);
  await existing?.destroy();
}

/** Lets the floating window be grabbed anywhere on its title row and dragged across the screen. */
export async function dragThisWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

/** Keeps the floating window exactly as large as the bar inside it. */
export async function sizeThisWindow(width, height) {
  const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setSize(new LogicalSize(Math.ceil(width), Math.ceil(height)));
}
