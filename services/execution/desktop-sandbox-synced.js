'use strict';
// Row 106: the synced-workspace pieces of DesktopSandboxService. The mirror index is valid on disk
// only while no run is in flight: it is removed at admission and rewritten after write-back, so a
// crash anywhere in between makes the next run a full resync and never trusts a half-known mirror.
// Outboxes are per-run host staging directories; any left at startup belonged to a crashed run and
// are discarded without touching the folder.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { stageMirrorSync, verifyMirrorSync, commitMirrorIndex, invalidateMirrorIndex, assertRealDirectory,
  mirrorIdFor, writeAtomically } = require('./sandbox-mirror-sync');
const { applyWriteBack } = require('./sandbox-write-back');
const { removeTree, removeFile } = require('../fs-remove-no-follow');
const { sandboxError, digest } = require('./sandbox-errors');

const RETENTION = Object.freeze({ count: 4, maxAgeMs: 30 * 24 * 60 * 60 * 1000 });
const RUN_DIRECTORY = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MIRROR_ID = /^[a-f0-9]{16}$/u;
const MAX_OUTBOXES = 32;
const MAX_GRANTS = 64;
const GRANT = /^[a-f0-9]{64}$/u;

class SyncedWorkspace {
  constructor({ directory, now = Date.now }) {
    this.mirrors = path.join(directory, 'mirrors');
    this.outboxRoot = path.join(directory, 'outbox');
    this.registryFile = path.join(this.mirrors, 'registry.json');
    this.grantsFile = path.join(directory, 'synced-grants.json');
    this.now = now;
  }
  indexFile(mirrorId) {
    if (!MIRROR_ID.test(mirrorId)) throw sandboxError('sandbox_mirror_identity_invalid');
    return path.join(this.mirrors, mirrorId + '.json');
  }
  async mirrorIdForRoot(root) {
    const resolved = path.resolve(root);
    const info = await assertRealDirectory(resolved);
    return mirrorIdFor(digest([resolved, info.dev, info.ino]));
  }
  // A mirror volume Docker had to create holds nothing the index describes.
  async prepareMirror(launcher, root) {
    const mirrorId = await this.mirrorIdForRoot(root);
    const volume = await launcher.ensureMirrorVolume(mirrorId);
    if (volume.created) await invalidateMirrorIndex(this.indexFile(mirrorId));
    return { mirrorId, volume: volume.name };
  }
  stage(options) {
    return stageMirrorSync({ ...options, indexDirectory: this.mirrors });
  }
  verify(stage) {
    return verifyMirrorSync(stage);
  }
  async openOutbox() {
    await fs.mkdir(this.outboxRoot, { recursive: true, mode: 0o700 });
    await assertRealDirectory(this.outboxRoot);
    const id = randomUUID();
    const directory = path.join(this.outboxRoot, id);
    await fs.mkdir(directory, { mode: 0o700 });
    return { id, directory };
  }
  async removeOutbox(outbox) {
    if (!outbox) return;
    const resolved = path.resolve(outbox.directory);
    if (path.dirname(resolved) !== path.resolve(this.outboxRoot) || !RUN_DIRECTORY.test(path.basename(resolved))) {
      throw sandboxError('sandbox_outbox_path_invalid');
    }
    await removeTree(resolved);
  }
  async markInFlight(stage) {
    await invalidateMirrorIndex(stage.indexFile);
    const registry = await this._registry();
    registry[stage.mirrorId] = new Date(this.now()).toISOString();
    await writeAtomically(this.registryFile, JSON.stringify({ schema_version: 1, mirrors: registry }));
  }
  // The folder must still be the root the run staged; otherwise nothing is written back.
  async writeBack({ stage, outbox, jobId, signal = null }) {
    let result;
    try {
      const current = await assertRealDirectory(stage.root);
      if (digest([stage.root, current.dev, current.ino]) !== stage.rootIdentity) throw sandboxError('write_back_root_changed');
      result = await applyWriteBack({ root: stage.root, outbox: outbox.directory, jobId, stage, signal });
    } catch (error) {
      await invalidateMirrorIndex(stage.indexFile).catch(() => {});
      return { status: 'failed', reason: /^[a-z_]{1,80}$/u.test(error?.reason || '') ? error.reason : 'write_back_failed',
        applied: [], refused: [] };
    }
    try { await commitMirrorIndex(stage.indexFile, stage, result); }
    catch { await invalidateMirrorIndex(stage.indexFile).catch(() => {}); }
    return result;
  }
  async _registry() {
    try {
      const raw = JSON.parse(await fs.readFile(this.registryFile, 'utf8'));
      if (raw?.schema_version !== 1 || !raw.mirrors || typeof raw.mirrors !== 'object') return {};
      return Object.fromEntries(Object.entries(raw.mirrors).filter(([id, at]) => MIRROR_ID.test(id) && !Number.isNaN(Date.parse(at))));
    } catch { return {}; }
  }
  async hasLeftovers() {
    const entries = await fs.readdir(this.outboxRoot).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    return entries.length > 0;
  }
  // Never touches the folder: discards crashed runs' outboxes and applies mirror retention.
  async reconcile(launcher, { keepMirrors }) {
    const entries = await fs.readdir(this.outboxRoot, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (entries.length > MAX_OUTBOXES) throw sandboxError('sandbox_outbox_recovery_limit');
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !RUN_DIRECTORY.test(entry.name)) throw sandboxError('sandbox_outbox_path_invalid');
      await this.removeOutbox({ directory: path.join(this.outboxRoot, entry.name) });
    }
    const registry = await this._registry();
    const cutoff = this.now() - RETENTION.maxAgeMs;
    const keep = new Set(keepMirrors ? Object.entries(registry).filter(([, at]) => Date.parse(at) >= cutoff)
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, RETENTION.count).map(([id]) => id) : []);
    for (const mirrorId of await launcher.listMirrorVolumes()) {
      if (keep.has(mirrorId)) continue;
      await launcher.removeMirrorVolume(mirrorId);
      await removeFile(this.indexFile(mirrorId));
    }
    for (const mirrorId of Object.keys(registry)) {
      if (!keep.has(mirrorId)) await removeFile(this.indexFile(mirrorId));
    }
    const retained = Object.fromEntries(Object.entries(registry).filter(([id]) => keep.has(id)));
    if (Object.keys(retained).length !== Object.keys(registry).length) {
      await writeAtomically(this.registryFile, JSON.stringify({ schema_version: 1, mirrors: retained }));
    }
  }
  // Row 106: an auto policy or chat auto-run applies to synced runs only once the user approved it
  // in synced mode (owner plan §8); a stamp is the digest of that grant, bounded and newest last.
  async _grants() {
    try {
      const raw = JSON.parse(await fs.readFile(this.grantsFile, 'utf8'));
      return raw?.schema_version === 1 && Array.isArray(raw.grants) ? raw.grants.filter((value) => GRANT.test(value)) : [];
    } catch { return []; }
  }
  async hasGrant(key) {
    return GRANT.test(key) && (await this._grants()).includes(key);
  }
  async stampGrant(key) {
    if (!GRANT.test(key)) return;
    const grants = (await this._grants()).filter((value) => value !== key).concat(key).slice(-MAX_GRANTS);
    await writeAtomically(this.grantsFile, JSON.stringify({ schema_version: 1, grants }));
  }
  scratchMirrorId() {
    return randomBytes(8).toString('hex');
  }
}

module.exports = { SyncedWorkspace, RETENTION };
