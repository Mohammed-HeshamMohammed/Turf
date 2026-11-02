import "@fontsource-variable/schibsted-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource/instrument-serif/400-italic.css";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./landing.css";
import "./pages.css";
import "./builder.css";
import "./account.css";

// Apply a saved pause before enabling CSS entrances; do not flash motion on reload.
let motionPaused = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
try { motionPaused ||= localStorage.getItem("callerwhale-site-motion") === "off"; } catch { /* Storage is optional. */ }
document.documentElement.dataset.motion = motionPaused ? "off" : "on";
// Scroll reveals enhance readable prerendered content only once scripts run.
document.documentElement.classList.add("js");

const root = document.getElementById("root");
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);
// A built page arrives prerendered and is hydrated; the dev server sends an empty root.
if (root.hasChildNodes()) hydrateRoot(root, app);
else createRoot(root).render(app);

import "./studio.css";

import "./home.css";
import "./deep.css";
