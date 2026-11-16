'use strict';

// The read coalescer of one team's chat client (slice 2a-4c; TEAM_CHAT_SPEC
// "Unread, receipts and presence": mark_read throttled to once per 2 s). Per
// channel, the first read goes at once and opens a window of READ_WINDOW_MS;
// reads asked for inside the window are held as one, the highest seq wins, and
// the held read is sent when the window ends (opening the next window); a
// window that ends with nothing held closes. A read with `unread: true` is
// never held for the window, and a held read is dropped and answered with its
// answer, so a held seq never raises the read position past an explicit "mark
// unread from here". Sends of one channel run one at a time, in call order: a
// mark-unread waits for that channel's send in flight, so the two answers
// cannot land out of order in the cache. Every held caller is answered with the
// answer of the send that carried its read. Timers are injected, unref'd and
// cleared by `clear`, which answers every held caller and closes the
// coalescer: a request after it (a call that was awaiting the first load when
// the client stopped) gets the same answer and opens nothing. The tables hold
// one entry per channel with an open window or a send in flight, and the
// client only reads channels its cache lists.

const READ_WINDOW_MS = 2000;

function createReadCoalescer({ send, timers, windowMs = READ_WINDOW_MS, failure }) {
  // channel id -> { timer, held: { seq, waiters } | null }
  const windows = new Map();
  // channel id -> the promise of its last send, settled (never rejects)
  const tails = new Map();
  let closed = null;
  const answerAll = (waiters, answer) => { for (const resolve of waiters) resolve(answer); };

  // One send, after the channel's send in flight; a throw answers `failure`.
  function sendInOrder(channelId, seq, unread) {
    const run = (tails.get(channelId) || Promise.resolve())
      .then(() => send(channelId, seq, unread)).catch(() => failure);
    tails.set(channelId, run);
    void run.then(() => { if (tails.get(channelId) === run) tails.delete(channelId); });
    return run;
  }

  function arm(channelId, entry) {
    entry.timer = timers.setTimeout(() => flush(channelId), windowMs);
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
  }

  function flush(channelId) {
    const entry = windows.get(channelId);
    if (!entry) return;
    entry.timer = null;
    if (!entry.held) { windows.delete(channelId); return; }
    const { seq, waiters } = entry.held;
    entry.held = null;
    arm(channelId, entry);
    void sendInOrder(channelId, seq, false).then((answer) => answerAll(waiters, answer));
  }

  return {
    /** Reads `seq` in `channelId`: a promise of the answer of the send that carried it. */
    async request(channelId, seq, unread) {
      if (closed) return closed;
      const entry = windows.get(channelId);
      if (unread) {
        const waiters = entry?.held?.waiters || [];
        if (entry) entry.held = null;
        const answer = await sendInOrder(channelId, seq, true);
        answerAll(waiters, answer);
        return answer;
      }
      if (!entry) {
        const opened = { timer: null, held: null };
        windows.set(channelId, opened);
        arm(channelId, opened);
        return sendInOrder(channelId, seq, false);
      }
      if (!entry.held) entry.held = { seq, waiters: [] };
      else entry.held.seq = Math.max(entry.held.seq, seq);
      const { waiters } = entry.held;
      return new Promise((resolve) => { waiters.push(resolve); });
    },

    /** Clears every window and timer, answers each held caller `answer` and closes: later requests get `answer`. */
    clear(answer) {
      closed = answer;
      for (const entry of windows.values()) {
        if (entry.timer !== null) timers.clearTimeout(entry.timer);
        if (entry.held) answerAll(entry.held.waiters, answer);
      }
      windows.clear();
      tails.clear();
    },

    size: () => windows.size,
  };
}

module.exports = { READ_WINDOW_MS, createReadCoalescer };
