/* Team tab markup (row 123, slice 1g-2; the chat frame since slice 2a-5a, owner-
 * approved mockup team-chat-2a5). Pure: a view model in,
 * HTML strings out, built from inventory primitives.
 *
 * A connected team is a channel: the frame (`frameHtml`) holds the left column
 * (switcher and connection, "Wants to join" for people set aside, Channels,
 * Online and Offline), and the main area's regions: the channel header, the
 * banner line, the join notice, the timeline and the composer. The controller
 * (renderer-team-tab.js) writes the frame once per shown channel and then
 * patches the column's head and lists, the header and the banner from
 * `panelHeadHtml`, `panelHtml`, `headHtml` and `bannerHtml`; the column's
 * search region, the notice and the timeline have their own modules.
 * A team behind a gate, or no team, is one whole-view state (`shellHtml`).
 * Design law: no side bars, no cards, state never by colour alone.
 *
 * Direct messages (slice 2d renderer, owner picks 2026-11-12, mockup team-dm): the column's
 * "Direct messages" label (with a New message plus for a member who may start one) and one row per conversation
 * between Channels and Online; a direct conversation's header (the other people's names, a presence dot for one
 * person, the standing line "The team's host can read direct messages." in the sub line's place); the New message
 * view's header and its region in place of the timeline and composer.
 *
 * Shared projects (slice 3-10, owner picks picks_3-10.md): the column's "Projects" section between Direct messages
 * and GPUs (renderer-team-project-column.js), and a project page or shared conversation as a frame of its own (the
 * pseudo ids `proj:` and `conv:`), whose one region (`data-team-region="project"`) the page draws with its header.
 *
 * The Overview (row 168, renderer-team-overview.js): one row above Channels (the pseudo id `channels.OVERVIEW`), its
 * header, and its region (`data-team-region="overview"`) that the page draws and patches itself.
 *
 * Channels (row 173, renderer-team-channel-menu.js and -form.js): a plus on the Channels label (the control Direct messages
 * has, greyed with its reason for a read-only member), #team then the live custom channels, then a folded "Archived · N"
 * group. The header's sub line leads with the topic (an archived channel's with who archived it and when), an options button
 * follows the bell, and a rename or topic edit takes the name or the sub line's place. The New channel view shares the
 * picker's region. `vm.channelUi` is the controller's part of the view model: the open edit, the menu, the fold. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('../shell/renderer-settings-team-view'),
      require('../shell/renderer-settings-team-owner-view'), require('./renderer-team-chat-store'), require('./renderer-team-channels'), require('./renderer-team-gpus'),
      require('./renderer-team-pins'), require('./renderer-team-project-column'), require('./renderer-team-server'), require('./renderer-team-channel-menu'));
    return;
  }
  root.rendererTeamTabView = factory(root.rendererSettingsTeamStrings, root.rendererSettingsTeamView, root.rendererSettingsTeamOwnerView,
    root.rendererTeamChatStore, root.rendererTeamChannels, root.rendererTeamGpus, root.rendererTeamPins, root.rendererTeamProjectColumn, root.rendererTeamServer, root.rendererTeamChannelMenu);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, settingsView, ownerView, chatStore, channels, gpus, pins, projectColumn, serverPage, channelMenu) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  // The status row's tone for each connection state; any other state has the plain dot.
  const TONES = { online: 'success', connecting: 'warning', reconnecting: 'warning', offline: 'danger' };
  const PANEL_ID = 'teamTabPanel';
  const SVG = (paths) => '<svg viewBox="0 0 16 16" aria-hidden="true">' + paths + '</svg>';
  const CHEVRON = SVG('<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>');
  const BACK = SVG('<path d="M9.5 3.5L5 8l4.5 4.5"/>');
  const SEARCH = SVG('<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>');
  const BELL = SVG('<path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.5 14h3"/>');
  const BELL_OFF = SVG('<path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM2.5 2.5l11 11"/>');
  const PLUS = SVG('<path d="M8 3.5v9M3.5 8h9"/>');
  const CLOSE = SVG('<path d="M4 4l8 8M12 4l-8 8"/>');
  const OVERVIEW_GLYPH = SVG('<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>');
  const MUTED = '<svg class="team-row__muted" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM2.5 2.5l11 11"/></svg>';

  function inv() { return globalThis.inventory || {}; }
  const withAttrs = channels.withAttrs;

  function notifyText(level) {
    if (level === 'mentions') return jt('team.chat.notify.mentions', 'Mentions only');
    if (level === 'none') return jt('team.chat.notify.none', 'Nothing');
    return jt('team.chat.notify.all', 'All messages');
  }

  // The one quiet fact beside a team in the switcher: the connection in words unless it is connected.
  function teamFact(team, hostedHere) {
    if (team.state !== 'online') return words.connectionText(team.state);
    const role = words.roleText(team.role);
    return hostedHere ? jt('team.tab.hostedHere', '{role} · hosted here', { role }) : role;
  }

  const collators = new Map();
  function collator() {
    const tag = globalThis.jennyI18n?.tag?.() || undefined;
    if (!collators.has(tag)) collators.set(tag, new Intl.Collator(tag, { sensitivity: 'base', numeric: true }));
    return collators.get(tag);
  }
  // The owner first, then names in the locale's order.
  function sortPeople(members) {
    const order = collator();
    return members.slice().sort((a, b) => (b.role === 'owner') - (a.role === 'owner')
      || order.compare(String(a.display_name || ''), String(b.display_name || '')));
  }

  function tabButton(action, label, { variant = 'secondary', teamId = '', disabled = false, ...more } = {}) {
    const dataset = { 'team-tab-action': action };
    if (teamId) dataset['team-id'] = teamId;
    return inv().actionButton({ label, variant, size: 'sm', dataset, disabled, ...more });
  }

  function label(text, count) {
    return '<h3 class="team-panel__label"><span>' + escapeHtml(text) + '</span>'
      + (count === null ? '' : '<span>' + escapeHtml(String(count)) + '</span>') + '</h3>';
  }

  // ------------------------------------------------------------ left column

  function panelHead(vm) {
    const name = words.teamName(vm.team);
    return '<div class="team-panel__head">' + inv().actionButton({
      plain: true, className: 'team-switch', domId: 'teamTabSwitch', title: jt('team.tab.switch', 'Switch team'),
      ariaLabel: jt('team.tab.switchLabel', '{team}, switch team', { team: name }), ariaHaspopup: 'menu', ariaExpanded: vm.menuOpen === true,
      dataset: { 'team-tab-action': 'switch' }, trustedHtml: '<span class="team-panel__title">' + escapeHtml(name) + '</span>' + CHEVRON,
    }) + inv().statusRow({ tone: TONES[vm.team.state], message: words.connectionText(vm.team.state), compact: true, className: 'team-panel__host' })
      + '</div>';
  }

  // People set aside from the join notice (Later), with their own Admit and Decline.
  function wantsHtml(vm) {
    if (!vm.canAdmit || !vm.aside.length) return '';
    return '<div class="team-wants" data-team-wants>' + label(jt('team.tab.wantsToJoin', 'Wants to join'), vm.aside.length)
      + '<ul class="team-set-list">' + vm.aside.map((member) => ownerView.pendingRow(vm, member)).join('') + '</ul>'
      + settingsView.note(vm.errors.wants) + '</div>';
  }

  // `title`: '#name', or a direct conversation's names.
  function channelLabel(channel, title) {
    const params = { channel: title };
    let text = params.channel;
    if (channel.unread_capped && channel.mention) text = jt('team.chat.row.cappedMention', '{channel}, more than 99 unread, mentions you', params);
    else if (channel.unread_capped) text = jt('team.chat.row.capped', '{channel}, more than 99 unread', params);
    else if (channel.unread > 0 && channel.mention) text = jtn('team.chat.row.unreadMention', channel.unread, params, '{channel}, {count} unread, mentions you', '{channel}, {count} unread, mentions you');
    else if (channel.unread > 0) text = jtn('team.chat.row.unread', channel.unread, params, '{channel}, {count} unread', '{channel}, {count} unread');
    else if (channel.mention) text = jt('team.chat.row.mention', '{channel}, mentions you', params);
    return channel.notify === 'none' ? jt('team.chat.row.muted', '{label}, notifications off', { label: text }) : text;
  }

  // A channel row, or (`lead`, `name` and `title` given) a direct conversation's row with its presence dot or people count.
  function channelRow(vm, channel, { lead = '<span class="team-row__glyph" aria-hidden="true">#</span>', name = vm.channelName(channel.channel_id), title = '#' + name, className = '' } = {}) {
    const unread = channel.unread > 0 || channel.unread_capped === true;
    const count = unread ? '<span class="team-count"' + (channel.mention ? ' data-mention="true"' : '') + ' aria-hidden="true">'
      + (channel.unread_capped ? '99+' : escapeHtml(String(channel.unread))) + '</span>' : '';
    const label = channelLabel(channel, title);
    const button = inv().actionButton({
      plain: true, className: 'team-row team-row--link' + className, ariaLabel: label, title: label,
      dataset: { 'team-channel': channel.channel_id, unread: unread ? 'true' : 'false' },
      trustedHtml: lead + '<span class="team-row__name" dir="auto">' + escapeHtml(name) + '</span>' + (channel.notify === 'none' ? MUTED : '') + count,
    });
    return withAttrs(button, { 'aria-current': channel.channel_id === vm.channelId ? 'true' : 'false' });
  }

  // The presence dot of a two-person conversation's other person (its fact as the tooltip), else ''. `named`: the
  // header's dot, which also carries the fact as its accessible name; a row's dot is hidden (the row says it).
  function personDot(vm, ids, named = false) {
    if (ids.length !== 1) return '';
    const member = (vm.presence || []).find((m) => m.member_id === ids[0]) || null;
    const presence = member && (member.state === 'online' || member.state === 'away') ? member.state : 'offline';
    const fact = escapeHtml(channels.presenceText(member, vm.lastSeen));
    return '<span class="team-dot" data-p="' + presence + '" title="' + fact + '"' + (named ? ' role="img" aria-label="' + fact + '"' : ' aria-hidden="true"') + '></span>';
  }

  // "Direct messages" with its plus (a member who may start one), then one row per conversation; '' when there is
  // neither a conversation nor a way to start one. Several people show their number (this member included).
  function directsHtml(vm) {
    if (!vm.directs.length && !vm.mayStart) return '';
    const add = jt('team.dm.heading', 'New message');
    const plus = vm.mayStart ? inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: add, title: add, dataset: { 'team-tab-action': 'dm-new' }, trustedHtml: PLUS }) : '';
    const rows = vm.directs.map((channel) => {
      const ids = channels.others(channel, vm.team.member_id);
      const lead = personDot(vm, ids) || '<span class="team-row__glyph" aria-hidden="true">' + escapeHtml(String(ids.length + 1)) + '</span>';
      const name = vm.titleOf(channel.channel_id);
      return channelRow(vm, channel, { lead, name, title: name, className: ' team-dm-row' });
    }).join('') || '<p class="team-col-empty">' + escapeHtml(jt('team.dm.none', 'No direct messages yet.')) + '</p>';
    return '<div class="team-directs" data-team-directs><h3 class="team-panel__label"><span>' + escapeHtml(jt('team.dm.label', 'Direct messages')) + '</span>'
      + plus + '</h3>' + rows + '</div>';
  }

  // "Channels" with its plus, #team and the live channels, then the folded group of archived ones (muted rows, a fold button
  // that says how many; open or folded as the controller holds it for this team).
  function channelsHtml(vm) {
    const blocked = channelMenu.createWhy(vm.team);
    const add = jt('team.channels.new', 'New channel');
    const plus = inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: blocked || add, title: blocked || add, disabled: Boolean(blocked),
      dataset: { 'team-tab-action': 'channel-new' }, trustedHtml: PLUS });
    const gone = vm.archived || [];
    const open = Boolean(vm.channelUi && vm.channelUi.foldOpen);
    const fold = gone.length ? inv().actionButton({ plain: true, className: 'team-arch-fold', ariaExpanded: open, title: jt('team.channels.archivedTitle', 'Show or hide archived channels'), dataset: { 'team-tab-action': 'archived-fold' },
      trustedHtml: CHEVRON + '<span>' + escapeHtml(jt('team.channels.archivedFold', 'Archived · {count}', { count: gone.length })) + '</span>' })
      + (open ? gone.map((channel) => channelRow(vm, channel, { className: ' team-row--archived',
        title: jt('team.channels.row.archived', '{channel}, archived', { channel: '#' + vm.channelName(channel.channel_id) }) })).join('') : '') : '';
    return '<div class="team-channels">' + overviewRow(vm) + '<h3 class="team-panel__label"><span>' + escapeHtml(jt('team.chat.channels', 'Channels')) + '</span>' + plus + '</h3>'
      + vm.channels.map((channel) => channelRow(vm, channel)).join('') + fold + '</div>';
  }

  function personName(vm, member) {
    return member.member_id === vm.team.member_id ? jt('settings.team.people.you', '{name} (you)', { name: chatStore.isolate(member.display_name) }) : member.display_name;
  }

  // As built (1g-2): the roster without presence, until the chat's member list is in.
  function rosterRow(vm, member) {
    const fact = member.role === 'member' ? '' : words.roleText(member.role);
    return '<li class="team-row team-row--member"><span class="team-row__name" dir="auto">' + escapeHtml(personName(vm, member)) + '</span>'
      + '<span class="team-row__meta">' + escapeHtml(fact) + '</span></li>';
  }

  // One quiet fact: away in words, when an offline member was last seen, else a role that is not Member.
  function presenceRow(vm, member) {
    let fact = member.role === 'member' ? '' : words.roleText(member.role);
    if (member.state === 'away') fact = jt('team.chat.presence.away', 'away');
    else if (member.state === 'offline' && member.last_seen_at) fact = vm.lastSeen(member.last_seen_at) || fact;
    const presence = member.state === 'online' || member.state === 'away' ? member.state : 'offline';
    return '<li class="team-row team-row--member"><span class="team-dot" data-p="' + presence + '" aria-hidden="true"></span>'
      + '<span class="team-row__name" dir="auto">' + escapeHtml(personName(vm, member)) + '</span>'
      + '<span class="team-row__meta">' + escapeHtml(fact) + '</span></li>';
  }

  function peopleHtml(vm) {
    const note = settingsView.note(vm.rosterError ? words.errorText(vm.rosterError) : '');
    if (!vm.presence) {
      const people = vm.people ? sortPeople(vm.people) : [];
      return '<div class="team-people" data-team-people>' + label(jt('settings.team.people.heading', 'People'), vm.people ? people.length : null)
        + '<ul class="team-list" data-team-people-list>' + people.map((member) => rosterRow(vm, member)).join('') + '</ul>' + note + '</div>';
    }
    const online = sortPeople(vm.presence.filter((m) => m.state === 'online' || m.state === 'away'));
    const offline = sortPeople(vm.presence.filter((m) => !(m.state === 'online' || m.state === 'away')));
    const group = (key, text, list) => (list.length ? label(text, list.length)
      + '<ul class="team-list" data-team-presence="' + key + '">' + list.map((member) => presenceRow(vm, member)).join('') + '</ul>' : '');
    return '<div class="team-people" data-team-people>' + group('online', jt('team.chat.online', 'Online'), online)
      + group('offline', jt('team.chat.offline', 'Offline'), offline) + note + '</div>';
  }

  // The column's lists, below its head and search region (search replaces them while it holds text).
  // Slice 4e: the team's GPUs (renderer-team-gpus.js) sit between the conversations and the people.
  function panelHtml(vm) {
    return wantsHtml(vm) + channelsHtml(vm) + directsHtml(vm)
      + projectColumn.sectionHtml(vm.projects, { channelRow: (channel, options) => channelRow(vm, channel, options) })
      + gpus.sectionHtml(vm.gpus, label) + peopleHtml(vm);
  }

  // ------------------------------------------------------------ the Overview

  // The row above Channels' label, in its block: a page, not a channel, so it has its own action and no unread state. The
  // count is the people waiting to join, for the owner who lets them in.
  function overviewRow(vm) {
    const title = jt('team.ov.title', 'Overview');
    const waiting = vm.waitingCount || 0;
    const label = waiting ? jt('team.ov.rowWaiting', 'Overview, {count} waiting to join', { count: waiting }) : title;
    const button = inv().actionButton({
      plain: true, className: 'team-row team-row--link team-ov-row', ariaLabel: label, title: label, dataset: { 'team-tab-action': 'overview' },
      trustedHtml: '<span class="team-row__glyph" aria-hidden="true">' + OVERVIEW_GLYPH + '</span><span class="team-row__name">' + escapeHtml(title) + '</span>'
        + (waiting ? '<span class="team-count" data-mention="true" aria-hidden="true">' + escapeHtml(String(waiting)) + '</span>' : ''),
    });
    return withAttrs(button, { 'aria-current': vm.channelId === channels.OVERVIEW ? 'true' : 'false' });
  }

  // The Overview's header: its name, where the team is hosted, and Team settings. Back shows under 720 px.
  function overviewHead(vm) {
    const name = words.teamName(vm.team);
    const owner = (vm.people || []).find((member) => member.role === 'owner');
    const where = vm.hostedHere ? jt('team.ov.subHere', '{team} · hosted on this PC', { team: name })
      : owner ? jt('team.ov.subBy', '{team} · hosted by {owner}', { team: name, owner: owner.display_name }) : name;
    const back = jt('team.chat.back', 'Back to the list');
    return '<header class="team-head">' + inv().actionButton({ plain: true, className: 'team-icon-btn team-back', ariaLabel: back, title: back, dataset: { 'team-tab-action': 'back' }, trustedHtml: BACK })
      + '<h2 class="team-head__name">' + escapeHtml(jt('team.ov.title', 'Overview')) + '</h2><span class="team-head__sub">' + escapeHtml(where) + '</span>'
      + '<div class="team-head__actions">' + tabButton('open-settings', jt('team.tab.teamSettings', 'Team settings')) + '</div></header>';
  }

  // The Overview's People rows (the same dot, name and quiet fact as the column's), online first; null before any list is read.
  function peopleRows(vm) {
    const live = (member) => member.state === 'online' || member.state === 'away';
    const members = vm.presence ? sortPeople(vm.presence.filter(live)).concat(sortPeople(vm.presence.filter((member) => !live(member)))) : vm.people ? sortPeople(vm.people) : null;
    if (!members) return null;
    return members.map((member) => ({ key: member.member_id, html: withAttrs(vm.presence ? presenceRow(vm, member) : rosterRow(vm, member), { 'data-ov-key': member.member_id }) }));
  }

  // ------------------------------------------------------------ main area

  function subLine(vm) {
    if (vm.memberCount === 1) return jt('team.chat.subOnlyYou', 'Everyone on this team · only you so far');
    if (!vm.memberCount) return jt('team.chat.subEveryone', 'Everyone on this team');
    return jtn('team.chat.subPeople', vm.memberCount, {}, 'Everyone on this team · {count} person', 'Everyone on this team · {count} people');
  }

  // The New message or New channel view's header: its name and Close (Esc does the same).
  function newHeadHtml(vm) {
    const back = jt('team.chat.back', 'Back to the list');
    const close = jt('team.dm.close', 'Close (Esc)');
    return '<header class="team-head">' + inv().actionButton({ plain: true, className: 'team-icon-btn team-back', ariaLabel: back, title: back, dataset: { 'team-tab-action': 'back' }, trustedHtml: BACK })
      + '<h2 class="team-head__name">' + escapeHtml(vm.channelId === channels.NEW_CHANNEL ? jt('team.channels.new', 'New channel') : jt('team.dm.heading', 'New message')) + '</h2><div class="team-head__actions">'
      + inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: close, title: close, dataset: { 'team-tab-action': 'dm-close' }, trustedHtml: CLOSE }) + '</div></header>';
  }

  // A member's name in a sentence: "you" for this member, else the display name.
  function memberName(vm, id) {
    if (id && id === vm.team.member_id) return jt('team.channels.you', 'you');
    const known = (vm.presence || vm.people || []).find((m) => m.member_id === id);
    return known && known.display_name ? known.display_name : jt('team.chat.formerMember', 'Former member');
  }

  // Who archived the channel and when, from its last `archived` change; '' for a channel that is not archived.
  function archivedLine(vm, row) {
    if (!row.archived) return '';
    const made = (Array.isArray(row.changes) ? row.changes : []).filter((c) => c && c.kind === 'archived').pop();
    const by = (made && made.by) || row.archived_by;
    const at = made ? (typeof made.at === 'number' ? made.at : Date.parse(made.at)) : NaN;
    if (!by || !Number.isFinite(at)) return jt('team.channels.archivedPlain', 'Archived');
    return jt('team.channels.archivedBy', 'Archived {date} by {name}', { date: words.dateText(at, true), name: memberName(vm, by) });
  }

  // The sub line of a channel: the archived note, the topic, then who is in it. Untrusted text is escaped.
  function channelSub(vm) {
    const row = vm.row;
    if (!row || (row.kind !== 'team' && row.kind !== 'channel')) return escapeHtml(subLine(vm));
    const parts = [];
    const archived = archivedLine(vm, row);
    if (archived) parts.push(escapeHtml(archived));
    if (row.topic) parts.push('<span class="team-head__topic" dir="auto">' + escapeHtml(row.topic) + '</span>');
    parts.push(escapeHtml(subLine(vm)));
    return parts.join(' · ');
  }

  // The shown channel's name, or a direct conversation's: the dot for one person, the names (cut, the full list in
  // the tooltip) and the standing line in the sub line's place, shown at every width. A rename or topic edit that is open
  // takes the name's or the sub line's place.
  function headName(vm) {
    if (!vm.direct) {
      const editing = channelMenu.editHtml(vm.channelUi && vm.channelUi.edit);
      return (editing && editing.name ? editing.name : '<h2 class="team-head__name" dir="auto">#' + escapeHtml(vm.channelName(vm.channelId)) + '</h2>')
        + (editing ? editing.sub : '<span class="team-head__sub">' + channelSub(vm) + '</span>');
    }
    const names = vm.titleOf(vm.channelId);
    return personDot(vm, vm.direct, true) + '<h2 class="team-head__name" dir="auto" title="' + escapeHtml(names) + '">' + escapeHtml(names) + '</h2>'
      + '<span class="team-head__sub" data-standing="true">' + escapeHtml(jt('team.dm.standing', 'The team’s host can read direct messages.')) + '</span>';
  }

  function headHtml(vm) {
    if (projectColumn.isPage(vm.channelId)) return ''; // the project page and conversation draw their own header
    if (vm.channelId === channels.OVERVIEW) return overviewHead(vm);
    if (vm.channelId === channels.NEW || vm.channelId === channels.NEW_CHANNEL) return newHeadHtml(vm);
    const level = notifyText(vm.notify);
    const bell = jt('team.chat.notify.label', 'Notifications: {level}', { level });
    const back = vm.searching ? jt('team.search.back', 'Back to the results') : jt('team.chat.back', 'Back to the list');
    const search = jt('team.search.allButton', 'Search messages (Ctrl+F)'); // it searches every channel, as Ctrl+F does
    const options = jt('team.channels.menu.label', 'Channel options');
    const manage = !vm.direct && vm.row && (vm.row.kind === 'team' || vm.row.kind === 'channel') ? inv().actionButton({ plain: true, className: 'team-icon-btn', domId: channelMenu.BUTTON_ID,
      ariaLabel: options, title: options, ariaHaspopup: 'menu', ariaExpanded: Boolean(vm.channelUi && vm.channelUi.menuOpen), dataset: { 'team-tab-action': 'channel-menu' }, trustedHtml: channelMenu.DOTS }) : '';
    return '<header class="team-head">' + inv().actionButton({
      plain: true, className: 'team-icon-btn team-back', ariaLabel: back, title: back, dataset: { 'team-tab-action': 'back' }, trustedHtml: BACK,
    }) + headName(vm) + '<div class="team-head__actions">' + pins.buttonHtml(vm) + inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: search, title: search,
        dataset: { 'team-tab-action': 'search' }, trustedHtml: SEARCH }) + inv().actionButton({
        plain: true, className: 'team-icon-btn', domId: 'teamNotifyButton', ariaLabel: bell, title: bell, ariaHaspopup: 'menu',
        ariaExpanded: vm.notifyOpen === true, dataset: { 'team-tab-action': 'notify' }, trustedHtml: vm.notify === 'none' ? BELL_OFF : BELL, disabled: vm.notifyReady === false,
      }) + manage + '</div></header>';
  }

  // The words for a team that is not connected ('' when it is); the banner's, and search's when offline.
  function hostWords(team) {
    if (team.state === 'connecting') return jt('team.tab.banner.connecting', 'Connecting…');
    if (team.state === 'reconnecting') return jt('team.tab.banner.reconnecting', 'Reconnecting…');
    if (team.state !== 'offline') return '';
    const time = words.formatTime(Number(team.since));
    return time ? jt('team.tab.banner.offline', 'Offline since {time}. Jenny keeps trying to reconnect.', { time }) : words.connectionText('offline');
  }

  // The connection line under the header (as built in 1g-2), then a sentence for a failed header action.
  function bannerHtml(vm) {
    const text = hostWords(vm.team);
    const banner = text ? inv().statusRow({ tone: TONES[vm.team.state], message: text, ariaLive: 'polite', className: 'team-banner' }) : '';
    const note = vm.errors.head ? '<p class="team-head-note team-set-note" role="status" data-team-head-note>' + escapeHtml(vm.errors.head) + '</p>' : '';
    return banner + note;
  }

  // The frame for one shown channel. Region roots stay for as long as that channel is shown.
  function frameHtml(vm) {
    return '<div class="team-shell" data-team-state="' + escapeHtml(vm.state) + '" data-screen="' + escapeHtml(vm.screen) + '">'
      + '<nav class="team-panel" id="' + PANEL_ID + '" aria-label="' + escapeHtml(jt('team.tab.panelLabel', 'Team and people')) + '">'
      + '<div class="team-slot" data-team-region="panel-head"></div><div class="team-slot" data-team-region="search"></div>'
      + '<div class="team-slot" data-team-region="lists"></div></nav>'
      + '<div class="team-main team-main--chat">'
      + '<div class="team-slot" data-team-region="head"></div>'
      + '<div class="team-slot" data-team-region="banner"></div>'
      + '<div class="team-slot" data-team-region="export"></div>'
      + '<div class="team-notice" data-team-region="notice"></div>'
      + (projectColumn.isPage(vm.channelId) ? '<div class="team-project-root" data-team-region="project"></div>'
        : vm.channelId === channels.OVERVIEW ? '<div class="team-ov" data-team-region="overview"></div>'
          : vm.channelId === channels.NEW || vm.channelId === channels.NEW_CHANNEL ? '<div class="team-pick-root" data-team-region="picker"></div>'
          : '<div class="team-timeline" data-team-region="timeline"></div><div class="team-composer-root" data-team-region="composer"></div>')
      + '</div></div>';
  }

  // ------------------------------------------------------- whole-view states

  // One heading, one paragraph and at most one button (this PC's stopped server is a page of its own: `page`); nothing
  // from the team is shown. A pending team adds one line with this device's key, from main, never from the host.
  function stateContent(vm) {
    const team = vm.team;
    const name = words.teamName(team || { team_name: vm.host && vm.host.team_name });
    const settings = tabButton('open-settings', jt('team.tab.openSettings', 'Open Team settings'));
    // E64: Force local holds this team (or, with no team row, the server here): the owner's state line, no composer.
    if (vm.state === 'force_local' || (!team && vm.host && vm.host.force_local === true)) return { heading: words.forceLocalText(), copy: '', button: settings };
    switch (vm.state) {
      case 'pending':
        return { heading: jt('team.tab.pending.heading', 'Waiting to be let in'),
          // The team's name may not be known yet; that case has its own sentence so every language reads right.
          copy: team.team_name
            ? jt('team.tab.pending.copy', 'Your invite to {team} was accepted on this PC. The owner has to let you in before anything is shown. You can keep using Jenny as usual.', { team: name })
            : jt('team.tab.pending.copyUnnamed', 'Your invite to this team was accepted on this PC. The owner has to let you in before anything is shown. You can keep using Jenny as usual.'),
          key: words.ownKeyText(team),
          button: tabButton('cancel-request', jt('settings.team.joined.cancel', 'Cancel request'), { variant: 'ghost', teamId: team.team_id, disabled: vm.isBusy('leave:' + team.team_id) }) };
      case 'revoked':
        return { heading: jt('team.tab.revoked.heading', 'You no longer have access to {team}', { team: name }),
          copy: jt('team.tab.revoked.copy', 'This device was removed from the team. Your own chats are untouched. To come back, ask the owner for a new invite.'),
          button: tabButton('remove-team', jt('settings.team.joined.remove', 'Remove this team'), { variant: 'ghost', teamId: team.team_id, disabled: vm.isBusy('remove:' + team.team_id) }) };
      case 'update_required':
        return { heading: jt('team.tab.update.heading', 'Update Jenny to open {team}', { team: name }),
          copy: jt('team.tab.update.copy', 'The team’s server runs a newer version than this Jenny. Nothing is lost: update Jenny and it connects again.'), button: '' };
      case 'lost_owner':
        return { heading: jt('team.tab.lost.heading', 'This Jenny is not signed in to its team'),
          copy: jt('team.tab.lost.copy', 'This PC runs the server for {team}, but this Jenny has lost its place in it. Reclaim ownership in Settings.', { team: name }), button: settings };
      default:
        // Row 170: this PC's server, not running, gets a page of its own (renderer-team-server.js). A saved team file that
        // does not load (needs_repair) with no server here says so and points to Settings.
        if (vm.host && vm.host.deployed === true && (!team || serverDown(vm))) return { page: serverPage.tab.pageHtml(vm) };
        return { heading: name, copy: team ? words.repairText(team.reason) : '', button: settings };
    }
  }

  function stateHtml(vm) {
    const content = stateContent(vm);
    if (content.page) return '<div class="team-main">' + content.page + '</div>';
    return '<div class="team-main"><div class="team-state"><h2>' + escapeHtml(content.heading) + '</h2>' + (content.copy ? '<p>' + escapeHtml(content.copy) + '</p>' : '')
      + (content.key ? '<p>' + escapeHtml(content.key) + '</p>' : '') + content.button + settingsView.note(vm.errors.state) + '</div></div>';
  }

  // This PC's own server is not running and the shown team is the one it serves: that row can only be offline, so the
  // server's page stands in for it (in the app the owner's membership loads at launch, so the row is there).
  function serverDown(vm) {
    const host = vm.host;
    return Boolean(vm.team && host && host.deployed === true && host.state !== 'running' && host.team_id === vm.team.team_id);
  }

  // True when the view is one whole-view state rather than a channel.
  function isWhole(vm) { return !vm.team || chatStore.LOCKED_STATES.has(vm.state) || serverDown(vm); }

  // A whole-view state. A gated team shows the column's head only, when there is another team to switch to.
  function shellHtml(vm) {
    const column = vm.team && vm.teamCount > 1
      ? '<nav class="team-panel" id="' + PANEL_ID + '" aria-label="' + escapeHtml(jt('team.tab.panelLabel', 'Team and people')) + '">' + panelHead(vm) + '</nav>' : '';
    return '<div class="team-shell" data-team-state="' + escapeHtml(vm.state) + '"' + (column ? '' : ' data-column="none"') + '>' + column + stateHtml(vm) + '</div>';
  }

  return { shellHtml, frameHtml, panelHeadHtml: panelHead, panelHtml, headHtml, bannerHtml, hostWords, isWhole, teamFact, notifyText, peopleRows };
});
