'use strict';

// Download manifests of team project files (TEAM_PROJECTS_SPEC "Upload and download", slice 3-8b). A manifest
// lists every regular file of a project the listing takes (project-folder-io.js `listFiles`) with its SHA-256,
// is bound to the member, device and project that made it, and is read a page of 1,000 entries at a time.
//
// - At most one build at a time per member, and one new build per member a minute (`team_upload_limit`,
//   retryable); at most two manifests per member (the least recently used goes); ten minutes idle ends one.
// - `files_downloaded` ("listed for download") is appended at most once per member and project in ten minutes:
//   a manifest made inside that window appends nothing and is still served; a failed append refuses it.
// - Hashes are cached by device, inode, size and modification time (nanoseconds), at most 20,000 entries; a
//   file that changed while it was hashed is skipped and not cached.
// - A part is read only from a file whose device, inode, size and modification time still match its listing.

const crypto = require('node:crypto');

const { hostFailure } = require('../api-contract');
const { DOWNLOAD_CHANGED, ROOT_UNAVAILABLE } = require('./project-folder-io');
const { TRANSFER_LIMITS } = require('./transfer-manifest');

const MANIFEST_ID = /^manifest_[A-Za-z0-9_-]{22}$/u;
const HASH_CHUNK_BYTES = 1024 * 1024;
const HASH_CACHE_LIMIT = 20_000;
const BUILD_EVERY_MS = 60 * 1000;
const AUDIT_EVERY_MS = 10 * 60 * 1000;

const changed = () => hostFailure('conflict', DOWNLOAD_CHANGED);
const notFound = () => hostFailure('forbidden', 'team_not_found');

/**
 * folders: project-folders.js. limits: { manifestsPerMember, manifestIdleMs, pageSize }. appended(entry): true
 * when the shared audit took the entry. stillAllowed(deviceId, projectId): null or the refusal, asked after the
 * hashing wait.
 */
