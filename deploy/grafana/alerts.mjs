#!/usr/bin/env node
// Writes grafana/provisioning/alerting/alerts.yml: Grafana's alert rules, where alerts go and when routine ones wait (build step 42,
// D300-D302). Edit the lists here, run `node deploy/grafana/alerts.mjs`, push, and redeploy the monitoring resource.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Every request line the services log, split into its parts (the same pattern as the Service traffic dashboard).
const requests = '{container=~".+"} |= "HTTP request" | regexp `\\|\\s*\\[(?P<result>[A-Z]+)\\]\\s*\\|\\s*(?P<service>[^|]+?)\\s*\\|\\s*HTTP request\\s*\\|\\s*(?P<method>[A-Z]+)\\s*\\|\\s*(?P<status>\\d+)\\s*\\|\\s*(?P<seconds>[0-9.]+) s\\s*\\|\\s*(?P<path>\\S*)`';
const failures = (filter, window) => `sum(count_over_time(${requests} | ${filter} | status=~"5.." [${window}])) or vector(0)`;
const slow = (filter) => `max(quantile_over_time(0.75, ${requests} | ${filter} | unwrap seconds [15m]))`;
const probe = names => `min by (instance) (probe_success{job="services", instance=~".*//(${names}):.*"})`;

export const rules = [
  // Urgent: calls, texts or sign-in down wake whoever is on call (D301).
  { uid: "core-down", title: "A service calls, texts or sign-in need is down", severity: "urgent", ds: "prometheus", expr: probe("gateway|auth|crm-core|dialer-sms"), op: "lt", value: 1, for: "2m", summary: "{{ $labels.instance }} is not answering" },
  { uid: "public-down", title: "The website or sign-in address is down", severity: "urgent", ds: "prometheus", expr: 'min by (instance) (probe_success{job="public"})', op: "lt", value: 1, for: "3m", summary: "{{ $labels.instance }} is not reachable from outside" },
  { uid: "sign-in-failing", title: "Sign-in is failing", severity: "urgent", ds: "loki", expr: failures('service="Auth" | path=~"/v1/sessions.*|/v1/oauth.*|/v1/token.*"', "5m"), op: "gt", value: 5, for: "0s", summary: "Sign-in answered with server errors more than 5 times in 5 minutes" },
  { uid: "calls-failing", title: "Calls are failing", severity: "urgent", ds: "loki", expr: failures('service="Dialer SMS" | path=~"/api/v1/calls.*|/webhooks/telnyx"', "5m"), op: "gt", value: 3, for: "0s", summary: "Calls answered with server errors more than 3 times in 5 minutes" },
  { uid: "texts-failing", title: "Texts are failing", severity: "urgent", ds: "loki", expr: failures('service="Dialer SMS" | path=~"/api/v1/sms.*"', "5m"), op: "gt", value: 3, for: "0s", summary: "Texts answered with server errors more than 3 times in 5 minutes" },
  // Routine: everything else waits for the morning.
  { uid: "service-down", title: "A service is down", severity: "routine", ds: "prometheus", expr: probe("authz|billing|notifications|messaging|assistant|grafana-proxy|alert-relay"), op: "lt", value: 1, for: "5m", summary: "{{ $labels.instance }} is not answering" },
  { uid: "chats-failing", title: "Chats are failing", severity: "routine", ds: "loki", expr: failures('service="Messaging"', "10m"), op: "gt", value: 5, for: "0s", summary: "Chats answered with server errors more than 5 times in 10 minutes" },
  { uid: "server-errors", title: "Many server errors", severity: "routine", ds: "loki", expr: failures('status!=""', "10m"), op: "gt", value: 50, for: "0s", summary: "More than 50 server errors across the services in 10 minutes" },
  { uid: "disk-full", title: "Disk almost full", severity: "routine", ds: "prometheus", expr: 'max by (mountpoint) (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"})', op: "gt", value: 0.85, for: "10m", summary: "{{ $labels.mountpoint }} is more than 85% full" },
  { uid: "memory-full", title: "Memory almost full", severity: "routine", ds: "prometheus", expr: "1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes", op: "gt", value: 0.9, for: "10m", summary: "The server's memory is more than 90% used" },
  { uid: "certificate", title: "A certificate expires soon", severity: "routine", ds: "prometheus", expr: "min by (instance) (probe_ssl_earliest_cert_expiry - time()) / 86400", op: "lt", value: 14, for: "1h", summary: "{{ $labels.instance }}'s certificate expires in under 14 days" },
  // The speed targets (D302): opening a lead or list within a second, saving an outcome or sending a text within half a second, for
  // most people (three requests in four).
  { uid: "slow-open", title: "Opening leads or lists is slow", severity: "routine", ds: "loki", expr: slow('service="CRM core" | method="GET" | path=~"/api/v1/leads/[^/]+|/sync/snapshot.*|/api/v1/projects/.*"'), op: "gt", value: 1, for: "15m", summary: "Opening a lead or a list takes more than a second for one person in four" },
  { uid: "slow-save", title: "Saving outcomes is slow", severity: "routine", ds: "loki", expr: slow('service="CRM core" | method="POST" | path="/api/v1/ops"'), op: "gt", value: 0.5, for: "15m", summary: "Saving a change takes more than half a second for one person in four" },
  { uid: "slow-text", title: "Sending texts or call outcomes is slow", severity: "routine", ds: "loki", expr: slow('service="Dialer SMS" | method="POST" | path=~"/api/v1/sms|/api/v1/calls/[^/]+/disposition"'), op: "gt", value: 0.5, for: "15m", summary: "Sending a text or a call's outcome takes more than half a second for one person in four" },
  // Errors in the web apps (D303): many at once means a broken release.
  { uid: "web-errors", title: "The web app is erroring", severity: "routine", ds: "loki", expr: 'sum(count_over_time({container=~".+"} |= "client_error" [15m])) or vector(0)', op: "gt", value: 30, for: "0s", summary: "More than 30 errors from people's browsers in 15 minutes" },
];

