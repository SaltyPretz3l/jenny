'use strict';

// The team model receiver on a member's PC (row 123 slice 6-4,
// TEAM_MODEL_SHARING_SPEC "The receiver" and "6-4 as built", MI3 to MI9,
// owner decisions E54 to E57 and E64). It accepts one offer at a time, pulls
// parts into `<root>/.jenny-incoming/<transfer id>/` through an injected
// transport, checks every segment's SHA-256 as it completes, then each whole
// file (the model hasher's worker), its size and its GGUF header, and only then
// places the set (model-receive-place.js: nothing is listed until it is whole).
// A cut at any step resumes from the journal (model-receive-journal.js): each
// staging file is truncated back to its last verified segment, so an unsynced
// tail is never trusted.
//
// Nothing here dials, loads a model or selects one. `transport` is the set of
// calls slice 6-5 provides; `roots()` is the member's model roots, the list
// discovery scans. Events, refusals and logs carry ids, states, closed
// reasons, counts and sizes: never a path, a file name, a hash, licence text or
// a URL. Test seams, not production options: `limits`, `validateManifest`
// (the tests shrink the segment size, which 6-1's validator pins at 1 GiB),
// `stepHook` (cuts at named steps), `transferIo` and `renameFolder`.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { removeFileSync, removeTree } = require('../fs-remove-no-follow');
const { readGgufHeader } = require('../gguf-header');
const { writeJson } = require('../host/durable-json');
const { MODEL_TRANSFER_LIMITS, validateModelManifest } = require('../../server/team/model-manifest');
const { createTransferIo } = require('../../server/team/transfer-io');
const { renameNoReplace } = require('../../server/team/file-checks');
const checks = require('./model-receive-checks');
const journals = require('./model-receive-journal');
const { createAcceptor } = require('./model-receive-accept');
const { createPlacer } = require('./model-receive-place');
const { createSweeper } = require('./model-receive-sweep');

const MODEL_RECEIVE_REASONS = Object.freeze([
  'model_manifest_invalid', 'model_destination_invalid', 'model_exists', 'model_no_space', 'model_hash_mismatch',
  'model_not_gguf', 'model_staging_failed', 'model_journal_invalid', 'model_transfer_interrupted',
  'model_receiver_busy', 'model_receiver_disposed',
]);
// A failure that ends the transfer and removes its staging folder; the rest pause it with staging kept.
const TERMINAL = new Set(['model_manifest_invalid', 'model_destination_invalid', 'model_exists', 'model_hash_mismatch',
  'model_not_gguf', 'model_journal_invalid']);
const RUNNING = new Set(['pulling', 'verifying']);
const CODE_WORD = /^[a-z][a-z0-9_]{0,79}$/u;

const DEFAULT_LIMITS = Object.freeze({
  partBytes: MODEL_TRANSFER_LIMITS.partBytes,
  segmentBytes: MODEL_TRANSFER_LIMITS.segmentBytes,
  segmentRetries: MODEL_TRANSFER_LIMITS.segmentRetries,
  freeSpaceMarginBytes: MODEL_TRANSFER_LIMITS.freeSpaceMarginBytes,
  stagingIdleMs: MODEL_TRANSFER_LIMITS.stagingIdleMs,
  // Staging kept for a journal that is newer or cannot be read is swept this long after its last change (E74).
  stagingKeptMs: 30 * 24 * 60 * 60 * 1000,
  stagingFolders: MODEL_TRANSFER_LIMITS.journalEntries,
  provenanceFileBytes: MODEL_TRANSFER_LIMITS.provenanceFileBytes,
  // The manifest (at most 64 KiB) plus the journal's own fields.
  journalBytes: 80 * 1024,
  // A best-effort transport call (pause, cancel, complete) is waited for this long, then the run ends anyway.
  quietCallMs: 10 * 1000,
  // Progress events while pulling, at most this often.
  progressIntervalMs: 500,
});

const reasonError = (reason, extra = {}) => Object.assign(new Error(reason), { reason, ...extra });
// A code from the transport or the host is logged only when it is a closed reason word.
const safeCode = (error) => (typeof error?.code === 'string' && CODE_WORD.test(error.code) ? error.code : 'other');

