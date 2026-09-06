const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KIND_IMAGE,
  KIND_FILE,
  KIND_TOOL,
  ACTION_PANEL,
  ACTION_OPEN,
  ACTION_REVEAL,
  ACTION_VOCABULARY,
  buildArtifactPresentation,
  detectShape,
  legacyTypeToken,
} = require('../renderer/features/renderer-artifact-presentation.js');

test('ACTION_VOCABULARY is the canonical frozen action set', () => {
  // W1-5: 'studio' retired with the Artifacts studio view; 'panel' is the
  // primary in-app action.
  assert.deepEqual(ACTION_VOCABULARY, [ACTION_PANEL, ACTION_OPEN, ACTION_REVEAL]);
  assert.throws(() => { ACTION_VOCABULARY.push('evil'); });
});

test('legacyTypeToken maps shared kinds back to projected type tokens', () => {
  assert.equal(legacyTypeToken(KIND_IMAGE), 'image');
  assert.equal(legacyTypeToken(KIND_FILE), 'generated_file');
  assert.equal(legacyTypeToken(KIND_TOOL), 'tool_output');
});

test('detectShape reads projected shape for artifactType-bearing artifacts', () => {
  assert.equal(detectShape({ artifactType: 'image' }), 'projected');
  assert.equal(detectShape({ artifactType: 'generated_file' }), 'projected');
  assert.equal(detectShape({ artifactType: 'tool_output' }), 'projected');
});

test('detectShape reads raw shape for tool-result generated_artifacts entries', () => {
  assert.equal(detectShape({ artifact_id: 'a-1', artifact_kind: 'file', file_name: 'a.md' }), 'raw');
  assert.equal(detectShape({ absolute_path: 'C:/x/y.png' }), 'raw');
});

test('buildArtifactPresentation normalizes a projected image artifact', () => {
  const presentation = buildArtifactPresentation({
    id: 'artifact-image-1',
    artifactType: 'image',
    title: 'Shelf Image',
    status: 'available',
    image: {
      assetPath: 'C:/artifacts/s1/a.png',
      sourceKind: 'clipboard',
      width: 1280,
      height: 720,
    },
  }, { mode: 'shelf' });
  assert.equal(presentation.kind, KIND_IMAGE);
  assert.equal(presentation.id, 'artifact-image-1');
  assert.equal(presentation.title, 'Shelf Image');
  assert.equal(presentation.kicker, 'Image');
  assert.equal(presentation.metaLine, 'Clipboard / 1280 x 720');
  assert.equal(presentation.statusLabel, '');
  assert.ok(presentation.thumbnail);
  assert.equal(presentation.thumbnail.assetPath, 'C:/artifacts/s1/a.png');
  assert.equal(presentation.dataAttributes['data-artifact-id'], 'artifact-image-1');
  assert.equal(presentation.dataAttributes['data-artifact-kind'], 'image');
  assert.equal(presentation.dataAttributes['data-artifact-type'], 'image');
  assert.deepEqual(presentation.actions, []);
});

test('buildArtifactPresentation normalizes a projected generated_file artifact', () => {
  const presentation = buildArtifactPresentation({
    id: 'artifact-file-1',
    artifactType: 'generated_file',
    title: 'Scratch Plan',
    status: 'available',
    generatedFile: {
      artifactId: 'artifact-file-1',
      fileName: 'scratch-plan.md',
      displayPath: '.jenny/artifacts/s1/scratch-plan.md',
      language: 'markdown',
      artifactKind: 'document',
    },
  }, { mode: 'catalog' });
  assert.equal(presentation.kind, KIND_FILE);
  assert.equal(presentation.kicker, 'Markdown Document');
  assert.equal(presentation.isMarkdownDocument, true);
  assert.equal(presentation.metaLine, '.jenny/artifacts/s1/scratch-plan.md');
  assert.equal(presentation.dataAttributes['data-artifact-kind'], 'file');
  assert.equal(presentation.dataAttributes['data-artifact-type'], 'generated_file');
});

