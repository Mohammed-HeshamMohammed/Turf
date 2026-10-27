import "@fontsource-variable/schibsted-grotesk";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./landing.css";
import "./pages.css";
import "./builder.css";

// Scroll reveals hide their content only once scripts run, so the prerendered page is readable without them.
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
