'use strict';

// "Started from {parent}" (row 59 checkpoint 5a-2): the existing conversation origin chip above
// the timeline keeps naming the parent of a linked child for good, from the summary spawned_from.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createChromePipeline } = require('../renderer/chat/renderer-render-pipeline-chrome');

const SPAWNED = { parent_session_id: 'sess_parent', parent_session_incarnation: 'inc_p', proposal_id: `proposal_${'a'.repeat(64)}`, created_at: '2026-10-15T16:00:00.000Z' };

function harness(t, sessions, messages = []) {
  const page = new JSDOM('<body><div class="origin-chip hidden" id="chip"><span id="label"></span></div><textarea></textarea></body>');
  const state = { sessions, currentSessionId: 'sess_child', ui: { activeView: 'chat' }, backend: { phase: 'ready' }, status: {} };
  const doc = page.window.document;
  const pipeline = createChromePipeline({
    state,
    dom: { chatOriginChip: doc.getElementById('chip'), chatOriginLabel: doc.getElementById('label'), chatInput: doc.querySelector('textarea') },
    callbacks: { getVisibleSessionMessages: () => messages },
  });
  t.after(() => { pipeline.dispose?.(); page.window.close(); });
  return { state, chip: doc.getElementById('chip'), label: doc.getElementById('label'), render: () => pipeline.renderOriginChip() };
}

const parent = { id: 'sess_parent', title: 'Benchmark the 128k setting', session_incarnation: 'inc_p' };
const child = (extra = {}) => ({ id: 'sess_child', title: 'Linked', spawned_from: SPAWNED, ...extra });

test('a linked child shows "Started from {parent}", before and after the first reply', (t) => {
  const reply = [{ role: 'assistant', kind: 'assistant', content: 'On it.' }];
  for (const messages of [[], reply]) {
    const { chip, label, render } = harness(t, [parent, child()], messages);
    render();
    assert.equal(chip.classList.contains('hidden'), false);
    assert.equal(label.textContent, 'Started from Benchmark the 128k setting');
  }
});

test('a deleted or replaced parent reads as an unavailable chat', (t) => {
  for (const sessions of [[child()], [{ ...parent, session_incarnation: 'inc_new' }, child()]]) {
    const { label, chip, render } = harness(t, sessions);
    render();
    assert.equal(chip.classList.contains('hidden'), false);
    assert.equal(label.textContent, 'Started from an unavailable chat');
  }
});

test('a chat started by /handoff shows "Continued from {source}" from its branch_origin', (t) => {
  const origin = { source_session_id: 'sess_parent', source_message_id: 'msg_1', source_title: 'Benchmark the 128k setting', created_at: '2026-10-18T10:00:00.000Z' };
  const { chip, label, render } = harness(t, [parent, { id: 'sess_child', title: 'Continued', branch_origin: origin }], []);
  render();
  assert.equal(chip.classList.contains('hidden'), false);
  assert.equal(label.textContent, 'Continued from Benchmark the 128k setting');
});

test('an ordinary chat keeps the chip hidden', (t) => {
  const { chip, render } = harness(t, [parent, { id: 'sess_child', title: 'Plain' }]);
  render();
  assert.equal(chip.classList.contains('hidden'), true);
});
