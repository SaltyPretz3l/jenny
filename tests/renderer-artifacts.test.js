const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GENERATED_FILE_FILTER,
  IMAGE_FILTER,
  TOOL_OUTPUT_FILTER,
  buildArtifactsFromMessages,
  clipPreviewText,
  filterArtifacts,
  normalizeArtifactFilter,
  sortArtifactsNewestFirst,
} = require('../renderer/features/renderer-artifacts-utils.js');
const { renderArtifactCard } = require('../renderer/features/renderer-artifacts-render.js');

test('artifact projection derives persisted images and tool outputs from session messages', () => {
  const messages = [
    {
      id: 'msg-user-1',
      role: 'user',
      content: 'Please inspect this screenshot',
      timestamp: '2026-03-17T10:00:00.000Z',
      attachments: [{
        id: 'image-1',
        kind: 'image',
        displayName: 'capture.png',
        mimeType: 'image/png',
        assetPath: 'C:/attachments/capture.png',
        width: 1280,
        height: 720,
        sourceKind: 'capture',
      }],
    },
    {
      id: 'tool-use-1',
      role: 'assistant',
      kind: 'tool_use',
      content: 'Read src/app.js',
      timestamp: '2026-03-17T10:01:00.000Z',
      finalizedAt: '2026-03-17T10:01:01.000Z',
      tool_call: {
        call_id: 'call-1',
        tool_name: 'Read',
        summary: 'Read src/app.js',
        input: { file_path: 'src/app.js' },
      },
    },
    {
      id: 'tool-result-1',
      role: 'tool',
      kind: 'tool_result',
      content: 'done',
      timestamp: '2026-03-17T10:01:02.000Z',
      finalizedAt: '2026-03-17T10:01:03.000Z',
      tool_result: {
        call_id: 'call-1',
        tool_name: 'Read',
        summary: 'Read src/app.js',
        output_text: 'export const ready = true;',
        is_error: false,
      },
    },
  ];

  const artifacts = buildArtifactsFromMessages(messages, { sessionId: 'session-1' });

  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0].artifactType, TOOL_OUTPUT_FILTER);
  assert.equal(artifacts[0].sourceMessageId, 'tool-use-1');
  assert.equal(artifacts[0].tool.toolName, 'Read');
  assert.equal(artifacts[1].artifactType, IMAGE_FILTER);
  assert.equal(artifacts[1].image.displayName, 'capture.png');
  assert.match(artifacts[1].previewText, /Screenshot - 1280 x 720/);
});

test('artifact projection fails closed for missing image assets and filters by type', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'msg-user-2',
      role: 'user',
      content: 'Draft',
      timestamp: '2026-03-17T10:02:00.000Z',
      attachments: [{
        id: 'image-2',
        kind: 'image',
        displayName: 'clipboard.png',
        mimeType: 'image/png',
        assetPath: '',
        sourceKind: 'clipboard',
      }],
    },
  ], { sessionId: 'session-2' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].status, 'missing');
  assert.deepEqual(filterArtifacts(artifacts, 'IMAGE'), artifacts);
  assert.deepEqual(filterArtifacts(artifacts, 'tool_output'), []);
  assert.equal(normalizeArtifactFilter('unknown-value'), 'all');
});

test('clipPreviewText truncates long strings and handles edge cases', () => {
  assert.equal(clipPreviewText('', 50), '');
  assert.equal(clipPreviewText(null, 50), '');
  assert.equal(clipPreviewText('short', 50), 'short');
  assert.equal(clipPreviewText('a'.repeat(100), 50), 'a'.repeat(47) + '...');
  assert.equal(clipPreviewText('exact length text here!', 23), 'exact length text here!');
  assert.equal(clipPreviewText('  spaced   text  ', 50), 'spaced text');
});

test('sortArtifactsNewestFirst orders by timestamp descending', () => {
  const artifacts = [
    { id: 'a', timestamp: '2026-03-17T10:00:00.000Z' },
    { id: 'c', timestamp: '2026-03-17T12:00:00.000Z' },
    { id: 'b', timestamp: '2026-03-17T11:00:00.000Z' },
  ];
  const sorted = sortArtifactsNewestFirst(artifacts);
  assert.equal(sorted[0].id, 'c');
  assert.equal(sorted[1].id, 'b');
  assert.equal(sorted[2].id, 'a');
});

