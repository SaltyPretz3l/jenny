'use strict';

// W1-5 (studio removal) — the built-in fallback artifact teaser in
// renderer-turn-row-render-utils.js renders its title button as the 'panel'
// action (opens the artifact review panel beside chat); the old 'studio'
// action and the flag-gated extra ⤢ icon are retired.
// Lives in its own file: the main turn-row suite sits at the file-size cap.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createRenderer(overrides = {}) {
  return createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml,
    ...overrides,
  });
}

function toolResultRow(callId, artifactId) {
  return [{
    row_id: `row:teaser-${callId}`,
    turn_id: 'turn_teaser',
    kind: 'tool_result',
    primary_message_id: 'tool_use_teaser',
    tool_call_id: callId,
    payload: {
      tool_call_id: callId,
      tool_name: 'Write',
      output_text: 'done',
      state: 'completed',
      generated_artifacts: [{ artifact_id: artifactId, title: 'notes.txt' }],
    },
  }];
}

test('teaser title button routes to the panel action (studio retired, W1-5)', () => {
  const renderer = createRenderer();
  const html = renderer.buildTurnRowListMarkup(toolResultRow('call-t1', 'artifact_teaser_on'), []);
  assert.doesNotMatch(html, /data-inv-artifact-action="studio"/, 'studio action is gone');
  const titleButton = html.match(/<button[^>]*data-inv-artifact-action="panel"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(titleButton, 'title button carries the panel action');
  assert.match(titleButton[1], /notes\.txt/, 'title button shows the artifact title');
  // Exactly one panel control — the redundant extra ⤢ icon is retired.
  assert.equal((html.match(/data-inv-artifact-action="panel"/g) || []).length, 1);
});

test('teaser markup needs no feature flags (panel is core)', () => {
  const withFlags = createRenderer({ getFeatureFlags: () => ({}) });
  const withoutFlags = createRenderer();
  const a = withFlags.buildTurnRowListMarkup(toolResultRow('call-t0', 'artifact_teaser_off'), []);
  const b = withoutFlags.buildTurnRowListMarkup(toolResultRow('call-t0', 'artifact_teaser_off'), []);
  assert.equal(a, b);
  assert.match(a, /data-inv-artifact-action="panel"/);
});
