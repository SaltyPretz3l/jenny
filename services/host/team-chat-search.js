'use strict';

// `team.chat.search` on the host (row 123 slice 2a-3b, TEAM_CHAT_SPEC
// "API and realtime"). A case-insensitive substring scan over the text of the
// messages in the channels the actor can see: thread replies included,
// deleted messages left out, newest first within a channel, channels in the
// team's channel order (the team channel first, then each project channel in
// the order it was created).
//
// One call does a bounded amount of work: a 250 ms budget on the injected
// clock, started once the first channel is loaded so a cold channel's load
// does not spend it, and a 20,000-message count, both checked between
// segments, with a yield to the event loop between segments. It then answers
// what it has with `next_cursor`, null when the scan is finished. Measured at
// 50,000 messages of about 1 KB: the count binds first, 20,000 messages in
// about 150 ms. One search runs at a time on the host, first come first
// served; at most 8 wait, and a ninth answers `team_chat_rate_limit`, so the
// scan never takes more than one core however many members search.
//
// Across channels a channel the store already reports broken is passed over;
// any other failure (a transient read, a store that latched mid-scan) is
// answered, never turned into a shorter complete-looking result.
//
// The cursor is opaque to the client and fully validated on the way in: a
// closed JSON object in base64url naming the channel, the seq to continue
// before (0: from the newest) and a digest of the query and scope, so a cursor
// only continues the search that made it. The channel it names is re-checked
// for visibility on every call; one the actor can no longer see answers
// `team_chat_not_found` and reveals nothing. Positions are seqs, which edits
// never change and prunes only remove, so an edit or a prune between pages
// leaves no gap and no repeat. The query, text and excerpts never reach a log.

const crypto = require('node:crypto');

const { CHAT_CURSOR_MAX_CHARS, CHAT_CURSOR_PATTERN, hostFailure } = require('../../server/api-contract');
const { yieldToEventLoop } = require('./team-chat-loader');
const { channelKind } = require('./team-chat-schema');

const BUDGET_MS = 250;
const SCAN_MAX = 20_000;
const WAITING_MAX = 8;
const EXCERPT_MAX = 200;
const CURSOR_KEYS = ['b', 'c', 'h', 'v'];
const CURSOR_SHAPE = new RegExp(CHAT_CURSOR_PATTERN, 'u');

const invalidCursor = () => hostFailure('invalid', 'team_chat_cursor_invalid');
const notFound = () => hostFailure('forbidden', 'team_chat_not_found');

function queryDigest(query, scope) {
  return crypto.createHash('sha256').update(JSON.stringify([query.toLowerCase(), scope || null])).digest('hex')
    .slice(0, 16);
}

function encodeCursor(channelId, beforeSeq, digest) {
  return Buffer.from(JSON.stringify({ v: 1, c: channelId, b: beforeSeq, h: digest })).toString('base64url');
}

// The decoded cursor, or null when anything about it is not exactly what this
// module writes.
function decodeCursor(cursor, digest) {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > CHAT_CURSOR_MAX_CHARS
    || !CURSOR_SHAPE.test(cursor)) return null;
  let value;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (_error) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(',') !== CURSOR_KEYS.join(',')) return null;
  if (value.v !== 1 || value.h !== digest || channelKind(value.c) === null) return null;
  if (!Number.isSafeInteger(value.b) || value.b < 0) return null;
  return { channelId: value.c, beforeSeq: value.b };
}

// At most 200 UTF-16 units of `text` around the match, never splitting a
// surrogate pair. Lower-casing can change a string's length (a few scripts);
// then the excerpt starts at the beginning of the text.
function excerptOf(text, lower, index, queryLength) {
  if (text.length <= EXCERPT_MAX) return text;
  const at = lower.length === text.length ? index : 0;
  let start = Math.max(0, Math.min(at - Math.floor((EXCERPT_MAX - queryLength) / 2), text.length - EXCERPT_MAX));
  let end = start + EXCERPT_MAX;
  const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;
  if (start > 0 && isLow(text.charCodeAt(start))) start += 1;
  if (end < text.length && isLow(text.charCodeAt(end))) end -= 1;
  return text.slice(start, end);
}

