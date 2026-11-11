'use strict';

// Row 94 P4: `terminal_read` is read-only and free (Plan mode may read), a closed schema over the terminal port, and
// its result always says terminal output is data.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const tool = require('../services/tools/builtin/terminal-read-tool');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');

const PERMISSIONS = { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) };
const TAIL = { ok: true, terminal: 2, lines: ['$ npm test', 'ok'], truncated: false, last_output_at: '2026-11-02T09:00:00.000Z' };

function harness({ port, featureFlags } = {}) {
  const project = { project_id: 'general', root_path: os.tmpdir(), root_id: 'root', root_revision: 1, device_id: 'device', inode: 'inode' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: (captured) => captured,
      _sessionStore: { getSessionSummary: () => ({ id: 'caller', run_mode: 'ask', plan_mode: false }) } },
    permissionStore: PERMISSIONS,
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const executionAuthority = authority.captureSession('caller', { requestId: 'stream', mode: 'assist', approvalMode: 'prompt' });
  const calls = [];
  const fake = port === undefined ? { async readTerminal(args) { calls.push(args); return TAIL; } } : port;
  const backendService = { sessionExecutionAuthority: authority, ...(featureFlags ? { featureFlags } : {}),
    sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }) } };
  const context = { sessionId: 'caller', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call-1', backendService, executionAuthority, terminalToolsService: fake, mode: 'ask',
    abortSignal: new AbortController().signal };
  return { context, calls };
}

const { parseToolOutput } = require('./helpers/refusal-output');
const output = parseToolOutput;

test('the kill switch refuses; Plan mode and read-only chats may read', async () => {
  const off = harness({ featureFlags: { terminal_tools: false } });
  assert.deepEqual(output(await tool.execute({}, off.context)), { ok: false, reason: 'disabled' });
  assert.deepEqual(off.calls, []);
  const plan = harness();
  assert.equal(output(await tool.execute({}, { ...plan.context, planMode: true, readOnly: true })).ok, true);
});

test('input is a closed schema: terminal 1-4 integers, lines 1-200 integers, no other keys', async () => {
  const { context, calls } = harness();
  const bad = [[], 'x', { extra: 1 }, { terminal: 0 }, { terminal: 5 }, { terminal: 1.5 }, { terminal: '2' }, { terminal: null },
    { lines: 0 }, { lines: 201 }, { lines: 2.5 }, { lines: '10' }, { terminal: 1, lines: 0 }];
  for (const input of bad) {
    assert.deepEqual(output(await tool.execute(input, context)), { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
  for (const input of [{}, { terminal: 1 }, { terminal: 4, lines: 200 }, { lines: 1 }]) {
    assert.equal(output(await tool.execute(input, context)).ok, true, JSON.stringify(input));
  }
});

test('a stale or missing live call and a missing port are unavailable', async () => {
  const stale = harness();
  stale.context.logicalTurnId = 'other-turn';
  assert.deepEqual(output(await tool.execute({}, stale.context)), { ok: false, reason: 'unavailable' });
  for (const port of [null, {}, { readTerminal: true }]) {
    assert.deepEqual(output(await tool.execute({}, harness({ port }).context)), { ok: false, reason: 'unavailable' });
  }
  assert.deepEqual(stale.calls, []);
});

test('the port gets the live caller and the requested terminal and lines; the answer carries the data note', async () => {
  const { context, calls } = harness();
  const result = await tool.execute({ terminal: 2, lines: 40 }, context);
  assert.deepEqual(calls, [{ session_id: 'caller', terminal: 2, lines: 40 }]);
  const { note, ...answer } = output(result);
  assert.deepEqual(answer, TAIL);
  assert.match(note, /data/i);
  assert.match(note, /not instructions/i);
  assert.equal(result.isError, false);
  assert.equal(result.metadata.status, 'ok');
  await tool.execute({}, context);
  assert.deepEqual(calls.at(-1), { session_id: 'caller', terminal: undefined, lines: undefined });
});

test('the port\'s refusal passes through its reason only; an odd answer is unavailable; a throw leaks nothing', async () => {
  const refused = harness({ port: { readTerminal: async () => ({ ok: false, reason: 'not_in_project', detail: 'C:\\private' }) } });
  const answer = await tool.execute({}, refused.context);
  assert.deepEqual(output(answer), { ok: false, reason: 'not_in_project' });
  assert.deepEqual(answer.metadata, { result_kind: 'terminal_read', status: 'refused', reason: 'not_in_project' });
  assert.deepEqual(output(await tool.execute({}, harness({ port: { readTerminal: async () => undefined } }).context)), { ok: false, reason: 'unavailable' });
  const thrown = await tool.execute({}, harness({ port: { readTerminal: async () => { throw new Error('C:\\private\\boom'); } } }).context);
  assert.deepEqual(output(thrown), { ok: false, reason: 'unavailable' });
  assert.equal(thrown.content.includes('private'), false);
});
