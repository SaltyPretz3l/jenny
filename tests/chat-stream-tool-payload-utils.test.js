'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeGeneratedArtifactsFromNotification,
  toolResultExitCode,
} = require('../services/backend/chat-stream-tool-payload-utils');

// Dogfood HB-035: the sidecar shell tool reports exit_code, so the stored tool
// result's exit_code was always null.
test('the stored exit status reads the sidecar wire key and the older shape', () => {
  assert.equal(toolResultExitCode({ exit_code: 1 }), 1);
  assert.equal(toolResultExitCode({ exitCode: 3 }), 3);
  assert.equal(toolResultExitCode({ exit_code: 0 }), 0);
  assert.equal(toolResultExitCode({ shell: 'cmd.exe' }), null);
  assert.equal(toolResultExitCode({ exit_code: 'x' }), null);
  assert.equal(toolResultExitCode(null), null);
  assert.equal(toolResultExitCode([1]), null);
});

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
