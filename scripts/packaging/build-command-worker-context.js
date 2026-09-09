'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const FILES = Object.freeze(['Dockerfile.worker', 'config/command-worker-image.json',
  ...['__init__','supervisor','job','snapshot','security','protocol','health','relay'].map((name) => 'server/worker/' + name + '.py')]);
async function buildWorkerContext({ sourceRoot, outputDirectory }) {
  const hash = createHash('sha256');
  const contents = [];
  for (const relative of FILES) {
    const source = path.resolve(sourceRoot, relative);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new Error('worker_context_source_invalid');
    if (path.resolve(await fs.realpath(source)) !== source) throw new Error('worker_context_source_invalid');
    const bytes = await fs.readFile(source);
    hash.update(relative).update('\0').update(bytes).update('\0');
    contents.push([relative, bytes]);
  }
  const manifest = JSON.parse(contents[1][1].toString('utf8'));
  if (manifest.schema_version !== 1 || manifest.platform !== 'linux/amd64'
    || !/@sha256:[a-f0-9]{64}$/u.test(manifest.base_image)
    || !contents[0][1].toString('utf8').split(/\r?\n/u).includes('FROM --platform=linux/amd64 ' + manifest.base_image)
    || JSON.stringify(manifest.source_files) !== JSON.stringify(FILES)) throw new Error('worker_image_manifest_invalid');
  const digest = hash.digest('hex');
  const directory = path.resolve(outputDirectory + '-' + digest);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const rootInfo = await fs.lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || path.resolve(await fs.realpath(directory)) !== directory) throw new Error('worker_context_target_invalid');
  for (const [relative, bytes] of contents) {
    const destination = path.join(directory, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (path.resolve(await fs.realpath(path.dirname(destination))) !== path.dirname(destination)) throw new Error('worker_context_target_invalid');
    try { await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await fs.lstat(destination);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || !(await fs.readFile(destination)).equals(bytes)) throw new Error('worker_context_target_changed', { cause: error });
    }
  }
  return { directory, digest };
}
module.exports = { buildWorkerContext, FILES };
