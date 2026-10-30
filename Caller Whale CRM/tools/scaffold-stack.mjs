// Creates the folders and the starting code for every service and desktop module listed in tools/stack.json, and the
// files that list the whole stack (Cargo workspace, compose file, service registry). It never overwrites a file that
// already exists, so it is safe to run again after adding a service to stack.json.
//
//   node tools/scaffold-stack.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templates = join(root, "tools", "templates");
const stack = JSON.parse(readFileSync(join(root, "tools", "stack.json"), "utf8"));

const LANGS = {
  rust: { name: "Rust", tpl: "rust-service", run: dir => `cargo test -p callerwhale-${dir.slug}\nPORT=${dir.port} cargo run -p callerwhale-${dir.slug}` },
  ts: { name: "TypeScript (Node 24 or newer, no build step)", tpl: "ts-service", run: dir => `npm --prefix ${dir.dir} test\nPORT=${dir.port} npm --prefix ${dir.dir} start` },
  python: { name: "Python 3.13 or newer (standard library only for now)", tpl: "python-service", run: dir => `python -m unittest discover -s ${dir.dir}/tests\nPORT=${dir.port} python ${dir.dir}/server.py` },
  go: { name: "Go 1.23 or newer (not compiled yet: Go was not installed when this was scaffolded)", tpl: "go-service", run: dir => `cd ${dir.dir} && go test ./...\ncd ${dir.dir} && PORT=${dir.port} go run .` },
};

function walk(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function fill(text, vars) {
  return Object.entries(vars).reduce((t, [k, v]) => t.split(`__${k}__`).join(v), text);
}

function put(file, text, log) {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text.replace(/\r\n/g, "\n"));
  log.push(relative(root, file).replace(/\\/g, "/"));
}

function copyTemplate(kind, destDir, vars, log) {
  const from = join(templates, kind);
  for (const file of walk(from)) {
    const rel = relative(from, file).replace(/\.tpl$/, "");
    put(join(destDir, rel), fill(readFileSync(file, "utf8"), vars), log);
  }
}

const created = [];

// ---- services ----
for (const s of stack.services) {
  const lang = LANGS[s.lang];
  const vars = {
    NAME: s.name, SLUG: s.name, TITLE: s.title, DESC: s.desc, PORT: String(s.port), DIR: s.dir,
    PART: s.dir.startsWith("services/features") ? "Feature service (server)" : "Platform service (server)",
    LANG_NAME: lang.name, OWNS: s.owns ? "Yes, its own database schema (`" + s.name.replace(/-/g, "_") + "`)" : "No",
    RUN: lang.run({ ...s, slug: s.name }),
    DATA: s.owns
      ? "This service owns its own PostgreSQL schema and its own database login. Migrations live in `migrations/` and only this service applies them. No other service may read or write these tables."
      : "This service keeps no data of its own.",
  };
  const dest = join(root, s.dir);
  copyTemplate(lang.tpl, dest, vars, created);
  put(join(dest, "README.md"), fill(readFileSync(join(templates, "common", "README.md.tpl"), "utf8"), vars), created);
  put(join(dest, "openapi.yaml"), fill(readFileSync(join(templates, "common", "openapi.yaml.tpl"), "utf8"), vars), created);
  if (s.owns) {
    put(join(dest, "migrations", "README.md"), `# Migrations\n\nSQL migrations for the \`${s.name.replace(/-/g, "_")}\` schema, numbered \`0001_name.sql\`, \`0002_name.sql\`. Only the ${s.title.toLowerCase()} applies them.\n`, created);
  }
}

