'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { BrowserConversationController } = require('../../renderer/browser/browser-conversation');
const view = require('../../renderer/browser/browser-view');

function harness(t) {
  const instance = new JSDOM('<!doctype html><div id="root"><div data-live></div></div>');
  global.window = instance.window;
  global.document = instance.window.document;
  const root = instance.window.document.getElementById('root');
  const state = { selectedSessionId: 'session_a', liveProjection: null, activeStreamId: '' };
  const controller = new BrowserConversationController({
    getState: () => state,
    getRoot: () => root,
    render: () => view.renderLive(root, state),
  });
  t.after(() => {
    controller.dispose();
    instance.window.close();
    delete global.window;
    delete global.document;
  });
  const feed = (type, fields = {}) => controller.applyStreamEvent({ stream_id: 'stream_a', type, ...fields });
  feed('started');
  return { root, state, feed };
}

test('discarding reset folds the erased draft, survives deltas, and disappears on complete', (t) => {
  const { root, state, feed } = harness(t);
  feed('delta', { content: 'Erased **first** ' });
  feed('delta', { content: 'draft' });
  feed('stream_reset', { discard_scope: 'all', reason: 'provider_retry' });
  assert.equal(state.liveProjection.current_segment_text, '');
  feed('delta', { content: 'Replacement only' });
  const folds = root.querySelectorAll('.browser-live-discarded');
  assert.equal(folds.length, 1);
  assert.equal(folds[0].open, false);
  assert.equal(folds[0].querySelector('summary').textContent,
    'Draft discarded · the engine dropped the reply, so Jenny asked again');
  assert.match(folds[0].querySelector('.browser-live-discarded-body').textContent, /Erased first draft/);
  assert.equal(folds[0].querySelector('strong').textContent, 'first');
  assert.match(folds[0].textContent, /Not saved\. Shown only while this reply is streaming\./);
  assert.equal(root.querySelector('.browser-live-answer').textContent.trim(), 'Replacement only');
  feed('complete');
  assert.equal(state.liveProjection, null);
  assert.equal(root.querySelector('.browser-live-discarded'), null);
  assert.equal(root.querySelector('[data-live]').textContent, '');
});

test('none reset preserves answer, segment and reasoning without recording a draft', (t) => {
  const { root, state, feed } = harness(t);
  feed('delta', { content: 'Kept ', reasoning: [{ id: 'r1', text: 'Kept thinking' }] });
  feed('delta', { content: 'draft' });
  feed('stream_reset', { discard_scope: 'none', reason: 'tool_continuation', reasoning: [] });
  assert.equal(state.liveProjection.assistant_text, 'Kept draft');
  assert.equal(state.liveProjection.current_segment_text, 'Kept draft');
  assert.deepEqual(state.liveProjection.reasoning, [{ id: 'r1', text: 'Kept thinking' }]);
  feed('delta', { content: ' continued' });
  assert.equal(root.querySelector('.browser-live-discarded'), null);
  assert.equal(state.liveProjection.discarded_drafts, undefined);
  assert.equal(root.querySelector('.browser-live-answer').textContent.trim(), 'Kept draft continued');
});

test('discarded answer and reasoning are capped independently without splitting surrogate pairs', (t) => {
  const { root, state, feed } = harness(t);
  feed('delta', { content: 'x'.repeat(5000) });
  feed('stream_reset', { discard_scope: 'all' });
  const body = root.querySelector('.browser-live-discarded-body');
  assert.ok(body);
  assert.equal(body.querySelector('p').textContent.length, 4000);
  assert.match(body.textContent, /Trimmed\./);
  assert.deepEqual(state.liveProjection.discarded_drafts[0], {
    reason: 'unknown', text: 'x'.repeat(4000), text_trimmed: true,
    reasoning_text: '', reasoning_trimmed: false,
  });
  const boundary = `${'y'.repeat(3999)}😀tail`;
  feed('delta', { content: boundary, reasoning: [{ id: 'r1', text: boundary }] });
  feed('stream_reset', { discard_scope: 'live_slice', reason: 'model_winddown' });
  const draft = state.liveProjection.discarded_drafts[1];
  assert.equal(draft.text, 'y'.repeat(3999));
  assert.equal(draft.reasoning_text, 'y'.repeat(3999));
  assert.equal(draft.text_trimmed, true);
  assert.equal(draft.reasoning_trimmed, true);
});

