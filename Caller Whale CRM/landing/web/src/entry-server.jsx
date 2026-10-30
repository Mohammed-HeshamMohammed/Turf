import { renderToString } from "react-dom/server";
import { App } from "./App.jsx";

export { pageMeta } from "./content.js";

/** The HTML of one page, for the build to write into its own folder (scripts/prerender.mjs). */
export const render = path => renderToString(<App path={path} />);
