'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createTranscriptEventBindings } = require('../renderer/chat/renderer-chat-event-transcript-bindings');

test('Expand All deduplicates hundreds of deferred rows without repeated rendering', (t) => {
  const rowCount = 120;
  const legacyMarkup = Array.from({ length: rowCount }, (_, index) => (
    `<div data-tool-row-key="legacy_${index}" data-tool-details-materialized="false">`
    + `<div class="tool-call-header" data-tool-row-key="legacy_${index}" aria-expanded="false"></div>`
    + `<div class="tool-call-header" data-tool-row-key="legacy_${index}" aria-expanded="false"></div></div>`
  )).join('');
  const minimalMarkup = Array.from({ length: rowCount }, (_, index) => (
    `<div class="tool-call-row--minimal" data-tool-row-key="minimal_${index}" data-tool-details-materialized="false">`
    + `<div data-tool-row-toggle data-tool-row-key="minimal_${index}" aria-expanded="false"></div>`
    + `<div data-tool-row-toggle data-tool-row-key="minimal_${index}" aria-expanded="false"></div></div>`
  )).join('');
  const reasoningMarkup = Array.from({ length: rowCount }, (_, index) => (
    `<div data-reasoning-toggle data-message-id="msg_${index}" data-phase-key="phase_${index}" `
    + 'data-default-expanded="false" aria-expanded="false"></div>'
    + `<div data-reasoning-toggle data-message-id="msg_${index}" data-phase-key="phase_${index}" `
    + 'data-default-expanded="false" aria-expanded="false"></div>'
  )).join('');
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + '<button id="timelineCollapseExpandToggle">Toggle</button>'
    + `<div id="chatTimeline">${legacyMarkup}${minimalMarkup}${reasoningMarkup}</div>`
    + '</body></html>');
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const legacyCalls = [];
  const minimalCalls = [];
  const renderCalls = [];
  const batchCalls = [];
  const expansionEvents = [];
  const clientLogs = [];
  const previousToolRowUtils = global.rendererTurnRowToolRenderUtils;
  global.rendererTurnRowToolRenderUtils = {
    setToolRowExpansion: (rowKey, expanded) => minimalCalls.push({ rowKey, expanded }),
  };
  t.after(() => {
    if (previousToolRowUtils === undefined) delete global.rendererTurnRowToolRenderUtils;
    else global.rendererTurnRowToolRenderUtils = previousToolRowUtils;
    dom.window.close();
  });
  chatTimeline.addEventListener('tool-row-user-expansion', (event) => expansionEvents.push(event.detail));
  const phaseExpansionState = new Map();
  const bindings = createTranscriptEventBindings({
    chatTimeline,
    state: { currentSessionId: 'session_large' },
    setToolCallExpansion: (rowKey, expanded) => legacyCalls.push({ rowKey, expanded }),
    setReasoningPhaseExpandedPreferences: (sessionId, entries) => batchCalls.push({ sessionId, entries }),
    renderAll: (options) => renderCalls.push(options),
    appendClientLog: (level, event, meta) => clientLogs.push({ level, event, meta }),
    toggleToolDetails: () => assert.fail('per-row toggle must not run during bulk expansion'),
    thinkingController: { phaseExpansionState, syncReasoningExpansionPause() {} },
  });
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });

  dom.window.document.getElementById('timelineCollapseExpandToggle').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
  );

  assert.equal(legacyCalls.length, rowCount);
  assert.equal(minimalCalls.length, rowCount);
  assert.equal(batchCalls.length, 1);
  assert.equal(batchCalls[0].entries.length, rowCount);
  assert.equal(phaseExpansionState.size, rowCount);
  assert.equal(expansionEvents.length, rowCount * 2);
  assert.deepEqual(renderCalls, [{ forceFullRender: true }]);
  assert.equal(clientLogs.length, 1);
  assert.equal(clientLogs[0].level, 'INFO');
  assert.equal(clientLogs[0].event, 'chat.timeline_bulk_expansion');
  assert.deepEqual(clientLogs[0].meta, {
    expanded: true, legacyToolRows: rowCount, minimalToolRows: rowCount,
    reasoningRows: rowCount, elapsedMs: clientLogs[0].meta.elapsedMs,
  });
  assert.equal(Number.isInteger(clientLogs[0].meta.elapsedMs), true);
  assert.equal(clientLogs[0].meta.elapsedMs >= 0, true);
});