test('sortArtifactsNewestFirst handles empty arrays and missing timestamps', () => {
  assert.deepEqual(sortArtifactsNewestFirst([]), []);
  assert.deepEqual(sortArtifactsNewestFirst(null), []);
  const withMissing = [
    { id: 'a', timestamp: '' },
    { id: 'b', timestamp: '2026-03-17T10:00:00.000Z' },
  ];
  const sorted = sortArtifactsNewestFirst(withMissing);
  assert.equal(sorted[0].id, 'b');
});

test('tool result without matching tool_call falls back gracefully', () => {
  const messages = [
    {
      id: 'orphan-result',
      role: 'tool',
      kind: 'tool_result',
      content: 'done',
      timestamp: '2026-03-17T10:01:00.000Z',
      tool_result: {
        call_id: 'orphan-call',
        tool_name: 'Execute',
        output_text: 'ls output',
        is_error: false,
      },
    },
  ];
  const artifacts = buildArtifactsFromMessages(messages, { sessionId: 's1' });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifactType, TOOL_OUTPUT_FILTER);
  assert.equal(artifacts[0].sourceMessageId, 'orphan-result');
});

test('artifact projection hides internal inspect_harness snapshots', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-use-harness',
      role: 'assistant',
      kind: 'tool_use',
      timestamp: '2026-03-17T10:01:00.000Z',
      tool_call: {
        call_id: 'call-harness',
        tool_name: 'inspect_harness',
        summary: 'Inspect Harness',
      },
    },
    {
      id: 'tool-result-harness',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-03-17T10:01:02.000Z',
      tool_result: {
        call_id: 'call-harness',
        tool_name: 'inspect_harness',
        summary: 'Inspect Harness',
        output_text: '{"tools":{"counts":{"available":1}}}',
        is_error: false,
        metadata: { result_kind: 'harness_snapshot' },
      },
    },
  ], { sessionId: 'session-1' });

  assert.deepEqual(artifacts, []);
});

test('generated artifact metadata projects first-class file artifacts and suppresses generic tool cards', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-use-g1',
      role: 'assistant',
      kind: 'tool_use',
      content: 'Create a scratch plan',
      timestamp: '2026-03-17T10:01:00.000Z',
      tool_call: {
        call_id: 'call-g1',
        tool_name: 'CreateArtifact',
        summary: 'Create scratch plan',
      },
    },
    {
      id: 'tool-result-g1',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-03-17T10:01:02.000Z',
      tool_result: {
        call_id: 'call-g1',
        tool_name: 'CreateArtifact',
        summary: 'Create scratch plan',
        output_text: 'Created document "Plan" at .jenny/artifacts/session-1/plan.md',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_file_session-1_plan',
          artifact_kind: 'document',
          title: 'Plan',
          file_name: 'plan.md',
          display_path: '.jenny/artifacts/session-1/plan.md',
          absolute_path: 'C:/workspace/.jenny/artifacts/session-1/plan.md',
          language: 'markdown',
          editable: true,
          status: 'available',
        }],
      },
    },
  ], { sessionId: 'session-1' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifactType, GENERATED_FILE_FILTER);
  assert.equal(artifacts[0].sourceMessageId, 'tool-use-g1');
  assert.equal(artifacts[0].generatedFile.fileName, 'plan.md');
  assert.equal(artifacts[0].generatedFile.isMarkdownDocument, true);
  assert.match(artifacts[0].previewText, /Markdown document/);
});

test('generated Mermaid artifacts infer mermaid language from .mmd paths when metadata is blank', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-use-mermaid-file',
      role: 'assistant',
      kind: 'tool_use',
      timestamp: '2026-03-17T10:01:00.000Z',
      tool_call: {
        call_id: 'call-mermaid-file',
        tool_name: 'CreateArtifact',
        summary: 'Create butterfly diagram',
      },
    },
    {
      id: 'tool-result-mermaid-file',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-03-17T10:01:02.000Z',
      tool_result: {
        call_id: 'call-mermaid-file',
        tool_name: 'CreateArtifact',
        summary: 'Create butterfly diagram',
        output_text: 'Created document "Butterfly Diagram" at .jenny/artifacts/session-1/butterfly-effect.mmd',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_file_session-1_butterfly-effect',
          artifact_kind: 'document',
          title: 'Butterfly Diagram',
          file_name: 'butterfly-effect.mmd',
          display_path: '.jenny/artifacts/session-1/butterfly-effect.mmd',
          absolute_path: 'C:/workspace/.jenny/artifacts/session-1/butterfly-effect.mmd',
          language: '',
          editable: true,
          status: 'available',
        }],
      },
    },
  ], { sessionId: 'session-1' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].generatedFile.language, 'mermaid');
});

