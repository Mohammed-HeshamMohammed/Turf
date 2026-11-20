import { renderToString } from "react-dom/server";
import { App } from "./App.tsx";

export { discoveryArtifacts } from "./discovery.ts";
export { metadataFor, renderMetadata } from "./metadata.ts";
export { notFoundRoute, routes } from "./routes.ts";
export { resolveSiteOrigin } from "./site.ts";

/** The HTML of one page, for the build to write into that page's own file (scripts/prerender.mjs). Nobody is signed in on the server. */
export const render = (path: string) => renderToString(<App path={path} />);
