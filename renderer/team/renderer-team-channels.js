/* Team tab: the shown channel and direct conversations (row 123, slice 2d renderer; owner picks 2026-11-12,
 * mockup team-dm). The one piece of tab state per team (which channel is shown) and pure
 * helpers; no DOM.
 *
 * - The shown channel: one per team for the session, `#team` by default. A direct conversation stays shown while
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
 * - The tab's number (E39) is counted by the chat store (`mentionCount`).
 * - Slice 3-10: a project channel (`chan_<project id>`) is named by its project (`projectNameOf`, from the project
 *   store); `channelName` alone would show the id's remainder. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-chat-store'));
    return;
  }
  root.rendererTeamChannels = factory(root.rendererTeamChatStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chatStore) {
  'use strict';

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const CHANNEL = chatStore.CHANNEL_TEAM;
  const NEW = 'new'; // not a channel id: every channel id starts with `chan_`
  const MAX_OTHERS = 7; // the host's bound: the caller and seven others

  const isDirectId = (id) => typeof id === 'string' && id.startsWith('chan_dm_');
  const isDirect = (row) => Boolean(row) && row.kind === 'dm' && Array.isArray(row.participants);
  function channelName(id) { return id === CHANNEL ? 'team' : String(id).replace(/^chan_(project_)?/, ''); }
  const others = (row, me) => row.participants.filter((id) => id !== me);
  const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));
  // Adds attributes an inventory primitive has no option for (aria-current, role, aria-selected) to its opening tag.
  function withAttrs(html, attrs) {
    const extra = Object.entries(attrs).map(([name, value]) => ' ' + name + '="' + escapeHtml(String(value)) + '"').join('');
    return html.replace(/^(<[a-z]+)/, '$1' + extra);
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

  // teamId -> { shown, back, awaiting: { id, others } | null }, kept for the session like the shown team.
  const byTeam = new Map();
  function entry(teamId) {
    if (!byTeam.has(teamId)) byTeam.set(teamId, { shown: CHANNEL, back: CHANNEL, awaiting: null });
    return byTeam.get(teamId);
  }
  // `others`: chatDmOpen answered `channelId` for these other participants; it is shown at once, also before its row arrives.
  function select(teamId, channelId, others = null) {
    const e = entry(teamId);
    if (channelId === NEW && e.shown !== NEW) e.back = e.shown;
    e.shown = channelId;
    e.awaiting = others ? { id: channelId, others: others.slice() } : null;
  }
  function closeNew(teamId) { const e = entry(teamId); if (e.shown === NEW) select(teamId, e.back); }
  function closeAllNew() { for (const teamId of byTeam.keys()) closeNew(teamId); }
  const shownOf = (teamId) => entry(teamId).shown;
  // The other participants of a conversation just opened whose row is not here yet, else null.
  function awaited(teamId, id) { const e = entry(teamId); return e.awaiting && e.awaiting.id === id ? e.awaiting.others : null; }

  // The channel to show among `rows` (the team's channel rows): the selection while listed, the New message view
  // while this member may start a conversation, a conversation just opened until its row arrives; else #team.
  // Before the chat is loaded #team is shown and the selection kept.
  function resolve(teamId, rows, { loaded, mayStart }) {
    const e = entry(teamId);
    if (!loaded) return e.shown === NEW && mayStart ? NEW : CHANNEL;
    const listed = e.shown === CHANNEL || rows.some((row) => row && row.channel_id === e.shown);
    if (listed && e.awaiting) e.awaiting = null;
    if (listed || (e.shown === NEW && mayStart) || (e.awaiting && e.awaiting.id === e.shown)) return e.shown;
    select(teamId, CHANNEL);
    return CHANNEL;
  }

  // The column's and the header's part of the view model for one team: #team's row, the conversations in the order
  // of their titles, whether this member may start one, the shown channel (its other people when it is a direct
  // conversation) and the shown row's notification level. `contextOf(channelId)`: the frame context.
  function listing({ team, chatState, contextOf }) {
    const all = chatState ? chatState.channels.filter(Boolean) : [];
    const own = all.filter((c) => c.channel_id === CHANNEL);
    const list = own.length ? own : [{ channel_id: CHANNEL, kind: 'team', notify: 'all', unread: 0, mention: false, unread_capped: false }];
    // Owners and members may start a direct conversation; a read-only member is refused by the host and gets no control.
    const mayStart = Boolean(team && (team.role === 'owner' || team.role === 'member'));
    const channelId = team ? resolve(team.team_id, all, { loaded: Boolean(chatState && chatState.loaded), mayStart }) : CHANNEL;
    const ctx = team ? contextOf(channelId) : null;
    const titleOf = ctx ? ctx.channelTitleOf : (id) => '#' + channelName(id);
    const directs = all.filter(isDirect).sort((a, b) => format('collator').compare(titleOf(a.channel_id), titleOf(b.channel_id)));
    const row = all.find((c) => c.channel_id === channelId);
    // `notifyReady`: the shown channel's row is here (a conversation just opened has none yet, so no bell to change).
    return { channels: list, directs, mayStart, channelId, titleOf, notify: (row || list[0]).notify || 'all', notifyReady: channelId === CHANNEL || Boolean(row),
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
    const othersOf = (id) => {
      const row = rows.find((r) => r && r.channel_id === id);
      if (isDirect(row)) return others(row, me);
      return id === channelId && pending ? pending : null;
    };
    const named = (id) => projectNameOf(id) || channelName(id);
    const titleOf = (id) => { const ids = othersOf(id); return ids ? namesText(ids.map(nameOf)) : (isDirectId(id) ? former : '#' + named(id)); };
    const direct = isDirectId(channelId);
    const base = { channelId, channelName: direct ? titleOf(channelId) : named(channelId), channelTitle: titleOf(channelId), channelTitleOf: titleOf,
      channelNameOf: named, direct, othersOf, listed: (id) => id === CHANNEL };
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
    };
  }

  return { CHANNEL, NEW, MAX_OTHERS, withAttrs, isDirect, isDirectId, channelName, others, namesText, mentionText, select, closeNew, closeAllNew, shownOf, awaited, resolve,
    listing, withPresence, existing, presenceText, frameContext };
});
