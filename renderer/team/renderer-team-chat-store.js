/* The team chat store, one per window: each connected team's channel list, the
 * timeline messages of the channels opened here, the outbox and the members
 * with their presence; it follows the one `team.onChat` push channel while
 * held. Pure state: no DOM. The tab's gate loads it after first paint, only
 * while the `team` flag is on and this Jenny is a member of at least one team.
 *
 * Rules the readers rely on:
 * - `sync(teams)` asks `chatOverview` once for each team that is connected.
 *   A pending, revoked or update-required team is never asked, and what was
 *   held for it is dropped, as is a team that left; its pushes are ignored.
 * - A push is newer than an overview asked for before it: a full list
 *   replaces that part of the answer, a partial one is merged over it.
 * - A channel's timeline is a window of at most what the page holds, held only
 *   while a timeline shows it (`openChannel` to `closeChannel`): thread
 *   replies are left out, `trim` drops the oldest or the newest, and with the
 *   newest dropped a later message waits for `loadNewer` or `openChannel`. A
 *   jump opens a window around a seq; only the latest open counts (an earlier
 *   one answers `superseded`). A read toward the newest never claims a seq it
 *   could not have covered: a message pushed meanwhile is read later.
 * - Read marks are paced per channel (and, E59, per thread) in
 *   renderer-team-chat-reads.js: at most one every 2 s, the latest position at
 *   the end of the window, never two in flight, none for 10 s after a refusal.
 * - Typing: one entry per member of the team and channel, gone 6 s after its
 *   last push, under one timer for the window; dropped with its team, on
 *   `closeChannel` and on `dispose`. A thread's typing is kept the same way,
 *   only for a thread a column watches, and goes when it stops watching.
 * - A `messages` change carries the pushed records and an `outbox` change the
 *   settled answers, so a thread column can follow its replies.
 * - A post that settled before its message arrived stays listed as landing
 *   (with its message id) until the message is here, at most a minute, so the
 *   timeline draws it once in either push order.
 * - Row 173: a custom channel's row carries its `name`, `topic`, `created_by`, `archived_by` and `changes`; `nameOf` finds a
 *   channel's name in any held team, and `manageChannel` sends the four channel operations (create, update, archive and
 *   delete are online only: the answer is the host's, the new rows arrive on the channel push).
 * - Every bridge call goes through the team store's bounded `call`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-store'), require('./renderer-team-chat-reads'));
    return;
  }
  root.rendererTeamChatStore = factory(root.rendererTeamStore, root.rendererTeamChatReads);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (teamStore, chatReads) {
  'use strict';

  const CHANNEL_TEAM = 'chan_team';
  // The team states that lock a member out: nothing is asked or drawn for them (the Team tab shares it).
  const LOCKED_STATES = Object.freeze(new Set(['pending', 'revoked', 'update_required', 'needs_repair', 'force_local']));
  const OLDER_PAGE = 50;
  const RETRY_MS = 10_000;
  const NOTIFY_LEVELS = new Set(['all', 'mentions', 'none']);
  const CHANNEL_CALLS = new Set(['chatChannelCreate', 'chatChannelUpdate', 'chatChannelArchive', 'chatChannelDelete']);
  const TYPING_MS = 6_000;
  const LANDING_MS = 60_000;
  const SETTLED_KEEP = 100;

  // A name inside a sentence keeps its own direction (U+2068 FIRST STRONG ISOLATE ... U+2069).
  function isolate(name) { return '\u2068' + String(name ?? '') + '\u2069'; }

  function createChatStore() {
    const send = (method, payload) => teamStore.getTeamStore().call(method, payload);
    const teams = new Map();
    const listeners = new Set();
    let tracked = new Set();
    let unsubscribe = null;
    let holders = 0;
    let generation = 0; // a release from before `dispose` is a no-op
    let typingTimer = null;
    // A typing key: the channel, or `channel|root` for a thread (ids hold no '|').
    const typingKey = (channelId, rootId) => (rootId ? channelId + '|' + rootId : channelId);

    function bridge() { const w = typeof window !== 'undefined' ? window : null; return (w && w.jennyShell && w.jennyShell.team) || null; }
    function notify(change) { for (const fn of [...listeners]) { try { fn(change); } catch (_error) { /* one reader must not stop the others */ } } }
    const reads = chatReads.createChatReads({ send, channel: (teamId, channelId) => channel(teamId, channelId),
      stateOf: (teamId) => stateOf(teamId), notify, noAnswer: teamStore.NO_ANSWER });
    const { markRead, markThreadRead, markUnread } = reads;

    // `partials`: channel records pushed partially while the overview is out, merged over its answer.
    // `typing`: typing key -> member -> expiry; `threads`: the typing keys of watched threads; `landing`: entry id -> a settled post not yet drawn as its
    // message; `settled`: the message ids of posts settled here (a queued post never claims one of them).
    function fresh() {
      return { loaded: false, loading: false, retryAt: 0, error: null, channels: [], outbox: [], members: null, reactionEmoji: null,
        timelines: new Map(), reads: new Map(), threadReads: new Map(), partials: new Map(), pushes: { channels: 0, members: 0, outbox: 0 },
        typing: new Map(), threads: new Set(), landing: new Map(), settled: new Set() };
    }
    function stateOf(teamId) { return teams.get(teamId) || null; }
    function ensure(teamId) { if (!teams.has(teamId)) teams.set(teamId, fresh()); return teams.get(teamId); }
    // Forgets a team, with its pending read marks.
    function drop(teamId) {
      const state = stateOf(teamId);
      if (!state) return false;
      reads.stop(state);
      teams.delete(teamId);
      armTyping();
      return true;
    }

    // ---------------------------------------------------------------- typing

    // One timer for every team: it runs at the earliest expiry, drops what expired and tells.
    function armTyping() {
      clearTimeout(typingTimer);
      typingTimer = null;
      let next = Infinity;
      for (const state of teams.values()) for (const who of state.typing.values()) for (const at of who.values()) next = Math.min(next, at);
      if (next === Infinity) return;
      typingTimer = setTimeout(expireTyping, Math.max(0, next - Date.now()));
    }
    function expireTyping() {
      typingTimer = null;
      const now = Date.now();
      for (const [teamId, state] of teams) {
        for (const [key, who] of state.typing) {
          let gone = false;
          for (const [memberId, at] of who) if (at <= now) { who.delete(memberId); gone = true; }
          if (!who.size) state.typing.delete(key);
          const [channelId, rootId = null] = key.split('|');
          if (gone) notify({ team_id: teamId, type: 'typing', channel_id: channelId, thread_root_id: rootId });
        }
      }
      armTyping();
    }
    // A member of the team typing in a channel, or in a thread a column watches (never someone not in the
    // member list). Only for a channel open in this window; a refresh of someone already listed only moves
    // their expiry.
    function onTyping(teamId, state, payload) {
      const { channel_id: channelId, member_id: memberId } = payload;
      const rootId = typeof payload.thread_root_id === 'string' ? payload.thread_root_id : null;
      const key = typeof channelId === 'string' ? typingKey(channelId, rootId) : '';
      if (!key || !state.timelines.has(channelId) || (rootId && !state.threads.has(key))
        || !(state.members || []).some((m) => m.member_id === memberId)) return;
      if (!state.typing.has(key)) state.typing.set(key, new Map());
      const listed = state.typing.get(key);
      const known = listed.has(memberId);
      listed.set(memberId, Date.now() + TYPING_MS);
      armTyping();
      if (!known) notify({ team_id: teamId, type: 'typing', channel_id: channelId, thread_root_id: rootId });
    }

    // A thread column shows a thread: its typing is kept until the answer is called.
    function watchThread(teamId, channelId, rootId) {
      const state = stateOf(teamId);
      const key = typingKey(channelId, rootId);
      if (!state) return () => {};
      state.threads.add(key);
      return function unwatch() {
        state.threads.delete(key);
        if (state.typing.delete(key)) armTyping();
      };
    }

    // ---------------------------------------------------------------- outbox

    // A settled post keeps its row (with its message id) until the message is here, at most a minute. Answers the
    // settled items, each with its entry's `thread_root_id` (a thread column reads once more when its reply settles).
    function onOutbox(state, payload) {
      const now = Date.now();
      const settled = [];
      const find = (list, id) => list.find((e) => e && e.entry_id === id) || null;
      for (const done of Array.isArray(payload.settled) ? payload.settled : []) {
        if (!done || typeof done !== 'object') continue;
        const known = find(state.outbox, done.entry_id);
        const entry = known || find(payload.outbox, done.entry_id);
        settled.push(entry && entry.thread_root_id ? { ...done, thread_root_id: entry.thread_root_id } : done);
        if (done.ok !== true || typeof done.message_id !== 'string') continue;
        if (known && known.operation === 'post') state.landing.set(known.entry_id, { ...known, state: 'queued', message_id: done.message_id, landedAt: now });
        state.settled.add(done.message_id);
        if (state.settled.size > SETTLED_KEEP) state.settled.delete(state.settled.values().next().value);
      }
      for (const [id, entry] of state.landing) if (now - entry.landedAt > LANDING_MS) state.landing.delete(id);
      state.outbox = payload.outbox.slice();
      return settled;
    }
    function landed(state, records) {
      const ids = new Set(records.map((m) => m && m.id));
      for (const [id, entry] of state.landing) if (ids.has(entry.message_id)) state.landing.delete(id);
    }

    // ------------------------------------------------------------- timelines

    function lastSeqOf(teamId, channelId) { return (channel(teamId, channelId) || {}).last_seq || 0; }
    // What a read toward the newest covered: up to `limit`, not past what existed when it was sent (the channel's
    // last_seq then, or the answer's newest seq), never below `from`; the newest are held once that is last_seq.
    function setNewer(teamId, channelId, line, [from, limit, sent], messages) {
      const top = messages.reduce((max, m) => (m && Number.isSafeInteger(m.seq) ? Math.max(max, m.seq) : max), 0);
      line.newerAt = Math.max(from, Math.min(limit, Math.max(sent, top)));
      line.hasNewer = line.newerAt < lastSeqOf(teamId, channelId);
    }
    function emptyTimeline() { return { list: [], hasMore: false, hasNewer: false, newerAt: 0, floorSeq: 0, loaded: false, older: false, newer: false, olderRetryAt: 0, error: null, turn: 0 }; }
    function timelineOf(state, channelId) {
      if (!state.timelines.has(channelId)) state.timelines.set(channelId, emptyTimeline());
      return state.timelines.get(channelId);
    }
    const isTimelineMessage = (m) => m && typeof m === 'object' && typeof m.id === 'string' && Number.isSafeInteger(m.seq) && !m.thread_root_id;
    const bySeq = (a, b) => a.seq - b.seq;
    const revOf = (m) => Number(m && m.rev) || 0; // a record never replaces one with a higher rev

    // Changed records into a held window: in place by id, new ones only inside or just past it.
    function mergeMessages(line, records) {
      const index = new Map(line.list.map((m, i) => [m.id, i]));
      const top = line.list.length ? line.list[line.list.length - 1].seq : 0;
      const bottom = line.list.length ? line.list[0].seq : 0;
      let added = false;
      for (const record of records.filter(isTimelineMessage)) {
        if (index.has(record.id)) { if (revOf(record) >= revOf(line.list[index.get(record.id)])) line.list[index.get(record.id)] = record; continue; }
        if (line.hasNewer && record.seq > top) continue;
        if (line.list.length && record.seq < bottom && line.hasMore) continue;
        line.list.push(record);
        index.set(record.id, line.list.length - 1);
        added = true;
      }
      if (added) line.list.sort(bySeq);
    }

    // ----------------------------------------------------------------- reads

    async function loadOverview(teamId) {
      const state = ensure(teamId);
      state.loading = true;
      state.partials.clear();
      const asked = { ...state.pushes };
      const answer = await send('chatOverview', { team_id: teamId });
      if (stateOf(teamId) !== state) return;
      state.loading = false;
      if (!answer.ok) {
        state.error = answer.error || teamStore.NO_ANSWER;
        state.retryAt = Date.now() + RETRY_MS;
        notify({ team_id: teamId, type: 'team' });
        return;
      }
      state.error = null;
      state.loaded = true;
      if (Array.isArray(answer.channels) && asked.channels === state.pushes.channels) {
        state.channels = answer.channels.slice();
        mergeChannels(state, [...state.partials.values()], true);
      }
      state.partials.clear();
      if (Array.isArray(answer.members) && asked.members === state.pushes.members) state.members = answer.members.slice();
      if (Array.isArray(answer.reaction_emoji)) state.reactionEmoji = answer.reaction_emoji.filter((e) => typeof e === 'string' && e);
      if (Array.isArray(answer.outbox) && asked.outbox === state.pushes.outbox) state.outbox = answer.outbox.slice();
      notify({ team_id: teamId, type: 'team' });
    }

    // The teams the team store knows. Connected ones are asked once; locked-out and gone ones are dropped.
    function sync(list) {
      const next = new Set();
      for (const team of Array.isArray(list) ? list : []) {
        if (!team || typeof team.team_id !== 'string' || LOCKED_STATES.has(team.state)) continue;
        next.add(team.team_id);
        const state = stateOf(team.team_id);
        if (team.state !== 'online' || (state && (state.loaded || state.loading))) continue;
        if (state && state.retryAt && Date.now() < state.retryAt) continue;
        void loadOverview(team.team_id);
      }
      tracked = next;
      for (const id of [...teams.keys()]) {
        if (next.has(id)) continue;
        drop(id);
        notify({ team_id: id, type: 'cleared' });
      }
    }

    // Asks a failed overview again now (the timeline's Try again).
    function retryOverview(teamId) {
      const state = stateOf(teamId);
      if (!state || state.loaded || state.loading || !tracked.has(teamId)) return;
      state.retryAt = 0;
      void loadOverview(teamId);
    }

    // Opens a channel: the latest page (main's cache), or the window around `aroundSeq` (a jump; a failed one changes
    // nothing). Replaces the window held here; the first notify clears a shown error row.
    async function openChannel(teamId, channelId, aroundSeq = 0) {
      const state = stateOf(teamId);
      if (!state) return { ok: false, error: teamStore.NO_ANSWER };
      const line = timelineOf(state, channelId);
      const around = Number.isSafeInteger(aroundSeq) && aroundSeq > 0;
      const turn = ++line.turn;
      if (!around) { line.error = null; notify({ team_id: teamId, type: 'timeline', channel_id: channelId }); }
      const sent = lastSeqOf(teamId, channelId);
      const answer = await send('chatHistory', around ? { team_id: teamId, channel_id: channelId, before_seq: aroundSeq + 51, limit: 100 } : { team_id: teamId, channel_id: channelId });
      if (stateOf(teamId) !== state || state.timelines.get(channelId) !== line || line.turn !== turn) return { ...answer, superseded: true };
      if (around && !(answer.ok && Array.isArray(answer.messages))) return answer;
      if (answer.ok && Array.isArray(answer.messages)) {
        // A push that landed while this read was out is newer: a held higher rev stays, as does a held seq past the answer.
        const held = new Map(line.list.map((m) => [m.id, m]));
        const list = answer.messages.filter(isTimelineMessage).map((m) => (held.has(m.id) && revOf(held.get(m.id)) > revOf(m) ? held.get(m.id) : m));
        const top = list.reduce((max, m) => Math.max(max, m.seq), 0);
        const ids = new Set(list.map((m) => m.id));
        if (around) setNewer(teamId, channelId, line, [aroundSeq, aroundSeq + 50, sent], answer.messages); else line.hasNewer = false;
        if (!line.hasNewer) for (const m of line.list) if (m.seq > top && !ids.has(m.id)) list.push(m);
        line.list = list.sort(bySeq);
        line.hasMore = answer.has_more === true;
        line.loaded = true;
      } else {
        line.error = answer.ok ? teamStore.NO_ANSWER : (answer.error || teamStore.NO_ANSWER);
      }
      notify({ team_id: teamId, type: 'timeline', channel_id: channelId, reset: true });
      return answer;
    }

    // Stops holding a channel's window (its timeline is gone); its pushes are then ignored here.
    function closeChannel(teamId, channelId) {
      const state = stateOf(teamId);
      if (!state) return;
      state.timelines.delete(channelId);
      let gone = false;
      for (const key of [...state.typing.keys()]) if (key === channelId || key.startsWith(channelId + '|')) { state.typing.delete(key); gone = true; }
      if (gone) armTyping();
    }

    // One older page before the oldest held message; not again for 10 s after a failed one.
    async function loadOlder(teamId, channelId, limit = OLDER_PAGE) {
      const state = stateOf(teamId);
      const line = state && state.timelines.get(channelId);
      if (!line || line.older || !line.hasMore || !line.list.length || Date.now() < line.olderRetryAt) return null;
      line.older = true;
      const before = line.list[0].seq;
      const turn = line.turn;
      const answer = await send('chatHistory', { team_id: teamId, channel_id: channelId, before_seq: before, limit });
      if (stateOf(teamId) !== state || state.timelines.get(channelId) !== line) return answer;
      line.older = false;
      if (line.turn !== turn) return answer; // the window was opened again meanwhile
      if (!answer.ok || !Array.isArray(answer.messages)) {
        line.error = answer.ok ? teamStore.NO_ANSWER : (answer.error || teamStore.NO_ANSWER);
        line.olderRetryAt = Date.now() + RETRY_MS;
        notify({ team_id: teamId, type: 'timeline', channel_id: channelId });
        return answer;
      }
      const held = new Set(line.list.map((m) => m.id));
      const older = answer.messages.filter((m) => isTimelineMessage(m) && m.seq < before && !held.has(m.id)).sort(bySeq);
      line.list = older.concat(line.list);
      line.error = null;
      line.hasMore = answer.has_more === true && older.length > 0; // an ok page that adds nothing is the end
      if (Number.isSafeInteger(answer.floor_seq)) line.floorSeq = answer.floor_seq;
      notify({ team_id: teamId, type: 'timeline', channel_id: channelId, older: older.map((m) => m.id) });
      return answer;
    }

    // One newer page while the window lacks the newest: the 50 seqs past `newerAt`, one in flight; not for 10 s after a failure.
    async function loadNewer(teamId, channelId) {
      const state = stateOf(teamId);
      const line = state && state.timelines.get(channelId);
      if (!line || line.newer || !line.hasNewer || Date.now() < line.olderRetryAt) return null;
      line.newer = true;
      const { turn, newerAt: from } = line;
      const sent = lastSeqOf(teamId, channelId);
      const answer = await send('chatHistory', { team_id: teamId, channel_id: channelId, before_seq: from + 51, limit: OLDER_PAGE });
      if (stateOf(teamId) !== state || state.timelines.get(channelId) !== line) return answer;
      line.newer = false;
      if (line.turn !== turn || line.newerAt !== from) return answer; // opened again, or the newest trimmed meanwhile
      if (!answer.ok || !Array.isArray(answer.messages)) {
        line.error = answer.ok ? teamStore.NO_ANSWER : (answer.error || teamStore.NO_ANSWER);
        line.olderRetryAt = Date.now() + RETRY_MS;
        notify({ team_id: teamId, type: 'timeline', channel_id: channelId });
        return answer;
      }
      const top = line.list.length ? line.list[line.list.length - 1].seq : 0;
      const held = new Set(line.list.map((m) => m.id));
      const newer = answer.messages.filter((m) => isTimelineMessage(m) && m.seq > top && !held.has(m.id)).sort(bySeq);
      line.list = line.list.concat(newer);
      setNewer(teamId, channelId, line, [from, from + OLDER_PAGE, sent], answer.messages);
      line.error = null;
      notify({ team_id: teamId, type: 'timeline', channel_id: channelId, newer: newer.map((m) => m.id) });
      return answer;
    }

    // Keeps `keep` messages, dropping from the oldest or the newest end.
    function trim(teamId, channelId, end, keep) {
      const state = stateOf(teamId);
      const line = state && state.timelines.get(channelId);
      if (!line || line.list.length <= keep) return false;
      if (end === 'newest') { line.list = line.list.slice(0, keep); line.hasNewer = true; line.newerAt = line.list[keep - 1].seq; } else { line.list = line.list.slice(-keep); line.hasMore = true; }
      return true;
    }

    async function setNotify(teamId, channelId, level) {
      if (!NOTIFY_LEVELS.has(level) || !channel(teamId, channelId)) return { ok: false, error: teamStore.NO_ANSWER };
      const answer = await send('chatSetNotify', { team_id: teamId, channel_id: channelId, level });
      const record = channel(teamId, channelId);
      if (answer.ok && record && NOTIFY_LEVELS.has(answer.level)) {
        record.notify = answer.level;
        notify({ team_id: teamId, type: 'channels' });
      }
      return answer;
    }

    function manageChannel(method, payload) {
      return CHANNEL_CALLS.has(method) ? send(method, payload) : Promise.resolve({ ok: false, error: teamStore.NO_ANSWER });
    }

    // ----------------------------------------------------------------- pushes

    function mergeChannels(state, list, partial) {
      if (!partial) { state.channels = list.slice(); return; }
      const index = new Map(state.channels.map((c, i) => [c.channel_id, i]));
      for (const record of list) {
        if (!record || typeof record.channel_id !== 'string') continue;
        if (index.has(record.channel_id)) state.channels[index.get(record.channel_id)] = record;
        else state.channels.push(record);
      }
    }

    function onChat(payload) {
      if (!payload || typeof payload !== 'object' || typeof payload.team_id !== 'string') return;
      const teamId = payload.team_id;
      if (payload.type === 'cleared') {
        tracked.delete(teamId); // the next `sync` tracks it again and asks the overview
        if (drop(teamId)) notify({ team_id: teamId, type: 'cleared' });
        return;
      }
      if (!tracked.has(teamId)) return;
      const state = ensure(teamId);
      switch (payload.type) {
        case 'channels':
          if (!Array.isArray(payload.channels)) return;
          if (payload.partial !== true) state.pushes.channels += 1;
          else if (state.loading) for (const record of payload.channels) if (record && typeof record.channel_id === 'string') state.partials.set(record.channel_id, record);
          mergeChannels(state, payload.channels, payload.partial === true);
          notify({ team_id: teamId, type: 'channels' });
          return;
        case 'messages': {
          if (typeof payload.channel_id !== 'string' || !Array.isArray(payload.messages)) return;
          const line = state.timelines.get(payload.channel_id);
          if (!line) return; // a channel not opened here: main keeps it
          landed(state, payload.messages);
          if (payload.reset === true) {
            line.list = payload.messages.filter(isTimelineMessage).sort(bySeq);
            line.hasNewer = false;
            line.hasMore = line.list.length > 0 && line.list[0].seq > Math.max(1, line.floorSeq || 1);
          } else {
            mergeMessages(line, payload.messages);
          }
          notify({ team_id: teamId, type: 'messages', channel_id: payload.channel_id, reset: payload.reset === true, records: payload.messages });
          return;
        }
        case 'outbox':
          if (!Array.isArray(payload.outbox)) return;
          state.pushes.outbox += 1;
          notify({ team_id: teamId, type: 'outbox', settled: onOutbox(state, payload) });
          return;
        case 'members':
          if (!Array.isArray(payload.members)) return;
          state.pushes.members += 1;
          state.members = payload.members.slice();
          notify({ team_id: teamId, type: 'members' });
          return;
        case 'presence': {
          const index = (state.members || []).findIndex((m) => m.member_id === payload.member_id);
          if (index < 0) return;
          state.members[index] = { ...state.members[index], state: payload.state, last_seen_at: payload.last_seen_at ?? null };
          notify({ team_id: teamId, type: 'presence' });
          return;
        }
        case 'typing':
          onTyping(teamId, state, payload);
          return;
        default:
      }
    }

    // ------------------------------------------------------------- consumers

    function use() {
      holders += 1;
      if (holders === 1) {
        const api = bridge();
        if (api && typeof api.onChat === 'function') {
          const off = api.onChat(onChat);
          unsubscribe = typeof off === 'function' ? off : null;
        }
      }
      let held = true;
      const born = generation;
      return function release() {
        if (!held || born !== generation) return;
        held = false;
        holders -= 1;
        if (holders === 0 && unsubscribe) { try { unsubscribe(); } catch (_error) { /* best effort */ } unsubscribe = null; }
      };
    }

    function subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    }

    // ------------------------------------------------------------- selectors

    function team(teamId) { return stateOf(teamId); }
    function channel(teamId, channelId) {
      const state = stateOf(teamId);
      return (state && state.channels.find((c) => c.channel_id === channelId)) || null;
    }
    // The name a held team's row gives a channel, or ''.
    function nameOf(channelId) {
      for (const state of teams.values()) {
        const row = state.channels.find((c) => c && c.channel_id === channelId);
        if (row && typeof row.name === 'string' && row.name) return row.name;
      }
      return '';
    }
    function timeline(teamId, channelId) {
      const state = stateOf(teamId);
      return (state && state.timelines.get(channelId)) || emptyTimeline();
    }
    // Who is typing in a channel (or one of its threads) now, in the order they started.
    function typing(teamId, channelId, rootId = null) {
      const state = stateOf(teamId);
      const who = state && state.typing.get(typingKey(channelId, rootId));
      const now = Date.now();
      return who ? [...who].filter(([, at]) => at > now).map(([id]) => id) : [];
    }
    // The posts still to draw: the outbox's entries, then the settled posts whose message is not here yet.
    function pending(teamId) {
      const state = stateOf(teamId);
      return state ? state.outbox.concat([...state.landing.values()]) : [];
    }
    // A followed thread's unseen replies as the channel row lists them (E59; 0 when it lists none), and all of them.
    function threadUnread(teamId, channelId, rootId) { return reads.threadUnread(channel(teamId, channelId), rootId); }
    function threadCounts(teamId, channelId) { return reads.threadCounts(channel(teamId, channelId)); }
    // The reactions the host accepts, in its order, per team (the picker's list); null until the overview answers.
    function emoji(teamId) { const state = stateOf(teamId); return state && state.reactionEmoji ? state.reactionEmoji.slice() : null; }
    function settledId(teamId, messageId) { const state = stateOf(teamId); return Boolean(state && state.settled.has(messageId)); }
    function member(teamId, memberId) {
      const state = stateOf(teamId);
      return (state && (state.members || []).find((m) => m.member_id === memberId)) || null;
    }
    // The tab's number (E39): channels that mention you plus direct conversations with unread messages not muted,
    // in every team held here; `{ direct: true }` counts the second part only (a muted conversation counts in neither).
    const unreadDirect = (c) => c.kind === 'dm' && (c.unread > 0 || c.unread_capped === true) && c.notify !== 'none';
    function mentionCount({ direct = false } = {}) {
      let count = 0;
      for (const [id, state] of teams) if (tracked.has(id)) count += state.channels.filter((c) => c && (direct ? unreadDirect(c) : unreadDirect(c) || (c.mention === true && !(c.kind === 'dm' && c.notify === 'none')))).length;
      return count;
    }

    // Drops everything held (the `team` flag went off); the store can be used again afterwards.
    function dispose() {
      generation += 1;
      listeners.clear();
      holders = 0;
      if (unsubscribe) { try { unsubscribe(); } catch (_error) { /* best effort */ } }
      unsubscribe = null;
      for (const id of [...teams.keys()]) drop(id);
      tracked = new Set();
      clearTimeout(typingTimer);
      typingTimer = null;
    }

    return { use, subscribe, sync, retryOverview, team, channel, timeline, member, typing, pending, emoji, settledId, mentionCount, openChannel,
      closeChannel, loadOlder, loadNewer, trim, markRead, markThreadRead, markUnread, threadUnread, threadCounts, setNotify, manageChannel, nameOf, watchThread, dispose };
  }

  let shared = null;
  function getChatStore() {
    if (!shared) shared = createChatStore();
    return shared;
  }

  return { createChatStore, getChatStore, CHANNEL_TEAM, LOCKED_STATES, isolate };
});
