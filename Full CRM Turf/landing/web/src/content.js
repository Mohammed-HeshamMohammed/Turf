// Everything the site says. It is taken from docs/features and docs/plans. Status words are honest:
//   now     built and working in the app today
//   preview built as a working screen with sample data; the live service behind it is not connected yet
//   soon    planned for launch, not built

export const STATUS = {
  now: "In the app now",
  preview: "In preview",
  soon: "Coming at launch",
};

export const features = [
  {
    id: "lists",
    icon: "UploadSimple",
    title: "Import lists",
    short: "Bring a spreadsheet from any source. Turf reads the columns it recognises and asks about the rest.",
    status: "now",
    pitch: "Any list, any source, and the original is never touched.",
    text: "County exports, PropStream, any CSV up to 50 MB. Turf maps the columns, keeps every row and tells you what it found. Lists live on your computer, so they open instantly and work offline.",
    points: [
      "Smart column mapping, remembered for the next list from the same source",
      "Households, LLCs, trusts and owners with many properties told apart",
      "Download any list as it was imported or as it is after checking",
      "Processing is never counted against your plan: import, merge and re-check as much as you like",
    ],
    shot: "lists",
    alt: "The Source lists page with four imported lists, each showing its records and check status.",
  },
  {
    id: "skip",
    icon: "MagnifyingGlass",
    title: "Skip tracing",
    short: "Clean and rank the phone numbers a list already has, on your own computer, offline.",
    status: "now",
    pitch: "Know which number to call first, and why.",
    text: "Turf looks at the evidence in your own list, picks the best phone, and keeps every original value. You can correct any answer, and Turf remembers your decision.",
    points: [
      "Starts with the strongest evidence: phone, then address, email and owner name",
      "The best number first, with the reason",
      "Every source column kept; mappings saved per source",
      "Review and overrule any answer",
    ],
    soon: [
      "Do Not Call blocking by area code",
      "Right-person check on whether a number belongs to the owner",
      "Hints learned from calls across all Turf customers",
    ],
    shot: "skip",
    alt: "The Skip Tracing page showing detected source fields, the evidence order and the check context.",
  },
  {
    id: "dialer",
    icon: "Phone",
    title: "Dialer, auto dialing and SMS",
    short: "Call and text from the app, with the queue, outcomes and history beside you.",
    status: "preview",
    pitch: "Calling that stays inside your CRM.",
    text: "The call queue, call screen, outcomes, call log, SMS composer and dial pad all work in the app today with sample data. Live calling through the phone network is the next step.",
    points: [
      "A call queue per list, with the lead, script and call assistant beside it",
      "One-click outcomes: voicemail, not available, wrong number, do not call",
      "A call log with timestamps, duration and who hung up",
      "A dial pad that works from every page",
    ],
    soon: [
      "Live calling inside Turf, with a 'call me first' option for older computers",
      "Power dialing, then multi-line with automatic abandonment tracking",
      "Voicemail detection and drop; texting for replies and follow-ups",
    ],
    shot: "calls",
    alt: "The Calls page with the call queue, the lead card with a Start call button, and the call assistant.",
    extra: [{ shot: "call-live", alt: "A demo call in progress: a green status bar with the elapsed timer, End call, and quick outcome buttons below." }],
  },
  {
    id: "map",
    icon: "MapTrifold",
    title: "Leads map",
    short: "See every property on a map and open a lead from its pin.",
    status: "now",
    pitch: "Your leads, where they actually are.",
    text: "Every lead appears at once at its ZIP area. Press one button and Turf finds exact locations from the street address, sending only the address, never names or phone numbers.",
    points: [
      "Price pins, grouped into count bubbles when you zoom out",
      "Property cards beside the map for what is in view",
      "Hover a card to light its pin; choose a pin to select its card",
      "Dashed pins show when only the area is known",
    ],
    soon: ["Offline maps for a county or a state", "Show my leads within half a mile of this one"],
    shot: "map",
    alt: "The Leads map with price pins over Tampa and a list of property cards beside it.",
  },
  {
    id: "crm",
    icon: "Kanban",
    title: "A CRM built for deals",
    short: "Leads, deals, tasks, handoffs, inbox, team and reports in one place.",
    status: "now",
    pitch: "From first call to closed deal, with nothing in a spreadsheet.",
    text: "Every lead has its property, owner, notes, next step and history. Callers hand deals to closers, and ownership moves only when the closer accepts.",
    points: [
      "An overview that opens with what needs you today",
      "Leads as a list, a board or a map; deals through eight stages",
      "Tasks, calendar and callbacks that follow the lead",
      "Roles for owners, managers, callers, closers, researchers and clients, each seeing only their part",
      "Follow-up rules, such as no answer, callback in two days",
      "Reports by source and by person, as CSV or PDF",
    ],
    shot: "deals",
    alt: "The Deals board with stages from Qualified to Closed won.",
    extra: [
      { shot: "dashboard", alt: "The overview page with active leads, next steps and pipeline value." },
      { shot: "leads", alt: "The Leads page, a table with phone quality, stage and next step." },
    ],
  },
  {
    id: "ai",
    icon: "Sparkle",
    title: "AI campaigns",
    short: "Write and send email and text campaigns, and draft replies, from the lead record.",
    status: "soon",
    pitch: "Outreach that stops the moment someone replies.",
    text: "Pick who, pick the channel and the steps, and the AI writes each message from the lead's own details. You approve drafts one by one or in bulk, or let it send within limits you set.",
    points: [
      "A lead's steps stop as soon as they reply",
      "Every reply sorted: interested, not interested, question, stop, wrong person, already sold",
      "Interested moves the stage and creates a callback; a stop blocks the lead for good",
      "You approve by default; automatic sending is opt-in",
    ],
    shot: "inbox",
    alt: "The Inbox with SMS, email and team conversations beside the open thread. Campaign replies will land here.",
  },
  {
    id: "exports",
    icon: "Export",
    title: "Exports",
    short: "Take your data to any other tool as CSV, any time, at no extra cost.",
    status: "now",
    pitch: "Your data goes wherever you need it.",
    text: "Turf makes the file the next tool expects, not just a dump.",
    points: [
      "Call list for any outside dialer: each lead once, best number first, other numbers, stage, callback and latest note",
      "Mail list for a mail house: each owner once at their mailing address, with absentee-only and no-PO-box filters",
      "Before and after copies of every list",
      "Leads view and reports as CSV; reports as PDF",
    ],
    shot: "reports",
    alt: "The Reports page with an Export CSV button and Print / save PDF.",
  },
  {
    id: "backup",
    icon: "Archive",
    title: "Backup and restore",
    short: "A recycle bin and project backups, so a mistake is never the end of a list.",
    status: "now",
    pitch: "Undo is always one click away.",
    text: "Deleted lists wait for 30 days and come back with everything they had. Reversible changes, like archiving a lead, happen at once with an Undo.",
    points: [
      "A recycle bin for deleted lists, with every row, setup and check",
      "One-file project backup that opens as a project anywhere",
      "Undo on archived leads, deleted tasks and notes",
    ],
    soon: ["Automatic daily backups on your computer", "Server backups and restore to a chosen moment", "Download your whole workspace in one zip"],
    shot: "handoffs",
    alt: "The Handoffs page showing requests passed from callers to closers.",
  },
];