function createProjectManifests({ folders, limits, appended, stillAllowed, clock, randomBytes, log }) {
  const manifests = new Map();
  const building = new Set();
  const lastBuild = new Map();
  const lastAudit = new Map();
  const hashes = new Map();

  const cacheKey = (entry) => `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeNs}`;
  const bound = (record, memberId, deviceId, projectId) => record.memberId === memberId
    && record.deviceId === deviceId && record.projectId === projectId;

  function remember(key, sha256) {
    hashes.delete(key);
    hashes.set(key, sha256);
    while (hashes.size > HASH_CACHE_LIMIT) hashes.delete(hashes.keys().next().value);
  }

  async function hashListed(projectId, entry) {
    const key = cacheKey(entry);
    const cached = hashes.get(key);
    if (cached !== undefined) {
      remember(key, cached);
      return cached;
    }
    const opened = await folders.openListed(projectId, entry.path, entry);
    if (!opened.ok) return null;
    try {
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(HASH_CHUNK_BYTES, entry.size)));
      let total = 0;
      while (total < entry.size) {
        const { bytesRead } = await opened.handle.read(buffer, 0, Math.min(buffer.length, entry.size - total), total);
        if (bytesRead <= 0) return null;
        hash.update(buffer.subarray(0, bytesRead));
        total += bytesRead;
      }
      const after = await opened.handle.stat({ bigint: true });
      if (after.size !== BigInt(entry.size) || after.mtimeNs !== entry.mtimeNs) return null;
      const sha256 = hash.digest('hex');
      remember(key, sha256);
      return sha256;
    } catch {
      return null;
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }

  function page(manifest, cursor) {
    const start = cursor ?? 0;
    if (!Number.isSafeInteger(start) || start < 0 || start > manifest.files.length) {
      return hostFailure('invalid', 'team_cursor_invalid');
    }
    const entries = manifest.files.slice(start, start + limits.pageSize)
      .map((entry, offset) => ({ index: start + offset, path: entry.path, size: entry.size, sha256: entry.sha256 }));
    const next = start + entries.length < manifest.files.length ? start + entries.length : null;
    return { ok: true, manifest_id: manifest.id, part_size: TRANSFER_LIMITS.maxPartBytes, total_files: manifest.files.length,
      total_bytes: manifest.totalBytes, skipped: manifest.skipped, capped: manifest.capped, entries, next_cursor: next };
  }

  function sweep(now = clock()) {
    for (const [id, manifest] of manifests) if (now - manifest.touched >= limits.manifestIdleMs) manifests.delete(id);
    for (const [key, at] of lastBuild) if (now - at >= BUILD_EVERY_MS) lastBuild.delete(key);
    for (const [key, at] of lastAudit) if (now - at >= AUDIT_EVERY_MS) lastAudit.delete(key);
  }

  /** The caller's live manifest, or null for a forged, foreign or idle one. */
  function manifestFor(manifestId, memberId, deviceId, projectId) {
    sweep();
    const manifest = typeof manifestId === 'string' && MANIFEST_ID.test(manifestId) ? manifests.get(manifestId) : undefined;
    if (!manifest || !bound(manifest, memberId, deviceId, projectId)) return null;
    manifest.touched = clock();
    return manifest;
  }

  // True when this member and project need a `files_downloaded` entry now (none in the last ten minutes).
  function auditDue(memberId, projectId) {
    const at = lastAudit.get(`${memberId}\u0000${projectId}`);
    return at === undefined || clock() - at >= AUDIT_EVERY_MS;
  }

  async function buildFor(projectId, memberId, deviceId) {
    const listed = await folders.listFiles(projectId);
    if (!listed.ok) return hostFailure('unavailable', listed.reason);
    const files = [];
    let skipped = listed.skipped;
    for (const entry of listed.files) {
      const sha256 = await hashListed(projectId, entry);
      if (sha256 === null) skipped += 1;
      else files.push(Object.freeze({ ...entry, sha256 }));
    }
    // Hashing awaited: the reader is checked again before the entry and the manifest exist.
    const refused = stillAllowed(deviceId, projectId);
    if (refused) return refused;
    const totalBytes = files.reduce((total, entry) => total + entry.size, 0);
    if (auditDue(memberId, projectId)) {
      if (!appended({ kind: 'files_downloaded', project_id: projectId, actor_member_id: memberId,
        detail: { files: files.length, bytes: totalBytes, skipped } })) return hostFailure('unavailable', 'team_audit_unavailable');
      lastAudit.set(`${memberId}\u0000${projectId}`, clock());
    }
    const bytes = randomBytes(16);
    const id = Buffer.isBuffer(bytes) && bytes.length === 16 ? `manifest_${bytes.toString('base64url')}` : '';
    if (!MANIFEST_ID.test(id) || manifests.has(id)) return hostFailure('unavailable', 'host_unavailable');
    const mine = [...manifests.values()].filter((manifest) => manifest.memberId === memberId)
      .sort((left, right) => left.touched - right.touched);
    while (mine.length >= limits.manifestsPerMember) manifests.delete(mine.shift().id);
    const manifest = { id, memberId, deviceId, projectId, files, totalBytes, skipped, capped: listed.capped, touched: clock() };
    manifests.set(id, manifest);
    log('INFO', 'team.project_files.manifest_made', { project_id: projectId, manifest_id: id, files: files.length,
      bytes: totalBytes, skipped });
    return page(manifest, 0);
  }

  /** A new manifest's first page, or a refusal (the build rules above). */
  async function build(projectId, memberId, deviceId) {
    sweep();
    if (building.has(memberId) || lastBuild.has(memberId)) return hostFailure('limit', 'team_upload_limit', '', true);
    building.add(memberId);
    lastBuild.set(memberId, clock());
    try {
      return await buildFor(projectId, memberId, deviceId);
    } finally {
      building.delete(memberId);
    }
  }

  // The bytes of part `n` of a listed file.
  async function readPart(manifest, index, n) {
    const entry = Number.isSafeInteger(index) ? manifest.files[index] : undefined;
    const partSize = TRANSFER_LIMITS.maxPartBytes;
    if (!entry || !Number.isSafeInteger(n) || n < 0 || (n > 0 && n * partSize >= entry.size)) return notFound();
    const start = n * partSize;
    const length = Math.min(partSize, entry.size - start);
    const opened = await folders.openListed(manifest.projectId, entry.path, entry);
    if (!opened.ok) return opened.reason === ROOT_UNAVAILABLE ? hostFailure('unavailable', opened.reason) : changed();
    try {
      const bytes = Buffer.allocUnsafe(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await opened.handle.read(bytes, done, length - done, start + done);
        if (bytesRead <= 0) return changed();
        done += bytesRead;
      }
      return { ok: true, bytes };
    } catch {
      return changed();
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }

  /** Drops every manifest `keep(manifest)` answers false for; the count dropped. */
  function retain(keep) {
    let dropped = 0;
    for (const manifest of [...manifests.values()]) {
      if (keep(manifest)) continue;
      manifests.delete(manifest.id);
      dropped += 1;
    }
    return dropped;
  }

  return Object.freeze({ build, page, manifestFor, readPart, retain, sweep, size: () => manifests.size });
}

module.exports = { AUDIT_EVERY_MS, BUILD_EVERY_MS, HASH_CACHE_LIMIT, createProjectManifests };
