/* Team tab controller (row 123, slice 1g-2; the team's channel since slice 2a-5a): shows one joined team in the
 * `#teamView` panel. The host state, the teams and the rosters come from the shared team store; the chat from the
 * chat store. This file keeps the tab's own state: which team is shown (kept for the session), the people set aside
 * from the join notice (for this run of the app), the open menus, the narrow-width screen, busy keys and one error
 * sentence per place.
 *
 * Drawing: a connected team gets a frame per shown channel (the column, and the header, banner, notice, timeline and
 * composer regions; the composer and the message actions since slice 2a-5b, with one set of writes). The column, the
 * header, the banner and the notice are rewritten only when their markup changed; the timeline patches itself by
 * message id; none of it replaces another region, so a push never resets scroll, selection or focus. A team behind a
 * gate is one whole-view state. Nothing destructive runs from here: Invite, Team settings and Join open Settings >
 * Team. The exceptions are the two answers a person can only give while locked out (Cancel request, Remove this
 * team) and the owner's Admit and Decline. While hidden it holds no listener and writes nothing. Loaded on the tab's
 * first activation.
 *
 * Threads (slice 2a-6a): one thread column per frame (renderer-team-thread.js), opened from a message's replies
 * button, Reply in thread or R, replaced when another opens (its draft saved first), closed by Close or Esc. The
 * focus goes back to the row that opened it, else to the channel composer. A lock, a `cleared` team, another team or
 * channel close it; a root the host no longer has closes it with one quiet line in the channel.
 * `data-screen="thread"` says a thread is open; under 720 px that is a third screen, and its Back closes the thread.
 *
 * Search and jump: the column's search region (renderer-team-search.js) lives with the frame, so a team change, a
 * lock and hiding end it; a `cleared` team resets it. Ctrl+F anywhere in the view and the header's search button
 * focus its field (under 720 px on the list screen). Results and message-link chips jump through one jumper per
 * frame (renderer-team-link.js); a jump shows the channel screen, or the thread; a `cleared` team cancels a jump in
 * flight; a jump into another channel of the team shows that channel first.
 * Slice 2d: the shown channel per team (renderer-team-channels.js) keys the frame; the New message view
 * (renderer-team-dm-picker.js) is a frame of its own whose Start shows the conversation chatDmOpen answers.
 * Slice 2a-6c: Export ends the team menu, its line fills the export slot; the tab runs palette and toast intents.
 * Slice 3-10: shared projects (renderer-team-project-tab.js): the project store is held while the tab is shown; the
 * column's Projects section, the project page and a shared conversation (frames keyed by `proj:` and `conv:`) follow
 * its changes only, so a chat push repaints no project view and a project push no timeline. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('./renderer-team-tab-view'), require('./renderer-team-store'),
      require('./renderer-team-chat-store'), require('./renderer-team-timeline'), require('./renderer-team-notice'), require('./renderer-team-message-row'),
      require('./renderer-team-chat-writes'), require('./renderer-team-composer'), require('./renderer-team-thread'), require('./renderer-team-search'), require('./renderer-team-link'),
      require('./renderer-team-channels'), require('./renderer-team-dm-picker'), require('./renderer-team-gpus'),
      require('./renderer-team-notify'), require('./renderer-team-export'), require('./renderer-team-tab-focus'), require('./renderer-team-project-tab'));
    return;
  }
  root.rendererTeamTab = factory(root.rendererSettingsTeamStrings, root.rendererTeamTabView, root.rendererTeamStore,
    root.rendererTeamChatStore, root.rendererTeamTimeline, root.rendererTeamNotice, root.rendererTeamMessageRow,
    root.rendererTeamChatWrites, root.rendererTeamComposer, root.rendererTeamThread, root.rendererTeamSearch, root.rendererTeamLink,
    root.rendererTeamChannels, root.rendererTeamDmPicker, root.rendererTeamGpus, root.rendererTeamNotify, root.rendererTeamExport, root.rendererTeamTabFocus,
    root.rendererTeamProjectTab);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, tabView, teamStore, chatStore, timelines, notices, rows, chatWrites, composers, threads, searches, link, channels, pickers, gpus, intents, exporting, focuser, projectTab) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const { SWITCH_ID, CONTROLS } = focuser;
  const CHANNEL = chatStore.CHANNEL_TEAM;
  const LEVELS = ['all', 'mentions', 'none'];

  // `owedFocus`: the control that had the keyboard focus when a redraw disabled it (see `restoreFocus`).
  function freshLive() {
    return { busy: new Set(), errors: {}, menuOpen: false, notifyOpen: false, owedFocus: null, screen: 'channel', noticeId: '', noticeIndex: 0, noticeErrorId: '', wholeHtml: null };
  }

  // The team shown is remembered for the session, also while the tab is hidden; so are the people set aside.
  let selectedTeamId = '';
  let teamTurn = 0; // counts team switches: an answer asked before one writes nothing into the team shown (R13-F02)
  const asideByTeam = new Map();
  let live = freshLive();
  let container = null;
  let openSettings = null;
  let frame = null;
  let releases = [];
  let gpuPop = null; // the GPU row popover while the tab is shown (renderer-team-gpus.js)

  function store() { return teamStore.getTeamStore(); }
  function chat() { return chatStore.getChatStore(); }
  function data() { return store().snapshot(); }
  function alive(s) { return s === live && container !== null; }
  function menuApi() { return (globalThis.inventory && globalThis.inventory.contextMenu) || globalThis.inventoryContextMenu || null; }
  function aside(teamId) { if (!asideByTeam.has(teamId)) asideByTeam.set(teamId, new Set()); return asideByTeam.get(teamId); }
  // A message this frame holds (the window, the thread, the results), for a chip's words.
  function heldMessage(teamId, id) {
    const own = frame && frame.shown.teamId === teamId ? frame : null;
    return chat().timeline(teamId, own ? own.shown.channelId : CHANNEL).list.find((m) => m.id === id) || (own && own.thread && own.thread.messageOf(id))
      || (own && own.search && own.search.messageOf(id)) || null;
  }

  // The teams this tab offers: a needs_repair row (a saved file that does not load) is only in Settings.
  const offered = (team) => Boolean(team) && team.state !== 'needs_repair';
  function offeredTeams() { return data().teams.filter(offered); }

  // The remembered team while it is still joined; else the team hosted here, else the first one.
  function selectedTeam() {
    const teams = offeredTeams();
    return teams.find((team) => team.team_id === selectedTeamId) || store().hostedTeam() || teams[0] || null;
  }

  // ---------------------------------------------------------------- people

  function rosterOf(team) { const own = team ? data().lists[team.team_id] || {} : {}; return own.roster ? own.roster.filter((m) => m.state === 'active') : null; }
  function presenceOf(team, roster) { return channels.withPresence(team ? (chat().team(team.team_id) || {}).members : null, roster); }

  // What a frame's timeline, actions, composer, thread and search read about its team and shown channel
  // (renderer-team-channels.js). A team that left the list reads as locked: no chat call for it.
  function timelineContext(teamId, channelId) {
    const team = data().teams.find((t) => t.team_id === teamId) || null;
    const state = team ? chat().team(teamId) : null;
    return channels.frameContext({ team, teamId, people: team ? presenceOf(team, rosterOf(team)) || rosterOf(team) || [] : [], loaded: Boolean(state && state.loaded),
      channelId, rows: state ? state.channels : [], pending: channels.awaited(teamId, channelId), heldMessage: (id) => heldMessage(teamId, id),
      projectNameOf: (id) => glue.projectNameOf(teamId, id) });
  }

  // Slice 3-10: the tab's shared-project part (renderer-team-project-tab.js).
  const glue = projectTab.createProjectTab({ data, store, chat, words, teamStore, rows, rosterOf, timelineContext, selectedTeam, CHANNEL,
    tab: { container: () => container, frame: () => frame, live: () => live, turn: () => teamTurn, render: (options) => render(options), renderLists: () => renderLists() } });
  // Slice 6-7: the notice's model offers (renderer-team-notice.js), from the gate's model store, held here while shown.
  const modelStore = () => (globalThis.rendererTeamModelStore ? globalThis.rendererTeamModelStore.getModelStore() : null);
  const offers = notices.createOffers({ models: modelStore, openSettings: () => openSettings, render: () => render() });

  function viewModel() {
    const { host } = data();
    const teams = offeredTeams();
    const team = selectedTeam();
    const owned = store().ownedHostedTeam();
    let state = team ? team.state : 'stopped';
    if (!team && host && host.state === 'running' && host.team_id) state = 'lost_owner';
    const roster = rosterOf(team);
    const presence = presenceOf(team, roster);
    const waiting = team ? notices.askedOrder(store().waitingOf(team.team_id)) : [];
    const set = team ? aside(team.team_id) : new Set();
    const own = team ? data().lists[team.team_id] || {} : {};
    const listing = glue.listing(team, channels.listing({ team, chatState: team ? chat().team(team.team_id) : null, contextOf: (id) => timelineContext(team.team_id, id) }));
    return {
      host, team, state, teamCount: teams.length, projects: glue.columnView(team, listing.channelId),
      canAdmit: Boolean(team && owned && owned.team_id === team.team_id),
      aside: waiting.filter((m) => set.has(m.member_id)), queue: waiting.filter((m) => !set.has(m.member_id)),
      people: roster, presence, channelName: (id) => (team && glue.projectNameOf(team.team_id, id)) || channels.channelName(id), ...listing,
      memberCount: presence ? presence.length : (roster ? roster.length : 0), gpus: gpus.viewOf(team, data().pools, presence || roster, data().sharing),
      lastSeen: (value) => rows.lastSeenText(value),
      rosterError: team && team.state === 'online' && own.rosterRead ? own.rosterRead.error : null,
      errors: live.errors, menuOpen: live.menuOpen, notifyOpen: live.notifyOpen, screen: live.screen, searching: Boolean(frame && frame.search && frame.search.active()),
      isBusy: (key) => live.busy.has(key),
    };
  }

  function noticeState(vm) {
    if (!vm.canAdmit) return { person: null };
    const { person, index } = notices.pick(vm.queue, live.noticeId, live.noticeIndex);
    live.noticeId = person ? person.member_id : '';
    live.noticeIndex = index;
    const error = person && live.noticeErrorId === person.member_id ? live.errors.notice : '';
    return { person, index, total: vm.queue.length, isBusy: vm.isBusy, error };
  }

  // ------------------------------------------------------------- focus keys

  // The focus across redraws and the view's keys (renderer-team-tab-focus.js).
  const focus = focuser.createTabFocus({ container: () => container, live: () => live, frame: () => frame,
    openMenu: () => openMenu(), focusSearch: (from) => focusSearch(from) });
  const captureFocus = () => focus.capture();
  const restoreFocus = (state) => focus.restore(state);

  // ---------------------------------------------------------------- render

  // `change`: the chat change that closed the menu, carried into the render that follows (the thread column
  // lives on its records). The flags drop first, so the menu's own onHide renders nothing on its own.
  function closeMenus(restoreFocusTo, change = null) {
    const open = live.menuOpen || live.notifyOpen;
    live.menuOpen = false;
    live.notifyOpen = false;
    const menu = menuApi();
    if (menu && typeof menu.hide === 'function') menu.hide({ restoreFocus: restoreFocusTo });
    if (open) render({ change });
  }

  function destroyFrame() {
    if (frame && frame.search) { frame.search.dispose(); frame.jumper.dispose(); }
    if (frame && frame.picker) frame.picker.dispose();
    if (frame && frame.project) frame.project.dispose();
    if (frame && frame.thread) frame.thread.dispose();
    if (live.screen === 'thread') live.screen = 'channel';
    if (frame && frame.composer) frame.composer.dispose();
    if (frame && frame.timeline) frame.timeline.dispose();
    if (frame && frame.writes) frame.writes.dispose();
    frame = null;
  }

  function buildFrame(vm, key) {
    destroyFrame();
    container.innerHTML = tabView.frameHtml(vm);
    const q = (selector) => container.querySelector(selector);
    const teamId = vm.team.team_id;
    const shown = { teamId, channelId: vm.channelId, chat: chat(), ctx: () => timelineContext(teamId, vm.channelId) };
    const writes = chatWrites.createWrites({ teamId: shown.teamId, onBusy: () => { if (frame && frame.writes === writes) frame.timeline.update({ type: 'busy' }); } });
    const own = { key, shown, shell: q('.team-shell'), panel: q('nav.team-panel'), last: {}, timeline: null, composer: null, thread: null, search: null, picker: null, openerId: '', writes,
      regions: { panelHead: q('[data-team-region="panel-head"]'), lists: q('[data-team-region="lists"]'), head: q('[data-team-region="head"]'),
        banner: q('[data-team-region="banner"]'), notice: q('[data-team-region="notice"]') } };
    frame = own;
    exporting.tabLine().mount(q('[data-team-region="export"]'), teamId, () => (frame === own && own.timeline ? own.timeline.logRoot : null));
    own.jumper = link.createJumper({ chat: shown.chat, teamId, channelId: vm.channelId, call: writes.call, timeline: () => (frame === own ? own.timeline : null),
      openThread: (root) => { openThread(root, root.id); return frame === own ? own.thread : null; },
      showScreen: (name) => { if (frame === own && live.screen !== name) { live.screen = name; render(); } },
      holdEdit: () => Boolean(frame === own && own.timeline && own.timeline.backToEdit()), rowOf: rows.rowOf, elsewhere: (target) => showElsewhere(teamId, target) });
    own.search = searches.createSearch({ root: q('[data-team-region="search"]'), lists: own.regions.lists, panel: own.panel, ctx: shown.ctx, call: writes.call,
      hostWords: () => { const team = data().teams.find((t) => t.team_id === teamId); return team ? tabView.hostWords(team) || words.errorText({ reason: 'team_not_connected' }) : ''; },
      onJump: (match) => own.jumper.jump(match),
      onState: () => { void Promise.resolve().then(() => { if (frame === own) render(); }); } });
    if (glue.isPage(vm.channelId)) { own.project = glue.mount(q('[data-team-region="project"]'), teamId, vm.channelId); return; }
    if (vm.channelId === channels.NEW) {
      own.picker = pickers.createPicker({ root: q('[data-team-region="picker"]'), ctx: shown.ctx, rows: () => (chat().team(teamId) || {}).channels || [],
        lastSeen: rows.lastSeenText, onStart: (ids) => startDirect(teamId, ids), onClose: () => closeNew(teamId) });
      return;
    }
    frame.timeline = timelines.createTimeline({ ...shown, root: q('[data-team-region="timeline"]'), writes, focusComposer: () => Boolean(frame && frame.composer && frame.composer.focus()),
      onReply: (message) => openThread(message, message.id) });
    frame.composer = composers.createComposer({ ...shown, root: q('[data-team-region="composer"]'), writes, onEditLast: () => frame.timeline.editLast() });
  }

  // Writes only what changed. A change under an open menu closes the menu first: its rows may be out of date.
  function render({ keepMenu = false, change = null } = {}) {
    if (!container) return;
    const vm = viewModel();
    store().setShownTeam(vm.team ? vm.team.team_id : '');
    const focus = captureFocus();
    if (tabView.isWhole(vm)) {
      const html = tabView.shellHtml(vm);
      if (frame || html !== live.wholeHtml) {
        if ((live.menuOpen || live.notifyOpen) && !keepMenu) { closeMenus(false, change); return; }
        destroyFrame();
        container.innerHTML = html;
        live.wholeHtml = html;
      }
      restoreFocus(focus);
      return;
    }
    live.wholeHtml = null;
    const key = vm.team.team_id + '|' + vm.channelId;
    const next = { panelHead: tabView.panelHeadHtml(vm), lists: tabView.panelHtml(vm), head: tabView.headHtml(vm), banner: tabView.bannerHtml(vm), notice: notices.noticeHtml(noticeState(vm)) || offers.html(offeredTeams(), vm.team.team_id) };
    if (frame && frame.key === key && (live.menuOpen || live.notifyOpen) && !keepMenu
      && ['panelHead', 'lists', 'head'].some((name) => next[name] !== frame.last[name])) { closeMenus(false, change); return; }
    // A page switch in the same team builds a new frame; the column keeps its scroll.
    const panelTop = frame && frame.key !== key && frame.key.startsWith(vm.team.team_id + '|') ? frame.panel.scrollTop : null;
    if (!frame || frame.key !== key) buildFrame(vm, key);
    if (frame.thread && (frame.shown.ctx().locked || (change && change.type === 'cleared'))) closeThread({ render: false });
    if (change && change.type === 'cleared') frame.jumper.cancel();
    if (frame.shell.dataset.screen !== vm.screen) frame.shell.dataset.screen = vm.screen;
    if (frame.thread && frame.shell.dataset.thread !== 'side') frame.shell.dataset.thread = 'side';
    else if (!frame.thread && frame.shell.dataset.thread) delete frame.shell.dataset.thread;
    if (frame.shell.dataset.teamState !== vm.state) frame.shell.dataset.teamState = vm.state;
    for (const [name, html] of Object.entries(next)) {
      if (frame.last[name] === html) continue;
      frame.regions[name].innerHTML = html;
      frame.last[name] = html;
      if (name === 'lists') glue.afterWrite(frame.regions.lists);
    }
    if (panelTop !== null) frame.panel.scrollTop = panelTop;
    // A project page or conversation draws member names: a roster change reaches it.
    if (frame.project && (!change || change.type === 'members' || change.type === 'team')) frame.project.update({ type: 'roster', team_id: vm.team.team_id });
    // Presence changes the people column only; typing the composer's line only.
    if (frame.timeline && (!change || (change.type !== 'presence' && change.type !== 'typing'))) frame.timeline.update(change || { type: 'team' });
    if (frame.composer) frame.composer.update();
    // The picker's list follows the people and the conversations, never a redraw of its own focus.
    if (frame.picker && change && ['team', 'members', 'presence', 'channels'].includes(change.type)) frame.picker.update();
    if (frame.thread) frame.thread.update(change || { type: 'team' });
    frame.search.update(change || { type: 'team' });
    restoreFocus(focus);
  }

  // Slice 3-10: a project list, activity or request change writes the column's lists (and the head when no menu is
  // open), so an open switcher or notify menu stays open.
  function renderLists() {
    if (!container || !frame) { render(); return; }
    const vm = viewModel();
    if (tabView.isWhole(vm) || frame.key !== vm.team.team_id + '|' + vm.channelId) { render(); return; }
    const focus = captureFocus();
    const next = { lists: tabView.panelHtml(vm), ...(live.menuOpen || live.notifyOpen ? {} : { head: tabView.headHtml(vm) }) };
    for (const [name, html] of Object.entries(next)) {
      if (frame.last[name] === html) continue;
      frame.regions[name].innerHTML = html;
      frame.last[name] = html;
      if (name === 'lists') glue.afterWrite(frame.regions.lists);
    }
    restoreFocus(focus);
  }

  // ---------------------------------------------------------------- threads

  // Threads are one level deep: a reply opens its root's thread. `openerId`: the channel row it came from
  // (null keeps the one already noted). The shown thread is focused again, not read again.
  function openThread(message, openerId) {
    if (!frame || !message) return;
    const rootId = message.thread_root_id || message.id;
    if (openerId) frame.openerId = openerId;
    live.screen = 'thread';
    if (frame.thread && frame.thread.rootId === rootId) { render(); frame.thread.focus(); return; }
    if (frame.thread) frame.thread.dispose(); // its composer saves its draft first
    frame.timeline.setNote('');
    const own = frame;
    frame.thread = threads.createThreadColumn({ ...frame.shown, rootId, shell: frame.shell, writes: frame.writes,
      onClose: () => { if (frame === own) closeThread(); },
      onGone: () => {
        if (frame !== own) return;
        closeThread();
        if (frame === own) frame.timeline.setNote(jt('team.thread.gone', 'That thread is no longer on the host.')); // the render may have replaced it
      },
      onReply: (next) => openThread(next, null) });
    render();
    if (frame === own && frame.thread) frame.thread.focus();
  }

  // The focus goes back to the row that opened the thread, else to the channel composer, when it was in the thread.
  function closeThread({ render: draw = true } = {}) {
    if (!frame || !frame.thread) return;
    const doc = container.ownerDocument;
    const had = frame.thread.root.contains(doc.activeElement);
    frame.thread.dispose();
    frame.thread = null;
    if (live.screen === 'thread') live.screen = 'channel';
    if (draw) render();
    if (!had || !frame) return;
    const row = rows.rowOf(frame.timeline.logRoot, frame.openerId);
    if (row) row.focus(); else frame.composer.focus();
  }

  // ---------------------------------------------------------------- actions

  // One call per key at a time; a failure shows its sentence in `place` and gives the control back. After
  // a success the key stays busy until the lists are read again, so the person answered cannot be answered twice.
  async function run(key, place, method, payload, refresh, memberId = '') {
    const s = live;
    if (s.busy.has(key)) return;
    s.busy.add(key);
    s.errors[place] = '';
    render();
    const answer = await store().call(method, payload);
    if (!alive(s)) return;
    if (!answer.ok) {
      s.busy.delete(key);
      s.errors[place] = words.errorText(answer.error || teamStore.NO_ANSWER);
      if (place === 'notice') s.noticeErrorId = memberId;
      render();
      return;
    }
    try { await (refresh === 'all' ? store().refreshAll() : store().refreshLists()); } finally {
      if (alive(s)) { s.busy.delete(key); render(); }
    }
  }

  // ------------------------------------------------------- direct messages

  // A row in the column, the New message view, a jump's target, or (`others` given) a conversation Start opened, its
  // composer focused: shown in this team (the frame follows). Closing the New message view focuses the composer too.
  function showChannel(teamId, channelId, others = null) {
    glue.leavePage(teamId);
    channels.select(teamId, channelId, others);
    live.screen = 'channel';
    render();
    if (others && frame && frame.composer) frame.composer.focus();
  }
  function closeNew(teamId) { channels.closeNew(teamId); render(); if (frame && frame.composer) frame.composer.focus(); }
  // Start: the conversation answered (new or existing) is shown while its New message view still is (closed, left or
  // another team shown meanwhile: nothing moves; its row still arrives in the list). A refusal is the picker's to say.
  async function startDirect(teamId, ids) {
    const answer = await store().call('chatDmOpen', { team_id: teamId, member_ids: ids });
    const team = container ? selectedTeam() : null;
    if (answer.ok && team && team.team_id === teamId && channels.shownOf(teamId) === channels.NEW) showChannel(teamId, answer.channel_id, ids);
    return answer;
  }
  // A search result or chip in #team or a listed conversation of this team: that channel first, then the jump there.
  function showElsewhere(teamId, target) {
    const state = chat().team(teamId);
    const id = target.channel_id;
    if (!state || !(id === CHANNEL || state.channels.some((c) => channels.isDirect(c) && c.channel_id === id))) return false;
    showChannel(teamId, id);
    if (frame && frame.shown.channelId === id) frame.jumper.jump(target);
    return true;
  }

  function selectTeam(teamId) {
    if (!container) return;
    const before = selectedTeam();
    if (before && before.team_id !== teamId) channels.closeNew(before.team_id);
    selectedTeamId = teamId;
    teamTurn += 1;
    live.errors = {};
    live.screen = 'channel';
    render();
  }

  // The switcher's menu: each team with its mention or unread mark, then Invite someone (owners), Team settings, Join.
  function openMenu() {
    const menu = menuApi();
    const current = selectedTeam();
    if (!menu || typeof menu.show !== 'function' || !current) return;
    live.menuOpen = true;
    render({ keepMenu: true });
    const anchor = container.querySelector('#' + SWITCH_ID);
    const s = live;
    const settings = () => { if (openSettings) openSettings('team'); };
    const mark = (team) => {
      const fact = tabView.teamFact(team, store().isHostedHere(team));
      const channels = (chat().team(team.team_id) || {}).channels || [];
      if (channels.some((c) => c.mention)) return jt('team.tab.menuMention', '{fact} · mentions you', { fact });
      if (channels.some((c) => c.unread > 0 || c.unread_capped)) return jt('team.tab.menuUnread', '{fact} · unread', { fact });
      return fact;
    };
    const items = offeredTeams().map((team) => ({ label: words.teamName(team), description: mark(team), checked: team.team_id === current.team_id,
      value: team.team_id, action: () => selectTeam(team.team_id) })).concat({ separator: true });
    if (current.role === 'owner') items.push({ label: jt('settings.team.invite.heading', 'Invite someone'), value: 'invite', action: settings });
    if (!gpus.viewOf(current, data().pools, null)) items.push({ label: jt('team.gpus.share', 'Share this PC’s GPU…'), value: 'share-gpu', action: () => gpus.openShareSettings(openSettings) });
    items.push({ label: jt('team.tab.teamSettings', 'Team settings'), value: 'settings', action: settings },
      { label: jt('team.tab.joinInvite', 'Join a team with an invite'), value: 'join-invite', action: settings },
      ...exporting.menuItems({ team: current, channelId: viewModel().channelId, onPick: (scope, id) => startExport(current.team_id, scope, id) }));
    menu.show({
      anchorEl: anchor, rootEl: anchor, restoreFocusTo: anchor, focusChecked: true, className: 'team-switch-menu',
      ariaLabel: jt('team.tab.switch', 'Switch team'), items,
      onHide: () => { if (alive(s) && s.menuOpen) { s.menuOpen = false; render(); } },
    });
  }

  async function setNotify(level) {
    const s = live;
    const team = selectedTeam();
    if (!team) return;
    s.errors.head = '';
    const answer = await chat().setNotify(team.team_id, viewModel().channelId, level);
    if (!alive(s)) return;
    if (!answer.ok) s.errors.head = words.errorText(answer.error || teamStore.NO_ANSWER);
    render();
  }

  // The notification level of the shown channel: All messages, Mentions only, Nothing.
  function openNotifyMenu() {
    const menu = menuApi();
    if (!menu || typeof menu.show !== 'function' || !frame) return;
    const level = viewModel().notify;
    live.notifyOpen = true;
    render({ keepMenu: true });
    const anchor = container.querySelector('#teamNotifyButton');
    const s = live;
    menu.show({
      anchorEl: anchor, rootEl: anchor, restoreFocusTo: anchor, focusChecked: true, className: 'team-notify-menu',
      ariaLabel: jt('team.chat.notify.menu', 'Notify me about'),
      items: LEVELS.map((value) => ({ label: tabView.notifyText(value), checked: value === level, value, action: () => { void setNotify(value); } })),
      onHide: () => { if (alive(s) && s.notifyOpen) { s.notifyOpen = false; render(); } },
    });
  }

  function noticeAction(action, memberId) {
    const vm = viewModel();
    if (!vm.canAdmit) return;
    if (action === 'later') {
      if (memberId) aside(vm.team.team_id).add(memberId);
    } else if (vm.queue.length > 1) {
      const step = action === 'prev' ? -1 : 1;
      const index = (live.noticeIndex + step + vm.queue.length) % vm.queue.length;
      live.noticeIndex = index;
      live.noticeId = vm.queue[index].member_id;
    }
    live.errors.notice = '';
    render();
  }

  // Ctrl+F and the header's search button. Under 720 px (Back is shown) the list screen comes first.
  function focusSearch(from) {
    if (!frame) return;
    const back = frame.regions.head.querySelector('.team-back');
    if ((!back || typeof back.checkVisibility !== 'function' || back.checkVisibility()) && live.screen !== 'list') { live.screen = 'list'; render(); }
    if (frame) frame.search.focus(from);
  }

  function onClick(event) {
    const chip = event.target && event.target.closest ? event.target.closest('.team-msglink') : null;
    if (chip && frame && frame.shell.contains(chip)) { frame.jumper.jump(link.chipTarget(chip)); return; }
    const target = event.target && event.target.closest ? event.target.closest(CONTROLS) : null;
    if (!target || target.disabled || !container.contains(target)) return;
    const { teamTabAction, teamAction, teamId, memberId, teamChannel, teamNotice } = target.dataset;
    const team = selectedTeam();
    if (teamChannel) { if (team) showChannel(team.team_id, teamChannel); return; }
    if (teamNotice) { if (!offers.action(teamNotice, target.dataset)) noticeAction(teamNotice, memberId); return; }
    if (teamAction === 'admit' || teamAction === 'decline') {
      if (!team || !memberId) return;
      const place = target.closest('[data-team-region="notice"]') ? 'notice' : 'wants';
      void run(teamAction + ':' + memberId, place, teamAction === 'admit' ? 'memberAdmit' : 'memberRevoke', { team_id: team.team_id, member_id: memberId }, 'lists', memberId);
      return;
    }
    switch (teamTabAction) {
      case 'switch': if (live.menuOpen) closeMenus(true); else openMenu(); return;
      case 'notify': if (live.notifyOpen) closeMenus(true); else openNotifyMenu(); return;
      case 'back': live.screen = 'list'; render(); return;
      case 'dm-new': if (team) { showChannel(team.team_id, channels.NEW); if (frame && frame.picker) frame.picker.focus(); } return;
      case 'dm-close': if (team) closeNew(team.team_id); return;
      case 'search': focusSearch(container.ownerDocument.activeElement); return;
      case 'gpu': if (gpuPop) gpuPop.toggle(target.dataset.teamGpu); return;
      case 'share-settings': gpus.openShareSettings(openSettings); return;
      case 'invite':
      case 'open-settings': if (openSettings) openSettings('team'); return;
      case 'cancel-request': if (teamId) void run('leave:' + teamId, 'state', 'leave', { team_id: teamId }, 'all'); return;
      case 'remove-team': if (teamId) void run('remove:' + teamId, 'state', 'removeTeam', { team_id: teamId }, 'all'); return;
      default: if (team && teamTabAction) glue.action(teamTabAction, target, team);
    }
  }

  // ------------------------------------------------------------- lifecycle

  function onTeams() {
    chat().sync(data().teams);
    glue.sync();
    render();
  }

  function onChat(change) {
    const team = selectedTeam();
    render(team && change && change.team_id === team.team_id ? { change } : {});
  }

  // One export at a time (renderer-team-export.js); the New message view exports #team.
  const startExport = (teamId, scope, id = channels.shownOf(teamId)) => void exporting.getExporter().start({ teamId, scope, channelId: id === channels.NEW ? CHANNEL : id });

  function showTeamTab({ container: next, openSettings: open } = {}) {
    if (!next || typeof next.querySelector !== 'function') return;
    openSettings = typeof open === 'function' ? open : null;
    if (next === container) return;
    if (container) hideTeamTab();
    container = next;
    for (const [type, handler] of [['click', onClick], ['keydown', focus.onKeydown], ['keydown', glue.onField], ['input', glue.onField]]) {
      next.addEventListener(type, handler);
      releases.push(() => next.removeEventListener(type, handler));
    }
    releases.push(store().use({ rosters: 'all' }), store().subscribe(onTeams), chat().use(), chat().subscribe(onChat), ...glue.hold(), () => store().setShownTeam(''),
      () => exporting.tabLine().dispose(), () => offers.reset());
    const models = modelStore();
    if (models) releases.push(models.use(), models.subscribe((change) => { if (change && (change.type === 'state' || change.type === 'gone')) render(); }));
    gpuPop = gpus.mount(next, { viewNow: () => viewModel().gpus, subscribe: (fn) => store().subscribe(fn) }); releases.push(() => { gpuPop.release(); gpuPop = null; });
    chat().sync(data().teams);
    render();
    // Palette and toast intents attach once the tab has drawn, so one asked before it opened finds its frame.
    releases.push(intents.attachTab(intents.tabIntents({ selectTeam, selectedTeamId: () => selectedTeam()?.team_id, showChannel, frame: () => frame,
      focusSearch, teams: () => data().teams, offeredTeams, call: (m, p) => store().call(m, p), exportStart: startExport })));
    void store().refreshAll();
  }

  // Hiding drops the listeners, the store holds, the timeline and the page state; the markup stays as it was.
  function hideTeamTab() {
    if (!container) return;
    const menu = menuApi();
    const menuOpen = live.menuOpen || live.notifyOpen;
    container = null;
    if (menuOpen && menu && typeof menu.hide === 'function') menu.hide({ restoreFocus: false });
    destroyFrame();
    channels.closeAllNew();
    releases.splice(0).forEach((fn) => { try { fn(); } catch (_error) { /* best effort */ } });
    live = freshLive();
  }

  return { showTeamTab, hideTeamTab };
});
