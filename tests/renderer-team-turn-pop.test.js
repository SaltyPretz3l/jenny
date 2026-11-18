'use strict';

// new-test-file: the transcript popover of a Team project conversation (row 171), a new surface

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const pop = require('../renderer/team/renderer-team-turn-pop');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');

const { toLocalMessages, liveMessage, turnBodyHtml, createTurnPop } = pop;

const TURN = 'turn-1';
const OUTPUT = '<meta name="description" content="Acme builds websites">';
const markdown = (text) => '<p>' + escapeHtml(String(text || '')) + '</p>';

function hostTurn() {
  return [
    { id: 'u1', role: 'user', content: 'Check the meta description in index.html', author: { kind: 'member', member_id: 'm1' },
      turn_id: TURN, timestamp: '2026-11-16T09:31:00.000Z', status: 'complete' },
    { id: 'a1', role: 'assistant', content: '', status: 'complete', turn_id: TURN,
      reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'Reading what the hero line promises first' }] } },
    { id: 't1', role: 'assistant', kind: 'tool_use', content: 'read_file', status: 'complete', turn_id: TURN,
      tool_call: { call_id: 'c1', tool_name: 'read_file', input_json: '{"path":"index.html"}', status: 'completed' } },
    { id: 't2', role: 'tool', kind: 'tool_result', content: '', status: 'complete', turn_id: TURN,
      tool_result: { call_id: 'c1', tool_name: 'read_file', output_text: OUTPUT, is_error: false, duration_ms: 400,
        metadata: { path: 'C:/x', artifacts: [{ artifact_id: 'art-0', title: 'x' }] } } },
    { id: 'a2', role: 'assistant', content: 'Here is the new meta description.', status: 'complete', turn_id: TURN },
  ];
}

// The fixture extended with data the local chain draws desktop affordances from (each one checked to render below).
function hostileTurn() {
  const messages = hostTurn();
  messages[0].attachments = [{ id: 'att-1', name: 'shot.png', mime_type: 'image/png', size: 10 }];
  // A local tool call carries its parsed input too; the adapter ignores it and parses input_json itself.
  messages[2].tool_call.input = { path: 'index.html' };
  messages[3].tool_result.metadata = { path: 'C:/x', row_summary: 'Opened C:/x', result_kind: 'project_notes' };
  messages[3].tool_result.generated_artifacts = [{ artifact_id: 'art-1', artifact_kind: 'document', title: 'Report' }];
  messages.splice(4, 0,
    { id: 't3', role: 'assistant', kind: 'tool_use', content: 'run_command', status: 'complete', turn_id: TURN,
      tool_call: { call_id: 'c2', tool_name: 'run_command', input_json: '{"command":"npm test"}', status: 'completed' } },
    { id: 't4', role: 'tool', kind: 'tool_result', content: '', status: 'complete', turn_id: TURN,
      tool_result: { call_id: 'c2', tool_name: 'run_command', output_text: '1 failed', is_error: false, duration_ms: 900,
        generated_artifacts: [{ artifact_id: 'art-2', artifact_kind: 'document', title: 'Coverage' }],
        metadata: { test_summary: { runner: 'node', unit: 'tests', total: 3, passed: 1, failed: 1, skipped: 1,
          failures: [{ name: 'adds', at: 0.5 }] } } } },
    { id: 't5', role: 'assistant', kind: 'tool_use', content: 'report_findings', status: 'complete', turn_id: TURN,
      tool_call: { call_id: 'c3', tool_name: 'report_findings', input_json: '{}', status: 'completed' } },
    { id: 't6', role: 'tool', kind: 'tool_result', content: '', status: 'complete', turn_id: TURN,
      tool_result: { call_id: 'c3', tool_name: 'report_findings', is_error: false, duration_ms: 5, review_findings: [{ title: 'x' }],
        output_text: JSON.stringify({ kind: 'review_findings', findings: [{ title: 'Unchecked input', severity: 'high', file: 'src/a.js', line: 3 }] }) } });
  messages[messages.length - 1].generated_artifacts = [{ artifact_id: 'art-3', title: 'Answer' }];
  return messages;
}

const AFFORDANCES = '[data-chat-path], [data-chat-path-open], .tool-path-chip, .chat-inline-path, .inv-artifact-card, .inv-artifact-figure,'
  + ' [data-inv-artifact-action], [data-inv-error-action], [data-review-findings], .review-findings, .tool-test-progress,'
  + ' .notes-chat__row, [data-notes-open], [data-jenny-code-review], .cal-chat';