test('legacy and live-slice resets retain only the newest eight nonblank drafts in order', (t) => {
  const { root, state, feed } = harness(t);
  for (let index = 0; index < 10; index += 1) {
    feed('delta', { content: `Draft ${index}` });
    feed('stream_reset', index % 2 ? { discard_scope: 'live_slice' } : {});
  }
  assert.equal(state.liveProjection.discarded_drafts.length, 8);
  assert.deepEqual(state.liveProjection.discarded_drafts.map((draft) => draft.text),
    Array.from({ length: 8 }, (_, index) => `Draft ${index + 2}`));
  feed('delta', { content: ' \n', reasoning: [{ id: 'blank', content: ' \t' }] });
  feed('stream_reset', { discard_scope: 'all' });
  assert.equal(state.liveProjection.assistant_text, '');
  assert.equal(state.liveProjection.current_segment_text, '');
  assert.deepEqual(state.liveProjection.reasoning, []);
  assert.equal(root.querySelectorAll('.browser-live-discarded').length, 8);
});

test('reasoning-only drafts use the content fallback, sanitize markdown and map unknown reasons', (t) => {
  const { root, state, feed } = harness(t);
  feed('delta', { reasoning: [{ id: 'r1', text: '**Thought**' },
    { id: 'r2', content: '<img src=x onerror=alert(1)>Next' }] });
  feed('stream_reset', { discard_scope: 'all', reason: '<img src=x onerror=alert(2)>' });
  const draft = state.liveProjection.discarded_drafts[0];
  assert.equal(draft.reason, '<img src=x onerror=alert(2)>');
  assert.equal(draft.reasoning_text, '**Thought**\n\n<img src=x onerror=alert(1)>Next');
  assert.equal(draft.text_trimmed, false);
  assert.equal(draft.reasoning_trimmed, false);
  feed('delta', { content: 'Next answer', reasoning: [{ id: 'r3', text: 'Live thinking' }] });
  const fold = root.querySelector('.browser-live-discarded');
  assert.equal(fold.querySelector('summary').textContent, 'Draft discarded · Jenny started this part over');
  assert.equal(fold.querySelector('strong').textContent, 'Thinking');
  assert.match(fold.textContent, /Thought/);
  assert.match(fold.textContent, /Next/);
  assert.equal(fold.querySelector('[onerror]'), null);
  assert.equal(fold.previousElementSibling.className, 'browser-live-reasoning');
  assert.equal(fold.nextElementSibling.className, 'browser-live-answer markdown-body');
  assert.doesNotMatch(fold.textContent, /Trimmed\./);
});

test('a newer snapshot of the same stream keeps the client-local discarded drafts', async () => {
  const { BrowserSnapshots } = require('../../renderer/browser/browser-snapshots');
  const drafts = [{ reason: 'provider_retry', text: 'Erased draft' }];
  for (const [streamId, kept] of [['stream_a', 1], ['stream_b', 0]]) {
    const state = {
      selectedSessionId: 'session_a', activeStreamId: 'stream_a', snapshot: null,
      liveProjection: { stream_id: 'stream_a', assistant_text: 'before', discarded_drafts: drafts },
    };
    const owner = {
      getState: () => state, isDisposed: () => false, getGeneration: () => 1, bridge: { cursor: 0 },
      syncControlFromSnapshot() {}, render() {}, handleEvent() {}, setError() {}, normalizeReason: String,
      command: async () => ({ ok: true, snapshot: {
        session: { session_id: 'session_a', plan_mode: false }, cursor: 7, messages: [],
        active_turn: { stream_id: streamId }, live_projection: { stream_id: streamId, assistant_text: 'after' },
      } }),
    };
    await new BrowserSnapshots(owner).load('session_a');
    assert.equal(state.liveProjection.assistant_text, 'after');
    assert.equal((state.liveProjection.discarded_drafts || []).length, kept, streamId);
  }
});

test('an expanded fold stays open while the replacement keeps streaming', (t) => {
  const { root, feed } = harness(t);
  feed('delta', { content: 'Erased' });
  feed('stream_reset', { discard_scope: 'all', reason: 'provider_retry' });
  feed('delta', { content: 'Replacement' });
  root.querySelector('.browser-live-discarded').open = true;
  feed('delta', { content: ' continues' });
  const fold = root.querySelector('.browser-live-discarded');
  assert.equal(fold.open, true);
  assert.match(fold.textContent, /Erased/);
  assert.equal(root.querySelector('.browser-live-answer').textContent.trim(), 'Replacement continues');
});
