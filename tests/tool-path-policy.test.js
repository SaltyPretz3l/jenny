'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { ToolPathPolicy } = require('../services/tools/tool-path-policy');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createPolicy() {
  return new ToolPathPolicy({ fs: fsp, path, logger() {} });
}

test('ToolPathPolicy allows new paths that remain under the workspace root', async () => {
  const root = createTrackedTempDir('jenny-tool-path-root-');
  const policy = createPolicy();
  const requested = path.join(root, 'nested', 'new-file.txt');

  const resolved = await policy.assertInsideRoot(requested, { workingDirectory: root });

  assert.equal(path.resolve(resolved), path.resolve(requested));
});

test('ToolPathPolicy allows descendants when the workspace is a drive root', async () => {
  const winPath = path.win32;
  const policy = new ToolPathPolicy({
    fs: { realpath: async (value) => winPath.resolve(value) },
    path: winPath,
    logger() {},
  });

  const resolved = await policy.assertInsideRoot('C:/temp/file.txt', {
    workingDirectory: 'C:/',
  });

  assert.equal(resolved, 'C:\\temp\\file.txt');
});

test('ToolPathPolicy rejects new paths below symlinked parents outside the workspace root', async (t) => {
  const root = createTrackedTempDir('jenny-tool-path-root-');
  const outside = createTrackedTempDir('jenny-tool-path-outside-');
  const linkPath = path.join(root, 'escape-link');
  const policy = createPolicy();

  try {
    await fsp.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const requested = path.join(linkPath, 'new-file.txt');
  await assert.rejects(
    () => policy.assertInsideRoot(requested, { workingDirectory: root }),
    /outside the working directory/
  );
  assert.equal(fs.existsSync(requested), false);
});
