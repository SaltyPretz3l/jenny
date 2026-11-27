/* Settings > Team, the whole team's lifecycle on the host PC (row 123, slice 5-6; the owner's picks in
 * picks_5-6.md, E48, E61, E63):
 * - the lost-key page: "This team's key is missing" with Put the key back, Start a new team (`hostStartNew`)
 *   and Restore from a backup;
 * - the Delete group, last on the page: Delete this team (`hostInventory`, then `hostDelete` with the typed
 *   name) and each old team set aside after a lost key (Show files `hostOldShow`, Delete `hostOldDelete`);
 * - Export (`hostExport`), a standing row in Ownership and shutdown and a form in the delete confirmation;
 * - Restore (`hostRestorePick`, then `hostRestore`), a row in Host a team and on the lost-key page.
 * Main checks every one of these (owner only, the typed name, the paths); the page only asks. Passwords are
 * never kept here: they are read from their fields when used. The counts come from main's inventory, read when
 * a confirmation opens ("Counting…" until then). Markup through the page's builders; every value is escaped.
 * While main runs one of these calls the pushed host state names it (`operation`): every action here is greyed
 * until it ends, whichever window or page asked, and a greyed button says why in its tooltip and name. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-team-strings'), require('./renderer-settings-team-view'));
    return;
  }
  root.rendererSettingsTeamLifecycle = factory(root.rendererSettingsTeamStrings, root.rendererSettingsTeamView);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, view) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const SECRET = Object.freeze({ 'team-secret': '1' });
  const LOST = new Set(['missing', 'set_aside']);
  const DRAFTS = Object.freeze({ teamDeleteName: 'typed', teamStartNewName: 'newName', teamRestoreName: 'restoreTyped' });
  // What the owner types to delete an old team whose name could not be read (main checks the same word).
  const OLD_CONFIRM_WORD = 'delete';
  // A team name is at most 40 characters, which may be two UTF-16 units each (emoji): the typed-name fields cap by units, so 80.
  const NAME_FIELD_MAX = 80;

  let ui = fresh();
  let asked = 0;
  function fresh() { return { inv: null, invFailed: false, typed: '', newName: '', restoreTyped: '', banner: null, exportOpen: '', exported: null, picked: null, exporting: false, stopAsked: false }; }
  function inv() { return globalThis.inventory || {}; }
  function input(opts) { return (globalThis.inventoryTextField || inv().textField)(opts); }
  const { tag, sizeText, dateText } = words;
  function num(n) { try { return new Intl.NumberFormat(tag()).format(n); } catch (_error) { return String(n); } }
  function p(text) { return text ? '<p>' + escapeHtml(text) + '</p>' : ''; }

  function listText(names) { try { return new Intl.ListFormat(tag(), { type: 'conjunction' }).format(names); } catch (_error) { return names.join(', '); } }

  function keyLost(host) { return Boolean(host && host.deployed && LOST.has(host.key)); }
  // Main is running a delete, restore, export or new team now (any window): the page's own keys do not say.
  function hostBusy(host) { return Boolean(host && typeof host.operation === 'string' && host.operation); }
  // A greyed button with its reason as tooltip and accessible name.
  function why(label, reason) { return reason ? { title: reason, ariaLabel: label + ' (' + reason + ')' } : {}; }
  const leftText = () => jt('settings.team.del.left', 'Some of its files could not be removed. Jenny removes them the next time it starts.');

  // ------------------------------------------------------------- the delete confirmation

  function membersText(list) {
    const you = (m) => (m.owner ? jt('settings.team.people.you', '{name} (you)', { name: m.name }) : m.name);
    return listText(list.map(you));
  }

  function projectTable(projects) {
    const row = (cells, cls) => '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' + cells.map((c, i) => '<td' + (i === 1 || i === 2 ? ' class="n"' : '') + '>' + escapeHtml(c) + '</td>').join('') + '</tr>';
    const files = (n) => jtn('settings.team.del.files', n, { count: num(n) }, '{count} file', '{count} files');
    const talks = (n) => jtn('settings.team.del.conversations', n, { count: num(n) }, '{count} conversation', '{count} conversations');
    const sum = projects.reduce((a, x) => ({ files: a.files + x.files, bytes: a.bytes + x.bytes, talks: a.talks + x.conversations }), { files: 0, bytes: 0, talks: 0 });
    return '<table class="team-del__projects"><tbody>' + projects.map((x) => row([x.name || x.project_id, files(x.files), sizeText(x.bytes), talks(x.conversations)])).join('')
      + (projects.length > 1 ? row([jtn('settings.team.del.projectCount', projects.length, {}, '{count} project', '{count} projects'), files(sum.files), sizeText(sum.bytes), talks(sum.talks)], 'sum') : '')
      + '</tbody></table>';
  }

  function whatGoes(data, old) {
    const counting = '<p>' + escapeHtml(jt('settings.team.del.counting', 'Counting…')) + '</p>';
    const notCounted = '<p>' + escapeHtml(jt('settings.team.del.notCounted', 'Could not be counted.')) + '</p>';
    const part = (missing, html) => (ui.invFailed || missing ? notCounted : ui.inv ? html : counting);
    const i = ui.inv || { members: [], chat: {}, projects: [], trash: [], uncounted: [] };
    const gone = (key) => (i.uncounted || []).includes(key);
    const people = old
      ? jtn('settings.team.del.oldMembers', i.members.length, { names: membersText(i.members) }, '{count} member: {names}. They lost the team when its key went missing; this removes their places in it for good.', '{count} members: {names}. They lost the team when its key went missing; this removes their places in it for good.')
      : jtn('settings.team.del.members', i.members.length, { names: membersText(i.members) }, '{count} member loses the team: {names}.', '{count} members lose the team: {names}.')
        + (i.invites ? ' ' + jtn('settings.team.del.invites', i.invites, {}, '{count} unused invite stops working.', '{count} unused invites stop working.') : '');
    const waiting = i.pending ? jtn('settings.team.del.pending', i.pending, {}, '{count} person waiting to join is turned away.', '{count} people waiting to join are turned away.') : '';
    const c = i.chat || {};
    const channels = c.attachments
      ? jtn('settings.team.del.channelsFiles', c.project_channels || 0, { messages: num(c.messages || 0), files: num(c.attachments) }, '#team and {count} project channel, with {messages} messages and the {files} files attached to them.', '#team and {count} project channels, with {messages} messages and the {files} files attached to them.')
      : jtn('settings.team.del.channels', c.project_channels || 0, { messages: num(c.messages || 0) }, '#team and {count} project channel, with {messages} messages.', '#team and {count} project channels, with {messages} messages.');
    const custom = c.custom_channels ? ' ' + jtn('settings.team.del.customChannels', c.custom_channels, {}, 'Also {count} custom channel, its messages counted above.', 'Also {count} custom channels, their messages counted above.') : '';
    const dms = c.dms ? jtn('settings.team.del.dms', c.dms, { messages: num(c.dm_messages || 0) }, '{count} direct conversation between members, with {messages} messages.', '{count} direct conversations between members, with {messages} messages.') : '';
    const projects = i.projects.length
      ? p(jtn('settings.team.del.projects', i.projects.length, {}, '{count} shared project: its files on this PC’s disk and its conversations with Jenny.', '{count} shared projects: their files on this PC’s disk and their conversations with Jenny.')) + projectTable(i.projects)
      : p(jt('settings.team.del.noProjects', 'No shared projects.'));
    const trash = (i.trash || []).length === 1
      ? jtn('settings.team.del.trashDays', i.trash[0].days_ago || 0, { size: sizeText(i.trash[0].bytes) }, 'Also 1 project deleted {count} day ago and still in the 7-day trash, {size}.', 'Also 1 project deleted {count} days ago and still in the 7-day trash, {size}.')
      : (i.trash || []).length ? jt('settings.team.del.trashMany', 'Also {count} deleted projects still in the 7-day trash, {size}.', { count: i.trash.length, size: sizeText(i.trash.reduce((a, t) => a + t.bytes, 0)) }) : '';
    const records = old ? jt('settings.team.del.oldRecords', 'The activity log and the record of who used the team’s GPUs.')
      : jt('settings.team.del.records', 'The activity log, the record of who used the team’s GPUs, and this team’s key. Without the key the team can never be started again, and its invites and reconnect codes stop working.');
    const dt = (text) => '<dt>' + escapeHtml(text) + '</dt>';
    return '<dl class="team-del__what">'
      + dt(jt('settings.team.del.people', 'People')) + '<dd>' + part(gone('members'), p(people) + p(waiting)) + '</dd>'
      + dt(jt('settings.team.del.messages', 'Messages')) + '<dd>' + part(gone('messages'), p(channels + custom) + p(dms)) + '</dd>'
      + dt(jt('settings.team.del.projectsHeading', 'Projects')) + '<dd>' + part(gone('projects') || gone('conversations'), projects + p(trash)) + '</dd>'
      + dt(jt('settings.team.del.recordsHeading', 'Records')) + '<dd>' + p(records) + '</dd></dl>';
  }

  function kept(old) {
    if (old) return p(jt('settings.team.del.oldKept', 'Not deleted: your own chats, projects and models, your new team, and anything on members’ PCs.'));
    return p(jt('settings.team.del.keptLead', 'Not deleted:')) + '<ul>' + [
      jt('settings.team.del.keptOwn', 'Your own chats, projects and models in Jenny on this PC.'),
      jt('settings.team.del.keptMembers', 'Anything on members’ PCs: their own chats, copies of project files they downloaded, models they received.'),
      jt('settings.team.del.keptEntry', 'The team’s entry in each member’s Jenny. Members connected now see “deleted by its owner”; the others see it as offline until they remove it.'),
    ].map((t) => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul>';
  }

  function exportForm(vm, team, where) {
    return '<div class="team-set-confirm" role="group" data-team-export-form="' + where + '" aria-label="' + escapeHtml(jt('settings.team.export.row', 'Export this team')) + '">'
      + p(jt('settings.team.export.lead', 'Export {team} to a folder you pick. Two things are saved:', { team })) + '<ul><li>'
      + escapeHtml(jt('settings.team.export.readable', 'A readable copy: every project’s files, and the messages you can read yourself (#team, the channels of your projects, your own direct conversations) as text files.'))
      + '</li><li>' + escapeHtml(jt('settings.team.export.backup', 'A backup file that can bring the whole team back: its key, members, every message and project. It is locked with a password you choose. Jenny cannot recover a lost password.'))
      + '</li></ul><p class="settings-field-note" id="teamExportPassHint">' + escapeHtml(jt('settings.team.export.passwordHint', 'The password needs at least 10 characters.')) + '</p><div class="team-set-inline">'
      + input({ id: 'teamExportPass', type: 'password', maxLength: 1024, dataset: SECRET, describedBy: 'teamExportPassHint', ariaLabel: jt('settings.team.export.password', 'Password for the backup'), placeholder: jt('settings.team.export.password', 'Password for the backup') })
      + input({ id: 'teamExportPass2', type: 'password', maxLength: 1024, dataset: SECRET, ariaLabel: jt('settings.team.export.again', 'The same password again'), placeholder: jt('settings.team.export.again', 'The same password again') })
      + '</div><div class="team-set-after">' + view.button(vm, 'export-go', jt('settings.team.export.go', 'Choose a folder and export'), { variant: 'primary', busyKey: 'export' })
      + view.button(vm, 'export-cancel', jt('settings.team.cancel', 'Cancel'), { busyKey: 'export-cancel', ids: { teamId: where } }) + '</div>' + view.note(vm.errors.export) + '</div>';
  }

  function exportedNote() {
    if (!ui.exported) return '';
    // E73: over a member list that does not read only the readable copy was written; nothing can be restored.
    if (ui.exported.leftOut) return view.note(words.exportLeftOutText());
    return view.note(jt('settings.team.export.done', 'Exported to {folder} ({size}). To bring the team back later: Settings, Team, Host a team, Restore a team from a backup.', { folder: ui.exported.folder, size: sizeText(ui.exported.bytes) }));
  }

  function deleteConfirm(vm, data, { old = null } = {}) {
    const host = data.host;
    const team = old ? (old.team_name || words.teamName(null)) : host.team_name;
    const busyKey = old ? 'old-del:' + old.id : 'del';
    const busy = vm.isBusy(busyKey);
    const lead = old ? jt('settings.team.del.oldLead', 'This deletes what the old team left on this PC. Nothing goes to a trash. It cannot be undone.')
      : jt('settings.team.del.lead', 'This deletes it from this PC and for everyone in it. Nothing goes to a trash. It can only be brought back from a backup you export first.');
    const running = !old && ui.inv ? (ui.inv.busy || []).map((b) => p(jt('settings.team.del.busy', 'Jenny is writing a reply in {project} right now (“{conversation}”). It is cut off.', b))).join('') : '';
    let exportHtml;
    if (old) exportHtml = p(jt('settings.team.del.oldExport', 'Its project files are still on this PC: use Show files to copy them out first. Its key is missing, so no export can bring this team back.'));
    else if (ui.exportOpen === 'delete') exportHtml = exportForm(vm, team, 'delete');
    else {
      const first = jt('settings.team.del.exportFirst', 'Export a copy first…');
      const noKey = keyLost(host) ? jt('settings.team.export.keyLost', 'The team’s key is missing, so no export can be made.') : '';
      exportHtml = exportedNote() || ('<div class="team-set-after">' + view.button(vm, 'export-open', first, { ids: { teamId: 'delete' }, disabled: Boolean(noKey) || hostBusy(host), ...why(first, noKey) }) + '</div>');
    }
    const named = !old || old.team_name !== null;
    const ready = ui.inv !== null || ui.invFailed;
    const matches = ui.typed === (named ? team : OLD_CONFIRM_WORD);
    const ids = old ? { teamId: old.id } : {};
    const typeText = named ? jt('settings.team.del.type', 'Type the team’s name, {team}, to confirm.', { team })
      : jt('settings.team.del.oldUnnamed', 'This old team’s name could not be read. Type {word} to confirm.', { word: OLD_CONFIRM_WORD });
    const deleting = busy || (!old && host && host.operation === 'hostDelete');
    const typeRow = '<div class="team-del__type"><label for="teamDeleteName">' + escapeHtml(typeText) + '</label>'
      + input({ id: 'teamDeleteName', value: ui.typed, ariaLabel: named ? jt('settings.team.del.typeLabel', 'The team’s name') : typeText, maxLength: NAME_FIELD_MAX, disabled: busy || !ready })
      + view.button(vm, old ? 'old-del-go' : 'del-go', deleting ? jt('settings.team.del.deleting', 'Deleting…') : jt('settings.team.del.go', 'Delete team and files'), { variant: 'danger', ids, busyKey, disabled: !matches || !ready || hostBusy(host) })
      + view.button(vm, 'confirm-cancel', jt('settings.team.cancel', 'Cancel'), { busyKey }) + '</div>';
    return '<div class="team-set-confirm team-del" role="group" aria-label="' + escapeHtml(jt('settings.team.del.row', 'Delete this team')) + '">'
      + '<p class="team-del__lead"><strong>' + escapeHtml(jt('settings.team.del.ask', 'Delete {team}?', { team })) + '</strong> ' + escapeHtml(lead) + '</p>'
      + running + whatGoes(data, Boolean(old)) + kept(Boolean(old)) + exportHtml + typeRow + view.note(vm.errors[old ? 'old:' + old.id : 'delete']) + '</div>';
  }

  /** The Delete group: this team (owner, or its key lost) and each old team set aside here. */
  function deleteGroup(vm, data, mayDelete) {
    const host = data.host;
    const olds = (host && host.old_teams) || [];
    if (!host || (!mayDelete && !olds.length)) return '';
    let html = '';
    if (mayDelete) {
      html += view.fieldRow('teamDeleteRow', jt('settings.team.del.row', 'Delete this team'),
        jt('settings.team.del.help', 'Deletes {team} for everyone: its members, messages, shared projects and their files on this PC. It cannot be undone.', { team: host.team_name }),
        view.button(vm, 'del-open', host.operation === 'hostDelete' ? jt('settings.team.del.deleting', 'Deleting…') : jt('settings.team.del.open', 'Delete team…'), { busyKey: 'del', disabled: hostBusy(host) }));
      if (vm.confirm === 'delete') html += deleteConfirm(vm, data);
    }
    for (const old of olds) {
      const name = old.team_name || words.teamName(null);
      const ids = { teamId: old.id };
      html += view.fieldRow('teamOld-' + old.id, jt('settings.team.old.row', '{team} (old team)', { team: name }),
        jt('settings.team.old.help', 'Set aside on {date} when its key went missing. {projects}, {size}. It cannot be opened in Jenny; its project files are ordinary files.',
          { date: dateText(old.set_aside_at), projects: jtn('settings.team.del.projectCount', old.projects, {}, '{count} project', '{count} projects'), size: sizeText(old.bytes) }),
        '<div class="team-set-inline">' + view.button(vm, 'old-show', jt('settings.team.old.show', 'Show files'), { ids, busyKey: 'old-show:' + old.id })
        + view.button(vm, 'old-del', jt('settings.team.old.delete', 'Delete…'), { ids, busyKey: 'old-del:' + old.id, disabled: hostBusy(host) }) + '</div>');
      if (vm.confirm === 'old-del:' + old.id) html += deleteConfirm(vm, data, { old });
      else html += view.note(vm.errors['old:' + old.id]);
    }
    return view.group('delete', jt('settings.team.del.heading', 'Delete'), { body: html });
  }

  // ------------------------------------------------------------- lost key, export, restore

  function restoreRow(vm, data, { lost = false } = {}) {
    const team = data.host && data.host.team_name;
    const label = lost ? jt('settings.team.restore.lostRow', 'Restore from a backup') : jt('settings.team.restore.row', 'Restore a team from a backup');
    const help = lost ? jt('settings.team.restore.lostHelp', 'If you exported {team} before its key went missing, the backup brings it back with its key. What {team} left on this PC is set aside first, not deleted.', { team })
      : jt('settings.team.restore.help', 'Brings back a team you exported from Jenny, with its members, messages and projects.');
    const busyHost = hostBusy(data.host);
    let html = view.fieldRow('teamRestoreRow', label, help, view.button(vm, 'restore-open', jt('settings.team.restore.open', 'Restore…'), { busyKey: 'restore', disabled: busyHost }));
    if (vm.confirm !== 'restore') return html;
    const picked = ui.picked ? '<span class="team-set-person__fact">' + escapeHtml(ui.picked.file_name + ' · ' + sizeText(ui.picked.size)) + '</span>' : '';
    let notYet = '';
    if (!ui.picked) notYet = jt('settings.team.reason.restoreNoFile', 'Choose the backup file first.');
    else if (lost && ui.restoreTyped !== team) notYet = jt('settings.team.restore.typeFirst', 'Type the team’s name first.');
    const go = jt('settings.team.restore.go', 'Restore team');
    html += '<div class="team-set-confirm" role="group" aria-label="' + escapeHtml(label) + '">'
      + p(lost ? jt('settings.team.restore.lostLead', 'Choose the backup file and type its password. {team} comes back on this PC as it was when you exported it, with its key. What it left here since then is set aside, not deleted. Members who still have the team in their Jenny reconnect by themselves.', { team })
        : jt('settings.team.restore.lead', 'Choose the backup file and type its password. The team comes back on this PC as it was when you exported it. Members who still have the team in their Jenny reconnect by themselves; anyone who removed it needs a new invite.'))
      + '<div class="team-set-inline">' + view.button(vm, 'restore-pick', jt('settings.team.restore.pick', 'Choose backup file…'), { busyKey: 'restore' }) + picked + '</div>'
      + (lost ? '<div class="team-del__type"><label for="teamRestoreName">' + escapeHtml(jt('settings.team.del.type', 'Type the team’s name, {team}, to confirm.', { team })) + '</label>'
        + input({ id: 'teamRestoreName', value: ui.restoreTyped, ariaLabel: jt('settings.team.del.typeLabel', 'The team’s name'), maxLength: NAME_FIELD_MAX }) + '</div>' : '')
      + '<div class="team-set-after">' + input({ id: 'teamRestorePass', type: 'password', maxLength: 1024, dataset: SECRET, ariaLabel: jt('settings.team.export.password', 'Password for the backup'), placeholder: jt('settings.team.export.password', 'Password for the backup') })
      + view.button(vm, 'restore-go', go, { variant: 'primary', busyKey: 'restore', disabled: Boolean(notYet) || busyHost, ...why(go, notYet) })
      + view.button(vm, 'confirm-cancel', jt('settings.team.cancel', 'Cancel'), { busyKey: 'restore' }) + '</div>' + view.note(vm.errors.restore) + '</div>';
    return html;
  }

  function lostKeyGroup(vm, data) {
    const host = data.host;
    if (!keyLost(host)) return '';
    const team = host.team_name;
    const copy = host.key === 'set_aside'
      ? jt('settings.team.lost.copyAside', 'Jenny’s saved credentials file was damaged, and the key that proves this PC is {team} was in it. Jenny kept the damaged file in its data folder, with a name starting secure-state.json.corrupt. Without the key nobody can start this team. Nothing was deleted.', { team })
      : jt('settings.team.lost.copy', 'The key that proves this PC is {team} is missing. Without the key nobody can start this team. Nothing was deleted.', { team });
    let body = view.fieldRow('teamKeyBackRow', jt('settings.team.lost.back', 'Put the key back'),
      jt('settings.team.lost.backHelp', 'If you have a backup of Jenny’s data folder from before the key went missing, restore it and restart Jenny. The team then starts as before.'), '')
      + view.fieldRow('teamNewTeamRow', jt('settings.team.lost.new', 'Start a new team'),
        jt('settings.team.lost.newHelp', 'A new team with a new key on this PC. Nobody is moved over. What {team} left here is set aside until you delete it.', { team }),
        view.button(vm, 'new-open', jt('settings.team.lost.newOpen', 'Start a new team…'), { busyKey: 'new', disabled: hostBusy(host) }));
    if (vm.confirm === 'new-team') {
      const label = jt('settings.team.lost.new', 'Start a new team');
      body += '<div class="team-set-confirm" role="group" aria-label="' + escapeHtml(label) + '">' + p(jt('settings.team.lost.ask', 'Start a new team on this PC?')) + '<ul>' + [
        jt('settings.team.lost.askKey', 'It gets a new key and starts with only you in it. Nobody is moved over: you invite people again.'),
        jt('settings.team.lost.askOld', '{team} cannot be started again without its key. Its members see it as offline.', { team }),
        jt('settings.team.lost.askAside', 'What {team} left on this PC (its messages, projects and files) is set aside, not deleted. You delete it yourself when you are ready.', { team }),
      ].map((t) => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul><div class="team-set-inline">'
        + input({ id: 'teamStartNewName', value: ui.newName, maxLength: 40, ariaLabel: jt('settings.team.lost.newName', 'New team’s name'), placeholder: jt('settings.team.lost.newName', 'New team’s name') })
        + view.button(vm, 'new-go', label, { variant: 'primary', busyKey: 'new' }) + view.button(vm, 'confirm-cancel', jt('settings.team.cancel', 'Cancel'), { busyKey: 'new' }) + '</div></div>';
    }
    body += restoreRow(vm, data, { lost: true }) + view.note(vm.errors.lostkey);
    return view.group('lostkey', jt('settings.team.lost.heading', 'This team’s key is missing'), { copy, body });
  }

  /** The standing Export row (Ownership and shutdown). */
  function exportRow(vm, data) {
    const team = data.host && data.host.team_name;
    let html = view.fieldRow('teamExportRow', jt('settings.team.export.row', 'Export this team'),
      jt('settings.team.export.help', 'A readable copy of its files and your messages, and a password-locked backup that can bring the whole team back.'),
      view.button(vm, 'export-open', jt('settings.team.export.open', 'Export…'), { ids: { teamId: 'row' }, busyKey: 'export', disabled: hostBusy(data.host) }));
    if (ui.exportOpen === 'row') html += exportForm(vm, team, 'row');
    else if (vm.confirm !== 'delete') html += exportedNote();
    return html;
  }

  /** The one line at the top after a delete or a restore, or ''. */
  function banner() {
    const b = ui.banner;
    if (!b) return '';
    return view.note(b.kind === 'deleted' ? jt('settings.team.del.done', '{team} was deleted from this PC.', { team: b.team }) + (b.left ? ' ' + leftText() : '')
      : jt('settings.team.restore.done', '{team} is back, as it was on {date}. If this PC’s address is different from before, send members a reconnect code (under Network).', { team: b.team, date: dateText(b.at) }));
  }

  /** The status line for a host whose key is lost, or null. */
  function status(host) {
    if (!keyLost(host)) return null;
    return { tone: 'blocked', value: jt('settings.team.status.cannotStart', 'Cannot start'),
      note: jt('settings.team.status.keyMissing', 'This PC’s key for {team} is missing.', { team: host.team_name }) };
  }

  /** The server status line for the page: E64 Force local, then a lost key, then the host's own state. `seats`: seats taken while connected, else null. */
  function hostStatus(host, seats, maxSeats) {
    if (!host) return null;
    // E64: while Force local is on the Server line is the state line, deployed or not, the hold's stop included; a
    // deployed team's Start stays, greyed with it (view.button).
    if (host.force_local === true) {
      return { tone: 'blocked', value: words.forceLocalText(), action: host.deployed && host.team_name ? 'start' : null };
    }
    if (keyLost(host)) return status(host); // slice 5-6: a lost key cannot start
    const startable = Boolean(host.team_name);
    switch (host.state) {
      case 'running':
        return { tone: 'ready', value: jt('settings.team.status.running', 'Running on this PC'), action: 'stop',
          note: seats === null ? '' : jt('settings.team.status.seats', '{count} of {max} seats', { count: seats, max: maxSeats }) };
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

  // ------------------------------------------------------------- actions

  async function openDelete(ctx, confirm, payload) {
    Object.assign(ui, { inv: null, invFailed: false, typed: '', exportOpen: '', exported: null });
    ctx.setConfirm(confirm);
    ctx.render();
    const mine = ++asked;
    let answer;
    try { answer = await ctx.call('hostInventory', payload); } catch (_error) { answer = null; }
    if (mine !== asked || ctx.confirm() !== confirm) return;
    if (answer && answer.ok && answer.inventory) ui.inv = answer.inventory; else ui.invFailed = true;
    ctx.render();
  }

  // A delete that stopped part way: the approved sentence with the project's name when main named it.
  function deleteFailed(ctx, answer, group) {
    const error = answer && answer.error;
    const id = (answer && answer.project_id) || (error && error.project_id);
    const project = id && ui.inv ? (ui.inv.projects.find((x) => x.project_id === id) || {}).name : '';
    if (error && error.reason === 'team_delete_file_held' && project) {
      ctx.setNote(group, jt('settings.team.del.failed', 'Not everything could be deleted: a file in {project} is open in another program. Nothing else was removed and the team is still here. Close the file, then delete again.', { project }));
    }
  }

  async function remove(ctx, name) {
    let failed = null;
    const answer = await ctx.run('del', 'delete', async () => { const a = await ctx.call('hostDelete', { name }); if (!a || !a.ok) failed = a; return a; });
    if (!answer) { deleteFailed(ctx, failed, 'delete'); ctx.render(); await ctx.refreshAll(); return; }
    Object.assign(ui, { inv: null, typed: '', exported: null, banner: { kind: 'deleted', team: name, left: Array.isArray(answer.left) && answer.left.length > 0 } });
    ctx.setConfirm('');
    await ctx.refreshAll();
  }

  async function removeOld(ctx, id) {
    const old = ((ctx.data().host || {}).old_teams || []).find((o) => o.id === id);
    if (!old) return;
    const payload = { set_aside_id: id, name: ui.typed };
    const answer = await ctx.run('old-del:' + id, 'old:' + id, () => ctx.call('hostOldDelete', payload));
    if (!answer) return;
    Object.assign(ui, { inv: null, typed: '' });
    ctx.setConfirm('');
    if (answer.host) ctx.seed({ host: answer.host });
    await ctx.refreshAll();
  }

  async function exportTeam(ctx) {
    const password = ctx.secret('teamExportPass');
    if (password !== ctx.secret('teamExportPass2')) { ctx.setNote('export', jt('settings.team.export.mismatch', 'The two passwords are not the same.')); ctx.render(); return; }
    let cancelled = false;
    const answer = await ctx.run('export', 'export', async () => {
      Object.assign(ui, { exporting: true, stopAsked: false });
      try {
        const a = await ctx.call('hostExport', { password });
        cancelled = Boolean(a && a.error && a.error.reason === 'team_export_cancelled');
        return cancelled ? { ok: false } : a;
      } finally { ui.exporting = false; }
    });
    // Stopped by Cancel: main removed what it wrote. A closed folder picker says nothing.
    if (cancelled) { ctx.setNote('export', ui.stopAsked ? jt('settings.team.export.cancelled', 'Export cancelled. Nothing was kept.') : ''); ctx.render(); return; }
    if (!answer) return;
    ui.exported = { folder: answer.folder, bytes: answer.bytes, leftOut: answer.backup_left_out === true };
    ui.exportOpen = '';
    ctx.render();
  }

  // Cancel while this window's export runs: main stops it at its next safe point (owner decision 2026-11-25).
  function stopExport(ctx) {
    ui.stopAsked = true;
    return ctx.run('export-cancel', 'export', () => ctx.call('hostExportCancel', {}));
  }

  async function pickBackup(ctx) {
    let cancelled = false;
    const answer = await ctx.run('restore', 'restore', async () => {
      const a = await ctx.call('hostRestorePick', {});
      cancelled = Boolean(a && a.error && a.error.reason === 'team_restore_cancelled');
      return cancelled ? { ok: false } : a;
    });
    if (cancelled) { ctx.setNote('restore', ''); ctx.render(); return; }
    ui.picked = answer ? { file_name: answer.file_name, size: answer.size } : null;
    ctx.render();
  }

  async function restore(ctx) {
    const host = ctx.data().host;
    const who = ctx.names('restore');
    if (!who) return;
    const body = { password: ctx.secret('teamRestorePass'), ...who };
    if (keyLost(host)) body.name = ui.restoreTyped;
    let failed = null;
    const answer = await ctx.run('restore', 'restore', async () => { const a = await ctx.call('hostRestore', body); if (!a || !a.ok) failed = a; return a; });
    if (!answer) {
      if (failed && Array.isArray(failed.left) && failed.left.length) { ctx.setNote('restore', words.errorText(failed.error) + ' ' + leftText()); ctx.render(); }
      return;
    }
    Object.assign(ui, { picked: null, restoreTyped: '', banner: { kind: 'restored', team: answer.team_name, at: answer.exported_at } });
    ctx.setConfirm('');
    if (answer.host) ctx.seed({ host: answer.host });
    await ctx.refreshAll();
  }

  async function startNew(ctx) {
    const name = ui.newName.trim();
    if (name.length < 1 || name.length > 40) { ctx.setNote('lostkey', words.errorText({ reason: 'team_name_invalid' })); ctx.render(); return; }
    const who = ctx.names('lostkey');
    if (!who) return;
    const answer = await ctx.run('new', 'lostkey', () => ctx.call('hostStartNew', { name, ...who }));
    if (!answer) return;
    ui.newName = '';
    ctx.setConfirm('');
    if (answer.host) ctx.seed({ host: answer.host });
    await ctx.refreshAll();
  }

  // Closes the export form and puts focus back on the button that opened it.
  function closeExport(ctx, where, doc) {
    ui.exportOpen = '';
    ctx.render();
    const opener = doc.querySelector('[data-team-action="export-open"][data-team-id="' + where + '"]');
    if (opener) opener.focus({ preventScroll: true });
  }

  // Escape inside the export form closes it (and nothing around it); true when it did.
  function onEscape(event, ctx) {
    const form = event.target.closest && event.target.closest('[data-team-export-form]');
    if (!form) return false;
    if (ui.exporting) return true; // the form holds the only Cancel of a running export
    closeExport(ctx, form.getAttribute('data-team-export-form'), form.ownerDocument);
    return true;
  }

  function onClick(event, ctx) {
    const button = event.target.closest && event.target.closest('[data-team-action]');
    if (!button || button.disabled) return false;
    const { teamAction: action, teamId } = button.dataset;
    const host = ctx.data().host;
    switch (action) {
      case 'del-open': void openDelete(ctx, 'delete', {}); return true;
      case 'del-go': if (host && ui.typed === host.team_name) void remove(ctx, host.team_name); return true;
      case 'old-del': void openDelete(ctx, 'old-del:' + teamId, { set_aside_id: teamId }); return true;
      case 'old-del-go': void removeOld(ctx, teamId); return true;
      case 'old-show': void ctx.run('old-show:' + teamId, 'old:' + teamId, () => ctx.call('hostOldShow', { set_aside_id: teamId })); return true;
      case 'export-open': ui.exportOpen = teamId; ui.exported = null; ctx.setNote('export', ''); ctx.render(); return true;
      case 'export-cancel': if (ui.exporting) void stopExport(ctx); else closeExport(ctx, teamId, button.ownerDocument); return true;
      case 'export-go': void exportTeam(ctx); return true;
      case 'new-open': ui.newName = ''; ctx.setConfirm('new-team'); ctx.render(); return true;
      case 'new-go': void startNew(ctx); return true;
      case 'restore-open': Object.assign(ui, { picked: null, restoreTyped: '', banner: null }); ctx.setConfirm('restore'); ctx.render(); return true;
      case 'restore-pick': void pickBackup(ctx); return true;
      case 'restore-go': void restore(ctx); return true;
      default: return false;
    }
  }

  // The typed names: the page redraws only when a button's state changes with them.
  function onInput(event, ctx) {
    const key = DRAFTS[event.target && event.target.id];
    if (!key) return Boolean(event.target && event.target.dataset && event.target.dataset.teamSecret);
    const host = ctx.data().host || {};
    const olds = host.old_teams || [];
    const oldName = () => { const o = olds.find((x) => 'old-del:' + x.id === ctx.confirm()); return o ? (o.team_name ?? OLD_CONFIRM_WORD) : undefined; };
    const target = () => (ctx.confirm().startsWith('old-del:') ? oldName() : host.team_name);
    const state = () => [ui.typed === target(), ui.restoreTyped === host.team_name, ui.newName.trim() !== ''].join();
    const before = state();
    ui[key] = String(event.target.value || '');
    if (state() !== before) ctx.render();
    return true;
  }

  function reset() { ui = fresh(); asked += 1; }

  return { lostKeyGroup, deleteGroup, exportRow, restoreRow, banner, status, hostStatus, keyLost, hostBusy, onClick, onEscape, onInput, reset };
});