// Rejects as soon as `signal` aborts, whatever the transport does with it.
function withAbort(work, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(reasonError('aborted'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(work).then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

function createModelReceiver({
  roots, transport, hasher, fs: fsImpl = fs, clock = Date.now, logger = null, limits: limitOverrides = {},
  onEvent = () => {}, validateManifest = validateModelManifest, stepHook = null, transferIo = null,
  renameFolder = renameNoReplace,
} = {}) {
  if (typeof roots !== 'function') throw new TypeError('roots must be a function.');
  if (!transport || typeof hasher?.hash !== 'function') throw new TypeError('transport and hasher are required.');
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...limitOverrides });
  if (limits.segmentBytes % limits.partBytes !== 0) throw new TypeError('segmentBytes must be a multiple of partBytes.');
  let handles = 0;
  const io = transferIo || createTransferIo({ onHandle: (delta) => { handles += delta; } });
  const log = (level, event, fields = {}) => {
    try {
      if (typeof logger === 'function') logger(level, event, fields);
    } catch (_error) { /* a logger never breaks a transfer */ }
  };
  const placer = createPlacer({ fsImpl, log, renameFolder });
  const step = async (name, detail) => {
    if (typeof stepHook === 'function') await stepHook(name, detail);
  };
  let active = null;
  let disposed = false;

  const stagingPath = (t, index) => path.join(t.stagingDir, journals.stagingFileName(index));
  const totalBytes = (t) => t.offer.manifest.files.reduce((sum, file) => sum + file.size, 0);
  const verifiedBytes = (t) => t.offer.manifest.files.reduce(
    (sum, file, index) => sum + journals.verifiedOffset(file, t.journal.files[index], limits.segmentBytes), 0,
  );
  const snapshot = (t) => (t && !t.claim ? {
    transferId: t.id, state: t.state, reason: t.reason, doneBytes: t.doneBytes, totalBytes: totalBytes(t),
  } : { transferId: null, state: disposed ? 'disposed' : 'idle', reason: null, doneBytes: 0, totalBytes: 0 });
  const emit = (t) => {
    t.lastProgress = clock();
    try {
      onEvent({ type: 'team.model.receive', ...snapshot(t) });
    } catch (_error) { /* a listener never breaks a transfer */ }
  };
  const setState = (t, state, reason = null) => {
    t.state = state;
    t.reason = reason;
    emit(t);
  };
  const saveTo = (stagingDir, journal) => {
    journal.updated_at = clock();
    journals.writeJournal(stagingDir, journal, { maxBytes: limits.journalBytes });
  };
  const save = (t) => saveTo(t.stagingDir, t.journal);
  // A call that moves the transfer on: aborts with the run; a failure pauses as model_transfer_interrupted.
  const call = async (t, name, payload) => {
    const { signal } = t.controller;
    try {
      return await withAbort(() => transport[name]({ ...payload, signal }), signal);
    } catch (error) {
      if (signal.aborted) throw reasonError('aborted');
      log('WARN', 'team.model.receive_transport_failed', { call: name, code: safeCode(error) });
      throw reasonError('model_transfer_interrupted');
    }
  };
  // A best-effort call (pause, cancel, complete): waited for at most quietCallMs, failures logged and ignored.
  const quietCall = async (name, payload) => {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => transport[name](payload)),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'quiet_call_timeout' })), limits.quietCallMs);
        }),
      ]);
    } catch (error) {
      log('WARN', 'team.model.receive_transport_failed', { call: name, code: safeCode(error) });
    } finally {
      clearTimeout(timer);
    }
  };
  const removeStaging = async (t) => {
    try {
      await removeTree(t.stagingDir);
    } catch (error) {
      log('WARN', 'team.model.receive_staging_kept', { transferId: t.id, code: error?.code || 'unknown' });
    }
  };
  const checkAborted = (t) => {
    if (t.controller.signal.aborted) throw reasonError('aborted');
  };
  const remainingBytes = (t) => totalBytes(t) - verifiedBytes(t);
  // A volume that cannot report its free space is allowed (the write itself then answers ENOSPC).
  const spaceHolds = (t) => {
    const free = checks.freeBytesOf(t.root, fsImpl);
    return free === null || free >= remainingBytes(t) + limits.freeSpaceMarginBytes;
  };
  const acceptor = createAcceptor({ roots, fsImpl, clock, limits, validateManifest, spaceHolds, save });
  const sweeper = createSweeper({
    roots, fsImpl, clock, limits, validateManifest, placer, log, saveTo, activeStagingDir: () => active?.stagingDir,
  });
  const writeProvenance = (t, file, folder) => writeJson(file,
    checks.provenanceDoc({ offer: t.offer, receivedAt: new Date(clock()).toISOString(), folder }));
  const placeCtx = (t) => ({ manifest: t.offer.manifest, main: t.main, stagingDir: t.stagingDir, root: t.root,
    restamp: (file, folder) => writeProvenance(t, file, folder) });

  // Length 0 removes the file (the first part creates it exclusively); any other length truncates through a no-follow open.
  async function truncateTo(file, length) {
    if (length === 0) {
      if (checks.present(file, fsImpl)) removeFileSync(file);
      return;
    }
    await io.withHandle(file, fs.constants.O_RDWR, (handle) => handle.truncate(length));
  }

  // Every staging file back to its last verified segment (none at all when nothing is verified); a file shorter than that breaks the journal.
  async function trimToVerified(t) {
    const files = t.offer.manifest.files;
    for (let index = 0; index < files.length; index += 1) {
      const offset = journals.verifiedOffset(files[index], t.journal.files[index], limits.segmentBytes);
      const file = stagingPath(t, index);
      if (!checks.present(file, fsImpl)) {
        if (offset > 0) throw reasonError('model_journal_invalid');
        continue;
      }
      const stat = checks.regularFile(file, { fsImpl });
      if (!stat || stat.size < BigInt(offset)) throw reasonError('model_journal_invalid');
      if (offset === 0 || stat.size > BigInt(offset)) await truncateTo(file, offset);
    }
  }

  const startPoints = (t) => t.offer.manifest.files.map((file, index) => ({
    file: index, offset: journals.verifiedOffset(file, t.journal.files[index], limits.segmentBytes),
  }));

  // One segment: `true` when its bytes match the manifest's digest, `false` on a wrong digest or a wrong-size part.
  async function pullSegment(t, index, segment) {
    const file = t.offer.manifest.files[index];
    const start = segment * limits.segmentBytes;
    const end = Math.min(file.size, start + limits.segmentBytes);
    const target = stagingPath(t, index);
    const digest = crypto.createHash('sha256');
    const base = verifiedBytes(t);
    for (let offset = start; offset < end;) {
      checkAborted(t);
      const bytes = await call(t, 'takePart', { offerId: t.offer.offerId, file: index, offset });
      checkAborted(t);
      if (!(bytes instanceof Uint8Array) || bytes.length !== Math.min(limits.partBytes, end - offset)) return false;
      await io.writeAt(target, offset, bytes);
      digest.update(bytes);
      offset += bytes.length;
      t.doneBytes = base + (offset - start);
      if (clock() - t.lastProgress >= limits.progressIntervalMs) emit(t);
      await step('part', { file: index, offset });
    }
    await io.withHandle(target, fs.constants.O_WRONLY, (handle) => handle.sync());
    return digest.digest('hex') === file.segments[segment];
  }

  async function pullFile(t, index) {
    const file = t.offer.manifest.files[index];
    const entry = t.journal.files[index];
    const total = journals.segmentsOf(file.size, limits.segmentBytes);
    while (entry.verified_segments < total) {
      if (!spaceHolds(t)) throw reasonError('model_no_space');
      const segment = entry.verified_segments;
      for (let attempt = 0; ; attempt += 1) {
        if (await pullSegment(t, index, segment)) break;
        log('WARN', 'team.model.receive_segment_mismatch', { transferId: t.id, file: index, segment, attempt });
        if (attempt >= limits.segmentRetries) throw reasonError('model_hash_mismatch');
        await truncateTo(stagingPath(t, index), segment * limits.segmentBytes);
      }
      entry.verified_segments = segment + 1;
      save(t);
      t.doneBytes = verifiedBytes(t);
      emit(t);
      await step('segment', { file: index, segment });
    }
  }

  async function verifyWhole(t, index) {
    const file = t.offer.manifest.files[index];
    const target = stagingPath(t, index);
    let result;
    try {
      result = await hasher.hash(target, { signal: t.controller.signal });
    } catch (error) {
      checkAborted(t);
      log('WARN', 'team.model.receive_hash_failed', { transferId: t.id, code: error?.code || 'none' });
      throw reasonError('model_staging_failed');
    }
    checkAborted(t);
    if (result?.size !== file.size || result?.sha256 !== file.sha256) throw reasonError('model_hash_mismatch');
    try {
      readGgufHeader(target);
    } catch (_error) {
      throw reasonError('model_not_gguf');
    }
    t.journal.files[index].whole = true;
    save(t);
    await step('verified', { file: index });
  }

  async function place(t) {
    setState(t, 'placing');
    if (t.journal.phase === 'pulling') {
      writeProvenance(t, path.join(t.stagingDir, journals.PROVENANCE_STAGED), t.journal.folder);
      t.journal.phase = 'placing';
      save(t);
    }
    await step('placing', {});
    await placer.placeAll({
      ctx: placeCtx(t), journal: t.journal, saveJournal: () => save(t), step,
      shouldYield: () => t.stopping === 'dispose',
    });
  }

  async function finish(t, error) {
    const stopping = t.stopping;
    t.stopping = null;
    if (stopping === 'dispose') {
      setState(t, 'disposed');
      active = null;
      return snapshot(t);
    }
    if (stopping === 'cancel') {
      await quietCall('cancel', { offerId: t.offer.offerId, reason: 'cancelled' });
      await removeStaging(t);
      setState(t, 'cancelled');
      active = null;
      log('INFO', 'team.model.receive_cancelled', { transferId: t.id });
      return snapshot(t);
    }
    if (stopping === 'pause') {
      await quietCall('pause', { offerId: t.offer.offerId, reason: 'paused' });
      setState(t, 'paused');
      return snapshot(t);
    }
    let reason = error?.reason;
    if (!MODEL_RECEIVE_REASONS.includes(reason)) {
      reason = error?.code === 'ENOSPC' ? 'model_no_space' : 'model_staging_failed';
      log('WARN', 'team.model.receive_io_failed', { transferId: t.id, code: error?.code || 'none' });
    }
    if (TERMINAL.has(reason)) {
      await quietCall('cancel', { offerId: t.offer.offerId, reason });
      if (error?.kept) {
        log('WARN', 'team.model.receive_rollback_kept', { transferId: t.id, reason });
      } else {
        await removeStaging(t);
      }
      setState(t, 'failed', reason);
      active = null;
    } else {
      await quietCall('pause', { offerId: t.offer.offerId, reason });
      setState(t, 'paused', reason);
    }
    log('WARN', 'team.model.receive_stopped', { transferId: t.id, reason, state: t.state });
    return snapshot(t);
  }

  async function run(t) {
    try {
      if (t.journal.phase === 'pulling') await trimToVerified(t);
      t.doneBytes = verifiedBytes(t);
      if (remainingBytes(t) > 0) {
        if (!spaceHolds(t)) throw reasonError('model_no_space');
        await call(t, t.accepted ? 'resume' : 'accept', { offerId: t.offer.offerId, startPoints: startPoints(t) });
        t.accepted = true;
      } else if (!t.accepted) {
        // Every byte is already here (a restart in the middle of placement): this run has no host transfer to complete
        // unless it takes the offer up again. Best effort: a host that no longer has the offer must not stop the set
        // from being placed.
        await quietCall('resume', { offerId: t.offer.offerId, startPoints: startPoints(t) });
      }
      setState(t, 'pulling');
      const files = t.offer.manifest.files;
      for (let index = 0; index < files.length; index += 1) {
        if (t.journal.files[index].whole) continue;
        await pullFile(t, index);
        setState(t, 'verifying');
        await verifyWhole(t, index);
        if (index < files.length - 1) setState(t, 'pulling');
      }
      checkAborted(t);
      await place(t);
      await removeStaging(t);
      // Nothing is sent once dispose has been asked for.
      if (t.stopping !== 'dispose') await quietCall('complete', { offerId: t.offer.offerId });
      t.stopping = null;
      setState(t, 'complete');
      active = null;
      log('INFO', 'team.model.receive_complete', { transferId: t.id, files: files.length, bytes: totalBytes(t) });
      return snapshot(t);
    } catch (error) {
      return finish(t, error);
    }
  }

  function begin(t) {
    t.stopping = null;
    t.controller = new AbortController();
    t.run = run(t);
    return t.run;
  }

  // A stop asked for while the accept checks ran: no transport call was made.
  async function settleBeforeRun(t, kind) {
    t.controller = new AbortController();
    if (kind === 'pause') {
      setState(t, 'paused');
      return snapshot(t);
    }
    if (kind === 'cancel') await removeStaging(t);
    setState(t, kind === 'cancel' ? 'cancelled' : 'disposed');
    active = null;
    return snapshot(t);
  }

  /** Accept an offer into a root: a refusal `{ ok: false, reason }`, or the promise of the run's end state. */
  async function start({ offer, root } = {}) {
    if (disposed) return { ok: false, reason: 'model_receiver_disposed' };
    if (active) return { ok: false, reason: 'model_receiver_busy' };
    let finishClaim;
    const claim = { claim: true, stopping: null, finished: new Promise((resolve) => { finishClaim = resolve; }) };
    active = claim;
    let prepared;
    try {
      prepared = await acceptor.prepare({ offer, root });
    } catch (error) {
      log('WARN', 'team.model.receive_accept_failed', { code: error?.code || 'none' });
      prepared = { refused: 'model_staging_failed' };
    }
    if (prepared.refused) {
      active = null;
      finishClaim();
      log('INFO', 'team.model.receive_refused', { reason: prepared.refused });
      return { ok: false, reason: prepared.refused };
    }
    const t = prepared.transfer;
    active = t;
    const pending = disposed ? 'dispose' : claim.stopping;
    if (pending) {
      const outcome = await settleBeforeRun(t, pending);
      finishClaim();
      return { ok: false, ...outcome };
    }
    log('INFO', 'team.model.receive_accepted', { transferId: t.id, files: t.offer.manifest.files.length, bytes: totalBytes(t) });
    const running = begin(t);
    finishClaim();
    const outcome = await running;
    return { ok: outcome.state === 'complete', ...outcome };
  }

  async function stop(kind) {
    const t = active;
    if (!t) return { ok: true, state: snapshot(null).state };
    if (t.claim) {
      t.stopping = kind;
      await t.finished;
      return stop(kind);
    }
    if (t.state === 'placing') {
      // Placement is short; dispose waits for the move in hand and stops before the next one.
      if (kind !== 'dispose') return { ok: false, reason: 'model_receiver_busy' };
      t.stopping = 'dispose';
      await t.run;
      return { ok: true, state: snapshot(null).state };
    }
    if (RUNNING.has(t.state) || t.state === 'accepting') {
      t.stopping = kind;
      t.controller.abort();
      await t.run;
      return { ok: true, state: kind === 'pause' ? 'paused' : snapshot(active).state };
    }
    // Paused: nothing runs.
    if (kind === 'cancel') {
      t.stopping = 'cancel';
      await finish(t, null);
    } else if (kind === 'dispose') {
      active = null;
    }
    return { ok: true, state: kind === 'pause' ? 'paused' : snapshot(null).state };
  }

  /**
   * Removes the staging and journal of an offer not in hand (`{ offer, root }` as for `start`), under the same claim
   * as an accept: `{ ok: true }`, or `{ ok: false, reason }` (`model_receiver_busy` while another transfer is held).
   */
  async function discard(input = {}) {
    if (disposed) return { ok: false, reason: 'model_receiver_disposed' };
    if (active) return { ok: false, reason: 'model_receiver_busy' };
    let finishClaim;
    active = { claim: true, stopping: null, finished: new Promise((resolve) => { finishClaim = resolve; }) };
    try {
      return await sweeper.discard(input);
    } catch (error) {
      log('WARN', 'team.model.receive_staging_kept', { code: error?.code || 'unknown' });
      return { ok: false, reason: 'model_staging_failed' };
    } finally {
      active = null;
      finishClaim();
    }
  }

  /** Resume a paused transfer: the promise of the run's end state. */
  async function resume() {
    if (disposed) return { ok: false, reason: 'model_receiver_disposed' };
    const t = active;
    if (!t || t.claim || t.state !== 'paused') return { ok: false, reason: 'model_receiver_busy' };
    const outcome = await begin(t);
    return { ok: outcome.state === 'complete', ...outcome };
  }

  return Object.freeze({
    start,
    resume,
    pause: () => stop('pause'),
    cancel: () => stop('cancel'),
    async dispose() {
      if (disposed) return { ok: true };
      disposed = true;
      await stop('dispose');
      active = null;
      return { ok: true };
    },
    sweep: (now) => sweeper.sweep(now),
    discard: (input) => discard(input),
    status: () => snapshot(active),
    // The folder the transfer in hand goes into (its journal's; read from an event it is the final one once the event
    // says `complete`), or null. Never in an event, a refusal or a log: it is made from a received name.
    folder: () => (active && !active.claim && active.journal ? active.journal.folder : null),
    resources: () => ({ handles, active: active ? 1 : 0 }),
  });
}

module.exports = { MODEL_RECEIVE_REASONS, createModelReceiver };
