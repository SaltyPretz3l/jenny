/* Team desktop notifications and the way into the Team tab from outside it (row 123, slice 2a-6c; owner picks
 * 2026-11-12, mockup team-chat-2a6c).
 *
 * The subscriber: the chat store keeps only the channels a timeline shows, so this reads the `team.onChat`
 * pushes itself, for every channel of every team the chat store holds, while the gate holds the store (the
 * gate starts and stops it with the store; with the `team` flag off nothing here exists). For each new message
 * it applies the spec's rules and hands one candidate to the desktop notifications controller, which sends it
 * to main (main gates the switch, focus, the count per conversation and the click):
 * - never for your own message, an edit, a deletion or a message seen before (a bounded set of ids);
 * - the channel's own level: `none` never, `all` every message, `mentions` (the default for channels; `all` for
 *   direct conversations) only when it mentions you or the channel;
 * - a thread reply only when it mentions you or the thread is one you follow. The host's follow rule is implicit
 *   (you started the thread, replied in it or were mentioned in it) unless you set it by hand, which no push
 *   carries: this keeps the implicit part for the threads it saw in this window;
 * - not for the conversation shown at its latest messages in the focused window (owner pick 8).
 * Titles and second lines are the approved wording; with the preview switch on main shows the message's first
 * line instead. No candidate carries a key, an invite, a member key or a device id: the routing fields are the
 * team, channel, message and thread ids and the message's seq, and mention tokens become names.
 *
 * The way in: a toast's click, a palette row and the palette's export actions ask for an intent here. With the
 * Team tab shown it runs at once; otherwise the tab is opened and the intent runs when the tab attaches, after its
 * first drawing, if that is within 10 seconds (else it is dropped, never run at a later unrelated open). A toast
 * for a team this Jenny is no longer in, with no Team tab left to open, is answered by the desktop notifications
 * controller's toast ("You are no longer in that team."). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-chat-store'), require('./renderer-team-channels'));
    return;
  }
  root.rendererTeamNotify = factory(root.rendererTeamChatStore, root.rendererTeamChannels);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chatStore, channels) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const SEEN_MAX = 1000;
  const FOLLOW_MAX = 200;
  const PREVIEW_MAX = 240;
  const TITLE_MAX = 120;
  const BOTTOM_SLACK_PX = 48;
  const PENDING_MS = 10000;

  const clip = (text, max) => { const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim()); return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join(''); };
  function firstLine(text) { return String(text || '').split(/\r?\n/).find((line) => line.trim()) || ''; }
  function bounded(set, value, max) { set.delete(value); set.add(value); while (set.size > max) set.delete(set.values().next().value); }

  // ---------------------------------------------------------------- intents

  let tabApi = null;
  let pending = null; // { intent, at }
  function shell() { return globalThis.rendererTopNavShellController || null; }

  // A palette row, an export action or a toast's click. Runs now when the Team tab is shown, else after it opens.
  function request(intent) {
    if (!intent || typeof intent !== 'object') return false;
    if (tabApi) { void runIntent(tabApi, intent); return true; }
    const nav = shell();
    pending = { intent, at: Date.now() };
    let opened;
    try { opened = Boolean(nav && typeof nav.openTeamView === 'function' && nav.openTeamView()); } catch (_error) { opened = false; }
    if (!opened) pending = null;
    return opened;
  }

  // The Team tab attaches once it has drawn (renderer-team-tab.js) and runs what was asked at most 10 s before.
  function attachTab(api) {
    tabApi = api;
    const asked = pending && Date.now() - pending.at <= PENDING_MS ? pending.intent : null;
    pending = null;
    if (asked) void runIntent(api, asked);
    return function detach() { if (tabApi === api) tabApi = null; };
  }

  // The Team tab's side of an intent, built from the controls the tab hands over (`tab`).
  function tabIntents(tab) {
    const frame = () => tab.frame();
    const team = (teamId) => tab.teams().find((t) => t.team_id === teamId) || null;
    return {
      show(teamId, channelId, others) {
        if (tab.selectedTeamId() !== teamId) tab.selectTeam(teamId);
        if (channelId) tab.showChannel(teamId, channelId, others);
        if (channelId === channels.NEW && frame() && frame().picker) frame().picker.focus();
      },
      hasTeam: (teamId) => tab.offeredTeams().some((t) => t.team_id === teamId),
      online: (teamId) => Boolean(team(teamId) && team(teamId).state === 'online'),
      memberOf: (teamId) => (team(teamId) || {}).member_id || '',
      jump: (target) => frame() && frame().jumper.jump(target),
      note: (text) => frame() && frame().timeline && frame().timeline.setNote(text),
      focusSearch: () => tab.focusSearch(null),
      call: tab.call,
      exportStart: (teamId, scope) => tab.exportStart(teamId, scope),
      shown() {
        const f = frame();
        return f ? { teamId: f.shown.teamId, channelId: f.shown.channelId, log: f.timeline ? f.timeline.logRoot : null } : null;
      },
    };
  }

  // Whether the message the toast named is still there: a deleted or vanished one opens the channel at its latest.
  async function stillThere(api, intent) {
    const { teamId, channelId, messageId, threadRootId, seq } = intent;
    if (!messageId || !Number.isSafeInteger(seq) || seq <= 0) return true;
    const answer = threadRootId
      ? await api.call('chatThread', { team_id: teamId, channel_id: channelId, root_id: threadRootId, after_seq: seq - 1, limit: 1 })
      : await api.call('chatHistory', { team_id: teamId, channel_id: channelId, before_seq: seq + 1, limit: 1 });
    if (!answer || !answer.ok) return Boolean(answer && answer.error && answer.error.reason !== 'team_chat_not_found');
    const list = threadRootId ? answer.replies : answer.messages;
    const found = Array.isArray(list) ? list.find((m) => m && m.id === messageId) : null;
    return Boolean(found && !found.deleted);
  }

  async function runIntent(api, intent) {
    try {
      const { kind, teamId } = intent;
      if (kind === 'search') { api.focusSearch(); return; }
      if (teamId && !api.hasTeam(teamId)) { api.note(jt('team.notify.gone', 'You are no longer in that team.')); return; }
      if (kind === 'new') { api.show(teamId, channels.NEW); return; }
      if (kind === 'person') { await openPerson(api, teamId, intent.memberId); return; }
      if (kind === 'export') { api.exportStart(teamId, intent.scope); return; }
      if (kind !== 'open' || !intent.channelId) return;
      api.show(teamId, intent.channelId);
      // Offline the channel opens with what this PC has; the jump needs the host.
      if (!intent.messageId || !api.online(teamId)) return;
      if (!(await stillThere(api, intent))) { api.note(jt('team.notify.deleted', 'That message was deleted.')); return; }
      api.jump({ channel_id: intent.channelId, message_id: intent.messageId, seq: intent.seq || 0, root_id: intent.threadRootId || null });
    } catch (_error) { /* an intent that cannot run leaves the tab as it is */ }
  }

  // A person: your one-to-one conversation with them when it exists (no create call); else chatDmOpen makes the empty
  // conversation, as the New message picker's Start does (orchestrator decision, 2026-11-12).
  async function openPerson(api, teamId, memberId) {
    const chat = chatStore.getChatStore();
    const state = chat.team(teamId);
    const me = api.memberOf(teamId);
    const row = state ? channels.existing(state.channels, me, [memberId]) : null;
    if (row) { api.show(teamId, row.channel_id); return; }
    const answer = await api.call('chatDmOpen', { team_id: teamId, member_ids: [memberId] });
    if (answer && answer.ok && typeof answer.channel_id === 'string') api.show(teamId, answer.channel_id, [memberId]);
  }

  // ------------------------------------------------------------- subscriber

  function createNotifier({ windowRef, state, store, controller = () => state && state.desktopNotificationsController } = {}) {
    const chat = chatStore.getChatStore();
    const seen = new Set();
    const follows = new Map(); // team id -> root ids this member follows (implicitly) in this window
    let off = null;

    const teams = () => (store.snapshot().teams || []).filter((t) => t && t.state !== 'needs_repair');
    const teamOf = (teamId) => teams().find((t) => t.team_id === teamId) || null;
    const followsOf = (teamId) => { if (!follows.has(teamId)) follows.set(teamId, new Set()); return follows.get(teamId); };
    const nameOf = (teamId, id) => (chat.member(teamId, id) || {}).display_name || jt('team.chat.formerMember', 'Former member');

    // The focused window shows this conversation at its latest messages.
    function onScreen(teamId, channelId) {
      const doc = windowRef && windowRef.document;
      if (!tabApi || !doc || typeof doc.hasFocus !== 'function' || !doc.hasFocus() || !state || !state.ui || state.ui.activeView !== 'team') return false;
      const shown = tabApi.shown();
      if (!shown || shown.teamId !== teamId || shown.channelId !== channelId) return false;
      if (chat.timeline(teamId, channelId).hasNewer) return false;
      const log = shown.log;
      return !log || log.clientHeight === 0 || log.scrollHeight - log.scrollTop - log.clientHeight <= BOTTOM_SLACK_PX;
    }

    function titleFor(team, record, row, sender, many) {
      if (row && channels.isDirect(row)) {
        const authorId = record.author && record.author.member_id;
        const others = row.participants.filter((id) => id !== team.member_id && id !== authorId).map((id) => nameOf(team.team_id, id));
        if (!others.length) return sender;
        if (others.length === 1) return jt('team.notify.withOne', '{sender}, with {name}', { sender, name: others[0] });
        if (others.length === 2) return jt('team.notify.withTwo', '{sender}, with {first} and {second}', { sender, first: others[0], second: others[1] });
        return jt('team.notify.withMany', '{sender}, with {name} and {count} others', { sender, name: others[0], count: others.length - 1 });
      }
      const title = jt('team.notify.inChannel', '{sender} in #{channel}', { sender, channel: channels.channelName(record.channel_id) });
      return many ? jt('team.notify.inTeam', '{title} · {team}', { title, team: team.team_name || '' }) : title;
    }

    // One record of a `messages` push: a candidate, or null.
    function consider(team, channelId, record) {
      if (!record || typeof record.id !== 'string' || !Number.isSafeInteger(record.seq) || !record.author || typeof record.author !== 'object') return null;
      const known = seen.has(record.id);
      bounded(seen, record.id, SEEN_MAX);
      if (known || record.deleted || record.edited_at) return null;
      const author = record.author;
      const me = team.member_id;
      const mentions = Array.isArray(record.mentions) ? record.mentions : [];
      const root = typeof record.thread_root_id === 'string' ? record.thread_root_id : '';
      const followed = followsOf(team.team_id);
      if (author.kind !== 'jenny' && author.member_id === me) { bounded(followed, root || record.id, FOLLOW_MAX); return null; }
      const mentioned = Boolean(me) && (mentions.includes(me) || mentions.includes('channel'));
      if (root && mentions.includes(me)) bounded(followed, root, FOLLOW_MAX);
      const row = chat.channel(team.team_id, channelId);
      const direct = channels.isDirectId(channelId);
      const level = (row && row.notify) || (direct ? 'all' : 'mentions');
      if (level === 'none') return null;
      if (root ? !(mentioned || followed.has(root)) : !(level === 'all' || mentioned)) return null;
      if (onScreen(team.team_id, channelId)) return null;
      const sender = author.kind === 'jenny' ? 'Jenny' : nameOf(team.team_id, author.member_id);
      let body = jt('team.notify.newMessage', 'New message');
      if (direct) body = jt('team.notify.direct', 'Direct message');
      if (mentioned) body = jt('team.notify.mentioned', 'Mentioned you');
      else if (root) body = jt('team.notify.followed', 'Replied in a thread you follow');
      const others = row && channels.isDirect(row) ? row.participants.filter((id) => id !== me).map((id) => nameOf(team.team_id, id)) : [];
      const candidate = {
        category: 'team', key: 'team:' + record.id, teamId: team.team_id, channelId, messageId: record.id, seq: record.seq,
        title: clip(titleFor(team, record, row, sender, teams().length > 1), TITLE_MAX), body, sender: clip(sender, 80),
        conversation: clip(direct ? (others.length ? channels.namesText(others) : sender) : '#' + channels.channelName(channelId), TITLE_MAX),
      };
      if (root) candidate.threadRootId = root;
      const preview = clip(firstLine(channels.mentionText(record.text, (id) => nameOf(team.team_id, id))), PREVIEW_MAX);
      if (preview) candidate.preview = preview;
      return candidate;
    }

    // What the renderer already holds of the settings: off, or team off, cannot toast, so nothing is sent (main decides the rest).
    function canToast() {
      const settings = state && state.ui && state.ui.notifications;
      return !settings || (settings.enabled !== false && !(settings.categories && settings.categories.team === false));
    }

    function onChat(payload) {
      if (!payload || typeof payload !== 'object' || typeof payload.team_id !== 'string') return;
      if (payload.type === 'cleared') { follows.delete(payload.team_id); return; }
      if (payload.type !== 'messages' || payload.reset === true || typeof payload.channel_id !== 'string' || !Array.isArray(payload.messages)) return;
      const team = teamOf(payload.team_id);
      if (!team || !chat.team(team.team_id) || chatStore.LOCKED_STATES.has(team.state)) return;
      for (const record of payload.messages) {
        // `consider` still runs while nothing can toast: it records seen messages and followed threads.
        const candidate = consider(team, payload.channel_id, record);
        if (candidate && !canToast()) continue;
        const target = candidate ? controller() : null;
        if (target && typeof target.notifyTeam === 'function') target.notifyTeam(candidate);
      }
    }

    // A team toast's click: the window is already forward (main); the Team tab opens at the message. False when
    // nothing opened because the team is gone (the controller then says so with a toast).
    function onOpen(payload) {
      if (!payload || typeof payload.teamId !== 'string' || typeof payload.channelId !== 'string') return true;
      const opened = request({ kind: 'open', teamId: payload.teamId, channelId: payload.channelId, messageId: payload.messageId || '',
        threadRootId: payload.threadRootId || '', seq: Number.isSafeInteger(payload.seq) ? payload.seq : 0 });
      return opened || Boolean(teamOf(payload.teamId));
    }

    function start() {
      if (off) return;
      const api = windowRef && windowRef.jennyShell && windowRef.jennyShell.team;
      const unsubscribe = api && typeof api.onChat === 'function' ? api.onChat(onChat) : null;
      const target = controller();
      if (target && typeof target.setTeamOpenHandler === 'function') target.setTeamOpenHandler(onOpen);
      off = () => {
        if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (_error) { /* best effort */ } }
        const current = controller();
        if (current && typeof current.setTeamOpenHandler === 'function') current.setTeamOpenHandler(null);
      };
    }

    function stop() {
      if (off) off();
      off = null;
      seen.clear();
      follows.clear();
    }

    start();
    return { stop };
  }

  // What the shown Team tab shows ({ teamId, channelId, log }), or null while it is hidden.
  function shownFrame() { return tabApi ? tabApi.shown() : null; }

  return { createNotifier, request, attachTab, tabIntents, shownFrame };
});
