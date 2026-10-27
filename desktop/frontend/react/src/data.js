export const TODAY = "2026-10-15";
export const LEAD_STAGES = ["New", "Contacted", "Interested", "Qualified", "Closed"];
// The call results a ReadyMode dialer logs ("Log Type", with its abbreviation), and what each means for the lead.
// meaning follows Turf's status reader; recallDays is when the dialer schedules the next try, null for no next try.
export const CALL_OUTCOMES = [
  { label: "Transfer", code: "Trans", meaning: "reached", recallDays: null, help: "Live transfer to Appointments" },
  { label: "Callback", code: "CB", meaning: "reached", recallDays: null, help: "Asked to be called at a set time" },
  { label: "Not interested", code: "NI", meaning: "reached", recallDays: 90, help: "Try again in three months" },
  { label: "Language barrier", code: "Lang", meaning: "reached", recallDays: null, help: "Needs a speaker of their language" },
  { label: "Voicemail", code: "VM", meaning: "voicemail", recallDays: 1, quick: true, help: "Try again tomorrow" },
  { label: "Not available", code: "NA", meaning: "no_answer", recallDays: 1, quick: true, help: "Try again tomorrow" },
  { label: "Dead call", code: "Dead", meaning: "no_answer", recallDays: 1, quick: true, help: "Silence or dropped; not a bad number" },
  { label: "Wrong number", code: "W#", meaning: "wrong_number", recallDays: null, quick: true, help: "Stops calling this number" },
  { label: "Do not call", code: "DNC", meaning: "do_not_call", recallDays: null, quick: true, help: "Blocks every call to this lead" },
];
export const DEAL_STAGES = ["Qualified", "Appointment", "Offer preparation", "Offer sent", "Negotiation", "Under contract", "Closed won", "Closed lost"];
export const PEOPLE = ["Maya Chen", "Alex Rivera", "Ben Carter", "Lena Brooks"];
/** How each sample person signs in, as the server reports it for real members ("password", "google", "apple"). */
export const SIGN_IN = { "Maya Chen": "google", "Alex Rivera": "password", "Ben Carter": "apple", "Lena Brooks": "google" };
export const ROLES = {
  manager: {
    name: "Team manager",
    person: "Lena Brooks",
    title: "Tampa acquisitions",
    scope: "Team records",
    team: "Tampa",
    pages: ["dashboard", "leads", "calls", "deals", "handoffs", "tasks", "calendar", "inbox", "lists", "team", "reports", "settings"],
    capabilities: ["edit", "assign", "handoff", "accept", "call", "message", "export", "finance", "rules"],
  },
  owner: {
    name: "Business owner",
    person: "Jordan Ellis",
    title: "Oak & Palm Partners",
    scope: "Organization records",
    pages: ["dashboard", "leads", "calls", "deals", "handoffs", "tasks", "calendar", "inbox", "lists", "skip", "team", "reports", "settings"],
    capabilities: ["edit", "assign", "handoff", "accept", "call", "message", "export", "finance", "import", "rules", "admin"],
  },
  caller: {
    name: "Caller",
    person: "Maya Chen",
    title: "Outreach team",
    scope: "My assigned leads",
    team: "Tampa",
    pages: ["dashboard", "leads", "calls", "handoffs", "tasks", "calendar", "inbox"],
    capabilities: ["edit", "handoff", "call", "message"],
  },
  closer: {
    name: "Acquisitions / closer",
    person: "Alex Rivera",
    title: "Acquisitions team",
    scope: "My deals & handoffs",
    team: "Tampa",
    pages: ["dashboard", "leads", "calls", "deals", "handoffs", "tasks", "calendar", "inbox", "reports"],
    capabilities: ["edit", "accept", "call", "message", "finance"],
  },
  researcher: {
    name: "Data researcher",
    person: "Ben Carter",
    title: "Data operations",
    scope: "Assigned project data",
    team: "Tampa",
    pages: ["dashboard", "leads", "lists", "skip", "tasks", "reports"],
    capabilities: ["import", "export", "review"],
  },
  admin: {
    name: "System administrator",
    person: "Sam Morgan",
    title: "Workspace administration",
    scope: "System configuration",
    pages: ["dashboard", "settings"],
    capabilities: ["admin"],
  },
  client: {
    name: "Client / partner",
    person: "Taylor Reed",
    title: "Partner workspace",
    scope: "Explicitly shared records",
    pages: ["dashboard", "leads", "tasks", "inbox", "reports"],
    capabilities: ["publicComment"],
  },
  solo: {
    name: "Solo operator",
    person: "Maya Chen",
    title: "My workspace",
    scope: "All project records",
    pages: ["dashboard", "leads", "calls", "deals", "handoffs", "tasks", "calendar", "inbox", "lists", "skip", "reports", "settings"],
    capabilities: ["edit", "assign", "handoff", "accept", "call", "message", "export", "finance", "import", "rules", "admin"],
  },
};

