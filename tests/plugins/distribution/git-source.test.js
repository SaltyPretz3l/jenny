'use strict';
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const test = require('node:test'); const assert = require('node:assert/strict');
const { acquireGitPackage } = require('../../../services/plugins/distribution/git-source');
test('Git source exports only an immutable commit and cleans its temporary repository', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jenny-git-test-'));
  try {
    const calls = []; const result = await acquireGitPackage({ locator: 'https://example.test/repo.git', tempRoot: root,
      createProxy: async () => ({ ok: true, proxy_url: 'http://127.0.0.1:4321', close: async () => {} }),
      runGit: async (cwd, args, options) => { calls.push({ args, options });
        if (args[0] === 'rev-parse') return { success: true, stdout: `${'a'.repeat(40)}\n`, stderr: '', reason: '', message: '' };
        if (args[0] === 'archive') await fs.promises.writeFile(path.join(path.dirname(cwd), 'package.zip'), Buffer.from('zip'));
        return { success: true, stdout: '', stderr: '', reason: '', message: '' }; } });
    assert.equal(result.ok, true); assert.equal(result.pinned_commit, 'a'.repeat(40));
    assert.equal(calls.every((call) => call.options.pluginFetchProfile), true);
    assert.deepEqual(await fs.promises.readdir(root), []);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});
test('Git source cleanup failure does not replace a successful acquisition', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jenny-git-cleanup-test-'));
  const originalRm = fs.promises.rm;
  try {
    fs.promises.rm = async (target, options) => {
      if (path.basename(target).startsWith('jenny-plugin-git-')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return originalRm(target, options);
    };
    const result = await acquireGitPackage({ locator: 'https://example.test/repo.git', tempRoot: root,
      createProxy: async () => ({ ok: true, proxy_url: 'http://127.0.0.1:4321', close: async () => {} }),
      runGit: async (cwd, args) => {
        if (args[0] === 'rev-parse') return { success: true, stdout: `${'b'.repeat(40)}\n`, reason: '' };
        if (args[0] === 'archive') await fs.promises.writeFile(path.join(path.dirname(cwd), 'package.zip'), Buffer.from('zip'));
        return { success: true, stdout: '', reason: '' };
      } });
    assert.equal(result.ok, true); assert.equal(result.pinned_commit, 'b'.repeat(40)); assert.deepEqual(result.bytes, Buffer.from('zip'));
  } finally {
    fs.promises.rm = originalRm;
    await originalRm(root, { recursive: true, force: true });
  }
});
