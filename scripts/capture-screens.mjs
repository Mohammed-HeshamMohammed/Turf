// Captures the CRM's screens for the landing site through Chrome's DevTools protocol (Node 22+, Chrome installed).
// Start the CRM first (npm run dev in desktop/frontend/react), then:
//   node scripts/capture-screens.mjs http://localhost:5190 shots [name ...]
// Convert the PNGs to WebP (quality 82) and copy them to public/screens/.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const [base, out, ...only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const chrome = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--remote-debugging-port=9333",
  "--user-data-dir=" + out + "/.profile", "about:blank",
], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let targets;
for (let i = 0; i < 40; i++) {
  try { targets = await (await fetch("http://127.0.0.1:9333/json")).json(); break; } catch { await sleep(250); }
}
const ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const js = async expression => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

const clickText = text => `(() => { const b = [...document.querySelectorAll('button,[role=tab],a')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (b) b.click(); return !!b; })()`;

const shots = [
  { name: "dashboard", hash: "dashboard" },
  { name: "leads", hash: "leads" },
  { name: "map", hash: "leads", run: [clickText("Map"), "document.querySelector('.leaflet-container') && 1"], wait: 9000 },
  { name: "board", hash: "leads", run: [clickText("Board")] },
  { name: "calls", hash: "calls" },
  { name: "calllog", hash: "calls", run: [clickText("Call log")] },
  { name: "deals", hash: "deals" },
  { name: "inbox", hash: "inbox" },
  { name: "tasks", hash: "tasks" },
  { name: "calendar", hash: "calendar" },
  { name: "handoffs", hash: "handoffs" },
  { name: "lists", hash: "lists", role: "owner" },
  { name: "skip", hash: "skip", role: "owner" },
  { name: "reports", hash: "reports", role: "owner" },
  { name: "team", hash: "team", role: "owner" },
  { name: "call-live", hash: "calls", run: [clickText("Start demo call")], wait: 6500 },
  { name: "mobile-dashboard", hash: "dashboard", mobile: true },
  { name: "mobile-leads", hash: "leads", mobile: true },
];

await cdp("Page.enable");
for (const s of shots.filter(x => !only.length || only.includes(x.name))) {
  await cdp("Emulation.setDeviceMetricsOverride", s.mobile
    ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
    : { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  if (s.role) {
    await cdp("Page.navigate", { url: `${base}/favicon.svg` });
    await sleep(800);
    await js(`(async () => { try { const m = await import("/src/model.js"); const st = m.loadState({ getItem: () => null }); st.role = "${s.role}"; localStorage.setItem("callerwhale.full-crm.prototype.v1", JSON.stringify(st)); for (const d of await indexedDB.databases()) indexedDB.deleteDatabase(d.name); } catch (e) { return String(e); } })()`);
    await sleep(800);
  }
  await cdp("Page.navigate", { url: `${base}/#/${s.hash}` });
  await sleep(2500);
  await js("location.reload()").catch(() => {});
  await sleep(3000);
  for (const r of s.run || []) { await js(r); await sleep(s.wait || 1200); }
  const shot = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}/${s.name}.png`, Buffer.from(shot.result.data, "base64"));
  console.log("saved", s.name);
}
ws.close();
chrome.kill();
