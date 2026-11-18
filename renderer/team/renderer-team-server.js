/* The team server this PC hosts (row 170, mockup team-servers layout A): the Team tab's page while it is not running (`tab`)
 * and the Settings > Team rows (`settings`: This server, and a You row per team). Each place has its own instance. The facts
 * come from `hostSummary`, read once per show and never on a timer. The store, the focus and the redraw stay with the caller. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('../shell/renderer-settings-team-view'), require('./renderer-team-store'));
    return;
  }
  root.rendererTeamServer = factory(root.rendererSettingsTeamStrings, root.rendererSettingsTeamView, root.rendererTeamStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, view, teamStore) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const ACTIVE = new Set(['starting', 'running', 'stopping']);
  const STOPPED = new Set(['stopped', 'failed']);
  const LOST_KEY = new Set(['missing', 'set_aside']);
  const SET_ASIDE_ID = /^\d{17}$/;
  const NO_PROFILE = new Set(['needs_repair', 'deleted']);

  function inv() { return globalThis.inventory || {}; }
  function textFieldFn() { return globalThis.inventoryTextField; }
  const { sizeText, dateText } = words;
  // 1 to 40 characters, counted as the host counts them (code points, not UTF-16 units).
  function okText(value) { const size = [...String(value || '').trim()].length; return size >= 1 && size <= 40; }
  // A name from the host or another member is shown cut and without hidden characters.
  function clean(value) { return value ? words.modelWords.name(value) : ''; }

  // ------------------------------------------------------------- the facts

  const whole = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  // `hostSummary`'s answer, each part a non-negative integer or null; null when the answer is not an object.
  function parseSummary(value) {
    if (!value || typeof value !== 'object') return null;
    return { members: whole(value.members), pending: whole(value.pending), projects: whole(value.projects), bytes: whole(value.bytes), last_ran: whole(value.last_ran) };
  }

  // "3 people · 1 waiting · 2 projects · last ran 14 Nov"; a part that is not known is left out.
  function factsLine(summary) {
    if (!summary) return '';
    const parts = [];
    if (summary.members !== null) parts.push(jtn('team.server.people', summary.members, {}, '{count} person', '{count} people'));
    if (summary.pending) parts.push(jt('settings.team.people.waiting', '{count} waiting', { count: summary.pending }));
    if (summary.projects !== null) parts.push(jtn('team.server.projects', summary.projects, {}, '{count} project', '{count} projects'));
    const when = summary.last_ran ? dateText(summary.last_ran, true) : '';
    if (when) parts.push(jt('team.server.lastRan', 'last ran {date}', { date: when }));
    return parts.join(' · ');
  }

  // What the server's state is called, with the tone of its dot.
  function stateOf(host) {
    switch (host.state) {
      case 'starting': return { tone: 'pending', text: jt('settings.team.status.starting', 'Starting…') };
      case 'stopping': return { tone: 'pending', text: jt('settings.team.status.stopping', 'Stopping…') };
      case 'running': return { tone: 'success', text: jt('settings.team.status.running', 'Running on this PC') };
      case 'failed': return { tone: 'danger', text: jt('settings.team.status.failed', 'Stopped with a problem') };
      default: return { tone: 'default', text: jt('settings.team.status.stopped', 'Stopped') };
    }
  }

  // Why Start is not offered while the server is stopped (the controller found no names to start it with, or the key is lost).
  function whyNoStart(host, row) {
    if (LOST_KEY.has(host.key)) return jt('team.server.noStartKey', 'This PC’s key for the team is missing, so the server cannot start. Team settings has the steps.');
    if (host.reason === 'team_host_platform_unavailable') return words.errorText({ reason: host.reason });
    if (row && row.state === 'needs_repair') return words.repairText(row.reason);
    return jt('team.server.noStartNames', 'Jenny needs your name and this PC’s name for this team to start the server. Enter them in Team settings.');
  }

  // `place`: 'tab' (the Team tab's page) or 'settings'. `options.store` stands in for the shared store (tests).
  function create(place, options = {}) {
    const settings = place === 'settings';
    const attr = settings ? 'team-action' : 'team-tab-action';
    const P = settings ? 'teamSetSrv' : 'teamTabSrv';
    const getStore = () => options.store || teamStore.getTeamStore();
    let s = fresh();

    function fresh() { return { summary: null, readKey: '', ticket: 0, stale: false, startFailed: false, busy: new Set(), errors: {}, drafts: {} }; }

    // ----------------------------------------------------------- markup

    function button(action, label, { variant = 'secondary', disabled = false, title = '', ariaLabel = '', data = {} } = {}) {
      return inv().actionButton({ label, variant, size: 'sm', disabled, ...(title ? { title } : {}), ...(ariaLabel ? { ariaLabel } : {}), dataset: { [attr]: action, ...data } });
    }
    function link(label) { return inv().actionButton({ plain: true, className: 'team-srv__link', label, dataset: { 'team-tab-action': 'open-settings' } }); }
    function note(key) { return view.note(s.errors[key], ' data-team-server-note="' + escapeHtml(key) + '"'); }

    // The Start with Jenny switch. Its track carries the action, so the tab's and Settings' own click handling find it.
    function autostartSwitch(host) {
      const html = inv().toggleSwitch({ id: P + 'Auto', domId: P + 'Auto', bare: true, labelledBy: P + 'AutoLabel', checked: host.autostart === true, disabled: s.busy.has('autostart') });
      return html.replace('data-inv-toggle="' + P + 'Auto"', 'data-inv-toggle="' + P + 'Auto" data-' + attr + '="server-autostart"');
    }
    const autostartLabel = () => jt('team.server.autostart', 'Start with Jenny');
    const autostartHelp = () => jt('team.server.autostartHelp', 'Start this server when Jenny starts.');
    const openFolder = () => button('server-open-folder', jt('team.server.openFolder', 'Open folder'), { disabled: s.busy.has('folder') });
    const sizeOf = () => (s.summary && s.summary.bytes !== null ? sizeText(s.summary.bytes) : '');

    // One row of the page's lists: what it is, what it is now with an optional muted line, and its actions. A row's own
    // sentence (a failed call) is the item after it.
    function fact(key, label, value, sub, actions, labelId = '') {
      const sentence = s.errors[key] ? '<li class="team-ov-fact team-ov-fact--wide"><div class="team-ov-fact__wide">' + note(key) + '</div></li>' : '';
      return '<li class="team-ov-fact" data-team-server-row="' + escapeHtml(key) + '"><span class="team-ov-fact__k"' + (labelId ? ' id="' + labelId + '"' : '') + '>' + escapeHtml(label) + '</span>'
        + '<span class="team-ov-fact__v"><span class="team-ov-fact__main">' + escapeHtml(value) + '</span>' + (sub ? '<span class="team-ov-fact__sub">' + escapeHtml(sub) + '</span>' : '')
        + '</span><span class="team-ov-fact__a">' + actions + '</span></li>' + sentence;
    }

    function oldRows(host) {
      const olds = (Array.isArray(host.old_teams) ? host.old_teams : []).filter((old) => old && SET_ASIDE_ID.test(String(old.id)));
      if (!olds.length) return '';
      return '<h3 class="team-srv__h">' + escapeHtml(jt('team.server.earlier', 'Earlier teams on this PC')) + '</h3><ul class="team-ov-facts" data-team-server="earlier">' + olds.map((old) => {
        const name = clean(old.team_name) || words.teamName(null);
        const projects = jtn('settings.team.del.projectCount', whole(old.projects) || 0, {}, '{count} project', '{count} projects');
        const show = button('server-old-show', jt('settings.team.old.show', 'Show files'), { disabled: s.busy.has('old:' + old.id), data: { 'set-aside-id': old.id },
          ariaLabel: jt('team.server.showOld', 'Show files of {team}', { team: name }) });
        const del = button('open-settings', jt('settings.team.old.delete', 'Delete…'), { variant: 'ghost', ariaLabel: jt('team.server.deleteOld', 'Delete {team}…', { team: name }) });
        return fact('old:' + old.id, name, jt('team.server.setAside', 'Set aside {date}', { date: dateText(Number(old.set_aside_at)) }), projects + ' · ' + sizeText(old.bytes), show + del);
      }).join('') + '</ul>';
    }

    // The Team tab's page for a deployed server that is not running. `vm`: the tab's view model (host, restart, forceLocal, errors, isBusy).
    function pageHtml(vm) {
      const host = vm.host;
      const row = getStore().snapshot().teams.find((team) => team.team_id === host.team_id) || null;
      const name = clean(host.team_name) || words.teamName(null);
      const state = stateOf(host);
      const active = ACTIVE.has(host.state);
      const held = vm.forceLocal === true;
      const start = button('start-server', jt('settings.team.status.start', 'Start'), { variant: 'primary', disabled: !vm.restart || held || vm.isBusy('start-server'), ...(held ? { title: words.forceLocalText() } : {}) });
      const settingsButton = !vm.restart && !active ? button('open-settings', jt('team.tab.openSettings', 'Open Team settings')) : '';
      const reason = host.state === 'failed' ? words.errorText({ code: 'CMP-TEAM-0006', reason: host.reason }) : '';
      const why = !vm.restart && !active && !held ? whyNoStart(host, row) : '';
      const renameWhy = jt('team.server.renameWhy', 'Start the server to rename the team.');
      const changeWhy = jt('team.server.changeWhy', 'Start the server to change your name.');
      const pc = row ? clean(row.label) : '';
      const person = row && row.display_name ? (pc ? jt('team.server.you', '{name} on {pc}', { name: clean(row.display_name), pc }) : clean(row.display_name)) : jt('team.server.notSignedIn', 'Not signed in on this PC');
      const on = host.internet ? jt('team.server.on', 'On') : jt('team.server.off', 'Off');
      const rows = fact('autostart', autostartLabel(), host.autostart === true ? jt('team.server.on', 'On') : jt('team.server.off', 'Off'), autostartHelp(), autostartSwitch(host), P + 'AutoLabel')
        + fact('name', jt('settings.team.host.name', 'Team name'), name, renameWhy, button('server-rename', jt('team.server.rename', 'Rename'), { disabled: true, title: renameWhy }))
        + fact('you', jt('settings.team.you.heading', 'You'), person, changeWhy, button('server-change', jt('team.server.change', 'Change'), { disabled: true, title: changeWhy }))
        + fact('internet', jt('team.server.internet', 'Joining over the internet'), on, host.internet ? jt('team.server.internetOn', 'People with an invite can join from anywhere.') : jt('settings.team.net.offHelp', 'Only people on this network can join.'),
          button('open-settings', jt('team.server.change', 'Change')))
        + fact('folder', jt('team.server.data', 'Team data'), sizeOf(), '', openFolder());
      return '<div class="team-srv" data-team-server="page" aria-labelledby="teamSrvTitle">'
        + '<p class="team-srv__kicker">' + escapeHtml(jt('team.server.kicker', 'Your team server on this PC')) + '</p>'
        + '<div class="team-srv__head"><h2 id="teamSrvTitle" dir="auto">' + escapeHtml(name) + '</h2><div class="team-srv__acts">' + start + settingsButton + '</div></div>'
        + '<div class="team-srv__state">' + inv().statusRow({ tone: state.tone, message: state.text, compact: true })
        + '<span data-team-server="facts">' + escapeHtml(factsLine(s.summary)) + '</span></div>'
        + (reason ? '<p class="team-srv__note">' + escapeHtml(reason) + '</p>' : '') + (why ? '<p class="team-srv__note" data-team-server="why">' + escapeHtml(why) + '</p>' : '')
        + view.note(vm.errors.state, ' data-team-server-note="start"')
        + '<ul class="team-ov-facts" data-team-server="rows">' + rows + '</ul>' + oldRows(host)
        + '<div class="team-srv__more">' + link(jt('team.server.joinAnother', 'Join another team')) + link(jt('team.server.startNew', 'Start a new team')) + link(jt('team.server.allSettings', 'All team settings')) + '</div></div>';
    }

    // Settings > Team's group "This server", for a server deployed on this PC (running or not).
    function groupHtml(vm) {
      const host = vm.host;
      if (!host || host.deployed !== true) return '';
      const size = sizeOf();
      const body = inv().settingsField({ id: P + 'AutoRow', variant: 'row', titleId: P + 'AutoLabel', label: autostartLabel(), help: autostartHelp(), controlHtml: autostartSwitch(host) }) + note('autostart')
        + inv().settingsField({ id: P + 'DataRow', variant: 'row', label: jt('team.server.data', 'Team data'),
          help: size ? jt('settings.team.server.dataSize', '{size} on this PC', { size }) : jt('settings.team.server.dataHelp', 'The team’s files on this PC.'), controlHtml: openFolder() }) + note('folder');
      return view.group('server', jt('settings.team.server.heading', 'This server'), { body });
    }

    // The names this PC holds in a team: the row's, the device's label while the row has none.
    function profileOf(data, team) {
      const device = ((data.lists[team.team_id] || {}).devices || []).find((item) => item.device_id === team.device_id);
      const base = { name: String(team.display_name || ''), label: String(team.label || (device && device.label) || '') };
      const draft = s.drafts[team.team_id] || {};
      return { base, name: draft.name ?? base.name, label: draft.label ?? base.label };
    }

    const nothingToSave = ({ base, name, label }) => !okText(name) || !okText(label) || (name.trim() === base.name && label.trim() === base.label);

    function profileRow(data, team, index, many) {
      const { base, name, label } = profileOf(data, team);
      const key = 'profile:' + team.team_id;
      const off = team.state !== 'online' || s.busy.has(key);
      const reason = team.state === 'online' ? '' : jt('settings.team.profile.offline', 'Connect to the team to change this.');
      const field = (id, text, value) => textFieldFn()({ id, label: text, value, maxLength: 40, disabled: off, className: 'team-set-profile__field' });
      const save = button('profile-save', jt('settings.team.rename.save', 'Save'), { variant: 'primary', data: { 'team-id': team.team_id }, ...(reason ? { title: reason } : {}),
        disabled: off || nothingToSave({ base, name, label }) });
      return inv().settingsField({ id: 'teamProfileRow-' + index, variant: 'row', label: many ? words.teamName(team) : '', help: reason,
        controlHtml: '<div class="team-set-inline team-set-profile" data-team-profile="' + escapeHtml(team.team_id) + '">'
          + field('teamProfileName-' + index, jt('settings.team.you.name', 'Your name'), name) + field('teamProfilePc-' + index, jt('settings.team.you.pc', 'This PC’s name'), label) + save + '</div>' })
        + note(key);
    }

    // The You group: one row for each team this PC is in. Not drawn while the first-run You group is (names still needed).
    function profileHtml(vm, data) {
      const teams = data.teams.filter((team) => !NO_PROFILE.has(team.state) && typeof team.display_name === 'string');
      if (vm.needNames || !teams.length) return '';
      return view.group('profile', jt('settings.team.you.heading', 'You'), { body: teams.map((team, index) => profileRow(data, team, index, teams.length > 1)).join('') });
    }

    // --------------------------------------------------------- reading

    function read(key, render) {
      const state = s;
      const ticket = state.ticket + 1;
      state.ticket = ticket;
      state.readKey = key;
      void getStore().call('hostSummary').then((answer) => {
        if (state !== s || ticket !== state.ticket) return;
        state.summary = answer.ok ? parseSummary(answer.summary) : null;
        render();
      });
    }

    // After the tab wrote its markup: reads the facts once for this team's page, and again once the page was drawn with the
    // server starting or stopping (it is stopped again now) or a Start was refused.
    function fill(root, render) {
      const host = getStore().snapshot().host;
      if (!host || !root.querySelector('[data-team-server="page"]')) return;
      const refused = Boolean(root.querySelector('[data-team-server-note="start"]'));
      const again = refused && !s.startFailed;
      s.startFailed = refused;
      if (ACTIVE.has(host.state)) { s.stale = true; return; }
      if (!STOPPED.has(host.state)) return;
      const key = host.team_id || '-';
      if (s.readKey !== key || s.stale || again) { s.stale = false; read(key, render); }
    }

    // Settings: the facts once each time the page is shown, as soon as a server is deployed here.
    function ensure(render) {
      const host = getStore().snapshot().host;
      if (!host || host.deployed !== true || s.readKey) return;
      read(host.team_id || '-', render);
    }

    // --------------------------------------------------------- actions

    // One call per key at a time; a failure says its sentence under the row and gives the control back.
    async function run(key, task, ctx) {
      const state = s;
      if (state.busy.has(key)) return;
      state.busy.add(key);
      state.errors[key] = '';
      ctx.render();
      let answer;
      try { answer = await task(); } catch (_error) { answer = null; }
      if (state !== s) return;
      state.busy.delete(key);
      if (!answer || answer.ok !== true) state.errors[key] = words.errorText((answer && answer.error) || teamStore.NO_ANSWER);
      ctx.render();
    }

    function saveProfile(teamId, ctx) {
      const store = getStore();
      const data = store.snapshot();
      const team = data.teams.find((item) => item.team_id === teamId);
      if (!team || team.state !== 'online') return;
      const { base, name, label } = profileOf(data, team);
      if (!okText(name) || !okText(label)) return;
      const payload = { team_id: teamId };
      if (name.trim() !== base.name) payload.display_name = name.trim();
      if (label.trim() !== base.label) payload.label = label.trim();
      if (Object.keys(payload).length === 1) return;
      const state = s;
      void run('profile:' + teamId, async () => {
        const answer = await store.call('profileSet', payload);
        if (answer.ok && state === s) delete state.drafts[teamId];
        return answer;
      }, ctx);
    }

    // `ctx`: { render, target }. True when the action was this module's.
    function action(name, ctx) {
      const store = getStore();
      switch (name) {
        case 'server-autostart': {
          const host = store.snapshot().host;
          void run('autostart', async () => {
            const answer = await store.call('hostAutostart', { enabled: !(host && host.autostart === true) });
            if (answer.ok && answer.host) store.seed({ host: answer.host });
            return answer;
          }, ctx);
          return true;
        }
        case 'server-open-folder': void run('folder', () => store.call('hostOpenFolder'), ctx); return true;
        case 'server-old-show': {
          const id = ctx.target && ctx.target.dataset ? ctx.target.dataset.setAsideId : '';
          if (SET_ASIDE_ID.test(String(id))) void run('old:' + id, () => store.call('hostOldShow', { set_aside_id: id }), ctx);
          return true;
        }
        case 'profile-save': saveProfile(ctx.target && ctx.target.dataset ? ctx.target.dataset.teamId : '', ctx); return true;
        default: return false;
      }
    }

    // A name field of a You row: the draft follows what is typed and the Save button follows the draft, in place (a redraw
    // of the page on every key would cost the field its undo history and an input method its composition). True when it was ours.
    function onInput(event) {
      const el = event.target;
      const box = el && typeof el.closest === 'function' ? el.closest('[data-team-profile]') : null;
      if (!box) return false;
      const teamId = box.getAttribute('data-team-profile');
      const draft = s.drafts[teamId] || (s.drafts[teamId] = {});
      draft[/^teamProfileName-/.test(el.id) ? 'name' : 'label'] = String(el.value || '');
      const data = getStore().snapshot();
      const team = data.teams.find((item) => item.team_id === teamId);
      const save = box.querySelector('[data-' + attr + '="profile-save"]');
      if (team && save) save.disabled = team.state !== 'online' || s.busy.has('profile:' + teamId) || nothingToSave(profileOf(data, team));
      return true;
    }

    function reset() { s = fresh(); }

    return { pageHtml, groupHtml, profileHtml, fill, ensure, action, onInput, reset };
  }

  return { create, tab: create('tab'), settings: create('settings'), factsLine, parseSummary };
});
