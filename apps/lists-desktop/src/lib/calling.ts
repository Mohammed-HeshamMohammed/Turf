// When a number may be called: the hour it is where the number is.
//
// United States federal rules (the Telephone Consumer Protection Act) allow calls from 8 in the morning to 9 at
// night, by the clock of the person called. Some states are stricter, and a number that was moved keeps its old
// area code, so this is a warning to look at, not a permission: Caller Whale says what time it is there and whether that
// is inside the window.

export const EARLIEST_HOUR = 8;
export const LATEST_HOUR = 21;

export type Window = {
  /** "ok" inside the window in every zone the number could be in; "closed" outside it in at least one; "unknown". */
  state: "ok" | "closed" | "unknown";
  /** The time there, as people write it: "7:12 am". */
  time: string;
  text: string;
};

function hourIn(zone: string, now: Date): { hour: number; text: string } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: false }).formatToParts(now);
    const hour = Number(parts.find(part => part.type === "hour")?.value) % 24;
    const text = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(now).toLowerCase();
    return Number.isFinite(hour) ? { hour, text } : null;
  } catch {
    return null;
  }
}

/** Whether now is a time to call a number in these zones. A number in several zones must be inside the window in
 * all of them. */
export function callingWindow(zones: string[] | undefined, now = new Date()): Window {
  const hours = (zones ?? []).map(zone => hourIn(zone, now)).filter((value): value is { hour: number; text: string } => value !== null);
  if (!hours.length) return { state: "unknown", time: "", text: "The time there is not known" };
  const early = hours.find(item => item.hour < EARLIEST_HOUR);
  const late = hours.find(item => item.hour >= LATEST_HOUR);
  const time = (early ?? late ?? hours[0]).text;
  if (early) return { state: "closed", time, text: `${time} there: too early to call (8 am to 9 pm)` };
  if (late) return { state: "closed", time, text: `${time} there: too late to call (8 am to 9 pm)` };
  return { state: "ok", time, text: `${time} there` };
}
