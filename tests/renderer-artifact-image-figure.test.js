const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const artifactCards = require('../renderer/chat/renderer-artifact-card-utils');
const { normalizeGeneratedArtifactMetadataList } = require('../services/artifact-metadata-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { createTranscriptToolCallRenderer } = require('../renderer/chat/renderer-transcript-tool-calls');

function createRenderer() {
  return createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils });
}

const generatedImage = { artifact_id: 'img-1', artifact_kind: 'image', title: 'Generated image',
  file_name: 'img-1.png', display_path: '.jenny/artifacts/session-1/img-1.png', absolute_path: '[redacted:path]',
  mime_type: 'image/png', width: 1024, height: 768, local_trusted: true, session_id: 'session-1' };

function renderImageTool({ status = 'completed', artifacts = [generatedImage], materialize = false, tool = 'image_generate', sessionId } = {}) {
  const message = { id: 'image-use', kind: 'tool_use', role: 'assistant', tool_call: {
    call_id: 'image-call', tool_name: tool, status, input: { width: 1024, height: 768 },
  } };
  const result = { id: 'image-result', kind: 'tool_result', role: 'tool', tool_result: {
    call_id: 'image-call', generated_artifacts: artifacts, metadata: { provenance: { seed: 4223638553 } },
  } };
  return createRenderer().renderToolCallBlock(message, status === 'running' ? [message] : [message, result], {
    forceMaterializeToolDetails: materialize, sessionId,
  });
}

test('completed image is a visible figure with seed meta outside the hidden artifact list', () => {
  artifactCards.resetArtifactImageLoaderForTests();
  for (const materialize of [false, true]) {
    const doc = new JSDOM(renderImageTool({ materialize })).window.document;
    assert.equal(doc.querySelectorAll('.inv-artifact-figures .inv-artifact-figure').length, 1);
    assert.equal(doc.querySelector('.inv-artifact-list'), null);
    assert.equal(doc.querySelector('.inv-artifact-figure').closest('.tool-call-disclosure'), null);
    assert.equal(doc.querySelector('.inv-artifact-figure-meta').textContent, '1024 × 768 · seed 4223638553');
  }
});

test('only a running image generation without artifacts renders the pending figure in both disclosure branches', () => {
  for (const materialize of [false, true]) {
    const doc = new JSDOM(renderImageTool({ status: 'running', materialize })).window.document;
    assert.equal(doc.querySelectorAll('.inv-artifact-figure--pending').length, 1);
    assert.equal(doc.querySelector('.inv-artifact-figure-placeholder').style.aspectRatio, '1024 / 768');
    assert.equal(doc.querySelector('[data-inv-image-cancel]').textContent, 'Cancel');
    assert.equal(doc.querySelector('.inv-artifact-figure--pending').closest('.tool-call-disclosure'), null);
    assert.doesNotMatch(renderImageTool({ status: 'running', materialize, tool: 'read_file' }), /inv-artifact-figure--pending/);
  }
});

test('non-image artifacts retain the hidden list markup', () => {
  const doc = new JSDOM(renderImageTool({ artifacts: [{ artifact_id: 'file-1', artifact_kind: 'file', file_name: 'notes.txt' }] })).window.document;
  assert.equal(doc.querySelectorAll('.inv-artifact-list .inv-artifact-card--file').length, 1);
  assert.equal(doc.querySelector('.inv-artifact-figures'), null);
});

