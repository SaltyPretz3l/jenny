/* Model sharing's renderer state (row 123, slice 6-7; TEAM_MODEL_SHARING_SPEC "6-7 as built"): one per window, held by
 * the Team tab's gate once a membership exists (the tab's number counts offers) and read by Settings › Models and
 * Settings › Team through `peekModelStore()`, which answers null while this file is not loaded (no team assets).
 *
 * Per online team it calls `modelState` once when the team is first seen online and again after each reconnect (main
 * builds a team's model entry on the first model call, so kept offers are re-sent and staging found), then follows
 * `team.onModel`: `state` replaces the team's rows, `progress` patches one transfer's bytes and rate, `received` marks a
 * tag. A malformed push is ignored. A `modelState` refused `team_model_sharing_off` is the kill switch on this PC
 * (JENNY_ENABLE_TEAM_MODEL_SHARING=0); an answer with `sharing: 'off'` is the host's switch.
 *
 * It also keeps, for this window's life: the one "review this offer" id the Team tab sets for the Library; the display
 * path each accept drawer showed (the "arriving in" line); the offers set aside with Later on the Team tab's card; the
 * failed incoming rows dismissed; and which Library tags were received (`modelProvenance` per tag and team, at most 3
 * calls in flight, answers kept; `team_not_found` and `model_not_listed` are "not received", kept as null). All of it
 * goes when the last hold is released; a team dropped takes its own entries with it.
 *
 * Bounds: the client's own caps (16 open plus 16 ended outgoing offers with at most 8 transfers each, 128 incoming
 * offers), 4 teams, 128 kept paths and set-aside ids each, 512 provenance answers. Subscribers get one change:
 * { type: 'state' | 'progress' | 'received' | 'provenance' | 'review' | 'gone', team_id, ... }; a progress push tells
 * only `progress` with its transfer id, so a view repaints that row's bar and nothing else; `provenance` is told only
 * when a tag turned out received (with its tag, so a view repaints that row). Values are main's rebuilt pushes and
 * answers, drawn escaped by the views. `eligibleTeams` is the one rule for which teams model sharing follows. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-store'));
    return;
  }
  root.rendererTeamModelStore = factory(root.rendererTeamStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (teamStore) {
  'use strict';

  const LOCKED = new Set(['revoked', 'pending', 'needs_repair', 'force_local']);
  const SHARING = new Set(['on', 'off', 'unknown']);
  const MAX_TEAMS = 4;
  const MAX_OUTGOING = 32;
  const MAX_TRANSFERS = 8;
  const MAX_INCOMING = 128;
  const MAX_KEPT = 128;
  const MAX_PROVENANCE = 512;
  const ASK_AT_ONCE = 3;
  const CALL_TIMEOUT_MS = 10_000;
  // An offer waits on the checks before any read; an accept or retry on the host's accept; a read on the main file's header.
  const SLOW_MS = Object.freeze({ modelOffer: 60_000, modelAccept: 120_000, modelReceiveRetry: 120_000, modelOfferRead: 30_000, modelFiles: 30_000 });
  const FAILED = Object.freeze({ ok: false, error: Object.freeze({ code: 'CMP-TEAM-0001', reason: '' }) });
  const NOT_RECEIVED = new Set(['team_not_found', 'model_not_listed']);

  const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const count = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
  const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;
  // Insertion-ordered and bounded: the oldest goes first.
  function bounded(map, key, value, max) {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
  }

  // The teams model sharing follows: not locked, not waiting for the owner's approval, at most 4.
  function eligibleTeams(teams) {
    return (Array.isArray(teams) ? teams : []).filter((t) => t && !LOCKED.has(t.state) && t.member_state !== 'pending').slice(0, MAX_TEAMS);
  }

  function outgoingRows(list) {
    if (!Array.isArray(list)) return null;
    return list.filter((row) => isObject(row) && id(row.request_id)).slice(0, MAX_OUTGOING).map((row) => ({
      ...row, transfers: Array.isArray(row.transfers) ? row.transfers.filter((t) => isObject(t) && id(t.transfer_id)).slice(0, MAX_TRANSFERS).map((t) => ({ ...t })) : [],
    }));
  }
  function incomingRows(list) {
    if (!Array.isArray(list)) return null;
    return list.filter((row) => isObject(row) && id(row.offer_id)).slice(0, MAX_INCOMING)
      .map((row) => ({ ...row, transfer: isObject(row.transfer) ? { ...row.transfer } : null }));
  }

  function createModelStore({ windowRef = null, teams: teamsOf = null } = {}) {
    const win = () => windowRef || (typeof window !== 'undefined' ? window : null);
    const bridge = () => { const w = win(); return (w && w.jennyShell && w.jennyShell.team) || null; };
    const byTeam = new Map(); // team id -> state
    const listeners = new Set();
    const paths = new Map(); // offer id -> the display path its accept drawer showed
    const later = new Map(); // offer id -> true: Later on the Team tab's card (this run)
    const dismissed = new Map(); // offer id -> true: a failed incoming row dismissed
    const provenance = new Map(); // team id + '\n' + tag -> provenance object, or null (not received through it)
    const asking = new Set();
    const waiting = [];
    const timers = new Map(); // a call's timeout -> its resolve: released (answered as failed) when the last hold goes
    let review = null; // { team_id, offer_id }
    let holds = 0;
    let off = null;
    let teamsOff = null; // the team store's changes, followed while held (each one re-syncs the teams)

    function emit(change) { for (const fn of [...listeners]) { try { fn(change); } catch (_error) { /* a view must not stop the others */ } } }
    const store = () => teamStore.getTeamStore();
    const currentTeams = () => ((typeof teamsOf === 'function' ? teamsOf() : store().snapshot().teams) || []).filter(Boolean).slice(0, MAX_TEAMS);
    const forceLocal = () => typeof store().forceLocal === 'function' && store().forceLocal() === true;

    // The bridge call with its own bound: a missing method, a throw, a bad answer and a timeout read the same.
    function call(method, payload) {
      const api = bridge();
      if (!api || typeof api[method] !== 'function') return Promise.resolve(FAILED);
      let sent;
      try { sent = api[method](payload); } catch (_error) { return Promise.resolve(FAILED); }
      return new Promise((resolve) => {
        const timer = setTimeout(() => { timers.delete(timer); resolve(FAILED); }, SLOW_MS[method] || CALL_TIMEOUT_MS);
        timers.set(timer, resolve);
        Promise.resolve(sent).then((answer) => (isObject(answer) && typeof answer.ok === 'boolean' ? answer : FAILED), () => FAILED)
          .then((answer) => { clearTimeout(timer); timers.delete(timer); resolve(answer); });
      });
    }

    function fresh(teamId) {
      return { teamId, sharing: 'unknown', sharingReason: null, online: false, rate: 0, outgoing: [], incoming: [], killed: false,
        error: null, reading: false, loaded: false, epoch: 0, wasOnline: false };
    }

    function drop(teamId) {
      const state = byTeam.get(teamId);
      if (!state) return;
      state.epoch += 1;
      byTeam.delete(teamId);
      const prefix = teamId + '\n';
      for (const key of [...provenance.keys()]) if (key.startsWith(prefix)) provenance.delete(key);
      for (const key of [...asking]) if (key.startsWith(prefix)) asking.delete(key);
      for (let i = waiting.length - 1; i >= 0; i -= 1) if (waiting[i].teamId === teamId) waiting.splice(i, 1);
      // Its offers' kept paths, set-aside and dismissed marks (offer and request ids are this team's own).
      const ids = state.incoming.map((row) => row.offer_id).concat(state.outgoing.map((row) => row.request_id));
      for (const offerId of ids) { paths.delete(offerId); later.delete(offerId); dismissed.delete(offerId); }
      if (review && review.team_id === teamId) review = null;
      emit({ type: 'gone', team_id: teamId });
    }

    function take(state, value) {
      if (SHARING.has(value.sharing)) state.sharing = value.sharing;
      state.sharingReason = typeof value.sharing_reason === 'string' ? value.sharing_reason : null;
      state.online = value.online === true;
      state.rate = Number.isSafeInteger(value.rate_mb_per_second) ? value.rate_mb_per_second : 0;
      const out = outgoingRows(value.outgoing);
      const inc = incomingRows(value.incoming);
      if (out) state.outgoing = out;
      if (inc) state.incoming = inc;
      state.loaded = true;
    }

    function readState(state) {
      if (state.reading) return;
      state.reading = true;
      const started = state.epoch;
      void call('modelState', { team_id: state.teamId }).then((answer) => {
        if (byTeam.get(state.teamId) !== state || state.epoch !== started) return;
        state.reading = false;
        if (answer.ok) { state.killed = false; state.error = null; take(state, answer); }
        else {
          state.error = answer.error || FAILED.error;
          state.killed = state.error.reason === 'team_model_sharing_off';
          state.loaded = true;
        }
        emit({ type: 'state', team_id: state.teamId });
      });
    }

    function onPush(payload) {
      if (!isObject(payload) || typeof payload.team_id !== 'string') return;
      const state = byTeam.get(payload.team_id);
      if (!state) return;
      if (payload.kind === 'state') {
        if (!SHARING.has(payload.sharing) || !Array.isArray(payload.outgoing) || !Array.isArray(payload.incoming)) return;
        take(state, payload);
        state.killed = false;
        emit({ type: 'state', team_id: state.teamId });
      } else if (payload.kind === 'progress') {
        if ((payload.direction !== 'send' && payload.direction !== 'receive') || !id(payload.transfer_id)) return;
        const target = payload.direction === 'send'
          ? state.outgoing.flatMap((row) => row.transfers).find((t) => t.transfer_id === payload.transfer_id)
          : (state.incoming.find((row) => row.transfer && (row.transfer.transfer_id === payload.transfer_id || row.offer_id === payload.offer_id)) || {}).transfer;
        if (!target) return;
        target.bytes_done = count(payload.bytes_done);
        target.bytes_total = count(payload.bytes_total);
        target.rate_bps = count(payload.rate_bps);
        emit({ type: 'progress', team_id: state.teamId, direction: payload.direction, transfer_id: payload.transfer_id,
          offer_id: typeof payload.offer_id === 'string' ? payload.offer_id : null });
      } else if (payload.kind === 'received') {
        // `tag` is null when main could not find the placed file in the scan; anything else that is not a tag is malformed.
        const tag = typeof payload.tag === 'string' && payload.tag.length > 0 && payload.tag.length <= 256 ? payload.tag : null;
        if (tag === null && payload.tag !== null) return;
        emit({ type: 'received', team_id: state.teamId, tag });
        // Asked again at once: the answer marks the Library row (decision 7).
        if (tag) {
          provenance.delete(state.teamId + '\n' + tag);
          if (waiting.length < MAX_PROVENANCE) waiting.push({ teamId: state.teamId, tag });
          pump();
        }
      }
    }

    function subscribe() {
      const api = bridge();
      if (off || !api || typeof api.onModel !== 'function') return;
      const unsubscribe = api.onModel(onPush);
      off = typeof unsubscribe === 'function' ? unsubscribe : () => {};
    }

    // Kept in step with the teams (the gate calls it on every team change). A team coming back online is read again.
    function sync(teams = currentTeams()) {
      if (!holds) return;
      const rows = eligibleTeams(teams);
      const held = forceLocal();
      for (const teamId of [...byTeam.keys()]) {
        if (held || !rows.some((row) => row.team_id === teamId)) drop(teamId);
      }
      if (held) return;
      for (const team of rows) {
        let state = byTeam.get(team.team_id);
        if (!state) { state = fresh(team.team_id); byTeam.set(team.team_id, state); }
        const online = team.state === 'online';
        if (online) subscribe();
        if (online && !state.wasOnline) readState(state);
        state.wasOnline = online;
      }
    }

    // ------------------------------------------------------------- provenance (which rows were received)

    function pump() {
      while (asking.size < ASK_AT_ONCE && waiting.length) {
        const job = waiting.shift();
        const key = job.teamId + '\n' + job.tag;
        const state = byTeam.get(job.teamId);
        if (provenance.has(key) || asking.has(key) || !state) continue;
        asking.add(key);
        const started = state.epoch;
        void call('modelProvenance', { team_id: job.teamId, tag: job.tag }).then((answer) => {
          if (byTeam.get(job.teamId) !== state || state.epoch !== started) return; // dropped or released meanwhile
          asking.delete(key);
          const found = answer.ok && isObject(answer.provenance) ? answer.provenance : null;
          if (found || (answer.error && NOT_RECEIVED.has(answer.error.reason))) bounded(provenance, key, found, MAX_PROVENANCE);
          // Told only when the tag turned out received: a "not received" changes no row.
          if (found) emit({ type: 'provenance', team_id: job.teamId, tag: job.tag });
          pump();
        });
      }
    }

    // Once per Library load: each GGUF tag not yet known is asked of each online team.
    function askProvenance(tags) {
      for (const tag of (tags || []).filter((t) => typeof t === 'string' && t.length > 0 && t.length <= 256)) {
        for (const state of byTeam.values()) {
          const key = state.teamId + '\n' + tag;
          if (state.wasOnline && !state.killed && !provenance.has(key) && !asking.has(key) && waiting.length < MAX_PROVENANCE) waiting.push({ teamId: state.teamId, tag });
        }
      }
      pump();
    }

    // The received model's provenance and the team it came through, or null.
    function receivedOf(tag) {
      for (const state of byTeam.values()) {
        const found = provenance.get(state.teamId + '\n' + tag);
        if (found) return { team_id: state.teamId, provenance: found };
      }
      return null;
    }

    // ------------------------------------------------------------- holding

    function release() {
      holds = Math.max(0, holds - 1);
      if (holds) return;
      if (off) { try { off(); } catch (_error) { /* best effort */ } }
      if (teamsOff) { try { teamsOff(); } catch (_error) { /* best effort */ } }
      teamsOff = null;
      off = null;
      for (const state of byTeam.values()) state.epoch += 1;
      byTeam.clear();
      asking.clear();
      waiting.length = 0;
      // Nothing another member wrote or a drawer showed stays once nothing holds the store.
      provenance.clear();
      paths.clear();
      later.clear();
      dismissed.clear();
      review = null;
      for (const [timer, resolve] of [...timers]) { clearTimeout(timer); resolve(FAILED); }
      timers.clear();
    }

    return {
      use() {
        holds += 1;
        if (!teamsOff && typeof teamsOf !== 'function') teamsOff = store().subscribe(() => sync());
        sync();
        let done = false;
        return () => { if (!done) { done = true; release(); } };
      },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      sync, call, askProvenance, receivedOf,
      team: (teamId) => byTeam.get(teamId) || null,
      teams: () => [...byTeam.values()],
      // Offers waiting for this member's answer, across teams (the Team tab's number, decision 11).
      offerCount() {
        let total = 0;
        for (const state of byTeam.values()) total += state.incoming.filter((row) => row.state === 'open' && !row.transfer && !dismissed.has(row.offer_id)).length;
        return total;
      },
      setReview(teamId, offerId) { review = id(teamId) && id(offerId) ? { team_id: teamId, offer_id: offerId } : null; emit({ type: 'review' }); },
      takeReview() { const value = review; review = null; return value; },
      peekReview: () => review,
      keepPath(offerId, displayPath) { if (id(offerId) && typeof displayPath === 'string') bounded(paths, offerId, displayPath, MAX_KEPT); },
      pathOf: (offerId) => paths.get(offerId) || '',
      setLater(offerId) { if (id(offerId)) { bounded(later, offerId, true, MAX_KEPT); emit({ type: 'state', team_id: null }); } },
      isLater: (offerId) => later.has(offerId),
      dismiss(offerId) { if (id(offerId)) { bounded(dismissed, offerId, true, MAX_KEPT); emit({ type: 'state', team_id: null }); } },
      isDismissed: (offerId) => dismissed.has(offerId),
      resources: () => ({ teams: byTeam.size, subscribed: Boolean(off), teamStore: Boolean(teamsOff), listeners: listeners.size, holds,
        asking: asking.size, waiting: waiting.length, timers: timers.size, provenance: provenance.size, paths: paths.size,
        later: later.size, dismissed: dismissed.size }),
      dispose() {
        holds = 1;
        release();
        listeners.clear();
      },
    };
  }

  let shared = null;
  function getModelStore() {
    if (!shared) shared = createModelStore();
    return shared;
  }
  // The Library and Settings › Team: the store once something loaded and holds it, else null.
  function peekModelStore() { return shared; }

  return { createModelStore, getModelStore, peekModelStore, eligibleTeams, LIMITS: Object.freeze({ MAX_OUTGOING, MAX_TRANSFERS, MAX_INCOMING, MAX_KEPT, MAX_PROVENANCE, ASK_AT_ONCE }) };
});
