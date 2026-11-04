import "@fontsource-variable/schibsted-grotesk";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./app.css";

// Keep the prerendered page in place while React attaches its event handlers.
hydrateRoot(document.getElementById("root") as HTMLElement,
  <StrictMode>
    <App path={location.pathname} />
  </StrictMode>,
);
