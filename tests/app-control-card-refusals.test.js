'use strict';

// Row 94 P4: the pre-card refusal step for `session_export` and `terminal_run`. A request the port refuses ends the
// call with this JSON before any approval card; an answer the step does not know becomes `unavailable`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { appControlCardRefusal, appControlCardStep, hasCardStep } = require('../services/backend/app-control-card-refusals');
const { evaluatePolicy } = require('../services/tools/tool-policy-evaluator');
const { NEVER_PERSIST_ALWAYS_ALLOW } = require('../services/tools/tool-permission-store');

const EXPORT_NOTE = 'The app refused this before asking the user; nothing was saved.';
const RUN_NOTE = 'The app refused this before asking the user; nothing was run.';

function exportService(answer) {
  const calls = [];
  return { calls, service: { primaryChatExport: { prepareCard: async (args) => { calls.push(args); return typeof answer === 'function' ? answer(args) : answer; } } } };
}

function terminalService(answer) {
  const calls = [];
  return { calls, service: { terminalTools: { prepareRun: async (args) => { calls.push(args); return typeof answer === 'function' ? answer(args) : answer; } } } };
}

test('hasCardStep names exactly the two carded app-control tools', () => {
  assert.equal(hasCardStep('session_export'), true);
  assert.equal(hasCardStep('terminal_run'), true);
  for (const name of ['terminal_read', 'app_view', 'run_command', 'toString', 'constructor', '__proto__', '', undefined]) {
    assert.equal(hasCardStep(name), false, String(name));
  }
});

test('a tool without a step is never refused', async () => {
  const { service, calls } = exportService({ ok: false, reason: 'disabled' });
  assert.equal(await appControlCardRefusal(service, 'terminal_read', 'p1', 'call-1', {}), null);
  assert.equal(await appControlCardRefusal(service, 'constructor', 'p1', 'call-1', {}), null);
  assert.deepEqual(calls, []);
});

test('session_export: an ok answer lets the card show, and the port gets the target and title from the input', async () => {
  const { service, calls } = exportService({ ok: true });
  const refusal = await appControlCardRefusal(service, 'session_export', 'p1', 'call-1', { session_id: 's9', chat_title: 'Release notes', purpose: 'x' });
  assert.equal(refusal, null);
  assert.deepEqual(calls, [{ session_id: 'p1', tool_call_id: 'call-1', target_session_id: 's9', chat_title: 'Release notes' }]);
});

test('session_export: a title mismatch carries the real title; other extras are dropped', async () => {
  const { service } = exportService({ ok: false, reason: 'title_mismatch', chat_title: 'The real title', secret: 'C:\\private', message: 'boom' });
  const refusal = JSON.parse(await appControlCardRefusal(service, 'session_export', 'p1', 'call-1', { session_id: 's9', chat_title: 'Wrong' }));
  assert.deepEqual(refusal, { ok: false, reason: 'title_mismatch', chat_title: 'The real title', note: EXPORT_NOTE });
});

test('session_export: every known reason passes through', async () => {
  for (const reason of ['invalid_input', 'not_found', 'title_mismatch', 'empty', 'not_allowed', 'disabled', 'unavailable']) {
    const { service } = exportService({ ok: false, reason });
    assert.equal(JSON.parse(await appControlCardRefusal(service, 'session_export', 'p1', 'c', {})).reason, reason);
  }
});

test('an unknown reason, a non-string extra, a throwing or missing port all become unavailable', async () => {
  const unknown = JSON.parse(await appControlCardRefusal(exportService({ ok: false, reason: 'project_not_open' }).service, 'session_export', 'p1', 'c', {}));
  assert.deepEqual(unknown, { ok: false, reason: 'unavailable', note: EXPORT_NOTE });

  const badExtra = JSON.parse(await appControlCardRefusal(exportService({ ok: false, reason: 'title_mismatch', chat_title: 42 }).service, 'session_export', 'p1', 'c', {}));
  assert.deepEqual(badExtra, { ok: false, reason: 'title_mismatch', note: EXPORT_NOTE });

  const throwing = exportService(() => { throw new Error('C:\\private\\boom'); });
  const thrown = await appControlCardRefusal(throwing.service, 'session_export', 'p1', 'c', {});
  assert.deepEqual(JSON.parse(thrown), { ok: false, reason: 'unavailable', note: EXPORT_NOTE });
  assert.equal(thrown.includes('private'), false);

  for (const service of [null, undefined, {}, { primaryChatExport: {} }]) {
    assert.equal(JSON.parse(await appControlCardRefusal(service, 'session_export', 'p1', 'c', {})).reason, 'unavailable');
  }
  assert.equal(JSON.parse(await appControlCardRefusal(exportService(undefined).service, 'session_export', 'p1', 'c', {})).reason, 'unavailable');
});

test('terminal_run: prepareRun gets the caller, call id and command; ok shows the card', async () => {
  const { service, calls } = terminalService({ ok: true });
  assert.equal(await appControlCardRefusal(service, 'terminal_run', 'p1', 'call-7', { command: 'npm test', purpose: 'x' }), null);
  assert.equal(await appControlCardRefusal(service, 'terminal_run', 'p1', 'call-8', { command: 'npm test', where: 'project' }), null);
  assert.deepEqual(calls, [
    { session_id: 'p1', tool_call_id: 'call-7', command: 'npm test', where: undefined },
    { session_id: 'p1', tool_call_id: 'call-8', command: 'npm test', where: 'project' },
  ], 'the service reads where; no where is the start folder');
});

