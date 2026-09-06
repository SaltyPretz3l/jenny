'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  cloneSortKey,
  deepCloneJsonValue,
  extractToolCallId,
  normalizeGeneratedArtifact,
  normalizeToolLifecycleStatus,
  pushDistinct,
  sortKeyCompare,
} = require('../renderer/chat/renderer-turn-normalization-utils');

describe('renderer-turn-normalization-utils', () => {
  test('normalizes generated artifact payloads consistently', () => {
    const artifact = normalizeGeneratedArtifact({
      artifactId: ' artifact-1 ',
      sessionId: ' session-1 ',
      artifactKind: 'Code',
      fileName: 'demo.js',
      absolutePath: 'C:/Users/demo/.jenny/artifacts/demo.js',
      sourceKind: 'Capture',
      localTrusted: true,
    });
    assert.ok(artifact);
    assert.equal(artifact.artifact_id, 'artifact-1');
    assert.equal(artifact.session_id, 'session-1');
    assert.equal(artifact.artifact_kind, 'code');
    assert.equal(artifact.file_name, 'demo.js');
    assert.equal(artifact.absolute_path, '[redacted:path]');
    assert.equal(artifact.source_kind, 'capture');
    assert.equal(artifact.local_trusted, true);
    assert.equal(normalizeGeneratedArtifact({ artifactId: '   ' }), null);
  });

  test('normalizes malformed and non-finite artifact dimensions to zero', () => {
    const malformed = normalizeGeneratedArtifact({
      artifactId: 'artifact-malformed',
      width: 'not-a-number',
      height: Infinity,
    });
    const nonFinite = normalizeGeneratedArtifact({
      artifactId: 'artifact-non-finite',
      width: -Infinity,
      height: NaN,
    });

    assert.deepEqual(
      { width: malformed.width, height: malformed.height },
      { width: 0, height: 0 }
    );
    assert.deepEqual(
      { width: nonFinite.width, height: nonFinite.height },
      { width: 0, height: 0 }
    );
  });

  test('normalizes tool lifecycle status aliases', () => {
    assert.equal(normalizeToolLifecycleStatus('timeout'), 'timed_out');
    assert.equal(normalizeToolLifecycleStatus('timed_out'), 'timed_out');
    assert.equal(normalizeToolLifecycleStatus('preempted'), 'cancelled');
  });

  test('deep clones json values with cycle and prototype-key protection', () => {
    const value = { ok: true, nested: { label: 'safe' }, __proto__: { polluted: true } };
    value.self = value;

    const cloned = deepCloneJsonValue(value);

    assert.deepEqual(cloned.nested, { label: 'safe' });
    assert.deepEqual(cloned.self, {});
    assert.equal(Object.hasOwn(cloned, '__proto__'), false);
  });

  test('normalizes sort keys and distinct IDs', () => {
    assert.deepEqual(cloneSortKey(['2', 'bad', 4]), [2, 0, 4]);
    assert.equal(sortKeyCompare([0, 1, 0], [0, 0, 9]) > 0, true);
    const values = ['a'];
    pushDistinct(values, ' a ');
    pushDistinct(values, 'b');
    assert.deepEqual(values, ['a', 'b']);
  });

  test('extracts tool call ids across wire and renderer shapes', () => {
    assert.equal(extractToolCallId({ callId: ' call-1 ' }), 'call-1');
    assert.equal(extractToolCallId({ tool_call_id: ' call-2 ' }), 'call-2');
    assert.equal(extractToolCallId({ tool_call: { call_id: ' call-3 ' } }), 'call-3');
    assert.equal(extractToolCallId({}), '');
  });
});
