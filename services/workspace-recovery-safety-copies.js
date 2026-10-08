'use strict';

/* services/workspace-recovery-safety-copies.js - in-memory safety copies for
 * the Changes view's undo/redo (row 34 S5).
 *
 * A safety copy holds, per workspace-relative path, the exact bytes that were
 * on disk (or "missing") just before an operation, plus the state the path is
 * expected to be in AFTER that operation (`sha256:<hex>` of its bytes, or
 * "missing"). A later restore only writes a path whose current state still
 * equals that expected state, so a file the user changed in between is never
 * overwritten.
 *
 * Copies live in main-process memory for the app session only (owner
 * decision): nothing is written to disk, nothing is logged, and the renderer
 * only ever sees the opaque token, the relative paths and the unavailable
 * reasons. Tokens are single-use and bound to the workspace root they were
 * taken in; the oldest copy is evicted first once the copy count or the
 * store-wide byte cap is reached.
 * A file over the caps, or not a regular file, is recorded as unavailable
 * with a reason and is never partially captured.
 */

const crypto = require('crypto');

const MIB = 1024 * 1024;
const SAFETY_COPY_LIMITS = Object.freeze({
  maxFileBytes: 8 * MIB,
  maxCopyBytes: 64 * MIB,
  maxCopies: 16,
  // All live copies together: main-process memory stays bounded however
  // many undos the session makes.
  maxTotalBytes: 128 * MIB,
});
const MISSING_STATE = 'missing';
const STATE_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UNAVAILABLE_REASONS = new Set([
  'too_large', 'not_a_file', 'unreadable', 'path_invalid', 'path_outside_root',
]);

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

// The comparable state of a recovery capture: "missing", the sha256 of the
// bytes, or null when the path holds something that cannot be compared (a
// directory, a link, an unreadable or over-cap file).
function stateOfCapture(capture) {
  if (!capture || typeof capture !== 'object') return null;
  if (capture.kind === 'missing') return MISSING_STATE;
  if (capture.kind === 'file' && Buffer.isBuffer(capture.bytes)) return sha256Bytes(capture.bytes);
  return null;
}

function unavailableReasonFor(capture) {
  if (capture?.kind === 'file') return capture.reason === 'too_large' ? 'too_large' : 'unreadable';
  return 'not_a_file';
}

function normalizeReason(reason) {
  return UNAVAILABLE_REASONS.has(reason) ? reason : 'unreadable';
}

function sameBinding(left, right) {
  return Boolean(left && right)
    && String(left.rootId || '') === String(right.rootId || '')
    && String(left.workspaceId || '') === String(right.workspaceId || '');
}

class SafetyCopyDraft {
  constructor(binding, limits) {
    this.binding = { rootId: String(binding?.rootId || ''), workspaceId: String(binding?.workspaceId || '') };
    this._limits = limits;
    this._entries = new Map();
    this._totalBytes = 0;
  }

  get totalBytes() {
    return this._totalBytes;
  }

  markUnavailable(relPath, reason) {
    this._release(relPath);
    this._entries.set(relPath, { state: 'unavailable', reason: normalizeReason(reason) });
  }

  // Records one capture. Returns true when the path is restorable from this
  // copy; false when it was recorded as unavailable.
  record(relPath, capture) {
    this._release(relPath);
    if (capture?.kind === 'missing') {
      this._entries.set(relPath, { state: MISSING_STATE });
      return true;
    }
    if (capture?.kind !== 'file' || !Buffer.isBuffer(capture.bytes)) {
      this.markUnavailable(relPath, unavailableReasonFor(capture));
      return false;
    }
    const size = capture.bytes.length;
    if (size > this._limits.maxFileBytes || this._totalBytes + size > this._limits.maxCopyBytes) {
      this.markUnavailable(relPath, 'too_large');
      return false;
    }
    const bytes = Buffer.from(capture.bytes);
    this._entries.set(relPath, { state: 'bytes', bytes, hash: sha256Bytes(bytes) });
    this._totalBytes += size;
    return true;
  }

  _release(relPath) {
    const previous = this._entries.get(relPath);
    if (previous?.state === 'bytes') this._totalBytes -= previous.bytes.length;
    this._entries.delete(relPath);
  }

  entries() {
    return this._entries.entries();
  }
}

class WorkspaceRecoverySafetyCopyStore {
  constructor({ limits = {}, randomUUID = () => crypto.randomUUID() } = {}) {
    this._limits = { ...SAFETY_COPY_LIMITS, ...limits };
    this._randomUUID = randomUUID;
    this._copies = new Map();
    this._totalBytes = 0;
  }

  get totalBytes() {
    return this._totalBytes;
  }

  get limits() {
    return { ...this._limits };
  }

  get size() {
    return this._copies.size;
  }

  startCopy(binding) {
    return new SafetyCopyDraft(binding, this._limits);
  }

  // Seals a draft. `postStates` maps a path to the state it is expected to be
  // in after the guarded operation ("missing" / "sha256:<hex>"), or to
  // { unavailable: reason } when that state could not be determined. A path
  // without a usable post-state is reported unavailable, never restorable.
  commit(draft, postStates = new Map()) {
    const states = postStates instanceof Map ? postStates : new Map(Object.entries(postStates || {}));
    const entries = new Map();
    const paths = [];
    const unavailable = [];
    for (const [relPath, entry] of draft.entries()) {
      if (entry.state === 'unavailable') {
        unavailable.push({ path: relPath, reason: entry.reason });
        continue;
      }
      const post = states.get(relPath);
      if (post === MISSING_STATE || (typeof post === 'string' && STATE_PATTERN.test(post))) {
        entries.set(relPath, { ...entry, expected: post });
        paths.push(relPath);
      } else {
        unavailable.push({ path: relPath, reason: normalizeReason(post?.unavailable) });
      }
    }
    if (!paths.length) return { token: null, paths, unavailable };
    const token = String(this._randomUUID());
    this._copies.set(token, { binding: { ...draft.binding }, entries, paths: [...paths], bytes: draft.totalBytes });
    this._totalBytes += draft.totalBytes;
    while (this._copies.size > this._limits.maxCopies
      || (this._totalBytes > this._limits.maxTotalBytes && this._copies.size > 1)) {
      this._delete(this._copies.keys().next().value);
    }
    return { token, paths, unavailable };
  }

  // Returns { copy } for a live token bound to `binding`, otherwise
  // { error: 'safety_copy_expired' | 'root_changed' }. Does not consume.
  peek(token, binding) {
    const copy = this._copies.get(String(token || ''));
    if (!copy) return { error: 'safety_copy_expired' };
    if (!sameBinding(copy.binding, binding)) return { error: 'root_changed' };
    return { copy };
  }

  consume(token) {
    return this._delete(String(token || ''));
  }

  clear() {
    this._copies.clear();
    this._totalBytes = 0;
  }

  _delete(token) {
    const copy = this._copies.get(token);
    if (!copy) return false;
    this._totalBytes -= copy.bytes;
    return this._copies.delete(token);
  }
}

module.exports = {
  MISSING_STATE,
  SAFETY_COPY_LIMITS,
  WorkspaceRecoverySafetyCopyStore,
  sha256Bytes,
  stateOfCapture,
  unavailableReasonFor,
};
