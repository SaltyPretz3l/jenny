'use strict';

// Cross-language contract: every top-level key Electron's managed config
// emits (buildManagedSidecarConfig) must be consumed by the sidecar's config
// parser. There is no shared schema between the two runtimes, so this test
// reads sidecar/ai/config.py as TEXT and collects the names it reads through
// raw_config.get("...") / raw_config["..."]. Scanning production source is the
// deliberate exception here: it is the only way to check a Python reader from
// the Node lane. Keys consumed outside config.py are allowlisted below with
// the file that reads them, and each allowlist entry is itself verified.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { DEFAULT_MANAGED_SHELL_MODEL } = require('../services/backend/backend-config');
const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-lifecycle');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_PARSER = 'sidecar/ai/config.py';

// Emitted keys read by a sidecar module other than config.py's raw_config reads.
const CONSUMED_ELSEWHERE = Object.freeze({
  // parse_runtime_config calls desktop_policy_from_config(raw_config), which
  // reads DESKTOP_EXECUTION_POLICY_KEY = "desktop_execution_policy_version".
  desktop_execution_policy_version: 'sidecar/ai/execution_policy.py',
});

// Emitted but no longer read by the sidecar: listed in config.py's
// _RETIRED_TOP_LEVEL_KEYS only so older payloads load without the unknown-key
// WARN. Electron still sends it (managed-sidecar-config.js); drop the entry
// here once Electron stops emitting it.
const RETIRED_BUT_EMITTED = Object.freeze(['tools_subagent_batch_enabled']);

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function emittedManagedConfigKeys() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-config-parity-'));
  trackDirectory(userDataPath);
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });
  return Object.keys(buildManagedSidecarConfig(service)).sort();
}

function configParserReadKeys() {
  const source = readRepoFile(CONFIG_PARSER);
  return new Set([...source.matchAll(/raw_config(?:\.get\(|\[)\s*"([^"]+)"/g)].map((match) => match[1]));
}

test('every managed sidecar config key is consumed by the sidecar', () => {
  const emitted = emittedManagedConfigKeys();
  const read = configParserReadKeys();
  assert.ok(emitted.length > 50, `expected the full managed config, got ${emitted.length} keys`);
  const unread = emitted.filter((key) => !read.has(key)
    && !Object.hasOwn(CONSUMED_ELSEWHERE, key)
    && !RETIRED_BUT_EMITTED.includes(key));
  assert.deepEqual(unread, [], `emitted but never read by ${CONFIG_PARSER}`);
});

test('the parity allowlists stay true', () => {
  const emitted = new Set(emittedManagedConfigKeys());
  const read = configParserReadKeys();
  for (const [key, reader] of Object.entries(CONSUMED_ELSEWHERE)) {
    assert.equal(emitted.has(key), true, `${key} is no longer emitted; drop it from the allowlist`);
    assert.equal(read.has(key), false, `${key} is read by ${CONFIG_PARSER}; drop it from the allowlist`);
    assert.match(readRepoFile(reader), new RegExp(`"${key}"`), `${reader} must name ${key}`);
  }
  const retiredLine = readRepoFile(CONFIG_PARSER)
    .split('\n')
    .find((line) => line.startsWith('_RETIRED_TOP_LEVEL_KEYS'));
  for (const key of RETIRED_BUT_EMITTED) {
    assert.equal(emitted.has(key), true, `${key} is no longer emitted; drop it from the allowlist`);
    assert.match(retiredLine || '', new RegExp(`"${key}"`), `${key} must stay in _RETIRED_TOP_LEVEL_KEYS`);
  }
});