// ---- desktop modules ----
for (const m of stack.desktopModules) {
  const dir = `desktop/backend/features/${m.name}`;
  const vars = {
    NAME: m.name, SLUG: m.name, TITLE: m.title, DESC: m.desc, PORT: "", DIR: dir, PART: "Desktop backend module (runs on the person's computer)",
    LANG_NAME: "Rust (a library crate the container links in)", OWNS: "No (it reads and writes the local workspace through the desktop backend)",
    RUN: `cargo test -p callerwhale-desktop-${m.name}`,
    DATA: "A desktop module uses the person's local workspace and files only. It must work with no connection.",
  };
  const dest = join(root, dir);
  copyTemplate("rust-module", dest, vars, created);
  put(
    join(dest, "README.md"),
    fill(readFileSync(join(templates, "common", "README.md.tpl"), "utf8"), vars)
      .replace(/\| Default port \| .*\n/, "")
      .replace(/- Answer `GET \/healthz`[\s\S]*?\n\n## Data/, "- Never need the server to do its job: opening, checking and exporting must work offline.\n- Keep every function callable from a Tauri command in `desktop/container/rust` and from tests, with no window.\n- Share nothing with the other modules except through the desktop backend crate.\n\n## Data")
      .replace(/- Keep its API in `openapi.yaml`.*\n- Talk to other services[\s\S]*?\n- Verify the signed-in person[^\n]*\n/, ""),
    created,
  );
}

// ---- the Cargo workspace: every Rust crate, with the existing standalone crates left out ----
const rustCrates = [
  ...stack.services.filter(s => s.lang === "rust").map(s => s.dir),
  ...stack.desktopModules.map(m => `desktop/backend/features/${m.name}`),
];
put(
  join(root, "Cargo.toml"),
  `# One workspace, one lock file and one \`cargo test --workspace\` for the new Rust crates (see docs/plans/service-architecture.md).
# The desktop container (Tauri) and services/core-api/rust keep their own lock files: the container pulls in a large dependency tree.
[workspace]
resolver = "2"
members = [
${rustCrates.map(c => `  "${c}",`).join("\n")}
]
exclude = ["desktop/container/rust", "services/core-api/rust"]
`,
  created,
);

// ---- the service registry ----
const rows = stack.services.map(s => `| ${s.name} | \`${s.dir}/\` | ${LANGS[s.lang].name.split(" (")[0]} | ${s.port} | ${s.owns ? "yes" : "no"} | ${s.desc} |`).join("\n");
put(
  join(root, "services", "README.md"),
  `# Services

The server side of Caller Whale CRM: one folder per service, each with its own code, tests, \`openapi.yaml\`, \`Dockerfile\` and (when it owns data) \`migrations/\`. See [the plan](../docs/plans/service-architecture.md) for why, and [the registry](../contracts/services.md) for ports and events.

| Service | Folder | Language | Port | Owns data | Job |
| --- | --- | --- | --- | --- | --- |
${rows}

Everything is a scaffold today: each service starts, answers \`/healthz\` and \`/version\`, and has tests. The existing server code in \`backend/\` (Rust API, Go worker, Python worker) is not moved yet; it becomes the \`crm\` service and the \`notifications\` and \`importing-lists\` services in later steps.

## Add a service

1. Add it to \`tools/stack.json\`.
2. Run \`node tools/scaffold-stack.mjs\` (it never overwrites existing files).
3. Run \`node tools/check-stack.mjs\`.

## The rules

1. A service owns its data: its own schema and login. No other service touches it.
2. Services talk through the gateway or events, never through each other's tables.
3. Auth is verified from public keys, not called on every request.
4. A service asks for a notification by publishing \`notification.requested\`. It never contacts Twilio, a mail server or a push service itself.
`,
  created,
);

put(
  join(root, "contracts", "services.md"),
  `# Service registry

| Service | Port | Language | Owns schema |
| --- | --- | --- | --- |
${stack.services.map(s => `| ${s.name} | ${s.port} | ${s.lang} | ${s.owns ? s.name.replace(/-/g, "_") : "none"} |`).join("\n")}

The gateway (8100) is the only public port. It routes \`/api/v1/<service>/*\` to the service of that name, after checking the token with the auth service's public keys.
`,
  created,
);

put(
  join(root, "contracts", "events.md"),
  `# Events

Services announce what happened on the event bus (Redis Streams to start). An event is a past-tense fact with a stable name, a version and the ids of the things it is about. It never carries a password, a token or a whole record.

| Event | Published by | Read by | Meaning |
| --- | --- | --- | --- |
| \`user.signed_up\` | auth | notifications, billing | A new account exists. Carries the user id and organization id |
| \`user.signed_in\` | auth | (audit) | A person signed in. Carries the user id and the device |
| \`subscription.changed\` | billing | every feature service | A plan's entitlements changed. Carries the subscription id and the new entitlements version |
| \`payment.failed\` | billing | notifications | A payment did not go through. Carries the subscription id |
| \`notification.requested\` | any service | notifications | Someone must be told something. Carries the user id, a template name and its data |
| \`import.completed\` | importing-lists | crm, notifications | A list finished importing. Carries the list id and the counts |
| \`skiptrace.completed\` | skip-tracing | crm, notifications | A check finished. Carries the list id and the counts |
| \`call.completed\` | dialer-sms | crm, skip-tracing | A call ended. Carries the lead id, outcome and duration |
| \`message.received\` | dialer-sms, ai-campaigns | crm | A text or email reply arrived |
| \`lead.changed\` | crm | exports, ai-campaigns, backup-restore | A lead was created, changed or removed |
| \`export.ready\` | exports | notifications | A file is ready to download |
| \`workspace.restored\` | backup-restore | crm, notifications | A workspace was restored to an earlier moment |

Rules: events are append-only; consumers must be safe to run twice (an event can be delivered again); and a breaking change makes a new event name or version, never a silent change.
`,
  created,
);

// ---- docker compose: every service, plus Postgres and Redis ----
const composeServices = stack.services
  .map(s => {
    const rust = s.lang === "rust";
    const build = rust ? `      context: ..\n      dockerfile: ${s.dir}/Dockerfile` : `      context: ../${s.dir}`;
    const upstreams = s.name === "gateway" ? `\n    environment:\n      PORT: "${s.port}"\n      UPSTREAMS: "${stack.services.filter(x => x.name !== "gateway").map(x => `${x.name}=http://${x.name}:${x.port}`).join(",")}"` : `\n    environment:\n      PORT: "${s.port}"`;
    const ports = s.name === "gateway" ? `\n    ports:\n      - "${s.port}:${s.port}"` : "";
    return `  ${s.name}:\n    build:\n${build}${upstreams}${ports}\n    restart: unless-stopped`;
  })
  .join("\n");
put(
  join(root, "deploy", "compose.yml"),
  `# Every service on one machine (decision 1 of docs/plans/service-architecture.md). Only the gateway is published.
# Build from the repository folder "Caller Whale CRM":  docker compose --env-file env/compose.env -f deploy/compose.yml up --build
# The secrets come from env/compose.env (node tools/env-init.mjs creates it; env/README.md).
name: callerwhale
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in env/compose.env}"
    volumes:
      - postgres-data:/var/lib/postgresql/data
  redis:
    image: redis:7
${composeServices}
volumes:
  postgres-data:
`,
  created,
);

put(
  join(root, "deploy", "README.md"),
  `# Deploy

\`compose.yml\` runs every service, Postgres and Redis on one machine. Only the gateway (port 8100) is published. It was written before Docker was available on the machine that scaffolded it, so it has **not been run yet**: treat the first \`docker compose up --build\` as its test.

Per-service environment variables go in \`.env\` files that are never committed (\`*.local\` and \`.env\` are ignored). Each service's README lists what it needs.
`,
  created,
);

console.log(`Created ${created.length} files.`);
for (const f of created) console.log("  " + f);
