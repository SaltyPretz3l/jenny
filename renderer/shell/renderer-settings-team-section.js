/* Settings > Team (row 123, slice 1g-1): host a team on this PC or join one.
 * The host state, the joined teams, their lists, the bridge call and the two
 * pushes live in the shared team store (renderer/team/renderer-team-store.js,
 * slice 1g-2), which the Team tab uses too; this file keeps the page's own
 * state (busy keys, confirms, the shown code, drafts, activity paging, error
 * sentences) and renders from the store. It holds the store while the section
 * is on screen, asking for the hosted roster, devices, invites and activity,
 * and re-reads after each action of its own. Loaded only when the `team` flag
 * is on (renderer-settings-utils.js `syncTeamSettingsSection`). An invite or
 * device code lives in `live.reveal` until the section is left or another code
 * is made; it is never logged or stored. Every async path keeps the state
 * object it started with and writes nothing once the page was left. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-team-strings'), require('./renderer-settings-team-view'),
      require('./renderer-settings-team-owner-view'), require('../team/renderer-team-store'), require('./renderer-settings-team-gpu'),
      require('./renderer-settings-team-network'), require('./renderer-settings-team-lifecycle'), require('./renderer-settings-team-models'));
    return;
  }
  root.rendererSettingsTeamSection = factory(root.rendererSettingsTeamStrings, root.rendererSettingsTeamView, root.rendererSettingsTeamOwnerView,
    root.rendererTeamStore, root.rendererSettingsTeamGpu, root.rendererSettingsTeamNetwork, root.rendererSettingsTeamLifecycle, root.rendererSettingsTeamModels);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, view, ownerView, teamStore, gpu, network, lifecycle, models) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const ACTIVE_HOST = new Set(['starting', 'running', 'stopping']);
  const ACTIVITY_PAGE = 20;
  const COPIED_MS = 1500;
  const NO_ANSWER = teamStore.NO_ANSWER;

  function freshDrafts() {
    return { displayName: undefined, label: undefined, teamName: '', invite: '', rename: undefined, inviteRole: 'member', inviteTtl: 86_400_000 };
  }
  function freshLive() {
    return { busy: new Set(), confirm: '', reveal: null, copied: false, errors: {}, readErrors: {}, readSeen: {},
      drafts: freshDrafts(), activity: { expanded: false, pages: [], nextCursor: null } };
  }

  // Module state for the one Settings page. The container, listeners and timer stay outside `live`.
  let live = freshLive();
  let container = null;
  let lastHtml = null;
  let copyTimer = null;
  let unsubscribers = [];
  let removeListeners = [];

  function store() { return teamStore.getTeamStore(); }
  function data() { return store().snapshot(); }
  function call(method, payload) { return store().call(method, payload); }
  function refreshLists() { return store().refreshLists(); }
  function refreshAll() { return store().refreshAll(); }
  // The shared export (slice 2a-6c), loaded with this page: Leave offers it first.
  function exporter() { return globalThis.rendererTeamExport ? globalThis.rendererTeamExport.getExporter() : null; }
  // Closing the Leave confirmation or leaving the page stops an export it started that is still gathering; one at
  // the save dialog is left to finish (the dialog has its own Cancel).
  function stopLeaveExport() { const ex = exporter(); if (ex && ex.state().origin === 'leave' && ex.state().phase === 'gathering') ex.cancel(); }
  // Each export step: a new phase redraws the page; a new count only rewrites the running line's words in place.
  let exportPhase = '';
  function onExport(s) {
    const phase = s.origin + ':' + s.phase;
    const line = phase === exportPhase && body() ? body().querySelector('[data-team-export-line]') : null;
    exportPhase = phase;
    if (line && globalThis.rendererTeamExport) { line.textContent = globalThis.rendererTeamExport.lineText(s); return; }
    render();
  }
  function body() { return container ? (container.querySelector('#teamSettingsBody') || container) : null; }
  function okText(value) { return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 40; }
  function alive(s) { return s === live && container !== null; }

  // ------------------------------------------------------------ derivation

  // The names to reuse: the hosted team's when this PC hosted one, else the first joined team's. This PC's name
  // comes from the team row (saved with the membership), else from the device list (read only while online).
  function reusedNames() {
    const { host, teams, lists } = data();
    const source = host && host.deployed ? store().hostedTeam() : teams.find((team) => team.state !== 'needs_repair') || null;
    if (!source) return { displayName: '', label: '' };
    const devices = lists[source.team_id]?.devices || [];
    const mine = devices.find((device) => device.device_id === source.device_id);
    return { displayName: source.display_name || '', label: source.label || (mine && mine.label) || '' };
  }

  // Anyone other than this person who is in the hosted team right now (Stop asks first then).
  function othersActive() {
    const hosted = store().hostedTeam();
    const roster = (hosted && data().lists[hosted.team_id]?.roster) || [];
    return roster.some((member) => member.state === 'active' && member.member_id !== hosted.member_id);
  }

  function statusOf(host, seats) {
    if (!host) return null;
    // E64: while Force local is on the Server line is the state line, deployed or not, the hold's stop included; a
    // deployed team's Start stays, greyed with it (view.button).
    if (host.force_local === true) {
      return { tone: 'blocked', value: words.forceLocalText(), action: host.deployed && host.team_name ? 'start' : null };
    }
    if (lifecycle.keyLost(host)) return lifecycle.status(host); // slice 5-6: a lost key cannot start
    const startable = Boolean(host.team_name);
    switch (host.state) {
      case 'running':
        return { tone: 'ready', value: jt('settings.team.status.running', 'Running on this PC'), action: 'stop',
          note: seats === null ? '' : jt('settings.team.status.seats', '{count} of {max} seats', { count: seats, max: teamStore.MAX_MEMBERS }) };
      case 'starting': return { tone: '', value: jt('settings.team.status.starting', 'Starting…') };
      case 'stopping': return { tone: '', value: jt('settings.team.status.stopping', 'Stopping…') };
      case 'failed':
        return { tone: 'blocked', value: jt('settings.team.status.failed', 'Stopped with a problem'),
          note: words.errorText({ code: 'CMP-TEAM-0006', reason: host.reason }),
          action: startable && host.reason !== 'team_host_platform_unavailable' ? 'start' : null,
          actionDisabled: host.reason === 'team_host_exit_unconfirmed' };
      case 'stopped':
        if (!host.deployed) return null;
        return { tone: 'blocked', value: jt('settings.team.status.stopped', 'Stopped'), action: startable ? 'start' : null,
          note: jt('settings.team.status.stoppedNote', 'Nobody can connect until you start it. Nothing was deleted.'),
          notes: host.reason && host.reason !== 'team_host_stopped' ? [words.errorText({ code: 'CMP-TEAM-0006', reason: host.reason })] : [] };
      default: return { tone: '', value: jt('settings.team.status.unknown', 'Unavailable') };
    }
  }

  function viewModel() {
    const { host, teams, lists: allLists } = data();
    const hosted = store().hostedTeam();
    const lists = hosted ? allLists[hosted.team_id] || {} : {};
    const hosting = Boolean(host && host.state === 'running' && hosted);
    const online = hosting && hosted.state === 'online';
    const reuse = reusedNames();
    const draft = live.drafts;
    // The Remove confirm of a needs_repair row lasts only while that row still needs repair.
    if (live.confirm.startsWith('remove-team:')
      && !teams.some((team) => live.confirm === 'remove-team:' + team.team_id && team.state === 'needs_repair')) live.confirm = '';
    return {
      host, hosting, online, status: statusOf(host, online && lists.roster ? lists.roster.length : null), forceLocal: store().forceLocal(),
      hosted: hosting ? { team: hosted, owner: online && hosted.role === 'owner', roster: lists.roster || null, invites: lists.invites,
        devices: lists.devices, audit: lists.audit } : null,
      joined: teams.filter((team) => team.state === 'needs_repair' || !(host && host.deployed && team.team_id === host.team_id)),
      teamCount: teams.length, maxTeams: teamStore.MAX_TEAMS, maxMembers: teamStore.MAX_MEMBERS,
      needNames: !(reuse.displayName && reuse.label),
      names: { displayName: draft.displayName ?? reuse.displayName, label: draft.label ?? reuse.label },
      showHost: Boolean(host && !host.deployed && !ACTIVE_HOST.has(host.state)),
      stoppedHere: Boolean(host && host.deployed && !hosting),
      reclaim: Boolean(host && host.state === 'running' && host.team_id && !hosted),
      drafts: draft, errors: live.errors, confirm: live.confirm, reveal: live.reveal, copied: live.copied, activity: live.activity,
      isBusy: (key) => live.busy.has(key),
      leaveExport: exporter() && exporter().state().origin === 'leave' ? exporter().state() : null, exportBusy: Boolean(exporter() && exporter().running()),
      exportLineText: globalThis.rendererTeamExport ? globalThis.rendererTeamExport.lineText : null,
      memberRow: network.memberRow, codeEntry: network.codeEntry, inviteLine: network.inviteLine(host),
    };
  }

  // ---------------------------------------------------------------- render

  function pageHtml(vm) {
    const reveal = (teamId) => (live.reveal && live.reveal.kind === 'device' && live.reveal.teamId === teamId ? view.codeBlock(vm, live.reveal) : '');
    let html = view.statusLine(vm) + lifecycle.banner();
    // Slice 4e: Share this PC's GPU sits after Your devices on the owner's page, else after the joined teams.
    // Slice 5-6: Network goes first in that place; the lost-key group replaces People; Delete is the last group.
    const share = gpu.shareGroup(vm, data()) + models.memberGroup(vm, data()); // slice 6-7: a member's Model sharing follows
    const lost = lifecycle.keyLost(vm.host);
    const owner = Boolean(vm.hosted && vm.hosted.owner);
    if (vm.reclaim) html += view.reclaimGroup(vm);
    if (vm.needNames) html += view.youGroup(vm);
    html += lifecycle.lostKeyGroup(vm, data());
    if (vm.hosting && vm.online) {
      html += ownerView.hostedGroups(vm, vm.hosted, (owner ? network.networkGroup(vm, data(), vm.hosted.team) : '') + share + (owner ? gpu.ownerGroups(vm, data(), vm.hosted) + models.hostGroup(vm, data(), vm.hosted) : ''));
    } else if ((vm.hosting || vm.stoppedHere) && !lost) {
      html += view.group('people', jt('settings.team.people.heading', 'People'), {
        copy: vm.hosting ? jt('settings.team.people.connecting', 'People are listed once this Jenny is connected to the server.')
          : jt('settings.team.people.whileRunning', 'Members and invites are listed while the server runs.') });
      if (vm.stoppedHere) html += network.networkGroup(vm, data(), store().hostedTeam());
    }
    vm.restoreHtml = vm.showHost ? lifecycle.restoreRow(vm, data()) : '';
    vm.exportRowHtml = owner ? lifecycle.exportRow(vm, data()) : '';
    html += view.joinedGroup(vm, reveal);
    if (!(vm.hosting && vm.online)) html += share;
    html += vm.teamCount === 0 && vm.showHost ? view.hostGroup(vm) + view.joinGroup(vm) : view.joinGroup(vm) + (vm.showHost ? view.hostGroup(vm) : '');
    if (owner) html += ownerView.ownershipGroup(vm);
    // Fork 8 on the page too: owner (from the live role while it runs, from main's saved membership while stopped), or the key is lost.
    return html + lifecycle.deleteGroup(vm, data(), Boolean(vm.host && vm.host.deployed && (lost || owner || (vm.stoppedHere && vm.host.owner === true))));
  }

  // Writes the page only when its markup changed, so an idle push keeps an open select and the focus.
  function render() {
    const target = body();
    if (!target) return;
    const html = pageHtml(viewModel());
    gpu.after(gpuContext);
    models.after(gpuContext);
    if (html === lastHtml) return;
    const doc = target.ownerDocument;
    const active = doc && doc.activeElement && target.contains(doc.activeElement) ? doc.activeElement : null;
    const focusId = active && active.id;
    const selection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    // A secret field's text (a password, the relay token, a pasted code) is kept by the field only, across the rewrite.
    const secrets = Array.from(target.querySelectorAll('[data-team-secret]'), (el) => [el.id, el.value]).filter((pair) => pair[1]);
    target.innerHTML = html;
    for (const [id, value] of secrets) { const el = doc.getElementById(id); if (el) el.value = value; }
    lastHtml = html;
    const again = focusId ? doc.getElementById(focusId) : null;
    if (again && typeof again.focus === 'function') {
      again.focus({ preventScroll: true });
      if (selection && typeof again.setSelectionRange === 'function') { try { again.setSelectionRange(selection[0], selection[1]); } catch (_error) { /* not a text field */ } }
    }
  }

  // ----------------------------------------------------------------- reads

  // The store's two reads this page shows a sentence for: the host status, and the hosted team's roster.
  function watchedReads() {
    const snapshot = data();
    const hosted = store().hostedTeam();
    const roster = hosted && store().isHostedHere(hosted) ? (snapshot.lists[hosted.team_id] || {}).rosterRead : null;
    return [['status', snapshot.hostRead, 'host'], ['people', roster, hosted ? hosted.team_id : '']];
  }

  // A failed read shows its sentence until the next good read of the same thing clears it. Each read is
  // applied once; `seenOnly` marks what the store already holds when the page opens, so only later reads show.
  function applyReads(seenOnly = false) {
    for (const [group, read, scope] of watchedReads()) {
      const stamp = read ? scope + ':' + read.seq : '';
      if (live.readSeen[group] === stamp) continue;
      live.readSeen[group] = stamp;
      if (seenOnly || !read) continue;
      if (read.error) {
        const text = words.errorText(read.error);
        live.errors[group] = text;
        live.readErrors[group] = text;
      } else {
        if (live.readErrors[group] && live.errors[group] === live.readErrors[group]) live.errors[group] = '';
        live.readErrors[group] = '';
      }
    }
  }

  function onStoreChange() {
    if (!container) return;
    applyReads();
    render();
  }

  // ---------------------------------------------------------------- actions

  // One call per key at a time; a failure shows its sentence in `group` and gives the control back.
  async function run(key, group, task) {
    const s = live;
    if (s.busy.has(key)) return null;
    s.busy.add(key);
    s.errors[group] = '';
    render();
    let answer;
    try {
      answer = await task(s);
    } catch (_error) {
      answer = null;
    }
    afterFirstAct(answer);
    if (!alive(s)) return null;
    s.busy.delete(key);
    const ok = Boolean(answer && answer.ok === true);
    if (!ok) s.errors[group] = words.errorText((answer && answer.error) || NO_ANSWER);
    render();
    return ok ? answer : null;
  }

  // With no team data on disk (E50) the first answered Join, Deploy or Recover ends the quiet state, ok or not and
  // whether the page is still showing: main loaded its team service for it and may have written a team or a host
  // config before answering (or after a timeout). The store follows the pushes and reads once; the shell loads the
  // gate when the answer was ok or that read finds a team, a deployed host or one that is not stopped.
  function afterFirstAct(answer) {
    if (!store().wake()) return;
    const note = () => globalThis.rendererTopNavShellController?.noteTeamData?.();
    if (answer && answer.ok === true) note();
    void refreshAll().then(() => {
      const { teams, host } = data();
      if (teams.length || (host && (host.deployed === true || host.state !== 'stopped'))) note();
    });
  }

  function names(group) {
    const vm = viewModel();
    if (!okText(vm.names.displayName) || !okText(vm.names.label)) {
      live.errors[vm.needNames ? 'you' : group] = words.errorText({ reason: 'team_display_name_invalid' });
      render();
      return null;
    }
    return { display_name: vm.names.displayName.trim(), label: vm.names.label.trim() };
  }

  function applyOwnerOutcome(s, answer, group) {
    if (answer.host && alive(s)) store().seed({ host: answer.host });
    const outcome = answer.owner;
    if (outcome && outcome.state === 'failed' && outcome.error && outcome.error.reason !== 'team_owner_recover_needed') {
      s.errors[group] = words.errorText(outcome.error);
    }
  }

  async function deploy(name, key, group) {
    const who = names(group);
    if (!who) return;
    const s = live;
    const answer = await run(key, group, () => call('hostDeploy', { name, display_name: who.display_name, label: who.label }));
    if (!answer) return;
    applyOwnerOutcome(s, answer, group === 'host' ? 'status' : group);
    if (key === 'deploy') s.drafts.teamName = '';
    await refreshAll();
  }

  async function join() {
    const invite = String(live.drafts.invite || '').trim();
    if (!invite || invite.length > 512) { live.errors.join = words.errorText({ reason: 'team_invite_malformed' }); render(); return; }
    const who = names('join');
    if (!who) return;
    const s = live;
    const answer = await run('join', 'join', () => call('join', { invite, display_name: who.display_name, label: who.label }));
    if (!answer) return;
    s.drafts.invite = '';
    await refreshAll();
    // Joining ends in the Team tab (membership spec M15): the shell opens it once the tab exists.
    if (alive(s)) globalThis.rendererTopNavShellController?.openTeamView?.({ wait: true });
  }

  function showCode(s, reveal) {
    if (!alive(s)) return;
    s.reveal = reveal;
    s.copied = false;
  }

  async function createInvite(team) {
    const s = live;
    if (s.busy.has('invite-create')) return;
    s.reveal = null;
    let created = false;
    await run('invite-create', 'invite', async () => {
      const made = await call('inviteCreate', { team_id: team.team_id, role: s.drafts.inviteRole, ttl_ms: s.drafts.inviteTtl });
      if (!made.ok) return made;
      created = true;
      const revealed = await call('inviteReveal', { team_id: team.team_id, invite_id: made.invite_id });
      if (revealed.ok && typeof revealed.invite === 'string') {
        showCode(s, { kind: 'invite', teamId: team.team_id, code: revealed.invite, expiresAt: made.expires_at });
      }
      return revealed;
    });
    // Also after a failed reveal, so the unused invite is listed and can be revoked.
    if (created && alive(s)) await refreshLists();
  }

  async function deviceInvite(teamId, group) {
    const s = live;
    const key = 'device-invite:' + teamId;
    if (s.busy.has(key)) return;
    s.reveal = null;
    const answer = await run(key, group, () => call('deviceInvite', { team_id: teamId }));
    if (answer && typeof answer.invite === 'string') showCode(s, { kind: 'device', teamId, code: answer.invite, expiresAt: answer.expires_at });
    if (alive(s)) render();
  }

  // Runs a host command, then re-reads: the lists only, or everything when the host or the team set may change.
  async function command(key, group, method, payload, { after = null, refresh = 'lists' } = {}) {
    const s = live;
    const answer = await run(key, group, () => call(method, payload));
    if (!answer) return;
    if (after) after(answer, s);
    await (refresh === 'all' ? refreshAll() : refreshLists());
  }

  function stopHost() {
    const s = live;
    void run('stop', 'status', () => call('hostStop')).then((answer) => {
      if (!answer || !alive(s)) return;
      s.confirm = '';
      if (answer.host) store().seed({ host: answer.host });
      void refreshAll();
    });
  }

  function openMore(button, memberId) {
    const hosted = store().hostedTeam();
    const member = (data().lists[hosted && hosted.team_id]?.roster || []).find((m) => m.member_id === memberId);
    const menu = (globalThis.inventory && globalThis.inventory.contextMenu) || globalThis.inventoryContextMenu;
    if (!member || !menu || typeof menu.show !== 'function') return;
    const ask = (confirm) => () => { live.confirm = confirm; render(); };
    menu.show({ anchorEl: button, rootEl: button, ariaLabel: jt('settings.team.people.more', 'More for {name}', { name: member.display_name }),
      items: [
        { label: jt('settings.team.people.makeOwner', 'Make {name} the owner…', { name: member.display_name }), action: ask('owner:' + memberId) },
        { label: jt('settings.team.people.remove', 'Remove from team…'), danger: true, action: ask('remove:' + memberId) },
      ] });
  }

  // Removing this PC, or the last device, asks first; any other device goes at once.
  function revokeDevice(teamId, deviceId) {
    const team = data().teams.find((t) => t.team_id === teamId);
    const own = view.ownDevicesOf(team, data().lists[teamId]?.devices);
    if (own.length <= 1 || (team && deviceId === team.device_id)) { live.confirm = 'device:' + deviceId; render(); return; }
    void command('device-revoke:' + deviceId, 'devices', 'deviceRevoke', { team_id: teamId, device_id: deviceId });
  }

  function copyCode() {
    const s = live;
    const code = s.reveal && s.reveal.code;
    const write = (typeof window !== 'undefined' && window.jennyShell?.clipboard?.writeText) || null;
    if (!code || typeof write !== 'function') return;
    Promise.resolve(write(code)).then(() => {
      if (!alive(s) || !s.reveal || s.reveal.code !== code) return;
      s.copied = true;
      render();
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyTimer = null; if (alive(s)) { s.copied = false; render(); } }, COPIED_MS);
    }, () => {});
  }

  // What the GPU groups (renderer-settings-team-gpu.js) may use of this page.
  const gpuContext = {
    data, call, run, hostedTeam: () => store().hostedTeam(), confirm: () => live.confirm,
    setConfirm: (value) => { live.confirm = value; },
    render: (force = false) => { if (force) lastHtml = null; render(); },
    // Slice 5-6 (network and lifecycle): a secret is read from its field when used, never kept in `live`.
    seed: (value) => store().seed(value), refreshAll, names,
    secret: (id) => { const el = body() && body().querySelector('#' + id); return el ? String(el.value || '') : ''; },
    setNote: (group, text) => { live.errors[group] = text; },
  };

  function onClick(event) {
    if (gpu.onClick(event, gpuContext) || models.onClick(event, gpuContext) || network.onClick(event, gpuContext) || lifecycle.onClick(event, gpuContext)) return;
    const segment = event.target.closest && event.target.closest('[data-inv-segmented="teamInviteRole"] [data-value]');
    if (segment) { live.drafts.inviteRole = segment.getAttribute('data-value') === 'read_only' ? 'read_only' : 'member'; render(); return; }
    const button = event.target.closest && event.target.closest('[data-team-action]');
    if (!button || button.disabled) return;
    const { teamAction: action, teamId, memberId, deviceId, inviteId } = button.dataset;
    const hosted = store().hostedTeam();
    const hostedId = hosted && hosted.team_id;
    const done = (_answer, s) => { s.confirm = ''; };
    switch (action) {
      case 'deploy':
        if (!okText(live.drafts.teamName)) { live.errors.host = words.errorText({ reason: 'team_name_invalid' }); render(); return; }
        void deploy(live.drafts.teamName.trim(), 'deploy', 'host'); return;
      case 'start': void deploy(data().host && data().host.team_name, 'start', 'status'); return;
      case 'stop':
        if (othersActive()) { live.confirm = 'stop:' + (button.closest('[data-team-group="ownership"]') ? 'ownership' : 'status'); render(); return; }
        stopHost(); return;
      case 'confirm-stop': stopHost(); return;
      case 'join': void join(); return;
      case 'rename': {
        const name = live.drafts.rename ?? (hosted && hosted.team_name);
        if (!okText(name)) { live.errors.rename = words.errorText({ reason: 'team_name_invalid' }); render(); return; }
        void command('rename', 'rename', 'rename', { team_id: hostedId, name: name.trim() }, { after: (_a, s) => { s.drafts.rename = undefined; } }); return;
      }
      case 'invite-create': if (hosted) void createInvite(hosted); return;
      case 'invite-revoke': void command('invite-revoke:' + inviteId, 'invite', 'inviteRevoke', { team_id: hostedId, invite_id: inviteId }); return;
      case 'admit': void command('admit:' + memberId, 'people', 'memberAdmit', { team_id: hostedId, member_id: memberId }); return;
      case 'decline': void command('decline:' + memberId, 'people', 'memberRevoke', { team_id: hostedId, member_id: memberId }); return;
      case 'more': openMore(button, memberId); return;
      case 'confirm-cancel': stopLeaveExport(); live.confirm = ''; render(); return;
      case 'confirm-remove': void command('remove:' + memberId, 'people', 'memberRevoke', { team_id: hostedId, member_id: memberId }, { after: done }); return;
      case 'confirm-owner': void command('owner:' + memberId, 'people', 'ownerTransfer', { team_id: hostedId, member_id: memberId }, { after: done }); return;
      case 'device-invite': void deviceInvite(teamId, teamId === hostedId ? 'devices' : 'joined'); return;
      case 'device-revoke': revokeDevice(teamId, deviceId); return;
      case 'confirm-device': void command('device-revoke:' + deviceId, 'devices', 'deviceRevoke', { team_id: teamId, device_id: deviceId }, { after: done }); return;
      case 'leave': live.confirm = 'leave:' + teamId; render(); return;
      case 'leave-export': if (exporter()) void exporter().start({ teamId, scope: 'all', origin: 'leave' }); return;
      case 'leave-export-cancel': if (exporter()) exporter().cancel(); return;
      case 'confirm-leave': void command('leave:' + teamId, 'joined', 'leave', { team_id: teamId }, { after: done, refresh: 'all' }); return;
      case 'cancel-request': void command('leave:' + teamId, 'joined', 'leave', { team_id: teamId }, { refresh: 'all' }); return;
      case 'remove-team':
        // A needs_repair row deletes this PC's saved file and key: it asks first.
        if ((data().teams.find((team) => team.team_id === teamId) || {}).state === 'needs_repair') { live.confirm = 'remove-team:' + teamId; render(); return; }
        void command('remove:' + teamId, 'joined', 'removeTeam', { team_id: teamId }, { refresh: 'all' }); return;
      case 'confirm-remove-team':
        // Acted on only while the row still needs repair; a team that healed meanwhile keeps its file.
        if ((data().teams.find((team) => team.team_id === teamId) || {}).state !== 'needs_repair') { live.confirm = ''; render(); return; }
        void command('remove:' + teamId, 'joined', 'removeTeam', { team_id: teamId }, { after: done, refresh: 'all' }); return;
      case 'recover': live.confirm = 'recover'; render(); return;
      case 'confirm-recover': {
        const who = names('reclaim');
        if (!who) return;
        void command('confirm-recover', 'reclaim', 'hostRecover', who,
          { after: (answer, s) => { s.confirm = ''; applyOwnerOutcome(s, answer, 'reclaim'); }, refresh: 'all' }); return;
      }
      case 'copy-code': copyCode(); return;
      case 'activity-all': live.activity = { expanded: true, pages: [], nextCursor: 0 }; void loadActivity(hostedId); return;
      case 'activity-more': void loadActivity(hostedId); return;
      case 'activity-less': live.activity = { expanded: false, pages: [], nextCursor: null }; render(); return;
      default:
    }
  }

  async function loadActivity(teamId) {
    const s = live;
    const cursor = s.activity.nextCursor;
    if (!teamId || cursor === null) return;
    const answer = await run('activity', 'activity', () => call('auditRead', { team_id: teamId, cursor, limit: ACTIVITY_PAGE }));
    if (!answer || !Array.isArray(answer.entries) || !alive(s)) return;
    s.activity.pages = s.activity.pages.concat(answer.entries);
    s.activity.nextCursor = answer.next_cursor ?? null;
    render();
  }

  const DRAFT_FIELDS = { teamYourName: 'displayName', teamPcName: 'label', teamNewName: 'teamName', teamInviteCode: 'invite', teamTeamName: 'rename' };

  function onInput(event) {
    if (network.onInput(event, gpuContext) || lifecycle.onInput(event, gpuContext)) return;
    const field = DRAFT_FIELDS[event.target && event.target.id];
    if (field) live.drafts[field] = String(event.target.value || '');
  }

  function onChange(event) {
    const target = event.target;
    if (!target || gpu.onChange(event, gpuContext) || models.onChange(event, gpuContext)) return;
    if (target.id === 'teamInviteExpiry') { live.drafts.inviteTtl = Number(target.value) || 86_400_000; return; }
    const memberId = target.dataset && target.dataset.memberId;
    if (memberId && target.tagName === 'SELECT') {
      const role = target.value === 'read_only' ? 'read_only' : 'member';
      const hosted = store().hostedTeam();
      if (hosted) void command('role:' + memberId, 'people', 'memberSetRole', { team_id: hosted.team_id, member_id: memberId, role });
    }
  }

  // ------------------------------------------------------------- lifecycle

  // `teamData: false` (main found no team data on disk, E50): the store holds the empty answers and
  // nothing is asked of main or subscribed until the first action succeeds.
  function showTeamSection({ container: next, teamData } = {}) {
    if (!next || typeof next.querySelector !== 'function') return;
    if (next === container) return;
    if (container) leaveTeamSection();
    container = next;
    lastHtml = null;
    for (const [type, handler] of [['click', onClick], ['input', onInput], ['change', onChange]]) {
      container.addEventListener(type, handler);
      removeListeners.push(() => next.removeEventListener(type, handler));
    }
    const quiet = teamData === false && store().startQuiet?.() === true;
    // Holding the store subscribes its pushes; what it already read shows at once, then everything is re-read.
    unsubscribers.push(store().use({ rosters: 'hosted', devices: true, ownerLists: true }), store().subscribe(onStoreChange));
    if (exporter()) unsubscribers.push(exporter().subscribe(onExport));
    applyReads(true);
    render();
    if (!quiet) void refreshAll();
  }

  // Leaving drops everything the section held: any shown code, drafts, confirms and lists.
  function leaveTeamSection() {
    stopLeaveExport();
    unsubscribers.splice(0).forEach((fn) => { try { fn(); } catch (_error) { /* best effort */ } });
    removeListeners.splice(0).forEach((fn) => fn());
    clearTimeout(copyTimer);
    copyTimer = null;
    gpu.reset();
    models.reset();
    network.reset();
    lifecycle.reset();
    const target = body();
    if (target) target.innerHTML = '';
    live = freshLive();
    lastHtml = null;
    container = null;
  }

  return { showTeamSection, leaveTeamSection, get _live() { return live; } };
});