test('buildArtifactPresentation prefers projected markdown classification flags', () => {
  const presentation = buildArtifactPresentation({
    id: 'artifact-file-flagged',
    artifactType: 'generated_file',
    title: 'Flagged Plan',
    status: 'available',
    generatedFile: {
      artifactId: 'artifact-file-flagged',
      fileName: 'flagged.txt',
      displayPath: '.jenny/artifacts/s1/flagged.txt',
      language: 'plaintext',
      artifactKind: 'document',
      isMarkdownDocument: true,
    },
  }, { mode: 'catalog' });

  assert.equal(presentation.kind, KIND_FILE);
  assert.equal(presentation.kicker, 'Markdown Document');
  assert.equal(presentation.isMarkdownDocument, true);
});

test('buildArtifactPresentation normalizes a projected tool_output artifact', () => {
  const presentation = buildArtifactPresentation({
    id: 'artifact-tool-1',
    artifactType: 'tool_output',
    title: 'Read src/app.js',
    status: 'completed',
    tool: {
      callId: 'call-1',
      toolName: 'Read',
      summary: 'Read src/app.js',
      isError: false,
    },
    outputText: 'export const ready = true;',
  }, { mode: 'shelf' });
  assert.equal(presentation.kind, KIND_TOOL);
  assert.equal(presentation.kicker, 'Read');
  assert.equal(presentation.metaLine, 'export const ready = true;');
  assert.equal(presentation.callId, 'call-1');
  assert.equal(presentation.dataAttributes['data-artifact-call-id'], 'call-1');
});

test('buildArtifactPresentation normalizes a raw tool-result image artifact for inline mode', () => {
  const presentation = buildArtifactPresentation({
    artifact_id: 'raw-image-1',
    artifact_kind: 'image',
    file_name: 'capture.png',
    display_path: '.jenny/artifacts/s-1/capture.png',
    absolute_path: 'C:/out/capture.png',
    session_id: 's-1',
    local_trusted: true,
    title: 'Capture',
  }, { mode: 'inline', sessionId: 's-1' });
  assert.equal(presentation.kind, KIND_IMAGE);
  assert.equal(presentation.id, 'raw-image-1');
  assert.equal(presentation.kicker, 'Image');
  assert.equal(presentation.thumbnail.assetPath, 'C:/out/capture.png');
  assert.equal(presentation.thumbnail.trustedLocalPath, true);
  assert.equal(presentation.dataAttributes['data-session-id'], 's-1');
  assert.equal(presentation.actions.length, 3);
  assert.deepEqual(presentation.actions.map((a) => a.name), ['panel', 'open', 'reveal']);
  assert.ok(presentation.actions.every((a) => a.enabled === true));
});

test('the panel action is the primary text action (studio retired, W1-5)', () => {
  const presentation = buildArtifactPresentation({
    artifact_id: 'raw-image-panel',
    artifact_kind: 'image',
    file_name: 'capture.png',
    display_path: '.jenny/artifacts/s-1/capture.png',
    absolute_path: 'C:/out/capture.png',
    session_id: 's-1',
    local_trusted: true,
    title: 'Capture',
  }, { mode: 'inline', sessionId: 's-1' });

  assert.deepEqual(presentation.actions.map((a) => a.name), ['panel', 'open', 'reveal']);
  const panelAction = presentation.actions[0];
  assert.equal(panelAction.label, 'View');
  assert.equal(panelAction.ariaLabel, 'Open in panel');
  assert.equal(panelAction.title, 'Open beside chat');
  assert.equal(panelAction.enabled, true);
  assert.equal(presentation.actions[1].title, 'Open with default app');
});

test('buildArtifactPresentation does not thumbnail raw local paths unless marked trusted', () => {
  const presentation = buildArtifactPresentation({
    artifact_id: 'raw-image-untrusted',
    artifact_kind: 'image',
    file_name: 'capture.png',
    absolute_path: 'C:/Users/Alice/secret.png',
    title: 'Imported capture',
  }, { mode: 'inline', sessionId: 's-1' });

  assert.equal(presentation.kind, KIND_IMAGE);
  assert.equal(presentation.thumbnail, null);
});

