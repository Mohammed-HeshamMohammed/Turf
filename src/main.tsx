import "@fontsource-variable/schibsted-grotesk";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./app.css";

// The page arrives already written into the HTML (so search engines and slow connections see it); the browser's own copy takes over.
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App path={location.pathname} />
  </StrictMode>,
);