export const steps = [
  { title: "Import", text: "Drop in a list. It is on your machine in seconds." },
  { title: "Skip trace", text: "Turf ranks the numbers worth calling and keeps every original value." },
  { title: "Reach out", text: "Call and text from one screen, with the lead beside you." },
  { title: "Close", text: "Follow-ups, handoffs and reports keep the deal moving." },
];

export const principles = [
  { icon: "WifiSlash", title: "Works offline", text: "Lists open, skip trace and export without a connection. Sign-in and sync need one." },
  { icon: "ShieldCheck", title: "Your data, untouched", text: "Original values are never changed. Download any list before or after checking, any time." },
  { icon: "Users", title: "Clients are free seats", text: "Partners and clients only see what you share with them, and they never cost a seat." },
];

export const audiences = [
  { title: "Wholesalers and investors", text: "Work absentee-owner and county lists from first call to assignment or purchase." },
  { title: "Acquisition teams", text: "Give callers, closers and researchers their own view, with handoffs and reports by person." },
  { title: "Solo operators and partners", text: "Run everything yourself, or with one partner, with nothing to set up." },
];

export const tiers = [
  { id: "trial", name: "Free trial", who: "Anyone, 7 days", text: "Try everything at small limits." },
  { id: "solo", name: "Solo", who: "1 person", text: "You do everything: lists, skip tracing, calls and deals.", price: 344, unit: "month" },
  { id: "duo", name: "Duo", who: "Exactly 2 people", text: "Two partners, or a caller and a closer. Both see everything, with nothing to set up.", price: 554, unit: "month for both" },
  { id: "team", name: "Team", who: "3 or more people", text: "Roles for owners, team leads, callers, closers and researchers, with assignments and reports.", price: 286, unit: "seat / month", from: 858 },
  { id: "pro", name: "Pro", who: "Teams with power features", text: "Multi-line dialing, the biggest limits and custom roles for teams that work leads all day.", price: 554, unit: "seat / month", from: 1662 },
];

