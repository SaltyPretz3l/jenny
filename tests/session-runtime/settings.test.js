'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ShellConfigService } = require('../../services/shell-config-service');
const { normalizeState, serializeState } = require('../../services/shell-config-state');
const { DEFAULT_SESSION_RUNTIME, applySessionRuntimePatch } = require('../../services/shell-config-session-runtime');

function profile(t, document) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-settings-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const file = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(file, JSON.stringify(document));
  return { file, service: new ShellConfigService({ userDataPath, env: {} }) };
}

test('v53 migration preserves sandbox and global preferences with independent local/cloud defaults', () => {
  const state = normalizeState({ version: 53, commandSandbox: { enabled: true }, uiLanguage: 'ja' });
  assert.equal(state.version, 55);
  assert.deepEqual(state.sessionRuntime, DEFAULT_SESSION_RUNTIME);
  assert.equal(state.commandSandbox.enabled, true);
  assert.equal(state.uiLanguage, 'ja');
  const serialized = serializeState(state);
  assert.deepEqual(serialized.session_runtime, DEFAULT_SESSION_RUNTIME);
  assert.equal(Object.hasOwn(serialized, 'sessionRuntime'), false);
  assert.deepEqual(normalizeState(serialized).sessionRuntime, state.sessionRuntime);
});

test('limits update only the requested group and cannot change downstream sandbox capacity', t => {
  const { service, file } = profile(t, { version: 53, commandSandbox: { enabled: true } });
  const result = service.updateSessionRuntime({ cloud: { runnable_turns: 3 }, local: { descendants: 0 } });
  assert.equal(result.cloud.runnable_turns, 3);
  assert.equal(result.cloud.inference_requests, 4);
  assert.equal(result.local.runnable_turns, 1);
  assert.equal(result.local.descendants, 0);
  const before = fs.readFileSync(file, 'utf8');
  for (const patch of [{ resources: { sandbox_commands: 2 } }, { local: { runnable_turns: '2' } },
    { cloud: { runnable_turns: 0 } }, { local: { descendant_depth: 99 } }, { unexpected: {} }]) {
    assert.throws(() => service.updateSessionRuntime(patch), /settings_invalid/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  result.cloud.runnable_turns = 12;
  assert.equal(service.getState().sessionRuntime.cloud.runnable_turns, 3);
  assert.equal(JSON.parse(before).commandSandbox.enabled, true);
});

test('future shell config is preserved and refuses runtime preference writes', t => {
  const document = { version: 56, authored_future_data: { keep: 'exact bytes' } };
  const { service, file } = profile(t, document);
  assert.throws(() => service.updateSessionRuntime({ local: { runnable_turns: 2 } }), /write_failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(document));
});

test('malformed on-disk limits use bounded defaults and patches do not mutate their inputs', () => {
  const state = normalizeState({ version: 54, session_runtime: { cloud: { inference_requests: Infinity } } });
  assert.deepEqual(state.sessionRuntime, DEFAULT_SESSION_RUNTIME);
  const next = applySessionRuntimePatch(DEFAULT_SESSION_RUNTIME, { cloud: { descendant_depth: 2 } });
  assert.equal(next.cloud.descendant_depth, 2);
  assert.equal(DEFAULT_SESSION_RUNTIME.cloud.descendant_depth, 3);
});
