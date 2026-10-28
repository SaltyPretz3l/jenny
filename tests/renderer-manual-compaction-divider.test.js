// A manual compaction (/compact, the meter's Compact now) has no turn: its
// "Context compacted" divider is projected from the session summary's
// compaction_context into the turn that ends at the snapshot's boundary
// message (renderer-manual-compaction-divider.js, wired in hydration).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  resolveManualCompaction,
  appendManualCompactionRow,
} = require('../renderer/chat/renderer-manual-compaction-divider');
const { createTranscriptThinkingRenderer } = require('../renderer/chat/renderer-transcript-thinking');
const {
  createPipelineHarness,
  withWindowGlobals,
  createRenderDom,
} = require('./helpers/render-pipeline-test-harness');

const SESSION_ID = 'session-source';

function manualContext(overrides = {}) {
  return {
    origin: 'manual', created_at: '2026-10-20T12:50:23.929Z', strategy: 'full',
    tokens_before: 23666, tokens_after: 2273, boundary_message_id: 'a1', boundary_message_count: 2,
    ...overrides,
  };
}

function stateWith(context) {
  return { sessions: [{ id: SESSION_ID, compaction_context: context }] };
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

test('only a manual snapshot with a boundary id resolves a divider', () => {
  assert.equal(resolveManualCompaction(stateWith(manualContext({ origin: 'automatic' })), SESSION_ID), null);
  assert.equal(resolveManualCompaction(stateWith(manualContext({ boundary_message_id: '' })), SESSION_ID), null);
  assert.equal(resolveManualCompaction(stateWith(null), SESSION_ID), null);
  assert.equal(resolveManualCompaction(stateWith(manualContext()), 'other-session'), null);

  const divider = resolveManualCompaction(stateWith(manualContext()), SESSION_ID);
  assert.equal(divider.boundaryMessageId, 'a1');
  assert.deepEqual({ ...divider.contextCompacted }, {
    strategy: 'full', phase: 'manual', tokensBefore: 23666, tokensAfter: 2273,
    summaryStatus: 'created', summaryPersisted: true, occurredAt: '2026-10-20T12:50:23.929Z',
  });
  assert.notEqual(
    resolveManualCompaction(stateWith(manualContext({ tokens_after: 2000 })), SESSION_ID).key,
    divider.key,
    'a new compaction at the same boundary changes the key',
  );
});

test('the divider row joins only the boundary turn, at its end, without touching the cached rows', () => {
  const divider = resolveManualCompaction(stateWith(manualContext()), SESSION_ID);
  const rows = Object.freeze([
    { kind: 'user_bubble', render_message_id: 'u1' },
    { kind: 'assistant_text', render_message_id: 'a1' },
  ]);
  assert.equal(appendManualCompactionRow(rows, { turn_id: 't0', source_message_ids: ['u0', 'a0'] }, divider), rows);
  assert.equal(appendManualCompactionRow(rows, { turn_id: 't1', source_message_ids: ['u1', 'a1'] }, null), rows);

  const next = appendManualCompactionRow(rows, { turn_id: 't1', source_message_ids: ['u1', 'a1'] }, divider);
  assert.notEqual(next, rows);
  assert.equal(next.length, 3);
  const row = next[2];
  assert.equal(row.kind, 'system_notice');
  assert.equal(row.turn_id, 't1');
  assert.equal(row.render_message_id, 'a1', 'renders in the article of the turn\'s last reply');
  assert.equal(row.primary_message_id, 'manual-compaction:a1', 'never a real message id');
  assert.equal(row.payload.subkind, 'context_compacted');

  const userOnly = [{ kind: 'user_bubble', render_message_id: 'u1' }];
  assert.equal(appendManualCompactionRow(userOnly, { turn_id: 't1', source_message_ids: ['u1', 'a1'] }, divider), userOnly,
    'no reply article to join: no divider');
});

test('a manual entry reads as compacted on request, for future turns', () => {
  const renderer = createTranscriptThinkingRenderer({ escapeHtml });
  const divider = resolveManualCompaction(stateWith(manualContext()), SESSION_ID);
  const html = renderer.renderContextCompactedNotice({ id: 'manual-compaction:a1', context_compacted: divider.contextCompacted });
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector('.context-compacted-notice-label').textContent, 'Context compacted');
  assert.match(document.querySelector('.context-compacted-notice-status').textContent, /23,666 → 2,273 tokens/);
  assert.match(html, /Older turns were summarized for future turns/);
  assert.match(html, /Compacted on request/);
  assert.doesNotMatch(html, /for this request/);
});

test('the rendered timeline shows the divider after the boundary reply and drops it when the snapshot is not manual', (t) => {
  const dom = createRenderDom();
  const { pipeline, state } = createPipelineHarness({
    dom,
    visibleMessages: [
      { id: 'u1', role: 'user', content: 'Compact me', status: 'complete', timestamp: '2026-10-20T12:49:00.000Z' },
      { id: 'a1', role: 'assistant', content: 'Manual divider reply marker.', status: 'complete',
        finalizedAt: '2026-10-20T12:49:05.000Z', timestamp: '2026-10-20T12:49:05.000Z' },
    ],
    rowModelEnabled: true,
    callbacks: { renderContextCompactedNotice: createTranscriptThinkingRenderer({ escapeHtml }).renderContextCompactedNotice },
  });
  state.ui.chatTimelineRowModelBySession.set(SESSION_ID, true);
  t.after(() => { pipeline.dispose?.(); });

  withWindowGlobals(dom, () => {
    const timeline = () => dom.window.document.getElementById('timeline');
    pipeline.renderMessages({});
    assert.equal(timeline().querySelector('.context-compacted-notice'), null);

    // The summary refresh after a saved /compact changes no message.
    state.sessions = [{ id: SESSION_ID, compaction_context: manualContext() }];
    pipeline.renderMessages({});
    const notice = timeline().querySelector('.context-compacted-notice');
    assert.ok(notice, 'a summary-only change repaints with the divider');
    const reply = [...timeline().querySelectorAll('.chat-entry')].find((node) => node.textContent.includes('Manual divider reply marker.'));
    assert.ok(reply && reply.contains(notice), 'inside the boundary reply\'s article');
    const position = reply.textContent.indexOf('Manual divider reply marker.');
    assert.ok(position >= 0 && position < reply.textContent.indexOf('Context compacted'), 'after the reply text');

    state.sessions = [{ id: SESSION_ID, compaction_context: manualContext({ origin: 'automatic' }) }];
    pipeline.renderMessages({});
    assert.equal(timeline().querySelector('.context-compacted-notice'), null, 'an automatic snapshot has its own turn notice');
  });
});