// Prices are drafts (docs/plans/README.md): each feature is priced alone and a plan is their sum.
export const priceRows = [
  { feature: "Importing lists", values: ["Free", "$49", "$69", "$39", "$59"], limits: ["25,000 leads", "1,000,000 leads", "2,000,000 shared", "1,000,000 per seat", "2,500,000 per seat"] },
  { feature: "Skip tracing", values: ["Free", "$79", "$119", "$59", "$89"], limits: ["25,000 rows", "1,000,000 rows", "2,000,000 shared", "1,000,000 per seat", "3,000,000 per seat"] },
  { feature: "Dialer and SMS", values: ["Free", "$99", "$179", "$89", "$239"], limits: ["30 minutes", "3,000 minutes", "6,000 shared", "3,000 per seat", "8,000 per seat"] },
  { feature: "Leads map", values: ["Free", "$19", "$29", "$15", "$29"], limits: ["500 locations", "5,000 locations", "10,000 shared", "5,000 per seat", "15,000 per seat"] },
  { feature: "The CRM", values: ["Free", "$49", "$79", "$45", "$59"], limits: ["1 GB", "25 GB", "50 GB shared", "25 GB per seat", "100 GB per seat"] },
  { feature: "AI campaigns", values: ["Free", "$49", "$79", "$39", "$79"], limits: ["100 emails", "5,000 emails", "10,000 shared", "5,000 per seat", "20,000 per seat"] },
  { feature: "Exports, backup and restore, accounts and security", values: ["Free", "Included", "Included", "Included", "Included"], limits: [] },
];

export const compareRows = [
  { need: "Stacking and cleaning lists", usual: "A list tool with a record limit", turf: "On your computer, unlimited, never counted" },
  { need: "Ranking phone numbers", usual: "A separate skip-tracing or scrubbing service", turf: "One check, with the best number first and the reason" },
  { need: "Calling", usual: "A dialer, billed per user", turf: "In the same app as the lead" },
  { need: "Texting", usual: "Another subscription", turf: "On the lead's own thread in the Inbox" },
  { need: "Tracking deals", usual: "A CRM you copy results into", turf: "Built in, fed by every call outcome" },
  { need: "Sending data on", usual: "Copy and paste", turf: "Call list and mail list files made for the next tool" },
  { need: "No connection", usual: "Stops working", turf: "Lists, skip tracing and exports keep working" },
];

