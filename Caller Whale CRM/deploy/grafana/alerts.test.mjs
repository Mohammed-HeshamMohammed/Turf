import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { render, rules } from "./alerts.mjs";

test("the provisioning file is the one alerts.mjs writes", () => {
  assert.equal(readFileSync(new URL("./grafana/provisioning/alerting/alerts.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n"), render());
});

test("calls, texts and sign-in are urgent; the speed targets are watched (D301, D302)", () => {
  const urgent = rules.filter(rule => rule.severity === "urgent").map(rule => rule.uid);
  for (const uid of ["core-down", "sign-in-failing", "calls-failing", "texts-failing"]) assert.ok(urgent.includes(uid), uid);
  for (const uid of ["slow-open", "slow-save", "slow-text", "chats-failing", "web-errors"]) assert.ok(rules.some(rule => rule.uid === uid && rule.severity === "routine"), uid);
  assert.equal(new Set(rules.map(rule => rule.uid)).size, rules.length);
});

test("only the relay's token is expanded by Grafana; every other $ is literal", () => {
  const text = render();
  const singles = text.replace(/\$\$/g, "").match(/\$[A-Za-z_{]+/g);
  assert.deepEqual([...new Set(singles)], ["$RELAY_TOKEN"]);
  assert.ok(text.includes("{{ $$labels.instance }}"));
});
