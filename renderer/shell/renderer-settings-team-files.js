/* Settings > Team, the "Project files" group (row 123, file tools on a team host, slice 3; the owner's mockup
 * team-host-file-tools): on the owner's page after "Model sharing", one switch "Let Jenny work with project files" and
 * under it, by the host's report, a line that says whether members really get the tools.
 *
 * `data.host.file_tools` is `{ on, state, reason }` (present only for a deployed team): `off`, `unavailable` (the
 * Windows review has not happened), `saved` (on, server stopped), `starting`, `working`, `not_working` with a reason
 * word. An unknown state draws like `off`, an unknown reason says the generic sentence. Turning it on asks first (the
 * server restarts and members reconnect; a member's prompt, or text inside a file, can lead Jenny to change files);
 * turning it off asks nothing, so an on switch is never disabled by a reason. Force local greys the switch with its
 * reason. A call is `hostFileTools { on }` run under the busy key and error key `files`; the answer's host state
 * redraws the page. The page (renderer-settings-team-section.js) places the group and hands each call its context:
 * on the owner's page while the server runs (`hosted` is the hosted team) and, with the server stopped, after Network
 * for the owner (`hosted` is a marker), so "Takes effect when you start the server" has a place to show; for anyone
 * else `hosted` is null and nothing is drawn.
 * Markup through the inventory primitives and the page's builders only; every value is escaped there. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-team-strings'), require('./renderer-settings-team-view'));
    return;
  }
  root.rendererSettingsTeamFiles = factory(root.rendererSettingsTeamStrings, root.rendererSettingsTeamView);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, view) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const CONFIRM = 'files-on';
  const BUSY = 'files';
  const REASON_PREFIX = 'file_access_';

  function inv() { return globalThis.inventory || {}; }

  // The sentence for a not_working reason (the host's `file_access_<word>`); anything else says the generic one.
  function reasonText(reason) {
    const word = typeof reason === 'string' && reason.startsWith(REASON_PREFIX) ? reason.slice(REASON_PREFIX.length) : '';
    switch (word) {
      case 'api_missing': return jt('settings.team.files.reason.apiMissing', 'This version of Windows lacks a feature Jenny needs to reach files safely.');
      case 'backup_privilege': return jt('settings.team.files.reason.backupPrivilege', 'Jenny holds a Windows backup privilege that could pass folder permissions. Start Jenny normally, then restart the server.');
      case 'component_missing': return jt('settings.team.files.reason.componentMissing', 'Jenny’s file access part is missing from this install. Reinstall Jenny.');
      case 'elevated': return jt('settings.team.files.reason.elevated', 'Jenny is running as administrator. Start Jenny normally, then restart the server.');
      case 'platform_unsupported': return jt('settings.team.files.reason.platformUnsupported', 'This system does not support project files.');
      case 'root_identity': return jt('settings.team.files.reason.rootIdentity', 'The team’s projects folder could not be identified safely.');
      case 'root_invalid': return jt('settings.team.files.reason.rootInvalid', 'The team’s projects folder is missing or was moved.');
      case 'selfcheck_failed': return jt('settings.team.files.reason.selfcheckFailed', 'Jenny’s file access part failed its own check. Reinstall Jenny.');
      case 'switch_off': return jt('settings.team.files.reason.switchOff', 'File access was off when the server started. Restart the server.');
      case 'volume_unsupported': return jt('settings.team.files.reason.volumeUnsupported', 'The team’s projects folder is on a drive Jenny cannot use safely, such as a network or removable drive.');
      default: return jt('settings.team.files.reason.unavailable', 'Jenny could not start file access.');
    }
  }

  // The line under the row: the restart while the call is out and the server runs, else the host's report.
  function stateLine(vm, host, tools) {
    const tone = (t, message) => '<div class="team-relay-state">' + inv().statusRow({ tone: t, message, compact: true }) + '</div>';
    if (vm.isBusy(BUSY) && host.state === 'running') return tone('default', jt('settings.team.net.restarting', 'Restarting the server with the new setting…'));
    switch (tools.state) {
      case 'working': return tone('success', jt('settings.team.files.working', 'On. Members see file tools in project conversations.'));
      case 'not_working': return tone('warning', jt('settings.team.files.notWorking', 'On, but Jenny could not open project files: {reason} Until then members get no file tools.', { reason: reasonText(tools.reason) }));
      case 'starting': return tone('default', jt('settings.team.files.starting', 'Waiting for the server to start project files.'));
      default: return '';
    }
  }

  function hostGroup(vm, data, hosted) {
    const host = data.host;
    const tools = host && host.file_tools;
    if (!tools || !hosted) return '';
    const on = tools.on === true;
    const held = vm.forceLocal === true;
    const windows = tools.state === 'unavailable' && !on;
    let help = jt('settings.team.files.help', 'Members’ prompts, and text inside the files themselves, can make Jenny read and change files in team project folders on this PC. Every change asks a person first. Jenny cannot reach any other folder.');
    if (host.state !== 'running') help += ' ' + jt('settings.team.files.takesEffect', 'Takes effect when you start the server.');
    if (windows) help = jt('settings.team.files.windowsHelp', 'Not on Windows yet. It waits for a safety review of how Jenny reaches files on Windows.');
    if (held) help = words.forceLocalText();
    const toggle = inv().toggleSwitch({ id: 'teamFileTools', domId: 'teamFileTools', bare: true, labelledBy: 'teamFileToolsTitle', describedBy: 'teamFileToolsHelp',
      checked: on, disabled: vm.isBusy(BUSY) || held || windows, ...(held ? { tooltip: words.forceLocalText() } : {}) });
    let body = inv().settingsField({ id: 'teamFileToolsRow', variant: 'row', titleId: 'teamFileToolsTitle', helpId: 'teamFileToolsHelp', controlHtml: toggle,
      label: jt('settings.team.files.label', 'Let Jenny work with project files'), help });
    body += stateLine(vm, host, tools);
    if (!on && vm.confirm === CONFIRM) {
      const sentence = host.state === 'running'
        ? jt('settings.team.files.confirmRunning', 'Turn on project files? The server restarts and members reconnect by themselves. From then on a member’s prompt, or text inside a file, can lead Jenny to change files in team project folders; each change still asks a person first.')
        : jt('settings.team.files.confirmStopped', 'Turn on project files? From then on a member’s prompt, or text inside a file, can lead Jenny to change files in team project folders; each change still asks a person first. It takes effect when you start the server.');
      body += view.confirmBlock(vm, sentence, 'files-confirm-on', jt('settings.team.files.turnOn', 'Turn on'), { variant: 'primary', busyKey: BUSY });
    }
    return view.group('files', jt('settings.team.files.heading', 'Project files'), {
      copy: jt('settings.team.files.copy', 'When a member asks in a project’s conversation, Jenny can read, search, write and edit files in that project’s folder on this PC.'),
      body: body + view.note(vm.errors.files) });
  }

  // Any answer closes the question; a good one redraws the page from the host state it carries (a failure shows its
  // sentence through the error key).
  function setFiles(ctx, on) {
    void ctx.run(BUSY, 'files', () => ctx.call('hostFileTools', { on })).then((answer) => {
      if (ctx.confirm() === CONFIRM) ctx.setConfirm('');
      if (answer && answer.host) ctx.seed({ host: answer.host });
      ctx.render(true);
    });
  }

  function switchClicked(ctx) {
    const tools = ctx.data().host && ctx.data().host.file_tools;
    if (!tools) return;
    if (tools.on === true) { setFiles(ctx, false); return; }
    ctx.setConfirm(ctx.confirm() === CONFIRM ? '' : CONFIRM);
  }

  // A click on the page. True when it was one of this group's.
  function onClick(event, ctx) {
    const target = event.target;
    const track = target && target.closest && target.closest('[data-inv-toggle="teamFileTools"]');
    if (track) {
      if (!track.disabled) switchClicked(ctx);
      ctx.render(true); // the shared toggle handler flips the switch it was given; the page draws the state
      return true;
    }
    const button = target && target.closest && target.closest('[data-team-action="files-confirm-on"]');
    if (!button || button.disabled) return false;
    setFiles(ctx, true);
    return true;
  }

  function reset() { /* no module state to forget */ }

  return { hostGroup, onClick, reset };
});
