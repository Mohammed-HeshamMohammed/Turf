// The call assistant's listening rules: what someone says on the call, and what is worth prompting in response.
// Plain pattern matching on the live transcript, so it runs on the device and nothing said leaves it.

const RULES = [
  {
    id: "stop",
    pattern: /\b(not interested|stop calling|remove me|take me off|do not call|don't call|leave me alone)\b/i,
    kind: "watch",
    text: "They want the calls to stop. Thank them, confirm you won't call again and record Do not call.",
  },
  {
    id: "busy",
    pattern: /\b(i'?m busy|call me back|call back|not a good time|bad time|in a meeting|later today|tomorrow)\b/i,
    kind: "next",
    text: "It's not a good moment. Offer two times for a callback and schedule one before you hang up.",
  },
  {
    id: "price",
    pattern: /\b(price|offer|how much|asking|worth|valu(e|ation)|number)\b/i,
    kind: "ask",
    text: "Don't name a number first. Ask what price would make the move work for them.",
  },
  {
    id: "timeline",
    pattern: /\b(months?|weeks?|soon|asap|deadline|flexible|close by|by (the )?(end|spring|summer|fall|autumn|winter)|time ?line|how long)\b/i,
    kind: "next",
    text: "Pin the timeline: ask the date they'd like to close by and what it depends on.",
  },
  {
    id: "condition",
    pattern: /\b(repairs?|roof|condition|needs work|damage|leaks?|renovat\w*|foundation|updated|remodel\w*)\b/i,
    kind: "ask",
    text: "Ask what needs fixing and roughly what it would cost, so the offer reflects it.",
  },
  {
    id: "occupancy",
    pattern: /\b(tenants?|renters?|rented|lease|living there|lives there|occupied|vacant|nobody lives|empty)\b/i,
    kind: "ask",
    text: "Check who is in the property and whether any lease runs past a closing date.",
  },
  {
    id: "competition",
    pattern: /\b(other (buyers|offers|companies)|realtors?|real estate agent|listed|listing|another (company|buyer))\b/i,
    kind: "watch",
    text: "They have other options. Ask what matters most to them besides the price.",
  },
  {
    id: "mortgage",
    pattern: /\b(mortgage|owe|liens?|loan|payoff|behind on|foreclos\w*)\b/i,
    kind: "ask",
    text: "Gently ask roughly what is owed so you know the payoff the sale has to cover.",
  },
  {
    id: "life",
    pattern: /\b(inherit\w*|probate|passed away|estate|divorce|relocat\w*|moving|retire\w*|downsiz\w*)\b/i,
    kind: "say",
    text: "That sounds like a big change. Acknowledge it before anything else, then ask how you can make it easier.",
  },
  {
    id: "warm",
    pattern: /\b(interested|sounds good|tell me more|open to|that works|sure thing|let's talk)\b/i,
    kind: "say",
    text: "They're warm. Summarise what you heard in two sentences and book the next conversation now.",
  },
];

/**
 * Cues for one spoken line. `seen` is the set of rule ids already raised on this call, so each prompt appears once.
 * Returns the new cues and records them in `seen`.
 */
export function cuesFor(text, seen) {
  const found = [];
  for (const rule of RULES) {
    if (seen.has(rule.id)) continue;
    const match = text.match(rule.pattern);
    if (!match) continue;
    seen.add(rule.id);
    found.push({ ruleId: rule.id, kind: rule.kind, text: rule.text, heard: match[0] });
    if (found.length === 3) break;
  }
  return found;
}
