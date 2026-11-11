/* Settings > Team, the hosted team's groups (row 123, slice 1g-1): Team name,
 * Invite someone, People, Your devices, Activity, and Ownership and shutdown.
 * Owner-only parts render only when the team snapshot says `role: 'owner'`;
 * a member of a team hosted here sees the roster read-only and their own
 * devices. Pure: the view model in, an HTML string out. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-team-strings'), require('./renderer-settings-team-view'));
    return;
  }
  root.rendererSettingsTeamOwnerView = factory(root.rendererSettingsTeamStrings, root.rendererSettingsTeamView);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, view) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const { button, group, note, textInput, fieldRow, confirmBlock, row, codeBlock, ownDevicesOf, stopConfirm } = view;
  const TTL_OPTIONS = [3_600_000, 86_400_000, 604_800_000];
  const ACTIVITY_PREVIEW = 5;

  function inv() { return globalThis.inventory || {}; }
  function segmented() { return inv().segmentedControl || globalThis.inventorySegmentedControl; }

  function roleOptions() {
    return [{ value: 'member', label: words.roleText('member') }, { value: 'read_only', label: words.roleText('read_only') }];
  }

  function teamNameRow(vm, hosted) {
    const ids = { teamId: hosted.team.team_id };
    return view.fieldRow('teamTeamNameRow', jt('settings.team.host.name', 'Team name'), jt('settings.team.host.nameHelp', 'Members see this name.'),
      '<div class="team-set-inline">' + textInput('teamTeamName', vm.drafts.rename ?? hosted.team.team_name, jt('settings.team.host.name', 'Team name'))
      + button(vm, 'rename', jt('settings.team.rename.save', 'Save'), { ids }) + '</div>', 'teamTeamName') + note(vm.errors.rename);
  }

  function inviteGroup(vm, hosted) {
    const ttlLabels = {
      3600000: jt('settings.team.invite.hour', 'Expires in 1 hour'),
      86400000: jt('settings.team.invite.day', 'Expires in 1 day'),
      604800000: jt('settings.team.invite.week', 'Expires in 7 days'),
    };
    const controls = '<div class="team-set-inline">'
      + segmented()({ id: 'teamInviteRole', ariaLabel: jt('settings.team.invite.role', 'Role for the new person'), value: vm.drafts.inviteRole, options: roleOptions() })
      + inv().selectField({ id: 'teamInviteExpiry', ariaLabel: jt('settings.team.invite.expiry', 'When the invite expires'), value: String(vm.drafts.inviteTtl),
        options: TTL_OPTIONS.map((ms) => ({ value: String(ms), label: ttlLabels[ms] })) })
      + button(vm, 'invite-create', jt('settings.team.invite.create', 'Create invite'), { variant: vm.reveal ? 'secondary' : 'primary' }) + '</div>';
    const reveal = vm.reveal && vm.reveal.kind === 'invite' && vm.reveal.teamId === hosted.team.team_id ? codeBlock(vm, vm.reveal) : '';
    const invites = (hosted.invites || []).filter((invite) => invite.kind === 'new_member');
    const list = invites.length
      ? '<ul class="team-set-list team-set-list--follow">' + invites.map((invite) => row(
        invite.role === 'read_only' ? jt('settings.team.invite.readOnlyInvite', 'Read-only invite') : jt('settings.team.invite.memberInvite', 'Member invite'),
        jt('settings.team.invite.unused', 'not used · expires {time}', { time: words.formatTime(invite.expires_at) }),
        button(vm, 'invite-revoke', jt('settings.team.invite.revoke', 'Revoke'), { ids: { inviteId: invite.invite_id }, busyKey: 'invite-revoke:' + invite.invite_id }),
      )).join('') + '</ul>'
      : '';
    return group('invite', jt('settings.team.invite.heading', 'Invite someone'), {
      copy: jt('settings.team.invite.copy', 'Each code lets one person ask to join. Nobody gets in until you admit them.'),
      body: controls + reveal + list + note(vm.errors.invite),
    });
  }

  function lastSeen(devices) {
    const latest = Math.max(0, ...(devices || []).map((device) => Number(device.last_seen_at) || 0));
    return latest ? jt('settings.team.people.lastSeen', 'last seen {time}', { time: words.formatTime(latest) }) : '';
  }

  function pendingRow(vm, member) {
    const device = (member.devices || [])[0] || {};
    const fact = jt('settings.team.people.pendingFact', 'wants to join as {role} · {label} · key {key}', {
      role: words.roleText(member.role), label: device.label || '', key: words.formatFingerprint(device.fingerprint) });
    const ids = { memberId: member.member_id };
    return row(member.display_name, fact,
      button(vm, 'admit', jt('settings.team.people.admit', 'Admit'), { variant: 'primary', ids, busyKey: 'admit:' + member.member_id })
      + button(vm, 'decline', jt('settings.team.people.decline', 'Decline'), { ids, busyKey: 'decline:' + member.member_id }),
      { extraHtml: '<p class="team-set-person__hint">' + escapeHtml(jt('settings.team.people.hint', 'Check the name and the key with them before you admit them. They see the same key on their screen.')) + '</p>' });
  }

  function memberRow(vm, hosted, member) {
    const you = member.member_id === hosted.team.member_id;
    const name = you ? jt('settings.team.people.you', '{name} (you)', { name: member.display_name }) : member.display_name;
    const fact = [words.deviceCount((member.devices || []).length), lastSeen(member.devices)].filter(Boolean).join(' · ');
    if (!hosted.owner) return row(name, words.roleText(member.role), '');
    if (member.role === 'owner') return row(name, fact, '<span class="team-set-person__fact">' + escapeHtml(words.roleText('owner')) + '</span>');
    const ids = { memberId: member.member_id };
    const moreLabel = jt('settings.team.people.more', 'More for {name}', { name: member.display_name });
    const acts = inv().selectField({ id: 'teamRole-' + member.member_id, ariaLabel: jt('settings.team.people.role', 'Role for {name}', { name: member.display_name }),
      value: member.role, options: roleOptions(), dataset: { 'member-id': member.member_id }, disabled: vm.isBusy('role:' + member.member_id) })
      + button(vm, 'more', '⋯', { variant: 'ghost', ids, ariaLabel: moreLabel, title: moreLabel, busyKey: 'more:' + member.member_id });
    let confirm = '';
    if (vm.confirm === 'remove:' + member.member_id) {
      confirm = confirmBlock(vm, jt('settings.team.people.removeConfirm', 'Remove {name} from the team? Their devices are disconnected at once and they lose the team’s channels and shared projects. They can only come back with a new invite.', { name: member.display_name }),
        'confirm-remove', jt('settings.team.people.removeAction', 'Remove {name}', { name: member.display_name }), { variant: 'danger', ids, busyKey: 'remove:' + member.member_id });
    } else if (vm.confirm === 'owner:' + member.member_id) {
      confirm = confirmBlock(vm, jt('settings.team.people.ownerConfirm', 'Make {name} the owner? You become a member. Only the owner can invite, admit, remove people and change roles, and only {name} can hand ownership back. The server keeps running on this PC.', { name: member.display_name }),
        'confirm-owner', jt('settings.team.people.ownerAction', 'Make {name} the owner', { name: member.display_name }), { ids, busyKey: 'owner:' + member.member_id });
    }
    return row(name, fact, acts, { extraHtml: confirm });
  }

  function peopleGroup(vm, hosted) {
    const members = hosted.roster || [];
    const pending = hosted.owner ? members.filter((member) => member.state === 'pending') : [];
    const active = members.filter((member) => member.state === 'active')
      .sort((a, b) => (b.member_id === hosted.team.member_id) - (a.member_id === hosted.team.member_id));
    const extra = jt('settings.team.people.count', '{count} of 8', { count: members.length })
      + (pending.length ? ' · ' + jt('settings.team.people.waiting', '{count} waiting', { count: pending.length }) : '');
    const solo = active.length <= 1 && !pending.length && hosted.owner;
    return group('people', jt('settings.team.people.heading', 'People'), {
      extra: hosted.roster ? extra : '',
      copy: solo ? jt('settings.team.people.solo', 'Only you so far. Create an invite to bring someone in.') : '',
      body: '<ul class="team-set-list" data-team-people>' + pending.map((member) => pendingRow(vm, member)).join('')
        + active.map((member) => memberRow(vm, hosted, member)).join('') + '</ul>' + note(vm.errors.people),
    });
  }

  function devicesGroup(vm, team, devices) {
    const own = ownDevicesOf(team, devices);
    const rows = own.map((device) => {
      const here = device.device_id === team.device_id;
      const fact = here ? jt('settings.team.devices.here', 'this PC') : lastSeen([device]);
      const ids = { teamId: team.team_id, deviceId: device.device_id };
      const sentence = own.length <= 1
        ? jt('settings.team.devices.lastConfirm', 'This is your only device in this team. Only the owner can bring you back.')
        : jt('settings.team.devices.hereConfirm', 'This is the PC you are using now. It leaves the team at once; to use the team here again, add it from one of your other devices.');
      const confirm = vm.confirm === 'device:' + device.device_id
        ? confirmBlock(vm, sentence, 'confirm-device', jt('settings.team.devices.removeAction', 'Remove this device'),
          { variant: 'danger', ids, busyKey: 'device-revoke:' + device.device_id })
        : '';
      return row(device.label, fact, button(vm, 'device-revoke', jt('settings.team.devices.remove', 'Remove'), { ids, busyKey: 'device-revoke:' + device.device_id }),
        { extraHtml: confirm });
    }).join('');
    const reveal = vm.reveal && vm.reveal.kind === 'device' && vm.reveal.teamId === team.team_id ? codeBlock(vm, vm.reveal)
      : '<div class="team-set-after">' + button(vm, 'device-invite', jt('settings.team.devices.add', 'Add another device'), { ids: { teamId: team.team_id }, busyKey: 'device-invite:' + team.team_id }) + '</div>';
    return group('devices', jt('settings.team.devices.heading', 'Your devices'), {
      copy: jt('settings.team.devices.copy', 'Up to three PCs can be you in this team.'),
      body: '<ul class="team-set-list" data-team-devices>' + rows + '</ul>' + reveal + note(vm.errors.devices),
    });
  }

  function activityList(entries, nameOf) {
    return entries.map((entry) => '<li><time>' + escapeHtml(words.formatTime(entry.at)) + '</time>'
      + escapeHtml(words.activityText(entry, nameOf)) + '</li>').join('');
  }

  function activityGroup(vm, hosted) {
    const nameOf = (id) => {
      if (!id) return '';
      if (id === hosted.team.member_id) return jt('settings.team.activity.you', 'You');
      return (hosted.roster || []).find((member) => member.member_id === id)?.display_name || '';
    };
    const all = vm.activity.expanded;
    const entries = all ? vm.activity.pages : (hosted.audit || []).slice(-ACTIVITY_PREVIEW).reverse();
    const list = entries.length
      ? '<ul class="team-set-log" data-team-activity>' + activityList(entries, nameOf) + '</ul>'
      : inv().emptyNote({ text: jt('settings.team.activity.empty', 'Nothing has happened yet.') });
    const more = all
      ? (vm.activity.nextCursor !== null ? button(vm, 'activity-more', jt('settings.team.activity.more', 'Show more'), { variant: 'ghost', busyKey: 'activity' }) : '')
        + button(vm, 'activity-less', jt('settings.team.activity.less', 'Show less'), { variant: 'ghost', busyKey: 'activity' })
      : button(vm, 'activity-all', jt('settings.team.activity.all', 'Show all activity'), { variant: 'ghost', busyKey: 'activity' });
    return group('activity', jt('settings.team.activity.heading', 'Activity'), {
      body: list + '<div class="team-set-after">' + more + '</div>' + note(vm.errors.activity),
    });
  }

  function ownershipGroup(vm) {
    return group('ownership', jt('settings.team.ownership.heading', 'Ownership and shutdown'), {
      body: fieldRow('teamHandOverRow', jt('settings.team.ownership.handOver', 'Hand over ownership'),
        jt('settings.team.ownership.handOverHelp', 'Pick a member in People, then “Make … the owner”. You stay as a member.'), '')
        + fieldRow('teamStopRow', jt('settings.team.ownership.stop', 'Stop the server'),
          jt('settings.team.ownership.stopHelp', 'Everyone is disconnected. Members, projects and history stay on this PC and come back when you start it.'),
          button(vm, 'stop', jt('settings.team.ownership.stopAction', 'Stop server'))) + stopConfirm(vm, 'ownership'),
    });
  }

  // The hosted team's groups in page order, up to Activity; Join and Ownership are placed by the page.
  function hostedGroups(vm, hosted) {
    let html = '';
    if (hosted.owner) html += teamNameRow(vm, hosted) + inviteGroup(vm, hosted);
    html += peopleGroup(vm, hosted);
    if (hosted.team.state === 'online') html += devicesGroup(vm, hosted.team, hosted.devices);
    if (hosted.owner) html += activityGroup(vm, hosted);
    return html;
  }

  return { hostedGroups, ownershipGroup };
});
