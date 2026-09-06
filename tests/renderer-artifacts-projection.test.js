'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  IMAGE_FILTER,
  buildArtifactsFromMessages,
} = require('../renderer/features/renderer-artifacts-projection');

test('generated image artifacts project into the image rail model', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-use-browser-shot',
      role: 'assistant',
      kind: 'tool_use',
      timestamp: '2026-05-16T12:00:00.000Z',
      tool_call: {
        call_id: 'call-browser-shot',
        tool_name: 'mermaid_generate',
        summary: 'Capture local page screenshot',
      },
    },
    {
      id: 'tool-result-browser-shot',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-05-16T12:00:01.000Z',
      tool_result: {
        call_id: 'call-browser-shot',
        tool_name: 'mermaid_generate',
        summary: 'Captured local page screenshot',
        output_text: 'Created image "Local page screenshot" at .jenny/artifacts/session-1/local-page-screenshot.png',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_image_session_1_local_page_screenshot',
          artifact_kind: 'image',
          title: 'Local page screenshot',
          file_name: 'local-page-screenshot.png',
          display_path: '.jenny/artifacts/session-1/local-page-screenshot.png',
          absolute_path: 'C:/workspace/.jenny/artifacts/session-1/local-page-screenshot.png',
          mime_type: 'image/png',
          width: 1280,
          height: 720,
          source_kind: 'capture',
          editable: false,
          status: 'available',
          local_trusted: true,
        }],
      },
    },
  ], { sessionId: 'session-1' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifactType, IMAGE_FILTER);
  assert.equal(artifacts[0].sourceKind, 'generated_artifact');
  assert.equal(artifacts[0].image.mimeType, 'image/png');
  assert.equal(artifacts[0].image.width, 1280);
  assert.equal(artifacts[0].image.height, 720);
  assert.equal(artifacts[0].image.sourceKind, 'capture');
  assert.match(artifacts[0].previewText, /Screenshot - 1280 x 720/);
  assert.equal(artifacts[0].image.assetPath, 'C:/workspace/.jenny/artifacts/session-1/local-page-screenshot.png');
  assert.equal(artifacts[0].generatedFile, undefined);
});

test('legacy generated image artifacts trust only session-scoped artifact paths when local trust is absent', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-result-legacy-image',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-05-16T12:00:01.000Z',
      tool_result: {
        call_id: 'call-legacy-image',
        tool_name: 'image_generate',
        summary: 'Generated image before trust metadata existed',
        output_text: 'Created image metadata',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_image_session_1_legacy',
          artifact_kind: 'image',
          title: 'Legacy image',
          file_name: 'legacy.png',
          display_path: '.jenny/artifacts/session-1/legacy.png',
          absolute_path: 'C:/workspace/.jenny/artifacts/session-1/legacy.png',
          mime_type: 'image/png',
          width: 400,
          height: 240,
          editable: false,
          status: 'available',
        }],
      },
    },
  ], { sessionId: 'session-1' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifactType, IMAGE_FILTER);
  assert.equal(artifacts[0].status, 'available');
  assert.equal(artifacts[0].image.assetPath, 'C:/workspace/.jenny/artifacts/session-1/legacy.png');
  assert.match(artifacts[0].previewText, /Image - 400 x 240/);
});

test('generated image artifacts honor explicit untrusted local path markers', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-result-untrusted-local-image',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-05-16T12:00:01.000Z',
      tool_result: {
        call_id: 'call-untrusted-local-image',
        tool_name: 'image_generate',
        summary: 'Imported untrusted image metadata',
        output_text: 'Imported image metadata',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_image_session_1_untrusted_local',
          artifact_kind: 'image',
          title: 'Untrusted local image',
          file_name: 'untrusted.png',
          display_path: '.jenny/artifacts/session-1/untrusted.png',
          absolute_path: 'C:/workspace/.jenny/artifacts/session-1/untrusted.png',
          mime_type: 'image/png',
          width: 400,
          height: 240,
          editable: false,
          status: 'available',
          local_trusted: false,
        }],
      },
    },
  ], { sessionId: 'session-1' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifactType, IMAGE_FILTER);
  assert.equal(artifacts[0].status, 'missing');
  assert.equal(artifacts[0].image.assetPath, '');
});

