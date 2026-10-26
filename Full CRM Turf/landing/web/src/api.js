async function send(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new Error("Could not reach Turf. Check your connection and try again.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Something went wrong. Try again.");
  return body;
}

const post = (path, data) =>
  send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

export const joinWaitlist = data => post("/api/waitlist", data);
export const sendMessage = data => post("/api/contact", data);
export const getDownload = () => send("/api/download");
