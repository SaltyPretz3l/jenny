'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ArtifactWorkspaceService } = require('../services/artifact-workspace-service');
const { PNG } = require('./helpers/preview-capture-fixture');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');
test.afterEach(cleanupTrackedResources);

function setup() {
  const root = createTrackedTempDir('preview-cache-');
  const make = (fsImpl) => {
    const service = new ArtifactWorkspaceService({
      configService: { getState: () => ({ toolsWorkspaceRoot: root }) },
      fsImpl,
    });
    return { createPreviewScreenshot: (session, options) => service.createBinaryArtifact(session, {
      ...options, previewScreenshot: true,
    }) };
  };
  return { root, make };
}
const input = { content: PNG, width: 2, height: 1 };
const index = async (root) => JSON.parse(await fs.readFile(path.join(root, '.jenny/artifacts/.preview-captures.json'), 'utf8'));

test('1,000 save attempts retain four captures across service restarts', async () => {
  const { root, make } = setup();
  let service = make();
  const first = await service.createPreviewScreenshot('session', input);
  await fs.writeFile(path.join(root, '.jenny/artifacts/session/user.png'), PNG);
  for (let i = 1; i < 1000; i += 1) {
    if (i === 500) service = make();
    if (i < 4) await service.createPreviewScreenshot('session', input);
    else await assert.rejects(service.createPreviewScreenshot('session', input), /storage is full/);
  }
  const entries = (await index(root)).entries;
  assert.equal(entries.length, 4);
  const files = await fs.readdir(path.join(root, '.jenny/artifacts/session'));
  assert.equal(files.length, 5);
  assert.ok(files.includes('user.png'));
  assert.deepEqual(await fs.readFile(path.join(root, first.metadata.display_path)), PNG);
  assert.ok(entries.every((entry) => files.includes(entry.file)));
});
test('concurrent saves across sessions respect workspace count and byte bounds', async () => {
  const { root, make } = setup();
  const service = make();
  const second = make();
  const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) =>
    (i % 2 ? service : second).createPreviewScreenshot(`s${i}`, input)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 32);
  assert.ok(results.filter((result) => result.status === 'rejected')
    .every((result) => /storage is full/.test(result.reason.message)));
  const entries = (await index(root)).entries;
  assert.equal(entries.length, 32);
  const files = (await fs.readdir(path.join(root, '.jenny/artifacts'), { recursive: true }))
    .filter((file) => file.endsWith('.png'));
  assert.equal(files.length, 32);
  await assert.rejects(service.createPreviewScreenshot('s', { content: Buffer.alloc(2 * 1024 * 1024 + 1) }));
});
test('full storage preserves modified captures without adding images', async () => {
  const { root, make } = setup();
  const service = make();
  const first = await service.createPreviewScreenshot('s', input);
  for (let i = 0; i < 3; i += 1) await service.createPreviewScreenshot('s', input);
  const target = path.join(root, first.metadata.display_path);
  await fs.writeFile(target, 'user-modified');
  await assert.rejects(service.createPreviewScreenshot('s', input), /storage is full/);
  assert.equal(await fs.readFile(target, 'utf8'), 'user-modified');
  assert.equal((await index(root)).entries.length, 4);
});
test('unsafe directories and corrupt indexes fail saving closed', async () => {
  const { root, make } = setup();
  const outside = createTrackedTempDir('preview-outside-');
  await fs.symlink(outside, path.join(root, '.jenny'), 'junction');
  await assert.rejects(make().createPreviewScreenshot('s', input), /unsafe/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(root, '.jenny'));
  await make().createPreviewScreenshot('s', input);
  await fs.writeFile(path.join(root, '.jenny/artifacts/.preview-captures.json'), 'invalid');
  await assert.rejects(make().createPreviewScreenshot('s', input));
});

test('lost index cannot restart an accumulating cache', async () => {
  const { root, make } = setup();
  await make().createPreviewScreenshot('s', input);
  await fs.unlink(path.join(root, '.jenny/artifacts/.preview-captures.json'));
  await assert.rejects(make().createPreviewScreenshot('s', input), /index is missing/);
  assert.equal((await fs.readdir(path.join(root, '.jenny/artifacts/s'))).length, 1);
});

test('full storage preserves hardlinked captures and both links', async () => {
  const { root, make } = setup();
  const service = make();
  const first = await service.createPreviewScreenshot('s', input);
  const target = path.join(root, first.metadata.display_path);
  const preserved = path.join(root, 'preserved.png');
  await fs.link(target, preserved);
  for (let i = 0; i < 3; i += 1) await service.createPreviewScreenshot('s', input);
  await assert.rejects(service.createPreviewScreenshot('s', input), /storage is full/);
  assert.deepEqual(await fs.readFile(target), PNG);
  assert.deepEqual(await fs.readFile(preserved), PNG);
});

test('capacity never reads or unlinks a candidate that could change after validation', async () => {
  const { root, make } = setup();
  const first = await make().createPreviewScreenshot('s', input);
  for (let i = 0; i < 3; i += 1) await make().createPreviewScreenshot('s', input);
  const target = path.join(root, first.metadata.display_path);
  let captureReads = 0;
  let removals = 0;
  const service = make({ ...fs,
    readFile: async (file, ...args) => {
      const bytes = await fs.readFile(file, ...args);
      if (file === target) {
        captureReads += 1;
        // Reproduces the old digest-read / unlink race deterministically.
        await fs.writeFile(target, 'concurrent user edit');
      }
      return bytes;
    },
    unlink: async (file) => { removals += 1; return fs.unlink(file); },
  });
  await assert.rejects(service.createPreviewScreenshot('s', input), /storage is full/);
  assert.equal(captureReads, 0);
  assert.equal(removals, 0);
  assert.deepEqual(await fs.readFile(target), PNG);
});

test('concurrent replacement during index read survives capacity refusal', async () => {
  const { root, make } = setup();
  const first = await make().createPreviewScreenshot('s', input);
  for (let i = 0; i < 3; i += 1) await make().createPreviewScreenshot('s', input);
  const target = path.join(root, first.metadata.display_path);
  const service = make({ ...fs, readFile: async (file, ...args) => {
    const bytes = await fs.readFile(file, ...args);
    if (path.basename(file) === '.preview-captures.json') {
      await fs.unlink(target);
      await fs.writeFile(target, 'concurrent replacement');
    }
    return bytes;
  } });
  await assert.rejects(service.createPreviewScreenshot('s', input), /storage is full/);
  assert.equal(await fs.readFile(target, 'utf8'), 'concurrent replacement');
  assert.equal((await index(root)).entries.length, 4);
});

test('owner removal frees a slot without reusing the removed reference', async () => {
  const { root, make } = setup();
  const first = await make().createPreviewScreenshot('s', input);
  for (let i = 0; i < 3; i += 1) await make().createPreviewScreenshot('s', input);
  await fs.unlink(path.join(root, first.metadata.display_path));
  const latest = await make().createPreviewScreenshot('s', input);
  assert.notEqual(latest.metadata.display_path, first.metadata.display_path);
  assert.equal((await index(root)).entries.length, 4);
  await assert.rejects(fs.stat(path.join(root, first.metadata.display_path)), { code: 'ENOENT' });
});
