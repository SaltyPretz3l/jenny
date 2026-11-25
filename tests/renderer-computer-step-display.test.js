// new-test-file: a new surface (the computer step display helper has no existing test file).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const display = require('../renderer/chat/renderer-computer-step-display');
const { createComputerTurnState } = require('../renderer/chat/renderer-computer-step-display');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const { createTranscriptToolCallRenderer } = require('../renderer/chat/renderer-transcript-tool-calls');

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const meta = (status, extra) => ({ result_kind: 'computer', status, ...(extra || {}) });

test('done steps change nothing; a resumed step says its action was not sent; other tools change nothing', () => {
  assert.equal(display.computerStepDisplay(meta('done')), null);
  assert.deepEqual(display.computerStepDisplay(meta('resumed')), { tone: 'warn', failureSummary: 'Paused, then handed back: not done' });
  assert.equal(display.computerStepDisplay({ result_kind: 'browser', status: 'refused' }), null);
  assert.equal(display.computerStepDisplay(null), null);
  assert.equal(display.computerStepDisplay({}), null);
});

test('every status maps to a warn dot and its fixed failure summary', () => {
  const table = {
    declined: 'You denied it',
    paused_by_user: 'Paused: you took the mouse',
    no_target: "Didn't work: no window in front",
    not_found: "Didn't work: no program by that name",
    busy: 'Waited: another chat has the mouse',
    budget: 'Stopped at the step limit',
    failed: "Didn't work",
    invalid: "Didn't work",
    unavailable: "Didn't work",
    cancelled: "Didn't work",
    stale: "Didn't work",
    unknown: "Didn't work",
    something_new: "Didn't work",
  };
  for (const [status, summary] of Object.entries(table)) {
    assert.deepEqual(display.computerStepDisplay(meta(status)), { tone: 'warn', failureSummary: summary }, status);
  }
});

test('a refused step names a short reason, and an unknown or missing reason reads blocked', () => {
  const reasons = {
    outside_window: 'outside the window', refused_chord: 'key not allowed', password_field: 'password field',
    elevated: 'runs as administrator', window_gone: 'the window closed', wrong_program: 'a different program',
    secure_desktop: 'the screen is locked', never: "Jenny can't use that program", view_only: 'view only',
    too_many: 'too many programs', unanswerable: 'no one to ask',
  };
  for (const [code, text] of Object.entries(reasons)) {
    assert.equal(display.computerStepDisplay(meta('refused', { refusal_reason: code })).failureSummary, `Didn't work: ${text}`, code);
  }
  for (const code of ['not_front', 'denied', '<b>x</b>', undefined]) {
    assert.equal(display.computerStepDisplay(meta('refused', { refusal_reason: code })).failureSummary, "Didn't work: blocked");
  }
});

test('the failure summary never carries the model-written step summary', () => {
  const shown = display.computerStepDisplay(meta('refused', { step_summary: 'SECRET TEXT', refusal_reason: 'elevated' }));
  assert.ok(!JSON.stringify(shown).includes('SECRET'));
});

