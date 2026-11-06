// Where the CRM web app lives (VITE_CALLERWHALE_APP_URL when building; the production address otherwise).
export const crmUrl = (import.meta.env.VITE_CALLERWHALE_APP_URL || "https://app.callerwhale.com").replace(/\/$/, "");

/** The address people add to an AI assistant to connect Caller Whale (VITE_CALLERWHALE_MCP_URL when building). */
export const mcpUrl = (import.meta.env.VITE_CALLERWHALE_MCP_URL || "https://mcp.callerwhale.com").replace(/\/$/, "") + "/mcp";
