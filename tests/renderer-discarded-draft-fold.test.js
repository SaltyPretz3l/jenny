// "Draft discarded" fold (live) + settled receipt: the markup layer honors the
// reducer's discard_anchor / discard_hidden stamps (renderer-row-identity-utils,
// covered by renderer-discarded-draft-state.test.js) and the persisted
// message.discarded_drafts receipt. Nothing here reaches into production source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const { createHarness, flushMicrotasks } = require('./helpers/renderer-stream-handler-buffering-harness');
const { STREAM_ID, makeRig, payload } = require('./helpers/renderer-stream-reset-rig');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createRenderer() {
  return createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml,
    renderMarkdown: (text) => `<p>${escapeHtml(text)}</p>`,
    renderStreamingMarkdownUnits: (text) => ({
      html: `<p>${escapeHtml(text)}</p>`,
      units: [{ html: `<span>${escapeHtml(text)}</span>`, revealed: true, tail: true }],
      changedStartIndex: 0,
    }),
    renderThinkingWidget: (message) => `<div class="reasoning-test" data-message-id="${escapeHtml(message.id)}"></div>`,
    renderToolCallBlock: () => '',
    renderAgentStatusWidget: () => '',
    renderAssistantFailureNotice: () => '',
    renderContextCompactedNotice: () => '',
  });
}

function textRow(id, messageId, text, extra = {}) {
  return {
    row_id: id,
    turn_id: 'turn_1',
    kind: 'assistant_text',
    primary_message_id: messageId,
    segment_group_index: 0,
    payload: { text, segment_group_index: 0, ...extra },
  };
}

function reasoningRow(id, messageId, extra = {}) {
  return {
    row_id: id,
    turn_id: 'turn_1',
    kind: 'reasoning',
    primary_message_id: messageId,
    phase_id: 'phase_1',
    payload: { phase_id: 'phase_1', entries: [], ...extra },
  };
}

const anchor = (extra = {}) => ({
  discard_anchor: true, discard_reason: 'provider_retry', discard_text: 'OLD DRAFT', discard_reasoning_text: '', ...extra,
});
const count = (html, needle) => html.split(needle).length - 1;

test('anchor assistant_text row renders only a closed fold with the reason phrase', () => {
  const html = createRenderer().buildTurnRowListMarkup(
    [textRow('r1', 'assistant_1', '', anchor({ discard_text: '<script>alert(1)</script>\nsecond line' }))], []
  );
  assert.match(html, /<details class="chat-discarded-draft">/);
  assert.ok(!/<details[^>]*\bopen\b/.test(html), 'closed by default');
  assert.match(html, /Draft discarded/);
  assert.match(html, /the engine dropped the reply, so Jenny asked again/);
  assert.ok(!html.includes('<script>'), 'discarded text stays inert');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;\nsecond line/);
  assert.match(html, /Not saved\. Shown only while this reply is streaming\./);
  assert.ok(!html.includes('chat-bubble'), 'no bubble for the anchor row');
});

test('anchor reasoning row with only reasoning shows a Thinking section and no thinking widget', () => {
  const html = createRenderer().buildTurnRowListMarkup([
    reasoningRow('r1', 'assistant_1', anchor({ discard_text: '', discard_reasoning_text: 'weighing <b>options</b>' })),
  ], []);
  assert.match(html, /chat-discarded-draft/);
  assert.match(html, />Thinking</);
  assert.match(html, /weighing &lt;b&gt;options&lt;\/b&gt;/);
  assert.ok(!html.includes('reasoning-test'), 'no thinking widget');
  assert.ok(!html.includes('thinking-placeholder'), 'no thinking placeholder');
});

test('text-only fold omits the Thinking section; trimmed note appears only when capped', () => {
  const renderer = createRenderer();
  const plain = renderer.buildTurnRowListMarkup([textRow('r1', 'assistant_1', '', anchor())], []);
  assert.ok(!plain.includes('>Thinking<'));
  assert.ok(!plain.includes('Trimmed.'));
  const trimmed = renderer.buildTurnRowListMarkup(
    [textRow('r1', 'assistant_1', '', anchor({ discard_text_trimmed: true }))], []
  );
  assert.match(trimmed, /Trimmed\./);
});