// Sample dialer history, shaped like a ReadyMode call log: one entry per call, newest last.
const call = (id, at, outcome, code, agent, scheduled = "") => ({ id, at, outcome, code, agent, scheduled });
const CALL_HISTORY = {
  l01: [
    call("c01", "2026-10-09T15:12", "Voicemail", "VM", "Maya Chen", "2026-10-10T15:12"),
    call("c02", "2026-10-10T15:20", "Not available", "NA", "Maya Chen", "2026-10-11T15:20"),
    call("c03", "2026-10-14T16:04", "Callback", "CB", "Maya Chen", "2026-10-15T10:30"),
  ],
  l02: [
    call("c04", "2026-10-08T17:41", "Voicemail", "VM", "Maya Chen", "2026-10-09T17:41"),
    call("c05", "2026-10-13T18:02", "Callback", "CB", "Maya Chen", "2026-10-15T11:15"),
  ],
  l03: [call("c06", "2026-10-12T14:30", "Transfer", "Trans", "Ben Carter")],
  l04: [call("c07", "2026-10-14T19:15", "Dead call", "Dead", "Maya Chen", "2026-10-15T15:30")],
  l07: [
    call("c08", "2026-10-06T16:10", "Voicemail", "VM", "Maya Chen", "2026-10-07T16:10"),
    call("c09", "2026-10-07T16:22", "Do not call", "DNC", "Maya Chen"),
  ],
  l09: [call("c10", "2026-10-13T20:05", "Language barrier", "Lang", "Ben Carter")],
};

const LEADS = [
  ["l01", "Sarah Johnson", "1842 Palm Avenue", "Tampa", "FL", "Interested", "Maya Chen", "Tampa", "d01", "10:30", 245000, true, "Ready to call"],
  ["l02", "Michael Bennett", "620 Willow Street", "Tampa", "FL", "Contacted", "Maya Chen", "Tampa", "d01", "11:15", 198000, false, "Ready to call"],
  ["l03", "Patricia Flores", "905 Baywood Drive", "St. Petersburg", "FL", "Qualified", "Alex Rivera", "Tampa", "d02", "14:00", 315000, true, "Ready to call"],
  ["l04", "David Brooks", "221 Magnolia Lane", "Tampa", "FL", "New", "Maya Chen", "Tampa", "d01", "15:30", 224000, false, "Unverified"],
  ["l05", "Angela Lewis", "48 Oak Hollow Road", "Clearwater", "FL", "Interested", "Alex Rivera", "Tampa", "d02", "16:00", 280000, true, "Ready to call"],
  ["l06", "Robert Thompson", "307 Cypress Court", "Orlando", "FL", "New", "Ben Carter", "Orlando", "d03", "", 269000, false, "Possible duplicate"],
  ["l07", "Linda Walker", "814 Lakeview Avenue", "Tampa", "FL", "Closed", "Maya Chen", "Tampa", "d01", "", 210000, false, "Do not call"],
  ["l08", "James Parker", "92 Garden Way", "Orlando", "FL", "Qualified", "Lena Brooks", "Orlando", "d03", "13:30", 360000, false, "Ready to call"],
  ["l09", "Maria Torres", "160 Seabreeze Street", "St. Petersburg", "FL", "Contacted", "Ben Carter", "Tampa", "d02", "", 235000, false, "Unverified"],
  ["l10", "William Davis", "511 Elm Terrace", "Tampa", "FL", "New", "Unassigned", "Tampa", "d04", "", 189000, false, "Unverified"],
  ["l11", "Evelyn Scott", "73 Sunset Drive", "Orlando", "FL", "Interested", "Lena Brooks", "Orlando", "d03", "09:00", 298000, false, "Ready to call"],
  ["l12", "Daniel Moore", "421 Harbor Court", "Tampa", "FL", "Qualified", "Alex Rivera", "Tampa", "d04", "14:45", 342000, false, "Ready to call"],
].map((row, index) => ({
  id: row[0],
  name: row[1],
  address: row[2],
  city: row[3],
  region: row[4],
  stage: row[5],
  assignee: row[6],
  team: row[7],
  datasetId: row[8],
  callback: row[9],
  callbackDate: row[9] ? TODAY : "",
  value: row[10],
  shared: row[11],
  verdict: row[12],
  phone: "+1 (813) 555-" + String(101 + index).padStart(4, "0"),
  email: row[1].toLowerCase().replaceAll(" ", ".") + "@example.com",
  zip: "336" + String(10 + index),
  source: index % 2 ? "County records" : "Absentee owners",
  priority: index < 3 ? "High" : "Normal",
  version: 1,
  calls: structuredClone(CALL_HISTORY[row[0]] || []),
  beds: 3,
  baths: 2,
  area: 1640 + index * 55,
  motivation: index === 0 ? "Moving closer to family. Would like a flexible closing date." : "Discuss their timeline and plans for the property.",
  notes: [
    {
      id: "note-" + index,
      text:
        index === 0
          ? "Spoke with Sarah. She is open to a conversation about an offer. Call back after 10 am."
          : "Imported from the source list. Verify the best way to reach the owner.",
      visibility: "internal",
      at: "Yesterday",
      actor: row[6],
    },
  ],
}));