function dom() {
  const window = new JSDOM('<!doctype html><body><div id="host"></div></body>').window;
  return { window, doc: window.document, host: window.document.getElementById('host') };
}
function parse(doc, html) {
  const box = doc.createElement('div');
  box.innerHTML = html;
  return box;
}
function anyInvAttribute(root) {
  return Array.from(root.querySelectorAll('*')).some((el) => Array.from(el.attributes).some((a) => a.name.startsWith('data-inv-')));
}
function model(messages, extra = {}) {
  return { turnId: TURN, title: 'Jenny\u2019s work', sub: 'Brendan\u2019s turn \u00b7 09:31', live: false, canStop: false,
    canPrev: true, canNext: true, messages, extraHtml: '', note: '', ...extra };
}
function mount(onAction = () => {}) {
  const env = dom();
  const p = createTurnPop({ host: env.host, doc: env.doc, markdown, sessionKey: 'team-proj-1-conv-1', onAction });
  return { ...env, p };
}

test('(a) a host turn renders the prompt bubble, reasoning, a tool row whose opened body holds the output, and the final text', () => {
  const { host, p } = mount();
  p.render(model(toLocalMessages(hostTurn())));
  assert.ok(p.isOpen());
  const timeline = host.querySelector('.team-turn-pop__scroll > .chat-timeline[data-transcript-view="everything"]');
  assert.ok(timeline, 'the body is the chain markup inside the chat timeline');
  const user = timeline.querySelector('article.chat-entry.user .chat-bubble');
  assert.match(user.textContent, /Check the meta description/);
  const assistant = timeline.querySelector('article.chat-entry.assistant');
  assert.ok(assistant.querySelector('.reasoning-row-block [data-reasoning-toggle]'), 'a reasoning row');
  assert.match(assistant.querySelector('.reasoning-row-header').textContent, /Reading what the hero line/);
  assert.match(assistant.textContent, /Here is the new meta description\./);
  const toggle = assistant.querySelector('.tool-call-row [data-tool-row-toggle]');
  assert.ok(toggle, 'a tool row');
  assert.match(toggle.closest('.tool-call-row-header').textContent, /index\.html/, 'the summary keeps the path as text');
  assert.equal(toggle.closest('.tool-call-row').getAttribute('data-expanded'), 'false', 'a settled tool row starts closed');
  toggle.click();
  const row = host.querySelector('.tool-call-row');
  assert.equal(row.getAttribute('data-expanded'), 'true');
  assert.ok(row.querySelector('.tool-call-row-body').textContent.includes(OUTPUT), 'the opened body holds the output');
});

test('(b) metadata, artifacts, attachments, findings and paths never reach the popover', () => {
  // Control: the raw host messages through the raw chain do draw every affordance this test then forbids.
  const { doc } = dom();
  const messages = normalizeChatMessages(hostileTurn());
  const rows = projectTurnTree({ messages }).turns.flatMap((t) => projectTurnRows(t.events, { deterministicRowId: true }));
  const raw = parse(doc, createTurnRowRenderUtils({ escapeHtml, renderMarkdown: markdown })
    .buildTurnRowListMarkup(rows, messages, { turnRows: rows, transcriptView: 'everything', sessionId: 's' }));
  for (const selector of ['[data-chat-path]', '.inv-artifact-card', '[data-review-findings]', '.tool-test-progress']) {
    assert.ok(raw.querySelector(selector), 'the unfiltered chain draws ' + selector);
  }
  assert.ok(anyInvAttribute(raw));

  const body = parse(doc, turnBodyHtml({ messages: toLocalMessages(hostileTurn()), markdown, doc, sessionKey: 's' }));
  assert.ok(body.querySelector('.tool-call-row'), 'the tool rows still render');
  assert.equal(body.querySelector(AFFORDANCES), null);
  assert.equal(anyInvAttribute(body), false);
  assert.match(body.textContent, /index\.html/, 'a path stays readable as text');

  const { host, p } = mount();
  p.render(model(toLocalMessages(hostileTurn())));
  host.querySelectorAll('[data-tool-row-toggle]').forEach((toggle) => toggle.click());
  assert.equal(host.querySelector(AFFORDANCES), null, 'opened rows draw none either');
  assert.equal(anyInvAttribute(host), false);
});

test('(c) the live message adds a streaming text row and a live reasoning row', () => {
  assert.equal(liveMessage({ stream: { id: 's1', text: '  ', reasoning: [] }, turnId: TURN }), null);
  const live = liveMessage({ stream: { id: 's1', text: 'Writing the description now', reasoning: [{ id: 'lr1', text: 'Matching the hero line' }] },
    turnId: TURN, model: 'qwen3:30b' });
  assert.equal(live.id, 'live-s1');
  assert.equal(live.status, 'streaming');
  const { doc } = dom();
  const body = parse(doc, turnBodyHtml({ messages: [...toLocalMessages(hostTurn().slice(0, 1)), live], markdown, doc }));
  const streaming = body.querySelector('[data-streaming-row="true"] .chat-bubble-streaming');
  assert.ok(streaming, 'a streaming text row');
  assert.match(streaming.textContent, /Writing the description now/);
  const reasoning = body.querySelector('.reasoning-row-block[data-reasoning-status="streaming"]');
  assert.ok(reasoning, 'a live reasoning row');
  assert.match(reasoning.textContent, /Matching the hero line/);
});