test('image loader deduplicates pending and cached reads, hydrates after render and marks invalid payloads unavailable', async () => {
  const oldDocument = globalThis.document; const oldShell = globalThis.jennyShell;
  const dom = new JSDOM('<body></body>'); const doc = dom.window.document;
  artifactCards.resetArtifactImageLoaderForTests();
  try {
    globalThis.document = doc;
    const reads = []; let resolveRead;
    globalThis.jennyShell = { artifacts: { read: (...args) => {
      reads.push(args); return new Promise((resolve) => { resolveRead = resolve; });
    } } };
    const render = (artifact = generatedImage) => artifactCards.renderArtifactCards([artifact], 'image-call');
    doc.body.innerHTML = render(); render();
    assert.deepEqual(reads, [['session-1', 'img-1']]);
    assert.equal(doc.querySelector('img').hasAttribute('src'), false);
    resolveRead({ asset_data_url: 'data:image/png;base64,YQ==' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(doc.querySelector('img').getAttribute('src'), 'data:image/png;base64,YQ==');
    const html = render(); assert.doesNotMatch(html, /data:image\/png;base64/);
    doc.body.innerHTML = html;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(reads.length, 1);
    assert.equal(doc.querySelector('img').getAttribute('src'), 'data:image/png;base64,YQ==');
    const invalid = { ...generatedImage, artifact_id: 'bad-image' };
    doc.body.innerHTML = render(invalid); resolveRead({ assetDataUrl: 'data:text/html;base64,YQ==' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(doc.querySelector('figure').dataset.invArtifactImageState, 'unavailable');
    assert.equal(doc.querySelector('img').hasAttribute('src'), false);
    assert.match(render(invalid), /data-inv-artifact-image-state="unavailable"/);
    assert.equal(reads.length, 2);
  } finally {
    artifactCards.resetArtifactImageLoaderForTests(); dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldShell === undefined) delete globalThis.jennyShell; else globalThis.jennyShell = oldShell;
  }
});

async function withLoaderGlobals(read, run) {
  const oldDocument = globalThis.document; const oldShell = globalThis.jennyShell;
  const dom = new JSDOM('<body></body>');
  artifactCards.resetArtifactImageLoaderForTests();
  globalThis.document = dom.window.document;
  globalThis.jennyShell = { artifacts: { read } };
  try { await run(dom.window.document); } finally {
    artifactCards.resetArtifactImageLoaderForTests(); dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldShell === undefined) delete globalThis.jennyShell; else globalThis.jennyShell = oldShell;
  }
}

test('a persisted image, stripped of session_id by the session store, loads through the row session', async () => {
  const [persisted] = normalizeGeneratedArtifactMetadataList([generatedImage]);
  assert.equal(persisted.session_id, undefined);
  assert.equal(persisted.local_trusted, undefined);
  const reads = [];
  await withLoaderGlobals(async (...args) => { reads.push(args); return { asset_data_url: 'data:image/png;base64,YQ==' }; }, async (doc) => {
    doc.body.innerHTML = renderImageTool({ artifacts: [persisted], sessionId: 'session-1' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(reads, [['session-1', 'img-1']]);
    assert.equal(doc.querySelector('img').getAttribute('data-inv-artifact-image-key'), 'session-1:img-1');
    assert.equal(doc.querySelector('[data-inv-artifact-action="save-as"]').dataset.sessionId, 'session-1');
    assert.equal(doc.querySelector('img').getAttribute('src'), 'data:image/png;base64,YQ==');
  });
});

test('a rejected read shows unavailable, then retries after the back-off and recovers', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let fail = true; let reads = 0;
  await withLoaderGlobals(async () => { reads += 1; if (fail) throw new Error('scope changed'); return { asset_data_url: 'data:image/png;base64,YQ==' }; }, async (doc) => {
    const render = () => artifactCards.renderArtifactCards([generatedImage], 'image-call');
    doc.body.innerHTML = render();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(doc.querySelector('figure').dataset.invArtifactImageState, 'unavailable');
    render(); await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(reads, 1);
    fail = false; now += 15_001;
    render(); await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(reads, 2);
    assert.equal(doc.querySelector('figure').hasAttribute('data-inv-artifact-image-state'), false);
    assert.equal(doc.querySelector('img').getAttribute('src'), 'data:image/png;base64,YQ==');
  });
});

// GIP-1: a settled image_generate row takes the minimal row path, not
// renderToolCallBlock. The figure must render there too, outside the inert body.
test('a settled image row on the minimal row path renders the figure beside its header', () => {
  artifactCards.resetArtifactImageLoaderForTests();
  const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
  const rowRenderer = createTurnRowRenderUtils({ escapeHtml });
  const callRow = { kind: 'tool_call', row_id: 'row-call', turn_id: 'turn-1', tool_call_id: 'image-call',
    payload: { tool_call_id: 'image-call', tool_name: 'image_generate', state: 'completed', input: { prompt: 'fox' } } };
  const resultRow = { kind: 'tool_result', row_id: 'row-result', turn_id: 'turn-1', tool_call_id: 'image-call',
    payload: { tool_call_id: 'image-call', tool_name: 'image_generate', output_text: 'Generated.', state: 'completed',
      generated_artifacts: [generatedImage], metadata: { provenance: { seed: 7 } } } };
  const markup = rowRenderer.buildToolCallRowMarkup(callRow, [], { pairedToolResultRow: resultRow, sessionId: 'session-1' });
  const doc = new JSDOM(markup).window.document;
  const row = doc.querySelector('.tool-call-row--minimal');
  assert.equal(row.getAttribute('data-has-result'), 'true');
  assert.equal(doc.querySelectorAll('.inv-artifact-figures .inv-artifact-figure').length, 1);
  assert.equal(doc.querySelector('.inv-artifact-figure').closest('.tool-call-row-body'), null);
  assert.equal(doc.querySelector('.inv-artifact-figure-meta').textContent, '1024 × 768 · seed 7');
  assert.equal(row.getAttribute('data-run-foldable'), null);
});

// F30: a running image_generate row also takes the minimal row path. The sized
// pending placeholder (with Cancel) renders beside its header, outside the
// inert body, and the settled render replaces it with the real figure.
function buildImageCallRow(state, input) {
  return { kind: 'tool_call', row_id: 'row-call', turn_id: 'turn-1', tool_call_id: 'image-call',
    payload: { tool_call_id: 'image-call', tool_name: 'image_generate', state, ...(input ? { input } : {}) } };
}

test('a running image row on the minimal row path renders the sized pending figure with Cancel outside the body', () => {
  const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
  const rowRenderer = createTurnRowRenderUtils({ escapeHtml });
  const doc = new JSDOM(rowRenderer.buildToolCallRowMarkup(buildImageCallRow('running', { prompt: 'fox', width: 512, height: 768 }),
    [], { sessionId: 'session-1', transcriptView: 'answers' })).window.document;
  const row = doc.querySelector('.tool-call-row--minimal');
  assert.equal(doc.querySelectorAll('.inv-artifact-figure--pending').length, 1);
  const pending = doc.querySelector('.inv-artifact-figure--pending');
  assert.equal(pending.closest('.tool-call-row--minimal'), row);
  assert.equal(pending.closest('.tool-call-row-body'), null);
  assert.equal(pending.querySelector('.inv-artifact-figure-placeholder').style.aspectRatio, '512 / 768');
  assert.equal(pending.querySelector('[data-inv-image-cancel]').textContent, 'Cancel');
  assert.equal(row.getAttribute('data-run-foldable'), 'false');

  const defaultSized = new JSDOM(rowRenderer.buildToolCallRowMarkup(buildImageCallRow('executing', null), [], {})).window.document;
  assert.equal(defaultSized.querySelector('.inv-artifact-figure-placeholder').style.aspectRatio, '1024 / 1024');
  for (const state of ['requested', 'awaiting_approval', 'completed']) {
    assert.doesNotMatch(rowRenderer.buildToolCallRowMarkup(buildImageCallRow(state, { prompt: 'fox' }), [], {}), /inv-artifact-figure--pending/);
  }
  const otherTool = buildImageCallRow('running', { prompt: 'fox' });
  otherTool.payload.tool_name = 'read_file';
  assert.doesNotMatch(rowRenderer.buildToolCallRowMarkup(otherTool, [], {}), /inv-artifact-figure--pending/);
});

test('the settled image row replaces the pending figure with the real figure', () => {
  artifactCards.resetArtifactImageLoaderForTests();
  const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
  const rowRenderer = createTurnRowRenderUtils({ escapeHtml });
  const resultRow = (extra) => ({ kind: 'tool_result', row_id: 'row-result', turn_id: 'turn-1', tool_call_id: 'image-call',
    payload: { tool_call_id: 'image-call', tool_name: 'image_generate', output_text: 'Generated.', state: 'completed', ...extra } });
  // The call row may still read running when its result row pairs with it.
  const callRow = buildImageCallRow('running', { prompt: 'fox', width: 1024, height: 768 });
  const settled = new JSDOM(rowRenderer.buildToolCallRowMarkup(callRow, [], {
    pairedToolResultRow: resultRow({ generated_artifacts: [generatedImage] }), sessionId: 'session-1',
  })).window.document;
  assert.equal(settled.querySelector('.inv-artifact-figure--pending'), null);
  assert.equal(settled.querySelector('[data-inv-image-cancel]'), null);
  assert.equal(settled.querySelectorAll('.inv-artifact-figures .inv-artifact-figure').length, 1);
  assert.equal(settled.querySelector('.inv-artifact-figure').closest('.tool-call-row-body'), null);
  const failed = rowRenderer.buildToolCallRowMarkup(callRow, [], {
    pairedToolResultRow: resultRow({ is_error: true, output_text: 'Cancelled.' }),
  });
  assert.doesNotMatch(failed, /inv-artifact-figure--pending/);
});

test('a hydrated image result whose journaled event carries no artifacts takes them from its tool_result message', () => {
  const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
  const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
  const messages = [
    { id: 'u1', role: 'user', content: 'draw a fox', turn_id: 'turn-1' },
    { id: 'use-1', role: 'assistant', kind: 'tool_use', turn_id: 'turn-1', content: 'image_generate',
      tool_call: { call_id: 'image-call', tool_name: 'image_generate', input: { prompt: 'fox' }, status: 'completed' } },
    { id: 'result-1', role: 'tool', kind: 'tool_result', turn_id: 'turn-1', content: 'image_generate',
      tool_result: { call_id: 'image-call', tool_name: 'image_generate', output_text: 'Generated.', generated_artifacts: [generatedImage] } },
  ];
  const event = (seq, kind, extra) => ({ event_id: `e${seq}`, event_seq: seq, turn_id: 'turn-1', kind, status: 'completed',
    source_message_ids: [extra.primary_message_id], tool_call_id: extra.tool_call_id || '', ...extra });
  const turnEvents = [
    event(0, 'user_prompt', { primary_message_id: 'u1', payload: { content: 'draw a fox' } }),
    event(1, 'tool_use', { primary_message_id: 'use-1', tool_call_id: 'image-call',
      payload: { tool_name: 'image_generate', tool_input: { prompt: 'fox' }, canonical_event_type: 'tool_call_requested' } }),
    event(2, 'tool_result', { primary_message_id: 'result-1', tool_call_id: 'image-call',
      payload: { tool_name: 'image_generate', success: true, tool_output_summary: 'Generated.', generated_artifacts: [],
        canonical_event_type: 'tool_execution_completed' } }),
  ];
  const turns = projectTurnTree({ messages, turn_event_log_version: 4, turn_events: turnEvents }).turns;
  const resultRow = turns.flatMap((turn) => projectTurnRows(turn.events, {})).find((row) => row.kind === 'tool_result');
  assert.equal(resultRow.payload.generated_artifacts.length, 1);
  assert.equal(resultRow.payload.generated_artifacts[0].artifact_kind, 'image');
});
