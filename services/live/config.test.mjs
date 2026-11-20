// Run: node --test services/live
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(resolve(here, "config.json"), "utf8"));
const docker = readFileSync(resolve(here, "Dockerfile"), "utf8");

test("secrets and addresses are never in the file (they stay in Coolify)", () => {
  const text = JSON.stringify(config).toLowerCase();
  for (const word of ["secret", "api_key", "key", "password", "address", "redis://", "rediss://", "allowed_origins", "token"]) assert.ok(!text.includes(word), word);
});

test("chat channels are only for the person they are named after", () => {
  const chat = config.channel.namespaces.find((n) => n.name === "chat");
  assert.equal(chat.allow_user_limited_channels, true);
  for (const unsafe of ["allow_subscribe_for_client", "allow_publish_for_client", "allow_presence_for_client", "allow_history_for_client"]) {
    assert.ok(!chat[unsafe], `${unsafe} must stay off`);
  }
});

test("one person cannot hold unlimited sockets", () => {
  assert.ok(config.client.user_connection_limit >= 1 && config.client.user_connection_limit <= 20);
  assert.ok(config.client.connection_limit >= 100);
});

test("health is on (Coolify's check) and the API is not left open", () => {
  assert.equal(config.health.enabled, true);
  assert.ok(!config.http_api || !config.http_api.insecure);
  assert.ok(!config.admin);
});

test("the Redis link is encrypted; Coolify's own certificate authority is not trusted here, so the name check is skipped", () => {
  const tls = config.engine.redis.tls;
  assert.equal(tls.enabled, true);
  assert.equal(tls.insecure_skip_verify, true);
});

test("the container uses the shared log table and pins the Centrifugo version", () => {
  assert.match(docker, /FROM centrifugo\/centrifugo:v6\.\d+\.\d+/);
  assert.match(docker, /ENTRYPOINT \["\/usr\/local\/bin\/callerwhale-log","centrifugo"/);
  assert.match(docker, /--config=\/centrifugo\/config\.json/);
});
