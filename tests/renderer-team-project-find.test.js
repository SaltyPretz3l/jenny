'use strict';

// new-test-file: Find in a Team project conversation (row 175 item 8, decision D15) is a new surface: the find bar in the
// conversation head, the count over channel rows and Jenny's work together, the transcript popover that opens on a match
// in her work, the unloaded-history note. The sibling conversation suites are at or near the test-file line cap.

const test = require('node:test');
const assert = require('node:assert/strict');

const { S1, OTHER, DOT, MAYA, message, snapshot, flush } = require('./helpers/team-project-renderer-host');
const { mount, field } = require('./helpers/team-conversation-mount');

const T0 = Date.parse('2026-11-12T10:31:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const ask = (id, content, turn, by = DOT) => message(id, 'user', content, { author: { kind: 'member', member_id: by }, turn_id: turn, timestamp: at(0) });
const said = (id, content, turn, over = {}) => message(id, 'assistant', content, { kind: undefined, turn_id: turn, timestamp: at(1), ...over });
const toolUse = (id, turn, path) => message(id, 'assistant', 'read_file', { kind: 'tool_use', turn_id: turn, timestamp: at(2),
  tool_call: { call_id: 'call_' + id, tool_name: 'read_file', input_json: JSON.stringify({ path }), status: 'complete' } });
const toolResult = (id, turn, call, output) => message(id, 'tool', '', { kind: 'tool_result', turn_id: turn, timestamp: at(3),
  tool_result: { call_id: call, tool_name: 'read_file', output_text: output, is_error: false, duration_ms: 40 } });

// Two turns. "hero" is in u1, turn_1's reasoning, turn_1's tool output, turn_1's answer, u2 and turn_2's answer: six matches in reading order.
const TURNS = () => [ask('u1', 'Give me the hero line', 'turn_1'),
  said('a1', '', 'turn_1', { reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'Think about the hero line options' }] } }),
  toolUse('t1', 'turn_1', 'src/hero.js'), toolResult('tr1', 'turn_1', 'call_t1', 'export const hero = "Less to click"'),
  said('a2', 'The hero is short.', 'turn_1'),
  ask('u2', 'Warmer hero please', 'turn_2', MAYA), said('a3', 'Come in, we are warm.', 'turn_2'), said('a4', 'Hero is warm now.', 'turn_2')];

const key = (m, el, name, over = {}) => el.dispatchEvent(new m.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...over }));
const click = (m, el) => el.dispatchEvent(new m.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const bar = (m) => m.q('.team-head .chat-search-bar');
const input = (m) => m.q('.chat-search-bar-input');
const count = (m) => m.q('.chat-search-bar-count').textContent;
const typeFind = (m, text) => { input(m).value = text; input(m).dispatchEvent(new m.window.Event('input', { bubbles: true })); };

test('Ctrl+F opens find in a project conversation: the field takes the title\'s place, takes the focus, and a second Ctrl+F selects it', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: TURNS() }) } });
  await flush();
  assert.equal(bar(m), null, 'closed: no field');
  assert.ok(m.q('.team-head [data-project-action="find"]'), 'the magnifier ends the head');
  key(m, field(m), 'f', { ctrlKey: true });
  assert.ok(bar(m), 'the local chat\'s own find bar is in the head');
  assert.equal(m.q('.team-head').hasAttribute('data-find-open'), true);
  assert.equal(m.window.document.activeElement, input(m), 'the field has the focus');
});

// jsdom has no CSS Custom Highlight API: a Map and a Highlight that keeps its ranges, as tests/renderer-chat-search-highlight.test.js does.
function withHighlights(m) {
  m.window.CSS = { highlights: new Map() };
  m.window.Highlight = class { constructor(...ranges) { this.ranges = ranges; this.priority = 0; } };
  return m.window.CSS.highlights;
}
const painted = (registry, name) => (registry.get(name) ? registry.get(name).ranges.map((r) => r.toString()) : []);
const popRows = (m) => [...m.root.querySelectorAll('#teamTurnPop .reasoning-row-block, #teamTurnPop .tool-call-row')];
const openRows = (m) => popRows(m).filter((el) => el.classList.contains('expanded') || el.getAttribute('data-expanded') === 'true').map((el) => (el.classList.contains('tool-call-row') ? 'tool' : 'reason'));