test('(d) a tool row stays open across renders and an unchanged row keeps its node', () => {
  const { host, p } = mount();
  const messages = toLocalMessages(hostTurn());
  p.render(model(messages));
  host.querySelector('[data-tool-row-toggle]').click();
  const row = host.querySelector('.chat-row[data-row-kind="tool_call"]');
  const user = host.querySelector('article.chat-entry.user');
  assert.equal(row.querySelector('.tool-call-row').getAttribute('data-expanded'), 'true');
  p.render(model(messages));
  assert.equal(host.querySelector('.chat-row[data-row-kind="tool_call"]'), row, 'the same model keeps every node');
  const more = toLocalMessages([{ id: 'a3', role: 'assistant', content: 'One more thing.', status: 'complete', turn_id: TURN }]);
  p.render(model([...messages, ...more]));
  const after = host.querySelector('.chat-row[data-row-kind="tool_call"]');
  assert.equal(after, row, 'the unchanged tool row is the same node');
  assert.equal(host.querySelector('article.chat-entry.user'), user, 'the prompt keeps its node');
  assert.equal(after.querySelector('.tool-call-row').getAttribute('data-expanded'), 'true', 'still open');
  assert.match(host.querySelector('.chat-timeline').textContent, /One more thing\./);
  // The reasoning row toggles the same way and survives a render.
  host.querySelector('[data-reasoning-toggle]').click();
  assert.ok(host.querySelector('.reasoning-row-block').classList.contains('expanded'));
  p.render(model([...messages, ...more]));
  assert.ok(host.querySelector('.reasoning-row-block').classList.contains('expanded'));
  // Enter on the tool row's role="button" closes it again.
  const toggle = host.querySelector('[data-tool-row-toggle]');
  toggle.dispatchEvent(new toggle.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(host.querySelector('.tool-call-row').getAttribute('data-expanded'), 'false');
});

test('(e) the frame follows the contract and the header buttons call onAction, disabled ones do not', () => {
  const calls = [];
  const { host, p } = mount((kind) => calls.push(kind));
  p.render(model(toLocalMessages(hostTurn()), { canStop: true, canNext: false, live: true }));
  const aside = host.querySelector('aside.team-turn-pop');
  assert.equal(aside.getAttribute('role'), 'complementary');
  assert.equal(aside.getAttribute('aria-label'), 'Jenny\u2019s work in this turn');
  assert.equal(aside.getAttribute('data-turn-id'), TURN);
  assert.equal(host.querySelector('.team-turn-pop__title b').textContent, 'Jenny\u2019s work');
  assert.equal(host.querySelector('.team-turn-pop__title span').getAttribute('dir'), 'auto');
  assert.equal(host.querySelector('.team-turn-pop__foot').textContent, 'Reply in the conversation. Everyone here sees this turn.');
  const stop = host.querySelector('button.btn.btn--sm.team-turn-pop__stop[data-pop-action="stop"]');
  assert.match(stop.textContent, /Stop/);
  assert.ok(stop.querySelector('svg'));
  assert.equal(host.querySelector('[data-pop-action="prev"]').getAttribute('aria-label'), 'Earlier turn');
  assert.equal(host.querySelector('[data-pop-action="next"]').getAttribute('aria-label'), 'Later turn');
  assert.equal(host.querySelector('[data-pop-action="close"]').getAttribute('aria-label'), 'Close (Esc)');
  for (const kind of ['stop', 'prev', 'next', 'close']) host.querySelector('[data-pop-action="' + kind + '"]').click();
  assert.deepEqual(calls, ['stop', 'prev', 'close']);
  p.render(model(toLocalMessages(hostTurn()), { canPrev: false, canNext: true, note: 'Earlier part not loaded' }));
  assert.equal(host.querySelector('[data-pop-action="stop"]'), null, 'no Stop once the turn cannot be stopped');
  assert.equal(host.querySelector('.team-turn-pop__foot').textContent, 'Earlier part not loaded');
  host.querySelector('[data-pop-action="prev"]').click();
  host.querySelector('[data-pop-action="next"]').click();
  assert.deepEqual(calls, ['stop', 'prev', 'close', 'next']);
  p.focus();
  assert.equal(host.ownerDocument.activeElement, host.querySelector('.team-turn-pop__scroll'));
  p.close();
  assert.equal(host.innerHTML, '');
  assert.equal(p.isOpen(), false);
});

test('(f) Escape on the popover closes it; Escape in a text field of the extra markup does not', () => {
  const calls = [];
  const { host, p } = mount((kind) => calls.push(kind));
  p.render(model(toLocalMessages(hostTurn()), { extraHtml: '<form class="team-q"><textarea name="other"></textarea></form>'
    + '<div class="user-questions-block"><button type="button" class="q-pick">A</button></div>' }));
  const view = host.ownerDocument.defaultView;
  const esc = (el) => el.dispatchEvent(new view.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  esc(host.querySelector('textarea'));
  esc(host.querySelector('.q-pick'));
  assert.deepEqual(calls, []);
  esc(host.querySelector('.team-turn-pop__scroll'));
  assert.deepEqual(calls, ['close']);
  // The extra block keeps its node (and a half-typed answer) while it does not change.
  const area = host.querySelector('textarea');
  area.value = 'half typed';
  p.render(model(toLocalMessages(hostTurn()), { extraHtml: host.querySelector('.team-turn-pop__extra').innerHTML }));
  assert.equal(host.querySelector('textarea'), area);
  p.dispose();
  esc(host.querySelector('.team-turn-pop__scroll') || host);
  assert.deepEqual(calls, ['close'], 'no handler after dispose');
  p.render(model(toLocalMessages(hostTurn())));
  assert.equal(host.innerHTML, '', 'a disposed popover draws nothing');
});

test('(g) with a chain module missing, the body is the plain prompt and last text and nothing throws', () => {
  const { doc } = dom();
  const messages = toLocalMessages(hostTurn());
  for (const deps of [{ projectTurnRows: null }, { normalizeChatMessages: undefined }, { createTurnRowRenderUtils: () => { throw new Error('x'); } }]) {
    const body = parse(doc, turnBodyHtml({ messages, markdown, doc, deps }));
    assert.equal(body.querySelector('.chat-row'), null);
    const plain = Array.from(body.querySelectorAll('.chat-timeline > p.team-turn-pop__plain')).map((n) => n.textContent);
    assert.deepEqual(plain, ['Check the meta description in index.html', 'Here is the new meta description.']);
  }
  const hostile = toLocalMessages([{ id: 'u', role: 'user', content: '<img src=x onerror=alert(1)>' }]);
  const body = parse(doc, turnBodyHtml({ messages: hostile, markdown, doc, deps: { projectTurnTree: null } }));
  assert.equal(body.querySelector('img'), null, 'the fallback escapes');
  // No document to sweep the markup with: fail closed to the plain body.
  assert.equal(parse(doc, turnBodyHtml({ messages, markdown })).querySelector('.chat-row'), null);
});

test('(g) the script loads in the app, where require throws, and falls back without the chain globals', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const { doc } = dom();
  const app = { stringUtils: require('../renderer/shared/string-utils'),
    require: (name) => { throw new Error('Check dependency list! ' + name); } };
  app.globalThis = app;
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/team/renderer-team-turn-adapter'), 'utf8'), app);
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/team/renderer-team-turn-pop'), 'utf8'), app);
  const api = app.rendererTeamTurnPop;
  assert.equal(typeof api.createTurnPop, 'function');
  const html = api.turnBodyHtml({ messages: api.toLocalMessages(hostTurn()), markdown, doc });
  assert.match(html, /team-turn-pop__plain/);
});

test('(h) the input messages are never mutated', () => {
  const input = hostileTurn();
  const before = JSON.parse(JSON.stringify(input));
  const local = toLocalMessages(input);
  const localBefore = JSON.parse(JSON.stringify(local));
  const { host, p } = mount();
  p.render(model(local));
  host.querySelectorAll('[data-tool-row-toggle]').forEach((toggle) => toggle.click());
  turnBodyHtml({ messages: local, markdown, doc: host.ownerDocument });
  assert.deepEqual(input, before);
  assert.deepEqual(local, localBefore);
});

// ------------------------------------------------------------ row 175: stable DOM, focus and follow

const LIVE = 'turn-live';
const REASON = { source: 'provider', entries: [{ id: 'r1', text: 'Weighing the hero line' }] };
// A live turn: the prompt and the streaming tail (event_seq after the prompt, as the adapter stamps it).
function liveTurn(text) {
  return [{ id: 'u1', role: 'user', content: 'Write the description', turn_id: LIVE, event_seq: 200, status: 'complete' },
    { id: 'live-s1', role: 'assistant', kind: '', content: text, status: 'streaming', turn_id: LIVE, event_seq: 201, reasoning: REASON }];
}
// The same turn after the first save; the host may stamp the saved message with another turn id.
function savedTurn(text, turnId = LIVE) {
  return toLocalMessages([{ id: 'u1', role: 'user', content: 'Write the description', turn_id: LIVE, event_seq: 200, status: 'complete' },
    { id: 'assistant_s1_seg0', role: 'assistant', content: text, status: 'complete', turn_id: turnId, event_seq: 201, reasoning: REASON }]);
}
const liveModel = (messages, extra = {}) => model(messages, { turnId: LIVE, live: true, ...extra });
// Scroll metrics jsdom does not lay out: a writable, clamped scrollTop over the given heights.
function metrics(el, m) {
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => m.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => m.clientHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top,
    set: (v) => { top = Math.max(0, Math.min(Number(v) || 0, m.scrollHeight - m.clientHeight)); } });
  return m;
}
const scrollOf = (host) => host.querySelector('.team-turn-pop__scroll');
function readerScroll(el, top) {
  const view = el.ownerDocument.defaultView;
  el.dispatchEvent(new view.Event('wheel'));
  el.scrollTop = top;
  el.dispatchEvent(new view.Event('scroll'));
}

