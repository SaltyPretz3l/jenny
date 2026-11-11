/* Settings > Team (row 123, slice 1g-1): host a team on this PC or join one.
 * Reads `team.hostStatus` and `team.status`, and for a team hosted here that
 * is online its roster, invites, devices and activity; listens to
 * `team.onHostState` and `team.onState` while the section is on screen and
 * re-reads after each action of its own (no polling timer). Loaded only when
 * the `team` flag is on (renderer-settings-utils.js `syncTeamSettingsSection`).
 * An invite or device code lives in `live.reveal` until the section is left or
 * another code is made; it is never logged or stored. Every async path keeps
 * the state object it started with and writes nothing once the page was left. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-team-strings'), require('./renderer-settings-team-view'),
      require('./renderer-settings-team-owner-view'));
    return;
  }
  root.rendererSettingsTeamSection = factory(root.rendererSettingsTeamStrings, root.rendererSettingsTeamView, root.rendererSettingsTeamOwnerView);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, view, ownerView) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const ACTIVE_HOST = new Set(['starting', 'running', 'stopping']);
  const AUDIT_PAGE = 100;
  const AUDIT_PAGES_PER_REFRESH = 3;
  const AUDIT_KEPT = 100;
  const ACTIVITY_PAGE = 20;
  const COPIED_MS = 1500;
  const NO_ANSWER = Object.freeze({ code: 'CMP-TEAM-0001', reason: '' });

  function freshDrafts() {
    return { displayName: undefined, label: undefined, teamName: '', invite: '', rename: undefined, inviteRole: 'member', inviteTtl: 86_400_000 };
  }
  function freshLive() {
    return { host: null, teams: [], lists: {}, busy: new Set(), confirm: '', reveal: null, copied: false, errors: {}, readErrors: {},
      drafts: freshDrafts(), activity: { expanded: false, pages: [], nextCursor: null }, listsRun: null, listsAgain: false };
  }

  // Module state for the one Settings page. The container, listeners and timer stay outside `live`.
  let live = freshLive();
  let container = null;
  let lastHtml = null;
  let copyTimer = null;
  let unsubscribers = [];
  let removeListeners = [];

  function bridge() { return (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.team) || null; }
  function body() { return container ? (container.querySelector('#teamSettingsBody') || container) : null; }
  function okText(value) { return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 40; }
  function alive(s) { return s === live && container !== null; }

  // ------------------------------------------------------------ derivation

  function hostedTeam(s = live) {
    const id = s.host && s.host.team_id;
    return id ? s.teams.find((team) => team.team_id === id) || null : null;
  }

  // The names to reuse: the hosted team's when this PC hosted one, else the first joined team's.
  function reusedNames() {
    const source = live.host && live.host.deployed ? hostedTeam() : live.teams[0] || null;
    if (!source) return { displayName: '', label: '' };
    const devices = live.lists[source.team_id]?.devices || [];
    const mine = devices.find((device) => device.device_id === source.device_id);
    return { displayName: source.display_name || '', label: (mine && mine.label) || '' };
  }

  // Anyone other than this person who is in the hosted team right now (Stop asks first then).
  function othersActive() {
    const hosted = hostedTeam();
    const roster = (hosted && live.lists[hosted.team_id]?.roster) || [];
    return roster.some((member) => member.state === 'active' && member.member_id !== hosted.member_id);
  }

  function statusOf(host, seats) {
    if (!host) return null;
    const startable = Boolean(host.team_name);
    switch (host.state) {
      case 'running':
        return { tone: 'ready', value: jt('settings.team.status.running', 'Running on this PC'), action: 'stop',
          note: seats === null ? '' : jt('settings.team.status.seats', '{count} of 8 seats', { count: seats }) };
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
    const host = live.host;
    const hosted = hostedTeam();
    const lists = hosted ? live.lists[hosted.team_id] || {} : {};
    const hosting = Boolean(host && host.state === 'running' && hosted);
    const online = hosting && hosted.state === 'online';
    const reuse = reusedNames();
    const draft = live.drafts;
    return {
      host, hosting, online, status: statusOf(host, online && lists.roster ? lists.roster.length : null),
      hosted: hosting ? { team: hosted, owner: online && hosted.role === 'owner', roster: lists.roster || null, invites: lists.invites,
        devices: lists.devices, audit: lists.audit } : null,
      joined: live.teams.filter((team) => !(host && host.deployed && team.team_id === host.team_id)),
      teamCount: live.teams.length,
      needNames: !(reuse.displayName && reuse.label),
      names: { displayName: draft.displayName ?? reuse.displayName, label: draft.label ?? reuse.label },
      showHost: Boolean(host && !host.deployed && !ACTIVE_HOST.has(host.state)),
      stoppedHere: Boolean(host && host.deployed && !hosting),
      reclaim: Boolean(host && host.state === 'running' && host.team_id && !hosted),
      drafts: draft, errors: live.errors, confirm: live.confirm, reveal: live.reveal, copied: live.copied, activity: live.activity,
      isBusy: (key) => live.busy.has(key),
    };
  }

  // ---------------------------------------------------------------- render

  function pageHtml(vm) {
    const reveal = (teamId) => (live.reveal && live.reveal.kind === 'device' && live.reveal.teamId === teamId ? view.codeBlock(vm, live.reveal) : '');
    let html = view.statusLine(vm);
    if (vm.reclaim) html += view.reclaimGroup(vm);
    if (vm.needNames) html += view.youGroup(vm);
    if (vm.hosting && vm.online) html += ownerView.hostedGroups(vm, vm.hosted);
    else if (vm.hosting || vm.stoppedHere) {
      html += view.group('people', jt('settings.team.people.heading', 'People'), {
        copy: vm.hosting ? jt('settings.team.people.connecting', 'People are listed once this Jenny is connected to the server.')
          : jt('settings.team.people.whileRunning', 'Members and invites are listed while the server runs.') });
    }
    html += view.joinedGroup(vm, reveal);
    html += vm.teamCount === 0 && vm.showHost ? view.hostGroup(vm) + view.joinGroup(vm) : view.joinGroup(vm) + (vm.showHost ? view.hostGroup(vm) : '');
    if (vm.hosted && vm.hosted.owner) html += ownerView.ownershipGroup(vm);
    return html;
  }

  // Writes the page only when its markup changed, so an idle push keeps an open select and the focus.
  function render() {
    const target = body();
    if (!target) return;
    const html = pageHtml(viewModel());
    if (html === lastHtml) return;
    const doc = target.ownerDocument;
    const active = doc && doc.activeElement && target.contains(doc.activeElement) ? doc.activeElement : null;
    const focusId = active && active.id;
    const selection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    target.innerHTML = html;
    lastHtml = html;
    const again = focusId ? doc.getElementById(focusId) : null;
    if (again && typeof again.focus === 'function') {
      again.focus({ preventScroll: true });
      if (selection && typeof again.setSelectionRange === 'function') { try { again.setSelectionRange(selection[0], selection[1]); } catch (_error) { /* not a text field */ } }
    }
  }

  // ----------------------------------------------------------------- reads

  // A rejected call, a missing method and an answer without `ok` all read as a failed answer.
  function call(method, payload) {
    const api = bridge();
    const failed = { ok: false, error: NO_ANSWER };
    if (!api || typeof api[method] !== 'function') return Promise.resolve(failed);
    return Promise.resolve(payload === undefined ? api[method]() : api[method](payload))
      .then((answer) => (answer && typeof answer === 'object' && typeof answer.ok === 'boolean' ? answer : failed), () => failed);
  }

  // A failed read shows its sentence until the next good read of the same thing clears it.
  function readFailed(s, group, error) {
    const text = words.errorText(error);
    s.errors[group] = text;
    s.readErrors[group] = text;
  }
  function readOk(s, group) {
    if (s.readErrors[group] && s.errors[group] === s.readErrors[group]) s.errors[group] = '';
    s.readErrors[group] = '';
  }

  // Reads forward from the cursor; an entry at or below the cursor found after an await is already listed.
  async function readAudit(teamId, lists) {
    for (let page = 0; page < AUDIT_PAGES_PER_REFRESH; page += 1) {
      const answer = await call('auditRead', { team_id: teamId, cursor: lists.auditCursor || 0, limit: AUDIT_PAGE });
      if (!answer.ok || !Array.isArray(answer.entries)) return;
      const floor = lists.auditCursor || 0;
      const fresh = answer.entries.filter((entry) => Number(entry.seq) > floor);
      if (fresh.length) {
        lists.audit = (lists.audit || []).concat(fresh).slice(-AUDIT_KEPT);
        lists.auditCursor = Number(fresh[fresh.length - 1].seq);
      }
      if (answer.next_cursor === null || answer.next_cursor === undefined || !fresh.length) return;
    }
  }

  async function readTeam(s, team, hosted) {
    const id = team.team_id;
    const lists = s.lists[id] || (s.lists[id] = {});
    const reads = [call('deviceList', { team_id: id }).then((a) => { if (a.ok) lists.devices = a.devices; })];
    if (hosted) {
      reads.push(call('members', { team_id: id }).then((a) => {
        if (a.ok) { lists.roster = a.members; readOk(s, 'people'); } else readFailed(s, 'people', a.error);
      }));
    }
    if (hosted && team.role === 'owner') {
      reads.push(call('inviteList', { team_id: id }).then((a) => { if (a.ok) lists.invites = a.invites; }));
      reads.push(readAudit(id, lists));
    }
    await Promise.all(reads);
  }

  async function readLists(s) {
    const host = s.host;
    await Promise.all(s.teams.filter((team) => team.state === 'online').map((team) =>
      readTeam(s, team, Boolean(host && host.state === 'running' && host.team_id === team.team_id))));
  }

  // One list refresh at a time: a request during a run asks for exactly one more run after it.
  function refreshLists() {
    const s = live;
    if (s.listsRun) { s.listsAgain = true; return s.listsRun; }
    s.listsRun = (async () => {
      do {
        s.listsAgain = false;
        await readLists(s);
        if (!alive(s)) return;
        render();
      } while (s.listsAgain);
    })().finally(() => { s.listsRun = null; });
    return s.listsRun;
  }

  async function refreshAll() {
    const s = live;
    const [hostAnswer, statusAnswer] = await Promise.all([call('hostStatus'), call('status')]);
    if (!alive(s)) return;
    if (hostAnswer.ok) { s.host = hostAnswer.host; readOk(s, 'status'); } else readFailed(s, 'status', hostAnswer.error);
    if (statusAnswer.ok && Array.isArray(statusAnswer.teams)) s.teams = statusAnswer.teams.slice(0, view.MAX_TEAMS);
    render();
    await refreshLists();
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
    if (answer.host) s.host = answer.host;
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
    if (!invite || invite.length > 256) { live.errors.join = words.errorText({ reason: 'team_invite_malformed' }); render(); return; }
    const who = names('join');
    if (!who) return;
    const s = live;
    const answer = await run('join', 'join', () => call('join', { invite, display_name: who.display_name, label: who.label }));
    if (!answer) return;
    s.drafts.invite = '';
    await refreshAll();
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
      s.host = answer.host || s.host;
      void refreshAll();
    });
  }

  function openMore(button, memberId) {
    const hosted = hostedTeam();
    const member = (live.lists[hosted && hosted.team_id]?.roster || []).find((m) => m.member_id === memberId);
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
    const team = live.teams.find((t) => t.team_id === teamId);
    const own = view.ownDevicesOf(team, live.lists[teamId]?.devices);
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

  function onClick(event) {
    const segment = event.target.closest && event.target.closest('[data-inv-segmented="teamInviteRole"] [data-value]');
    if (segment) { live.drafts.inviteRole = segment.getAttribute('data-value') === 'read_only' ? 'read_only' : 'member'; render(); return; }
    const button = event.target.closest && event.target.closest('[data-team-action]');
    if (!button || button.disabled) return;
    const { teamAction: action, teamId, memberId, deviceId, inviteId } = button.dataset;
    const hosted = hostedTeam();
    const hostedId = hosted && hosted.team_id;
    const done = (_answer, s) => { s.confirm = ''; };
    switch (action) {
      case 'deploy':
        if (!okText(live.drafts.teamName)) { live.errors.host = words.errorText({ reason: 'team_name_invalid' }); render(); return; }
        void deploy(live.drafts.teamName.trim(), 'deploy', 'host'); return;
      case 'start': void deploy(live.host && live.host.team_name, 'start', 'status'); return;
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
      case 'confirm-cancel': live.confirm = ''; render(); return;
      case 'confirm-remove': void command('remove:' + memberId, 'people', 'memberRevoke', { team_id: hostedId, member_id: memberId }, { after: done }); return;
      case 'confirm-owner': void command('owner:' + memberId, 'people', 'ownerTransfer', { team_id: hostedId, member_id: memberId }, { after: done }); return;
      case 'device-invite': void deviceInvite(teamId, teamId === hostedId ? 'devices' : 'joined'); return;
      case 'device-revoke': revokeDevice(teamId, deviceId); return;
      case 'confirm-device': void command('device-revoke:' + deviceId, 'devices', 'deviceRevoke', { team_id: teamId, device_id: deviceId }, { after: done }); return;
      case 'leave': live.confirm = 'leave:' + teamId; render(); return;
      case 'confirm-leave': void command('leave:' + teamId, 'joined', 'leave', { team_id: teamId }, { after: done, refresh: 'all' }); return;
      case 'cancel-request': void command('leave:' + teamId, 'joined', 'leave', { team_id: teamId }, { refresh: 'all' }); return;
      case 'remove-team': void command('remove:' + teamId, 'joined', 'removeTeam', { team_id: teamId }, { refresh: 'all' }); return;
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
    const field = DRAFT_FIELDS[event.target && event.target.id];
    if (field) live.drafts[field] = String(event.target.value || '');
  }

  function onChange(event) {
    const target = event.target;
    if (!target) return;
    if (target.id === 'teamInviteExpiry') { live.drafts.inviteTtl = Number(target.value) || 86_400_000; return; }
    const memberId = target.dataset && target.dataset.memberId;
    if (memberId && target.tagName === 'SELECT') {
      const role = target.value === 'read_only' ? 'read_only' : 'member';
      const hosted = hostedTeam();
      if (hosted) void command('role:' + memberId, 'people', 'memberSetRole', { team_id: hosted.team_id, member_id: memberId, role });
    }
  }

  // ------------------------------------------------------------- lifecycle

  function showTeamSection({ container: next } = {}) {
    if (!next || typeof next.querySelector !== 'function') return;
    if (next === container) return;
    if (container) leaveTeamSection();
    container = next;
    lastHtml = null;
    for (const [type, handler] of [['click', onClick], ['input', onInput], ['change', onChange]]) {
      container.addEventListener(type, handler);
      removeListeners.push(() => next.removeEventListener(type, handler));
    }
    const api = bridge();
    if (api) {
      const push = (fn) => { if (typeof fn === 'function') unsubscribers.push(fn); };
      if (typeof api.onState === 'function') {
        push(api.onState((payload) => {
          if (payload && Array.isArray(payload.teams)) live.teams = payload.teams.slice(0, view.MAX_TEAMS);
          render();
          void refreshLists();
        }));
      }
      if (typeof api.onHostState === 'function') {
        push(api.onHostState((host) => { if (host && typeof host === 'object') live.host = host; render(); void refreshLists(); }));
      }
    }
    render();
    void refreshAll();
  }

  // Leaving drops everything the section held: any shown code, drafts, confirms and lists.
  function leaveTeamSection() {
    unsubscribers.splice(0).forEach((fn) => { try { fn(); } catch (_error) { /* best effort */ } });
    removeListeners.splice(0).forEach((fn) => fn());
    clearTimeout(copyTimer);
    copyTimer = null;
    const target = body();
    if (target) target.innerHTML = '';
    live = freshLive();
    lastHtml = null;
    container = null;
  }

  return { showTeamSection, leaveTeamSection, get _live() { return live; } };
});