// One holder at a time, first come first served, at most `waitingMax` waiting.
function createTurnstile(waitingMax) {
  let busy = false;
  const waiting = [];
  return {
    // A promise of the turn, or null when the queue is full.
    enter() {
      if (!busy) { busy = true; return Promise.resolve(); }
      if (waiting.length >= waitingMax) return null;
      return new Promise((resolve) => { waiting.push(resolve); });
    },
    leave() {
      const next = waiting.shift();
      if (next) next(); else busy = false;
    },
  };
}

function createTeamChatSearch({
  store, visible, clock = Date.now, yieldTo = yieldToEventLoop, budgetMs = BUDGET_MS, scanMax = SCAN_MAX,
} = {}) {
  if (typeof visible !== 'function') throw new TypeError('Team chat search needs the visibility rule.');
  const turnstile = createTurnstile(WAITING_MAX);

  // The channels to scan, in order (the one asked for, or every visible
  // channel), and the ones the store reports broken now, passed over unscoped.
  function channelOrder(actor, scope) {
    if (scope !== undefined) return visible(scope, actor) ? { ok: true, order: [scope], broken: new Set() } : notFound();
    const listed = store.listChannels();
    if (!listed.ok) return listed;
    const shown = listed.channels.filter((info) => visible(info.channel_id, actor));
    return { ok: true, order: shown.map((info) => info.channel_id),
      broken: new Set(shown.filter((info) => info.broken).map((info) => info.channel_id)) };
  }

  async function scan({ params, actor }, start, digest) {
    const scope = params.channel_id;
    const needle = params.query.toLowerCase();
    // Re-checked on every call: a channel the actor can no longer see reveals nothing.
    if (start.channelId !== null && !visible(start.channelId, actor)) return notFound();
    const planned = channelOrder(actor, scope);
    if (!planned.ok) return planned;
    const { order, broken } = planned;
    let index = start.channelId === null ? 0 : order.indexOf(start.channelId);
    if (index < 0) return notFound();

    let deadline = null;
    const matches = [];
    let scanned = 0;
    let beforeSeq = start.beforeSeq;
    const spent = () => scanned >= scanMax || clock() >= deadline;
    const pause = (channelId, seq) => ({ ok: true, matches, next_cursor: encodeCursor(channelId, seq, digest) });
    while (index < order.length) {
      const channelId = order[index];
      if (!broken.has(channelId)) {
        await store.ensureLoaded(channelId);
        if (deadline === null) deadline = clock() + budgetMs;
        for (;;) {
          const segment = store.segmentBefore(channelId, beforeSeq);
          if (!segment.ok) return segment;
          for (const message of segment.messages) {
            scanned += 1;
            const lower = message.text.toLowerCase();
            const at = lower.indexOf(needle);
            if (at < 0) continue;
            matches.push({ channel_id: channelId, message_id: message.id, seq: message.seq, root_id: message.root_id,
              author: message.author, created_at: message.created_at,
              excerpt: excerptOf(message.text, lower, at, needle.length) });
            if (matches.length === params.limit) return pause(channelId, message.seq);
          }
          if (segment.next === null) break;
          beforeSeq = segment.next;
          if (spent()) return pause(channelId, beforeSeq);
          await yieldTo();
        }
      }
      index += 1;
      beforeSeq = 0;
      if (index < order.length && deadline !== null && spent()) return pause(order[index], 0);
    }
    return { ok: true, matches, next_cursor: null };
  }

  async function search({ params, actor }) {
    const digest = queryDigest(params.query, params.channel_id);
    let start = { channelId: null, beforeSeq: 0 };
    if (params.cursor !== undefined) {
      const decoded = decodeCursor(params.cursor, digest);
      if (!decoded || (params.channel_id !== undefined && decoded.channelId !== params.channel_id)) {
        return invalidCursor();
      }
      start = decoded;
    }
    const turn = turnstile.enter();
    if (turn === null) return hostFailure('limit', 'team_chat_rate_limit');
    await turn;
    try {
      return await scan({ params, actor }, start, digest);
    } finally {
      turnstile.leave();
    }
  }

  return Object.freeze({ search });
}

module.exports = { createTeamChatSearch, encodeCursor, queryDigest };
