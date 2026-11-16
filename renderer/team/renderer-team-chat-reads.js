/* The read marks of the team chat store (moved out of renderer-team-chat-store.js in row 123 slice E59). Pure
 * state and timers; no DOM.
 *
 * - A channel's read mark is paced per channel: at most one every 2 s, the latest position at the end of the
 *   window, never two in flight, and none for 10 s after a refusal (the host's mutation limit is shared with
 *   edits). Mark unread resets the pacing, so the next read mark goes at once.
 * - A thread's own mark (E59) is paced the same way, per thread, on its own table: it never waits for a channel
 *   mark. It is asked while the channel row lists the thread with unseen replies, or while the thread's own page
 *   says its newest reply lies past the member's mark (`readSeq`: the row lists at most 20 threads). A host
 *   without thread counts lists none and sends no mark, so nothing is sent to it; main clears the thread's count
 *   when the host answers, and the row's push redraws the link.
 * - `threadCounts(record)`: the one reading of a channel row's thread list (root id -> unseen replies), for the
 *   store, the timeline and the thread column.
 *
 * `api` is the store's: { send(method, payload), channel(teamId, channelId), stateOf(teamId), notify(change), noAnswer }.
 * Each team state holds `reads` (channel id -> pacing) and `threadReads` (channel id + ' ' + root id -> pacing). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamChatReads = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const READ_EVERY_MS = 2_000;
  const RETRY_MS = 10_000;

  const pacing = () => ({ want: 0, sent: 0, nextAt: 0, busy: false, timer: null });

  // A channel row's followed threads with unseen replies: root id -> count (a malformed item is left out).
  function threadCounts(record) {
    return new Map((record && Array.isArray(record.threads) ? record.threads : [])
      .filter((thread) => thread && typeof thread.root_id === 'string' && Number.isSafeInteger(thread.unread) && thread.unread > 0)
      .map((thread) => [thread.root_id, thread.unread]));
  }
  const threadUnread = (record, rootId) => threadCounts(record).get(rootId) || 0;

  function createChatReads(api) {
    // One paced table: `held()` the position already held, `wanted()` whether to send at all, `payload(seq)` the
    // call, and for a channel mark `answered(answer)` after an ok answer.
    function pace(teamId, state, table, key, read, spec) {
      if (read.busy || read.timer || !read.want) return;
      const wait = read.nextAt - Date.now();
      if (wait > 0) {
        read.timer = setTimeout(() => { read.timer = null; if (api.stateOf(teamId) === state) pace(teamId, state, table, key, read, spec); }, wait);
        return;
      }
      void sendPaced(teamId, state, table, key, read, spec);
    }

    async function sendPaced(teamId, state, table, key, read, spec) {
      const seq = read.want;
      read.want = 0;
      if (!spec.wanted() || seq <= Math.max(spec.held(), read.sent)) return;
      const before = read.sent;
      read.sent = seq;
      read.busy = true;
      read.nextAt = Date.now() + READ_EVERY_MS;
      const answer = await api.send('chatMarkRead', spec.payload(seq));
      read.busy = false;
      if (api.stateOf(teamId) !== state) return;
      if (!answer.ok) {
        read.sent = before;
        read.want = Math.max(read.want, seq);
        read.nextAt = Date.now() + RETRY_MS;
      } else if (spec.answered) {
        spec.answered(answer);
      }
      pace(teamId, state, table, key, read, spec);
    }

    function ask(teamId, state, table, key, seq, spec) {
      if (!table.has(key)) table.set(key, pacing());
      const read = table.get(key);
      if (seq <= Math.max(spec.held(), read.sent, read.want)) return;
      read.want = seq;
      pace(teamId, state, table, key, read, spec);
    }

    // Raises the channel's read position, paced per channel.
    function markRead(teamId, channelId, seq) {
      const state = api.stateOf(teamId);
      if (!state || !api.channel(teamId, channelId) || !Number.isSafeInteger(seq) || seq <= 0) return;
      ask(teamId, state, state.reads, channelId, seq, {
        held: () => (api.channel(teamId, channelId) || {}).last_read_seq || 0,
        wanted: () => Boolean(api.channel(teamId, channelId)),
        payload: (value) => ({ team_id: teamId, channel_id: channelId, seq: value }),
        answered(answer) {
          const now = api.channel(teamId, channelId);
          if (now && Number.isSafeInteger(answer.last_read_seq) && answer.last_read_seq > (now.last_read_seq || 0)) {
            now.last_read_seq = answer.last_read_seq;
            api.notify({ team_id: teamId, type: 'channels' });
          }
        },
      });
    }

    // Raises a followed thread's own mark to `seq` (its newest reply shown), paced per thread: while the channel
    // row lists unseen replies for it, or past `readSeq`, the member's mark as the thread's own page gave it (null
    // from a host that sends none).
    function markThreadRead(teamId, channelId, rootId, seq, readSeq = null) {
      const state = api.stateOf(teamId);
      const mark = Number.isSafeInteger(readSeq) ? readSeq : null;
      const wanted = () => mark !== null || threadUnread(api.channel(teamId, channelId), rootId) > 0;
      if (!state || typeof rootId !== 'string' || !wanted() || !Number.isSafeInteger(seq) || seq <= 0) return;
      ask(teamId, state, state.threadReads, channelId + ' ' + rootId, seq, {
        held: () => mark || 0,
        wanted,
        payload: (value) => ({ team_id: teamId, channel_id: channelId, seq: value, thread_root_id: rootId }),
      });
    }

    // Marks the channel unread from `seq` (the host reads to seq - 1); resets the pacing, so the next read mark goes at once.
    async function markUnread(teamId, channelId, seq) {
      const state = api.stateOf(teamId);
      if (!state || !api.channel(teamId, channelId) || !Number.isSafeInteger(seq) || seq <= 0) return { ok: false, error: api.noAnswer };
      const read = state.reads.get(channelId);
      if (read) { clearTimeout(read.timer); Object.assign(read, { want: 0, sent: 0, nextAt: 0, timer: null }); }
      const answer = await api.send('chatMarkRead', { team_id: teamId, channel_id: channelId, seq, unread: true });
      const record = api.channel(teamId, channelId);
      if (answer.ok && record && api.stateOf(teamId) === state && Number.isSafeInteger(answer.last_read_seq)) {
        record.last_read_seq = answer.last_read_seq;
        api.notify({ team_id: teamId, type: 'channels' });
      }
      return answer;
    }

    // Stops every pending read timer of a team being dropped.
    function stop(state) {
      for (const read of state.reads.values()) clearTimeout(read.timer);
      for (const read of state.threadReads.values()) clearTimeout(read.timer);
    }

    return { markRead, markThreadRead, markUnread, stop, threadCounts, threadUnread };
  }

  return { createChatReads };
});