test('the header dot takes the tone override when one is set', () => {
  const model = { displayToolName: 'Computer', summary: '', status: 'completed', isRunning: false, statusLabel: 'Done', tone: 'warn', failureSummary: 'You denied it' };
  const html = toolCallUtils.buildToolHeaderInner(model, { escapeHtml: esc });
  assert.match(html, /status-dot status-dot--warn/);
  assert.match(html, /tool-call-failure-summary">You denied it</);
  const plain = toolCallUtils.buildToolHeaderInner({ ...model, tone: undefined, failureSummary: '' }, { escapeHtml: esc });
  assert.match(plain, /status-dot--ok/);
});

function resultRow(status, extra, kind = 'computer') {
  return { kind: 'tool_result', payload: { tool_name: 'computer', metadata: { result_kind: kind, status, ...(extra || {}) } } };
}
const finalAnswer = { kind: 'assistant_text', assistant_phase: 'final_answer' };
const settled = (rows) => ({ turnRows: rows, turnLive: false, isStreaming: false });

test("the count line counts only this turn's computer steps that did not work", () => {
  const rows = [resultRow('done'), resultRow('refused', { refusal_reason: 'elevated' }), resultRow('resumed'), resultRow('declined'),
    { kind: 'tool_result', payload: { tool_name: 'Read', metadata: { status: 'refused' } } }, finalAnswer];
  assert.deepEqual(display.countComputerSteps(rows), { failed: 2, total: 4 });
  const html = display.buildTallyMarkup(finalAnswer, settled(rows), esc);
  assert.match(html, /^<p class="computer-step-tally" role="note"><span class="status-dot status-dot--warn" aria-hidden="true"><\/span>/);
  assert.match(html, /2 of 4 computer steps did not work\. Check the result in the program before you rely on it\./);
});

test('the count line says "1 computer step" for a single step', () => {
  const rows = [resultRow('failed'), finalAnswer];
  assert.match(display.buildTallyMarkup(finalAnswer, settled(rows), esc), /1 of 1 computer step did not work\./);
});

test('no count line when nothing failed, no computer steps, a running turn, or a mid-turn answer', () => {
  assert.equal(display.buildTallyMarkup(finalAnswer, settled([resultRow('done'), resultRow('resumed')]), esc), '');
  assert.equal(display.buildTallyMarkup(finalAnswer, settled([{ kind: 'tool_result', payload: { tool_name: 'Read', metadata: {} } }]), esc), '');
  assert.equal(display.buildTallyMarkup(finalAnswer, settled([]), esc), '');
  const failing = [resultRow('refused')];
  assert.equal(display.buildTallyMarkup(finalAnswer, { turnRows: failing, turnLive: true }, esc), '');
  assert.equal(display.buildTallyMarkup(finalAnswer, { turnRows: failing, isStreaming: true }, esc), '');
  assert.equal(display.buildTallyMarkup({ kind: 'assistant_text', assistant_phase: 'commentary' }, settled(failing), esc), '');
});

function setupPause({ withBridge = true } = {}) {
  const dom = new JSDOM(`<div id="chat">
    <div class="tool-call-row tool-call-row--minimal" data-tool-name="computer" data-tool-status="completed"><div class="tool-call-row-header"></div></div>
    <div class="tool-call-row tool-call-row--minimal" id="live" data-tool-name="computer" data-tool-status="running"><div class="tool-call-row-header"></div><div class="tool-call-row-body"></div></div>
    <div class="tool-call-row tool-call-row--minimal" data-tool-name="Read" data-tool-status="running"><div class="tool-call-row-header"></div></div>
  </div>`);
  const calls = [];
  const resolvers = [];
  const bridge = {
    onTurnState() { return () => {}; },
    resume: (payload) => { calls.push(['resume', payload]); return new Promise((resolve) => resolvers.push(resolve)); },
    stop: (payload) => { calls.push(['stop', payload]); return Promise.resolve({ ok: true }); },
  };
  const windowRef = { jennyShell: { computerUse: bridge } };
  const turnState = createComputerTurnState({ windowRef });
  let current = 'chat-1';
  let timerFn = null;
  const mount = display.mountComputerPauseLine({
    document: dom.window.document,
    getCurrentSessionId: () => current,
    turnState,
    shell: withBridge ? windowRef.jennyShell : {},
    setIntervalFn: (fn) => { timerFn = fn; return 1; },
    clearIntervalFn: () => { timerFn = null; },
  });
  return { doc: dom.window.document, turnState, calls, resolvers, mount, setCurrent: (id) => { current = id; }, tick: () => timerFn && timerFn(), hasTimer: () => timerFn !== null };
}
const lines = (doc) => [...doc.querySelectorAll('.computer-pause-line')];

test('the pause line mounts once under the running computer step while the chat is paused', () => {
  const t = setupPause();
  assert.equal(lines(t.doc).length, 0);
  t.turnState.accept({ sessionId: 'chat-1', state: 'paused' });
  t.turnState.accept({ sessionId: 'chat-1', state: 'paused' });
  const [line, ...rest] = lines(t.doc);
  assert.equal(rest.length, 0);
  assert.equal(line.parentElement.id, 'live');
  assert.equal(line.previousElementSibling.className, 'tool-call-row-header');
  assert.equal(line.getAttribute('role'), 'status');
  assert.ok(line.querySelector('.status-dot--warn'));
  assert.match(line.textContent, /Paused while you use the mouse or keyboard\./);
  const buttons = [...line.querySelectorAll('button')];
  assert.deepEqual(buttons.map((b) => b.textContent), ['Resume', 'Stop']);
  assert.ok(buttons[0].matches('.btn.btn--sm.btn--primary'));
  assert.ok(buttons[1].matches('.btn.btn--sm'));
});

test('Resume and Stop call the bridge with the chat id and disable while in flight', async () => {
  const t = setupPause();
  t.turnState.accept({ sessionId: 'chat-1', state: 'paused' });
  const [resume, stop] = lines(t.doc)[0].querySelectorAll('button');
  resume.click();
  assert.deepEqual(t.calls, [['resume', { sessionId: 'chat-1' }]]);
  assert.ok(resume.disabled && stop.disabled);
  t.resolvers[0]({ ok: true, held: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!resume.disabled && !stop.disabled);
  stop.click();
  assert.deepEqual(t.calls[1], ['stop', { sessionId: 'chat-1' }]);
});

test('the pause line goes when the state changes or the chat changes', () => {
  const t = setupPause();
  t.turnState.accept({ sessionId: 'chat-1', state: 'paused' });
  t.turnState.accept({ sessionId: 'chat-1', state: 'step' });
  assert.equal(lines(t.doc).length, 0);
  t.turnState.accept({ sessionId: 'chat-1', state: 'paused' });
  assert.equal(lines(t.doc).length, 1);
  t.setCurrent('chat-2');
  t.tick();
  assert.equal(lines(t.doc).length, 0);
  t.turnState.accept({ sessionId: 'chat-1', state: 'idle' });
  assert.equal(t.hasTimer(), false);
});

test('a re-render that drops the line puts it back while the chat is still paused', () => {
  const t = setupPause();
  t.turnState.accept({ sessionId: 'chat-1', state: 'paused' });
  lines(t.doc)[0].remove();
  t.tick();
  assert.equal(lines(t.doc).length, 1);
});

test('a chat that was already paused shows the line after the person switches to it', () => {
  const t = setupPause();
  t.setCurrent('chat-2');
  t.turnState.accept({ sessionId: 'chat-1', state: 'paused' });
  assert.equal(lines(t.doc).length, 0);
  t.setCurrent('chat-1');
  t.tick();
  assert.equal(lines(t.doc).length, 1);
});

test('nothing mounts without a bridge, a running computer step, or a paused chat', () => {
  const t = setupPause({ withBridge: false });
  t.turnState.accept({ sessionId: 'chat-1', state: 'paused' });
  assert.equal(lines(t.doc).length, 0);
  assert.equal(typeof t.mount.dispose, 'function');
  const none = setupPause();
  none.doc.getElementById('live').dataset.toolStatus = 'completed';
  none.turnState.accept({ sessionId: 'chat-1', state: 'paused' });
  assert.equal(lines(none.doc).length, 0);
  none.turnState.accept({ sessionId: 'chat-9', state: 'paused' });
  assert.equal(lines(none.doc).length, 0);
});

test('dispose removes the line and stops listening', () => {
  const t = setupPause();
  t.turnState.accept({ sessionId: 'chat-1', state: 'paused' });
  t.mount.dispose();
  assert.equal(lines(t.doc).length, 0);
  t.turnState.accept({ sessionId: 'chat-1', state: 'paused' });
  assert.equal(lines(t.doc).length, 0);
});

// The wiring: each builder hands the helper's tone and reason to the shared header.
function computerCallRow(isError) {
  return { payload: { tool_call_id: 'c1', tool_name: 'computer', state: isError ? 'errored' : 'completed' } };
}
function toolRowMarkup(status, isError, extra) {
  const renderer = createTurnRowToolRenderUtils({ escapeHtml: esc, normalizeId: (v) => String(v || '').trim(), formatDurationMs: () => '' });
  const result = { payload: { tool_call_id: 'c1', tool_name: 'computer', is_error: isError, state: isError ? 'errored' : 'completed',
    metadata: meta(status, extra), output_text: 'step text' } };
  return renderer.buildToolCallRowMarkup(computerCallRow(isError), [], { pairedToolResultRow: result, sessionId: 's' });
}

test('a live step row shows a warn dot and the reason, and marks itself as a computer row', () => {
  const html = toolRowMarkup('refused', false, { refusal_reason: 'password_field' });
  assert.match(html, /status-dot status-dot--warn/);
  assert.match(html, /tool-call-failure-summary">Didn't work: password field</);
  assert.match(html, /data-tool-name="computer"/);
  const worked = toolRowMarkup('done', false);
  assert.match(worked, /status-dot--ok/);
  assert.ok(!worked.includes('tool-call-failure-summary'));
});

test('a real error keeps its own dot and failure text', () => {
  const html = toolRowMarkup('failed', true);
  assert.match(html, /status-dot--error/);
  assert.ok(!html.includes("Didn't work"));
});

test('the transcript view model carries the same tone and reason', () => {
  const renderer = createTranscriptToolCallRenderer({ escapeHtml: esc, toolCallUtils });
  const use = { id: 'u1', role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'c1', tool_name: 'computer', input: {}, status: 'completed' } };
  const result = { id: 'r1', role: 'assistant', kind: 'tool_result',
    tool_result: { call_id: 'c1', tool_name: 'computer', output_text: 'x', is_error: false, metadata: meta('declined') } };
  const model = renderer.buildToolCallViewModel(use, [use, result]);
  assert.equal(model.tone, 'warn');
  assert.equal(model.failureSummary, 'You denied it');
});

test('the answer row of a finished turn carries the count line, and a running turn does not', () => {
  const renderer = createTurnRowRenderUtils({ escapeHtml: esc, renderMarkdown: (text) => `<p>${esc(text)}</p>` });
  const answer = { kind: 'assistant_text', assistant_phase: 'final_answer', row_id: 'a1', turn_id: 't1', payload: { text: 'Built the farm.' } };
  const rows = [resultRow('refused', { refusal_reason: 'outside_window' }), answer];
  const done = renderer.buildAssistantTextRowMarkup(answer, [], { turnRows: rows, sessionId: 's' });
  assert.match(done, /chat-bubble[\s\S]*Built the farm\.[\s\S]*computer-step-tally[\s\S]*1 of 1 computer step did not work\./);
  const live = renderer.buildAssistantTextRowMarkup(answer, [], { turnRows: rows, sessionId: 's', turnLive: true });
  assert.ok(!live.includes('computer-step-tally'));
});
