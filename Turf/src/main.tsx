import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/schibsted-grotesk";
import "./styles.css";
import { App } from "./App";

// Scrollbars stay hidden until their area is scrolled or pointed at (see styles.css).
const timers = new WeakMap<Element, number>();
document.addEventListener(
  "scroll",
  event => {
    const target = event.target instanceof Element ? event.target : document.documentElement;
    target.classList.add("is-scrolling");
    clearTimeout(timers.get(target));
    timers.set(
      target,
      window.setTimeout(() => target.classList.remove("is-scrolling"), 900),
    );
  },
  { capture: true, passive: true },
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
