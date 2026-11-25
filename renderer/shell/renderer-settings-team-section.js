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
      require('./renderer-settings-team-network'), require('./renderer-settings-team-lifecycle'), require('./renderer-settings-team-models'), require('../team/renderer-team-server'), require('./renderer-settings-team-files'));
    return;
  }
  root.rendererSettingsTeamSection = factory(root.rendererSettingsTeamStrings, root.rendererSettingsTeamView, root.rendererSettingsTeamOwnerView,
    root.rendererTeamStore, root.rendererSettingsTeamGpu, root.rendererSettingsTeamNetwork, root.rendererSettingsTeamLifecycle, root.rendererSettingsTeamModels, root.rendererTeamServer, root.rendererSettingsTeamFiles);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, view, ownerView, teamStore, gpu, network, lifecycle, models, serverRows, files) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const ACTIVE_HOST = new Set(['starting', 'running', 'stopping']);
  const ACTIVITY_PAGE = 20;
  const COPIED_MS = 1500;
  const NO_ANSWER = teamStore.NO_ANSWER;
  const server = serverRows.settings; // row 170: This server and the You rows

  function freshDrafts() {
    return { displayName: undefined, label: undefined, teamName: '', invite: '', rename: undefined, inviteRole: 'member', inviteTtl: 86_400_000 };
  }
  function freshLive() {
    return { busy: new Set(), folds: new Set(), confirm: '', reveal: null, copied: false, errors: {}, readErrors: {}, readSeen: {},
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

  function viewModel() {
    const { host, teams, lists: allLists } = data();
    const hosted = store().hostedTeam();
    const lists = hosted ? allLists[hosted.team_id] || {} : {};
    const hosting = Boolean(host && host.state === 'running' && hosted);
    const online = hosting && hosted.state === 'online';
    // H20: this PC's own place in the team it runs was revoked: the owner can reclaim it here, and the team is listed to remove.
    const revokedHostedId = hosted && hosted.state === 'revoked' ? hosted.team_id : '';
    const reuse = reusedNames();
    const draft = live.drafts;
    // The Remove confirm of a needs_repair row lasts only while that row still needs repair.
    if (live.confirm.startsWith('remove-team:')
      && !teams.some((team) => live.confirm === 'remove-team:' + team.team_id && team.state === 'needs_repair')) live.confirm = '';
    return {
      host, hosting, online, revokedHostedId, status: lifecycle.hostStatus(host, online && lists.roster ? lists.roster.length : null, teamStore.MAX_MEMBERS), forceLocal: store().forceLocal(),
      hosted: hosting ? { team: hosted, owner: online && hosted.role === 'owner', roster: lists.roster || null, invites: lists.invites,
        devices: lists.devices, audit: lists.audit } : null,
      joined: teams.filter((team) => team.state === 'needs_repair' || team.team_id === revokedHostedId || !(host && host.deployed && team.team_id === host.team_id)),
      teamCount: teams.length, maxTeams: teamStore.MAX_TEAMS, maxMembers: teamStore.MAX_MEMBERS,
      needNames: !(reuse.displayName && reuse.label),
      names: { displayName: draft.displayName ?? reuse.displayName, label: draft.label ?? reuse.label },
      showHost: Boolean(host && !host.deployed && !ACTIVE_HOST.has(host.state)),
      stoppedHere: Boolean(host && host.deployed && !hosting),
      reclaim: Boolean(host && host.state === 'running' && host.team_id && (!hosted || revokedHostedId)),
      // OD-7: Deploy cannot work on this platform, as the host state says (`desktop_hosting`, or the platform reason).
      platformBlocked: Boolean(host && (host.desktop_hosting === false || host.reason === 'team_host_platform_unavailable')),
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
    // Slice 4e: Share this PC's GPU sits after Your devices on the owner's page, else after the joined teams.
    // Slice 5-6: Network goes first in that place; the lost-key group replaces People; Delete is the last group.
    const shareGpu = gpu.shareGroup(vm, data());
    const share = shareGpu + models.memberGroup(vm, data()); // slice 6-7: a member's Model sharing follows
    const lost = lifecycle.keyLost(vm.host);
    const owner = Boolean(vm.hosted && vm.hosted.owner);
    // Row 168: the connected owner's page opens with a summary line and folds its rarely used groups. A fold is open
    // when the person opened it or something in it must be seen: a confirm, a note, a running export.
    const isOpen = (id, groupHtml) => live.folds.has(id) || /team-set-confirm|team-set-note/.test(groupHtml)
      || ((id === 'ownership' || id === 'delete') && vm.isBusy('export'));
    const fold = owner ? (id, groupHtml) => view.fold(id, groupHtml, isOpen) : (id, groupHtml) => groupHtml;
    const net = owner ? network.networkGroup(vm, data(), vm.hosted.team) : '';
    const summary = owner ? view.summaryLine(ownerView.summaryFacts(vm, vm.hosted, data(), { network: net !== '', share: shareGpu !== '' })) : '';
    let html = view.statusLine(vm) + summary + lifecycle.banner();
    if (vm.reclaim) html += view.reclaimGroup(vm);
    if (vm.needNames) html += view.youGroup(vm);
    html += lifecycle.lostKeyGroup(vm, data()) + server.groupHtml(vm) + server.profileHtml(vm, data()) + (vm.teamCount ? densityHtml() : '');
    if (vm.hosting && vm.online) {
      html += ownerView.hostedGroups(vm, vm.hosted, net + share + (owner ? view.foldLast('use', gpu.ownerGroups(vm, data(), vm.hosted), isOpen) + models.hostGroup(vm, data(), vm.hosted) + files.hostGroup(vm, data(), vm.hosted) : ''), fold);
    } else if ((vm.hosting || vm.stoppedHere) && !lost && !vm.revokedHostedId) {
      html += view.group('people', jt('settings.team.people.heading', 'People'), {
        copy: vm.hosting ? jt('settings.team.people.connecting', 'People are listed once this Jenny is connected to the server.')
          : jt('settings.team.people.whileRunning', 'Members and invites are listed while the server runs.') });
      if (vm.stoppedHere) html += network.networkGroup(vm, data(), store().hostedTeam()) + files.hostGroup(vm, data(), vm.host.owner === true ? { stopped: true } : null);
    }
    vm.restoreHtml = vm.showHost ? lifecycle.restoreRow(vm, data()) : '';
    vm.exportRowHtml = owner ? lifecycle.exportRow(vm, data()) : '';
    html += view.joinedGroup(vm, reveal);
    if (!(vm.hosting && vm.online)) html += share;
    const joinHtml = fold('join', view.joinGroup(vm));
    html += vm.teamCount === 0 && vm.showHost ? view.hostGroup(vm) + joinHtml : joinHtml + (vm.showHost ? view.hostGroup(vm) : '');
    if (owner) html += fold('ownership', ownerView.ownershipGroup(vm));
    // Fork 8 on the page too: owner (from the live role while it runs, from main's saved membership while stopped), or the key is lost.
    return html + fold('delete', lifecycle.deleteGroup(vm, data(), Boolean(vm.host && vm.host.deployed && (lost || owner || (vm.stoppedHere && vm.host.owner === true)))));
  }

  // Row 193 C14: Team chat density (saved with Appearance, bound by the Settings view); it shows the density applied to the page.
  function densityHtml() {
    const binding = globalThis.rendererSettingsFieldBinding || require('./renderer-settings-field-binding');
    const descriptors = globalThis.rendererSettingsFieldDescriptors || require('./renderer-settings-field-descriptors');
    const descriptor = descriptors.getSettingDescriptor('appearanceTeamDensitySelect');
    const applied = globalThis.document && globalThis.document.documentElement.dataset.teamDensity;
    return '<div class="settings-group team-set-group" data-team-group="density">' + binding.renderSettingRow(descriptor, descriptors.normalizeSettingValue(descriptor, applied), {}) + '</div>';
  }

  // Writes the page only when its markup changed, so an idle push keeps an open select and the focus.
  function render() {
    const target = body();
    if (!target) return;
    const html = pageHtml(viewModel());
    gpu.after(gpuContext);
    models.after(gpuContext);
    server.ensure(render);
    if (html === lastHtml) return;
    const doc = target.ownerDocument;
    const refocus = view.keepFocus(target);
    // A secret field's text (a password, the relay token, a pasted code) is kept by the field only, across the rewrite.
    const secrets = Array.from(target.querySelectorAll('[data-team-secret]'), (el) => [el.id, el.value]).filter((pair) => pair[1]);
    target.innerHTML = html;
    for (const [id, value] of secrets) { const el = doc.getElementById(id); if (el) el.value = value; }
    lastHtml = html;
    refocus();
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
    teamStore.afterFirstAct(store(), answer); // E50: the first answered act ends the quiet start
    if (!alive(s)) return null;
    s.busy.delete(key);
    const ok = Boolean(answer && answer.ok === true);
    if (!ok) s.errors[group] = words.errorText((answer && answer.error) || NO_ANSWER);
    render();
    return ok ? answer : null;
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

  // A removed device cannot be brought back from here (it needs a new code), so every removal asks first.
  function revokeDevice(deviceId) {
    live.confirm = 'device:' + deviceId;
    live.opener = '[data-team-action="device-revoke"][data-device-id="' + deviceId + '"]';
    render();
  }

  // Cancel or Escape: the strip closes and focus goes back to the button that opened it.
  function cancelConfirm() {
    stopLeaveExport(); live.confirm = ''; render();
    const opener = live.opener && body().querySelector(live.opener);
    live.opener = '';
    if (opener) opener.focus({ preventScroll: true });
  }
  // Enter presses a form's own button; Escape closes the export form, else the confirm strip it is in.
  function onKeydown(event) {
    if (view.submitOnEnter(event)) return;
    if (event.key !== 'Escape' || !event.target.closest) return;
    if (lifecycle.onEscape(event, gpuContext)) { event.stopPropagation(); return; }
    if (!live.confirm || !event.target.closest('.team-set-confirm')) return;
    event.stopPropagation();
    cancelConfirm();
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

  // A fold's own `toggle` (it does not bubble) keeps `live.folds`, so a redraw writes the `open` the person left.
  function onToggle(event) {
    const el = event.target;
    const id = el && el.tagName === 'DETAILS' ? el.getAttribute('data-team-fold') : null;
    if (id) { if (el.open) live.folds.add(id); else live.folds.delete(id); }
  }

  function onClick(event) {
    const jump = event.target.closest && event.target.closest('[data-team-jump]');
    if (jump) { event.preventDefault(); const opened = view.revealGroup(body(), jump.getAttribute('data-team-jump')); if (opened) live.folds.add(opened); return; }
    if (gpu.onClick(event, gpuContext) || models.onClick(event, gpuContext) || files.onClick(event, gpuContext) || network.onClick(event, gpuContext) || lifecycle.onClick(event, gpuContext)) return;
    const segment = event.target.closest && event.target.closest('[data-inv-segmented="teamInviteRole"] [data-value]');
    if (segment) { live.drafts.inviteRole = segment.getAttribute('data-value') === 'read_only' ? 'read_only' : 'member'; render(); return; }
    const button = event.target.closest && event.target.closest('[data-team-action]');
    if (!button || button.disabled) return;
    const { teamAction: action, teamId, memberId, deviceId, inviteId } = button.dataset;
    if (server.action(action, { render, target: button })) return;
    const hosted = store().hostedTeam();
    const hostedId = hosted && hosted.team_id;
    const done = (_answer, s) => { s.confirm = ''; s.opener = ''; };
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
        void command('rename', 'rename', 'rename', { team_id: hostedId, name: name.trim() }, { after: (_a, s) => { s.drafts.rename = undefined; }, refresh: 'all' }); return; // the name is in the team row and the host status
      }
      case 'invite-create': if (hosted) void createInvite(hosted); return;
      case 'invite-revoke': void command('invite-revoke:' + inviteId, 'invite', 'inviteRevoke', { team_id: hostedId, invite_id: inviteId }); return;
      case 'admit': void command('admit:' + memberId, 'people', 'memberAdmit', { team_id: hostedId, member_id: memberId }); return;
      case 'decline': void command('decline:' + memberId, 'people', 'memberRevoke', { team_id: hostedId, member_id: memberId }); return;
      case 'more': openMore(button, memberId); return;
      case 'confirm-cancel': cancelConfirm(); return;
      case 'confirm-remove': void command('remove:' + memberId, 'people', 'memberRevoke', { team_id: hostedId, member_id: memberId }, { after: done }); return;
      case 'confirm-owner': void command('owner:' + memberId, 'people', 'ownerTransfer', { team_id: hostedId, member_id: memberId }, { after: done }); return;
      case 'device-invite': void deviceInvite(teamId, teamId === hostedId ? 'devices' : 'joined'); return;
      case 'device-revoke': revokeDevice(deviceId); return;
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
    if (network.onInput(event, gpuContext) || lifecycle.onInput(event, gpuContext) || server.onInput(event, { render })) return;
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
    for (const [type, handler, capture] of [['click', onClick], ['input', onInput], ['change', onChange], ['keydown', onKeydown], ['toggle', onToggle, true]]) {
      container.addEventListener(type, handler, capture === true);
      removeListeners.push(() => next.removeEventListener(type, handler, capture === true));
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
    files.reset();
    network.reset();
    lifecycle.reset();
    server.reset();
    const target = body();
    if (target) target.innerHTML = '';
    live = freshLive();
    lastHtml = null;
    container = null;
  }

  return { showTeamSection, leaveTeamSection, get _live() { return live; } };
});