test('generated Mermaid artifacts infer mermaid language from .mermaid paths when metadata is blank', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-use-mermaid-long-ext',
      role: 'assistant',
      kind: 'tool_use',
      timestamp: '2026-03-17T10:01:00.000Z',
      tool_call: {
        call_id: 'call-mermaid-long-ext',
        tool_name: 'CreateArtifact',
        summary: 'Create evolution diagram',
      },
    },
    {
      id: 'tool-result-mermaid-long-ext',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-03-17T10:01:02.000Z',
      tool_result: {
        call_id: 'call-mermaid-long-ext',
        tool_name: 'CreateArtifact',
        summary: 'Create evolution diagram',
        output_text: 'Created document "Evolution Diagram" at .jenny/artifacts/session-1/evolution-flowchart.mermaid',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_file_session-1_evolution-flowchart',
          artifact_kind: 'document',
          title: 'Evolution Diagram',
          file_name: 'evolution-flowchart.mermaid',
          display_path: '.jenny/artifacts/session-1/evolution-flowchart.mermaid',
          absolute_path: 'C:/workspace/.jenny/artifacts/session-1/evolution-flowchart.mermaid',
          language: '',
          editable: true,
          status: 'available',
        }],
      },
    },
  ], { sessionId: 'session-1' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].generatedFile.language, 'mermaid');
});

test('artifact projection dedupes repeated tool results for the same call_id', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-use-dedupe-1',
      role: 'assistant',
      kind: 'tool_use',
      timestamp: '2026-03-17T10:00:00.000Z',
      tool_call: {
        call_id: 'call-dedupe-1',
        tool_name: 'read_file',
        summary: 'Read notes.md',
      },
    },
    {
      id: 'tool-result-dedupe-1a',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-03-17T10:00:01.000Z',
      tool_result: {
        call_id: 'call-dedupe-1',
        tool_name: 'read_file',
        summary: 'Read notes.md',
        output_text: 'first output',
        is_error: false,
      },
    },
    {
      id: 'tool-result-dedupe-1b',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-03-17T10:00:02.000Z',
      tool_result: {
        call_id: 'call-dedupe-1',
        tool_name: 'read_file',
        summary: 'Read notes.md',
        output_text: 'second output',
        is_error: false,
      },
    },
  ], { sessionId: 'session-dedupe-1' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifactType, TOOL_OUTPUT_FILTER);
  assert.equal(artifacts[0].tool.callId, 'call-dedupe-1');
  assert.equal(artifacts[0].outputText, 'second output');
});

test('artifact projection dedupes generated artifacts with the same artifact_id', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-use-dedupe-g1',
      role: 'assistant',
      kind: 'tool_use',
      timestamp: '2026-03-17T11:00:00.000Z',
      tool_call: {
        call_id: 'call-dedupe-g1',
        tool_name: 'create_artifact',
        summary: 'Create artifact',
      },
    },
    {
      id: 'tool-result-dedupe-g1a',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-03-17T11:00:01.000Z',
      tool_result: {
        call_id: 'call-dedupe-g1',
        tool_name: 'create_artifact',
        summary: 'Create artifact',
        output_text: 'created',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_file_session_dedupe_plan',
          artifact_kind: 'document',
          title: 'Plan',
          file_name: 'plan.md',
          display_path: '.jenny/artifacts/session-dedupe/plan.md',
          absolute_path: 'C:/workspace/.jenny/artifacts/session-dedupe/plan.md',
          language: 'markdown',
          editable: true,
          status: 'available',
        }],
      },
    },
    {
      id: 'tool-result-dedupe-g1b',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-03-17T11:00:02.000Z',
      tool_result: {
        call_id: 'call-dedupe-g1',
        tool_name: 'create_artifact',
        summary: 'Create artifact',
        output_text: 'created',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_file_session_dedupe_plan',
          artifact_kind: 'document',
          title: 'Plan',
          file_name: 'plan.md',
          display_path: '.jenny/artifacts/session-dedupe/plan.md',
          absolute_path: 'C:/workspace/.jenny/artifacts/session-dedupe/plan.md',
          language: 'markdown',
          editable: true,
          status: 'available',
        }],
      },
    },
  ], { sessionId: 'session-dedupe-2' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifactType, GENERATED_FILE_FILTER);
  assert.equal(artifacts[0].generatedFile.artifactId, 'artifact_file_session_dedupe_plan');
});

