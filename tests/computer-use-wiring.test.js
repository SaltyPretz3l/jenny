'use strict';
// new-test-file: the computer tool's Electron wiring (row 196 C2): turn gate, approval fields, typed text, holder

const test = require('node:test');
const assert = require('node:assert/strict');

const { computerHidden, withComputerEngineGate, withComputerToolGate } = require('../services/backend/computer-use-tool-gate');
const { computerApprovalFields, savedComputerOutput } = require('../services/backend/computer-use-chat-fields');
const { savedToolOutput } = require('../services/backend/chat-stream-tool-payload-utils');
const { buildPersistedToolInputSnapshot } = require('../services/backend/tool-loop-input-sanitization');
const { inheritedToolCategoryOverrides } = require('../services/backend/spawned-child-tool-switches');
const { requestToolPreferences } = require('../services/backend/backend-service-utils');
const { createLazyComputerUse, readJennyIdentity } = require('../services/main/computer-use-composition');
const { MID_TOOL_CONSENT_TOOLS } = require('../services/tools/mid-tool-consent');

function backend({ flag = true, safetyMode = 'normal', sandbox = false, engine = 'ollama' } = {}) {
  return {
    featureFlags: { tools_computer_use_enabled: flag },
    currentEngineType: engine,
    configService: {
      getChatUiState: () => ({ safetyMode }),
      getState: () => ({ commandSandbox: { enabled: sandbox } }),
    },
  };
}

test('the turn gate hides computer outside normal safety, with the sandbox on, or off this computer', () => {
  assert.equal(computerHidden(backend()), false);
  assert.equal(computerHidden(backend({ flag: false, safetyMode: 'strict' })), false, 'not registered: nothing to hide');
  assert.equal(computerHidden(backend({ safetyMode: 'strict' })), true);
  assert.equal(computerHidden(backend({ safetyMode: 'paranoid' })), true);
  assert.equal(computerHidden(backend({ sandbox: true })), true);
  assert.equal(computerHidden(backend({ engine: 'chatgpt' })), true);
  assert.equal(computerHidden(backend({ engine: 'chatgpt' }), { engine: false }), false, 'the engine is checked after the model resolves');
  const throwing = { featureFlags: { tools_computer_use_enabled: true }, configService: { getState() { throw new Error('x'); }, getChatUiState: () => ({ safetyMode: 'normal' }) } };
  assert.equal(computerHidden(throwing), true, 'an unreadable sandbox state fails closed');
});

test('both passes only add computer to disabled_tools', () => {
  const first = withComputerToolGate(backend({ safetyMode: 'strict' }), { disabled_tools: ['web_search'], enabled_tools: [] });
  assert.deepEqual(first, { disabled_tools: ['computer', 'web_search'], enabled_tools: [] });
  const kept = { disabled_tools: ['web_search'] };
  assert.equal(withComputerToolGate(backend(), kept), kept);
  assert.deepEqual(withComputerEngineGate(backend({ engine: 'chatgpt' }), {}), { disabled_tools: ['computer'] });
  assert.equal(withComputerEngineGate(backend(), kept), kept);
  const digest = { enabled_tools: ['away_digest'] };
  assert.equal(withComputerEngineGate(backend({ engine: 'chatgpt' }), digest), digest, 'a fixed list without it is left alone');
});

test('a computer ask reaches a card only in its exact shape', () => {
  const ask = { schema_version: 1, kind: 'grant', program_name: 'Notepad', program_path: 'C:\\Windows\\notepad.exe', view_only: false };
  const params = (value, tool = 'computer') => ({ tool_name: tool, messageFields: { computer_approval: value } });
  assert.deepEqual(computerApprovalFields(params(ask)), { computer_approval: ask });
  assert.deepEqual(computerApprovalFields(params({ ...ask, extra: 'x' })).computer_approval, ask, 'unknown fields dropped');
  for (const bad of [
    { ...ask, schema_version: 2 }, { ...ask, kind: 'run' }, { ...ask, program_name: '' },
    { ...ask, program_name: 'a\u0007b' }, { ...ask, program_path: 'x'.repeat(513) }, { ...ask, view_only: 'no' },
    { ...ask, kind: 'file_dialog', view_only: true }, null,
  ]) assert.deepEqual(computerApprovalFields(params(bad)), {}, JSON.stringify(bad));
  assert.deepEqual(computerApprovalFields(params(ask, 'browser')), {}, 'another tool never borrows the card');
  assert.ok(MID_TOOL_CONSENT_TOOLS.has('computer'));
});

