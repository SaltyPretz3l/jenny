'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeGeneratedArtifactsFromNotification,
} = require('../services/backend/chat-stream-tool-payload-utils');

test('generated artifact traversal checks allow consecutive dots within path segments', () => {
  const artifacts = normalizeGeneratedArtifactsFromNotification([
    {
      artifact_id: 'valid',
      title: 'Versioned',
      file_name: 'report..final.txt',
      display_path: 'out/report..final.txt',
      absolute_path: 'C:\\workspace\\out\\report..final.txt',
    },
    {
      artifact_id: 'traversal',
      title: 'Traversal',
      file_name: 'secret.txt',
      display_path: 'out/../secret.txt',
    },
    {
      artifact_id: 'nul',
      title: 'Nul',
      file_name: 'bad.txt',
      display_path: 'out/bad\0.txt',
    },
  ]);

  assert.deepEqual(artifacts.map((artifact) => artifact.artifact_id), ['valid']);
  assert.equal(artifacts[0].file_name, 'report..final.txt');
  assert.equal(artifacts[0].display_path, 'out/report..final.txt');
});