test('(i) the streaming row, its live region, the reasoning body and the article keep their nodes across renders and the first save', () => {
  const { host, p } = mount();
  p.render(liveModel(liveTurn('Writing')));
  const row = host.querySelector('.chat-row[data-row-kind="assistant_text"]');
  const bubble = row.querySelector('[role="status"]');
  const article = host.querySelector('article.chat-entry.assistant');
  const body = host.querySelector('.reasoning-row-panel-body');
  metrics(body, { scrollHeight: 300, clientHeight: 100 });
  body.scrollTop = 40;
  p.render(liveModel(liveTurn('Writing the description now')));
  assert.equal(host.querySelector('.chat-row[data-row-kind="assistant_text"]'), row, 'the streaming row keeps its node');
  assert.equal(host.querySelector('[role="status"]'), bubble, 'the live region keeps its node');
  assert.match(bubble.textContent, /Writing the description now/);
  assert.equal(host.querySelector('article.chat-entry.assistant'), article);
  assert.equal(host.querySelector('.reasoning-row-panel-body'), body);
  // The first save: another message id and another turn_id on the saved message; the model's turnId keys the rows.
  p.render(model(savedTurn('Writing the description now.', 'stream-xyz'), { turnId: LIVE }));
  assert.equal(host.querySelector('.chat-row[data-row-kind="assistant_text"]'), row, 'the row survives the save');
  assert.equal(row.querySelector('.chat-bubble'), bubble, 'the bubble survives the save');
  assert.equal(host.querySelector('article.chat-entry.assistant'), article, 'the article is keyed by the turn');
  assert.equal(host.querySelector('.reasoning-row-panel-body'), body, 'the reasoning body survives the save');
  assert.equal(body.scrollTop, 40, 'and keeps its inner scroll');
  assert.equal(host.querySelector('.reasoning-row-panel').getAttribute('data-collapsing'), 'true', 'the settled phase collapses, not snaps');
  for (const el of host.querySelectorAll('[data-row-id]')) assert.ok(el.getAttribute('data-row-id').startsWith(LIVE + ':'), 'rows keyed by the model turn');
});

