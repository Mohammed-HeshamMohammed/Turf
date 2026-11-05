import { useEffect, useRef, useState } from "react";
import { DotsSixVertical } from "@phosphor-icons/react";
import { CaptionsPanel } from "./LiveCaptions.jsx";
import { CAPTIONS_CHANNEL, dragThisWindow, inDesktopApp, sizeThisWindow } from "./popout.js";

/**
 * What the floating caption window shows. It owns no call: the main window runs the captions and streams each frame here,
 * and anything pressed in this window is sent back as an action.
 */
export function CaptionsWindow() {
  const [frame, setFrame] = useState(null);
  const channel = useRef(null);
  const root = useRef(null);

  useEffect(() => {
    document.documentElement.classList.add("captions-window");
    const link = new BroadcastChannel(CAPTIONS_CHANNEL);
    channel.current = link;
    link.onmessage = event => event.data?.type === "frame" && setFrame(event.data);
    link.postMessage({ type: "hello" });
    const goodbye = () => link.postMessage({ type: "closed" });
    window.addEventListener("beforeunload", goodbye);
    return () => {
      window.removeEventListener("beforeunload", goodbye);
      link.close();
    };
  }, []);

  // The window is exactly as big as the bar, so it never leaves an empty frame floating over other apps.
  useEffect(() => {
    if (!inDesktopApp() || !root.current) return undefined;
    const watch = new ResizeObserver(() => {
      const box = root.current.getBoundingClientRect();
      sizeThisWindow(box.width, box.height).catch(() => {});
    });
    watch.observe(root.current);
    return () => watch.disconnect();
  }, []);

  const send = (name, value) => channel.current?.postMessage({ type: "action", name, value });
  const startDrag = event => {
    if (event.button === 0 && !event.target.closest("button") && inDesktopApp()) dragThisWindow().catch(() => {});
  };

  return (
    <div className="captions-window-root" ref={root}>
      <CaptionsPanel
        shown={frame?.shown || []}
        active={Boolean(frame?.active)}
        large={Boolean(frame?.large)}
        source={frame?.source || "demo"}
        micState={frame?.micState || "idle"}
        onSource={value => send("source", value)}
        onLarge={() => send("large")}
        onClose={() => send("close")}
        onDock={() => send("dock")}
        grip={
          <span className="captions-grip" aria-hidden="true" title="Drag anywhere on this row to move">
            <DotsSixVertical size={18} weight="bold" />
          </span>
        }
        barProps={{ onMouseDown: startDrag }}
      />
    </div>
  );
}
