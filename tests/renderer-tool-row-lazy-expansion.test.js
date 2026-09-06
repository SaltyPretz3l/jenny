const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createTranscriptEventBindings } = require('../renderer/chat/renderer-chat-event-transcript-bindings');
const toolRowUtils = require('../renderer/chat/renderer-turn-row-tool-render-utils');

test('first expansion materializes deferred tool details through the keyed render pipeline', async (t) => {
  toolRowUtils.clearToolRowExpansionOverrides();
  const renderer = toolRowUtils.createTurnRowToolRenderUtils({
    escapeHtml: (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    normalizeId: (value) => String(value || '').trim(),
  });
  const markup = renderer.buildToolCallRowMarkup({
    turn_id: 't', row_id: 'r',
    payload: { tool_call_id: 'c', tool_name: 'run_command', state: 'completed', input: { command: 'echo complete' } },
  }, [], { sessionId: 's' });
  const dom = new JSDOM('<div id="chatTimeline">' + markup + '</div>');
  const timeline = dom.window.document.getElementById('chatTimeline');
  const previous = globalThis.rendererTurnRowToolRenderUtils;
  globalThis.rendererTurnRowToolRenderUtils = toolRowUtils;
  let renders = 0;
  t.after(() => {
    toolRowUtils.clearToolRowExpansionOverrides();
    if (previous === undefined) delete globalThis.rendererTurnRowToolRenderUtils;
    else globalThis.rendererTurnRowToolRenderUtils = previous;
    dom.window.close();
  });
  const noOp = async () => {};
  const bindings = createTranscriptEventBindings({
    chatTimeline: timeline, state: {}, renderAll: () => { renders += 1; },
    handleBranchMessage: noOp, handleCopyMessage: noOp, handleRegenerateMessage: noOp,
    handleElaborateMessage: noOp, handleFollowUpMessage: noOp, handleErrorRecoveryAction: noOp,
    handleArtifactAction: noOp, toggleInteractiveRoundRecap: noOp, toggleThreadBranch: noOp,
    setReasoningPhaseExpandedPreference: noOp, syncThinkingBlockNode: noOp, resolveToolCallId: () => '',
    toggleToolDetails: noOp, thinkingController: {},
  });
  bindings.bindTranscriptEvents((target, eventName, handler, options) => target.addEventListener(eventName, handler, options));
  const toggle = timeline.querySelector('[data-tool-row-toggle]');
  toggle.focus();
  toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  assert.equal(toolRowUtils.getToolRowExpansion('session=s|turn=t|row=r|call=c'), true);
  assert.equal(renders, 0);
  assert.equal(timeline.querySelector('.tool-call-row').getAttribute('data-expanded'), 'true');
  assert.equal(timeline.querySelector('.tool-call-row').dataset.toolDetailsMaterialized, 'true');
  assert.match(timeline.querySelector('.tool-call-row-body').innerHTML, /echo complete/);
  assert.equal(timeline.querySelector('[data-tool-row-toggle]'), toggle, 'targeted materialization must retain the toggle node');
  assert.equal(dom.window.document.activeElement, toggle);
  assert.deepEqual(
    toolRowUtils.materializeToolRowDetails('session=s|turn=t|row=r|call=c'),
    { ok: false, reason: 'missing_render_context', markup: '' },
    'successful materialization releases the deferred payload'
  );

  // The delegated listener must keep working against the freshly materialized
  // node, and the keyed override must survive that intervening rerender.
  assert.equal(
    toolRowUtils.getToolRowExpansion('session=s|turn=t|row=r|call=c'),
    true
  );
  timeline.querySelector('[data-tool-row-toggle]').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
  );
  await Promise.resolve();
  assert.equal(timeline.querySelector('.tool-call-row').getAttribute('data-expanded'), 'false');
  assert.equal(timeline.querySelector('[data-tool-row-toggle]').getAttribute('aria-expanded'), 'false');
  assert.equal(
    toolRowUtils.getToolRowExpansion('session=s|turn=t|row=r|call=c'),
    false
  );
});

