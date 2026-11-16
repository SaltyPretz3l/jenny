'use strict';

// The sender's push of one transfer (row 123 slice 6-5, decision 4; TEAM_MODEL_SHARING_SPEC "6-3 as built", what a
// client does with each answer). It follows the transfer's `next` (from the accept, the events and a list), puts one
// part at a time, waits while the transfer is queued or paused, and before each part re-stats the source: the path's
// identity (device, inode, size, modified time) and the open handle's size and modified time must equal what was
// hashed, else it stops with `model_source_changed` (the host then gets a plain cancel from the sender). A lost link
// waits for the team to come back and reads the transfer again (transfer-upload.js's shape: LinkDropped, the
// reconnect waiters, and a stalled-resume counter that ends the push after three drops in a row with no byte moved).
// The optional rate limit (the member's own setting) is applied between parts on the injected clock: one sleep per
// part at most (never longer than that part's time at the rate plus a second), no busy loop, no timer left after an
// abort. Against an untrusted host every retry waits: `window_full` and `team_model_relay_busy` back off (1 s,
// doubling to 8 s) with the part's bytes kept, and the 30th in a row ends the push (`team_model_transfer_stale`,
// `team_model_relay_busy`). A host `next` past the offer's end is the host's fault (`team_answer_invalid`). A host
// reason word is checked against the closed list before it is kept or logged. Nothing here logs a path, a name or a hash.

const fs = require('node:fs');

const { LinkDropped, TransferEnd } = require('./transfer-common');
const { rowReason } = require('./model-reasons');
const { identityOf, sameIdentity } = require('./model-send-source');

const LIVE = new Set(['accepted', 'flowing', 'paused']);
const DEFAULTS = Object.freeze({ busyMs: 1000, busyMaxMs: 8000, busyTries: 30, fullTries: 30, waitMs: 30_000, stalledResumes: 3,
  resetMs: 1000, resets: 3 });
// One limiter sleep is at most the part's time at the rate plus this (a wall-clock step cannot park a push for long).
const LIMIT_MARGIN_MS = 1000;
const backoff = (base, max, tries) => Math.min(base * (2 ** Math.min(tries, 16)), max);

const ended = (reason) => ({ state: 'ended', reason });

class PushEnd extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

/**
 * A limiter over the member's outgoing model bytes: `take(bytes, signal)` resolves once those bytes fit the rate
 * (`rate()` bytes a second; 0 or less means no limit). Shared by every push of one team.
 */
function createRateLimiter({ rate, clock, sleep }) {
  let nextAt = null;
  return {
    async take(bytes, signal) {
      const perSecond = Number(rate()) || 0;
      if (perSecond <= 0) { nextAt = null; return; }
      const now = clock();
      const span = (bytes * 1000) / perSecond;
      if (nextAt === null || nextAt < now || nextAt - now > span + LIMIT_MARGIN_MS) nextAt = now;
      nextAt += span;
      const wait = Math.min(nextAt - clock(), span + LIMIT_MARGIN_MS);
      if (wait > 0) await sleep(wait, signal);
    },
  };
}

/**
 * deps: `transferId`, `files` ([{ path, size, identity }], the offer's order), `partBytes`, `put(index, n, bytes, signal)`
 * (the host's answer; LinkDropped or TransferEnd('aborted')), `command(operation, params)`, `view()` (the last view),
 * `pauses()` (paused events seen for it: a pause rewinds the host to the first part not passed, so the position is
 * read again), `refresh(signal)` (a fresh view from a list), `waitView(signal, ms)`, `online()`, `waitReconnect(signal)`, `sleep`,
 * `limiter`, `onProgress(bytesDone)`, `fsImpl`. `run(signal)` resolves { state, reason } at the end.
 */
