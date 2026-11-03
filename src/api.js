/** The two public forms (waitlist and contact) are on Caller Whale's server, the same one people sign in to. Set at build (VITE_CALLERWHALE_API_URL); in development the core API on its own port. */
const BASE = (import.meta.env?.VITE_CALLERWHALE_API_URL || "http://localhost:8088").replace(/\/$/, "");

async function send(path, options) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, options);
  } catch {
    throw new Error("Could not reach Caller Whale. Check your connection and try again.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || (typeof body.error === "string" && body.error) || "Something went wrong. Try again.");
  return body;
}

const post = (path, data) =>
  send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

export const joinWaitlist = data => post("/api/v1/public/waitlist", data);
export const sendMessage = data => post("/api/v1/public/contact", data);
