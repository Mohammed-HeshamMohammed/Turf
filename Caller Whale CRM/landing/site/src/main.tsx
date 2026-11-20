import "@fontsource-variable/schibsted-grotesk";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./app.css";
import { installErrorReports } from "./error-report.ts";

// Errors in people's browsers reach the auth service's log, without their text (step 42).
installErrorReports(`${(import.meta.env.VITE_CALLERWHALE_AUTH_URL || "http://localhost:8101").replace(/\/$/, "")}/v1/client-errors`, "site", String(import.meta.env.VITE_APP_VERSION || "web"));

const root = document.getElementById("root") as HTMLElement;
const page = (
  <StrictMode>
    <App path={location.pathname} />
  </StrictMode>
);
// A prerendered page stays in place while React attaches its event handlers. The development server sends an empty page, which is
// drawn fresh instead (hydrating nothing would report a mismatch on every page).
if (root.hasChildNodes()) hydrateRoot(root, page);
else createRoot(root).render(page);
