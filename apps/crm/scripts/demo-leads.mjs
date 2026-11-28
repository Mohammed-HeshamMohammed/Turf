// Writes demo-leads.csv: made-up Florida leads for the demo agency (node scripts/demo-leads.mjs [count]).
// Every number is in a 555 range that is not assigned to anyone. The last four digits pick what the dialer's simulator
// plays (services/telnyx/scenarios.go). Never import this list into a workspace that calls through a live dialer.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// One lead per outcome the demo shows, in the order the presenter calls them: answered, voicemail, no answer, busy,
// disconnected, rejected, dropped, transfer, callback, do not call.
const STORY = ["0001", "0002", "0003", "0004", "0005", "0007", "0009", "0010", "0011", "0013"];
const FIRST = ["Ana", "Ben", "Carla", "David", "Elena", "Frank", "Grace", "Hector", "Irene", "James", "Karen", "Luis", "Maria", "Nathan", "Olivia", "Peter", "Rosa", "Sam", "Tina", "Victor"];
const LAST = ["Diaz", "Brooks", "Nguyen", "Patel", "Carter", "Lopez", "Reed", "Walker", "Hughes", "Moreno"];
const STREETS = ["Bay St", "Palm Ave", "Gulf Blvd", "Oak Dr", "Harbor Ln", "Cypress Way", "Sunset Rd", "Pine St"];
const PLACES = [
  { area: "813", city: "Tampa", zip: "33602" },
  { area: "727", city: "St. Petersburg", zip: "33701" },
  { area: "941", city: "Sarasota", zip: "34236" },
  { area: "352", city: "Gainesville", zip: "32601" },
];
const MOTIVATION = ["Inherited the house", "Relocating for work", "Tired landlord", "Behind on repairs", "Downsizing", "Divorce"];

export function demoLeads(count = 200) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const story = i < STORY.length;
    const place = PLACES[i % PLACES.length];
    // Story leads: 813-555-0001 and so on. The rest: 555-0100 onwards in each area (the fictional 555-01xx block),
    // which no scenario matches, so a person answers (human_answered).
    const line = story ? STORY[i] : String(100 + Math.floor((i - STORY.length) / PLACES.length)).padStart(4, "0");
    rows.push({
      name: `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`,
      phone: `+1${story ? "813" : place.area}555${line}`,
      address: `${100 + i} ${STREETS[i % STREETS.length]}`,
      city: story ? "Tampa" : place.city,
      state: "FL",
      zip: story ? "33602" : place.zip,
      motivation: MOTIVATION[i % MOTIVATION.length],
    });
  }
  return rows;
}

const cell = value => (/[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));

export function toCsv(rows) {
  const header = "Owner Name,Phone,Property Address,City,State,ZIP,Motivation";
  return [header, ...rows.map(row => [row.name, row.phone, row.address, row.city, row.state, row.zip, row.motivation].map(cell).join(","))].join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const count = Number(process.argv[2] || 200);
  writeFileSync("demo-leads.csv", toCsv(demoLeads(count)));
  console.log(`Wrote demo-leads.csv with ${count} leads`);
}
