// The rules for the password that locks the offline copy on a device, and how strong a choice is. Long beats complicated: a few
// random words are far harder to guess than a short word with a number on the end, and much easier to remember. Nothing here is
// sent anywhere; the password never leaves the device.

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;
/** The example shown to people. It is on everyone's screen, so it is refused as a password. */
export const EXAMPLE = "maple river tractor candle";

const COMMON = [
  "password",
  "password1",
  "password12",
  "password123",
  "passw0rd",
  "p@ssw0rd",
  "qwertyuiop",
  "qwerty123",
  "qwertyui",
  "asdfghjkl",
  "zxcvbnm1",
  "iloveyou",
  "letmein1",
  "welcome1",
  "welcome123",
  "admin1234",
  "administrator",
  "changeme",
  "changeme1",
  "trustno1",
  "dragon123",
  "monkey123",
  "football1",
  "baseball1",
  "superman1",
  "princess1",
  "sunshine1",
  "master123",
  "shadow123",
  "abc12345",
  "abcd1234",
  "abcdefgh",
  "12345678",
  "123456789",
  "1234567890",
  "111111111",
  "000000000",
  "987654321",
  "1q2w3e4r",
  "1qaz2wsx",
  "q1w2e3r4",
  "callerwhale",
  "callerwhale1",
  "callerwhale123",
  "whale1234",
  "offlinecopy",
  "mypassword",
  "mypassword1",
  "letmeinplease",
  "secretpassword",
];
const blocked = new Set([...COMMON, EXAMPLE].map(squash));

/** Lower case with spaces and punctuation removed, so "Maple River-Tractor Candle!" is still the example. */
function squash(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Repeats ("aaaaaaaa", "abababab") and straight runs ("12345678", "abcdefgh", "87654321"). */
function tooSimple(value: string) {
  const text = squash(value);
  if (text.length < 4) return false;
  if (new Set(text).size <= 2) return true;
  for (const size of [1, 2, 3, 4]) {
    const unit = text.slice(0, size);
    if (text.length >= size * 3 && unit.repeat(Math.ceil(text.length / size)).slice(0, text.length) === text) return true;
  }
  let steps = 0;
  for (let i = 1; i < text.length; i += 1) if (Math.abs(text.charCodeAt(i) - text.charCodeAt(i - 1)) === 1) steps += 1;
  return steps >= text.length - 2 && text.length >= 6;
}

export type Check = { label: string; pass: boolean };
export type Assessment = {
  ok: boolean;
  /** 0 nothing typed, 1 weak, 2 fair, 3 good, 4 strong */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  problem: string;
  checks: Check[];
};

export function assess(value: string): Assessment {
  const length = [...value].length;
  const common = length > 0 && blocked.has(squash(value));
  const simple = length > 0 && !common && tooSimple(value);
  const checks: Check[] = [
    { label: `${MIN_LENGTH} or more characters`, pass: length >= MIN_LENGTH },
    { label: "12 or more is better, and 16 or more is best", pass: length >= 12 },
    { label: "Not a common password, and not our example", pass: length > 0 && !common },
    { label: "No repeats or simple runs like 12345 or abcde", pass: length > 0 && !simple },
  ];
  let problem = "";
  if (length > MAX_LENGTH) problem = `Use at most ${MAX_LENGTH} characters.`;
  else if (common) problem = "That one is too common, or it is our example. Make up your own.";
  else if (simple) problem = "That is a repeat or a simple run. Make up something less predictable.";
  else if (length > 0 && length < MIN_LENGTH) problem = `Use at least ${MIN_LENGTH} characters.`;
  const ok = length >= MIN_LENGTH && length <= MAX_LENGTH && !common && !simple;
  let score: Assessment["score"] = 0;
  if (length > 0) {
    const distinct = new Set(squash(value)).size;
    if (!ok) score = 1;
    else if (length >= 16 && distinct >= 8) score = 4;
    else if (length >= 12 && distinct >= 6) score = 3;
    else score = 2;
  }
  return { ok, score, label: ["", "Weak", "Fair", "Good", "Strong"][score], problem, checks };
}
