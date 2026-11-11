/* Settings > Team markup (row 123, slice 1g-1): the status line, the You,
 * Host a team, Join, Teams you have joined and Get back in groups, built from
 * inventory primitives. Pure: a view model in, an HTML string out. The owner's
 * groups (Invite, People, Your devices, Activity, Ownership) are in
 * renderer-settings-team-owner-view.js. Design law: no side bars, no cards in
 * cards, dangerous actions behind an inline confirm. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-team-strings'));
    return;
  }
  root.rendererSettingsTeamView = factory(root.rendererSettingsTeamStrings);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const MAX_TEAMS = 4;

  function inv() { return globalThis.inventory || {}; }
  function textFieldFn() { return globalThis.inventoryTextField || inv().textField; }

  // One inventory button carrying its action and ids as data attributes; disabled while busy.
  function button(vm, action, label, { variant = 'secondary', ids = {}, busyKey = action, disabled = false, ariaLabel = '', title = '' } = {}) {
    const dataset = { 'team-action': action };
    if (ids.teamId) dataset['team-id'] = ids.teamId;
    if (ids.memberId) dataset['member-id'] = ids.memberId;
    if (ids.deviceId) dataset['device-id'] = ids.deviceId;
    if (ids.inviteId) dataset['invite-id'] = ids.inviteId;
    return inv().actionButton({ label, variant, size: 'sm', dataset, disabled: disabled || vm.isBusy(busyKey),
      ...(ariaLabel ? { ariaLabel } : {}), ...(title ? { title } : {}) });
  }

  function group(id, heading, { copy = '', extra = '', body = '' } = {}) {
    const headingId = 'teamGroup-' + id;
    return '<div class="settings-group team-set-group" role="group" aria-labelledby="' + headingId + '" data-team-group="' + id + '">'
      + '<h4 class="settings-group-heading" id="' + headingId + '">' + escapeHtml(heading)
      + (extra ? '<span class="team-set-count">' + escapeHtml(extra) + '</span>' : '') + '</h4>'
      + (copy ? '<p class="settings-group-copy">' + escapeHtml(copy) + '</p>' : '') + body + '</div>';
  }

  function note(text) {
    return text ? '<p class="settings-field-note team-set-note" role="status">' + escapeHtml(text) + '</p>' : '';
  }

  function textInput(id, value, ariaLabel, { placeholder = '', maxLength = 40 } = {}) {
    return textFieldFn()({ id, value: value || '', ariaLabel, placeholder, maxLength });
  }

  function fieldRow(id, label, help, controlHtml, labelFor = '') {
    return inv().settingsField({ id, variant: 'row', label, help, controlHtml, ...(labelFor ? { labelFor } : {}) });
  }

  // The inline confirm under a row: one sentence, the action, Cancel. `busyKey` is the key its call runs under.
  function confirmBlock(vm, sentence, action, label, { variant = 'primary', ids = {}, busyKey = action } = {}) {
    return '<div class="team-set-confirm" role="group" aria-label="' + escapeHtml(label) + '"><p>' + escapeHtml(sentence) + '</p>'
      + '<div class="team-set-inline">' + button(vm, action, label, { variant, ids, busyKey })
      + button(vm, 'confirm-cancel', jt('settings.team.cancel', 'Cancel')) + '</div></div>';
  }

  function row(name, fact, actionsHtml, { extraHtml = '' } = {}) {
    return '<li class="team-set-person"><div class="team-set-person__who"><span class="team-set-person__name">' + escapeHtml(name)
      + '</span>' + (fact ? '<span class="team-set-person__fact">' + escapeHtml(fact) + '</span>' : '') + '</div>'
      + '<div class="team-set-person__acts">' + actionsHtml + '</div>' + extraHtml + '</li>';
  }

  // This person's own devices in a team (a device list row may omit member_id).
  function ownDevicesOf(team, devices) {
    return (devices || []).filter((device) => team && (!device.member_id || device.member_id === team.member_id));
  }

  // Stop asks first while anyone else is in the team; `where` is the control that asked.
  function stopConfirm(vm, where) {
    if (vm.confirm !== 'stop:' + where) return '';
    return confirmBlock(vm, jt('settings.team.status.stopConfirm', 'Stop the server? Everyone else in the team is disconnected now. Nothing is deleted: members, projects and history come back when you start it.'),
      'confirm-stop', jt('settings.team.ownership.stopAction', 'Stop server'), { variant: 'danger', busyKey: 'stop' });
  }

  // ------------------------------------------------------------ status line

  function statusLine(vm) {
    const s = vm.status;
    if (!s) return '';
    const action = s.action === 'stop'
      ? button(vm, 'stop', jt('settings.team.status.stop', 'Stop'))
      : s.action === 'start' ? button(vm, 'start', jt('settings.team.status.start', 'Start'), { variant: 'primary', disabled: s.actionDisabled }) : '';
    const notes = [s.note, ...(s.notes || [])].filter(Boolean).map(escapeHtml).join(' ');
    return '<div class="settings-page-status team-set-status" role="status"' + (s.tone ? ' data-state="' + s.tone + '"' : '') + '>'
      + '<span class="settings-page-status-dot" aria-hidden="true"></span>'
      + '<span class="settings-page-status-label">' + escapeHtml(jt('settings.team.status.label', 'Server')) + '</span>'
      + '<span class="settings-page-status-value">' + escapeHtml(s.value) + '</span>'
      + '<span class="settings-page-status-note">' + notes + '</span>' + action + '</div>'
      + stopConfirm(vm, 'status') + note(vm.errors.status);
  }

  // ------------------------------------------------------------------ groups

  function youGroup(vm) {
    return group('you', jt('settings.team.you.heading', 'You'), {
      copy: jt('settings.team.you.copy', 'How you appear to the people in a team.'),
      body: fieldRow('teamYourNameRow', jt('settings.team.you.name', 'Your name'), jt('settings.team.you.nameHelp', '1 to 40 characters.'),
        textInput('teamYourName', vm.names.displayName, jt('settings.team.you.name', 'Your name')), 'teamYourName')
        + fieldRow('teamPcNameRow', jt('settings.team.you.pc', 'This PC’s name'), jt('settings.team.you.pcHelp', 'Helps you tell your devices apart.'),
          textInput('teamPcName', vm.names.label, jt('settings.team.you.pc', 'This PC’s name')), 'teamPcName')
        + note(vm.errors.you),
    });
  }

  function hostGroup(vm) {
    return group('host', jt('settings.team.host.heading', 'Host a team'), {
      copy: jt('settings.team.host.copy', 'This PC becomes the team’s server. Up to eight people, you included. It runs while Jenny is open.'),
      body: fieldRow('teamNewNameRow', jt('settings.team.host.name', 'Team name'), jt('settings.team.host.nameHelp', 'Members see this name.'),
        textInput('teamNewName', vm.drafts.teamName, jt('settings.team.host.name', 'Team name')), 'teamNewName')
        + fieldRow('teamDeployRow', jt('settings.team.host.server', 'Team server'),
          jt('settings.team.host.serverHelp', 'Windows may ask once to allow Jenny on your network. People on the same network can then join with an invite.'),
          button(vm, 'deploy', jt('settings.team.host.deploy', 'Deploy'), { variant: 'primary' }))
        + note(vm.errors.host),
    });
  }

  function joinGroup(vm) {
    const first = vm.teamCount === 0;
    const heading = first ? jt('settings.team.join.heading', 'Join a team') : jt('settings.team.join.another', 'Join another team');
    if (vm.teamCount >= MAX_TEAMS) {
      return group('join', heading, { copy: jt('settings.team.join.full', 'Jenny can be in four teams at once. Leave one to join another.') });
    }
    return group('join', heading, {
      copy: jt('settings.team.join.copy', 'Paste the invite code someone sent you. Their owner then lets you in.'),
      body: '<div class="team-set-inline">' + textInput('teamInviteCode', vm.drafts.invite, jt('settings.team.join.code', 'Invite code'),
        { placeholder: jt('settings.team.join.placeholder', 'jteam1_…'), maxLength: 256 })
        + button(vm, 'join', jt('settings.team.join.join', 'Join')) + '</div>' + note(vm.errors.join),
    });
  }

  function joinedRowActions(vm, team) {
    const ids = { teamId: team.team_id };
    switch (team.state) {
      case 'pending': return button(vm, 'cancel-request', jt('settings.team.joined.cancel', 'Cancel request'), { ids, busyKey: 'leave:' + team.team_id });
      case 'revoked': return button(vm, 'remove-team', jt('settings.team.joined.remove', 'Remove this team'), { ids, busyKey: 'remove:' + team.team_id });
      case 'update_required': return '';
      case 'online':
        return button(vm, 'device-invite', jt('settings.team.joined.addDevice', 'Add a device'), { ids, busyKey: 'device-invite:' + team.team_id })
          + button(vm, 'leave', jt('settings.team.joined.leave', 'Leave'), { ids, busyKey: 'leave:' + team.team_id });
      default: return button(vm, 'leave', jt('settings.team.joined.leave', 'Leave'), { ids, busyKey: 'leave:' + team.team_id });
    }
  }

  function joinedGroup(vm, revealHtml) {
    if (!vm.joined.length) return '';
    const rows = vm.joined.map((team) => {
      const name = team.team_name || jt('settings.team.joined.unnamed', 'Unnamed team');
      const fact = words.roleText(team.role) + ' · ' + words.connectionText(team.state);
      const confirm = vm.confirm === 'leave:' + team.team_id
        ? confirmBlock(vm, jt('settings.team.joined.leaveConfirm', 'Leave {team}? This PC disconnects from it and you lose its channels and shared projects. You can only come back with a new invite.', { team: name }),
          'confirm-leave', jt('settings.team.joined.leaveAction', 'Leave {team}', { team: name }), { variant: 'danger', ids: { teamId: team.team_id }, busyKey: 'leave:' + team.team_id })
        : '';
      const code = revealHtml(team.team_id);
      return row(name, fact, joinedRowActions(vm, team), { extraHtml: confirm + (code ? '<div class="team-set-row-wide">' + code + '</div>' : '') });
    }).join('');
    return group('joined', jt('settings.team.joined.heading', 'Teams you have joined'), {
      extra: jt('settings.team.joined.count', '{count} of 4', { count: vm.teamCount }),
      body: '<ul class="team-set-list" data-team-joined>' + rows + '</ul>' + note(vm.errors.joined),
    });
  }

  function reclaimGroup(vm) {
    const confirm = vm.confirm === 'recover'
      ? confirmBlock(vm, jt('settings.team.reclaim.confirm', 'Signs this Jenny in as the owner again and disconnects the owner’s other devices. It is written to the team’s activity log. It works only here, on the PC that runs the server.'),
        'confirm-recover', jt('settings.team.reclaim.confirmAction', 'Reclaim ownership'))
      : '';
    return group('reclaim', jt('settings.team.reclaim.heading', 'Get back in as the owner'), {
      copy: jt('settings.team.reclaim.copy', 'This PC runs the server but this Jenny has lost its place in the team (for example after its saved keys were cleared).'),
      body: fieldRow('teamReclaimRow', jt('settings.team.reclaim.row', 'Reclaim ownership on this PC'),
        jt('settings.team.reclaim.help', 'Only the PC that runs the server can do this.'),
        button(vm, 'recover', jt('settings.team.reclaim.action', 'Reclaim ownership…'), { busyKey: 'confirm-recover' }))
        + confirm + note(vm.errors.reclaim),
    });
  }

  // The one invite or device code on screen, shown once with Copy and when it expires.
  function codeBlock(vm, reveal) {
    if (!reveal) return '';
    const noteText = reveal.kind === 'device'
      ? jt('settings.team.code.deviceNote', 'Shown once. Paste it into Jenny on your other PC within 15 minutes. It adds a device to you, not a new person.')
      : jt('settings.team.code.inviteNote', 'Shown once. Works for one person until {time}. Send it privately: anyone who has it can ask to join, and you still admit them.', { time: words.formatTime(reveal.expiresAt) });
    return '<div class="team-set-code"><code>' + escapeHtml(reveal.code) + '</code>'
      + button(vm, 'copy-code', vm.copied ? jt('common.copied', 'Copied') : jt('settings.team.code.copy', 'Copy'), { variant: 'primary' })
      + '<p class="team-set-code__note">' + escapeHtml(noteText) + '</p></div>';
  }

  return { button, group, note, textInput, fieldRow, confirmBlock, row, codeBlock, statusLine, stopConfirm, ownDevicesOf, youGroup, hostGroup, joinGroup, joinedGroup, reclaimGroup, MAX_TEAMS };
});