test('multiple image attachments on a single message produce separate artifacts', () => {
  const messages = [
    {
      id: 'multi-img',
      role: 'user',
      content: 'Two images',
      timestamp: '2026-03-17T10:00:00.000Z',
      attachments: [
        { id: 'img-a', kind: 'image', displayName: 'a.png', assetPath: '/a.png', sourceKind: 'file' },
        { id: 'img-b', kind: 'image', displayName: 'b.png', assetPath: '/b.png', sourceKind: 'clipboard' },
      ],
    },
  ];
  const artifacts = buildArtifactsFromMessages(messages, { sessionId: 's2' });
  assert.equal(artifacts.length, 2);
  const names = artifacts.map((a) => a.image.displayName).sort();
  assert.deepEqual(names, ['a.png', 'b.png']);
});

test('non-image attachments are excluded from artifacts', () => {
  const messages = [
    {
      id: 'text-attach',
      role: 'user',
      content: 'A text file',
      timestamp: '2026-03-17T10:00:00.000Z',
      attachments: [
        { id: 'txt-1', kind: 'text', displayName: 'notes.txt' },
      ],
    },
  ];
  const artifacts = buildArtifactsFromMessages(messages, { sessionId: 's3' });
  assert.equal(artifacts.length, 0);
});

test('normalizeArtifactFilter handles null, undefined, and empty string', () => {
  assert.equal(normalizeArtifactFilter(null), 'all');
  assert.equal(normalizeArtifactFilter(undefined), 'all');
  assert.equal(normalizeArtifactFilter(''), 'all');
  assert.equal(normalizeArtifactFilter(123), 'all');
});

test('artifact gallery image previews quote and encode file urls for CSS backgrounds', () => {
  const markup = renderArtifactCard({
    id: 'artifact-image-css',
    artifactType: IMAGE_FILTER,
    title: 'Preview image',
    previewText: 'Image attachment',
    timestamp: '2026-03-17T10:00:00.000Z',
    status: 'available',
    image: {
      assetPath: "C:/Users/Test/Artifact Folder/diagram(1)#draft?.png",
      sourceKind: 'capture',
    },
  }, {
    selected: false,
    escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },
    clipPreviewText(value) { return String(value || ''); },
    formatArtifactStatus(value) { return String(value || ''); },
    formatArtifactTimestamp(value) { return String(value || ''); },
    formatLanguageLabel(value) { return String(value || ''); },
    prettyPrintJson(value) { return String(value || ''); },
    toFileAssetUrl(value) { return String(value || ''); },
  });

  assert.match(markup, /background-image: url\('/);
  assert.match(markup, /diagram\(1\)#draft\?\.png/);
});

test('artifact gallery rejects remote, UNC, and malformed image paths before choosing thumbnail markup', () => {
  const deps = {
    selected: false,
    escapeHtml: (value) => String(value || ''),
    clipPreviewText: (value) => String(value || ''),
    formatArtifactStatus: (value) => String(value || ''),
    formatArtifactTimestamp: (value) => String(value || ''),
    formatLanguageLabel: (value) => String(value || ''),
    prettyPrintJson: (value) => String(value || ''),
    toFileAssetUrl: () => '',
  };
  for (const assetPath of ['https://example.com/a.png', '\\\\server\\share\\a.png', '\u0000bad.png']) {
    const markup = renderArtifactCard({
      id: `rejected-${assetPath.length}`,
      artifactType: IMAGE_FILTER,
      title: 'Rejected image',
      timestamp: '2026-03-17T10:00:00.000Z',
      status: 'available',
      image: { assetPath },
    }, deps);
    assert.match(markup, /Image unavailable/, assetPath);
    assert.doesNotMatch(markup, /background-image/, assetPath);
  }
});
