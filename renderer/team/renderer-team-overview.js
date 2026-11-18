/* The Team tab's Overview page (row 168, slice S2; owner-approved mockup team-overview, layout A, one column): what needs
 * the owner, the server, seats, joining, GPU sharing, the people and the latest activity, each with at most one
 * action. It does not replace Settings > Team: it is the quick view, and every deeper control stays in Settings behind a
 * link. The pseudo channel id `channels.OVERVIEW` shows it in the main area; it is never sent to the host, marked read or
 * persisted (no timeline or composer is built for it).
 *
 * Sections, in order: Needs you (the connected owner of a team hosted here, while people wait), Server and sharing (the
 * owner's facts) or You in this team (a member's), People, Recent activity (owner only). The facts, rows and sentences are
 * Settings' own (renderer-settings-team-owner-view.js, -view.js, -strings.js); the calls are the ones Settings makes.
 *
 * `createOverview` is one page per frame: it holds the store while shown (`use`: the hosted roster, the devices and the
 * owner's lists for the audit) and gives it back in `dispose`, which also drops the invite code and every draft. Drawing
 * patches by key: a section, a fact or a row is rewritten only when its markup changed, so focus, an open dropdown and
 * the chosen invite options survive a store push. The invite code lives only in this page's state: never logged, stored
 * or kept after the page is left. Loaded with the tab's scripts (renderer-settings-script-manifest.js `teamTab`). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('../shell/renderer-settings-team-view'),
      require('../shell/renderer-settings-team-owner-view'), require('./renderer-team-channels'), require('./renderer-team-gpus'), require('./renderer-team-store'));
    return;
  }
  root.rendererTeamOverview = factory(root.rendererSettingsTeamStrings, root.rendererSettingsTeamView, root.rendererSettingsTeamOwnerView,
    root.rendererTeamChannels, root.rendererTeamGpus, root.rendererTeamStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, view, ownerView, channels, gpus, teamStore) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const DAY_MS = 86_400_000;
  const TTLS = [3_600_000, DAY_MS, 604_800_000];
  const PREVIEW = 5;
  const COPIED_MS = 1500;
  const ROLE_ID = 'teamOvInviteRole';
  const EXPIRY_ID = 'teamOvInviteExpiry';
  const SHARE_ID = 'teamOvShare';

  function inv() { return globalThis.inventory || {}; }
  function segmented() { return inv().segmentedControl || globalThis.inventorySegmentedControl || {}; }

  // ------------------------------------------------------------ the default

  // The tab opens on Overview when the team has only this person in it. Decided once per team for the session, when the
  // roster (active members) is first read, so a pick the person made later is never taken back.
  const decided = new Set();
  function applyDefault(team, roster) {
    if (!team || team.state !== 'online' || !roster || decided.has(team.team_id)) return;
    decided.add(team.team_id);
    if (team.role === 'owner' && roster.length === 1) channels.select(team.team_id, channels.OVERVIEW);
  }
  // A page the person picked: the default no longer applies to this team.
  function decide(teamId) { decided.add(teamId); }

  // ---------------------------------------------------------------- markup

  function link(label) { return inv().actionButton({ plain: true, className: 'team-ov__link', label, dataset: { 'team-tab-action': 'open-settings' } }); }

  function head(key, title, count = '', action = '') {
    return '<div class="team-ov__h"><h3 id="teamOvH-' + key + '">' + escapeHtml(title) + (count ? ' <span>' + escapeHtml(count) + '</span>' : '') + '</h3>' + action + '</div>';
  }

  // One fact: what it is, what it is now (600 weight, an optional muted second line) and at most one action.
  function fact(key, label, value, second = '', action = '', labelId = '') {
    return { key, html: '<li class="team-ov-fact" data-ov-key="' + key + '"><span class="team-ov-fact__k"' + (labelId ? ' id="' + labelId + '"' : '') + '>' + escapeHtml(label) + '</span>'
      + '<span class="team-ov-fact__v"><span class="team-ov-fact__main">' + escapeHtml(value) + '</span>'
      + (second ? '<span class="team-ov-fact__sub">' + escapeHtml(second) + '</span>' : '') + '</span><span class="team-ov-fact__a">' + action + '</span></li>' };
  }
  function wide(key, html) { return { key, html: '<li class="team-ov-fact team-ov-fact--wide" data-ov-key="' + key + '"><div class="team-ov-fact__wide">' + html + '</div></li>' }; }

  // ------------------------------------------------------------ the controller

  // `root`: the region (`data-team-region="overview"`); `viewNow()`: the tab's view model; `peopleRows(vm)`: the People
  // section's rows, `[{ key, html }]` (the tab view draws them, as it does the column's).
  function createOverview({ root, teamId, store, viewNow, openSettings, peopleRows }) {
    const doc = root.ownerDocument;
    const s = { busy: new Set(), errors: {}, confirm: '', inviteOpen: false, draft: { role: 'member', ttl: DAY_MS }, reveal: null, copied: false, owed: null };
    let disposed = false;
    let copyTimer = null;
    const release = store.use({ rosters: 'hosted', devices: true, ownerLists: true });
    root.innerHTML = '<div class="team-ov__page" data-ov-page></div>';
    const pageEl = root.firstElementChild;
    void store.refreshLists();

    function model(given) {
      const vm = given || viewNow();
      const team = vm.team;
      if (!team || team.team_id !== teamId) return null;
      const data = store.snapshot();
      const lists = data.lists[teamId] || {};
      const owned = store.ownedHostedTeam();
      return { vm, team, data, lists, roster: lists.roster || null, owner: Boolean(owned && owned.team_id === teamId), waiting: vm.waiting || [] };
    }
    const helpers = () => ({ forceLocal: store.forceLocal(), isBusy: (key) => s.busy.has(key), confirm: s.confirm, copied: s.copied });

    // ---------------------------------------------------------------- the facts

    function gpuFacts(m) {
      const { team, data, vm } = m;
      const out = [];
      const readOnly = team.role === 'read_only';
      const mine = data.sharing && data.sharing.team_id === teamId ? data.sharing : null;
      const reason = store.forceLocal() ? words.forceLocalText() : readOnly ? jt('settings.team.gpu.readOnly', 'Read-only members cannot share a GPU. The owner can change your role.') : '';
      const toggle = inv().toggleSwitch({ id: SHARE_ID, domId: SHARE_ID, bare: true, labelledBy: 'teamOvGpuLabel', checked: !readOnly && Boolean(mine),
        disabled: Boolean(reason) || s.busy.has('share'), ...(reason ? { tooltip: reason } : {}) });
      out.push(fact('gpu', jt('settings.team.summary.gpu', 'This PC’s GPU'), mine && !readOnly ? jt('team.ov.gpuShared', 'Shared with the team') : jt('settings.team.summary.notShared', 'Not shared'),
        reason || (mine ? jt('team.ov.gpuFirst', 'your own chats always go first') : ''), toggle, 'teamOvGpuLabel'));
      if (data.pools && Object.hasOwn(data.pools, teamId)) {
        const list = gpus.viewOf(team, data.pools, vm.presence || vm.people, data.sharing);
        const first = list && list.rows[0];
        out.push(fact('gpus', jt('settings.team.gpu.teamGpus', 'Team GPUs'), list ? jt('team.ov.gpusShared', '{count} shared', { count: list.all }) : jt('team.ov.gpusNone', 'None shared'),
          first ? jt('team.ov.gpuLine', '{name} · {state}', { name: first.name, state: first.word || jt('team.ov.gpuReady', 'ready') }) : ''));
      }
      return out;
    }

    function deviceFact(m) {
      const summary = ownerView.summaryFacts({ host: m.data.host, maxMembers: teamStore.MAX_MEMBERS }, { team: m.team, roster: null, devices: m.lists.devices }, m.data, { network: false, share: false });
      const devices = summary.find((item) => item.id === 'devices');
      if (!devices) return [];
      const here = view.ownDevicesOf(m.team, m.lists.devices).find((device) => device.device_id === m.team.device_id);
      const label = (here && here.label) || m.team.label || '';
      return [fact('devices', devices.label, devices.value, label ? jt('team.ov.thisPc', '{label} (this PC)', { label }) : '', link(jt('team.ov.manage', 'Manage')))];
    }

    function ownerFacts(m, b) {
      const out = [];
      out.push(fact('server', jt('settings.team.status.label', 'Server'), jt('settings.team.status.running', 'Running on this PC'), jt('team.ov.serverNote', 'runs while Jenny is open'),
        view.button(b, 'stop', jt('settings.team.status.stop', 'Stop'))));
      if (s.confirm === 'stop:overview') out.push(wide('server-confirm', view.stopConfirm(b, 'overview')));
      if (m.roster) {
        const waiting = m.roster.filter((member) => member.state === 'pending').length;
        const solo = m.roster.filter((member) => member.state === 'active').length <= 1 && !waiting;
        out.push(fact('seats', jt('team.ov.seats', 'Seats'), jt('settings.team.people.count', '{count} of {max}', { count: m.roster.length, max: teamStore.MAX_MEMBERS }),
          waiting ? jt('team.ov.seatsWaiting', '{count} waiting to be let in', { count: waiting }) : solo ? jt('team.ov.onlyYou', 'only you so far') : '',
          s.inviteOpen ? '' : view.button(b, 'ov-invite', jt('settings.team.invite.heading', 'Invite someone'), { variant: solo ? 'primary' : 'secondary' })));
        if (s.inviteOpen) out.push(inviteRow(b));
      }
      const network = ownerView.summaryFacts({ host: m.data.host, maxMembers: teamStore.MAX_MEMBERS }, { team: m.team, roster: null, devices: null }, m.data, { network: true, share: false }).find((item) => item.id === 'network');
      if (network) out.push(fact('joining', network.label, network.value, '', link(jt('team.ov.networkSettings', 'Network settings'))));
      return out.concat(gpuFacts(m), deviceFact(m));
    }

    function memberFacts(m) {
      const owner = (m.vm.people || []).find((member) => member.role === 'owner');
      const connected = m.team.state === 'online' ? jt('team.ov.connected', 'Connected') : words.connectionText(m.team.state).replace(/^./, (c) => c.toUpperCase());
      return [fact('connection', jt('team.ov.connection', 'Connection'), connected, owner ? jt('team.ov.hostedBy', 'hosted by {owner}', { owner: owner.display_name }) : ''),
        fact('role', jt('team.ov.role', 'Your role'), words.roleText(m.team.role))].concat(gpuFacts(m), deviceFact(m));
    }

    // The options under Seats: the role, the expiry, Create and Cancel (Settings' own controls and sentences), then the code.
    function inviteRow(b) {
      const labels = { 3600000: jt('settings.team.invite.hour', 'Expires in 1 hour'), 86400000: jt('settings.team.invite.day', 'Expires in 1 day'),
        604800000: jt('settings.team.invite.week', 'Expires in 7 days') };
      const controls = '<div class="team-set-inline">'
        + segmented()({ id: ROLE_ID, ariaLabel: jt('settings.team.invite.role', 'Role for the new person'), value: s.draft.role,
          options: [{ value: 'member', label: words.roleText('member') }, { value: 'read_only', label: words.roleText('read_only') }] })
        + inv().selectField({ id: EXPIRY_ID, ariaLabel: jt('settings.team.invite.expiry', 'When the invite expires'), value: String(s.draft.ttl),
          options: TTLS.map((ms) => ({ value: String(ms), label: labels[ms] })) })
        + view.button(b, 'invite-create', jt('settings.team.invite.create', 'Create invite'), { variant: s.reveal ? 'secondary' : 'primary' })
        + view.button(b, 'ov-invite-cancel', jt('settings.team.cancel', 'Cancel')) + '</div>';
      return wide('invite', controls + (s.reveal ? view.codeBlock(b, s.reveal) : ''));
    }

    function activityRows(m) {
      const nameOf = (id) => {
        if (!id) return '';
        if (id === m.team.member_id) return jt('settings.team.activity.you', 'You');
        return ((m.roster || []).find((member) => member.member_id === id) || {}).display_name || '';
      };
      const entries = (m.lists.audit || []).slice(-PREVIEW).reverse();
      if (!entries.length) return [{ key: 'empty', html: '<li class="team-ov__empty" data-ov-key="empty">' + escapeHtml(jt('settings.team.activity.empty', 'Nothing has happened yet.')) + '</li>' }];
      return entries.map((entry) => ({ key: 'a:' + entry.seq, html: '<li data-ov-key="a:' + escapeHtml(String(entry.seq)) + '"><time>' + escapeHtml(words.formatTime(entry.at)) + '</time><span>'
        + escapeHtml(words.activityText(entry, nameOf)) + '</span></li>' }));
    }

    // The page as sections: `{ key, head, ulClass, items: [{ key, html }], note }`, in page order.
    function build(m) {
      const b = helpers();
      const out = [];
      if (m.owner && m.waiting.length) {
        out.push({ key: 'needs', head: head('needs', jt('team.ov.needs', 'Needs you'), String(m.waiting.length)), ulClass: 'team-set-list',
          items: m.waiting.map((member) => ({ key: 'w:' + member.member_id, html: channels.withAttrs(ownerView.pendingRow(b, member), { 'data-ov-key': 'w:' + member.member_id }) })),
          note: view.note(s.errors.needs) });
      }
      out.push({ key: 'facts', head: head('facts', m.owner ? jt('team.ov.serverSharing', 'Server and sharing') : jt('team.ov.you', 'You in this team')), ulClass: 'team-ov-facts',
        items: m.owner ? ownerFacts(m, b) : memberFacts(m), note: view.note(s.errors.server || s.errors.invite || s.errors.share) });
      const people = peopleRows(m.vm);
      if (people) {
        const count = m.roster ? jt('settings.team.people.count', '{count} of {max}', { count: m.roster.length, max: teamStore.MAX_MEMBERS })
          + (m.owner && m.waiting.length ? ' · ' + jt('settings.team.people.waiting', '{count} waiting', { count: m.waiting.length }) : '') : '';
        out.push({ key: 'people', head: head('people', jt('settings.team.people.heading', 'People'), count, m.owner ? link(jt('team.ov.rolesRemoval', 'Roles and removal')) : ''),
          ulClass: 'team-ov-people', items: people, note: '' });
      }
      if (m.owner) {
        out.push({ key: 'activity', head: head('activity', jt('team.ov.recent', 'Recent activity'), '', link(jt('team.ov.allActivity', 'All activity'))), ulClass: 'team-ov-log',
          items: activityRows(m), note: '' });
      }
      return out;
    }

    // --------------------------------------------------------------- patching

    function fragment(html) {
      const holder = doc.createElement('template');
      holder.innerHTML = html;
      return holder.content.firstElementChild;
    }
    // `el` goes after `prev` (or first) in `parent`; an element already there is left alone, so it keeps its focus.
    function place(parent, el, prev) {
      const want = prev ? prev.nextElementSibling : parent.firstElementChild;
      if (want !== el) parent.insertBefore(el, want);
    }
    function slot(el, html) {
      if (el.__ov === html) return;
      el.innerHTML = html;
      el.__ov = html;
    }
    function sync(parent, items) {
      const have = new Map(Array.from(parent.children).map((el) => [el.dataset.ovKey, el]));
      let prev = null;
      for (const item of items) {
        let el = have.get(item.key);
        have.delete(item.key);
        if (!el || el.__ov !== item.html) {
          const next = fragment(item.html);
          next.__ov = item.html;
          if (el) el.replaceWith(next); else parent.appendChild(next);
          el = next;
        }
        place(parent, el, prev);
        prev = el;
      }
      for (const el of have.values()) el.remove();
    }
    function patch(sections) {
      const have = new Map(Array.from(pageEl.children).map((el) => [el.dataset.ovSec, el]));
      let prev = null;
      for (const section of sections) {
        let el = have.get(section.key);
        have.delete(section.key);
        if (!el) {
          el = fragment('<section class="team-ov__sec" data-ov-sec="' + section.key + '" aria-labelledby="teamOvH-' + section.key + '"><div data-ov-head></div>'
            + '<ul class="' + section.ulClass + '" data-ov-list></ul><div data-ov-note></div></section>');
        }
        place(pageEl, el, prev);
        slot(el.querySelector('[data-ov-head]'), section.head);
        sync(el.querySelector('[data-ov-list]'), section.items);
        slot(el.querySelector('[data-ov-note]'), section.note);
        prev = el;
      }
      for (const el of have.values()) el.remove();
    }

    // The control with the focus is the same one after a rewrite when its id, action, person, value and place match.
    const keyOf = (el) => ({ id: el.id || '', a: el.dataset.teamAction || '', t: el.dataset.teamTabAction || '', m: el.dataset.memberId || '', v: el.dataset.value || '',
      i: (el.closest('[data-ov-key]') || { dataset: {} }).dataset.ovKey || (el.closest('[data-ov-sec]') || { dataset: {} }).dataset.ovSec || '' });
    const sameKey = (a, b) => Object.keys(a).every((name) => a[name] === b[name]);
    function refocus(key) {
      const next = Array.from(root.querySelectorAll('button, select')).find((el) => sameKey(keyOf(el), key));
      if (!next) return false;
      if (next.disabled) { s.owed = key; return true; }
      s.owed = null;
      next.focus({ preventScroll: true });
      return true;
    }

    function update(vm) {
      if (disposed) return;
      const m = model(vm);
      if (!m) return;
      const active = doc.activeElement;
      const had = active && active !== doc.body && root.contains(active) ? keyOf(active) : null;
      patch(build(m));
      if (had && !root.contains(doc.activeElement)) refocus(had);
      else if (!had && s.owed && (!doc.activeElement || doc.activeElement === doc.body)) refocus(s.owed);
    }

    // The options and the code after a draft change the controls already show: nothing to rewrite.
    function remember(key) {
      const m = model();
      const item = m && build(m).flatMap((section) => section.items).find((entry) => entry.key === key);
      const el = item && root.querySelector('[data-ov-key="' + key + '"]');
      if (el) el.__ov = item.html;
    }

    // ---------------------------------------------------------------- actions

    // One call per key at a time; a failure says its sentence under the section and gives the control back. After a
    // success the key stays busy until the lists (or, with `all`, everything) are read again.
    async function act(key, place, call, all = false) {
      if (s.busy.has(key) || disposed) return false;
      s.busy.add(key);
      s.errors[place] = '';
      update();
      const answer = await call();
      if (disposed) return false;
      if (!answer.ok) {
        s.busy.delete(key);
        s.errors[place] = words.errorText(answer.error || teamStore.NO_ANSWER);
        update();
        return false;
      }
      try { await (all ? store.refreshAll() : store.refreshLists()); } finally {
        if (!disposed) { s.busy.delete(key); update(); }
      }
      return true;
    }

    function othersActive(m) { return (m.roster || []).some((member) => member.state === 'active' && member.member_id !== m.team.member_id); }

    async function stop() {
      s.confirm = '';
      await act('stop', 'server', async () => {
        const answer = await store.call('hostStop');
        if (answer.ok && answer.host) store.seed({ host: answer.host });
        return answer;
      }, true);
    }

    async function createInvite() {
      if (s.busy.has('invite-create')) return;
      s.reveal = null;
      s.copied = false;
      let created = false;
      const ok = await act('invite-create', 'invite', async () => {
        const made = await store.call('inviteCreate', { team_id: teamId, role: s.draft.role, ttl_ms: s.draft.ttl });
        if (!made.ok) return made;
        created = true;
        const revealed = await store.call('inviteReveal', { team_id: teamId, invite_id: made.invite_id });
        if (revealed.ok && typeof revealed.invite === 'string') s.reveal = { kind: 'invite', teamId, code: revealed.invite, expiresAt: made.expires_at };
        return revealed;
      });
      // Also after a failed reveal, so the unused invite is listed in Settings and can be revoked there.
      if (!ok && created && !disposed) void store.refreshLists();
    }

    function copyCode() {
      const code = s.reveal && s.reveal.code;
      const write = (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.clipboard && window.jennyShell.clipboard.writeText) || null;
      if (!code || typeof write !== 'function') return;
      Promise.resolve(write(code)).then(() => {
        if (disposed || !s.reveal || s.reveal.code !== code) return;
        s.copied = true;
        update();
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copyTimer = null; if (!disposed) { s.copied = false; update(); } }, COPIED_MS);
      }, () => {});
    }

    // The switch shares this PC's GPU with this team, as Settings' switch does. What only Settings asks (the first-time
    // notice, a request that is running, a PC already sharing with another team) opens Settings at its switch.
    async function toggleShare() {
      const m = model();
      if (!m || m.team.role === 'read_only' || store.forceLocal() || s.busy.has('share')) return;
      const { sharing } = m.data;
      const here = sharing && sharing.team_id === teamId ? sharing : null;
      if ((sharing && !here) || (here && here.state === 'serving')) { gpus.openShareSettings(openSettings()); return; }
      let ask = false;
      await act('share', 'share', async () => {
        const answer = await store.call('shareSet', here ? { team_id: teamId, on: false } : { team_id: teamId, on: true, confirmed: false });
        ask = Boolean(answer && answer.ok === false && answer.error && answer.error.reason === 'team_share_confirm_needed');
        return ask ? { ok: true } : answer;
      }, true);
      if (ask && !disposed) gpus.openShareSettings(openSettings());
    }

    // A click anywhere in the tab: true when it was this page's.
    function click(event) {
      const el = event.target;
      if (disposed || !el || typeof el.closest !== 'function' || !root.contains(el)) return false;
      const track = el.closest('[data-inv-toggle="' + SHARE_ID + '"]');
      if (track) { if (!track.disabled) void toggleShare(); return true; }
      const option = el.closest('.inv-segmented-option');
      const group = option && option.closest('[data-inv-segmented="' + ROLE_ID + '"]');
      if (group) {
        if (!option.disabled) {
          s.draft.role = option.dataset.value === 'read_only' ? 'read_only' : 'member';
          if (typeof segmented().select === 'function') segmented().select(group, option.dataset.value);
          remember('invite');
        }
        return true;
      }
      const button = el.closest('[data-team-action]');
      if (!button || button.disabled) return false;
      const { teamAction: action, memberId } = button.dataset;
      const m = model();
      if (!m) return true;
      switch (action) {
        case 'ov-invite':
          s.inviteOpen = true;
          update();
          { const first = root.querySelector('[data-inv-segmented="' + ROLE_ID + '"] [tabindex="0"]'); if (first) first.focus({ preventScroll: true }); }
          return true;
        case 'ov-invite-cancel':
          s.inviteOpen = false;
          s.reveal = null;
          s.copied = false;
          clearTimeout(copyTimer);
          update();
          { const again = root.querySelector('[data-team-action="ov-invite"]'); if (again) again.focus({ preventScroll: true }); }
          return true;
        case 'invite-create': if (m.owner) void createInvite(); return true;
        case 'copy-code': copyCode(); return true;
        case 'stop':
          if (!m.owner) return true;
          if (othersActive(m)) { s.confirm = 'stop:overview'; update(); } else void stop();
          return true;
        case 'confirm-stop': if (m.owner) void stop(); return true;
        case 'confirm-cancel': s.confirm = ''; update(); return true;
        case 'admit':
        case 'decline':
          if (m.owner && memberId) void act(action + ':' + memberId, 'needs', () => store.call(action === 'admit' ? 'memberAdmit' : 'memberRevoke', { team_id: teamId, member_id: memberId }));
          return true;
        default: return false;
      }
    }

    // The keyboard path of the role control and a chosen expiry: the draft follows, and the controls need no rewrite.
    function onSegment(event) {
      if (!event.detail || event.detail.id !== ROLE_ID) return;
      s.draft.role = event.detail.value === 'read_only' ? 'read_only' : 'member';
      remember('invite');
    }
    function onChange(event) {
      if (!event.target || event.target.id !== EXPIRY_ID) return;
      s.draft.ttl = TTLS.includes(Number(event.target.value)) ? Number(event.target.value) : DAY_MS;
      remember('invite');
    }
    root.addEventListener('inv-segmented-change', onSegment);
    root.addEventListener('change', onChange);

    // Leaving the page (or hiding the tab) gives the store back and drops the code, the drafts and the markup.
    function dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(copyTimer);
      root.removeEventListener('inv-segmented-change', onSegment);
      root.removeEventListener('change', onChange);
      s.reveal = null;
      s.draft = { role: 'member', ttl: DAY_MS };
      try { release(); } catch (_error) { /* best effort */ }
      root.replaceChildren();
    }

    return { update, click, dispose };
  }

  return { createOverview, applyDefault, decide };
});
