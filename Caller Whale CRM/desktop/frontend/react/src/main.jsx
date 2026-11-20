import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "@fontsource-variable/schibsted-grotesk";
import "./styles.css";
import "./crm.css";
import { installErrorReports } from "@callerwhale/error-report";
import { AUTH_SERVER } from "./remote/api.ts";

// Errors in the app reach the auth service's log, without their text (step 42).
installErrorReports(`${AUTH_SERVER}/v1/client-errors`, "crm", String(import.meta.env?.VITE_APP_VERSION || "web"));

const root = createRoot(document.getElementById("root"));
if (window.location.hash.startsWith("#/captions-window")) {
  // The floating caption window: just the caption bar, streamed from the main window.
  import("./CaptionsWindow.jsx").then(({ CaptionsWindow }) => root.render(<CaptionsWindow />));
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