test('hidden rows render nothing', () => {
  const renderer = createRenderer();
  const text = renderer.buildTurnRowListMarkup([textRow('r1', 'assistant_1', 'gone', { discard_hidden: true })], []);
  assert.ok(!text.includes('gone') && !text.includes('chat-bubble') && !text.includes('chat-discarded-draft'));
  const reasoning = renderer.buildTurnRowListMarkup([reasoningRow('r2', 'assistant_1', { discard_hidden: true })], []);
  assert.ok(!reasoning.includes('reasoning-test') && !reasoning.includes('chat-discarded-draft'));
});

test('unknown reason falls back to the generic phrase', () => {
  const renderer = createRenderer();
  const html = renderer.buildTurnRowListMarkup([textRow('r1', 'assistant_1', '', anchor({ discard_reason: 'something_new' }))], []);
  assert.match(html, /Jenny started this part over/);
  const missing = renderer.buildTurnRowListMarkup([textRow('r1', 'assistant_1', '', anchor({ discard_reason: undefined }))], []);
  assert.match(missing, /Jenny started this part over/);
});

test('the old restarted marker is gone', () => {
  const html = createRenderer().buildTurnRowListMarkup([textRow('r1', 'assistant_1', 'Answer', { truncated: true })], []);
  assert.ok(!html.includes('chat-truncation-marker'));
});

test('settled receipt renders once after the last assistant_text row of each receipted message', () => {
  const renderer = createRenderer();
  const messages = [
    { id: 'assistant_1', role: 'assistant', discarded_drafts: { count: 1, latest_reason: 'provider_retry' } },
    { id: 'assistant_2', role: 'assistant', discarded_drafts: { count: 2, latest_reason: 'nudge_retry' } },
    { id: 'assistant_3', role: 'assistant' },
  ];
  const rows = [
    textRow('a1', 'assistant_1', 'First answer'),
    textRow('b1', 'assistant_2', 'Segment one'),
    textRow('b2', 'assistant_2', 'Segment two'),
    textRow('c1', 'assistant_3', 'No receipt here'),
  ];
  const html = renderer.buildTurnRowListMarkup(rows, messages);
  assert.equal(count(html, 'class="chat-discarded-receipt"'), 2, 'older and newer turn both keep a receipt');
  assert.match(html, /1 draft discarded · the engine dropped the reply/);
  assert.match(html, /2 drafts discarded · it skipped a tool it needed/);
  assert.match(html, /title="Jenny threw away a draft of this reply and replaced it\. The draft was not saved\."/);
  assert.ok(html.indexOf('First answer') < html.indexOf('1 draft discarded'));
  assert.ok(html.indexOf('Segment two') < html.indexOf('2 drafts discarded'));
  assert.ok(html.indexOf('Segment one') < html.indexOf('Segment two'));
  assert.ok(html.indexOf('2 drafts discarded') < html.indexOf('No receipt here'), 'receipt sits under its own message');
});

test('receipt does not render while the row is streaming or when the count is empty', () => {
  const renderer = createRenderer();
  const messages = [{ id: 'assistant_1', role: 'assistant', discarded_drafts: { count: 1, latest_reason: 'provider_retry' } }];
  const streaming = renderer.buildTurnRowListMarkup([textRow('a1', 'assistant_1', 'Live')], messages, { isStreaming: true });
  assert.ok(!streaming.includes('chat-discarded-receipt'));
  const empty = renderer.buildTurnRowListMarkup([textRow('a1', 'assistant_1', 'Done')], [
    { id: 'assistant_1', role: 'assistant', discarded_drafts: { count: 0, latest_reason: '' } },
  ]);
  assert.ok(!empty.includes('chat-discarded-receipt'));
  // After `complete`, before the hydrated swap: the live fold still shows, so
  // the receipt waits instead of doubling up with it.
  const anchor = textRow('a0', 'assistant_1', 'DRAFT');
  anchor.payload.discard_anchor = true;
  const bridged = renderer.buildTurnRowListMarkup([anchor, textRow('a1', 'assistant_1', 'Done')], messages);
  assert.ok(bridged.includes('chat-discarded-draft'));
  assert.ok(!bridged.includes('chat-discarded-receipt'));
});

test('receipt with an unknown reason uses the short generic phrase', () => {
  const html = createRenderer().buildTurnRowListMarkup([textRow('a1', 'assistant_1', 'Done')], [
    { id: 'assistant_1', role: 'assistant', discarded_drafts: { count: 1, latest_reason: 'brand_new' } },
  ]);
  assert.match(html, /1 draft discarded · started over/);
});

