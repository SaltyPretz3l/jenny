'use strict';

// F27: the generated-image caption shows the prompt actually sent to the engine.
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const artifactCards = require('../renderer/chat/renderer-artifact-card-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { createTranscriptToolCallRenderer } = require('../renderer/chat/renderer-transcript-tool-calls');
const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const { buildCanonicalTurnEvent } = require('../services/backend/canonical-turn-event');

const image = { artifact_id: 'img-1', artifact_kind: 'image', title: 'Generated image', file_name: 'img-1.png',
  display_path: '.jenny/artifacts/session-1/img-1.png', mime_type: 'image/png', width: 1024, height: 768,
  local_trusted: true, session_id: 'session-1' };
const PROMPT = 'A fox <img src=x onerror=alert(1)>\nin   "snow"';

function figure(markup) {
  return new JSDOM(markup).window.document.querySelector('.inv-artifact-figure');
}

test('the prompt is a second caption line under the meta with the full prompt and negative prompt in its tooltip', () => {
  artifactCards.resetArtifactImageLoaderForTests();
  const markup = artifactCards.renderArtifactCards([image], 'image-call',
    { seed: 7, prompt: PROMPT, negativePrompt: 'blur & noise', sessionId: 'session-1' });
  assert.doesNotMatch(markup, /<img src=x/);
  const node = figure(markup);
  assert.equal(node.querySelector('.inv-artifact-figure-meta').textContent, '1024 × 768 · seed 7');
  const prompt = node.querySelector('.inv-artifact-figure-caption .inv-artifact-figure-prompt');
  assert.equal(prompt.textContent, 'A fox <img src=x onerror=alert(1)> in "snow"');
  assert.equal(prompt.getAttribute('title'), `Prompt: ${PROMPT}\nNegative prompt: blur & noise`);
  assert.equal(node.querySelectorAll('img').length, 1);
});

test('an image without a prompt renders exactly as before', () => {
  artifactCards.resetArtifactImageLoaderForTests();
  const before = artifactCards.renderArtifactCards([image], 'image-call', { seed: 7, sessionId: 'session-1' });
  for (const prompt of [undefined, '', '   ', 42]) {
    artifactCards.resetArtifactImageLoaderForTests();
    assert.equal(artifactCards.renderArtifactCards([image], 'image-call', { seed: 7, prompt, negativePrompt: 'blur', sessionId: 'session-1' }), before);
  }
  assert.equal(figure(before).querySelector('.inv-artifact-figure-prompt'), null);
});

function renderBothCallSites(provenance) {
  const use = { id: 'image-use', kind: 'tool_use', role: 'assistant', tool_call: {
    call_id: 'image-call', tool_name: 'image_generate', status: 'completed', input: { prompt: 'fox' } } };
  const result = { id: 'image-result', kind: 'tool_result', role: 'tool', tool_result: {
    call_id: 'image-call', generated_artifacts: [image], metadata: { provenance } } };
  const live = createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils })
    .renderToolCallBlock(use, [use, result], { sessionId: 'session-1' });
  const callRow = { kind: 'tool_call', row_id: 'row-call', turn_id: 'turn-1', tool_call_id: 'image-call',
    payload: { tool_call_id: 'image-call', tool_name: 'image_generate', state: 'completed', input: { prompt: 'fox' } } };
  const resultRow = { kind: 'tool_result', row_id: 'row-result', turn_id: 'turn-1', tool_call_id: 'image-call',
    payload: { tool_call_id: 'image-call', tool_name: 'image_generate', output_text: 'Generated.', state: 'completed',
      generated_artifacts: [image], metadata: { provenance } } };
  const persisted = createTurnRowRenderUtils({ escapeHtml })
    .buildToolCallRowMarkup(callRow, [], { pairedToolResultRow: resultRow, sessionId: 'session-1' });
  return [live, persisted];
}

// F29: provenance as persisted, i.e. after the canonical tool_result normalizer
// (which redacts engine/system prompt keys named `prompt`).
function canonicalProvenance(provenance) {
  const event = buildCanonicalTurnEvent({ type: 'tool_execution_completed', turn_id: 'turn-1', seq: 1,
    tool_call_id: 'image-call', payload: { tool_call_id: 'image-call', metadata: { provenance } } });
  return event.payload.metadata.provenance;
}

test('both caption call sites read the prompt from persisted provenance', () => {
  artifactCards.resetArtifactImageLoaderForTests();
  const provenance = canonicalProvenance({ seed: 7, image_prompt: 'a red fox', image_negative_prompt: 'blur' });
  for (const markup of renderBothCallSites(provenance)) {
    assert.doesNotMatch(markup, /\[redacted\]/);
    const prompt = figure(markup).querySelector('.inv-artifact-figure-prompt');
    assert.equal(prompt.textContent, 'a red fox');
    assert.equal(prompt.getAttribute('title'), 'Prompt: a red fox\nNegative prompt: blur');
  }
});

test('a row persisted before F29 shows no prompt line rather than the redaction marker', () => {
  artifactCards.resetArtifactImageLoaderForTests();
  for (const markup of renderBothCallSites({ seed: 7, prompt: '[redacted]', negative_prompt: 'blur' })) {
    assert.doesNotMatch(markup, /\[redacted\]/);
    assert.equal(figure(markup).querySelector('.inv-artifact-figure-prompt'), null);
  }
});