export const securityPoints = [
  { icon: "LockKey", title: "Passwords", text: "Stored only as Argon2id hashes. Sessions use HttpOnly cookies, and five failed sign-ins in 15 minutes pauses the account.", status: "now" },
  { icon: "Buildings", title: "One organization never sees another", text: "Row-level security in the database, so an organization can never read another's rows, even through a bug in a page.", status: "now" },
  { icon: "GoogleLogo", title: "Google sign-in", text: "On the website and in the desktop app. In the app, sign-in happens in your own browser, never inside the app window.", status: "now" },
  { icon: "DeviceMobile", title: "Two-step sign-in", text: "Authenticator code plus recovery codes, required for owners and administrators. Built; switched on before launch.", status: "preview" },
  { icon: "HardDrives", title: "Encrypted offline copy", text: "Changes made offline wait in an encrypted copy on your machine, unlocked by your passphrase, and sync when you reconnect.", status: "now" },
  { icon: "CreditCard", title: "No card numbers", text: "Checkout goes to the payment provider, and only the provider's signed notice marks a payment paid. Turf never stores card numbers.", status: "now" },
  { icon: "ListChecks", title: "Audit log and devices", text: "Who did what and when, and every signed-in device you can sign out.", status: "soon" },
  { icon: "IdentificationBadge", title: "Single sign-on", text: "Sign in through Google Workspace or Microsoft 365 for larger teams.", status: "soon" },
];

export const faqs = [
  { q: "Does Turf work without an internet connection?", a: "Yes. Opening a list, skip tracing it and exporting run on your computer. Signing in, syncing with your team, calling and messaging need a connection." },
  { q: "Where are my records kept?", a: "On your computer, and on your organization's server when you sync. Records are never shared between organizations." },
  { q: "Which computers does it run on?", a: "Windows first. The download button serves the newest release." },
  { q: "How many people can use one account?", a: "Solo is one person and Duo is exactly two. Team starts at three and gives each person a role. Clients and partners you share properties with are free seats." },
  { q: "What does it cost?", a: "Each feature is priced on its own and a plan is the sum of its features. The prices on the Pricing page are drafts until launch, and people on the waitlist hear first." },
  { q: "Can I take my data with me?", a: "Yes. Exports are included in every plan, and a recycle bin and project backups protect against mistakes." },
  { q: "Does Turf find new phone numbers?", a: "Not yet. Turf cleans and ranks the numbers your list already has. Looking up new numbers is planned as a separate service." },
  { q: "Is calling live today?", a: "Not yet. The call screens, outcomes and logs work with sample data. Live calling is a launch feature." },
];

export const footerLinks = [
  { title: "Product", links: [["Features", "/features"], ["Pricing", "/pricing"], ["Why Turf", "/compare"], ["Security", "/security"], ["Download", "/#download"]] },
  { title: "Company", links: [["Join the waitlist", "/#waitlist"], ["Contact", "/contact"]] },
  { title: "Legal", links: [["Privacy", "/privacy"], ["Terms", "/terms"]] },
];

export const pageMeta = {
  home: ["Turf · The CRM and dialer for property outreach", "Import lists, skip trace them, call and text owners, and track every deal in one desktop CRM that keeps working offline."],
  features: ["Features · Turf", "Lists, skip tracing, dialer, leads map, CRM, AI campaigns, exports and backup. Everything a property lead goes through."],
  pricing: ["Pricing · Turf", "Draft launch pricing for Solo, Duo, Team and Pro. Each feature is priced alone and a plan is their sum."],
  compare: ["Why Turf · One app instead of five", "See how one app replaces a list tool, a skip-tracing service, a dialer, a texting tool and a CRM."],
  security: ["Security · Turf", "How Turf protects your accounts and records, what is built today and what is coming."],
  contact: ["Contact · Turf", "Questions about Turf? Send a message."],
  privacy: ["Privacy · Turf", "How the Turf website uses the details you give it."],
  terms: ["Terms · Turf", "Terms for the Turf website."],
  notfound: ["Page not found · Turf", "That page does not exist."],
};