export function seedState() {
  return {
    schema: 2,
    role: "manager",
    online: true,
    callLog: [],
    leads: structuredClone(LEADS),
    datasets: [
      {
        id: "d01",
        name: "Tampa absentee owners",
        description: "Outreach · October 2026",
        status: "Checked",
        team: "Tampa",
        date: "Oct 14",
        columns: ["Owner", "Address", "Phone", "Email"],
      },
      {
        id: "d02",
        name: "Pinellas opportunity list",
        description: "Acquisitions · October 2026",
        status: "Checked",
        team: "Tampa",
        date: "Oct 13",
        columns: ["Owner", "Address", "Phone", "Email"],
      },
      {
        id: "d03",
        name: "Orlando county records",
        description: "Research · October 2026",
        status: "Needs review",
        team: "Orlando",
        date: "Oct 12",
        columns: ["Owner", "Address", "Phone", "Email"],
      },
      {
        id: "d04",
        name: "New leads · October",
        description: "Import · Not checked",
        status: "Not checked",
        team: "Tampa",
        date: "Oct 15",
        columns: ["Owner", "Address", "Phone", "Email"],
      },
    ],
    deals: [
      { id: "deal01", leadId: "l03", stage: "Offer sent", amount: 275000, fee: 18000, closeDate: "2026-11-03" },
      { id: "deal02", leadId: "l05", stage: "Appointment", amount: 245000, fee: 16000, closeDate: "2026-11-10" },
      { id: "deal03", leadId: "l08", stage: "Under contract", amount: 320000, fee: 24000, closeDate: "2026-10-30" },
      { id: "deal04", leadId: "l12", stage: "Negotiation", amount: 295000, fee: 21000, closeDate: "2026-11-07" },
    ],
    tasks: [
      {
        id: "t01",
        title: "Call Sarah about her timeline",
        leadId: "l01",
        assignee: "Maya Chen",
        time: "10:30",
        date: TODAY,
        priority: "High",
        done: false,
        type: "Callback",
      },
      {
        id: "t02",
        title: "Follow up with Michael",
        leadId: "l02",
        assignee: "Maya Chen",
        time: "11:15",
        date: TODAY,
        priority: "Normal",
        done: false,
        type: "Callback",
      },
      {
        id: "t03",
        title: "Review Patricia's offer",
        leadId: "l03",
        assignee: "Alex Rivera",
        time: "14:00",
        date: TODAY,
        priority: "High",
        done: false,
        type: "Offer",
      },
      {
        id: "t04",
        title: "Visit Angela's property",
        leadId: "l05",
        assignee: "Alex Rivera",
        time: "16:00",
        date: "2026-10-16",
        priority: "Normal",
        done: false,
        type: "Appointment",
      },
      {
        id: "t05",
        title: "Review possible duplicate",
        leadId: "l06",
        assignee: "Ben Carter",
        time: "09:00",
        date: TODAY,
        priority: "Normal",
        done: false,
        type: "Data review",
      },
      {
        id: "t06",
        title: "Send approved property brief",
        leadId: "l03",
        assignee: "Alex Rivera",
        time: "12:00",
        date: TODAY,
        priority: "Normal",
        done: false,
        type: "Document",
        shared: true,
      },
    ],
    handoffs: [
      {
        id: "h01",
        leadId: "l05",
        from: "Maya Chen",
        to: "Alex Rivera",
        status: "Accepted",
        note: "Seller is open to an offer. Interested in a November closing.",
        at: "Yesterday",
      },
    ],
    activities: [
      { id: "a01", leadId: "l03", actor: "Alex Rivera", text: "Sent an offer to Patricia Flores", time: "12 min ago", kind: "Deal" },
      { id: "a02", leadId: "l01", actor: "Maya Chen", text: "Scheduled Sarah's callback for 10:30", time: "28 min ago", kind: "Callback" },
      { id: "a03", leadId: "l05", actor: "Alex Rivera", text: "Accepted Maya's lead handoff", time: "42 min ago", kind: "Handoff" },
      { id: "a04", leadId: "l09", actor: "Ben Carter", text: "Reviewed the best phone for Maria", time: "1 hour ago", kind: "Research" },
    ],
    threads: [
      {
        id: "m04",
        leadId: "l01",
        channel: "Partner",
        shared: true,
        preview: "Your approved property brief is ready.",
        unread: false,
        messages: [
          { from: "Alex Rivera", text: "Your approved property brief is ready. Let us know if you have any questions.", at: "Yesterday", incoming: true },
        ],
      },
      {
        id: "m01",
        leadId: "l01",
        channel: "SMS",
        preview: "Tomorrow morning works for me. Thank you!",
        unread: true,
        messages: [
          { from: "Sarah Johnson", text: "Tomorrow morning works for me. Thank you!", at: "9:04 am", incoming: true },
          { from: "Maya Chen", text: "Perfect, Sarah. I'll give you a call after 10 am.", at: "9:06 am", incoming: false },
        ],
      },
      {
        id: "m02",
        leadId: "l03",
        channel: "Email",
        preview: "Re: Your property on Baywood Drive",
        unread: false,
        messages: [
          {
            from: "Patricia Flores",
            text: "Thanks for sending the offer. Could we discuss a closing date in early November?",
            at: "Yesterday",
            incoming: true,
          },
        ],
      },
      {
        id: "m03",
        leadId: "l05",
        channel: "Team",
        preview: "Handoff accepted. Appointment booked.",
        unread: false,
        messages: [
          { from: "Alex Rivera", text: "Handoff accepted. Appointment booked for Friday. Maya, thanks for the context.", at: "Yesterday", incoming: true },
        ],
      },
    ],
    queue: [],
    conflicts: [],
    settings: { workspace: "Oak & Palm Partners", timezone: "America/New_York", dailyGoal: 30 },
    rules: [
      { id: "r01", name: "A missed call gets a next step", when: "No answer", action: "Create callback in 2 days", enabled: true },
      { id: "r02", name: "Keep handoffs moving", when: "Handoff waiting 24 hours", action: "Notify team manager", enabled: true },
      { id: "r03", name: "A qualified lead starts a deal", when: "Lead becomes qualified", action: "Create acquisition task", enabled: false },
    ],
    integrations: { Email: false, SMS: false, Voice: false },
    permissions: {},
    personal: {},
    reportSchedules: [],
  };
}