test('generated image artifacts resolve redacted trusted paths through artifact reads', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-result-redacted-image',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-05-16T12:00:01.000Z',
      tool_result: {
        call_id: 'call-redacted-image',
        tool_name: 'mermaid_generate',
        summary: 'Captured redacted image metadata',
        output_text: 'Captured image metadata',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_image_session_1_redacted',
          artifact_kind: 'image',
          title: 'Redacted local image',
          file_name: 'redacted.png',
          display_path: '.jenny/artifacts/session-1/redacted.png',
          absolute_path: '[redacted:path]',
          mime_type: 'image/png',
          width: 400,
          height: 240,
          editable: false,
          status: 'available',
          local_trusted: true,
        }],
      },
    },
  ], { sessionId: 'session-1' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifactType, IMAGE_FILTER);
  assert.equal(artifacts[0].status, 'available');
  assert.equal(artifacts[0].image.assetPath, '');
  assert.equal(artifacts[0].image.artifactId, 'artifact_image_session_1_redacted');
  assert.equal(artifacts[0].image.requiresArtifactRead, true);
});


test('generated image artifacts reject spoofed session-scoped imported paths without local trust', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-result-spoofed-path',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-05-16T12:00:01.000Z',
      tool_result: {
        call_id: 'call-spoofed-path',
        tool_name: 'mermaid_generate',
        summary: 'Imported screenshot metadata',
        output_text: 'Imported image metadata',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_image_session_1_spoof',
          artifact_kind: 'image',
          title: 'Spoofed screenshot',
          file_name: 'spoof.png',
          display_path: '.jenny/artifacts/session-1/spoof.png',
          absolute_path: 'C:/Users/Alice/secret.png',
          mime_type: 'image/png',
          width: 100,
          height: 100,
          editable: false,
          status: 'available',
        }],
      },
    },
  ], { sessionId: 'session-1' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifactType, IMAGE_FILTER);
  assert.equal(artifacts[0].status, 'missing');
  assert.equal(artifacts[0].image.assetPath, '');
});

test('generated image artifacts reject imported absolute paths outside the session artifact scope', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-result-imported-path',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-05-16T12:00:01.000Z',
      tool_result: {
        call_id: 'call-imported-path',
        tool_name: 'mermaid_generate',
        summary: 'Imported screenshot metadata',
        output_text: 'Imported image metadata',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_image_session_1_secret',
          artifact_kind: 'image',
          title: 'Secret screenshot',
          file_name: 'secret.png',
          display_path: 'C:/Users/Alice/secret.png',
          absolute_path: 'C:/Users/Alice/secret.png',
          mime_type: 'image/png',
          width: 100,
          height: 100,
          editable: false,
          status: 'available',
        }],
      },
    },
  ], { sessionId: 'session-1' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifactType, IMAGE_FILTER);
  assert.equal(artifacts[0].status, 'missing');
  assert.equal(artifacts[0].image.assetPath, '');
});

test('generated preview image artifacts project through the generic image path', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-result-pdf-preview',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-05-16T12:00:01.000Z',
      tool_result: {
        call_id: 'call-pdf-preview',
        tool_name: 'mermaid_generate',
        summary: 'Inspected PDF and generated preview image',
        output_text: 'Created image preview for page 1',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_image_session_1_pdf_page_1',
          artifact_kind: 'image',
          title: 'PDF page 1',
          file_name: 'report-page-1.png',
          display_path: '.jenny/artifacts/session-1/report-page-1.png',
          absolute_path: 'C:/workspace/.jenny/artifacts/session-1/report-page-1.png',
          mime_type: 'image/png',
          width: 200,
          height: 120,
          editable: false,
          status: 'available',
          local_trusted: true,
        }],
      },
    },
  ], { sessionId: 'session-1' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].artifactType, IMAGE_FILTER);
  assert.equal(artifacts[0].sourceKind, 'generated_artifact');
  assert.equal(artifacts[0].image.mimeType, 'image/png');
  assert.equal(artifacts[0].image.width, 200);
  assert.equal(artifacts[0].image.height, 120);
  assert.equal(artifacts[0].image.sourceKind, '');
  assert.match(artifacts[0].previewText, /Image - 200 x 120/);
  assert.equal(artifacts[0].generatedFile, undefined);
});

/* ── WS2 Step 5: additive mime threading + new kind predicates ── */

const {
  buildArtifactsFromMessages: buildArtifactsWs2,
  inferGeneratedArtifactLanguage,
  isChartGeneratedArtifact,
  isHtmlGeneratedArtifact,
  isSvgGeneratedArtifact,
} = require('../renderer/features/renderer-artifacts-projection');