test('an accepted request adds where the result lands to the card: the Downloads name, the terminal folder', async () => {
  const exported = await appControlCardStep(exportService({ ok: true, file_name: 'Jenny chat - Notes.md' }).service, 'session_export', 'p1', 'c', {});
  assert.deepEqual(exported, { refusal: null, cardNote: 'Saved to your Downloads folder as "Jenny chat - Notes.md".' });
  const run = await appControlCardStep(terminalService({ ok: true, folder: 'G:\\work\\pr1' }).service, 'terminal_run', 'p1', 'c', { command: 'x' });
  assert.deepEqual(run, { refusal: null, cardNote: 'Runs in a new Jenny terminal tab in G:\\work\\pr1.' });
  assert.deepEqual(await appControlCardStep(terminalService({ ok: true }).service, 'terminal_run', 'p1', 'c', { command: 'x' }), { refusal: null, cardNote: '' });
  assert.deepEqual(await appControlCardStep({}, 'app_view', 'p1', 'c', {}), { refusal: null, cardNote: '' });
});

test('terminal_run: Docker sandbox mode refuses before the card and never asks the port', async () => {
  const { service, calls } = terminalService({ ok: true, folder: 'G:\\work' });
  service.commandSandbox = { enabled: true };
  const step = await appControlCardStep(service, 'terminal_run', 'p1', 'c', { command: 'x' });
  assert.deepEqual(JSON.parse(step.refusal), { ok: false, reason: 'sandbox_mode', note: RUN_NOTE });
  assert.deepEqual(calls, []);
  const fromConfig = terminalService({ ok: true });
  fromConfig.service.configService = { getState: () => ({ commandSandbox: { enabled: true } }) };
  assert.equal(JSON.parse((await appControlCardStep(fromConfig.service, 'terminal_run', 'p1', 'c', { command: 'x' })).refusal).reason, 'sandbox_mode');
});

test('terminal_run: known reasons pass through with the nothing-was-run note and no extras', async () => {
  for (const reason of ['invalid_command', 'project_not_open', 'sandbox_mode', 'not_allowed', 'disabled', 'unavailable']) {
    const { service } = terminalService({ ok: false, reason, chat_title: 'leak' });
    assert.deepEqual(JSON.parse(await appControlCardRefusal(service, 'terminal_run', 'p1', 'c', { command: 'x' })), { ok: false, reason, note: RUN_NOTE });
  }
  const unknown = terminalService({ ok: false, reason: 'no_free_terminal' });
  assert.equal(JSON.parse(await appControlCardRefusal(unknown.service, 'terminal_run', 'p1', 'c', { command: 'x' })).reason, 'unavailable');
  const thrown = terminalService(() => { throw new Error('x'); });
  assert.equal(JSON.parse(await appControlCardRefusal(thrown.service, 'terminal_run', 'p1', 'c', { command: 'x' })).reason, 'unavailable');
  assert.equal(JSON.parse(await appControlCardRefusal({}, 'terminal_run', 'p1', 'c', { command: 'x' })).reason, 'unavailable');
});

// Row 178, owner pick D4: a project chat may use terminal_run on its own project; every run is carded.
const { REFUSAL_SENTENCES } = require('../services/tools/builtin/session-directory-tool-support');
test('terminal_run: a project chat that is not on the open project, or asks for the start folder, is refused with a sentence the model can read', async () => {
  const notOpen = terminalService({ ok: false, reason: 'not_in_project' });
  const first = JSON.parse(await appControlCardRefusal(notOpen.service, 'terminal_run', 'c1', 'call-1', { command: 'npm test' }));
  assert.deepEqual(first, {
    ok: false, reason: 'not_in_project', note: RUN_NOTE,
    message: REFUSAL_SENTENCES.not_in_project,
  });
  const startFolder = terminalService({ ok: false, reason: 'project_chat_runs_in_project' });
  const second = JSON.parse(await appControlCardRefusal(startFolder.service, 'terminal_run', 'c1', 'call-2', { command: 'npm test', where: 'start_folder' }));
  assert.deepEqual(second, {
    ok: false, reason: 'project_chat_runs_in_project', note: RUN_NOTE,
    message: REFUSAL_SENTENCES.project_chat_runs_in_project,
  });
  assert.deepEqual(startFolder.calls, [{ session_id: 'c1', tool_call_id: 'call-2', command: 'npm test', where: 'start_folder' }]);
  // The reasons that need no extra sentence carry none.
  assert.equal('message' in JSON.parse(await appControlCardRefusal(terminalService({ ok: false, reason: 'not_allowed' }).service, 'terminal_run', 'c1', 'c', { command: 'x' })), false);
});

test('terminal_run: a project chat on its open project reaches a card that names the project folder, and the policy asks every time', async () => {
  const { service } = terminalService({ ok: true, folder: 'G:\\work\\pr1', where: 'project' });
  assert.deepEqual(await appControlCardStep(service, 'terminal_run', 'c1', 'call-1', { command: 'npm test', purpose: 'x' }),
    { refusal: null, cardNote: 'Runs in a new Jenny terminal tab in G:\\work\\pr1.' });
  // The approval policy is by tool name, so it holds for a project chat as for the Jenny chat: ask, and never always-allowed.
  const descriptor = { name: 'terminal_run', side_effecting: true, read_only: false };
  const decision = evaluatePolicy({ descriptor, args: { command: 'npm test', purpose: 'x' }, mode: 'auto', snapshot: undefined });
  assert.equal(decision.decision, 'ask');
  assert.equal(NEVER_PERSIST_ALWAYS_ALLOW.has('terminal_run'), true);
});
