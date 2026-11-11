'use strict';

// The first load of a team chat channel without blocking the host (row 123
// slice 2a-3b). Methods installed on TeamChatStore.prototype.
//
// Measured on main (50,000 messages, 100 segments): the synchronous first load
// held the event loop for about 880 ms. `ensureLoaded` reads and checks one
// segment at a time and yields (the injected `yieldTo`, setImmediate by
// default) between segments, so the host keeps answering other requests.
//
//   - Concurrent first accesses of one channel share one load.
//   - The loaded index is assigned in one synchronous step at the end, against
//     the channel document of that moment. A load whose document changed under
//     it in a way that touches segments, or that a synchronous load beat, is
//     dropped unassigned; the channel is then as the synchronous path left it.
//   - A post, edit, delete or follow of a channel being loaded waits for the
//     load before it joins the store's write chain, and a retention pass waits
//     for every load in flight, so each sees the same index as before.
//   - A failed segment read ends the load quietly. Its failure is kept for a
//     few seconds (LOAD_FAILURE_TTL_MS on the store's clock) so the request
//     that awaited the load answers it; a new load of the channel drops it,
//     and once it is older the next synchronous access loads again and
//     answers on its own.
// No persisted index and no segment cache: the measurement did not call for them.

const channels = require('./team-chat-channel');

const LOAD_FAILURE_TTL_MS = 5_000;

// The one event-loop yield of team chat: the stepwise load and search use it.
const yieldToEventLoop = () => new Promise((resolve) => { setImmediate(resolve); });

const loaderMethods = {
  // Resolves once the channel is loaded, or once loading is not possible here
  // (unknown, broken or latched: the synchronous path answers why). Never
  // rejects: a failed load is kept and thrown by the next synchronous access
  // within LOAD_FAILURE_TTL_MS (`_takeLoadFailure`), so it is answered once
  // through the store's rules.
  ensureLoaded(channelId) {
    if (this.open().ok !== true) return Promise.resolve();
    const state = this._channels.get(channelId);
    if (!state || state.loaded || state.broken) return Promise.resolve();
    const pending = this._loads.get(channelId);
    if (pending) return pending;
    // A new load supersedes what the last one left behind.
    this._loadFailures.delete(channelId);
    const load = this._loadStepwise(channelId, state)
      .catch((error) => {
        // As the synchronous load does: corruption breaks this channel only.
        if (error?.brokenReason) error.channelId = channelId;
        if (this._channels.get(channelId) === state && !state.loaded) {
          this._loadFailures.set(channelId, { error, at: this._clock() });
        }
      })
      .finally(() => { if (this._loads.get(channelId) === load) this._loads.delete(channelId); });
    // A channel with no segment loads at once: nothing to wait for.
    if (state.loaded) return Promise.resolve();
    this._loads.set(channelId, load);
    return load;
  },

  // True while a stepwise load of this channel is in flight.
  isLoading(channelId) { return this._loads.has(channelId); },

  // The failure of the last stepwise load of this channel, once, while it is
  // fresh (bounded: one per channel); an older one is dropped unanswered.
  _takeLoadFailure(channelId) {
    const kept = this._loadFailures.get(channelId);
    if (kept === undefined) return undefined;
    this._loadFailures.delete(channelId);
    return this._clock() - kept.at < LOAD_FAILURE_TTL_MS ? kept.error : undefined;
  },

  // True while the load may still be assigned to this channel state.
  _loadCurrent(channelId, state, doc) {
    const now = this._channels.get(channelId);
    return now === state && !state.loaded && !state.broken && state.doc.segments === doc.segments
      && state.doc.next_seq === doc.next_seq && state.doc.floor_seq === doc.floor_seq;
  },

  async _loadStepwise(channelId, state) {
    const doc = state.doc;
    const load = channels.startLoad(doc);
    for (let i = 0; i < doc.segments.length; i += 1) {
      if (i > 0) await this._yieldTo();
      if (!this._loadCurrent(channelId, state, doc)) return;
      channels.loadStep(load, this._readSegment(channelId, doc.segments[i].n));
    }
    if (!this._loadCurrent(channelId, state, doc)) return;
    const outcome = channels.finishLoad(state, load, this._io);
    if (outcome.strays > 0 || outcome.rolledForward > 0) {
      this._log('WARN', 'team_chat.reconciled', { channel_id: channelId, strays: outcome.strays,
        rolled_forward: outcome.rolledForward });
    }
  },

  // Runs `start` (which joins the write chain) after the channel's load and
  // after the mutations of this channel that were already waiting, so their
  // order is the call order. With nothing to wait for it runs at once. The
  // returned promise is tracked so `settled()` waits for work not yet queued.
  // The tail resolves when `start()` is called, not when its mutation
  // finishes: `start()` joins the store's write chain synchronously, and from
  // then on the chain keeps the order. The next waiter only has to join the
  // chain after it; holding it until the write lands would serialize every
  // mutation of the channel behind disk I/O a second time.
  _afterLoad(channelId, start) {
    const loading = this.ensureLoaded(channelId);
    const before = this._tails.get(channelId);
    if (!before && !this._loads.has(channelId)) return start();
    let markQueued;
    const queued = new Promise((resolve) => { markQueued = resolve; });
    this._tails.set(channelId, queued);
    queued.then(() => { if (this._tails.get(channelId) === queued) this._tails.delete(channelId); });
    const run = (before || Promise.resolve()).then(() => loading).then(() => {
      try { return start(); } finally { markQueued(); }
    });
    return this._track(run);
  },

  // Runs `start` once every load in flight is done (a retention pass).
  _afterLoads(start) {
    if (this._loads.size === 0) return start();
    return this._track(Promise.all([...this._loads.values()]).then(start));
  },

  _track(run) {
    this._waiting.add(run);
    const drop = () => { this._waiting.delete(run); };
    run.then(drop, drop);
    return run;
  },

  // Resolves once every load in flight, every mutation waiting for one and
  // every mutation already queued has settled.
  async settled() {
    while (this._loads.size > 0 || this._waiting.size > 0) {
      await Promise.allSettled([...this._loads.values(), ...this._waiting]);
    }
    await this._chain;
  },
};

module.exports = { loaderMethods, yieldToEventLoop };
