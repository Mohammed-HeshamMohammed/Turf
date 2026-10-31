/** The landing API (waitlist and contact), on its own address. Set at build (VITE_CALLERWHALE_LANDING_API_URL); in development it is the same origin and the dev server forwards it. */
const BASE = (import.meta.env?.VITE_CALLERWHALE_LANDING_API_URL || "").replace(/\/$/, "");

async function send(path, options) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, options);
  } catch {
    throw new Error("Could not reach Caller Whale. Check your connection and try again.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Something went wrong. Try again.");
  return body;
}

const post = (path, data) =>
  send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

export const joinWaitlist = data => post("/waitlist", data);
export const sendMessage = data => post("/contact", data);
