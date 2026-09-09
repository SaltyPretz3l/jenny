'use strict';

// Durable bounded ownership index. Never automatically delete workspace files:
// a hash check followed by unlink cannot preserve concurrent user edits.
const path = require('node:path');
const crypto = require('node:crypto');
const { MAX_PREVIEW_IMAGE_BYTES } = require('./preview-vision-image');
const { normalizeGeneratedArtifactMetadata } = require('./artifact-metadata-utils');
const workspaceLocks = new Map();
const MAX_WORKSPACE_CAPTURES = 32;
const MAX_SESSION_CAPTURES = 4;
const INDEX_NAME = '.preview-captures.json';
const MARKER_NAME = '.preview-captures.initialized';
const FILE_PATTERN = /^preview-capture-[a-f0-9-]{36}\.png$/;
const SESSION_PATTERN = /^[A-Za-z0-9._-]+$/;
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function directory(fs, parent, name) {
  const target = path.join(parent, name);
  await fs.mkdir(target).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(target) !== target) {
    throw new Error('Preview cache directory is unsafe.');
  }
  return target;
}

async function readIndex(fs, root) {
  const target = path.join(root, INDEX_NAME);
  const stat = await fs.lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) {
    const initialized = await fs.lstat(path.join(root, MARKER_NAME)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (initialized) throw new Error('Preview cache index is missing; automatic saving stopped.');
    return [];
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) {
    throw new Error('Preview cache index is unsafe.');
  }
  const index = JSON.parse(await fs.readFile(target, 'utf8'));
  if (index.version !== 1 || !Array.isArray(index.entries)
      || index.entries.length > MAX_WORKSPACE_CAPTURES
      || !index.entries.every((entry) => entry && typeof entry.session === 'string'
        && typeof entry.file === 'string' && SESSION_PATTERN.test(entry.session)
        && entry.session !== '.' && entry.session !== '..' && FILE_PATTERN.test(entry.file)
        && /^[a-f0-9]{64}$/.test(entry.sha256))) {
    throw new Error('Preview cache index is invalid.');
  }
  return index.entries;
}

async function retainedEntries(fs, root, entries) {
  const retained = [];
  for (const entry of entries) {
    // Reclaim only index slots for files already removed by the owner. A file
    // recreated afterward belongs to that writer; we never touch that path.
    const exists = await fs.lstat(path.join(root, entry.session, entry.file)).then(
      () => true,
      (error) => { if (error.code === 'ENOENT') return false; throw error; },
    );
    if (exists) retained.push(entry);
  }
  return retained;
}

// Caller serializes this operation for the entire workspace, including restarts
// through the application's exclusive profile owner. Index publication precedes
// image creation, so interrupted writes cannot leave untracked image accumulation.
async function savePreviewScreenshot({ fs, workspace, session, content, writeIndex }) {
  if (!SESSION_PATTERN.test(session) || session === '.' || session === '..'
      || !Buffer.isBuffer(content) || !content.length || content.length > MAX_PREVIEW_IMAGE_BYTES) {
    throw new Error('Preview screenshot exceeds the cache contract.');
  }
  const realWorkspace = await fs.realpath(workspace);
  const state = await directory(fs, realWorkspace, '.jenny');
  const root = await directory(fs, state, 'artifacts');
  const entries = await retainedEntries(fs, root, await readIndex(fs, root));
  if (entries.length >= MAX_WORKSPACE_CAPTURES
      || entries.filter((entry) => entry.session === session).length >= MAX_SESSION_CAPTURES) {
    throw new Error('Preview screenshot storage is full (4 per session, 32 per workspace). '
      + 'Remove unwanted saved screenshots to free space; model image delivery can continue.');
  }
  const parent = await directory(fs, root, session);
  const file = `preview-capture-${crypto.randomUUID()}.png`;
  const target = path.join(parent, file);
  entries.push({ session, file, sha256: digest(content) });
  await fs.writeFile(path.join(root, MARKER_NAME), '1', { flag: 'wx' }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await writeIndex(path.join(root, INDEX_NAME), JSON.stringify({ version: 1, entries }));
  await fs.writeFile(target, content, { flag: 'wx' });
  return { file, absolutePath: target, displayPath: path.relative(realWorkspace, target).replace(/\\/g, '/') };
}

async function createPreviewScreenshot(service, session, input, buildArtifactId) {
  const workspace = await service._fs.realpath(await service.requireWorkspaceRoot());
  const previous = workspaceLocks.get(workspace) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const saved = await savePreviewScreenshot({
      fs: service._fs, workspace, session, content: input.content,
      writeIndex: (target, text) => service._writeFileAtomic(target, text),
    });
    return { metadata: normalizeGeneratedArtifactMetadata({
      artifact_id: buildArtifactId(session, saved.file),
      artifact_kind: 'image', title: 'Preview screenshot (temporary)',
      file_name: saved.file, display_path: saved.displayPath, absolute_path: saved.absolutePath,
      mime_type: 'image/png', width: input.width, height: input.height,
      editable: false, status: 'available',
    }) };
  });
  workspaceLocks.set(workspace, next);
  try { return await next; } finally {
    if (workspaceLocks.get(workspace) === next) workspaceLocks.delete(workspace);
  }
}

module.exports = { createPreviewScreenshot, MAX_WORKSPACE_CAPTURES, MAX_SESSION_CAPTURES };
