/* The Team tab's start page (row 168, slice S3; owner-approved mockup team-overview, "Team tab: no team yet"): with no
 * team and no team server on this PC the Team view hosts a team or joins one. A heading and lede, then Your name and
 * This PC's name once, then two columns: Host a team (Team name, Start the team, the network sentence, Restore from a
 * file in Settings) and Join a team (Invite code, Join). The same checks, calls and sentences as Settings > Team.
 *
 * The page's state (drafts, busy keys, one sentence per place) is module state; `reset` clears it when the view is
 * hidden. The markup carries no typed text, so a store push rewrites nothing; when the markup does change (a busy
 * button, a sentence) `fill` puts the drafts back into the new fields.
 *
 * With no team data on disk (E50) the store is quiet: the first Start the team or Join ends that exactly as Settings
 * does (`afterFirstAct`): the store wakes and reads once, and the shell learns there is team data. Loaded with the
 * tab's scripts (renderer-settings-script-manifest.js `teamTab`). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('./renderer-team-store'), require('./renderer-team-channels'), require('./renderer-team-server'));
    return;
  }
  root.rendererTeamStart = factory(root.rendererSettingsTeamStrings, root.rendererTeamStore, root.rendererTeamChannels, root.rendererTeamServer);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, teamStore, channels, serverPage) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const ACTIVE_HOST = new Set(['starting', 'running', 'stopping']);
  const STOPPED = new Set(['stopped', 'failed']);
  const LOST_KEY = new Set(['missing', 'set_aside']); // the host's `key` when it cannot start (as Settings' lifecycle says)
  const FIELDS = Object.freeze({ teamStartName: 'displayName', teamStartPc: 'label', teamStartTeam: 'teamName', teamStartInvite: 'invite' });

  function fresh() { return { drafts: { displayName: '', label: '', teamName: '', invite: '' }, busy: new Set(), errors: {} }; }
  let page = fresh();

  function inv() { return globalThis.inventory || {}; }
  function textFieldFn() { return globalThis.inventoryTextField; }
  function okText(value, max = 40) { const text = String(value || '').trim(); return text.length >= 1 && text.length <= max; }

  // 'start' with no team and no team server here; 'wait' while nothing has been read yet (a blank view, so a team
  // that is about to arrive never flashes another state); '' otherwise.
  function phase(data) {
    const host = data.host;
    if (data.teams.length || (host && (host.deployed === true || ACTIVE_HOST.has(host.state)))) return '';
    return host || (data.hostRead && data.hostRead.seq > 0) ? 'start' : 'wait';
  }

  // ---------------------------------------------------------------- markup

  function note(place) {
    const text = page.errors[place];
    return text ? '<p class="team-start__note team-set-note" role="status" data-team-start-note="' + place + '">' + escapeHtml(text) + '</p>' : '';
  }

  function field(id, label, { maxLength = 40, placeholder = '' } = {}) {
    return textFieldFn()({ id, label, value: '', maxLength, placeholder, className: 'team-start__field' });
  }

  function go(action, label, busyKey, held) {
    return inv().actionButton({ label, variant: 'primary', size: 'sm', dataset: { 'team-tab-action': action },
      disabled: held || page.busy.has(busyKey), ...(held ? { title: words.forceLocalText() } : {}) });
  }

  function html(store, which) {
    if (which === 'wait') return '<div class="team-shell" data-team-state="loading" data-column="none"><div class="team-main"></div></div>';
    const held = store.forceLocal();
    const restore = jt('team.start.restore', 'Restore a team from a file…');
    return '<div class="team-shell" data-team-state="none" data-column="none"><div class="team-main"><div class="team-start">'
      + '<h2>' + escapeHtml(jt('team.start.heading', 'Work with people you trust')) + '</h2>'
      + '<p class="team-start__lede">' + escapeHtml(jt('team.start.lede', 'Host a team on this PC or join someone else’s. Your own chats stay on this PC either way.')) + '</p>'
      + (held ? '<p class="team-start__held" role="status">' + escapeHtml(words.forceLocalText()) + '</p>' : '')
      + '<div class="team-start__you" role="group" aria-label="' + escapeHtml(jt('settings.team.you.heading', 'You')) + '">'
      + field('teamStartName', jt('settings.team.you.name', 'Your name')) + field('teamStartPc', jt('settings.team.you.pc', 'This PC’s name'))
      + '<p class="team-start__fine">' + escapeHtml(jt('settings.team.you.copy', 'How you appear to the people in a team.')) + '</p>' + note('you') + '</div>'
      + '<div class="team-start__cols"><section class="team-start__col" aria-labelledby="teamStartHostHeading">'
      + '<h3 id="teamStartHostHeading">' + escapeHtml(jt('settings.team.host.heading', 'Host a team')) + '</h3>'
      + '<p>' + escapeHtml(jt('settings.team.host.copy', 'This PC becomes the team’s server. Up to eight people, you included. It runs while Jenny is open.')) + '</p>'
      + field('teamStartTeam', jt('settings.team.host.name', 'Team name'))
      + '<div class="team-start__go">' + go('start-host', jt('team.start.host', 'Start the team'), 'host', held) + '</div>' + note('host')
      + '<p class="team-start__fine">' + escapeHtml(jt('settings.team.host.serverHelp', 'Windows may ask once to allow Jenny on your network. People on the same network can then join with an invite.')) + '</p>'
      + inv().actionButton({ plain: true, className: 'team-start__link', label: restore, dataset: { 'team-tab-action': 'open-settings' } })
      + '</section><section class="team-start__col" aria-labelledby="teamStartJoinHeading">'
      + '<h3 id="teamStartJoinHeading">' + escapeHtml(jt('settings.team.join.heading', 'Join a team')) + '</h3>'
      + '<p>' + escapeHtml(jt('settings.team.join.copy', 'Paste the invite code someone sent you. Their owner then lets you in.')) + '</p>'
      + field('teamStartInvite', jt('settings.team.join.code', 'Invite code'), { maxLength: 512, placeholder: jt('settings.team.join.placeholder', 'jteam2_…') })
      + '<div class="team-start__go">' + go('start-join', jt('settings.team.join.join', 'Join'), 'join', held) + '</div>' + note('join')
      + '</section></div></div></div></div>';
  }

  // After a rewrite: the drafts back into the new fields, and the stopped server's page reads its facts (`render` redraws the view).
  function fill(root, render) {
    serverPage.tab.fill(root, render);
    for (const [id, key] of Object.entries(FIELDS)) {
      const input = root.querySelector('#' + id);
      if (input && input.value !== page.drafts[key]) input.value = page.drafts[key];
    }
  }

  function onInput(event) {
    const key = FIELDS[event.target && event.target.id];
    if (key) page.drafts[key] = String(event.target.value || '');
  }

  // --------------------------------------------------------------- actions

  // The names, or null with the sentence under the names row.
  function names() {
    const { displayName, label } = page.drafts;
    if (okText(displayName) && okText(label)) return { display_name: displayName.trim(), label: label.trim() };
    page.errors.you = words.errorText({ reason: 'team_display_name_invalid' });
    return null;
  }

  // One call per button at a time. A failure says its sentence under its column; a success clears its field and
  // re-reads all. The button comes back even when a step throws.
  async function send(key, method, payload, ctx, after) {
    const s = page;
    s.busy.add(key);
    s.errors.you = '';
    try {
      ctx.render();
      const answer = await ctx.store.call(method, payload);
      teamStore.afterFirstAct(ctx.store, answer); // E50: the first answered act ends the quiet start
      if (answer.ok && answer.host) ctx.store.seed({ host: answer.host });
      if (s !== page) return;
      if (!answer.ok) { s.errors[key] = words.errorText(answer.error || teamStore.NO_ANSWER); return; }
      after();
      await ctx.store.refreshAll();
    } finally { s.busy.delete(key); if (s === page) ctx.render(); }
  }

  // `ctx`: { store, render, target }. True when the action was the start page's or the stopped server page's.
  function action(name, ctx) {
    if (serverPage.tab.action(name, ctx)) return true;
    if (name !== 'start-host' && name !== 'start-join') return false;
    const key = name === 'start-host' ? 'host' : 'join';
    if (page.busy.has(key) || ctx.store.forceLocal()) return true;
    const draft = page.drafts;
    if (key === 'host' ? !okText(draft.teamName) : !okText(draft.invite, 512)) {
      page.errors[key] = words.errorText({ reason: key === 'host' ? 'team_name_invalid' : 'team_invite_malformed' });
      ctx.render();
      return true;
    }
    page.errors[key] = '';
    const who = names();
    if (!who) { ctx.render(); return true; }
    if (key === 'host') void send('host', 'hostDeploy', { name: draft.teamName.trim(), ...who }, ctx, () => { draft.teamName = ''; const hosted = ctx.store.snapshot().host; if (hosted && hosted.team_id) channels.select(hosted.team_id, channels.OVERVIEW); });
    else void send('join', 'join', { invite: draft.invite.trim(), ...who }, ctx, () => { draft.invite = ''; });
    return true;
  }

  // The Start of a stopped server in the Team view's "not running" state (renderer-team-tab-view.js): the hostDeploy
  // payload, or null when it cannot be offered (no saved team name, a lost key, a platform that cannot host, a server
  // that is not stopped, or names this PC does not know: the hosted team's row saved with the membership).
  function restart(store) {
    const { host, teams } = store.snapshot();
    if (!host || host.deployed !== true || !okText(host.team_name) || !STOPPED.has(host.state)) return null;
    if (LOST_KEY.has(host.key) || host.reason === 'team_host_platform_unavailable') return null;
    const row = teams.find((team) => team.team_id === host.team_id);
    return row && okText(row.display_name) && okText(row.label) ? { name: host.team_name, display_name: row.display_name, label: row.label } : null;
  }

  function reset() { page = fresh(); serverPage.tab.reset(); }

  return { phase, html, fill, onInput, action, restart, reset, send };
});
