import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "@fontsource-variable/inter-tight";
import "./styles.css";
import "./crm.css";

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
