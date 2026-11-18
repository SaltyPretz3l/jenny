/* Team tab: the shown channel and direct conversations (row 123, slice 2d renderer; owner picks 2026-11-12,
 * mockup team-dm). The one piece of tab state per team (which channel is shown) and pure
 * helpers; no DOM.
 *
 * - The shown channel: one per team for the session, `#team` by default (a solo owner's tab opens on OVERVIEW, the
 *   Overview page of renderer-team-overview.js, which is not a channel). A direct conversation stays shown while
 *   the overview lists it, or right after chatDmOpen answered it until its row arrives; one that leaves the
 *   overview falls back to `#team`. NEW is the New message view (owner pick 1, variant A): closing it returns to
 *   the channel shown before, and so does leaving the tab or the team; a member who may not start one never has it.
 * - A direct conversation's row carries `participants` (member ids, this member among them). Its title is the
 *   other participants' display names in the locale's order, joined as a list, never this member's own; a
 *   participant no longer known here reads "Former member".
 * - The frame context (moved here from renderer-team-tab.js): what the timeline, actions, composer, thread and
 *   search read about the shown team and channel. Message references name team and project channels only: a
 *   direct conversation is never `listed`, so a pasted reference to one is plain text, and `direct` tells the
 *   actions to offer no Copy link in one.
 * - TEAM_CHAT_PARITY_GAPS F16: the last shown channel or conversation per team is kept in this window's localStorage
 *   (`jenny.teamShown.v1`, at most 64 teams) and is the selection the first time a team's tab state is made after an app
 *   start. Only #team's own, custom channel and conversation ids are kept or restored; one no longer listed falls back to
 *   `#team` through `resolve`, with no note. A solo owner's Overview default still wins (it is chosen later, by the tab).
 * - The tab's number (E39) is counted by the chat store (`mentionCount`).
 * - Row 173, custom channels: the listing's `channels` are #team then the team's live custom channels (`kind: 'channel'`, in
 *   the order the chat lists them) and `archived` holds the archived ones, shown under a fold. A channel is named by its
 *   row (`name`), else by what its id says. NEW_CHANNEL is the New channel view, a pseudo id like NEW: it shares NEW's
 *   place in the selection (closing returns to the channel before) and is offered to the same members. A channel just
 *   created is shown by its name before its row arrives (`expect`), as a conversation just opened is.
 * - Slice 3-10: a project channel (`chan_<project id>`) is named by its project (`projectNameOf`, from the project
 *   store); `channelName` alone would show the id's remainder. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-chat-store'), require('./renderer-team-channel-menu'));
    return;
  }
  root.rendererTeamChannels = factory(root.rendererTeamChatStore, root.rendererTeamChannelMenu);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chatStore, channelMenu) {
  'use strict';

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const CHANNEL = chatStore.CHANNEL_TEAM;
  const NEW = 'new'; // not a channel id: every channel id starts with `chan_`
  const NEW_CHANNEL = 'newchannel'; // the New channel view: not a channel id either
  const OVERVIEW = 'overview'; // the Overview page (row 168): a page of its own, never sent to the host, marked read or persisted
  const MAX_OTHERS = 7; // the host's bound: the caller and seven others

  const isDirectId = (id) => typeof id === 'string' && id.startsWith('chan_dm_');
  const isDirect = (row) => Boolean(row) && row.kind === 'dm' && Array.isArray(row.participants);
  const isNew = (id) => id === NEW || id === NEW_CHANNEL;
  const isCustom = (row) => Boolean(row) && row.kind === 'channel';
  const hints = new Map(); // channel id -> the name a channel just created was made with, until its row arrives
  // A custom channel's name is its row's (the chat store knows every team's rows); a project's or a conversation's id gives the rest.
  function channelName(id) {
    if (id === CHANNEL) return 'team';
    const named = hints.get(id) || (typeof chatStore.getChatStore === 'function' ? chatStore.getChatStore().nameOf(id) : '');
    return named || String(id).replace(/^chan_(project_)?/, '');
  }
  const others = (row, me) => row.participants.filter((id) => id !== me);
  const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));
  // Adds attributes an inventory primitive has no option for (aria-current, role, aria-selected) to its opening tag.
  function withAttrs(html, attrs) {
    const extra = Object.entries(attrs).map(([name, value]) => ' ' + name + '="' + escapeHtml(String(value)) + '"').join('');
    return html.replace(/^(<[a-z]+)/, '$1' + extra);
  }

  // Another team this member belongs to, as a link into it reads it: its name, which of its channels a link may name (#team
  // and the custom ones, never a conversation) and a channel's name; null for a team not held here (the link stays text).
  function peerTeam(teamId, shownId) {
    if (!teamId || teamId === shownId) return null;
    const teamStore = globalThis.rendererTeamStore || (typeof require === 'function' ? require('./renderer-team-store') : null);
    const joined = teamStore ? teamStore.getTeamStore().snapshot().teams.find((t) => t && t.team_id === teamId && t.state !== 'needs_repair') : null;
    const state = joined && typeof chatStore.getChatStore === 'function' ? chatStore.getChatStore().team(teamId) : null;
    if (!state) return null;
    const rowOf = (id) => state.channels.find((c) => c && c.channel_id === id) || null;
    return { name: joined.team_name || '', listed: (id) => id === CHANNEL || isCustom(rowOf(id)), channelName: (id) => (id === CHANNEL ? 'team' : String((rowOf(id) || {}).name || channelName(id))) };
  }

  const tag = () => globalThis.jennyI18n?.tag?.() || undefined;
  const formats = new Map();
  function format(kind) {
    const key = kind + '|' + tag();
    if (!formats.has(key)) {
      formats.set(key, kind === 'list' ? new Intl.ListFormat(tag(), { type: 'unit', style: 'short' }) : new Intl.Collator(tag(), { sensitivity: 'base', numeric: true }));
    }
    return formats.get(key);
  }
  // A message's text with each mention token as the name shown on screen (the notifier and the export; the message
  // row draws the same tokens as chips).
  const MENTION = /<@(member_[A-Za-z0-9_-]{1,64}|jenny|channel)>/g;
  function mentionText(text, nameOf) {
    return String(text || '').replace(MENTION, (_m, id) => '@' + (id === 'channel' ? 'channel' : id === 'jenny' ? 'Jenny' : nameOf(id)));
  }
  // Display names in the locale's order, as one list ("Dot, Maya, Lena").
  function namesText(names) { return format('list').format(names.slice().sort((a, b) => format('collator').compare(a, b))); }

  // ------------------------------------------------------------ selection

  // The last shown channel per team, as local preference (F16). Every read and write is best effort: storage can be absent or blocked.
  const SHOWN_KEY = 'jenny.teamShown.v1';
  const SHOWN_MAX = 64;
  const KEPT_ID = /^chan_(?:c_[a-z2-7]{16}|dm_[a-f0-9]{64})$/;
  function shownPrefs() {
    try {
      const store = globalThis.window && globalThis.window.localStorage;
      const data = store ? JSON.parse(store.getItem(SHOWN_KEY) || '{}') : null;
      return store && data && typeof data === 'object' && !Array.isArray(data) ? { store, data } : null;
    } catch (_error) { return null; }
  }
  function restoredShown(teamId) {
    const prefs = shownPrefs();
    const id = prefs && Object.hasOwn(prefs.data, teamId) ? prefs.data[teamId] : '';
    return typeof id === 'string' && KEPT_ID.test(id) ? id : CHANNEL;
  }
  // `kept`: a channel id, a conversation ({ kind: 'conversation', projectId, sessionId }) or null (#team, the default).
  function keepShown(teamId, kept) {
    const prefs = shownPrefs();
    if (!prefs) return;
    const { store, data } = prefs;
    delete data[teamId];
    if (kept) data[teamId] = kept;
    const keys = Object.keys(data);
    for (const old of keys.slice(0, Math.max(0, keys.length - SHOWN_MAX))) delete data[old];
    try { store.setItem(SHOWN_KEY, JSON.stringify(data)); } catch (_error) { /* storage blocked or full: the tab opens on #team */ }
  }
  function rememberShown(teamId, channelId) {
    if (channelId === CHANNEL || KEPT_ID.test(channelId)) keepShown(teamId, channelId === CHANNEL ? null : channelId);
  }
  // F16 for a project conversation (row 175 round 2b): the same preference holds the one the Team tab showed last. It is read
  // once per app start and per team (`takeConversation`); the project tab opens it when it is still listed.
  const KEPT_PROJECT = /^project_[A-Za-z0-9_-]{1,128}$/;
  const KEPT_SESSION = /^sess_[A-Za-z0-9_-]{1,123}$/;
  const taken = new Set();
  function takeConversation(teamId) {
    if (taken.has(teamId)) return null;
    taken.add(teamId);
    const prefs = shownPrefs();
    const kept = prefs && Object.hasOwn(prefs.data, teamId) ? prefs.data[teamId] : null;
    return kept && typeof kept === 'object' && kept.kind === 'conversation' && KEPT_PROJECT.test(kept.projectId) && KEPT_SESSION.test(kept.sessionId)
      ? { projectId: kept.projectId, sessionId: kept.sessionId } : null;
  }
  function rememberConversation(teamId, projectId, sessionId) {
    if (KEPT_PROJECT.test(projectId) && KEPT_SESSION.test(sessionId)) keepShown(teamId, { kind: 'conversation', projectId, sessionId });
  }
  // Left the conversation (or it is gone): the channel shown is what is kept again.
  function forgetConversation(teamId) {
    const shown = entry(teamId).shown;
    keepShown(teamId, KEPT_ID.test(shown) ? shown : null);
  }

  // teamId -> { shown, back, awaiting: { id, others } | null }, kept for the session like the shown team.
  const byTeam = new Map();
  function entry(teamId) {
    if (!byTeam.has(teamId)) { const shown = restoredShown(teamId); byTeam.set(teamId, { shown, back: shown, awaiting: null }); }
    return byTeam.get(teamId);
  }
  // `others`: chatDmOpen answered `channelId` for these other participants; it is shown at once, also before its row arrives.
  function select(teamId, channelId, others = null) {
    const e = entry(teamId);
    if (isNew(channelId) && !isNew(e.shown)) e.back = e.shown;
    e.shown = channelId;
    rememberShown(teamId, channelId);
    e.awaiting = others ? { id: channelId, others: others.slice() } : (e.awaiting && e.awaiting.id === channelId ? e.awaiting : null);
  }
  // A channel just created is shown before its row is listed, by `name` (see `resolve`: the same wait as a conversation just opened).
  function expect(teamId, channelId, name) {
    hints.set(channelId, name);
    entry(teamId).awaiting = { id: channelId, others: [] };
  }
  function closeNew(teamId) { const e = entry(teamId); if (isNew(e.shown)) select(teamId, e.back); }
  function closeAllNew() { for (const teamId of byTeam.keys()) closeNew(teamId); }
  const shownOf = (teamId) => entry(teamId).shown;
  // The other participants of a conversation just opened whose row is not here yet, else null.
  function awaited(teamId, id) { const e = entry(teamId); return e.awaiting && e.awaiting.id === id && e.awaiting.others.length ? e.awaiting.others : null; }

  // The channel a shown id stands for: the tab's own pages (New message, New channel, Overview) are not channels, so `#team`.
  const asChannel = (id) => (isNew(id) || id === OVERVIEW ? CHANNEL : id);

  // The channel to show among `rows` (the team's channel rows): the selection while listed, the New message view
  // while this member may start a conversation, a conversation just opened until its row arrives; else #team.
  // Before the chat is loaded #team is shown and the selection kept.
  function resolve(teamId, rows, { loaded, mayStart }) {
    const e = entry(teamId);
    if (e.shown === OVERVIEW) return OVERVIEW; // a page of the tab: it needs neither the chat nor a listed row
    if (!loaded) return isNew(e.shown) && mayStart ? e.shown : CHANNEL;
    const listed = e.shown === CHANNEL || rows.some((row) => row && row.channel_id === e.shown);
    if (listed && e.awaiting) { hints.delete(e.awaiting.id); e.awaiting = null; }
    if (listed || (isNew(e.shown) && mayStart) || (e.awaiting && e.awaiting.id === e.shown)) return e.shown;
    select(teamId, CHANNEL);
    return CHANNEL;
  }

  // The column's and the header's part of the view model for one team: #team's row then the live custom channels
  // (`channels`), the archived ones (`archived`), the conversations in the order of their titles, whether this member may
  // start one or make a channel, the shown channel (its other people when it is a direct conversation) and its row, and the
  // shown row's notification level. `contextOf(channelId)`: the frame context.
  function listing({ team, chatState, contextOf }) {
    const all = chatState ? chatState.channels.filter(Boolean) : [];
    const own = all.filter((c) => c.channel_id === CHANNEL);
    const customs = all.filter(isCustom);
    const list = (own.length ? own : [{ channel_id: CHANNEL, kind: 'team', notify: 'all', unread: 0, mention: false, unread_capped: false }]).concat(customs.filter((c) => !c.archived));
    // Owners and members may start a direct conversation; a read-only member is refused by the host and gets no control.
    const mayStart = Boolean(team && (team.role === 'owner' || team.role === 'member'));
    const channelId = team ? resolve(team.team_id, all, { loaded: Boolean(chatState && chatState.loaded), mayStart }) : CHANNEL;
    const ctx = team ? contextOf(channelId) : null;
    const titleOf = ctx ? ctx.channelTitleOf : (id) => '#' + channelName(id);
    const directs = all.filter(isDirect).sort((a, b) => format('collator').compare(titleOf(a.channel_id), titleOf(b.channel_id)));
    const row = all.find((c) => c.channel_id === channelId);
    // `notifyReady`: the shown channel's row is here (a conversation just opened has none yet, so no bell to change).
    return { channels: list, archived: customs.filter((c) => c.archived), directs, mayStart, row: row || null, channelId, titleOf, channelName: ctx ? ctx.channelNameOf : channelName, notify: (row || list[0]).notify || 'all', notifyReady: channelId === CHANNEL || Boolean(row),
      direct: ctx && ctx.direct ? ctx.othersOf(channelId) || [] : null };
  }

  // The chat's members with their presence, plus anyone the roster lists that the chat has not heard of yet; null
  // before the chat's member list is in.
  function withPresence(members, roster) {
    if (!members) return null;
    const known = new Set(members.map((m) => m.member_id));
    return members.concat((roster || []).filter((m) => !known.has(m.member_id))
      .map((m) => ({ member_id: m.member_id, display_name: m.display_name, role: m.role, state: 'offline', last_seen_at: null })));
  }

  // The conversation this member already has with exactly `ids`, or null.
  function existing(rows, me, ids) { return rows.find((row) => isDirect(row) && sameSet(others(row, me), ids)) || null; }

  // ------------------------------------------------------- frame context

  // One person's presence in words, for the header dot and the picker: online, away, last seen, offline.
  function presenceText(member, lastSeen) {
    if (!member) return jt('team.dm.presence.offline', 'offline');
    if (member.state === 'online') return jt('team.dm.presence.online', 'online');
    if (member.state === 'away') return jt('team.chat.presence.away', 'away');
    const time = member.last_seen_at ? lastSeen(member.last_seen_at) : '';
    return time ? jt('team.dm.presence.lastSeen', 'last seen {time}', { time }) : jt('team.dm.presence.offline', 'offline');
  }

  // What a frame's timeline, actions, composer, thread and search need about its team and shown channel, read fresh
  // on every pass. `team` null (it left the list) reads as locked: no chat call for it. `rows`: the team's channel
  // rows; `pending`: the other participants of a conversation just opened whose row is not here yet.
  function frameContext({ team, teamId, people, loaded, channelId, rows = [], pending = null, heldMessage = () => null, projectNameOf = () => '' }) {
    const former = jt('team.chat.formerMember', 'Former member');
    const byId = new Map(people.map((m) => [m.member_id, m]));
    const me = team ? team.member_id : '';
    const nameOf = (id) => (byId.get(id) || {}).display_name || former;
    const shownRow = rows.find((r) => r && r.channel_id === channelId) || null;
    const rules = team && shownRow && (shownRow.kind === 'team' || isCustom(shownRow)) ? channelMenu.channelActions(shownRow, team, nameOf) : null;
    const othersOf = (id) => {
      const row = rows.find((r) => r && r.channel_id === id);
      if (isDirect(row)) return others(row, me);
      return id === channelId && pending ? pending : null;
    };
    const named = (id) => projectNameOf(id) || channelName(id);
    const titleOf = (id) => { const ids = othersOf(id); return ids ? namesText(ids.map(nameOf)) : (isDirectId(id) ? former : '#' + named(id)); };
    const direct = isDirectId(channelId);
    const base = { channelId, channelName: direct ? titleOf(channelId) : named(channelId), channelTitle: titleOf(channelId), channelTitleOf: titleOf,
      channelNameOf: named, direct, othersOf, listed: (id) => id === CHANNEL || rows.some((r) => r && r.channel_id === id && isCustom(r)),
      archived: Boolean(rules && shownRow.archived), unarchiveWhy: rules ? rules.unarchive : null };
    if (!team) {
      return { ...base, online: false, me: '', chatLoaded: false, soleOwner: false, nameOf: () => '', author: () => ({ name: '', initial: '' }),
        mentionName: () => '', knownName: () => '', state: 'stopped', locked: true, canWrite: false, isOwner: false, ownerName: '', people: [] };
    }
    const known = (id) => {
      if (id === 'channel') return 'channel';
      if (id === 'jenny') return 'Jenny';
      return (byId.get(id) || {}).display_name || '';
    };
    return {
      ...base, online: team.state === 'online', me, chatLoaded: Boolean(loaded), teamId, heldMessage,
      soleOwner: team.role === 'owner' && people.length === 1, state: team.state, locked: chatStore.LOCKED_STATES.has(team.state),
      canWrite: team.role === 'owner' || team.role === 'member', isOwner: team.role === 'owner', people,
      ownerName: (people.find((m) => m.role === 'owner') || {}).display_name || '',
      nameOf,
      author(author) {
        if (author && author.kind === 'jenny') return { name: 'Jenny', initial: 'J', jenny: true };
        const member = author && byId.get(author.member_id);
        return member ? { name: member.display_name, initial: Array.from(member.display_name)[0] || '' } : { name: former, initial: '', former: true };
      },
      mentionName: (id) => known(id) || former,
      // The name to show for a mention token, or '' for someone not known here (the token stays as written).
      knownName: known,
      // Another team this member belongs to, for a link into it (renderer-team-link.js); null for any other.
      otherTeam: (id) => peerTeam(id, teamId),
    };
  }

  return { CHANNEL, NEW, NEW_CHANNEL, OVERVIEW, MAX_OTHERS, asChannel, withAttrs, isDirect, isDirectId, isCustom, channelName, others, namesText, mentionText, select, expect, closeNew, closeAllNew, shownOf, awaited, resolve,
    takeConversation, rememberConversation, forgetConversation, listing, withPresence, existing, presenceText, frameContext };
});
