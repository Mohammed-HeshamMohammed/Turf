// The help pages, searchable on /help. Short answers in plain words; the in-app assistant answers the rest.
export type HelpArticle = { slug: string; title: string; topic: string; roles: string[]; body: string[] };

export const helpArticles: HelpArticle[] = [
  { slug: "start", title: "Getting started as an owner", topic: "Setup", roles: ["owner"], body: [
    "Open the CRM from your dashboard. The setup checklist walks you through your agency's name, clients, teams and the people you invite.",
    "Before anyone calls or texts, submit your business under Settings → Carrier registration. Calling opens when the carriers verify your business, and texting when they approve your texting; that can take a few days.",
  ] },
  { slug: "invite", title: "Inviting people and roles", topic: "People", roles: ["owner", "admin", "manager"], body: [
    "Invite by email from Dashboard → Invitations. Choose the role (caller, closer, researcher, team lead, admin or client) and the team.",
    "Team leads invite callers, closers and researchers into the teams they lead. Every seat is counted except clients.",
  ] },
  { slug: "import", title: "Importing a list", topic: "Leads", roles: ["owner", "admin", "manager", "researcher"], body: [
    "In the CRM choose Import, pick a CSV or Excel file and match its columns to name, phone, email and address.",
    "Repeats of leads you already have are shown for you to merge or keep apart. Numbers on your block list come in marked do-not-call.",
  ] },
  { slug: "call", title: "Calling leads", topic: "Calls", roles: [], body: [
    "Open a lead and press Call. Calls go out only in the hours your agency set, from your team's number or the one the lead knows.",
    "After the call choose what happened. Callbacks become tasks; a lead who asks not to be called is blocked at once.",
  ] },
  { slug: "text", title: "Texting leads and consent", topic: "Texts", roles: [], body: [
    "You can text a lead who texted you first, agreed on a form or a call, or whose list the agency confirmed consent for.",
    "STOP and similar replies block the number straight away. A reply that might be an opt-out waits for you to choose.",
  ] },
  { slug: "do-not-call", title: "The block list (do not call)", topic: "Leads", roles: [], body: [
    "Anyone can mark a number not to be called or texted. Only the owner or an admin lifts a block, with a reason that is kept.",
    "A number that came blocked with a lead from another agency stays blocked.",
  ] },
  { slug: "files", title: "Files on leads", topic: "Leads", roles: [], body: [
    "Add PDFs, Word and Excel files and photos up to 25 MB to a lead. Each is checked for harmful content before anyone can open it.",
    "Team leads, admins and the owner share a file with the lead's client or by a link that stops working after the days they choose.",
  ] },
  { slug: "send-lead", title: "Sending a lead to another agency", topic: "Leads", roles: ["owner", "admin"], body: [
    "Open the lead, choose Send to agency, find the agency by its owner's name and tag, and confirm the person agreed to be passed on.",
    "Only the contact details and your note go. You keep a closed copy and see whether they accept.",
  ] },
  { slug: "texting-standing", title: "Why texting can be limited", topic: "Texts", roles: ["owner", "admin"], body: [
    "When many people opt out of or complain about an agency's texts, Caller Whale warns the owner, then limits texting, then suspends it until we review it.",
    "This protects every agency's numbers with the carriers. The owner can appeal once at each step.",
  ] },
  { slug: "security", title: "Two-step sign-in and devices", topic: "Account", roles: [], body: [
    "Turn on two-step sign-in under Settings → Security. The owner can require it of everyone in the agency.",
    "Each new device sign-in is emailed to you. If it wasn't you, the email's link signs that device out.",
  ] },
  { slug: "support", title: "Getting help from Caller Whale", topic: "Account", roles: [], body: [
    "Ask the assistant in the app first: it knows these pages and your screens.",
    "Owners and admins can open a support conversation from the dashboard. Members ask their agency's owner, who can ask us.",
    "Use Send feedback on any page to tell us what to improve. It sends the page and the app version, never your leads.",
  ] },
  { slug: "early-features", title: "Early features", topic: "Account", roles: ["owner"], body: [
    "Owners can switch on features before they reach everyone, under Dashboard → Settings → Early features. They may still change.",
  ] },
];

/** Articles matching every word of the search, in title, topic or text. */
export function searchHelp(query: string, articles = helpArticles): HelpArticle[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return articles;
  return articles.filter(article => {
    const text = `${article.title} ${article.topic} ${article.body.join(" ")}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
}