test('complete stamps discarded_drafts on the live message before hydration', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());
  const streamId = 'stream-discard-stamp';
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId });
  await harness.emit({
    type: 'complete', sessionId: 'session-1', streamId, content: 'done',
    discardedDrafts: { count: 2, latest_reason: 'provider_retry' },
  });
  await flushMicrotasks(20);
  const message = harness.state.messagesBySession.get('session-1').find((m) => m.id === `assistant_${streamId}`);
  assert.deepEqual(message.discarded_drafts, { count: 2, latest_reason: 'provider_retry' });

  const plainId = 'stream-discard-none';
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: plainId });
  await harness.emit({ type: 'complete', sessionId: 'session-1', streamId: plainId, content: 'done' });
  const plain = harness.state.messagesBySession.get('session-1').find((m) => m.id === `assistant_${plainId}`);
  assert.ok(!('discarded_drafts' in plain));
});

test('live reducer: delta -> stream_reset -> delta renders one fold plus the post-reset text', async () => {
  const rig = makeRig();
  await rig.handlers.handleStarted(payload({ type: 'started' }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'DRAFT_TEXT', aggregate: 'DRAFT_TEXT' }));
  await rig.handlers.handleStreamReset(payload({
    type: 'stream_reset',
    reason: 'provider_retry',
    next_assistant_message_id: `assistant_${STREAM_ID}`,
    preserve_prior_segments: false,
    discard_scope: 'all',
  }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'FINAL_ANSWER', aggregate: 'FINAL_ANSWER' }));

  const html = createRenderer().buildTurnRowListMarkup(rig.turn().rows, [], { isStreaming: true });
  assert.equal(count(html, 'class="chat-discarded-draft"'), 1);
  assert.match(html, /DRAFT_TEXT/);
  assert.match(html, /the engine dropped the reply, so Jenny asked again/);
  assert.match(html, /FINAL_ANSWER/);
  assert.ok(html.indexOf('chat-discarded-draft') < html.indexOf('FINAL_ANSWER'), 'the fold sits above the answer that replaced it');
  assert.equal(count(html, 'chat-bubble-markdown'), 1, 'only the live answer renders a bubble');
});

test('settle: reconcile drops the live fold and the receipt renders from the persisted message', async () => {
  const { reconcileTurnRows } = require('../renderer/chat/renderer-row-identity-utils');
  const rig = makeRig();
  await rig.handlers.handleStarted(payload({ type: 'started' }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'DRAFT_TEXT', aggregate: 'DRAFT_TEXT' }));
  await rig.handlers.handleStreamReset(payload({
    type: 'stream_reset',
    reason: 'provider_retry',
    next_assistant_message_id: `assistant_${STREAM_ID}`,
    preserve_prior_segments: false,
    discard_scope: 'all',
  }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'FINAL_ANSWER', aggregate: 'FINAL_ANSWER' }));
  const liveRows = rig.turn().rows;
  const live = liveRows.find((row) => row.kind === 'assistant_text' && row.discarded !== true);
  // The hydrated projector rebuilds only what main persisted: the answer.
  const hydrated = [{ ...live, payload: { ...live.payload } }];
  const { finalRows, staleRows } = reconcileTurnRows(liveRows, hydrated);
  assert.ok(staleRows.some((row) => row.payload.discard_anchor === true), 'the fold row is dropped at settle');
  const messages = [{ id: live.primary_message_id, role: 'assistant', discarded_drafts: { count: 1, latest_reason: 'provider_retry' } }];
  const html = createRenderer().buildTurnRowListMarkup(finalRows, messages);
  assert.equal(count(html, 'class="chat-discarded-draft"'), 0);
  assert.ok(!html.includes('DRAFT_TEXT'), 'discarded text does not survive the settle');
  assert.equal(count(html, 'class="chat-discarded-receipt"'), 1);
  assert.ok(html.indexOf('FINAL_ANSWER') < html.indexOf('1 draft discarded'));
});

test('chat-system-notices-v2.css styles the fold and the receipt', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-system-notices-v2.css'), 'utf8');
  for (const selector of ['.chat-discarded-draft ', '.chat-discarded-receipt ']) {
    assert.ok(css.includes(selector), `${selector.trim()} selector present`);
  }
  assert.ok(css.includes('.chat-discarded-draft summary:focus-visible'), 'focus ring present');
  assert.ok(!css.includes('.chat-truncation-marker'), 'old marker styles removed');
});
