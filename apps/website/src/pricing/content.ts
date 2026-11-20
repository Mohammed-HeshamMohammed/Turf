// The pricing page's content: the plans, the price of each feature per plan, and the questions people ask. The prices are
// drafts (docs/plans/README.md): each feature is priced alone and a plan is their sum. src/pricing/plan.js does the arithmetic.
export const tiers = [
  { id: "trial", name: "Free trial", who: "Anyone, 7 days", text: "Try everything at small limits." },
  { id: "solo", name: "Solo", who: "1 person", text: "You do everything: lists, skip tracing, calls and deals.", unit: "month" },
  { id: "duo", name: "Duo", who: "Exactly 2 people", text: "Two partners, or a caller and a closer. Both see everything, with nothing to set up.", unit: "month for both" },
  { id: "team", name: "Team", who: "3 or more people", text: "Roles for owners, team leads, callers, closers and researchers, with assignments and reports.", unit: "seat / month" },
  {
    id: "pro", name: "Pro", who: "Teams with power features", text: "For teams that work leads all day and need more than the standard plan includes.", unit: "seat / month",
    includes: [
      "Multi-line dialing (2 to 3 lines) with voicemail drop",
      "Number health checks and rotation",
      "Custom roles and API access",
      "Scheduled and custom reports",
      "Higher limits: 2,500,000 leads, 6,000 texts and 4,000 campaign emails per person",
      "90-day recycle bin and 30-day point-in-time restore",
      "2-year audit log, and single sign-on when it is ready",
    ],
  },
];


// Prices are drafts (docs/plans/README.md): each feature is priced alone and a plan is their sum.
export const priceRows = [
  { feature: "Importing lists", values: ["Free", "$49", "$69", "$39", "$59"], limits: ["25,000 leads", "1,000,000 leads", "2,000,000 shared", "1,000,000 per seat", "2,500,000 per seat"] },
  { feature: "Skip tracing", values: ["Free", "$79", "$119", "$59", "$89"], limits: ["25,000 rows", "1,000,000 rows", "2,000,000 shared", "1,000,000 per seat", "3,000,000 per seat"] },
  { feature: "Dialer and SMS", values: ["Free", "$99", "$179", "$89", "$239"], limits: ["30 minutes of calling", "Unlimited calling · 1,500 texts", "Unlimited calling · 3,000 texts shared", "Unlimited calling · 1,500 texts per seat", "Unlimited calling · 6,000 texts per seat"] },
  { feature: "Leads map", values: ["Free", "$19", "$29", "$15", "$29"], limits: ["500 locations", "5,000 locations", "10,000 shared", "5,000 per seat", "15,000 per seat"] },
  { feature: "The CRM", values: ["Free", "Included", "Included", "Included", "Included"], limits: ["1 GB", "25 GB", "50 GB shared", "25 GB per seat", "100 GB per seat"] },
  { feature: "AI campaigns", values: ["Free", "$49", "$79", "$39", "$79"], limits: ["100 emails", "1,000 emails", "2,000 emails shared", "1,000 per seat", "4,000 per seat"] },
  { feature: "Exports, backup and restore, accounts and security", values: ["Free", "Included", "Included", "Included", "Included"], limits: [] },
];

export const faqs = [
  {
    q: "What is Caller Whale for?",
    a: "Caller Whale is a desktop workspace for people working property leads: organize supplied lists, review phone evidence, record outcomes and keep the next follow-up connected to its record.",
  },
  {
    q: "Can I import my spreadsheet?",
    a: "Yes. The desktop list workflow supports CSV and spreadsheet imports with column mapping. Original source values remain available for review and export.",
  },
  {
    q: "Does Caller Whale work without an internet connection?",
    a: "Yes. Opening a list, skip tracing it and exporting run on your computer. Signing in, syncing with your team, calling and messaging need a connection.",
  },
  {
    q: "Where are my records kept?",
    a: "The local desktop workflow keeps project records on your computer. Team sync and account services have separate online requirements; see Security for the current scope and limitations.",
  },
  {
    q: "Which computers does it run on?",
    a: "Windows first. Create an account to follow the launch; the download will be in your dashboard when the app is ready.",
  },
  {
    q: "How many people can use one account?",
    a: "Solo is one person and Duo is exactly two. Team starts at three and gives each person a role. Clients and partners you share properties with are free seats.",
  },
  {
    q: "What does it cost?",
    a: "Each feature is priced on its own, so you build the plan: switch off what you do not need, add extras where you need more. The ready-made plans are only starting points. The prices on the Pricing page are drafts until launch, and checkout is not open yet.",
  },
  {
    q: "Can I take my data with me?",
    a: "Yes. Exports are included in every plan, and a recycle bin and project backups protect against mistakes.",
  },
  {
    q: "Does Caller Whale find new phone numbers?",
    a: "Not yet. Caller Whale cleans and ranks the numbers your list already has. Looking up new numbers is planned as a separate service.",
  },
  {
    q: "Is calling live today?",
    a: "Not yet. The call screens, outcomes and logs work with sample data. Live calling is a launch feature.",
  },
];

