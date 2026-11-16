'use strict';

// The model receiver's network transport for one team (row 123 slice 6-5; the interface model-receive.js calls,
// TEAM_MODEL_SHARING_SPEC "6-4 as built" and "6-3 as built"). It keeps offer id -> transfer id, maps the receiver's
// start points `{ file, offset }` to the host's `resume: [{ index, offset }]`, absorbs a part GET's 204 and the
// host's `team_model_relay_busy` with a bounded back-off and a count that ends the take (`team_model_transfer_stale`,
// `team_model_relay_busy`), bounds the stale answers one take may meet, and honours the abort signal in every wait.
//
// Where the host is: a part leaves the relay's window only once a later part was served, so the host's low end is
// the last part this receiver took (or the transfer's start when it took none): the `base`. A pause drops the window
// and the sender puts again from the base; the receiver must take the base once more (the transport drops those
// bytes), or the unserved part would hold the window full for good. A pause is seen in the transfer's events
// (`pausesOf`), in a stale answer, or because this receiver paused.
//
// The host cannot rewind a live transfer: a part before the base answers `team_model_transfer_stale`, and
// `team.model.resume` takes only the transfer id. So when the receiver asks for bytes before the base (a segment
// mismatch, a pause mid-segment, a restart), the transport cancels the transfer and accepts the offer again with the
// new resume list; the relay lets the same member accept a direct offer reopened by the cancel, and a team offer
// again. A second accept of a live transfer with other start points (`team_model_request_reused`, after a restart)
// cancels that transfer first. Receiver reasons the host's `complete` does not accept travel as a plain cancel; pause
// reasons as a plain pause. Failures reject with an error whose `code` is a closed reason word. Nothing here logs.

const { COMPLETE_REASONS } = require('../../server/team/model-relay-core');
const { offersList, transferView } = require('./model-answers');
const { LinkDropped, TransferEnd } = require('./transfer-common');

const LIVE = new Set(['accepted', 'flowing', 'paused']);
const DEFAULTS = Object.freeze({
  // Back-off after `team_model_relay_busy`: 1 s, doubling to 8 s; the 30th busy answer in a row ends the take.
  busyMs: 1000, busyMaxMs: 8000, busyTries: 30,
  // Back-off after a part GET's 204 (the host waits 25 s before it; an untrusted host may not): 250 ms, doubling to
  // 4 s; the 40th in a row with no byte (about 19 minutes against the real host) ends the take.
  notReadyMs: 250, notReadyMaxMs: 4000, notReadyTries: 40,
  // Stale answers one take may meet (each after a back-off of 500 ms, doubling to 8 s) before it ends.
  staleMs: 500, stales: 6,
  // A reset while the link still reads as online is retried this many times in a row, 1 s apart.
  resets: 3, resetMs: 1000,
  // A paused transfer is looked at again after this long without an event.
  pausedWaitMs: 30_000,
  // Re-pulls one takePart may start before it gives up.
  rewinds: 2,
});

const codeError = (code) => Object.assign(new Error(code), { code });
const backoff = (base, max, tries) => Math.min(base * (2 ** Math.min(tries, 16)), max);
const reasonOf = (answer) => (typeof answer?.error?.reason === 'string' ? answer.error.reason : 'team_answer_invalid');
const cmp = (a, b) => (a.file - b.file) || (a.offset - b.offset);

