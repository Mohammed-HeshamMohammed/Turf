// Where the CRM web app lives (VITE_CALLERWHALE_APP_URL when building; the production address otherwise).
export const crmUrl = (import.meta.env.VITE_CALLERWHALE_APP_URL || "https://app.callerwhale.com").replace(/\/$/, "");
