'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ARTIFACT_ERROR_CODES } = require('../services/artifact-workspace-errors');
const {
  assertRealPathInside,
  assertSessionScratchDirUnredirected,
} = require('../services/artifact-scratch-containment');

function scratchOptions(overrides = {}) {
  return {
    pathImpl: path.posix,
    realWorkspaceRoot: '/workspace',
    realScratchDir: '/workspace/.jenny/artifacts/session-a',
    sessionId: 'session-a',
    sessionArtifactRoot: '.jenny/artifacts',
    platform: 'linux',
    ...overrides,
  };
}

test('scratch identity accepts the normalized session path relative to the real root', () => {
  assert.equal(assertSessionScratchDirUnredirected(scratchOptions()), undefined);
  assert.equal(assertSessionScratchDirUnredirected(scratchOptions({
    realScratchDir: '/workspace/.jenny/artifacts/./session-a',
    sessionArtifactRoot: '.jenny/./artifacts',
  })), undefined);
});

test('scratch identity rejects another session and redirected ancestors', () => {
  for (const realScratchDir of [
    '/workspace/.jenny/artifacts/session-b',
    '/workspace/other/artifacts/session-a',
    '/outside/.jenny/artifacts/session-a',
  ]) {
    assert.throws(() => assertSessionScratchDirUnredirected(scratchOptions({ realScratchDir })), {
      code: ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES,
      message: 'Session scratch directory is redirected outside its own session.',
    });
  }
});

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`scratch identity uses ${platform} case comparison`, () => {
    const pathImpl = platform === 'win32' ? path.win32 : path.posix;
    const realWorkspaceRoot = platform === 'win32' ? 'C:\\workspace' : '/workspace';
    const options = scratchOptions({
      pathImpl, platform, realWorkspaceRoot,
      realScratchDir: pathImpl.join(realWorkspaceRoot, '.JENNY', 'ARTIFACTS', 'SESSION-A'),
      sessionArtifactRoot: pathImpl.join('.jenny', 'artifacts'),
    });
    if (platform !== 'win32') {
      assert.throws(() => assertSessionScratchDirUnredirected(options), {
        code: ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES,
      });
    } else {
      assert.equal(assertSessionScratchDirUnredirected(options), undefined);
    }
  });
}

test('real path containment returns the real target and rejects escaped targets', async () => {
  const fsImpl = { realpath: async (target) => ({
    '/root-link': '/real-root',
    '/root-link/file': '/real-root/file',
    '/root-link/escape': '/outside/file',
  })[target] };
  assert.equal(await assertRealPathInside(fsImpl, path.posix, '/root-link/file', '/root-link'), '/real-root/file');
  await assert.rejects(() => assertRealPathInside(fsImpl, path.posix, '/root-link/escape', '/root-link'), {
    code: ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES,
    message: 'Resolved path escapes the expected parent directory.',
  });
});
