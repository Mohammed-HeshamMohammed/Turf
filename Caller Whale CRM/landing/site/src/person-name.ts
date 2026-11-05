// A person's name in parts. People who signed up before names had parts have only one display name: its first word is taken
// as the first name, its last word as the last name, and anything between as the middle name, as a starting point to correct.

export type NameParts = { first: string; middle: string; last: string };

export function splitName(display: string): NameParts {
  const words = display.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { first: "", middle: "", last: "" };
  if (words.length === 1) return { first: words[0]!, middle: "", last: "" };
  return { first: words[0]!, middle: words.slice(1, -1).join(" "), last: words[words.length - 1]! };
}

/** The parts the person saved, or, when none were ever saved, the display name split into parts. */
export function namePartsOf(me: { name?: string; first_name?: unknown; middle_name?: unknown; last_name?: unknown }): NameParts {
  const saved = { first: String(me.first_name || ""), middle: String(me.middle_name || ""), last: String(me.last_name || "") };
  return saved.first || saved.middle || saved.last ? saved : splitName(me.name || "");
}