function generatedFileMessagePair(metadata) {
  return [
    {
      id: 'tool-result-gen',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-07-01T10:00:01.000Z',
      tool_result: {
        call_id: 'call-gen',
        tool_name: 'create_artifact',
        summary: 'Generated a file',
        output_text: 'ok',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_gen_1',
          artifact_kind: 'document',
          title: 'Generated file',
          editable: true,
          status: 'available',
          ...metadata,
        }],
      },
    },
  ];
}

test('generatedFile projection threads mime_type through as mimeType', () => {
  const artifacts = buildArtifactsWs2(generatedFileMessagePair({
    file_name: 'page.html',
    display_path: '.jenny/artifacts/s1/page.html',
    language: 'html',
    mime_type: 'text/html',
  }), { sessionId: 's1' });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].generatedFile.mimeType, 'text/html');
});

test('generatedFile projection defaults mimeType to the empty string when absent', () => {
  const artifacts = buildArtifactsWs2(generatedFileMessagePair({
    file_name: 'diagram.mmd',
    display_path: '.jenny/artifacts/s1/diagram.mmd',
    language: 'mermaid',
  }), { sessionId: 's1' });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].generatedFile.mimeType, '');
});

test('inferGeneratedArtifactLanguage covers the new html/svg/chart extensions', () => {
  assert.equal(inferGeneratedArtifactLanguage({ file_name: 'page.html' }), 'html');
  assert.equal(inferGeneratedArtifactLanguage({ file_name: 'page.htm' }), 'html');
  assert.equal(inferGeneratedArtifactLanguage({ display_path: 'a/icon.svg' }), 'svg');
  assert.equal(inferGeneratedArtifactLanguage({ file_name: 'sales.vl.json' }), 'chart');
  assert.equal(inferGeneratedArtifactLanguage({ file_name: 'sales.vega.json' }), 'chart');
  assert.equal(inferGeneratedArtifactLanguage({ file_name: 'sales.chart.json' }), 'chart');
  assert.equal(inferGeneratedArtifactLanguage({ file_name: 'diagram.mmd' }), 'mermaid');
  assert.equal(inferGeneratedArtifactLanguage({ file_name: 'plain.json' }), '');
});

test('new kind predicates true/false table', () => {
  const generated = (file) => ({ artifactType: 'generated_file', generatedFile: file });
  // html
  assert.equal(isHtmlGeneratedArtifact(generated({ language: 'html' })), true);
  assert.equal(isHtmlGeneratedArtifact(generated({ fileName: 'x.htm' })), true);
  assert.equal(isHtmlGeneratedArtifact(generated({ displayPath: 'a/x.html' })), true);
  assert.equal(isHtmlGeneratedArtifact(generated({ language: 'python' })), false);
  assert.equal(isHtmlGeneratedArtifact({ artifactType: 'tool_output' }), false);
  assert.equal(isHtmlGeneratedArtifact(null), false);
  // svg
  assert.equal(isSvgGeneratedArtifact(generated({ language: 'svg' })), true);
  assert.equal(isSvgGeneratedArtifact(generated({ fileName: 'icon.svg' })), true);
  assert.equal(isSvgGeneratedArtifact(generated({ language: 'html' })), false);
  assert.equal(isSvgGeneratedArtifact(null), false);
  // chart
  assert.equal(isChartGeneratedArtifact(generated({ language: 'chart' })), true);
  assert.equal(isChartGeneratedArtifact(generated({ language: 'vega-lite' })), true);
  assert.equal(isChartGeneratedArtifact(generated({ fileName: 'q.vl.json' })), true);
  assert.equal(isChartGeneratedArtifact(generated({ fileName: 'plain.json' })), false);
  assert.equal(isChartGeneratedArtifact(null), false);
  // mime-based detection for kinds the sidecar ArtifactSpec path stamps
  assert.equal(isHtmlGeneratedArtifact(generated({ mimeType: 'text/html' })), true);
  assert.equal(isSvgGeneratedArtifact(generated({ mimeType: 'image/svg+xml' })), true);
});

/* ── HTML Artifact Preview Step 3: executable-vs-inert routing predicate ── */

const {
  isExecutableHtmlArtifact,
} = require('../renderer/features/renderer-artifacts-projection');

