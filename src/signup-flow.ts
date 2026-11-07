// The questions of the chat-style sign-up (the /test page). Nothing here talks to a server: it is the script of the conversation, kept apart
// from how it looks so it can be tested. Every choice question also offers a way out ("Skip" or "Something else"), and consent boxes start
// unticked: the person is guided, never cornered.

export type Answers = Record<string, string | string[]>;

export type Choice = { value: string; label: string };

export type Step =
  | { id: string; kind: "choice"; ask: string[]; choices: Choice[]; when?: (a: Answers) => boolean }
  | { id: string; kind: "text" | "email" | "password"; ask: string[]; placeholder: string; when?: (a: Answers) => boolean }
  | { id: string; kind: "consent"; ask: string[]; boxes: Box[]; when?: (a: Answers) => boolean }
  | { id: string; kind: "review"; ask: string[]; when?: (a: Answers) => boolean };

export type Box = { id: string; label: string; required: boolean };

const joining = (a: Answers) => a.intent === "new";
const signingIn = (a: Answers) => a.intent === "back";
const withPassword = (a: Answers) => a.method === "email";

export const steps: Step[] = [
  {
    id: "intent",
    kind: "choice",
    ask: ["Hi, I'm the Caller Whale assistant.", "Are you starting something new, or coming back?"],
    choices: [
      { value: "new", label: "Start a new account" },
      { value: "back", label: "I already have an account" },
    ],
  },
  {
    id: "work",
    kind: "choice",
    when: joining,
    ask: ["Welcome. A few quick questions so your workspace fits you.", "What do you do?"],
    choices: [
      { value: "wholesaler", label: "I wholesale properties" },
      { value: "agency", label: "I run a calling team" },
      { value: "solo", label: "I make calls myself" },
      { value: "other", label: "Something else" },
      { value: "skip", label: "Skip" },
    ],
  },
  {
    id: "size",
    kind: "choice",
    when: joining,
    ask: ["How many people will be making calls?"],
    choices: [
      { value: "1", label: "Just me" },
      { value: "2-5", label: "2 to 5" },
      { value: "6-20", label: "6 to 20" },
      { value: "20+", label: "More than 20" },
      { value: "skip", label: "Skip" },
    ],
  },
  {
    id: "first",
    kind: "choice",
    when: joining,
    ask: ["What would you like to do first?"],
    choices: [
      { value: "import", label: "Bring in a list" },
      { value: "sample", label: "Try the sample workspace" },
      { value: "look", label: "Just look around" },
    ],
  },
  { id: "name", kind: "text", when: joining, ask: ["Nice. What should I call you?"], placeholder: "Your first name" },
  {
    id: "method",
    kind: "choice",
    ask: ["How would you like to sign in?"],
    choices: [
      { value: "google", label: "Continue with Google" },
      { value: "email", label: "Use my email and a password" },
    ],
    when: a => joining(a) || signingIn(a),
  },
  { id: "email", kind: "email", when: a => (joining(a) || signingIn(a)) && withPassword(a), ask: ["What is your email address?"], placeholder: "you@example.com" },
  {
    id: "password",
    kind: "password",
    when: a => (joining(a) || signingIn(a)) && withPassword(a),
    ask: ["Now a password. Use at least 10 characters."],
    placeholder: "Your password",
  },
  {
    id: "consent",
    kind: "consent",
    when: joining,
    ask: ["Before I set this up, I need your OK on a few things. Nothing is ticked for you."],
    boxes: [
      { id: "age", label: "I am 18 or older", required: true },
      { id: "terms", label: "I accept the Terms and have read the Privacy notice", required: true },
      { id: "email", label: "Email me about my account and new features", required: false },
      { id: "text", label: "Text me about my account", required: false },
    ],
  },
  { id: "review", kind: "review", ask: [] },
];

/** The question to ask next, given what has been answered; null when the conversation is over. */
export function nextStep(answers: Answers): Step | null {
  return steps.find(step => answers[step.id] === undefined && (!step.when || step.when(answers))) ?? null;
}

const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** What is wrong with an answer, in a sentence; "" when it is fine. */
export function problemWith(step: Step, value: string | string[]): string {
  if (step.kind === "text") return String(value).trim() ? "" : "Tell me what to call you, or use a nickname.";
  if (step.kind === "email") return looksLikeEmail(String(value).trim()) ? "" : "That does not look like an email address.";
  if (step.kind === "password") return String(value).length >= 10 ? "" : "Use at least 10 characters.";
  if (step.kind === "consent") {
    const ticked = new Set(value as string[]);
    const missing = step.boxes.filter(box => box.required && !ticked.has(box.id));
    return missing.length ? "I can only continue once the required boxes are ticked." : "";
  }
  return "";
}

/** What a person's answer looks like as their side of the conversation. Passwords are never shown. */
export function said(step: Step, value: string | string[]): string {
  if (step.kind === "choice") return step.choices.find(choice => choice.value === value)?.label ?? String(value);
  if (step.kind === "password") return "•".repeat(Math.min(String(value).length, 12));
  if (step.kind === "consent") {
    const ticked = new Set(value as string[]);
    const labels = step.boxes.filter(box => ticked.has(box.id)).map(box => box.label);
    return labels.length ? labels.join("; ") : "None";
  }
  return String(value);
}

/** The lines of the final recap. */
export function recap(answers: Answers): [string, string][] {
  const label = (id: string) => {
    const step = steps.find(s => s.id === id);
    return step && answers[id] !== undefined && step.kind === "choice" ? said(step, answers[id]) : "";
  };
  const lines: [string, string][] = [];
  if (answers.intent === "new") {
    if (answers.name) lines.push(["Name", String(answers.name)]);
    for (const [id, title] of [["work", "What you do"], ["size", "Team"], ["first", "First step"]] as const) {
      if (answers[id] && answers[id] !== "skip") lines.push([title, label(id)]);
    }
  }
  lines.push(["Sign-in", answers.method === "google" ? "Google" : String(answers.email ?? "")]);
  if (answers.intent === "new") {
    const ticked = new Set((answers.consent as string[]) ?? []);
    lines.push(["Emails", ticked.has("email") ? "Yes" : "No"], ["Texts", ticked.has("text") ? "Yes" : "No"]);
  }
  return lines;
}
