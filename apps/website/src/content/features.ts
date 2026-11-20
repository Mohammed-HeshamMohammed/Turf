// What each feature is and how far along it is. Taken from docs/features. The status words are honest:
//   now      built and working in the app today
//   preview  built as a working screen with sample data; the live service behind it is not connected yet
//   soon     planned for launch, not built
// Check these against the app before each launch and change the status when the work lands.

export type Status = "now" | "preview" | "soon";

export const STATUS: Record<Status, string> = {
  "now": "In the app now",
  "preview": "In preview",
  "soon": "Coming at launch"
};

export interface Shot {
  shot: string;
  alt: string;
}

export interface Feature {
  /** The address of the feature's own page: /features/<slug>. */
  slug: string;
  title: string;
  short: string;
  status: Status;
  pitch: string;
  text: string;
  points: string[];
  soon?: string[];
  shot: string;
  alt: string;
  extra?: Shot[];
}

export const features: Feature[] = [
  {
    "slug": "import-lists",
    "title": "Import lists",
    "short": "Bring a spreadsheet from any source. Caller Whale reads the columns it recognises and asks about the rest.",
    "status": "now",
    "pitch": "Any list, any source, and the original is never touched.",
    "text": "County exports, PropStream, any CSV up to 50 MB. Caller Whale maps the columns, keeps every row and tells you what it found. Lists live on your computer, so they open instantly and work offline.",
    "points": [
      "Smart column mapping, remembered for the next list from the same source",
      "Households, LLCs, trusts and owners with many properties told apart",
      "Download any list as it was imported or as it is after checking",
      "Processing on your computer is not counted against your plan: import, merge and re-check as much as you like"
    ],
    "shot": "lists",
    "alt": "The Source lists page with four imported lists, each showing its records and check status."
  },
  {
    "slug": "skip-tracing",
    "title": "Skip tracing",
    "short": "Clean and rank the phone numbers a list already has, on your own computer, offline.",
    "status": "now",
    "pitch": "Know which number to call first, and why.",
    "text": "Caller Whale looks at the evidence in your own list, ranks the phone numbers, and keeps every original value. You can correct any answer, and Caller Whale remembers your decision.",
    "points": [
      "Starts with the strongest evidence: phone, then address, email and owner name",
      "The strongest number first, with the reason",
      "Every source column kept; mappings saved per source",
      "Review and overrule any answer"
    ],
    "soon": [
      "Do Not Call blocking by area code",
      "Right-person check on whether a number belongs to the owner",
      "Hints learned from calls across all Caller Whale customers"
    ],
    "shot": "skip",
    "alt": "The Skip Tracing page showing detected source fields, the evidence order and the check context."
  },
  {
    "slug": "dialer-and-sms",
    "title": "Dialer, auto dialing and SMS",
    "short": "Call and text from the app, with the queue, outcomes and history beside you.",
    "status": "preview",
    "pitch": "Calling that stays inside your CRM.",
    "text": "The call queue, call screen, outcomes, call log, SMS composer and dial pad all work in the app today with sample data. Live calling through the phone network is the next step. Calling is unlimited, and texts are flexible: 1,500 a month included, more when you need them.",
    "points": [
      "A call queue per list, with the lead, script and call assistant beside it",
      "One-click outcomes: voicemail, not available, wrong number, do not call",
      "A call log with timestamps, duration and who hung up",
      "A dial pad that works from every page"
    ],
    "soon": [
      "Live calling inside Caller Whale, with a 'call me first' option for older computers",
      "Power dialing, then multi-line with automatic abandonment tracking",
      "Voicemail detection and drop; texting for replies and follow-ups"
    ],
    "shot": "calls",
    "alt": "The Calls page with the call queue, the lead card with a Start call button, and the call assistant.",
    "extra": [
      {
        "shot": "call-live",
        "alt": "A demo call in progress: a green status bar with the elapsed timer, End call, and quick outcome buttons below."
      }
    ]
  },
  {
    "slug": "leads-map",
    "title": "Leads map",
    "short": "See every property on a map and open a lead from its pin.",
    "status": "now",
    "pitch": "Your leads, where they actually are.",
    "text": "Every lead appears at once at its ZIP area. Press one button and Caller Whale finds exact locations from the street address, sending only the address, never names or phone numbers.",
    "points": [
      "Price pins, grouped into count bubbles when you zoom out",
      "Property cards beside the map for what is in view",
      "Hover a card to light its pin; choose a pin to select its card",
      "Dashed pins show when only the area is known"
    ],
    "soon": [
      "Offline maps for a county or a state",
      "Show my leads within half a mile of this one"
    ],
    "shot": "map",
    "alt": "The Leads map with price pins over Tampa and a list of property cards beside it."
  },
  {
    "slug": "crm",
    "title": "A CRM built for deals",
    "short": "Leads, deals, tasks, handoffs, inbox, team and reports in one place.",
    "status": "now",
    "pitch": "From first call to closed deal, with nothing in a spreadsheet.",
    "text": "Every lead has its property, owner, notes, next step and history. Callers hand deals to closers, and ownership moves only when the closer accepts.",
    "points": [
      "An overview that opens with what needs you today",
      "Leads as a list, a board or a map; deals through eight stages",
      "Tasks, calendar and callbacks that follow the lead",
      "Roles for owners, managers, callers, closers, researchers and clients, each seeing only their part",
      "Follow-up rules, such as no answer, callback in two days",
      "Reports by source and by person, as CSV or PDF"
    ],
    "shot": "deals",
    "alt": "The Deals board with stages from Qualified to Closed won.",
    "extra": [
      {
        "shot": "dashboard",
        "alt": "The overview page with active leads, next steps and pipeline value."
      },
      {
        "shot": "leads",
        "alt": "The Leads page, a table with phone quality, stage and next step."
      }
    ]
  },
  {
    "slug": "ai-campaigns",
    "title": "AI campaigns",
    "short": "Write and send email and text campaigns, and draft replies, from the lead record.",
    "status": "soon",
    "pitch": "Outreach that stops the moment someone replies.",
    "text": "Pick who, pick the channel and the steps, and the AI writes each message from the lead's own details. You approve drafts one by one or in bulk, or let it send within limits you set.",
    "points": [
      "A lead's steps stop as soon as they reply",
      "Every reply sorted: interested, not interested, question, stop, wrong person, already sold",
      "Interested moves the stage and creates a callback; a stop blocks the lead for good",
      "You approve by default; automatic sending is opt-in"
    ],
    "shot": "inbox",
    "alt": "The Inbox with SMS, email and team conversations beside the open thread. Campaign replies will land here."
  },
  {
    "slug": "exports",
    "title": "Exports",
    "short": "Take your data to any other tool as CSV, any time, at no extra cost.",
    "status": "now",
    "pitch": "Your data goes wherever you need it.",
    "text": "Caller Whale makes the file the next tool expects, not just a dump.",
    "points": [
      "Call list for any outside dialer: each lead once, best number first, other numbers, stage, callback and latest note",
      "Mail list for a mail house: each owner once at their mailing address, with absentee-only and no-PO-box filters",
      "Before and after copies of every list",
      "Leads view and reports as CSV; reports as PDF"
    ],
    "shot": "reports",
    "alt": "The Reports page with an Export CSV button and Print / save PDF."
  },
  {
    "slug": "backup-and-restore",
    "title": "Backup and restore",
    "short": "A recycle bin and project backups, so a mistake is easier to undo.",
    "status": "now",
    "pitch": "A way back from most mistakes.",
    "text": "Deleted lists wait for 30 days and come back with everything they had. Reversible changes, like archiving a lead, happen at once with an Undo.",
    "points": [
      "A recycle bin for deleted lists, with every row, setup and check",
      "One-file project backup that opens as a project anywhere",
      "Undo on archived leads, deleted tasks and notes"
    ],
    "soon": [
      "Automatic daily backups on your computer",
      "Server backups and restore to a chosen moment",
      "Download your whole workspace in one zip"
    ],
    "shot": "handoffs",
    "alt": "The Handoffs page showing requests passed from callers to closers."
  }
];

export const featureBySlug = (slug: string) => features.find(feature => feature.slug === slug);

/** The screenshot files this content names, in public/screens/. */
export const screenFiles: string[] = ["call-live","calls","dashboard","deals","handoffs","inbox","leads","lists","map","reports","skip"];