test('isExecutableHtmlArtifact truth table (html executable, inert svg stays inline, svg-with-script executable)', () => {
  const generated = (file) => ({ artifactType: 'generated_file', generatedFile: file });
  // html artifacts are executable regardless of content
  assert.equal(isExecutableHtmlArtifact(generated({ language: 'html' }), '<p>hi</p>'), true);
  assert.equal(isExecutableHtmlArtifact(generated({ fileName: 'page.htm' }), ''), true);
  assert.equal(isExecutableHtmlArtifact(generated({ mimeType: 'text/html' }), '<div></div>'), true);
  // inert svg is NOT executable — it stays on the WS2 strict-DOMPurify inline path
  assert.equal(isExecutableHtmlArtifact(generated({ language: 'svg' }), '<svg><rect/></svg>'), false);
  assert.equal(isExecutableHtmlArtifact(generated({ fileName: 'icon.svg' }), '<svg/>'), false);
  // an svg carrying <script> is executable and routes to the sandbox iframe
  assert.equal(
    isExecutableHtmlArtifact(generated({ language: 'svg' }), '<svg><script>animate()</script></svg>'),
    true
  );
  assert.equal(
    isExecutableHtmlArtifact(generated({ fileName: 'anim.svg' }), '<svg>\n  <SCRIPT href="x">\n</svg>'),
    true
  );
  // mermaid / markdown / code / tool output / null are never executable html
  assert.equal(isExecutableHtmlArtifact(generated({ language: 'mermaid' }), 'flowchart TD'), false);
  assert.equal(isExecutableHtmlArtifact(generated({ language: 'markdown' }), '# hi'), false);
  assert.equal(isExecutableHtmlArtifact(generated({ language: 'python' }), 'print(1)'), false);
  assert.equal(isExecutableHtmlArtifact({ artifactType: 'tool_output' }, '<p>x</p>'), false);
  assert.equal(isExecutableHtmlArtifact(null, '<p>x</p>'), false);
  // svg script detection requires a real tag, not the substring in text
  assert.equal(
    isExecutableHtmlArtifact(generated({ language: 'svg' }), '<svg><text>a script walkthrough</text></svg>'),
    false
  );
});

/* ── Wave-R #18: post-delete catalog reconciliation ── */

const { filterDeletedArtifacts } = require('../renderer/features/renderer-artifacts-projection');

test('filterDeletedArtifacts excludes only the deleted artifact, scoped to its own session', () => {
  const artifacts = [
    { id: 'artifact-a', sessionId: 'session-1' },
    { id: 'artifact-b', sessionId: 'session-1' },
  ];
  const deletedIds = ['session-1::artifact-a', 'session-2::artifact-b'];
  const result = filterDeletedArtifacts(artifacts, deletedIds, 'session-1');
  assert.deepEqual(result.map((a) => a.id), ['artifact-b'], 'artifact-a is deleted in session-1; artifact-b\'s session-2 key must not match');
});

test('filterDeletedArtifacts is a no-op with no deletions and tolerates malformed input', () => {
  const artifacts = [{ id: 'artifact-a', sessionId: 'session-1' }];
  assert.deepEqual(filterDeletedArtifacts(artifacts, [], 'session-1'), artifacts);
  assert.deepEqual(filterDeletedArtifacts(artifacts, null, 'session-1'), artifacts);
  assert.deepEqual(filterDeletedArtifacts(null, ['session-1::artifact-a'], 'session-1'), []);
});

test('file-write tool results carry the structured diff and target path for the panel', () => {
  const diff = {
    path: 'workspace/hellodemo.md',
    status: 'created',
    additions: 9,
    deletions: 0,
    truncated: false,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+# Hello Demo!'] }],
  };
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-result-write',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-05-16T12:00:01.000Z',
      tool_result: {
        call_id: 'call-write',
        tool_name: 'write_file',
        summary: 'Write workspace/hellodemo.md',
        output_text: 'Wrote 275 bytes to workspace/hellodemo.md',
        is_error: false,
        metadata: { path: 'workspace/hellodemo.md', bytes_written: 275, diff },
      },
    },
  ], { sessionId: 'session-1' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].sourceKind, 'tool_result');
  assert.deepEqual(artifacts[0].diff, diff);
  assert.equal(artifacts[0].filePath, 'workspace/hellodemo.md');
});

test('tool results without file metadata project a null diff and empty path', () => {
  const artifacts = buildArtifactsFromMessages([
    {
      id: 'tool-result-plain',
      role: 'tool',
      kind: 'tool_result',
      timestamp: '2026-05-16T12:00:01.000Z',
      tool_result: {
        call_id: 'call-plain',
        tool_name: 'run_command',
        summary: 'Run dir',
        output_text: 'listing',
        is_error: false,
      },
    },
  ], { sessionId: 'session-1' });

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].diff, null);
  assert.equal(artifacts[0].filePath, '');
});
