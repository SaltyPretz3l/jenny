'use strict';

// One team's chat drafts and outbox on this PC (slice 2a-4b), kept in
// client.json's chat part (client-file.js `loadChatState` / `saveChatState`).
// Only text the user wrote here; nothing of the team's history. Drafts are
// written behind a short timer (a keystroke never costs a write) and flushed on
// close; the outbox is written at once, because an entry the user was told is
// queued must survive a crash. A file that did not load is never written (fail
// closed): drafts and outbox then refuse. Entries the file held that failed
// their checks were dropped on load (client-file.js); one WARN says how many.
// `purge` empties both on disk and stops every later write; `kill` stops writes
// without flushing (the team's directory is about to be removed). Logs carry the
// team id and a fixed reason or counts only.

const { loadChatState, saveChatState } = require('./client-file');
const { DRAFTS_MAX, draftKey } = require('./chat-shapes');

const DRAFT_WRITE_DELAY_MS = 1000;

function createChatLocalStore({
  userDataPath, teamId, timers = { setTimeout, clearTimeout }, now = Date.now, log = () => {},
  writeDelayMs = DRAFT_WRITE_DELAY_MS,
}) {
  const drafts = new Map();
  let outbox = [];
  let writable = false;
  let dead = false;
  let timer = null;
  const say = (event, fields) => { try { log('WARN', event, { team_id: teamId, ...fields }); } catch { /* best effort */ } };

  const loaded = loadChatState(userDataPath, teamId);
  if (loaded.ok) {
    writable = true;
    for (const entry of loaded.drafts) drafts.set(draftKey(entry.channel_id, entry.thread_root_id), entry);
    outbox = loaded.outbox.map((entry) => ({ ...entry }));
    const { drafts: droppedDrafts, outbox: droppedOutbox } = loaded.dropped;
    if (droppedDrafts > 0 || droppedOutbox > 0) {
      say('team.chat.state_entries_dropped', { drafts: droppedDrafts, outbox: droppedOutbox });
    }
  } else if (loaded.reason !== 'team_client_missing') {
    say('team.chat.state_unreadable', { reason: loaded.reason });
  }

  function cancelTimer() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  function write() {
    cancelTimer();
    if (dead || !writable) return { ok: false, reason: 'team_client_invalid' };
    const saved = saveChatState(userDataPath, teamId, { drafts: [...drafts.values()], outbox });
    if (!saved.ok) say('team.chat.state_write_failed', { reason: saved.reason });
    return saved;
  }

  function scheduleWrite() {
    if (timer !== null) return;
    timer = timers.setTimeout(() => { timer = null; write(); }, writeDelayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return {
    getDraft(channelId, rootId = null) {
      return drafts.get(draftKey(channelId, rootId))?.text || '';
    },

    /** Sets (or, with '', clears) one draft: { ok } or { ok: false, reason }. The text is checked by the caller. */
    setDraft(channelId, rootId, text) {
      if (dead || !writable) return { ok: false, reason: 'team_client_invalid' };
      const key = draftKey(channelId, rootId);
      if (text === '') {
        if (drafts.delete(key)) scheduleWrite();
        return { ok: true };
      }
      if (!drafts.has(key) && drafts.size >= DRAFTS_MAX) return { ok: false, reason: 'team_chat_draft_limit' };
      drafts.set(key, { channel_id: channelId, thread_root_id: rootId || null, text,
        updated_at: new Date(now()).toISOString() });
      scheduleWrite();
      return { ok: true };
    },

    outbox: () => outbox.map((entry) => ({ ...entry })),

    /** Replaces the stored outbox and writes the file now: { ok } or { ok: false, reason }. */
    saveOutbox(entries) {
      if (dead || !writable) return { ok: false, reason: 'team_client_invalid' };
      const previous = outbox;
      outbox = entries.map((entry) => ({ ...entry }));
      const saved = write();
      if (!saved.ok) outbox = previous;
      return saved;
    },

    flush() { if (timer !== null) write(); },

    /** Empties drafts and outbox on disk (when the file still loads) and stops every later write. */
    purge() {
      cancelTimer();
      const had = drafts.size > 0 || outbox.length > 0;
      drafts.clear();
      outbox = [];
      if (had && writable && !dead) write();
      dead = true;
    },

    /** Flushes pending drafts and stops writing. */
    close() {
      if (!dead) this.flush();
      cancelTimer();
      dead = true;
    },

    /** Stops writing at once, without a flush (the team's files are being removed). */
    kill() {
      cancelTimer();
      drafts.clear();
      outbox = [];
      dead = true;
    },
  };
}

module.exports = { DRAFT_WRITE_DELAY_MS, createChatLocalStore };
