'use strict';

// HTML Artifact Preview Step 6 (reconciled): every regeneration creates a NEW
// artifact (buildArtifactId seeds randomly; filename collisions suffix -2/-3),
// so version history is DERIVED from the projected session artifacts by
// filename-stem grouping — there is no separate persisted version store. These
// tests pin the grouping, ordering, stepping ids, bounded cap, and safe
// defaults.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_VERSION_HISTORY_ENTRIES,
  buildArtifactVersionGroupKey,
  resolveArtifactVersionInfo,
} = require('../renderer/features/renderer-artifact-version-history-utils.js');

function generatedMessage(artifactId, fileName, timestamp) {
  return {
    id: `msg-${artifactId}`,
    role: 'tool',
    kind: 'tool_result',
    timestamp,
    finalizedAt: timestamp,
    tool_result: {
      call_id: `call-${artifactId}`,
      tool_name: 'create_artifact',
      summary: 'Generated a file',
      output_text: 'ok',
      is_error: false,
      generated_artifacts: [{
        artifact_id: artifactId,
        artifact_kind: 'document',
        title: fileName,
        file_name: fileName,
        display_path: `.jenny/artifacts/s1/${fileName}`,
        language: fileName.endsWith('.svg') ? 'svg' : 'html',
        editable: true,
        status: 'available',
      }],
    },
  };
}

function makeState(messages) {
  return { messagesBySession: new Map([['s1', messages]]) };
}

function artifactRef(artifactId, fileName) {
  return {
    id: artifactId,
    sessionId: 's1',
    artifactType: 'generated_file',
    generatedFile: { artifactId, fileName, displayPath: `.jenny/artifacts/s1/${fileName}`, language: 'html' },
  };
}

/* ── group keys ── */

test('regeneration suffixes collapse into one group key; distinct stems and extensions do not', () => {
  const candidates = new Set(['chart.html', 'chart-2.html', 'chart-13.html']);
  const base = buildArtifactVersionGroupKey('s1', 'chart.html', candidates);
  assert.equal(buildArtifactVersionGroupKey('s1', 'chart-2.html', candidates), base);
  assert.equal(buildArtifactVersionGroupKey('s1', 'chart-13.html', candidates), base);
  assert.notEqual(buildArtifactVersionGroupKey('s1', 'other.html', candidates), base);
  assert.notEqual(buildArtifactVersionGroupKey('s1', 'chart.svg', candidates), base);
  assert.notEqual(buildArtifactVersionGroupKey('s2', 'chart.html', candidates), base);
  assert.equal(buildArtifactVersionGroupKey('s1', ''), '');
});

/* ── version resolution ── */

test('N regenerations resolve as N ordered versions with stepping ids', () => {
  const messages = [
    generatedMessage('a1', 'chart.html', '2026-07-02T10:00:00.000Z'),
    generatedMessage('a2', 'chart-2.html', '2026-07-02T10:05:00.000Z'),
    generatedMessage('a3', 'chart-3.html', '2026-07-02T10:10:00.000Z'),
    generatedMessage('zz', 'other.html', '2026-07-02T10:07:00.000Z'),
  ];
  const state = makeState(messages);

  const first = resolveArtifactVersionInfo(artifactRef('a1', 'chart.html'), state);
  assert.deepEqual(first, { index: 1, count: 3, prevId: '', nextId: 'a2' });

  const middle = resolveArtifactVersionInfo(artifactRef('a2', 'chart-2.html'), state);
  assert.deepEqual(middle, { index: 2, count: 3, prevId: 'a1', nextId: 'a3' });

  const latest = resolveArtifactVersionInfo(artifactRef('a3', 'chart-3.html'), state);
  assert.deepEqual(latest, { index: 3, count: 3, prevId: 'a2', nextId: '' });

  const unrelated = resolveArtifactVersionInfo(artifactRef('zz', 'other.html'), state);
  assert.deepEqual(unrelated, { index: 1, count: 1, prevId: '', nextId: '' });
});

