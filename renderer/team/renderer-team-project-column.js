/* Team tab: the "Projects" section of the left column (row 123, slice 3-10; owner picks 3-10,
 * "Left column", fork 1 A). Between Direct messages and GPUs. Pure markup plus the tab state it owns,
 * kept for the session like the shown channel:
 *
 * - The page shown per team: `proj:<project id>` (the project page) or `conv:<session id>` (a shared conversation),
 *   else none (the channel frame). These are not channel ids (every channel id starts with `chan_`), so they key
 *   their own frames, like the New message view's `channels.NEW`.
 * - Folds: open or folded per team, per member and per project, in memory; the first project is open by default.
 * - The create field per team: the name typed so far, a refusal sentence, busy.
 *
 * A project row has a chevron (fold), its name (opens the page), "being deleted" where the data says so, and an
 * admin's waiting always-allow requests as a count. Under it, indented: its channel ("#{project}", the existing
 * project channel row; while the chat rows do not hold it yet, a row that opens nothing: "still loading"), its
 * conversations ("running", an approval count) and "New conversation" (writers and admins). The team owner's
 * projects they are not in are muted rows, name only, "You are not in this project". The plus on the label (owners
 * and members, E22) opens the create field in place. Every name is drawn escaped, bidi isolated (dir="auto") and cut
 * by CSS; a name the host gave longer than 80 characters is cut here too.
 *
 * Shared by the project views (no script file of their own): `button` and `confirmBlock`, `plain` (host text with
 * bidi and zero-width characters removed and cut, for an approval's summary and a saved path), and the checks main
 * makes before it sends (services/team/ipc-methods.js and the host's rules), mirrored so the person reads the
 * matching sentence: `checkName`, `checkFolder`, `checkReason`. tests/team-project-rules-client.test.js pins them
 * to main's. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamProjectColumn = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const PROJECT = 'proj:';
  const CONVERSATION = 'conv:';
  const NAME_MAX = 80;
  const FOLDS_MAX = 512;
  const CREATE_ID = 'teamProjectNewName';
  const RENAME_ID = 'teamConversationRename';
  const TITLE_MAX = 80;
  const SVG = (paths) => '<svg viewBox="0 0 16 16" aria-hidden="true">' + paths + '</svg>';
  const CHEVRON = SVG('<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>');
  const PLUS = SVG('<path d="M8 3.5v9M3.5 8h9"/>');
  const DOTS = SVG('<circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/>');
  const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
  const HIDDEN = /[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

  function inv() { return globalThis.inventory || {}; }
  const cut = (text, max) => { const chars = Array.from(text); return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text; };
  // A host name as shown: bidi controls removed (dir="auto" isolates it), cut to the host's own bound.
  function clean(text, max = NAME_MAX) { return cut(String(text == null ? '' : text).replace(BIDI, ''), max); }
  // Host text a person decides on (an approval's summary, a saved path): bidi and zero-width characters removed, cut.
  function plain(text, max) { return cut(String(text == null ? '' : text).replace(HIDDEN, '').trim(), max); }

  // The one button of the project views: an action on `data-project-action`, a tooltip on every one.
  function button(action, label, { variant = 'secondary', title = label, disabled = false, dataset = {}, ariaLabel = '', ariaDescription = '' } = {}) {
    return inv().actionButton({ label, variant, size: 'sm', title, disabled, dataset: { 'project-action': action, ...dataset },
      ...(ariaLabel ? { ariaLabel } : {}), ...(ariaDescription ? { ariaDescription } : {}) });
  }
  // The one confirm of the project views: a named group, its sentence, its buttons (the first is focused on open).
  function confirmBlock(label, text, actions, className = 'team-set-confirm') {
    return '<div class="' + className + '" role="group" aria-label="' + escapeHtml(label) + '"><p dir="auto">' + escapeHtml(text) + '</p><div class="team-set-inline">' + actions + '</div></div>';
  }

  // Writes `html` into `el`, keeping a field named in `keepIds` that is already there (its node, value, caret, IME
  // composition and undo): the nodes around it are replaced, the field and its ancestors stay, their attributes (all
  // but a field's value) taken from the new markup. With no such field, or none in the new markup, it is a plain write.
  function writeKeeping(el, html, keepIds) {
    const doc = el.ownerDocument;
    const field = keepIds.map((id) => doc.getElementById(id)).find((node) => node && el.contains(node));
    const holder = field ? doc.createElement('template') : null;
    if (holder) holder.innerHTML = html;
    const twin = holder ? holder.content.querySelector('[id="' + field.id + '"]') : null;
    if (!twin) { el.innerHTML = html; return; }
    patchAround(el, holder.content, field, twin);
  }
  function patchAround(live, fresh, field, twin) {
    const keep = [...live.childNodes].find((node) => node === field || node.contains(field));
    const match = [...fresh.childNodes].find((node) => node === twin || node.contains(twin));
    for (const node of [...live.childNodes]) if (node !== keep) node.remove();
    const incoming = [...fresh.childNodes];
    const at = incoming.indexOf(match);
    for (const node of incoming.slice(0, at)) keep.before(node);
    keep.after(...incoming.slice(at + 1));
    for (const attr of [...keep.attributes]) if (!match.hasAttribute(attr.name) && attr.name !== 'value') keep.removeAttribute(attr.name);
    for (const attr of [...match.attributes]) if (attr.name !== 'value' && keep.getAttribute(attr.name) !== attr.value) keep.setAttribute(attr.name, attr.value);
    if (keep !== field) patchAround(keep, match, field, twin);
  }

  // ---------------------------------------------------------- main's checks

  const CONTROL = /\p{Cc}/u;
  const ENCODER = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  const bytes = (text) => (ENCODER ? ENCODER.encode(text).length : text.length * 3);
  // A project name (ipc-methods.js projectName): 1 to 80 UTF-16 units, no control character; sent trimmed.
  function checkName(text) {
    const name = String(text == null ? '' : text).trim();
    return name && name.length <= NAME_MAX && !CONTROL.test(name) ? { ok: true, name } : { ok: false, reason: 'team_project_name_invalid' };
  }
  // A rule's folder (server/team/project-rules-match.js validateFolder with path-segments.js): relative, 1 to 8
  // segments, at most 255 characters and 512 bytes, each segment a name the upload rules take, none hidden, no
  // C1, separator, bidi or zero-width character. Sent trimmed of spaces at its ends.
  const SEGMENT_BAD = /[\\:<>"|?*\p{Cc}]/u;
  const RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]) *(?:\..*)?$/iu;
  const UNSAFE = /[\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/u;
  const wellFormed = (text) => typeof text.isWellFormed !== 'function' || text.isWellFormed();
  function checkFolder(text) {
    const folder = String(text == null ? '' : text).trim();
    const segments = folder.split('/');
    const bad = !folder || folder.length > 255 || bytes(folder) > 512 || segments.length > 8 || /^[A-Za-z]:/u.test(folder) || !wellFormed(folder) || UNSAFE.test(folder)
      || segments.some((s) => !s || s.startsWith('.') || bytes(s) > 255 || SEGMENT_BAD.test(s) || /[. ]$/u.test(s) || RESERVED.test(s));
    return bad ? { ok: false, reason: 'team_rule_folder_invalid' } : { ok: true, folder };
  }
  // A decline reason (server/team/member-schema.js isInputText, 200): NFC, no control, separator, bidi or hidden
  // character (a joiner, an emoji presentation or a Han variation selector excepted), something visible, at most 200
  // characters. Sent trimmed and in NFC.
  const INVISIBLE = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
  const IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
  const NOT_VISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Z}\p{Cf}\u{2800}]/gu;
  function allowedIgnorable(point, previous) {
    if (point === '\u200c' || point === '\u200d') return true;
    if (previous === undefined) return false;
    if (/^\p{Script=Han}$/u.test(previous)) return /^[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]$/u.test(point);
    return (point === '\ufe0e' || point === '\ufe0f') && /^[\p{Extended_Pictographic}0-9#*]$/u.test(previous);
  }
  function checkReason(text) {
    const reason = String(text == null ? '' : text).trim().normalize('NFC');
    const points = Array.from(reason);
    const bad = !reason || points.length > 200 || reason.trim() !== reason || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(reason) || INVISIBLE.test(reason)
      || reason.replace(/[\p{Cf}\p{Z}]/gu, '').length === 0 || reason.replace(NOT_VISIBLE, '').length === 0
      || points.some((point, index) => IGNORABLE.test(point) && !allowedIgnorable(point, points[index - 1]));
    return bad ? { ok: false, reason: 'team_rule_reason_invalid' } : { ok: true, reason };
  }

  // ------------------------------------------------------------- tab state

  const views = new Map(); // team id -> 'proj:<id>' | 'conv:<id>'
  const folds = new Map(); // team|member|project -> open
  const creating = new Map(); // team id -> { name, error, busy }
  const fresh = new Map(); // team id -> a page just opened whose row has not arrived yet
  const rowing = new Map(); // team id -> { sessionId, mode: 'rename' | 'confirm' | 'note', value, busy, note }: one conversation row

  const isPage = (id) => typeof id === 'string' && (id.startsWith(PROJECT) || id.startsWith(CONVERSATION));
  const projectPage = (projectId) => PROJECT + projectId;
  const conversationPage = (sessionId) => CONVERSATION + sessionId;
  const idOf = (page) => String(page).slice(String(page).indexOf(':') + 1);
  function viewOf(teamId) { return views.get(teamId) || ''; }
  function show(teamId, page, opened = false) {
    if (page) views.set(teamId, page); else views.delete(teamId);
    if (opened && page) fresh.set(teamId, page); else fresh.delete(teamId);
  }
  // A page just created (a project, a conversation) is shown before the list names it; once listed it is settled.
  const isFresh = (teamId, page) => fresh.get(teamId) === page;
  function settle(teamId, page) { if (fresh.get(teamId) === page) fresh.delete(teamId); }
  function foldKey(teamId, memberId, projectId) { return teamId + '|' + memberId + '|' + projectId; }
  function isOpen(teamId, memberId, projectId, index) {
    const key = foldKey(teamId, memberId, projectId);
    return folds.has(key) ? folds.get(key) : index === 0;
  }
  function toggle(teamId, memberId, projectId, index) {
    const key = foldKey(teamId, memberId, projectId);
    const open = !isOpen(teamId, memberId, projectId, index);
    folds.delete(key);
    folds.set(key, open);
    while (folds.size > FOLDS_MAX) folds.delete(folds.keys().next().value);
  }
  // A project gone from this member's list: its fold goes too.
  function pruneFolds(teamId, memberId, projectIds) {
    const prefix = teamId + '|' + memberId + '|';
    const keep = new Set(projectIds);
    for (const key of [...folds.keys()]) if (key.startsWith(prefix) && !keep.has(key.slice(prefix.length))) folds.delete(key);
  }
  function createOf(teamId) { return creating.get(teamId) || null; }
  function openCreate(teamId) { if (!creating.has(teamId)) creating.set(teamId, { name: '', error: '', busy: false }); }
  function closeCreate(teamId) { creating.delete(teamId); }
  // A team left or gone: its pages and its field go; the folds are the member's own and stay for the session.
  function forgetTeam(teamId) { views.delete(teamId); creating.delete(teamId); fresh.delete(teamId); rowing.delete(teamId); }
  function rowOf(teamId) { return rowing.get(teamId) || null; }
  function openRow(teamId, sessionId, mode, value = '') { rowing.set(teamId, { sessionId, mode, value, busy: false, note: '' }); }
  function closeRow(teamId) { rowing.delete(teamId); }

  // What the row's menu offers this member (role: the project role, the team owner counts as an admin). A choice the
  // member may not use stays, disabled, with the reason.
  function rowMenu({ role, owner = false, running = false }) {
    const admin = owner || role === 'admin' || role === 'owner';
    const mayRename = admin || role === 'writer';
    let reason = '';
    if (!admin) reason = jt('team.projects.deleteAdmins', 'Only the project’s admins can delete');
    else if (running) reason = jt('team.projects.deleteRunning', 'A turn is running. Stop it first');
    return [
      { id: 'rename', label: jt('team.projects.convRename', 'Rename'), disabled: !mayRename, danger: false, description: mayRename ? '' : jt('team.projects.renameReader', 'Only writers and admins can rename') },
      { id: 'delete', label: jt('team.projects.convDelete', 'Delete'), disabled: Boolean(reason), danger: true, description: reason },
    ];
  }

  // --------------------------------------------------------------- markup

  function iconButton(action, label, svg, dataset = {}) {
    return inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: label, title: label, dataset: { 'team-tab-action': action, ...dataset }, trustedHtml: svg });
  }

  function rowButton(action, { name, title, current = false, muted = false, trailing = '', dataset = {}, extraClass = '', plus = false, disabled = false }) {
    const html = inv().actionButton({
      plain: true, className: 'team-row team-row--link' + extraClass, ariaLabel: title, title, disabled,
      dataset: { 'team-tab-action': action, 'team-project-row': 'true', ...dataset },
      trustedHtml: '<span class="team-row__name"' + (muted ? ' data-muted="true"' : '') + ' dir="auto">' + (plus ? '<span aria-hidden="true">+</span> ' : '') + escapeHtml(name) + '</span>' + trailing,
    });
    return current ? html.replace(/^(<[a-z]+)/, '$1 aria-current="true"') : html.replace(/^(<[a-z]+)/, '$1 aria-current="false"');
  }

  // A project channel the chat rows do not hold yet: drawn (the project exists) but not a link, since opening it would
  // fall back to #team. It becomes the normal channel row once the chat rows list it.
  function loadingChannelRow(channelId, name) {
    const tip = jt('team.projects.channelLoading', 'This channel is still loading.');
    return inv().actionButton({ plain: true, className: 'team-row', ariaLabel: jt('team.projects.rowWith', '{name}, {facts}', { name: '#' + name, facts: tip }), title: tip, dataset: { 'team-channel-loading': channelId },
      trustedHtml: '<span class="team-row__glyph" aria-hidden="true">#</span><span class="team-row__name" dir="auto">' + escapeHtml(name) + '</span>' }).replace(/^(<[a-z]+)/, '$1 aria-disabled="true"');
  }

  // A conversation row's link: the title, then (running dot, approvals count) at the end; its name says what the dot shows.
  function conversationLink(pv, row, title) {
    const activity = pv.activity[row.session_id] || null;
    const words = [];
    let trailing = '';
    if (activity && activity.running) {
      const running = jt('team.projects.running', 'running');
      words.push(running);
      trailing += '<span class="status-dot status-dot--active" role="img" aria-label="' + escapeHtml(running) + '"></span>';
    }
    if (activity && activity.approvals > 0) {
      words.push(jtn('team.projects.approvalsWaiting', activity.approvals, {}, '{count} approval waiting', '{count} approvals waiting'));
      trailing += '<span class="team-count" aria-hidden="true">' + escapeHtml(String(activity.approvals)) + '</span>';
    }
    const label = words.length ? jt('team.projects.rowWith', '{name}, {facts}', { name: title, facts: words.join(', ') }) : title;
    return rowButton('conv-open', { name: title, title: label, current: pv.current === conversationPage(row.session_id), trailing: trailing ? '<span class="team-row__trail">' + trailing + '</span>' : '',
      dataset: { 'session-id': row.session_id } });
  }

  function conversationMenuButton(row, project, title) {
    const label = jt('team.projects.rowActions', 'Actions for {title}', { title });
    return inv().actionButton({ plain: true, className: 'team-icon-btn team-row__menu', ariaLabel: label, title: label, ariaHaspopup: 'menu', ariaExpanded: false,
      dataset: { 'team-tab-action': 'conv-menu', 'session-id': row.session_id, 'project-id': project.id }, trustedHtml: DOTS });
  }

  function deleteConfirm(state, title, project) {
    const label = jt('team.projects.deleteConversation', 'Delete conversation');
    const cancel = jt('team.projects.cancel', 'Cancel');
    const dataset = (action) => ({ 'team-tab-action': action, 'session-id': state.sessionId });
    const sentence = jt('team.projects.deleteConversationConfirm', 'Delete “{title}” for everyone in {project}? This cannot be undone.', { title, project: clean(project.name) });
    return '<div class="team-row__confirm" role="group" aria-label="' + escapeHtml(label) + '"><p dir="auto">' + escapeHtml(sentence) + '</p><div>'
      + inv().actionButton({ label: jt('team.projects.convDelete', 'Delete'), variant: 'danger', size: 'sm', title: label, dataset: dataset('conv-delete-yes'), disabled: state.busy })
      + inv().actionButton({ label: cancel, variant: 'ghost', size: 'sm', title: cancel, dataset: dataset('conv-delete-no') }) + '</div></div>';
  }

  // The row: its link and menu button, or the rename field in their place; a delete confirm and a refusal's sentence under it.
  function conversationRow(pv, row, project) {
    const title = clean(row.title) || jt('team.projects.untitled', 'Untitled conversation');
    const state = pv.rowing && pv.rowing.sessionId === row.session_id ? pv.rowing : null;
    const rename = state && state.mode === 'rename';
    const inside = rename
      ? globalThis.inventoryTextField({ id: RENAME_ID, value: state.value, ariaLabel: jt('team.projects.convNameLabel', 'Conversation name'), maxLength: TITLE_MAX, disabled: state.busy })
      : conversationLink(pv, row, title) + conversationMenuButton(row, project, title);
    return '<div class="team-row--conv' + (rename ? ' team-inline-name' : '') + '" data-conv-row="' + escapeHtml(row.session_id) + '">' + inside + '</div>'
      + (state && state.mode === 'confirm' ? deleteConfirm(state, title, project) : '')
      + (state && state.note ? '<p class="team-set-note team-proj__note" role="status">' + escapeHtml(state.note) + '</p>' : '');
  }

  function projectBlock(pv, row, index, helpers) {
    const name = clean(row.name);
    const open = isOpen(pv.teamId, pv.me, row.id, index);
    const deleting = pv.deleting.has(row.id);
    const requests = pv.requests[row.id] || 0;
    const facts = [];
    let trailing = '';
    if (deleting) {
      facts.push(jt('team.projects.beingDeleted', 'being deleted'));
      trailing += '<span class="team-row__role" aria-hidden="true">' + escapeHtml(jt('team.projects.beingDeleted', 'being deleted')) + '</span>';
    }
    if (requests > 0) {
      facts.push(jtn('team.projects.requestsWaiting', requests, {}, '{count} always-allow request waits for you', '{count} always-allow requests wait for you'));
      trailing += '<span class="team-count" aria-hidden="true">' + escapeHtml(String(requests)) + '</span>';
    }
    const label = facts.length ? jt('team.projects.rowWith', '{name}, {facts}', { name, facts: facts.join(', ') }) : name;
    const fold = open ? jt('team.projects.fold', 'Fold {project}', { project: name }) : jt('team.projects.unfold', 'Unfold {project}', { project: name });
    const chevron = inv().actionButton({ plain: true, className: 'team-proj__chev', ariaLabel: fold, title: fold, ariaExpanded: open,
      dataset: { 'team-tab-action': 'project-fold', 'project-id': row.id, 'project-index': String(index) }, trustedHtml: CHEVRON });
    const channelId = 'chan_' + row.id;
    const listed = pv.channelRowOf(channelId);
    const channel = listed ? helpers.channelRow(listed, { name, title: '#' + name }) : loadingChannelRow(channelId, name);
    const writes = row.role === 'admin' || row.role === 'writer' || row.role === 'owner';
    const kids = channel + pv.conversationsOf(row.id).map((conversation) => conversationRow(pv, conversation, row)).join('')
      + (writes && !deleting ? rowButton('conv-new', { name: jt('team.projects.newConversation', 'New conversation'), disabled: pv.making === true,
        title: pv.making ? jt('team.projects.creatingConversation', 'A conversation is being created.') : jt('team.projects.newConversationIn', 'New conversation in {project}', { project: name }),
        extraClass: ' team-proj__new', plus: true, dataset: { 'project-id': row.id } }) : '');
    return '<div class="team-proj" data-open="' + open + '" data-team-project="' + escapeHtml(row.id) + '"><div class="team-proj__head">' + chevron
      + rowButton('project-open', { name, title: label, current: pv.current === projectPage(row.id), trailing, dataset: { 'project-id': row.id } })
      + '</div><div class="team-proj__kids">' + kids + '</div></div>';
  }

  // The owner's project they are not in: name only, muted, no chevron and nothing under it.
  function unjoinedBlock(pv, row) {
    const name = clean(row.name) || jt('team.projects.unnamed', 'A project');
    const tip = jt('team.projects.notMember', 'You are not in this project');
    return '<div class="team-proj" data-open="false" data-team-project="' + escapeHtml(row.project_id) + '"><div class="team-proj__head"><span class="team-proj__gap" aria-hidden="true"></span>'
      + rowButton('project-open', { name, title: jt('team.projects.notMemberRow', '{project}, you are not in this project', { project: name }), muted: true,
        current: pv.current === projectPage(row.project_id), dataset: { 'project-id': row.project_id, 'project-unjoined': 'true' } }).replace(/ title="[^"]*"/, ' title="' + escapeHtml(tip) + '"')
      + '</div></div>';
  }

  function createHtml(pv) {
    const field = pv.create;
    if (!field) return '';
    const label = jt('team.projects.nameLabel', 'Project name');
    const create = jt('team.projects.create', 'Create');
    const cancel = jt('team.projects.cancel', 'Cancel');
    return '<div class="team-inline-name" data-team-project-create>' + globalThis.inventoryTextField({ id: CREATE_ID, value: field.name, ariaLabel: label, placeholder: label, maxLength: NAME_MAX, disabled: field.busy })
      + inv().actionButton({ label: create, variant: 'primary', size: 'sm', title: jt('team.projects.createTitle', 'Create this project'), dataset: { 'team-tab-action': 'project-create' }, disabled: field.busy })
      + inv().actionButton({ label: cancel, variant: 'ghost', size: 'sm', title: cancel, dataset: { 'team-tab-action': 'project-create-cancel' } }) + '</div>'
      + (field.error ? '<p class="team-set-note team-proj__note" role="status">' + escapeHtml(field.error) + '</p>' : '');
  }

  // The section, or '' while the team is not online. `pv` is `columnView`'s; `helpers`: the tab view's
  // `channelRow(channel, { name, title })`.
  function sectionHtml(pv, helpers) {
    if (!pv || (!pv.loaded && !pv.error)) return ''; // drawn once the list is read
    const add = pv.mayCreate ? iconButton('project-new', jt('team.projects.new', 'New project'), PLUS) : '';
    const head = '<h3 class="team-panel__label"><span>' + escapeHtml(jt('team.projects.heading', 'Projects')) + '</span>' + add + '</h3>';
    let body;
    if (pv.error) body = '<p class="team-set-note team-proj__note" role="status">' + escapeHtml(pv.error) + '</p>';
    else {
      const rows = pv.projects.map((row, index) => projectBlock(pv, row, index, helpers)).join('') + pv.unjoined.map((row) => unjoinedBlock(pv, row)).join('');
      body = createHtml(pv) + (rows || (pv.create ? '' : '<p class="team-col-empty">' + escapeHtml(jt('team.projects.none', 'No shared projects yet.')) + '</p>'));
    }
    return '<div class="team-projects" data-team-projects>' + head + body + '</div>';
  }

  // The section's view model for one team from the project store's state, or null when the team is not online (Force
  // local takes the team out of `online`, so the section goes with it). `channelRows`: the chat store's rows of the
  // team (a project channel row may not be there yet: `channelRowOf` answers null for it).
  function columnView({ team, state, current = '', channelRows = [], errorText = () => '', making = false }) {
    if (!team || team.state !== 'online') return null;
    const mayCreate = team.role === 'owner' || team.role === 'member';
    if (!state) return { teamId: team.team_id, mayCreate, loaded: false };
    const byChannel = new Map((channelRows || []).filter(Boolean).map((row) => [row.channel_id, row]));
    const joined = new Set((state.projects || []).map((row) => row.id));
    // A row whose conversation is no longer listed loses its state.
    let open = rowOf(team.team_id);
    if (open && !(state.conversations || []).some((row) => row.session_id === open.sessionId)) { closeRow(team.team_id); open = null; }
    return {
      teamId: team.team_id, me: team.member_id, mayCreate, current, making, loaded: Array.isArray(state.projects),
      error: state.error && !state.projects ? errorText(state.error) : '',
      projects: state.projects || [], unjoined: team.role === 'owner' ? state.unjoined.filter((row) => !joined.has(row.project_id)) : [],
      activity: state.activity || {}, requests: state.requests || {}, deleting: state.deleting || new Set(), create: createOf(team.team_id), rowing: open,
      conversationsOf: (projectId) => state.conversations.filter((row) => row.project_id === projectId),
      channelRowOf: (id) => byChannel.get(id) || null,
    };
  }

  // The create and rename fields keep their caret at the end after the lists were written again under them.
  function afterWrite(root) {
    for (const id of [CREATE_ID, RENAME_ID]) {
      const input = root && root.querySelector ? root.querySelector('#' + id) : null;
      if (input && input.ownerDocument.activeElement === input && typeof input.setSelectionRange === 'function') input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  return { PROJECT, CREATE_ID, RENAME_ID, TITLE_MAX, clean, plain, button, confirmBlock, writeKeeping, checkName, checkFolder, checkReason, isPage, projectPage, conversationPage, idOf, viewOf, show, isFresh, settle,
    toggle, pruneFolds, createOf, openCreate, closeCreate, rowOf, openRow, closeRow, rowMenu, forgetTeam, sectionHtml, columnView, afterWrite };
});