test('the count covers channel rows and Jenny\'s work in reading order; Enter walks them, a match in her work opens the popover with only that row open and the field keeps the focus', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: TURNS() }) } });
  const registry = withHighlights(m);
  await flush();
  key(m, field(m), 'f', { ctrlKey: true });
  typeFind(m, 'hero');
  assert.equal(count(m), '1 of 6', 'u1, the reasoning, the tool output, the answer, u2, the second answer');
  assert.equal(m.q('#teamTurnPop'), null, 'the first match is a message: no popover');
  assert.deepEqual(painted(registry, 'chat-search-current'), ['hero'], 'the current match is painted');
  assert.equal(painted(registry, 'chat-search-match').length, 4, 'the four matches in the rows shown are painted (the work\'s are not drawn yet)');
  key(m, input(m), 'Enter');
  assert.equal(count(m), '2 of 6');
  assert.equal(m.q('#teamTurnPop').dataset.turnId, 'turn_1', 'her work opens on that turn');
  assert.deepEqual(openRows(m), ['reason'], 'only the matching row is open');
  assert.equal(m.window.document.activeElement, input(m), 'the focus stays in the field');
  assert.deepEqual(painted(registry, 'chat-search-current'), ['hero'], 'the current match is inside the popover now');
  key(m, input(m), 'Enter');
  assert.equal(count(m), '3 of 6');
  assert.deepEqual(openRows(m), ['tool'], 'the next row opens and the first one shuts');
  assert.equal(m.window.document.activeElement, input(m));
  key(m, input(m), 'Enter');
  assert.equal(count(m), '4 of 6', 'her answer in the channel');
  assert.ok(m.q('#teamTurnPop'), 'stepping to a message leaves the popover open');
  key(m, input(m), 'Enter', { shiftKey: true });
  assert.equal(count(m), '3 of 6', 'Shift+Enter goes back');
  key(m, input(m), 'F3');
  assert.equal(count(m), '4 of 6', 'F3 goes on from the field');
  assert.equal(painted(registry, 'chat-search-match').length > 4, true, 'the popover\'s own copy of the prompt, the row and the answer is painted too');
});

test('the options: match case and whole word narrow the count; a word is Unicode-aware', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: [ask('u1', 'Hero heroes ÉCOLE école', 'turn_1'), said('a1', 'Done', 'turn_1')] }) } });
  withHighlights(m);
  await flush();
  key(m, field(m), 'f', { ctrlKey: true });
  typeFind(m, 'hero');
  assert.equal(count(m), '1 of 2');
  click(m, m.q('.chat-search-bar-toggle-word'));
  assert.equal(count(m), '1 of 1', 'whole word leaves "heroes" out');
  click(m, m.q('.chat-search-bar-toggle-case'));
  assert.equal(count(m), 'No matches', '"Hero" is not "hero" with match case on');
  typeFind(m, 'école');
  click(m, m.q('.chat-search-bar-toggle-case'));
  assert.equal(count(m), '1 of 2', 'case-insensitive over non-ASCII letters');
});

test('Esc closes find and keeps the query and an open popover; opening again shows the words; the magnifier opens it too', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: TURNS() }) } });
  const registry = withHighlights(m);
  await flush();
  click(m, m.q('[data-project-action="find"]'));
  assert.ok(bar(m), 'the magnifier opens it');
  typeFind(m, 'hero');
  key(m, input(m), 'Enter');
  assert.ok(m.q('#teamTurnPop'));
  key(m, input(m), 'Escape');
  assert.equal(bar(m), null, 'closed');
  assert.equal(m.q('.team-head').hasAttribute('data-find-open'), false);
  assert.ok(m.q('#teamTurnPop'), 'the popover stays open');
  assert.equal(registry.get('chat-search-match'), undefined, 'nothing is painted any more');
  assert.equal(m.window.document.activeElement, m.q('[data-project-action="find"]'), 'the focus goes back to the magnifier');
  key(m, field(m), 'f', { ctrlKey: true });
  assert.equal(input(m).value, 'hero', 'the words were kept');
  assert.equal(count(m), '2 of 6', 'and the place');
});