function createPush({
  transferId, files, partBytes, put, command, view, pauses, refresh, waitView, online, waitReconnect, sleep, limiter,
  onProgress = () => {}, fsImpl = fs,
}) {
  const limits = DEFAULTS;
  const handles = new Map();

  async function handleOf(index) {
    if (handles.has(index)) return handles.get(index);
    const file = files[index];
    let handle;
    try {
      handle = await fsImpl.promises.open(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } catch {
      throw new PushEnd('model_source_changed');
    }
    handles.set(index, handle);
    return handle;
  }

  // The source must still be the bytes that were hashed: the path and the open handle both.
  async function checkSource(index) {
    const file = files[index];
    let byPath;
    try { byPath = identityOf(await fsImpl.promises.lstat(file.path, { bigint: true })); } catch { byPath = null; }
    if (!sameIdentity(byPath, file.identity)) throw new PushEnd('model_source_changed');
    const handle = await handleOf(index);
    const open = identityOf(await handle.stat({ bigint: true }));
    if (!sameIdentity(open, file.identity)) throw new PushEnd('model_source_changed');
    return handle;
  }

  async function readPart(index, part) {
    const handle = await checkSource(index);
    const offset = part * partBytes;
    const length = Math.min(partBytes, files[index].size - offset);
    if (length <= 0) throw new PushEnd('team_answer_invalid');
    const bytes = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(bytes, read, length - read, offset + read);
      if (bytesRead === 0) throw new PushEnd('model_source_changed');
      read += bytesRead;
    }
    return bytes;
  }

  const after = (at) => (((at.part + 1) * partBytes) < files[at.index].size ? { index: at.index, part: at.part + 1 }
    : (at.index + 1 < files.length ? { index: at.index + 1, part: 0 } : null));
  // A position the host named must lie inside the offer.
  const inside = (at) => at.index < files.length && at.part * partBytes < files[at.index].size;

  async function closeAll() {
    for (const handle of handles.values()) await handle.close().catch(() => {});
    handles.clear();
  }

  // Waits until the transfer may take a part; answers its position, or ends.
  async function ready(signal) {
    for (;;) {
      const current = view();
      if (!current || !LIVE.has(current.state)) throw new PushEnd(current?.state === 'done' ? 'done' : (current?.reason || 'team_model_transfer_stale'));
      if (current.state === 'paused' && current.reason === 'idle') {
        await command('team.model.resume', { transfer_id: transferId }).catch(() => null);
      }
      if (current.state !== 'paused' && !current.queued && current.next) return current.next;
      await waitView(signal, limits.waitMs);
    }
  }

  async function run(signal) {
    let stalled = 0;
    let moved = 0;
    let busy = 0;
    let full = 0;
    let resets = 0;
    let held = null; // the part read for `at`, kept across a retry of the same part
    let seen = pauses();
    try {
      let at = await ready(signal);
      for (;;) {
        if (signal.aborted) throw new TransferEnd('aborted');
        if (pauses() > seen) {
          seen = pauses();
          at = await ready(signal);
          continue;
        }
        if (!at) {
          // Every part is put: wait for the receiver's verdict (or a pause that asks for parts again).
          const current = view();
          if (!current || !LIVE.has(current.state)) throw new PushEnd(current?.state === 'done' ? 'done' : (current?.reason || 'team_model_transfer_stale'));
          await waitView(signal, limits.waitMs);
          continue;
        }
        if (!inside(at)) throw new PushEnd('team_answer_invalid');
        const bytes = held?.at === at ? held.bytes : await readPart(at.index, at.part);
        held = null;
        let answer;
        try {
          answer = await put(at.index, at.part, bytes, signal);
        } catch (error) {
          if (signal.aborted || (error instanceof TransferEnd && error.reason === 'aborted')) throw new TransferEnd('aborted');
          if (!(error instanceof LinkDropped)) throw error;
          if (online() && resets < limits.resets) {
            // The host answers some refusals before reading the body and closes; a reset there is retried.
            resets += 1;
            held = { at, bytes };
            await sleep(limits.resetMs, signal);
            continue;
          }
          resets = 0;
          stalled = moved > 0 ? 0 : stalled + 1;
          moved = 0;
          if (stalled >= limits.stalledResumes) throw new PushEnd('team_not_connected');
          await waitReconnect(signal);
          await refresh(signal).catch(() => null);
          at = await ready(signal);
          continue;
        }
        resets = 0;
        if (answer?.ok === true && answer.ready === true) {
          busy = 0;
          full = 0;
          moved += bytes.length;
          onProgress(at, bytes.length);
          await limiter.take(bytes.length, signal);
          at = after(at);
          continue;
        }
        if (answer?.ok === true && answer.wait === 'window_full') {
          if (full + 1 >= limits.fullTries) throw new PushEnd('team_model_transfer_stale');
          await sleep(backoff(limits.busyMs, limits.busyMaxMs, full), signal);
          full += 1;
          held = { at, bytes };
          continue;
        }
        const reason = rowReason(answer?.error?.reason) || 'team_answer_invalid';
        if (reason === 'team_model_relay_busy') {
          if (busy + 1 >= limits.busyTries) throw new PushEnd('team_model_relay_busy');
          held = { at, bytes };
          if (view()?.queued) await waitView(signal, limits.busyMs * 2);
          else await sleep(backoff(limits.busyMs, limits.busyMaxMs, busy), signal);
          busy += 1;
          continue;
        }
        if (reason === 'team_model_transfer_stale') {
          await refresh(signal).catch(() => null);
          seen = pauses();
          at = await ready(signal);
          continue;
        }
        throw new PushEnd(reason);
      }
    } catch (error) {
      if (error instanceof PushEnd) return { state: error.reason === 'done' ? 'done' : 'ended', reason: error.reason === 'done' ? null : error.reason };
      if (error instanceof TransferEnd || error?.code === 'aborted') return { state: 'stopped', reason: null };
      return ended('model_read_failed');
    } finally {
      await closeAll();
    }
  }

  return { run, handles: () => handles.size };
}

module.exports = { PushEnd, createPush, createRateLimiter };