test('(j) an opened reasoning phase stays open across the stream-id to saved-id change', () => {
  const { host, p } = mount();
  p.render(liveModel(liveTurn('Writing')));
  host.querySelector('[data-reasoning-toggle]').click();
  assert.equal(host.querySelector('.reasoning-row-block').classList.contains('expanded'), false, 'closed by the reader');
  host.querySelector('[data-reasoning-toggle]').click();
  assert.ok(host.querySelector('.reasoning-row-block').classList.contains('expanded'), 'opened by the reader');
  p.render(model(savedTurn('Done.'), { turnId: LIVE }));
  assert.ok(host.querySelector('.reasoning-row-block').classList.contains('expanded'), 'still open after the save');
});

test('(k) follow: a following reader stays at the bottom on growth, a scrolled-up reader is not moved', () => {
  const env = dom();
  let observed = null;
  env.window.ResizeObserver = class { constructor(cb) { observed = cb; } observe() {} unobserve() {} disconnect() {} };
  const p = createTurnPop({ host: env.host, doc: env.doc, markdown, sessionKey: 'team-proj-1-conv-1' });
  p.render(liveModel(liveTurn('One')));
  const el = scrollOf(env.host);
  const m = metrics(el, { scrollHeight: 1000, clientHeight: 400 });
  p.render(liveModel(liveTurn('One two')));
  assert.equal(el.scrollTop, 600, 'pinned at the bottom');
  assert.equal(el.style.getPropertyValue('--chat-thread-viewport-h'), '400px', 'the live box is capped from the popover');
  m.scrollHeight = 1500;
  p.render(liveModel(liveTurn('One two three')));
  assert.equal(el.scrollTop, 1100, 'growth through a render keeps it pinned');
  m.scrollHeight = 1800;
  observed([]);
  assert.equal(el.scrollTop, 1400, 'growth after the render (resize) keeps it pinned');
  readerScroll(el, 200);
  m.scrollHeight = 2400;
  p.render(liveModel(liveTurn('One two three four')));
  observed([]);
  assert.equal(el.scrollTop, 200, 'a scrolled-up reader is not moved');
  readerScroll(el, 1980);
  m.scrollHeight = 2600;
  observed([]);
  assert.equal(el.scrollTop, 2200, 'back within 48 px of the bottom: following again');
  // The live turn settles while open: it keeps following until the reader scrolls.
  m.scrollHeight = 2700;
  p.render(model(savedTurn('Done.'), { turnId: LIVE }));
  assert.equal(el.scrollTop, 2300);
  p.dispose();
});