function abortable(work, signal) {
  if (!signal) return Promise.resolve().then(work);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(codeError('aborted'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(work).then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

/**
 * deps: `command(operation, params)` (the host's answer; throws LinkDropped with no answer), `part(transferId, index,
 * n, signal)` (a part GET's answer; LinkDropped or TransferEnd('aborted')), `online()`, `memberId()`, `sizesOf(offerId)`
 * (the offer's file sizes), `pausesOf(transferId)` (paused events seen), `waitChange(transferId, signal, ms)` (the next
 * event for it, or the time), `sleep(ms, signal)`, `partBytes`, `windowParts`.
 */
function createModelTransport({
  command, part, online, memberId, sizesOf, pausesOf, waitChange, sleep, partBytes, windowParts,
}) {
  const limits = DEFAULTS;
  // offer id -> { transferId, start, last, pauses }: `start` and `last` are { file, offset } (last null until a take).
  const entries = new Map();

  const ask = async (operation, params, signal = null) => {
    try {
      return await abortable(() => command(operation, params), signal);
    } catch (error) {
      if (error?.code === 'aborted') throw error;
      if (error instanceof LinkDropped) throw codeError('team_not_connected');
      throw codeError('team_unavailable');
    }
  };
  const sizes = (offerId) => {
    const known = sizesOf(offerId);
    if (!Array.isArray(known) || known.length === 0) throw codeError('team_not_found');
    return known;
  };
  const startPos = (startPoints, all) => {
    const first = [...startPoints].sort((a, b) => a.file - b.file).find((point) => point.offset < all[point.file]);
    return first ? { file: first.file, offset: first.offset } : { file: all.length, offset: 0 };
  };
  const viewPos = (view) => (view.next ? { file: view.next.index, offset: view.next.part * partBytes } : null);
  const base = (entry) => entry.last || entry.start;
  // A point's place in the offer's whole part sequence, and the point one part later (into the next file at an end).
  const ordinal = (all, at) => all.slice(0, at.file).reduce((sum, size) => sum + Math.ceil(size / partBytes), 0)
    + at.offset / partBytes;
  const after = (all, at) => (at.offset + partBytes < all[at.file] ? { file: at.file, offset: at.offset + partBytes }
    : { file: at.file + 1, offset: 0 });

  async function listed(signal) {
    return offersList(await ask('team.model.offers', {}, signal));
  }

  async function open(offerId, startPoints, signal, retried = false) {
    const resume = startPoints.map((point) => ({ index: point.file, offset: point.offset }));
    const answer = await ask('team.model.accept', { offer_id: offerId, resume }, signal);
    if (answer?.ok !== true) {
      const reason = reasonOf(answer);
      if (reason !== 'team_model_request_reused' || retried) throw codeError(reason);
      const live = (await listed(signal))?.transfers.filter((view) => view.offer_id === offerId
        && view.receiver_member_id === memberId() && LIVE.has(view.state)) || [];
      for (const view of live) await ask('team.model.cancel', { transfer_id: view.transfer_id }, signal);
      return open(offerId, startPoints, signal, true);
    }
    const view = transferView(answer.transfer);
    if (!view) throw codeError('team_answer_invalid');
    const start = startPos(startPoints, sizes(offerId));
    // The same live transfer, answered for the same start points, has moved on: start it again from ours.
    const at = viewPos(view);
    if (LIVE.has(view.state) && at && cmp(at, start) !== 0 && !retried) {
      await ask('team.model.cancel', { transfer_id: view.transfer_id }, signal);
      return open(offerId, startPoints, signal, true);
    }
    entries.set(offerId, { transferId: view.transfer_id, start, last: null, pauses: pausesOf(view.transfer_id) });
    return view.transfer_id;
  }

  // Cancel and accept again from `want` (everything before it is held, nothing after it).
  async function rewind(offerId, want, signal) {
    const entry = entries.get(offerId);
    entries.delete(offerId);
    if (entry) {
      await ask('team.model.cancel', { transfer_id: entry.transferId }, signal).catch((error) => {
        if (error?.code === 'aborted') throw error;
      });
    }
    const all = sizes(offerId);
    await open(offerId, all.map((size, index) => ({
      file: index, offset: index < want.file ? size : index === want.file ? want.offset : 0,
    })), signal);
    return entries.get(offerId);
  }

  // Waits while the transfer is paused (an idle pause this receiver resumes itself); throws once it ended.
  async function untilLive(entry, signal) {
    for (;;) {
      const view = (await listed(signal))?.transfers.find((row) => row.transfer_id === entry.transferId) || null;
      if (!view || !LIVE.has(view.state)) throw codeError(view?.reason || 'team_model_transfer_stale');
      if (view.state !== 'paused') return;
      if (view.reason === 'idle') {
        const answer = await ask('team.model.resume', { transfer_id: entry.transferId }, signal);
        if (answer?.ok === true && transferView(answer.transfer)?.state !== 'paused') return;
      }
      await waitChange(entry.transferId, signal, limits.pausedWaitMs);
    }
  }

  // One part's bytes at `at`: 'stale' when the host refused it as not in its window, else the bytes.
  async function fetch(entry, at, signal) {
    let busy = 0;
    let resets = 0;
    let notReady = 0;
    for (;;) {
      if (signal?.aborted) throw codeError('aborted');
      let answer;
      try {
        answer = await part(entry.transferId, at.file, at.offset / partBytes, signal);
      } catch (error) {
        if (signal?.aborted || (error instanceof TransferEnd && error.reason === 'aborted')) throw codeError('aborted');
        if (!online() || resets >= limits.resets) throw codeError('team_not_connected');
        resets += 1;
        await sleep(limits.resetMs, signal);
        continue;
      }
      resets = 0;
      if (answer?.ok === true && answer.bytes) return answer.bytes;
      if (answer?.ok === true && answer.ready === false) {
        if (notReady + 1 >= limits.notReadyTries) throw codeError('team_model_transfer_stale');
        await sleep(backoff(limits.notReadyMs, limits.notReadyMaxMs, notReady), signal);
        notReady += 1;
        continue;
      }
      const reason = reasonOf(answer);
      if (reason === 'team_model_transfer_stale') return 'stale';
      if (reason !== 'team_model_relay_busy') throw codeError(reason);
      if (busy + 1 >= limits.busyTries) throw codeError('team_model_relay_busy');
      await sleep(backoff(limits.busyMs, limits.busyMaxMs, busy), signal);
      busy += 1;
    }
  }

  // Puts the entry where `want` can be asked next: a re-pull for a point before the base or past one window, the
  // base taken again (and dropped) after a pause. Answers the entry to use.
  async function position(offerId, entry, want, signal, dropped) {
    const from = base(entry);
    const all = sizes(offerId);
    if (cmp(want, from) < 0 || ordinal(all, want) - ordinal(all, from) > windowParts) return rewind(offerId, want, signal);
    if (!dropped || cmp(want, from) === 0) return entry;
    for (let at = from; cmp(at, want) < 0; at = after(all, at)) {
      const bytes = await fetch(entry, at, signal);
      if (bytes === 'stale') return rewind(offerId, want, signal);
      entry.last = at;
    }
    return entry;
  }

  async function takePart({ offerId, file, offset, signal }) {
    let entry = entries.get(offerId);
    if (!entry) throw codeError('model_not_receiving');
    const want = { file, offset };
    let rewinds = 0;
    let stales = 0;
    let dropped = false;
    for (;;) {
      const pauses = pausesOf(entry.transferId);
      if (pauses > entry.pauses) { entry.pauses = pauses; dropped = true; }
      const next = await position(offerId, entry, want, signal, dropped);
      if (next !== entry) rewinds += 1;
      entry = next;
      dropped = false;
      const bytes = await fetch(entry, want, signal);
      if (bytes !== 'stale') {
        entry.last = want;
        return bytes;
      }
      if (stales + 1 >= limits.stales) throw codeError('team_model_transfer_stale');
      await sleep(backoff(limits.staleMs, limits.busyMaxMs, stales), signal);
      stales += 1;
      await untilLive(entry, signal);
      // A stale answer while the transfer flows again: the window was dropped (a pause), or the part is gone. The
      // re-pull bound comes first, so pauses that keep coming cannot hold the take in this loop.
      if (rewinds >= limits.rewinds) throw codeError('team_model_transfer_stale');
      if (pausesOf(entry.transferId) > entry.pauses) continue;
      dropped = true;
      entry.pauses = -1;
    }
  }

  async function resume({ offerId, startPoints, signal }) {
    const entry = entries.get(offerId);
    if (!entry) return open(offerId, startPoints, signal);
    const want = startPos(startPoints, sizes(offerId));
    const answer = await ask('team.model.resume', { transfer_id: entry.transferId }, signal);
    if (answer?.ok !== true) {
      const reason = reasonOf(answer);
      if (reason !== 'team_model_transfer_stale' && reason !== 'team_not_found') throw codeError(reason);
      try {
        if (reason === 'team_not_found') throw codeError(reason);
        await untilLive(entry, signal); // paused by the sender: wait for it to flow
      } catch (error) {
        if (error?.code === 'aborted') throw error;
        entries.delete(offerId);
        return open(offerId, startPoints, signal);
      }
    }
    // This receiver's pause dropped the window: the next take starts from the base again.
    entry.pauses = -1;
    const placed = await position(offerId, entry, want, signal, false);
    return placed.transferId;
  }

  const quiet = async (offerId, run) => {
    const entry = entries.get(offerId);
    if (!entry) return;
    const answer = await run(entry);
    if (answer?.ok !== true) throw codeError(reasonOf(answer));
  };

  return Object.freeze({
    accept: ({ offerId, startPoints, signal }) => open(offerId, startPoints, signal),
    resume,
    takePart,
    pause: ({ offerId }) => quiet(offerId, (entry) => ask('team.model.pause', { transfer_id: entry.transferId })),
    cancel: async ({ offerId, reason }) => {
      try {
        await quiet(offerId, (entry) => (COMPLETE_REASONS.includes(reason)
          ? ask('team.model.complete', { transfer_id: entry.transferId, ok: false, reason })
          : ask('team.model.cancel', { transfer_id: entry.transferId })));
      } finally { entries.delete(offerId); }
    },
    complete: async ({ offerId }) => {
      try {
        await quiet(offerId, (entry) => ask('team.model.complete', { transfer_id: entry.transferId, ok: true }));
      } finally { entries.delete(offerId); }
    },
    transferOf: (offerId) => entries.get(offerId)?.transferId || null,
  });
}

module.exports = { createModelTransport };
