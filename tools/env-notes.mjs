#!/usr/bin/env node
// Reads versioned notes and key-only inventories; never reads runtime env files.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(await readFile(path.join(root, 'env/container-notes.json'), 'utf8'));
const examples = {
  'auth.production.example': 'auth',
  'gateway.production.example': 'gateway',
  'landing-web.production.example': 'landing-web',
  'notifications.production.example': 'notifications',
  'authz.production.example': 'authz',
  'billing.production.example': 'billing',
  'mcp.production.example': 'mcp',
  'crm-core.production.example': 'crm-core',
  'crm-merge.production.example': 'crm-merge',
  'crm-outbox.production.example': 'crm-outbox',
  'assistant.production.example': 'assistant',
  'learning.production.example': 'learning',
  'importing-lists.production.example': 'importing-lists',
  'importing-worker.production.example': 'importing-worker',
  'dialer-sms.production.example': 'dialer-sms',
  'telnyx-phone-api.production.example': 'telnyx-phone-api',
  'telnyx-phone-webhooks.production.example': 'telnyx-phone-webhooks',
  'telnyx-phone-jobs.production.example': 'telnyx-phone-jobs',
  'telnyx-sms-api.production.example': 'telnyx-sms-api',
  'telnyx-sms-webhooks.production.example': 'telnyx-sms-webhooks',
  'telnyx-sms-jobs.production.example': 'telnyx-sms-jobs',
  'messaging.production.example': 'messaging',
  'centrifugo.production.example': 'live',
  // Pointer-only example; actual monitoring settings are in deploy/monitoring.
  'grafana.production.example': 'callerwhale-monitoring',
};
const [command = 'check', resource] = process.argv.slice(2);
if (command === 'render') {
  const entry = catalog.resources[resource];
  if (!entry) throw new Error('Usage: node tools/env-notes.mjs render <catalog-resource>');
  console.log(`# ${resource}: ${entry.description}`);
  console.log('# Reference template only. DO NOT bulk-paste placeholders over live values.');
  for (const [key, comment] of Object.entries(entry.variables)) {
    console.log(`# ${comment}\n${key}=<set-in-coolify>`);
  }
} else if (command === 'check') {
  const errors = [];
  let checked = 0;
  if (catalog.schemaVersion !== 1) errors.push('Unsupported catalog schemaVersion');
  for (const [name, entry] of Object.entries(catalog.resources)) {
    if (!entry.description || !entry.variables || typeof entry.variables !== 'object') errors.push(`${name}: missing purpose or variables object`);
    for (const [key, comment] of Object.entries(entry.variables ?? {})) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) errors.push(`${name}: invalid key ${key}`);
      if (typeof comment !== 'string' || !comment.trim() || comment.length > 240 || /[\r\n]/.test(comment)) errors.push(`${name}/${key}: comment must be one line, 1–240 characters`);
    }
  }
  for (const filename of await readdir(path.join(root, 'env'))) {
    if (filename.endsWith('.production.example') && !examples[filename]) errors.push(`${filename}: missing resource mapping`);
  }
  async function checkFile(filename, name, matcher) {
    const lines = (await readFile(path.join(root, filename), 'utf8')).split(/\r?\n/);
    let inEnvironment = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (matcher === 'compose') {
        if (line === '    environment:') inEnvironment = true;
        else if (inEnvironment && line.trim() && !line.startsWith('      ') && !line.trimStart().startsWith('#')) inEnvironment = false;
        if (!inEnvironment) continue;
      }
      const match = (matcher === 'compose' ? /^      ([A-Z][A-Z0-9_]*):/ : /^([A-Z][A-Z0-9_]*)=/).exec(line);
      if (!match) continue;
      checked++;
      const key = match[1], expected = catalog.resources[name]?.variables[key];
      if (!expected) errors.push(`${filename}:${i + 1}: no catalog note for ${name}/${key}`);
      else if (lines[i - 1]?.trim() !== `# ${expected}`) errors.push(`${filename}:${i + 1}: ${key} needs its catalog comment immediately above it`);
    }
  }
  for (const [file, name] of Object.entries(examples)) await checkFile(`env/${file}`, name);
  await checkFile('deploy/monitoring/.env.example', 'callerwhale-monitoring');
  await checkFile('deploy/monitoring/compose.yml', 'callerwhale-monitoring', 'compose');
  const inventory = JSON.parse(await readFile(path.join(root, 'env/container-variable-inventory.json'), 'utf8'));
  let observed = 0;
  for (const [name, keys] of Object.entries(inventory.resources)) {
    if (!catalog.resources[name]) errors.push(`inventory: no catalog resource ${name}`);
    for (const key of keys) {
      observed++;
      if (!catalog.resources[name]?.variables[key]) errors.push(`inventory: undocumented ${name}/${key}`);
    }
  }
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Environment notes verified: ${Object.keys(catalog.resources).length} resources, ${observed} observed keys, ${checked} annotated declarations. No runtime values read.`);
} else {
  throw new Error('Usage: node tools/env-notes.mjs [check | render <catalog-resource>]');
}
