'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildWorkerContext, FILES } = require('../scripts/packaging/build-command-worker-context');
test('packaged worker context is closed, reproducible and rejects tampering', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-worker-context-test-'));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 const sourceRoot = path.join(root, 'resources', 'command-worker');
 for (const relative of FILES) {
  const target = path.join(sourceRoot, relative); await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(__dirname, '..', relative), target);
 }
 const outputDirectory = path.join(root, 'staging');
 const first = await buildWorkerContext({ sourceRoot, outputDirectory });
 assert.deepEqual(await buildWorkerContext({ sourceRoot, outputDirectory }), first);
 assert.equal(FILES.some(file => /auth|browser|credential|host-/.test(file)), false);
 const relay = path.join(first.directory, 'server/worker/relay.py');
 await fs.writeFile(relay, 'tampered');
 await assert.rejects(buildWorkerContext({ sourceRoot, outputDirectory }), /target_changed/);
 const manifest = path.join(sourceRoot, 'config/command-worker-image.json');
 const invalid = JSON.parse(await fs.readFile(manifest, 'utf8')); invalid.base_image = 'node:latest';
 await fs.writeFile(manifest, JSON.stringify(invalid));
 await assert.rejects(buildWorkerContext({ sourceRoot, outputDirectory }), /manifest_invalid/);
});