export const CALL_DAYS = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const CALL_INTERVALS = [
  [
    [2, 3, 4, 4, 3, 2],
    [1, 1, 1, 2, 1, 1],
  ],
  [
    [3, 4, 6, 5, 4, 3],
    [1, 2, 3, 2, 2, 2],
  ],
  [
    [2, 3, 4, 3, 3, 1],
    [1, 1, 2, 2, 1, 1],
  ],
  [
    [1, 1, 2, 2, 2, 1],
    [0, 0, 1, 1, 1, 0],
  ],
  [
    [4, 5, 7, 7, 5, 4],
    [2, 2, 4, 4, 2, 2],
  ],
  [
    [3, 5, 6, 6, 5, 3],
    [1, 2, 3, 3, 2, 2],
  ],
  [
    [4, 6, 8, 8, 6, 5],
    [2, 3, 5, 4, 4, 3],
  ],
];
// Explicit illustrative intervals preserve the sample daily totals; no interpolation.
export const CALL_TREND = CALL_INTERVALS.flatMap(([calls, reached], day) =>
  calls.map((count, interval) => ({
    day: CALL_DAYS[day],
    date: "Oct " + (8 + day),
    slot: day * 24 + 8 + interval * 2,
    time: String(8 + interval * 2).padStart(2, "0") + ":00–" + String(10 + interval * 2).padStart(2, "0") + ":00",
    calls: count,
    reached: reached[interval],
  })),
);
