'use strict';

// Row 86 S3: `away_digest` is a read-only, primary-only, default-off read over the digest port
// (`backendService.primaryDigestPresence.factsSince`). It validates the window, re-checks the caller, and never
// carries exception text; its sidecar flag follows a live feature-flag change.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const tool = require('../services/tools/builtin/away-digest-tool');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { executeElectronToolRequest, ELECTRON_BRIDGE_TOOL_NAMES } = require('../services/backend/electron-tool-bridge');
const { NEVER_PERSIST_ALWAYS_ALLOW } = require('../services/tools/tool-permission-migrations');
const { TOOL_NETWORK_CLASSIFICATION } = require('../services/backend/session-lockdown-gate');
const { surfaceFamilyForTool, ALWAYS_ON_TOOL_NAMES } = require('../services/tools/tool-surface-families');
const { DIGEST_TURN_TOOLS } = require('../services/backend/application-turns');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');
const { createManagedServiceWithConfig } = require('./helpers/managed-sidecar-runtime-helpers');

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const PERMISSIONS = { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) };

test.beforeEach((t) => t.mock.timers.enable({ apis: ['Date'], now: NOW }));
test.afterEach(async () => { await cleanupTrackedResources(); });

function harness({ flags = { primary_digests: true }, primaryId = 'jenny', caller = 'jenny', digest = null, factsSince } = {}) {
  const calls = [];
  const port = factsSince === null ? undefined : {
    factsSince: factsSince || (async (window) => {
      calls.push(window);
      return { ok: true, since: window.since, until: window.until, items: [{ kind: 'work_completed', at: window.until, title: 'Docs' }],
        truncated: false, counts: { work_completed: 1 }, extra: 'dropped' };
    }),
  };
  const backendService = {
    featureFlags: flags,
    primaryDigestPresence: port,
    primaryChatControls: { primarySessionId: () => primaryId, getDigest: () => digest },
  };
  return { context: { sessionId: caller, backendService }, calls };
}

const output = (result) => JSON.parse(result.content);
const run = async (input, options) => {
  const h = harness(options);
  return { answer: output(await tool.execute(input, h.context)), calls: h.calls };
};

test('the flag is default off and either switch refuses before the port', async () => {
  for (const flags of [{}, { primary_digests: false }, { primary_digests: 'true' }, { primary_digests: true, primary_chat: false }]) {
    const { answer, calls } = await run({}, { flags });
    assert.deepEqual(answer, { ok: false, reason: 'disabled' }, JSON.stringify(flags));
    assert.deepEqual(calls, []);
  }
  assert.deepEqual((await run({}, { factsSince: null })).answer, { ok: false, reason: 'disabled' });
});

