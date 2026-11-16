/* The data of one open thread (row 123, slice 2a-6a): its root, its replies
 * oldest first, paging and the follow state. One instance per shown thread;
 * the column owns it and disposes it when the thread closes, so an answer that
 * comes back for a closed or replaced thread changes nothing. No DOM.
 *
 * - A read is a run of `chatThread` calls, one in flight: from the start (when
 *   the thread opens, after a reset, back online) or on from the paging
 *   position, then page after page with `after_seq` while `has_more`, up to
 *   400 replies; past that `capped` is set and no page is asked. The paging
 *   position is the seq of the last reply an answer delivered, never derived
 *   from the list, so a pushed reply never moves it.
 * - The first read of a thread shows each page as it arrives. A read from the
 *   start of a thread already shown collects its pages and replaces what is
 *   shown only when it has finished (the last page, or the cap); until then
 *   the shown replies stay and live updates apply to them. A reset asked while
 *   a call is out waits for it and drops its answer.
 * - While a read is under way (also one that failed before its end), a pushed
 *   reply that is not shown is held aside, since the paging brings it; one
 *   shown is updated in place. When the read finishes, the replies held aside
 *   that it did not deliver are added, so no answer removes a reply that
 *   arrived after the read was sent.
 * - A record never replaces a held one with a higher `rev` (replies and root),
 *   so an answer built before a pushed edit or delete never undoes it.
 * - A failed read keeps what is shown and holds the error; `retry` goes on
 *   with the same read. The root gone from the host (`team_chat_not_found`)
 *   calls `onGone` instead.
 * - Follow: `following` is a boolean only once an answer carried one (an
 *   older host sends none, and then there is no toggle). `toggleFollow` sends
 *   the opposite once at a time; a refusal keeps the state and holds the
 *   error. An answer's `following` counts only when no follow change was sent
 *   or was out since its read was sent.
 * - `readSeq` (E59): the member's own mark for the thread from the latest
 *   answer that carried one (null from an older host). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamThreadData = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PAGE = 100;
  const MAX_REPLIES = 400;
  const NO_ANSWER = Object.freeze({ code: '', reason: 'team_chat_answer_invalid' });
  const isMessage = (m) => Boolean(m && typeof m === 'object' && typeof m.id === 'string' && Number.isSafeInteger(m.seq));
  const bySeq = (a, b) => a.seq - b.seq;
  const revOf = (m) => Number(m && m.rev) || 0;
  // `record` may replace `held`: there is none, or it is no older.
  const fresher = (record, held) => !held || revOf(record) >= revOf(held);

  // `call(method, payload)` adds the team id (the frame's writes). `onChange()` after a change an answer made.
  function createThreadData({ channelId, rootId, call, onChange, onGone }) {
    const state = { root: null, replies: [], loaded: false, capped: false, error: null,
      following: null, followBusy: false, followError: null, readSeq: null };
    let read = null; // the read under way: { pos, staged } (`staged`: the pages of a read from the start of a shown thread)
    let pos = null; // the paging position of what is shown
    let want = null; // 'fresh' or 'more': the next call owed
    let busy = false;
    let disposed = false;
    let followTurn = 0; // counts follow changes sent
    const aside = new Map(); // replies pushed while a read is under way: id -> newest record

    const isReply = (m) => isMessage(m) && m.thread_root_id === rootId;
    function tell() { if (!disposed) onChange(); }

    // Merges records into `list` by id and rev, adding new ones in seq order while there is room. Answers
    // whether anything changed.
    function mergeInto(list, records) {
      const index = new Map(list.map((m, i) => [m.id, i]));
      let changed = false;
      let added = false;
      for (const record of records) {
        if (index.has(record.id)) {
          const at = index.get(record.id);
          if (fresher(record, list[at]) && list[at] !== record) { list[at] = record; changed = true; }
          continue;
        }
        if (list.length >= MAX_REPLIES) { state.capped = true; continue; }
        list.push(record);
        index.set(record.id, list.length - 1);
        added = true;
      }
      if (added) list.sort(bySeq);
      return changed || added;
    }

    // The read is done: a read from the start replaces what is shown (a shown record with a higher rev
    // stays); the replies held aside that it did not deliver are added.
    function finish(capped) {
      if (read.staged) {
        const held = new Map(state.replies.map((m) => [m.id, m]));
        state.replies = read.staged.map((m) => (fresher(m, held.get(m.id)) ? m : held.get(m.id)));
        state.capped = false;
      }
      mergeInto(state.replies, [...aside.values()]);
      if (capped) state.capped = true;
      pos = read.pos;
      aside.clear();
      read = null;
    }

    async function pump() {
      if (busy || disposed) return;
      busy = true;
      while (want && !disposed) {
        const kind = want;
        want = null;
        if (kind === 'fresh') read = { pos: null, staged: state.loaded ? [] : null };
        else if (!read) read = { pos, staged: null };
        const turn = state.followBusy ? -1 : followTurn;
        const answer = await call('chatThread', { channel_id: channelId, root_id: rootId, ...(read.pos !== null ? { after_seq: read.pos } : {}), limit: PAGE });
        if (disposed) break;
        if (want === 'fresh') continue; // a reset came while this was out: read from the start instead
        if (!answer || !answer.ok || !isMessage(answer.root) || !Array.isArray(answer.replies)) {
          const error = answer && !answer.ok && answer.error ? answer.error : NO_ANSWER;
          want = null;
          if (error.reason === 'team_chat_not_found') { disposed = true; onGone(); break; }
          state.error = error; // the read stays: `retry` goes on with it
          tell();
          break;
        }
        state.error = null;
        if (fresher(answer.root, state.root)) state.root = answer.root;
        if (typeof answer.following === 'boolean' && turn === followTurn && !state.followBusy) state.following = answer.following;
        if (Number.isSafeInteger(answer.read_seq)) state.readSeq = answer.read_seq;
        const got = answer.replies.filter(isReply);
        if (got.length) read.pos = Math.max(read.pos || 0, ...got.map((m) => m.seq));
        const list = read.staged || state.replies;
        mergeInto(list, got);
        if (!read.staged) pos = read.pos;
        state.loaded = true;
        const full = list.length >= MAX_REPLIES;
        if (answer.has_more === true && !full && got.length) { if (!want) want = 'more'; } else finish(answer.has_more === true && full);
        tell();
      }
      busy = false;
    }

    function ask(kind) {
      if (disposed) return;
      if (kind === 'fresh' || want !== 'fresh') want = kind;
      void pump();
    }

    async function toggleFollow() {
      if (disposed || state.followBusy || typeof state.following !== 'boolean') return;
      state.followBusy = true;
      state.followError = null;
      followTurn += 1;
      tell();
      const answer = await call('chatFollow', { channel_id: channelId, root_id: rootId, on: !state.following });
      if (disposed) return;
      state.followBusy = false;
      if (answer && answer.ok) { if (typeof answer.on === 'boolean') state.following = answer.on; } else state.followError = (answer && answer.error) || NO_ANSWER;
      tell();
    }

    return {
      state,
      // From the start: when the thread opens, after a reset, back online.
      load: () => ask('fresh'),
      // What came after the paging position (your own reply settled; the follow state with it).
      more() { if (!state.capped) ask('more'); },
      // Goes on with the read that failed.
      retry() { if (disposed) return; state.error = null; tell(); ask(read ? 'more' : 'fresh'); },
      // Live records (a `messages` push). Answers whether anything shown changed; tells nothing.
      onRecords(records) {
        if (disposed || !Array.isArray(records)) return false;
        let changed = false;
        for (const record of records) if (isMessage(record) && record.id === rootId && fresher(record, state.root) && record !== state.root) { state.root = record; changed = true; }
        const replies = records.filter(isReply);
        if (!replies.length) return changed;
        if (!read) return mergeInto(state.replies, replies) || changed;
        const shown = new Map(state.replies.map((m, i) => [m.id, i]));
        for (const record of replies) {
          if (fresher(record, aside.get(record.id))) aside.set(record.id, record);
          const at = shown.get(record.id);
          if (at !== undefined && fresher(record, state.replies[at]) && state.replies[at] !== record) { state.replies[at] = record; changed = true; }
        }
        return changed;
      },
      toggleFollow,
      // A read is under way or owed (also one that failed before its end).
      reading: () => read !== null || want !== null,
      dispose() { disposed = true; want = null; },
    };
  }

  return { createThreadData };
});
