// The last-known name, email and picture of the signed-in person, kept on this device so the header can show them at once after a
// refresh while the real answer is being fetched (show what we know, then update it). It holds nothing secret: no token, no roles.
// It is removed when the person signs out or the session ends, and the next answer from the server replaces it.

export type CachedProfile = { id: string; name: string; email: string; avatar: string };

const KEY = "cw-profile";

export function readProfile(): CachedProfile | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CachedProfile>;
    if (typeof value.id !== "string" || typeof value.email !== "string") return null;
    // A picture is only ever an inline PNG or JPEG the server accepted; anything else in storage is ignored.
    const avatar = typeof value.avatar === "string" && /^data:image\/(png|jpeg);base64,/.test(value.avatar) ? value.avatar : "";
    return { id: value.id, name: typeof value.name === "string" ? value.name : "", email: value.email, avatar };
  } catch {
    return null;
  }
}

/** Remembers the person (or forgets them when `me` is null). Storage can be refused (a private window): then nothing is remembered. */
export function writeProfile(me: { id: string; name?: string; email: string; avatar?: unknown } | null): void {
  try {
    if (!me) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ id: me.id, name: me.name || "", email: me.email, avatar: typeof me.avatar === "string" ? me.avatar : "" }));
  } catch { /* the choice just is not remembered */ }
}