test('(l) a turnId change resets follow: a live turn opens at the bottom, a settled turn at its question', () => {
  const { host, p } = mount();
  p.render(model(toLocalMessages(hostTurn())));
  const el = scrollOf(host);
  const m = metrics(el, { scrollHeight: 1000, clientHeight: 400 });
  readerScroll(el, 300);
  p.render(liveModel(liveTurn('Writing')));
  assert.equal(el.scrollTop, 600, 'a live turn starts at the bottom');
  m.scrollHeight = 1200;
  p.render(model(toLocalMessages(hostTurn()), { turnId: 'turn-2' }));
  assert.equal(el.scrollTop, 0, 'a settled turn opens at the top');
  m.scrollHeight = 1400;
  p.render(model([...toLocalMessages(hostTurn()), { id: 'a9', role: 'assistant', content: 'More.', status: 'complete', turn_id: TURN }], { turnId: 'turn-2' }));
  assert.equal(el.scrollTop, 0, 'and is not pulled down by a later render');
});

test('(m) focus: a replaced focused element hands focus to its replacement, else to the scroller, never to body', () => {
  const { host, doc, p } = mount();
  const base = toLocalMessages(hostTurn());
  p.render(model(base, { extraHtml: '<div tabindex="0" id="pick-1">A</div><div tabindex="0" id="pick-2">B</div>' }));
  host.querySelector('#pick-1').focus();
  p.render(model(base, { extraHtml: '<span tabindex="0" id="pick-1">A</span><div tabindex="0" id="pick-2">B</div>' }));
  assert.equal(doc.activeElement.tagName, 'SPAN');
  assert.equal(doc.activeElement.id, 'pick-1', 'the replacement holds focus');
  p.render(model(base, { extraHtml: '<div tabindex="0" id="pick-2">B</div>' }));
  assert.equal(doc.activeElement, scrollOf(host), 'gone: the scroller holds focus');
  // The reasoning toggle keeps focus through the save, where its id changes.
  p.render(liveModel(liveTurn('Writing')));
  host.querySelector('[data-reasoning-toggle]').focus();
  p.render(model(savedTurn('Done.'), { turnId: LIVE }));
  assert.ok(doc.activeElement.hasAttribute('data-reasoning-toggle'));
});

test('(n) a question form keeps its picked radio, typed text and focus when a second card arrives', () => {
  const { host, doc, p } = mount();
  const base = toLocalMessages(hostTurn());
  const form = '<form class="team-conv__qform"><div class="team-conv__question" data-question-ref="q1"><p>Which tone?</p>'
    + '<label><input type="radio" name="q1" value="a"> Plain</label><label><input type="radio" name="q1" value="b"> Warm</label>'
    + '<textarea data-user-question-free-text></textarea></div></form>';
  p.render(liveModel(base, { extraHtml: form }));
  const radio = host.querySelector('input[value="b"]');
  const area = host.querySelector('textarea');
  radio.checked = true;
  area.value = 'half typed';
  area.focus();
  const approval = '<div class="tool-approval-block" data-approval-id="ap1"><p class="tool-approval-prompt">Write index.html?</p></div>';
  p.render(liveModel(base, { extraHtml: approval + form }));
  assert.equal(host.querySelector('input[value="b"]'), radio);
  assert.ok(radio.checked, 'the pick stays');
  assert.equal(host.querySelector('textarea'), area);
  assert.equal(area.value, 'half typed');
  assert.equal(doc.activeElement, area);
  assert.ok(host.querySelector('[data-approval-id="ap1"]'), 'the new card is drawn');
});