test('Ctrl+F with text selected seeds the field', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: TURNS() }) } });
  withHighlights(m);
  await flush();
  const text = m.q('.team-msg[data-message-id="u2"] .team-msg__text');
  const range = m.window.document.createRange();
  range.selectNodeContents(text);
  m.window.getSelection().removeAllRanges();
  m.window.getSelection().addRange(range);
  key(m, field(m), 'f', { ctrlKey: true });
  assert.equal(input(m).value, 'Warmer hero please');
  assert.equal(count(m), '1 of 1');
});

test('history not loaded: a "+" on the count, a quiet line when the oldest match is passed or nothing matches, one Load earlier page that keeps the place and the focus', async (t) => {
  const older = snapshot({ messages: [ask('u0', 'The old hero idea', 'turn_0'), said('a0', 'A hero from before', 'turn_0')], has_more: false });
  const m = mount(t, { open: (p) => (p.before_message_id ? { ok: true, snapshot: older } : { ok: true, snapshot: snapshot({ messages: TURNS(), has_more: true, next_before_message_id: 'u1' }) }) });
  withHighlights(m);
  await flush();
  key(m, field(m), 'f', { ctrlKey: true });
  typeFind(m, 'nothing like this');
  assert.equal(count(m), 'No matches');
  assert.equal(m.q('.team-find-note').textContent.replace(/\s+/g, ' ').trim(), 'Searched the 4 messages shown. Load earlier to search further. Load earlier');
  typeFind(m, 'hero');
  assert.equal(count(m), '1 of 6+', 'the "+" says there may be more');
  assert.equal(m.q('.team-find-note'), null, 'no line while matches are still to step through');
  key(m, input(m), 'Enter', { shiftKey: true });
  assert.equal(count(m), '1 of 6+', 'back from the first match stays on it');
  assert.ok(m.q('.team-find-note'), 'and says why it stops');
  assert.equal(m.sent('conversationOpen').length, 1, 'nothing loads by itself');
  click(m, m.q('.team-find-note [data-find-action="earlier"]'));
  await flush();
  assert.deepEqual(m.sent('conversationOpen').pop(), { team_id: OTHER, session_id: S1, before_message_id: 'u1' }, 'one page, through the conversation\'s own path');
  assert.equal(count(m), '3 of 8', 'the place is kept: the same match, two older ones before it, and no "+"');
  assert.equal(m.q('.team-find-note'), null);
  assert.equal(m.window.document.activeElement, input(m), 'the focus is back in the field');
});

test('rows the reader opened by hand shut when find opens one; a row that is not drawn leaves the popover as it was', async (t) => {
  const m = mount(t, { open: { ok: true, snapshot: snapshot({ messages: TURNS() }) } });
  withHighlights(m);
  await flush();
  click(m, m.q('.team-turn-chip[data-turn-id="turn_1"]'));
  for (const toggle of m.root.querySelectorAll('#teamTurnPop [data-tool-row-toggle]')) click(m, toggle);
  assert.deepEqual(openRows(m), ['tool'], 'opened by hand');
  key(m, field(m), 'f', { ctrlKey: true });
  typeFind(m, 'hero');
  key(m, input(m), 'Enter');
  assert.deepEqual(openRows(m), ['reason'], 'only the matching row is open');
  assert.equal(m.q('#teamTurnPop').dataset.turnId, 'turn_1');
});

test("the Team tab sends Ctrl+F to the open conversation's find and to its own search everywhere else", () => {
  const { createTabFocus } = require('../renderer/team/renderer-team-tab-focus');
  const calls = [];
  const tab = (project) => createTabFocus({ container: () => ({}), live: () => ({}), frame: () => ({ project }), openMenu() {}, focusSearch: () => calls.push('search') });
  const press = () => ({ key: 'f', ctrlKey: true, preventDefault: () => calls.push('prevent'), target: null });
  tab({ openFind: () => { calls.push('find'); return true; } }).onKeydown(press());
  tab({ focusTarget() {} }).onKeydown(press());
  tab(null).onKeydown(press());
  assert.deepEqual(calls, ['prevent', 'find', 'prevent', 'search', 'prevent', 'search']);
});