test('first minimal-row expansion materializes nested file diffs already open', async (t) => {
  toolRowUtils.clearToolRowExpansionOverrides();
  const renderer = toolRowUtils.createTurnRowToolRenderUtils({
    escapeHtml: (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    normalizeId: (value) => String(value || '').trim(),
  });
  const markup = renderer.buildToolCallRowMarkup({
    turn_id: 't-diff', row_id: 'r-diff',
    payload: { tool_call_id: 'c-diff', tool_name: 'write_file', state: 'running', input: { path: 'src/a.js' } },
  }, [], {
    sessionId: 's-diff',
    pairedToolResultRow: { payload: {
      tool_call_id: 'c-diff', tool_name: 'write_file', state: 'completed',
      metadata: { diff: {
        diff_id: 'diff:minimal', path: 'src/a.js',
        hunks: [{ oldStart: 1, newStart: 1, lines: ['+added'] }],
      } },
    } },
  });
  const dom = new JSDOM('<div id="chatTimeline">' + markup + '</div>');
  const timeline = dom.window.document.getElementById('chatTimeline');
  const previous = globalThis.rendererTurnRowToolRenderUtils;
  globalThis.rendererTurnRowToolRenderUtils = toolRowUtils;
  let renders = 0;
  t.after(() => {
    toolRowUtils.clearToolRowExpansionOverrides();
    if (previous === undefined) delete globalThis.rendererTurnRowToolRenderUtils;
    else globalThis.rendererTurnRowToolRenderUtils = previous;
    dom.window.close();
  });
  const noOp = async () => {};
  const bindings = createTranscriptEventBindings({
    chatTimeline: timeline, state: {}, renderAll: () => { renders += 1; },
    handleBranchMessage: noOp, handleCopyMessage: noOp, handleRegenerateMessage: noOp,
    handleElaborateMessage: noOp, handleFollowUpMessage: noOp, handleErrorRecoveryAction: noOp,
    handleArtifactAction: noOp, toggleInteractiveRoundRecap: noOp, toggleThreadBranch: noOp,
    setReasoningPhaseExpandedPreference: noOp, syncThinkingBlockNode: noOp, resolveToolCallId: () => '',
    toggleToolDetails: noOp, thinkingController: {},
  });
  bindings.bindTranscriptEvents((target, eventName, handler, options) => target.addEventListener(eventName, handler, options));

  timeline.querySelector('[data-tool-row-toggle]').click();
  await Promise.resolve();

  assert.equal(renders, 0, 'targeted detail materialization must remain sufficient');
  assert.equal(timeline.querySelector('.file-diff').dataset.expanded, 'true');
  assert.ok(timeline.querySelector('[data-file-diff-materialized] .diff-line'));
  assert.equal(timeline.querySelector('[data-file-diff-pending]'), null);
});

test('missing render context logs a bounded warning and uses the explicit full-render fallback', async (t) => {
  const rowKey = 'session=s|turn=t|row=missing|call=c';
  const rowMarkup = (expanded) => `<div class="tool-call-row tool-call-row--minimal" data-tool-row-key="${rowKey}" data-expanded="${expanded}" data-tool-details-materialized="${expanded}"><div role="button" tabindex="0" data-tool-row-toggle="true" data-tool-row-key="${rowKey}" aria-expanded="${expanded}"></div><div class="tool-call-row-body"></div></div>`;
  const dom = new JSDOM(`<div id="chatTimeline">${rowMarkup(false)}</div>`);
  const timeline = dom.window.document.getElementById('chatTimeline');
  const previous = globalThis.rendererTurnRowToolRenderUtils;
  globalThis.rendererTurnRowToolRenderUtils = toolRowUtils;
  const logs = [];
  let renders = 0;
  t.after(() => {
    toolRowUtils.clearToolRowExpansionOverrides();
    if (previous === undefined) delete globalThis.rendererTurnRowToolRenderUtils;
    else globalThis.rendererTurnRowToolRenderUtils = previous;
    dom.window.close();
  });
  const noOp = async () => {};
  const bindings = createTranscriptEventBindings({
    chatTimeline: timeline, state: {}, appendClientLog: (...args) => logs.push(args),
    renderAll: () => { renders += 1; timeline.innerHTML = rowMarkup(true); },
    handleBranchMessage: noOp, handleCopyMessage: noOp, handleRegenerateMessage: noOp,
    handleElaborateMessage: noOp, handleFollowUpMessage: noOp, handleErrorRecoveryAction: noOp,
    handleArtifactAction: noOp, toggleInteractiveRoundRecap: noOp, toggleThreadBranch: noOp,
    setReasoningPhaseExpandedPreference: noOp, syncThinkingBlockNode: noOp, resolveToolCallId: () => '',
    toggleToolDetails: noOp, thinkingController: {},
  });
  bindings.bindTranscriptEvents((target, eventName, handler, options) => target.addEventListener(eventName, handler, options));
  const toggle = timeline.querySelector('[data-tool-row-toggle]');
  toggle.focus();
  toggle.click();
  await Promise.resolve();
  assert.equal(renders, 1);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].slice(0, 2), ['WARN', 'tool.details_materialization_fallback']);
  assert.ok(logs[0][2].rowKey.length <= 240);
  assert.equal(dom.window.document.activeElement, timeline.querySelector('[data-tool-row-toggle]'));
});
