/* Team tab: a shared project's page (row 123, slice 3-10; picks_3-10.md "Project page", with the brief's source
 * corrections). Drawn in the project frame's region with its own header, in the picks' order: Files, Members,
 * Always allowed (renderer-team-project-rules.js), Activity for project admins (renderer-team-project-activity.js),
 * Delete for admins and the team owner. Also the new empty project, the stuck delete line, and the team owner's page
 * for a project they are not in (its name only in the header; Add myself joins as an admin, E30).
 *
 * Roles: a project admin gets rename, the role selects, Add someone and Remove; the team owner who is not an admin
 * gets nothing beyond Delete and Add myself (the registry's rule); everyone gets Download a copy (when the host
 * serves files) and Leave. `files_supported === false` (never the host's operating system) replaces the Files section
 * with its sentence. One transfer a team at a time, drawn from the store's last `transfer` push for this project,
 * with a neutral progress bar (it never turns to a warning colour near the end).
 *
 * Redraws: the frame and its scroller are built once; each part (header, notes, lede, Files, Members, Always allowed,
 * Activity, Delete, the owner's join) is written only when its own markup changed, so a transfer push writes Files
 * alone and the scroll stays where it is. A field someone is typing in (the rename, the rule form's folder and
 * reason) is never replaced: column.writeKeeping keeps its node. A click that replaces its own button moves the focus
 * into what replaced it (a confirm's Cancel, a form's first field). The members are read on open and when this
 * project's own row changes (single flight); Activity is read again on this project's rules, requests or a finished
 * transfer. `dispose` leaves no timer or listener.
 *
 * `createProjectPage({ root, teamId, projectId, store, ctx(), onShow(page), onClose(), renders })` -> { update(change),
 * dispose(), focusTarget(), resources() }. `ctx()`: { team, roster, nameOf(id), errorText(error), timeText(ms),
 * fresh() (the page was just created and its row may not be listed yet) }. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-project-column'), require('./renderer-team-project-rules'), require('./renderer-team-project-activity'));
    return;
  }
  root.rendererTeamProjectPage = factory(root.rendererTeamProjectColumn, root.rendererTeamProjectRules, root.rendererTeamProjectActivity);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (column, rulesModule, activityModule) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const SVG = (paths) => '<svg viewBox="0 0 16 16" aria-hidden="true">' + paths + '</svg>';
  const BACK = SVG('<path d="M9.5 3.5L5 8l4.5 4.5"/>');
  const PEN = SVG('<path d="M10.5 3.5l2 2L6 12H4v-2z"/>');
  const ROLES = Object.freeze(['admin', 'writer', 'reader']);
  const RENAME_ID = 'teamProjectRename';
  const KEEP = Object.freeze([RENAME_ID, 'teamRuleFolder', 'teamRuleReason']);
  const ACTIVE = new Set(['checking', 'running', 'waiting', 'committing']);
  const TEAM_ONLY = new Set(['uploadCancel', 'downloadCancel']);
  const OUTSIDE = Object.freeze(['header', 'notes']);
  const INSIDE = Object.freeze(['lede', 'files', 'boards', 'members', 'rules', 'activity', 'delete', 'join']);

  function inv() { return globalThis.inventory || {}; }
  function explorer() { return globalThis.rendererTeamProjectFiles || (typeof require === 'function' ? require('./renderer-team-project-files') : null); }
  const tag = () => globalThis.jennyI18n?.tag?.() || undefined;
  const number = (n) => Number(n || 0).toLocaleString(tag());
  const mb = (bytes) => (Number(bytes || 0) / (1024 * 1024)).toLocaleString(tag(), { maximumFractionDigits: 0 });
  function roleWord(role) {
    if (role === 'admin') return jt('team.projects.role.admin', 'Admin');
    if (role === 'writer') return jt('team.projects.role.writer', 'Writer');
    return jt('team.projects.role.reader', 'Reader');
  }
  const button = column.button;
  const note = (text) => (text ? '<p class="team-set-note" role="status">' + escapeHtml(text) + '</p>' : '');
  const section = (name, heading, body, count = '') => '<section data-team-project-section="' + name + '"><h3>' + escapeHtml(heading)
    + (count ? ' <span class="team-set-count">' + escapeHtml(count) + '</span>' : '') + '</h3>' + body + '</section>';

  function createProjectPage({ root, teamId, projectId, store, ctx, onShow, onClose, renders = { page: 0 } }) {
    const ids = { team_id: teamId, project_id: projectId };
    const live = { members: null, membersError: '', reading: false, again: false, rename: null, confirmDelete: false, confirm: null, addWho: '', addRole: 'writer',
      notes: {}, busy: new Set(), disposed: false, rowKey: '', transferState: '' };
    const last = {};
    let rules = null;
    let activity = null;

    const state = () => store.team(teamId);
    const row = () => store.project(teamId, projectId);
    const unjoined = () => ((state() || {}).unjoined || []).find((r) => r.project_id === projectId) || null;
    const isAdmin = () => (row() || {}).role === 'admin';
    const isOwner = () => ctx().team.role === 'owner';
    const name = () => column.clean((row() || unjoined() || {}).name) || jt('team.projects.unnamed', 'A project');
    const conversationTitle = (sessionId) => { const r = ((state() || {}).conversations || []).find((c) => c.session_id === sessionId); return r ? r.title : ''; };
    const personOf = (memberId) => (ctx().roster || []).find((m) => m.member_id === memberId) || null;

    function readMembers() {
      if (live.disposed || !row()) return;
      if (live.reading) { live.again = true; return; }
      live.reading = true;
      void store.call('projectMembers', ids).then((answer) => {
        live.reading = false;
        if (live.disposed) return;
        if (answer.ok) { live.members = answer.members.slice(0, 256); live.membersError = ''; } else live.membersError = ctx().errorText(answer.error);
        store.note(teamId, projectId, answer);
        if (live.again) { live.again = false; readMembers(); }
        draw();
      });
    }

    // Row 175 F11: the project's boards (20 at most) and the Boards line that opens one.
    // One read at a time; a refusal reads as no boards, so a projects change does not ask again and again.
    function readBoards() {
      if (live.disposed || !row() || live.readingBoards) return;
      live.readingBoards = true;
      void store.call('boardList', ids).then((a) => {
        live.readingBoards = false;
        if (live.disposed) return;
        live.boards = a && a.ok && Array.isArray(a.boards) ? a.boards.filter((b) => b && typeof b.id === 'string').slice(0, 20) : [];
        draw();
      });
    }
    async function openBoard(boardId) {
      const w = globalThis;
      const lists = w.rendererSettingsScriptManifest;
      if (!w.rendererBoardTeam && lists?.teamBoard) await Promise.resolve(w.rendererTeamTabGate?.ensureTeamAssets({ windowRef: w, scripts: lists.teamBoard, styles: ['styles/board-team.css'] })).catch(() => false);
      if (w.rendererBoardTeam?.requestOpen?.({ teamId, projectId, boardId }) && w.rendererTopNavShellController?.openBoardView?.() === true) return;
      live.notes.boards = jt('team.projects.boardsFailed', 'The Board tab could not be opened. Try again.');
      if (!live.disposed) draw();
    }
    function boardsSection() {
      if (!live.boards?.length || globalThis.rendererTopNavShellController?.openBoardView?.({ dry: true }) !== true) return '';
      const why = ctx().team.state === 'online' ? '' : jt('team.projects.boardsOffline', 'Boards open when the team is online.');
      const rows = live.boards.map((b) => {
        const label = column.clean(b.name);
        const title = why || jt('team.projects.boardsOpenTitle', 'Open {board} in the Board tab', { board: label });
        return '<li class="team-set-person"><span class="team-set-person__name" dir="auto">' + escapeHtml(label) + '</span><div class="team-set-person__acts">'
          + button('board-open', jt('team.projects.boardsOpen', 'Open'), { title, ariaLabel: title, disabled: Boolean(why), dataset: { 'board-id': b.id } }) + '</div></li>';
      }).join('');
      return section('boards', jt('team.projects.boards', 'Boards'), '<ul class="team-set-list">' + rows + '</ul>' + note(why) + note(live.notes.boards), number(live.boards.length));
    }

    // The sections that read on their own come and go with the role: rules for any member, activity for admins.
    function syncParts() {
      const c = ctx();
      const parts = { call: (m, p) => store.call(m, p), nameOf: c.nameOf, conversationTitle, timeText: c.timeText, errorText: c.errorText, onChange: () => draw() };
      if (row() && !rules) rules = rulesModule.createRules({ teamId, projectId, isAdmin, ...parts });
      if (!row() && rules) { rules.dispose(); rules = null; }
      if (isAdmin() && !activity) activity = activityModule.createActivity({ teamId, projectId, ...parts });
      if (!isAdmin() && activity) { activity.dispose(); activity = null; }
    }

    async function run(key, place, method, payload, after) {
      if (live.busy.has(key) || live.disposed) return;
      live.busy.add(key);
      live.notes[place] = '';
      draw();
      // A transfer's cancel names the team only (one transfer a team at a time).
      const answer = await store.call(method, TEAM_ONLY.has(method) ? { team_id: teamId } : { ...ids, ...payload });
      if (live.disposed) return;
      live.busy.delete(key);
      store.note(teamId, projectId, answer);
      if (!answer.ok) live.notes[place] = deleteRefusal(method, answer) || ctx().errorText(answer.error);
      else if (after) after(answer);
      draw();
    }

    // E24 with the running conversation named, when this client knows one; else the landed sentence.
    function deleteRefusal(method, answer) {
      if (method !== 'projectDelete' || !answer.error || answer.error.reason !== 'team_project_busy') return '';
      const s = state();
      const busy = s ? s.conversations.find((c) => c.project_id === projectId && s.activity[c.session_id]) : null;
      return busy ? jt('team.projects.deleteBusy', '{project} cannot be deleted while a turn is running or an approval is waiting in it (“{conversation}” is running). Try again when they have finished.',
        { project: name(), conversation: column.clean(busy.title) || jt('team.projects.untitled', 'Untitled conversation') }) : '';
    }

    // ------------------------------------------------------------ markup

    function header(sub) {
      const back = jt('team.chat.back', 'Back to the list');
      const backButton = inv().actionButton({ plain: true, className: 'team-icon-btn team-back', ariaLabel: back, title: back, dataset: { 'team-tab-action': 'back' }, trustedHtml: BACK });
      if (live.rename) {
        const label = jt('team.projects.renameLabel', 'Project name');
        return '<header class="team-head">' + backButton + '<div class="team-inline-name">' + globalThis.inventoryTextField({ id: RENAME_ID, value: live.rename.value, ariaLabel: label, maxLength: 80, dataset: { 'project-input': 'rename' } })
          + button('rename-save', jt('team.projects.save', 'Save'), { variant: 'primary', disabled: live.busy.has('rename') }) + button('rename-cancel', jt('team.projects.cancel', 'Cancel')) + '</div></header>';
      }
      const rename = jt('team.projects.rename', 'Rename {project}', { project: name() });
      const pen = isAdmin() && !(state() || { deleting: new Set() }).deleting.has(projectId)
        ? inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: rename, title: rename, dataset: { 'project-action': 'rename' }, trustedHtml: PEN }) : '';
      return '<header class="team-head">' + backButton + '<h2 class="team-head__name" dir="auto" title="' + escapeHtml(name()) + '">' + escapeHtml(name()) + '</h2>'
        + (sub ? '<span class="team-head__sub">' + escapeHtml(sub) + '</span>' : '') + '<div class="team-head__actions">' + pen + '</div></header>';
    }

    function subLine(role) {
      const count = live.members ? live.members.length : 0;
      if (count === 1 && role === 'admin') return jt('team.projects.subJustYou', 'Shared project · just you · you are its admin');
      const you = role === 'admin' ? jt('team.projects.youAdmin', 'you are an admin') : role === 'writer' ? jt('team.projects.youWriter', 'you are a writer') : jt('team.projects.youReader', 'you are a reader');
      if (!count) return jt('team.projects.subNoCount', 'Shared project · {you}', { you });
      return jtn('team.projects.sub', count, { you }, 'Shared project · {count} member · {you}', 'Shared project · {count} members · {you}');
    }

    function transferLine(transfer) {
      if (!transfer || transfer.project_id !== projectId) return '';
      const up = transfer.direction === 'upload';
      const folder = column.clean(transfer.folder || '');
      if (ACTIVE.has(transfer.state)) {
        const counts = { done: number(transfer.files_done), total: number(transfer.files_total), mbDone: mb(transfer.bytes_done), mbTotal: mb(transfer.bytes_total) };
        const line = transfer.state === 'checking' ? (up ? jt('team.projects.uploadChecking', 'Uploading {folder} · checking the files', { folder })
          : jt('team.projects.downloadChecking', 'Downloading a copy · reading the list of files'))
          : up ? jt('team.projects.uploading', 'Uploading {folder} · {done} of {total} files · {mbDone} of {mbTotal} MB', { folder, ...counts })
            : jt('team.projects.downloading', 'Downloading a copy · {done} of {total} files · {mbDone} of {mbTotal} MB', counts);
        const waiting = transfer.state === 'waiting' ? ' ' + jt('team.projects.transferWaiting', 'Waiting for the team’s host to come back…') : '';
        const cancel = button(up ? 'upload-cancel' : 'download-cancel', jt('team.projects.cancel', 'Cancel'), { title: up ? jt('team.projects.uploadCancel', 'Stop this upload') : jt('team.projects.downloadCancel', 'Stop this download'),
          disabled: live.busy.has('cancel') });
        // Neutral: progress is not a level, so no warning or danger colour near the end.
        const bar = inv().progressBar({ value: Number(transfer.bytes_done) || 0, max: Math.max(1, Number(transfer.bytes_total) || 0), label: line, className: 'team-progress__bar', warningThreshold: 2, dangerThreshold: 2 });
        const after = up ? '<p class="team-page__fact team-progress__note">' + escapeHtml(jt('team.projects.uploadAfter', 'It arrives as a new folder, {folder}, once every file has been checked. Your own folder is not changed.', { folder })) + '</p>' : '';
        return '<div class="team-progress" role="status"><div class="team-progress__line"><span dir="auto">' + escapeHtml(line + waiting) + '</span>' + cancel + '</div>' + bar + after + '</div>';
      }
      if (transfer.state === 'done') {
        if (up) return note(jtn('team.projects.uploadDone', transfer.files || 0, { folder, n: number(transfer.files), size: activityModule.sizeText(transfer.bytes) },
          'Uploaded {folder} ({n} file, {size}).', 'Uploaded {folder} ({n} files, {size}).'));
        const saved = jtn('team.projects.downloadDone', transfer.files || 0, { project: name(), path: column.plain(transfer.path, 1024), n: number(transfer.files), size: activityModule.sizeText(transfer.bytes) },
          'Saved a copy of {project} to {path} ({n} file, {size}).', 'Saved a copy of {project} to {path} ({n} files, {size}).');
        const skipped = transfer.skipped > 0 ? ' ' + jtn('team.projects.linksSkipped', transfer.skipped, {}, '{count} link was skipped.', '{count} links were skipped.') : '';
        return note(saved + skipped);
      }
      if (transfer.state === 'cancelled') return note(up ? jt('team.projects.uploadCancelled', 'The upload was stopped. Nothing of it was kept.') : jt('team.projects.downloadCancelled', 'The download was stopped. Nothing partly saved was kept.'));
      if (transfer.state === 'failed') return note(ctx().errorText({ reason: transfer.reason || 'team_transfer_failed' }));
      return '';
    }

    // Row 175 round 2 (D13): Browse files shows the project's files in the Team preview column (renderer-team-project-files.js
    // `open`); greyed with the reason, never hidden, when the host serves no files or the project is being deleted.
    function browseButton(unsupported = '') {
      const why = unsupported || (state().deleting.has(projectId) ? jt('team.projects.deletingShort', 'This project is being deleted.') : '');
      return button('browse-files', jt('team.projectFiles.browse', 'Browse files'), { disabled: Boolean(why),
        title: why || jt('team.projectFiles.browseTitle', 'Show the project’s files in a column') });
    }

    function filesSection(role, fresh) {
      const s = state();
      if (!s.filesSupported) {
        const unsupported = jt('team.projects.filesUnsupported',
          'This team’s host cannot give Jenny confined access to files yet, so Jenny can talk in this project but cannot read, change, upload or download its files. Conversations and the channel work.');
        return section('files', jt('team.projects.files', 'Files'), '<p class="team-page__fact">' + escapeHtml(unsupported) + '</p><div class="team-page__acts">' + browseButton(unsupported) + '</div>');
      }
      const deleting = s.deleting.has(projectId);
      const transfer = s.transfer;
      const other = transfer && ACTIVE.has(transfer.state) ? (transfer.project_id === projectId ? jt('team.projects.transferHere', 'A transfer is running in this project.')
        : jt('team.projects.transferElsewhere', 'Another upload or download for this team is still running.')) : '';
      const why = deleting ? jt('team.projects.deletingShort', 'This project is being deleted.') : other;
      const writes = role === 'admin' || role === 'writer';
      const upload = writes ? button('upload', jt('team.projects.upload', 'Upload a folder'), { variant: fresh ? 'primary' : 'secondary', disabled: Boolean(why) || live.busy.has('upload'),
        title: why || jt('team.projects.uploadTitle', 'Copy a folder from this PC into the project') }) : '';
      const download = fresh ? '' : button('download', jt('team.projects.download', 'Download a copy'), { disabled: Boolean(other) || live.busy.has('download'),
        title: other || jt('team.projects.downloadTitle', 'Save a copy of the project’s files into an empty folder') });
      const start = fresh && writes ? button('conv-new', jt('team.projects.newConversation', 'New conversation'), { title: jt('team.projects.newConversationIn', 'New conversation in {project}', { project: name() }) }) : '';
      const fact = fresh ? jt('team.projects.noFiles', 'No files yet.') : jt('team.projects.filesFact', 'Files are kept on the team’s host, up to 2 GB a project.');
      const limits = fresh ? '<p class="team-page__fact team-progress__note">' + escapeHtml(jt('team.projects.filesLimits', 'Up to 512 MB an upload and 2 GB a project. Files you upload are copied; your own folder is not changed.')) + '</p>' : '';
      const browse = browseButton();
      return section('files', jt('team.projects.files', 'Files'), '<p class="team-page__fact">' + escapeHtml(fact) + '</p><div class="team-page__acts">' + browse + upload + download + start + '</div>'
        + limits + transferLine(transfer) + note(live.notes.files));
    }

    function memberRow(member, admin) {
      const c = ctx();
      const me = member.member_id === c.team.member_id;
      const person = personOf(member.member_id);
      const shown = c.nameOf(member.member_id);
      const label = me ? jt('settings.team.people.you', '{name} (you)', { name: shown }) : shown;
      const capped = person && person.role === 'read_only';
      const fact = capped ? jt('team.projects.readOnlyHere', 'read-only in the team, so Reader here') : '';
      let acts = '<span class="team-set-person__fact">' + escapeHtml(roleWord(member.role)) + '</span>';
      let sure = ''; // H21.1: Remove asks first; the confirm stands in the row where the button was
      const asking = admin && !me && live.confirm && live.confirm.kind === 'remove' && live.confirm.memberId === member.member_id;
      if (admin && !me) {
        const roleLabel = jt('team.projects.roleFor', 'Role for {name}', { name: shown });
        acts = inv().selectField({ id: 'teamProjectRole-' + member.member_id, ariaLabel: roleLabel, tooltip: capped ? fact : roleLabel, value: member.role, disabled: capped || live.busy.has('role:' + member.member_id),
          options: ROLES.map((role) => ({ value: role, label: roleWord(role) })), dataset: { 'project-input': 'member-role', 'member-id': member.member_id } })
          + (asking ? '' : button('member-remove', jt('team.projects.remove', 'Remove'), { variant: 'ghost', title: jt('team.projects.removeTitle', 'Remove {name} from the project', { name: shown }),
            disabled: live.busy.has('remove:' + member.member_id), dataset: { 'member-id': member.member_id } }));
        if (asking) {
          const params = { name: shown, project: name() };
          sure = column.confirmBlock(jt('team.projects.removeGo', 'Remove {name}', params), jt('team.projects.removeConfirm', 'Remove {name} from {project}? They no longer see its conversations, its channel or its files. You can add them back.', params),
            button('member-remove-go', jt('team.projects.removeGo', 'Remove {name}', params), { variant: 'danger', disabled: live.busy.has('remove:' + member.member_id), dataset: { 'member-id': member.member_id } })
            + button('member-cancel', jt('team.projects.cancel', 'Cancel'), { dataset: { 'member-id': member.member_id } }));
        }
      }
      return '<li class="team-set-person"><div class="team-set-person__who"><span class="team-set-person__name" dir="auto">' + escapeHtml(label) + '</span>'
        + (fact ? '<span class="team-set-person__fact">' + escapeHtml(fact) + '</span>' : '') + '</div><div class="team-set-person__acts">' + acts + '</div>' + sure + '</li>';
    }

    // Add someone: a person who is read-only in the team joins as a reader (the role is fixed and says why).
    const addRoleOf = () => ((personOf(live.addWho) || {}).role === 'read_only' ? 'reader' : live.addRole);

    function membersSection(role) {
      const admin = role === 'admin';
      const members = live.members || [];
      const rows = members.map((member) => memberRow(member, admin)).join('');
      let add = '';
      if (admin) {
        const inside = new Set(members.map((m) => m.member_id));
        const choices = (ctx().roster || []).filter((m) => !inside.has(m.member_id));
        if (choices.length) {
          if (!choices.some((m) => m.member_id === live.addWho)) live.addWho = choices[0].member_id;
          const capped = (personOf(live.addWho) || {}).role === 'read_only';
          const roleTip = capped ? jt('team.projects.readOnlyHere', 'read-only in the team, so Reader here') : jt('team.projects.addRole', 'Role');
          add = '<div class="team-page__acts">' + inv().selectField({ id: 'teamProjectAddWho', ariaLabel: jt('team.projects.addWho', 'Add someone'), tooltip: jt('team.projects.addWho', 'Add someone'), value: live.addWho,
            options: choices.map((m) => ({ value: m.member_id, label: column.clean(m.display_name) })), dataset: { 'project-input': 'add-who' } })
            + inv().selectField({ id: 'teamProjectAddRole', ariaLabel: jt('team.projects.addRole', 'Role'), tooltip: roleTip, value: addRoleOf(), disabled: capped,
              options: ROLES.map((r) => ({ value: r, label: roleWord(r) })), dataset: { 'project-input': 'add-role' } })
            + button('member-add', jt('team.projects.add', 'Add'), { title: jt('team.projects.addTitle', 'Add this person to the project'), disabled: live.busy.has('add') }) + '</div>';
        }
      }
      const leave = live.confirm && live.confirm.kind === 'leave' ? column.confirmBlock(jt('team.projects.leave', 'Leave this project'),
        jt('team.projects.leaveConfirm', 'Leave {project}? You stop seeing its conversations, its channel and its files until a project admin adds you back.', { project: name() }),
        button('leave-go', jt('team.projects.leaveGo', 'Leave {project}', { project: name() }), { variant: 'danger', disabled: live.busy.has('leave') }) + button('leave-cancel', jt('team.projects.cancel', 'Cancel')))
        : '<div class="team-page__acts">' + button('leave', jt('team.projects.leave', 'Leave this project'), { title: jt('team.projects.leaveTitle', 'Stop being a member of {project}', { project: name() }), disabled: live.busy.has('leave') }) + '</div>';
      return section('members', jt('team.projects.members', 'Members'), (rows ? '<ul class="team-set-list">' + rows + '</ul>' : '') + note(live.membersError) + add + leave + note(live.notes.members),
        live.members ? number(members.length) : '');
    }

    // `conversations`: the count this client knows, or null (the owner's page for a project they are not in).
    function deleteSection(conversations) {
      const body = '<p class="team-page__fact">' + escapeHtml(jt('team.projects.deleteFact', 'Deletes its conversations and archives its channel. Its files go to the host’s trash for 7 days.')) + '</p>';
      const params = { project: name() };
      const sentence = conversations === null
        ? jt('team.projects.deleteConfirmNoCount', 'Delete {project}? Its conversations are deleted and its channel is archived for everyone. Its files stay in the host’s trash for 7 days, where only the host’s owner can get them back.', params)
        : jtn('team.projects.deleteConfirm', conversations, params, 'Delete {project}? Its {count} conversation is deleted and its channel is archived for everyone. Its files stay in the host’s trash for 7 days, where only the host’s owner can get them back.',
          'Delete {project}? Its {count} conversations are deleted and its channel is archived for everyone. Its files stay in the host’s trash for 7 days, where only the host’s owner can get them back.');
      const confirm = live.confirmDelete ? column.confirmBlock(jt('team.projects.deleteGo', 'Delete {project}', params), sentence,
        button('delete-go', jt('team.projects.deleteGo', 'Delete {project}', params), { variant: 'danger', disabled: live.busy.has('delete') }) + button('delete-cancel', jt('team.projects.cancel', 'Cancel')))
        : '<div class="team-page__acts">' + button('delete', jt('team.projects.delete', 'Delete project…'), { title: jt('team.projects.deleteTitle', 'Delete {project} for everyone', params) }) + '</div>';
      return section('delete', jt('team.projects.deleteHeading', 'Delete this project'), body + confirm + note(live.notes.delete));
    }

    function memberParts() {
      const r = row();
      const s = state();
      const role = r.role === 'owner' ? 'admin' : r.role;
      const conversations = s.conversations.filter((c) => c.project_id === projectId).length;
      const fresh = s.created.has(projectId) && conversations === 0;
      const deleting = s.deleting.has(projectId) ? '<p class="team-note-line" role="status">' + escapeHtml(jt('team.projects.deleting', 'This project is being deleted. Nothing in it can change; the delete finishes when the team’s host next starts.')) + '</p>' : '';
      const lede = fresh ? jt('team.projects.ledeEmpty', 'A new project starts empty. Bring files in, or start a conversation and let Jenny write them.')
        : jt('team.projects.lede', 'Everyone in this project sees its conversations, its channel and its files. Jenny’s file tools reach only this project’s folder on the team’s host.');
      return { header: header(subLine(role)), notes: note(live.notes.header) + deleting, lede: '<p class="team-page__lede">' + escapeHtml(lede) + '</p>',
        files: filesSection(role, fresh), boards: boardsSection(), members: membersSection(role), rules: rules ? rules.html() : '', activity: activity ? activity.html() : '',
        delete: role === 'admin' || isOwner() ? deleteSection(conversations) : '' };
    }

    function notMemberParts() {
      const lede = jt('team.projects.notMemberLede', 'You are not in this project, so its conversations, channel and files are not shown to you. As the team’s owner you can add yourself; that is written to the team’s activity log.');
      return { header: header(''), lede: '<p class="team-page__lede">' + escapeHtml(lede) + '</p>',
        join: '<div class="team-page__acts">' + button('join', jt('team.projects.addMyself', 'Add myself'), { variant: 'primary', title: jt('team.projects.addMyselfTitle', 'Join {project} as an admin', { project: name() }), disabled: live.busy.has('join') })
          + (live.confirmDelete ? '' : button('delete', jt('team.projects.delete', 'Delete project…'), { title: jt('team.projects.deleteTitle', 'Delete {project} for everyone', { project: name() }) })) + '</div>'
          + note(live.notes.join) + (live.confirmDelete ? deleteSection(null) : note(live.notes.delete)) };
    }

    // ------------------------------------------------------------ drawing

    root.innerHTML = OUTSIDE.map((part) => '<div data-page-part="' + part + '"></div>').join('') + '<div class="team-page"><div class="team-page__inner">'
      + INSIDE.map((part) => '<div data-page-part="' + part + '"></div>').join('') + '</div></div>';
    const partsEl = Object.fromEntries([...OUTSIDE, ...INSIDE].map((part) => [part, root.querySelector('[data-page-part="' + part + '"]')]));

    const dataKey = (el) => (el.dataset ? el.dataset.requestSeq || el.dataset.ruleSeq || el.dataset.memberId || '' : '');
    function focused() {
      const active = root.ownerDocument.activeElement;
      if (!active || !root.contains(active)) return null;
      const part = active.closest('[data-page-part]');
      return { id: active.id, action: active.dataset ? active.dataset.projectAction || active.dataset.teamTabAction || '' : '', seq: dataKey(active), part: part ? part.dataset.pagePart : '' };
    }
    // The control again; else, in the part it was in, a confirm's first field or its Cancel; else the part's first
    // button; else the back button.
    function refocus(key) {
      const doc = root.ownerDocument;
      if (!key || (doc.activeElement && doc.activeElement !== doc.body && root.contains(doc.activeElement))) return;
      const part = partsEl[key.part] || root;
      const same = (key.id && doc.getElementById(key.id)) || [...root.querySelectorAll('[data-project-action], [data-team-tab-action]')]
        .find((el) => (el.dataset.projectAction || el.dataset.teamTabAction) === key.action && dataKey(el) === key.seq);
      const confirm = part.querySelector('.team-set-confirm');
      const next = (same && !same.disabled && same)
        || (confirm && (confirm.querySelector('input, select, textarea') || [...confirm.querySelectorAll('button:not([disabled])')].pop()))
        || part.querySelector('button:not([disabled])') || root.querySelector('.team-back');
      if (next && typeof next.focus === 'function') next.focus({ preventScroll: true });
    }

    function draw() {
      if (live.disposed) return;
      // Not listed: a page just created waits for its row; any other was left, removed or deleted.
      if (!state() || (!row() && !(unjoined() && isOwner()))) { if (!(ctx().fresh && ctx().fresh())) onClose(); return; }
      syncParts();
      const next = row() ? memberParts() : notMemberParts();
      const key = focused();
      for (const [part, el] of Object.entries(partsEl)) {
        const html = next[part] || '';
        if (last[part] === html) continue;
        column.writeKeeping(el, html, KEEP);
        last[part] = html;
        renders.page += 1;
        renders[part] = (renders[part] || 0) + 1;
      }
      refocus(key);
    }

    // ------------------------------------------------------------ actions

    // H21.1: Remove and Leave ask first. The confirm's Cancel takes the focus; Cancel, Escape and the answer close it and give the focus back.
    function focusControl(action, memberId) {
      const el = Array.from(root.querySelectorAll('[data-project-action="' + action + '"]')).find((b) => !memberId || b.dataset.memberId === memberId);
      if (el && !el.disabled) el.focus({ preventScroll: true });
    }
    function ask(kind, memberId = '') {
      live.confirm = { kind, memberId };
      draw();
      const cancel = partsEl.members.querySelector('.team-set-confirm [data-project-action$="-cancel"]');
      if (cancel) cancel.focus({ preventScroll: true });
    }
    function closeConfirm() {
      const c = live.confirm;
      live.confirm = null;
      draw();
      if (c) focusControl(c.kind === 'leave' ? 'leave' : 'member-remove', c.memberId);
    }
    async function confirmed(kind, memberId, method, payload, after) {
      await run(kind === 'leave' ? 'leave' : 'remove:' + memberId, 'members', method, payload, after);
      if (live.disposed) return;
      live.confirm = null;
      draw();
      focusControl(kind === 'leave' ? 'leave' : 'member-remove', memberId);
    }

    function browse(target) {
      const files = explorer();
      if (files) files.open({ teamId, projectId, projectName: name(), from: target });
    }

    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-project-action]') : null;
      if (!target || target.disabled || !root.contains(target)) return;
      if (rules && rules.onClick(target)) return;
      if (activity && activity.onClick(target)) return;
      const memberId = target.dataset.memberId;
      switch (target.dataset.projectAction) {
        case 'rename': live.rename = { value: (row() || {}).name || '' }; draw(); { const field = root.querySelector('#' + RENAME_ID); if (field) field.focus(); } return;
        case 'rename-cancel': live.rename = null; draw(); return;
        case 'rename-save': {
          const checked = column.checkName(live.rename ? live.rename.value : '');
          if (!checked.ok) { live.notes.header = ctx().errorText({ reason: checked.reason }); draw(); return; }
          void run('rename', 'header', 'projectRename', { name: checked.name }, () => { live.rename = null; store.reread(teamId); });
          return;
        }
        case 'upload': void run('upload', 'files', 'uploadFolder', {}); return;
        case 'download': void run('download', 'files', 'downloadProject', {}); return;
        case 'upload-cancel': void run('cancel', 'files', 'uploadCancel', {}); return;
        case 'download-cancel': void run('cancel', 'files', 'downloadCancel', {}); return;
        case 'browse-files': browse(target); return;
        case 'board-open': void openBoard(target.dataset.boardId); return;
        case 'member-remove': ask('remove', memberId); return;
        case 'member-remove-go': void confirmed('remove', memberId, 'projectRemoveMember', { member_id: memberId }, () => readMembers()); return;
        case 'member-cancel': case 'leave-cancel': closeConfirm(); return;
        case 'member-add': void run('add', 'members', 'projectAddMember', { member_id: live.addWho, role: addRoleOf() }, () => readMembers()); return;
        case 'leave': ask('leave'); return;
        case 'leave-go': void confirmed('leave', '', 'projectLeave', {}, () => { store.reread(teamId); onClose(); }); return;
        case 'delete': live.confirmDelete = true; draw(); return;
        case 'delete-cancel': live.confirmDelete = false; draw(); return;
        case 'delete-go': void run('delete', 'delete', 'projectDelete', {}, () => { store.reread(teamId); onClose(); }); return;
        case 'join': void run('join', 'join', 'projectJoin', { role: 'admin' }, () => store.reread(teamId)); return;
        case 'conv-new': onShow({ newConversation: projectId }); return;
        default:
      }
    }

    function onInput(event) {
      const target = event.target;
      if (!target || !target.dataset) return;
      if (rules && rules.onInput(target)) return;
      if (target.dataset.projectInput === 'rename' && live.rename) live.rename.value = target.value;
    }

    function onChange(event) {
      const target = event.target;
      if (!target || !target.dataset) return;
      if (rules && rules.onSelect(target)) return;
      const key = target.dataset.projectInput;
      if (key === 'add-who') { live.addWho = target.value; draw(); } else if (key === 'add-role') live.addRole = target.value;
      else if (key === 'member-role') {
        const memberId = target.dataset.memberId;
        void run('role:' + memberId, 'members', 'projectSetMember', { member_id: memberId, role: target.value }, () => readMembers());
      }
    }

    function onKeydown(event) {
      if ((event.key === 'Escape' || event.key === 'Esc') && live.confirm && event.target && event.target.closest && event.target.closest('.team-set-confirm') && partsEl.members.contains(event.target)) {
        event.preventDefault();
        closeConfirm();
        return;
      }
      if (event.target && event.target.id === RENAME_ID) {
        if (event.key === 'Enter') { event.preventDefault(); onClick({ target: root.querySelector('[data-project-action="rename-save"]') }); }
        else if (event.key === 'Escape') { event.preventDefault(); live.rename = null; draw(); }
      }
    }

    const listeners = [['click', onClick], ['input', onInput], ['change', onChange], ['keydown', onKeydown]];
    for (const [type, handler] of listeners) root.addEventListener(type, handler);
    live.rowKey = JSON.stringify(row());
    readMembers();
    readBoards();
    draw();

    return {
      // Only a change of this team moves the page: its own row reads the members again; its rules, requests or a
      // finished transfer read the rules and the activity again.
      update(change) {
        if (!change || change.team_id !== teamId || live.disposed) return;
        if (change.type === 'projects') {
          const key = JSON.stringify(row());
          if (key !== live.rowKey) { live.rowKey = key; readMembers(); readBoards(); } else if (!live.boards) readBoards();
        }
        if ((change.type === 'rules' || change.type === 'requests') && change.project_id === projectId) {
          if (rules) void rules.refresh();
          if (activity) void activity.refresh();
          return;
        }
        if (change.type === 'transfer') {
          const transfer = (state() || {}).transfer;
          const now = transfer && transfer.project_id === projectId ? transfer.state : '';
          if (now === 'done' && live.transferState !== 'done' && activity) void activity.refresh();
          live.transferState = now;
        }
        if (['projects', 'transfer', 'unjoined', 'roster', 'gone'].includes(change.type)) draw();
      },
      focusTarget: () => root.querySelector('.team-page button:not([disabled]), .team-back'),
      resources: () => ({ listeners: live.disposed ? 0 : listeners.length, rules: Boolean(rules), activity: Boolean(activity) }),
      dispose() {
        if (live.disposed) return;
        live.disposed = true;
        for (const [type, handler] of listeners) root.removeEventListener(type, handler);
        if (rules) rules.dispose();
        if (activity) activity.dispose();
        rules = null;
        activity = null;
      },
    };
  }

  return { createProjectPage };
});