test('independently authored numbered files remain separate histories', () => {
  const messages = [
    generatedMessage('a1', 'slide-1.html', '2026-07-02T10:00:00.000Z'),
    generatedMessage('a2', 'slide-2.html', '2026-07-02T10:05:00.000Z'),
  ];
  const state = makeState(messages);

  assert.deepEqual(resolveArtifactVersionInfo(artifactRef('a1', 'slide-1.html'), state), {
    index: 1, count: 1, prevId: '', nextId: '',
  });
  assert.deepEqual(resolveArtifactVersionInfo(artifactRef('a2', 'slide-2.html'), state), {
    index: 1, count: 1, prevId: '', nextId: '',
  });
});

test('a regenerated numbered file groups only with its authored unsuffixed filename', () => {
  const messages = [
    generatedMessage('a1', 'slide-1.html', '2026-07-02T10:00:00.000Z'),
    generatedMessage('a2', 'slide-1-2.html', '2026-07-02T10:05:00.000Z'),
  ];
  const state = makeState(messages);

  assert.deepEqual(resolveArtifactVersionInfo(artifactRef('a2', 'slide-1-2.html'), state), {
    index: 2, count: 2, prevId: 'a1', nextId: '',
  });
});

test('a new regeneration while viewing an old version bumps count without moving the viewed index', () => {
  const messages = [
    generatedMessage('a1', 'chart.html', '2026-07-02T10:00:00.000Z'),
    generatedMessage('a2', 'chart-2.html', '2026-07-02T10:05:00.000Z'),
  ];
  const state = makeState(messages);
  assert.deepEqual(resolveArtifactVersionInfo(artifactRef('a1', 'chart.html'), state), {
    index: 1, count: 2, prevId: '', nextId: 'a2',
  });
  // Regeneration arrives: messages array is REPLACED (renderer state contract),
  // so the derived history must recompute despite the internal cache.
  state.messagesBySession.set('s1', [
    ...messages,
    generatedMessage('a3', 'chart-3.html', '2026-07-02T10:10:00.000Z'),
  ]);
  assert.deepEqual(resolveArtifactVersionInfo(artifactRef('a1', 'chart.html'), state), {
    index: 1, count: 3, prevId: '', nextId: 'a2',
  });
});

test('history is bounded: only the newest MAX entries are browsable', () => {
  const messages = [];
  const total = MAX_VERSION_HISTORY_ENTRIES + 5;
  for (let i = 1; i <= total; i += 1) {
    const fileName = i === 1 ? 'chart.html' : `chart-${i}.html`;
    messages.push(generatedMessage(`a${i}`, fileName, `2026-07-02T10:${String(i).padStart(2, '0')}:00.000Z`));
  }
  const state = makeState(messages);
  const newest = resolveArtifactVersionInfo(artifactRef(`a${total}`, `chart-${total}.html`), state);
  assert.equal(newest.count, MAX_VERSION_HISTORY_ENTRIES);
  assert.equal(newest.index, MAX_VERSION_HISTORY_ENTRIES);
  // An artifact older than the cap window resolves to the safe default (null).
  assert.equal(resolveArtifactVersionInfo(artifactRef('a1', 'chart.html'), state), null);
});

/* ── safe defaults ── */

test('malformed inputs resolve to null, never throw', () => {
  const state = makeState([generatedMessage('a1', 'chart.html', '2026-07-02T10:00:00.000Z')]);
  assert.equal(resolveArtifactVersionInfo(null, state), null);
  assert.equal(resolveArtifactVersionInfo({ artifactType: 'tool_output' }, state), null);
  assert.equal(resolveArtifactVersionInfo(artifactRef('a1', ''), state), null);
  assert.equal(resolveArtifactVersionInfo(artifactRef('a1', 'chart.html'), {}), null);
  assert.equal(resolveArtifactVersionInfo(artifactRef('a1', 'chart.html'), { messagesBySession: new Map() }), null);
  assert.equal(resolveArtifactVersionInfo(artifactRef('a1', 'chart.html'), null), null);
});