// A YAML double-quoted string is a JSON string. Grafana expands $NAME in provisioning files from its settings, so a literal $ (as in
// {{ $labels.instance }}) is written $.
const q = s => JSON.stringify(s).replaceAll("$", () => "$$");

export function render() {
  const out = [
    "# Written by deploy/grafana/alerts.mjs (build step 42). Do not edit by hand: change that file and run it.",
    "apiVersion: 1",
    "contactPoints:",
    "  - orgId: 1",
    "    name: urgent-on-call",
    "    receivers:",
    "      - uid: urgent-on-call",
    "        type: webhook",
    "        settings:",
    "          url: http://alert-relay:8121/alerts?level=urgent",
    "          httpMethod: POST",
    "          authorization_scheme: Bearer",
    "          authorization_credentials: $RELAY_TOKEN",
    "  - orgId: 1",
    "    name: routine-everyone",
    "    receivers:",
    "      - uid: routine-everyone",
    "        type: webhook",
    "        settings:",
    "          url: http://alert-relay:8121/alerts?level=routine",
    "          httpMethod: POST",
    "          authorization_scheme: Bearer",
    "          authorization_credentials: $RELAY_TOKEN",
    "muteTimes:",
    "  - orgId: 1",
    "    name: night",
    "    time_intervals:",
    "      - times:",
    '          - start_time: "22:00"',
    '            end_time: "24:00"',
    '          - start_time: "00:00"',
    '            end_time: "07:00"',
    "        location: Europe/Paris",
    "policies:",
    "  - orgId: 1",
    "    receiver: routine-everyone",
    "    group_by: [alertname]",
    "    group_wait: 30s",
    "    group_interval: 5m",
    "    repeat_interval: 4h",
    "    routes:",
    "      - receiver: urgent-on-call",
    '        object_matchers: [["severity", "=", "urgent"]]',
    "        group_wait: 10s",
    "        repeat_interval: 30m",
    "      - receiver: routine-everyone",
    '        object_matchers: [["severity", "=", "routine"]]',
    "        mute_time_intervals: [night]",
    "groups:",
  ];
  for (const severity of ["urgent", "routine"]) {
    out.push("  - orgId: 1", `    name: ${severity}`, "    folder: Caller Whale alerts", "    interval: 1m", "    rules:");
    for (const r of rules.filter(rule => rule.severity === severity)) {
      out.push(
        `      - uid: ${r.uid}`,
        `        title: ${q(r.title)}`,
        "        condition: C",
        "        data:",
        "          - refId: A",
        `            relativeTimeRange: { from: ${r.ds === "loki" ? 900 : 300}, to: 0 }`,
        `            datasourceUid: ${r.ds}`,
        "            model:",
        "              refId: A",
        `              expr: ${q(r.expr)}`,
        r.ds === "loki" ? "              queryType: instant" : "              instant: true",
        "          - refId: B",
        "            datasourceUid: __expr__",
        "            model: { refId: B, type: reduce, expression: A, reducer: last }",
        "          - refId: C",
        "            datasourceUid: __expr__",
        `            model: { refId: C, type: threshold, expression: B, conditions: [{ evaluator: { type: ${r.op}, params: [${r.value}] } }] }`,
        "        noDataState: OK",
        "        execErrState: Error",
        `        for: ${r.for}`,
        `        labels: { severity: ${severity} }`,
        `        annotations: { summary: ${q(r.summary)} }`,
      );
    }
  }
  return out.join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(new URL("./grafana/provisioning/alerting/alerts.yml", import.meta.url), render());
  console.log(`Wrote ${rules.length} alert rules.`);
}
