'use strict';

// new-test-file: renderer-team-turn-pop.test.js is at 573 lines. Team review fixes, Part III performance 2: the popover patches
// the sanitized fragment itself (no serialize and second parse) and a streaming tick sweeps only the rows that changed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const pop = require('../renderer/team/renderer-team-turn-pop');
const { escapeHtml } = require('../renderer/shared/string-utils');

const { toLocalMessages, liveMessage, turnBodyHtml, createTurnPop } = pop;

const TURN = 'turn-1';
const KEY = 'team-proj-1-conv-1';
const markdown = (text) => '<p>' + escapeHtml(String(text || '')) + '</p>';

function hostTurn() {
  return [
    { id: 'u1', role: 'user', content: 'Check the meta description in index.html', author: { kind: 'member', member_id: 'm1' }, turn_id: TURN, timestamp: '2026-11-16T09:31:00.000Z', status: 'complete' },
    { id: 'a1', role: 'assistant', content: '', status: 'complete', turn_id: TURN, reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'Reading what the hero line promises first' }] } },
    { id: 't1', role: 'assistant', kind: 'tool_use', content: 'read_file', status: 'complete', turn_id: TURN, tool_call: { call_id: 'c1', tool_name: 'read_file', input_json: '{"path":"index.html"}', status: 'completed' } },
    { id: 't2', role: 'tool', kind: 'tool_result', content: '', status: 'complete', turn_id: TURN, tool_result: { call_id: 'c1', tool_name: 'read_file', output_text: '<meta name="description" content="Acme">', is_error: false, duration_ms: 400, metadata: { path: 'C:/x' } } },
    { id: 't3', role: 'assistant', kind: 'tool_use', content: 'read_file', status: 'complete', turn_id: TURN, tool_call: { call_id: 'c2', tool_name: 'read_file', input_json: '{"path":"site/app.js"}', status: 'completed' } },
    { id: 't4', role: 'tool', kind: 'tool_result', content: '', status: 'complete', turn_id: TURN, tool_result: { call_id: 'c2', tool_name: 'read_file', output_text: 'const a = 1;', is_error: false, duration_ms: 90, metadata: { path: 'C:/y' } } },
  ];
}
const model = (messages, extra = {}) => ({ turnId: TURN, title: 'Jenny’s work', sub: 'Brendan’s turn', live: false, canStop: false, canPrev: false, canNext: false, messages, extraHtml: '', note: '', ...extra });
function mount(paths) {
  const window = new JSDOM('<!doctype html><body><div id="host"></div></body>').window;
  const doc = window.document;
  const host = doc.getElementById('host');
  return { doc, host, p: createTurnPop({ host, doc, markdown, sessionKey: KEY, paths }) };
}

test('the popover body is the same DOM the string path gives for the same turn', () => {
  const messages = toLocalMessages(hostTurn());
  const { host, doc, p } = mount();
  p.render(model(messages));
  const expected = doc.createElement('div');
  expected.innerHTML = turnBodyHtml({ messages, markdown, doc, sessionKey: KEY, turnId: TURN });
  const scroll = host.querySelector('.team-turn-pop__scroll');
  assert.ok(scroll.querySelector('.tool-call-row'), 'the chain drew the turn');
  assert.equal(scroll.innerHTML, expected.innerHTML);
});

test('a streaming tick sweeps only the live row: the rows that did not change are not walked again, and still draw the same', () => {
  let walked = 0;
  const paths = { enabled: () => true, adopt: () => { walked += 1; return false; } };
  const { host, p } = mount(paths);
  const base = toLocalMessages(hostTurn());
  const live = (text) => liveMessage({ stream: { id: 's1', text, reasoning: [] }, turnId: TURN, model: 'qwen3:30b' });
  p.render(model([...base, live('Writing')], { live: true }));
  const first = walked;
  const toolRow = host.querySelector('.chat-row[data-row-kind="tool_call"]');
  assert.ok(first > 0 && toolRow, 'the first draw walks every row');
  walked = 0;
  p.render(model([...base, live('Writing the description now')], { live: true }));
  assert.ok(walked > 0, 'the live row is walked');
  assert.ok(walked * 2 < first, 'but far fewer elements than the whole body (' + walked + ' of ' + first + ')');
  assert.match(host.querySelector('[data-streaming-row="true"]').textContent, /Writing the description now/, 'the live text is the new one');
  assert.equal(host.querySelector('.chat-row[data-row-kind="tool_call"]'), toolRow, 'the settled rows keep their nodes');
  assert.equal(host.querySelectorAll('.tool-call-row').length, 2, 'and none is drawn twice');
});