test('(o) the end line for a failed or stopped turn, and the asker line above the prompt', () => {
  const { host, p } = mount();
  const base = toLocalMessages(hostTurn());
  p.render(model(base, { end: { kind: 'failed', text: '<b>Failed: runtime error</b>' } }));
  let end = host.querySelector('.team-turn-pop__end');
  assert.equal(end.getAttribute('data-end-kind'), 'failed');
  assert.equal(end.getAttribute('data-pop-key'), 'end');
  assert.equal(end.textContent, '<b>Failed: runtime error</b>', 'escaped');
  assert.ok(host.querySelector('article.chat-entry.assistant').compareDocumentPosition(end) & 4, 'after the assistant article');
  p.render(model(base, { end: { kind: 'stopped', text: 'Stopped' } }));
  end = host.querySelector('.team-turn-pop__end');
  assert.equal(end.getAttribute('data-end-kind'), 'stopped');
  p.render(model(base, { end: null }));
  assert.equal(host.querySelector('.team-turn-pop__end'), null);
  p.render(model(base, { promptBy: '<img src=x onerror=alert(1)>Brendan' }));
  const by = host.querySelector('[data-pop-key="prompt-by"]');
  assert.equal(by.getAttribute('dir'), 'auto');
  assert.equal(by.textContent, 'Asked by <img src=x onerror=alert(1)>Brendan');
  assert.equal(host.querySelector('img'), null);
  assert.ok(by.compareDocumentPosition(host.querySelector('article.chat-entry.user')) & 4, 'above the prompt');
  p.render(model(base, { promptBy: '\u{1F600}'.repeat(80) }));
  assert.equal(Array.from(host.querySelector('[data-pop-key="prompt-by"]').textContent.replace('Asked by ', '')).length, 64, 'capped at 64 code points');
  p.render(model(base, { promptBy: '' }));
  assert.equal(host.querySelector('[data-pop-key="prompt-by"]'), null);
});

test('(p) aria-busy follows live; a toggle is applied once per click; dispose clears the session tool-row state', () => {
  const tools = require('../renderer/chat/renderer-turn-row-tool-render-utils');
  const calls = [];
  const env = dom();
  const spy = (rowKey, expanded) => { calls.push(rowKey); tools.setToolRowExpansion(rowKey, expanded); };
  const p = createTurnPop({ host: env.host, doc: env.doc, markdown, sessionKey: 'team-proj-9-conv-9', deps: { setToolRowExpansion: spy } });
  const messages = toLocalMessages(hostileTurn());
  p.render(model(messages, { live: true }));
  const aside = env.host.querySelector('aside.team-turn-pop');
  assert.equal(aside.getAttribute('aria-busy'), 'true');
  p.render(model(messages));
  assert.equal(aside.hasAttribute('aria-busy'), false);
  const keys = Array.from(env.host.querySelectorAll('.tool-call-row')).map((n) => n.getAttribute('data-tool-row-key'));
  env.host.querySelector('[data-tool-row-toggle]').click();
  for (let i = 0; i < 3; i += 1) p.render(model([...messages], { note: 'n' + i }));
  assert.deepEqual(calls, [keys[0]], 'set once for one click');
  assert.equal(tools.getToolRowExpansion(keys[0]), true);
  tools.setToolRowExpansion('session=local-chat|row', true);
  // Control: a collapsed row of another popover session has a detail context to materialize.
  const other = mount();
  other.p.render(model(messages));
  const otherKey = other.host.querySelectorAll('.tool-call-row')[1].getAttribute('data-tool-row-key');
  assert.equal(tools.materializeToolRowDetails(otherKey).ok, true);
  p.dispose();
  assert.equal(tools.getToolRowExpansion(keys[0]), undefined, 'the override is gone');
  assert.equal(tools.materializeToolRowDetails(keys[1]).reason, 'missing_render_context', 'the detail context is gone');
  assert.equal(tools.getToolRowExpansion('session=local-chat|row'), true, 'the local chat keeps its own');
  other.p.dispose();
});

test('(q) with the live box on, a streaming reasoning body is held by the local live-box follow until dispose', () => {
  const window = new JSDOM('<!doctype html><html data-reasoning-live-box="on"><body><div id="host"></div></body></html>').window;
  const host = window.document.getElementById('host');
  const p = createTurnPop({ host, doc: window.document, markdown, sessionKey: 'team-proj-1-conv-1' });
  p.render(liveModel(liveTurn('Writing')));
  const body = host.querySelector('.reasoning-row-panel-body');
  assert.equal(body.getAttribute('data-live-box'), 'true');
  p.render(liveModel(liveTurn('Writing more')));
  assert.equal(host.querySelector('.reasoning-row-panel-body'), body);
  assert.equal(body.getAttribute('data-live-box'), 'true', 'still held after a repaint');
  p.dispose();
  assert.equal(body.hasAttribute('data-live-box'), false);
});

// ------------------------------------------------------------ row 175, wave 2: Jenny's edits as diffs, the compaction line