test('malformed input, a future since and a non-ISO instant are invalid_input', async () => {
  for (const input of [null, [], 'x', { extra: 1 }, { since: 7 }, { since: '' }, { since: 'yesterday' }, { since: '2026-11-02' },
    { since: '2026-11-02T08:00:00' }, { since: '2026-13-40T08:00:00Z' }, { since: iso(NOW + 60000) }]) {
    const { answer, calls } = await run(input);
    assert.deepEqual(answer, { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
    assert.deepEqual(calls, []);
  }
});

test('only the primary chat may read the digest, re-checked against primarySessionId', async () => {
  assert.deepEqual((await run({}, { caller: 'other' })).answer, { ok: false, reason: 'not_primary' });
  assert.deepEqual((await run({}, { primaryId: null })).answer, { ok: false, reason: 'not_primary' });
  assert.deepEqual((await run({}, { caller: '' })).answer, { ok: false, reason: 'not_primary' });
  const h = harness();
  h.context.backendService.primaryChatControls.primarySessionId = () => { throw new Error('C:/private/path'); };
  assert.deepEqual(output(await tool.execute({}, h.context)), { ok: false, reason: 'unavailable' });
  assert.deepEqual(h.calls, []);
});

test('the window defaults to lastPresentAt, else 24 h back, and is clamped to 30 days', async () => {
  const present = iso(NOW - 3 * HOUR);
  let { answer, calls } = await run({}, { digest: { lastPresentAt: present } });
  assert.deepEqual(calls, [{ since: present, until: iso(NOW) }]);
  assert.deepEqual(answer, { ok: true, since: present, until: iso(NOW),
    items: [{ kind: 'work_completed', at: iso(NOW), title: 'Docs' }], truncated: false, counts: { work_completed: 1 } });

  for (const digest of [null, {}, { lastPresentAt: null }, { lastPresentAt: 'garbage' }, { lastPresentAt: iso(NOW + HOUR) }]) {
    ({ calls } = await run({}, { digest }));
    assert.deepEqual(calls, [{ since: iso(NOW - DAY), until: iso(NOW) }], JSON.stringify(digest));
  }
  ({ calls } = await run({}, { digest: { lastPresentAt: iso(NOW - 90 * DAY) } }));
  assert.deepEqual(calls, [{ since: iso(NOW - 30 * DAY), until: iso(NOW) }]);
  const h = harness();
  h.context.backendService.primaryChatControls.getDigest = () => { throw new Error('boom'); };
  await tool.execute({}, h.context);
  assert.deepEqual(h.calls, [{ since: iso(NOW - DAY), until: iso(NOW) }]);
});

test('an explicit since is normalized, may equal now, and is clamped to 30 days back', async () => {
  let { calls } = await run({ since: '2026-11-02T06:30:00-05:00' }, { digest: { lastPresentAt: iso(NOW - HOUR) } });
  assert.deepEqual(calls, [{ since: '2026-11-02T11:30:00.000Z', until: iso(NOW) }]);
  ({ calls } = await run({ since: iso(NOW) }));
  assert.deepEqual(calls, [{ since: iso(NOW), until: iso(NOW) }]);
  ({ calls } = await run({ since: '2025-01-01T00:00Z' }));
  assert.deepEqual(calls, [{ since: iso(NOW - 30 * DAY), until: iso(NOW) }]);
});

test('a null, refused or throwing port is unavailable, with no exception text', async () => {
  for (const factsSince of [() => null, async () => undefined, async () => ({ ok: false, reason: 'invalid_window' }),
    async () => ({ ok: true, items: 'nope' }), () => { throw new Error('C:/secret/profile'); }, async () => { throw new Error('x'); }]) {
    const result = await tool.execute({}, harness({ factsSince }).context);
    assert.deepEqual(output(result), { ok: false, reason: 'unavailable' });
    assert.equal(result.content.includes('secret'), false);
    assert.equal(result.metadata.status, 'refused');
  }
  const ok = await tool.execute({}, harness().context);
  assert.equal(ok.metadata.status, 'ok');
  assert.equal(ok.metadata.result_kind, 'away_digest');
  assert.equal(tool.summarize({}), 'While you were away: facts');
});

test('the manifest, policy, registry and bridges pin a read-only, primary-only, default-off tool', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'services', 'tools', 'tool-manifest.json'), 'utf8'));
  const entry = manifest.tools.find((item) => item.name === 'away_digest');
  assert.equal(entry.owner, 'electron');
  assert.equal(entry.read_only, true);
  assert.equal(entry.side_effecting, false);
  assert.equal(entry.availability.config_flag, 'tools_primary_digests_enabled');
  assert.equal(entry.availability.workspace_required, false);
  assert.equal(entry.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(entry.parameters.properties), ['since']);
  assert.equal(entry.parameters.required, undefined);
  assert.equal(tool.readOnly, true);
  assert.equal(tool.sideEffecting, false);
  assert.equal(NEVER_PERSIST_ALWAYS_ALLOW.has('away_digest'), false);
  assert.equal(TOOL_NETWORK_CLASSIFICATION.away_digest, 'none');
  assert.equal(ELECTRON_BRIDGE_TOOL_NAMES.has('away_digest'), true);
  assert.equal(surfaceFamilyForTool('away_digest'), 'helpers');
  assert.equal(ALWAYS_ON_TOOL_NAMES.includes('away_digest'), false);
  assert.ok(DIGEST_TURN_TOOLS.includes('away_digest'), 'the digest turn allowlist names this tool');

  assert.equal(createDefaultRegistry({}).getTool('away_digest'), undefined);
  assert.equal(createDefaultRegistry({ toolsPrimaryDigestsEnabled: false }).getTool('away_digest'), undefined);
  const hosted = await executeElectronToolRequest({ hostMode: 'server' }, { params: { tool_name: 'away_digest' } });
  assert.equal(hosted.success, false);
  const tools = new ToolExecutor({ registry: createDefaultRegistry({ toolsPrimaryDigestsEnabled: true }),
    permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {} });
  const registered = tools.registry.getTool('away_digest');
  assert.ok(registered);
  assert.equal(tools._evaluateToolPolicy(registered, {}, {}).decision, 'auto');
  assert.equal(tools._evaluateToolPolicy(registered, {}, { mode: 'plan' }).decision, 'auto');
});

test('tools_primary_digests_enabled is primary_chat !== false && primary_digests === true, follows setFeatureFlags, hosted off', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-away-digest-flag-'));
  trackDirectory(userDataPath);
  const config = { getState() { return {}; } };
  const build = (featureFlags) => createManagedServiceWithConfig(userDataPath, config, { featureFlags })
    ._buildManagedSidecarConfig().tools_primary_digests_enabled;
  assert.equal(build({}), false, 'default off');
  assert.equal(build({ primary_digests: true }), true);
  assert.equal(build({ primary_digests: true, primary_chat: false }), false);
  assert.equal(build({ primary_digests: false }), false);

  // A Settings toggle commits the override, then setFeatureFlags + refreshManagedConfig rebuild this config.
  const service = createManagedServiceWithConfig(userDataPath, config, { featureFlags: {} });
  assert.equal(service._buildManagedSidecarConfig().tools_primary_digests_enabled, false);
  await service.setFeatureFlags({ ...service.featureFlags, primary_digests: true });
  assert.equal(service._buildManagedSidecarConfig().tools_primary_digests_enabled, true);
  await service.setFeatureFlags({ ...service.featureFlags, primary_digests: false });
  assert.equal(service._buildManagedSidecarConfig().tools_primary_digests_enabled, false);

  const hosted = createManagedServiceWithConfig(userDataPath, config, { featureFlags: { primary_digests: true } });
  hosted.hostMode = 'server';
  assert.equal(hosted._buildManagedSidecarConfig().tools_primary_digests_enabled, false);
});
