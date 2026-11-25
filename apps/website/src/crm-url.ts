// Where the CRM web app lives (VITE_CALLERWHALE_APP_URL when building; the production address otherwise).
export const crmUrl = (import.meta.env.VITE_CALLERWHALE_APP_URL || "https://app.callerwhale.com").replace(/\/$/, "");

/** Opens the CRM as the person signed in here: a one-time code (good for two minutes) is traded there for its own session, which
 *  replaces whoever the CRM had open before. Every "Open the CRM" goes through this. */
export async function openCrm(auth: { handoff: (kind: "browser") => Promise<string> }) {
  try { window.location.assign(`${crmUrl}/?callerwhale_code=${encodeURIComponent(await auth.handoff("browser"))}`); }
  catch { window.location.assign(crmUrl); }
}

/** The address people add to an AI assistant to connect Caller Whale (VITE_CALLERWHALE_MCP_URL when building). */
export const mcpUrl = (import.meta.env.VITE_CALLERWHALE_MCP_URL || "https://mcp.callerwhale.com").replace(/\/$/, "") + "/mcp";
