/* Team rows for the Ctrl+K palette (row 123, slice 2a-6c; owner picks 1 to 3, 2026-11-12). Loaded by the gate
 * with the chat store, so the rows exist only while this Jenny is in a team and the `team` flag is on; the
 * palette's providers ask here once per open (renderer-command-palette-providers.js) and get nothing otherwise.
 *
 * - "Team" in Navigate (Ctrl 6), then the Team group: "Search messages", "New message" and the conversations
 *   with something unread, mentions first, at most four, shown with nothing typed (`landing`).
 * - Typed: every channel, every conversation of three or more and every other member, in the palette's one
 *   ranked list (`queryOnly` keeps them out of the empty list). A one-to-one conversation has no row of its own:
 *   the person's row is it. You are not listed. Channels and conversations are also in the Chats scope (`#`).
 * - "Export this conversation" and "Export every conversation", while the team is online.
 * Facts are as of the moment the palette opened, like every other row. Picking runs an intent in the Team tab
 * (renderer-team-notify.js), after the palette's own move to the Team view. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-store'), require('./renderer-team-chat-store'), require('./renderer-team-channels'), require('./renderer-team-notify'));
    return;
  }
  root.rendererTeamPalette = factory(root.rendererTeamStore, root.rendererTeamChatStore, root.rendererTeamChannels, root.rendererTeamNotify);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (teamStore, chatStore, channels, notify) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const LANDING_MAX = 4;
  const SEP = ' · ';
  const GROUP = 'Team';

  const unread = (row) => Boolean(row) && row.notify !== 'none' && (row.mention === true || row.unread > 0 || row.unread_capped === true);
  function unreadText(row) {
    if (!row || row.notify === 'none') return '';
    if (row.mention === true) return jt('team.palette.mentions', 'mentions you');
    if (row.unread > 0 || row.unread_capped === true) return jt('team.palette.unread', '{count} unread', { count: row.unread_capped === true ? row.unread + '+' : row.unread });
    return '';
  }
  const describe = (parts) => parts.filter(Boolean).join(SEP);

  /**
   * @param {{ navigate: Function }} options - `navigate` moves to the Team view (and its focus landing)
   * @returns {Array<Object>} palette items (the providers decorate them)
   */
  function paletteItems({ navigate = () => {} } = {}) {
    const store = teamStore.getTeamStore();
    const chat = chatStore.getChatStore();
    const teams = (store.snapshot().teams || []).filter((t) => t && !chatStore.LOCKED_STATES.has(t.state) && chat.team(t.team_id));
    if (!teams.length) return [];
    const many = teams.length > 1;
    const go = (intent) => () => { try { navigate(); } catch (_error) { /* noop */ } notify.request(intent); };
    const shown = (typeof notify.shownFrame === 'function' && notify.shownFrame()) || null;
    const current = teams.find((t) => shown && t.team_id === shown.teamId) || teams[0];
    const shownId = shown && shown.teamId === current.team_id ? shown.channelId : channels.shownOf(current.team_id);
    const items = [{ id: 'nav:team', group: 'Navigate', label: jt('team.tab.label', 'Team'), description: '', hint: jt('commandPalette.navigation.teamHint', 'Ctrl 6'), run: navigate }];
    const rows = [];
    const titleIn = (team, row) => {
      const others = channels.others(row, team.member_id).map((id) => (chat.member(team.team_id, id) || {}).display_name || jt('team.chat.formerMember', 'Former member'));
      return channels.namesText(others);
    };
    const titleOf = (team, id) => {
      const row = (chat.team(team.team_id).channels || []).find((c) => c && c.channel_id === id);
      return row && channels.isDirect(row) ? titleIn(team, row) : '#' + channels.channelName(id === channels.NEW ? channels.CHANNEL : id);
    };
    items.push({ id: 'team:search', group: GROUP, label: jt('team.search.field', 'Search messages'), description: titleOf(current, shownId), tag: jt('team.palette.action', 'Action'),
      icon: 'search', landing: true, run: go({ kind: 'search' }) });
    if (current.role === 'owner' || current.role === 'member') {
      items.push({ id: 'team:new', group: GROUP, label: jt('team.dm.heading', 'New message'), description: jt('team.palette.newDescription', 'Start a direct conversation'),
        tag: jt('team.palette.action', 'Action'), icon: 'action', landing: true, run: go({ kind: 'new', teamId: current.team_id }) });
    }
    for (const team of teams) {
      const state = chat.team(team.team_id);
      const teamName = many ? (team.team_name || '') : '';
      const list = (state.channels || []).filter(Boolean);
      const direct = new Map(); // member id -> its one-to-one row
      for (const row of list) {
        if (channels.isDirect(row) && channels.others(row, team.member_id).length === 1) { direct.set(channels.others(row, team.member_id)[0], row); continue; }
        const isGroup = channels.isDirect(row);
        if (!isGroup && row.kind === 'dm') continue; // a direct row without its participants is not drawn anywhere
        rows.push({ row, item: { id: 'team:chan:' + team.team_id + ':' + row.channel_id, group: GROUP, label: isGroup ? titleIn(team, row) : '#' + channels.channelName(row.channel_id),
          description: describe(isGroup ? [teamName, jt('team.palette.directDescription', 'direct conversation'), unreadText(row)] : [teamName, unreadText(row)]),
          tag: isGroup ? jt('team.palette.direct', 'Direct') : jt('team.palette.channel', 'Channel'), icon: 'chat', scopes: ['chats'],
          run: go({ kind: 'open', teamId: team.team_id, channelId: row.channel_id }) } });
      }
      for (const member of state.members || []) {
        if (!member || member.member_id === team.member_id) continue;
        const row = direct.get(member.member_id) || null;
        rows.push({ row, item: { id: 'team:person:' + team.team_id + ':' + member.member_id, group: GROUP, label: String(member.display_name || ''),
          description: describe([teamName, channels.presenceText(member, () => ''), unreadText(row)]), tag: jt('team.palette.person', 'Person'), icon: 'person',
          run: go(row ? { kind: 'open', teamId: team.team_id, channelId: row.channel_id } : { kind: 'person', teamId: team.team_id, memberId: member.member_id }) } });
      }
    }
    const landing = new Set(rows.filter((r) => unread(r.row)).sort((a, b) => Number(b.row.mention === true) - Number(a.row.mention === true)
      || (b.row.unread || 0) - (a.row.unread || 0)).slice(0, LANDING_MAX).map((r) => r.item.id));
    for (const { item } of rows) items.push(Object.assign(item, landing.has(item.id) ? { landing: true } : { queryOnly: true }));
    // One export at a time: while one runs the actions are not offered (the export module loads with the Team view).
    const exporter = globalThis.rendererTeamExport && globalThis.rendererTeamExport.getExporter();
    if (current.state === 'online' && !(exporter && exporter.running())) {
      items.push({ id: 'team:export-one', group: GROUP, label: jt('team.palette.exportOne', 'Export this conversation'), description: titleOf(current, shownId === channels.NEW ? channels.CHANNEL : shownId),
        tag: jt('team.palette.action', 'Action'), icon: 'action', queryOnly: true, run: go({ kind: 'export', teamId: current.team_id, scope: 'one' }) },
      { id: 'team:export-all', group: GROUP, label: jt('team.palette.exportAll', 'Export every conversation'), description: current.team_name || '',
        tag: jt('team.palette.action', 'Action'), icon: 'action', queryOnly: true, run: go({ kind: 'export', teamId: current.team_id, scope: 'all' }) });
    }
    return items;
  }

  return { paletteItems };
});