test('buildArtifactPresentation keeps legacy raw thumbnails only when session-scoped', () => {
  const presentation = buildArtifactPresentation({
    artifact_id: 'raw-image-legacy',
    artifact_kind: 'image',
    file_name: 'legacy.png',
    display_path: '.jenny/artifacts/s-1/legacy.png',
    absolute_path: 'C:/workspace/.jenny/artifacts/s-1/legacy.png',
    title: 'Legacy image',
  }, { mode: 'inline', sessionId: 's-1' });

  assert.equal(presentation.kind, KIND_IMAGE);
  assert.equal(presentation.thumbnail.assetPath, 'C:/workspace/.jenny/artifacts/s-1/legacy.png');
  assert.equal(presentation.thumbnail.trustedLocalPath, true);
});

test('buildArtifactPresentation requires trusted raw thumbnails to be session-scoped', () => {
  const presentation = buildArtifactPresentation({
    artifact_id: 'raw-image-wrong-session',
    artifact_kind: 'image',
    file_name: 'capture.png',
    display_path: '.jenny/artifacts/other-session/capture.png',
    absolute_path: 'C:/Users/Alice/secret.png',
    local_trusted: true,
    title: 'Imported capture',
  }, { mode: 'inline', sessionId: 's-1' });

  assert.equal(presentation.kind, KIND_IMAGE);
  assert.equal(presentation.thumbnail, null);
});

test('buildArtifactPresentation normalizes a raw file artifact', () => {
  const presentation = buildArtifactPresentation({
    artifact_id: 'raw-file-1',
    artifact_kind: 'file',
    file_name: 'plan.md',
    display_path: '.jenny/plan.md',
    language: 'markdown',
    title: 'Plan',
  }, { mode: 'inline' });
  assert.equal(presentation.kind, KIND_FILE);
  assert.equal(presentation.kicker, 'Markdown Document');
  assert.equal(presentation.isMarkdownDocument, true);
  assert.equal(presentation.metaLine, '.jenny/plan.md');
  assert.equal(presentation.dataAttributes['data-artifact-type'], 'generated_file');
});

test('buildArtifactPresentation detects image by file extension when kind is missing', () => {
  const presentation = buildArtifactPresentation({
    artifact_id: 'raw-image-2',
    file_name: 'screenshot.JPEG',
  }, { mode: 'inline' });
  assert.equal(presentation.kind, KIND_IMAGE);
});

test('buildArtifactPresentation returns generic tool kind when nothing matches', () => {
  const presentation = buildArtifactPresentation({
    artifact_id: 'raw-unknown-1',
    artifact_kind: 'custom',
    title: 'Thing',
  }, { mode: 'inline' });
  assert.equal(presentation.kind, KIND_TOOL);
  assert.equal(presentation.kicker, 'custom');
});

test('buildArtifactPresentation disables inline actions when no artifact id is present', () => {
  const presentation = buildArtifactPresentation({
    artifact_kind: 'image',
    file_name: 'tmp.png',
  }, { mode: 'inline' });
  assert.equal(presentation.actions.length, 3);
  assert.ok(presentation.actions.every((a) => a.enabled === false));
  assert.ok(presentation.actions.every((a) => a.title === 'Artifact unavailable'));
});

test('buildArtifactPresentation surfaces non-standard status as a status label', () => {
  const presentation = buildArtifactPresentation({
    id: 'artifact-file-err',
    artifactType: 'generated_file',
    title: 'Broken plan',
    status: 'error',
    generatedFile: { fileName: 'x.md' },
  }, { mode: 'catalog' });
  assert.equal(presentation.statusLabel, 'Error');
  assert.equal(presentation.dataAttributes['data-artifact-status'], 'error');
});