test('history keeps a computer step as its one line; typed text never reaches stored input', () => {
  assert.equal(savedToolOutput('computer', 'Typed 5 characters.', { step_summary: 'Computer: type Notepad done' }), 'Computer: type Notepad done');
  assert.equal(savedComputerOutput({ failure_class: 'x' }), 'Computer step failed.');
  assert.equal(savedComputerOutput(null), 'Computer step finished.');
  const typed = buildPersistedToolInputSnapshot({ action: 'type', text: 'my secret note' });
  assert.equal(typed.input.text, '[typed text not saved]');
  assert.ok(!typed.inputJson.includes('secret'));
  const browser = buildPersistedToolInputSnapshot({ action: 'type', ref: 'r1', text: 'hello' });
  assert.equal(browser.input.text, 'hello', 'the browser keeps its own rule');
  assert.equal(buildPersistedToolInputSnapshot({ action: 'click', x: 1, y: 2 }).input.x, 1);
  assert.equal(buildPersistedToolInputSnapshot({ action: 'key', chord: 'ctrl+s' }).input.chord, '[key not saved]');
});

test('a spawned child and a woken turn never get the Computer switch', () => {
  const store = { peekSession: () => ({ tool_category_overrides: { browser_use: true, computer_use: true } }) };
  assert.deepEqual(inheritedToolCategoryOverrides(store, 'parent'), { browser_use: true });
  const session = { tool_category_overrides: { computer_use: true } };
  assert.ok(!(requestToolPreferences(undefined, { session })?.disabled_tools || []).includes('computer'), 'a typed turn follows the chat');
  assert.ok(requestToolPreferences(undefined, { session, applicationTurn: 'wake' }).disabled_tools.includes('computer'));
});

test('the holder starts nothing until used and shares the Live tab helper', async () => {
  const helper = { request: async () => ({}), on() {}, removeListener() {} };
  let hostAsks = 0;
  const holder = createLazyComputerUse({
    getRunView: () => ({ helperHost: () => { hostAsks += 1; return helper; } }),
    userDataPath: 'C:\\data', log: () => {},
    electron: { app: { getAppMetrics: () => [{ pid: 4242 }] }, shell: { readShortcutLink: () => ({}), openPath: async () => '' } },
    processRef: { pid: 1, execPath: 'C:\\Jenny\\Jenny.exe' },
  });
  assert.equal(holder.peek(), null);
  await holder.onTurnEnd('s1');
  await holder.forgetChat('s1');
  await holder.dispose();
  assert.equal(holder.peek(), null, 'a turn end, a delete or shutdown never starts it');
  const service = holder.get();
  assert.equal(holder.get(), service);
  const outcome = await service.execute({ action: 'screenshot' }, { sessionId: 's1', turnId: 't1', callId: 'c1' });
  assert.equal(outcome.status, 'no_target');
  assert.equal(hostAsks > 0, true, 'the helper comes from the Live tab holder');
  await holder.dispose();
});

test('Jenny names every one of its own processes and its program file', () => {
  const identity = readJennyIdentity({
    app: { getAppMetrics: () => [{ pid: 10 }, { pid: 11 }, { pid: -1 }, {}] },
    processRef: { pid: 10, execPath: 'C:\\Jenny\\Jenny.exe' },
  });
  assert.deepEqual(identity, { pids: [10, 11], programs: ['C:\\Jenny\\Jenny.exe'] });
  const lonely = readJennyIdentity({ app: { getAppMetrics() { throw new Error('x'); } }, processRef: { pid: 3, execPath: 'j.exe' } });
  assert.deepEqual(lonely.pids, [3]);
});