// `tag` keeps the call ids apart: a tool row's open state is remembered per session, turn and call across these tests.
const editTurn = (calls, tag) => {
  const out = [{ id: 'u1', role: 'user', content: 'Fix the title', author: { kind: 'member', member_id: 'm1' }, turn_id: TURN, status: 'complete' }];
  calls.forEach(([tool, input], i) => {
    out.push({ id: 'tu' + i, role: 'assistant', kind: 'tool_use', content: tool, status: 'complete', turn_id: TURN,
      tool_call: { call_id: tag + i, tool_name: tool, input_json: JSON.stringify(input), status: 'completed' } },
    { id: 'tr' + i, role: 'tool', kind: 'tool_result', content: '', status: 'complete', turn_id: TURN,
      tool_result: { call_id: tag + i, tool_name: tool, output_text: 'ok', is_error: false, duration_ms: 10 } });
  });
  out.push({ id: 'a9', role: 'assistant', content: 'Changed it.', status: 'complete', turn_id: TURN });
  return out;
};
const openRows = (host) => host.querySelectorAll('[data-tool-row-toggle]').forEach((toggle) => toggle.click());

test('(r) a write_file and an edit_file row show the change as the local diff row, escaped, closed until opened', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const { host, p } = mount();
  p.render(model(toLocalMessages(editTurn([['write_file', { path: 'notes/a.md', content: '# Title\n' + hostile + '\n' }],
    ['edit_file', { file_path: 'src/b.js', old_string: 'let a = 1;', new_string: 'let a = 2;\nlet b = 3;' }]], 'dr'))));
  const rows = host.querySelectorAll('.tool-call-row');
  assert.equal(rows.length, 2);
  assert.deepEqual([...rows].map((r) => r.getAttribute('data-expanded')), ['false', 'false'], 'collapsed like the local tool rows');
  openRows(host);
  const diffs = host.querySelectorAll('.tool-call-row .file-diff');
  assert.equal(diffs.length, 2, 'one diff row per call');
  const write = diffs[0];
  assert.equal(write.querySelectorAll('.diff-line-add').length, 2, 'a final newline is not a line');
  assert.equal(write.querySelectorAll('.diff-line-remove').length, 0);
  assert.ok(write.textContent.includes(hostile), 'the text is data');
  assert.equal(host.querySelector('img'), null, 'nothing was parsed as markup');
  const edit = diffs[1];
  assert.deepEqual([...edit.querySelectorAll('.diff-line-remove .diff-content')].map((n) => n.textContent), ['let a = 1;']);
  assert.deepEqual([...edit.querySelectorAll('.diff-line-add .diff-content')].map((n) => n.textContent), ['let a = 2;', 'let b = 3;']);
  assert.equal(host.querySelector(AFFORDANCES), null);
  assert.equal(host.querySelector('[data-jenny-open-change-diff]'), null, 'no Open in editor: the file is on the host');
  assert.equal(anyInvAttribute(host), false);
});

test('(s) a change too long to draw says so quietly, without its text', () => {
  const { host, p } = mount();
  p.render(model(toLocalMessages(editTurn([['write_file', { path: 'big.txt', content: 'SECRETWORD\n'.repeat(401) }]], 'ds'))));
  openRows(host);
  assert.equal(host.querySelectorAll('.diff-line').length, 0);
  const note = host.querySelector('.tool-call-row .file-diff-truncated');
  assert.equal(note.textContent, 'Change too long to show here.');
  assert.equal(host.textContent.includes('SECRETWORD'), false);
  assert.match(host.querySelector('.tool-call-row .file-diff-path').textContent, /big\.txt/);
});

test('(t) a compaction notice is one fixed quiet line at its place; none without a notice', () => {
  const { host, p } = mount();
  const messages = editTurn([['write_file', { path: 'a.txt', content: 'x' }]], 'dc');
  messages.splice(1, 0, { id: 'a0', role: 'assistant', content: 'Starting.', status: 'complete', turn_id: TURN,
    context_compacted: { strategy: 'summary', tokensBefore: 9000, tokensAfter: 2000, phase: 'preflight', summaryExcerpt: 'PRIVATE SUMMARY', occurredAt: '2026-11-17T10:00:00Z' } });
  p.render(model(toLocalMessages(messages)));
  const notes = host.querySelectorAll('.team-turn-pop__compact');
  assert.equal(notes.length, 1, 'once');
  assert.equal(notes[0].textContent, 'Jenny summarised earlier turns to make room. Older details may be forgotten.');
  assert.equal(notes[0].getAttribute('role'), 'note');
  assert.equal(host.textContent.includes('PRIVATE SUMMARY'), false);
  assert.equal(host.textContent.includes('9000'), false, 'no token counts');
  const rows = [...host.querySelectorAll('[data-row-id]')].map((r) => r.getAttribute('data-row-kind'));
  assert.ok(rows.indexOf('system_notice') > rows.indexOf('user_bubble') && rows.indexOf('system_notice') < rows.lastIndexOf('assistant_text'), 'between the prompt and the answer');
  p.render(model(toLocalMessages(editTurn([['write_file', { path: 'a.txt', content: 'x' }]], 'dc'))));
  assert.equal(host.querySelector('.team-turn-pop__compact'), null);
});
