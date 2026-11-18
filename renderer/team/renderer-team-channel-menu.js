/* Team channel management (row 173, renderer slice; owner picks 2026-11-16, mockup team-channels): the one rules
 * function, the words of a refusal, the header's options menu, the in-place rename and topic, the delete confirmation and
 * the change lines of the timeline. The host stays the authority; everything here only decides what is offered.
 *
 * - `channelActions(row, team, nameOf)`: per action (`create`, `rename`, `topic`, `archive`, `unarchive`, `delete`) null
 *   when the viewer may, else the reason shown on the disabled control. The plan's rules table: any member who is not
 *   read-only creates; the creator or the owner renames, sets the topic and archives a custom channel; the owner sets
 *   #team's topic, unarchives, and deletes an archived channel; #team can never be renamed, archived or deleted.
 * - `createChannelUi(deps)`: the tab's controller for this view (one for the session; `dispose` ends what is open). It
 *   holds the Archived fold per team, the open options menu, the rename or topic edit in the header and the delete
 *   dialog. Its `read` is part of the tab's view model, `click` takes the tab's channel actions, `onKey` and `onInput`
 *   take the keys of an open edit.
 * - An unavailable action is greyed out with its reason as the item's description, never hidden. A failed save keeps the
 *   edit open with the reason beside it; a failed archive says why in the header's note; a failed delete says why in
 *   its dialog. Names and topics are other members' text: escaped, `dir="auto"`.
 * - The change lines (`changeHtml`, `placeChanges`): one quiet line after the message a change followed. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'));
    return;
  }
  root.rendererTeamChannelMenu = factory(root.rendererSettingsTeamStrings);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const NAME_MAX = 40;
  const TOPIC_MAX = 250;
  const CHANNELS_MAX = 32; // the host's bound on live custom channels
  const BUTTON_ID = 'teamChannelMenuButton';
  const DELETE_ID = 'team-channel-delete';
  const DOTS = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/></svg>';

  const isChannelRow = (row) => Boolean(row) && (row.kind === 'team' || row.kind === 'channel');
  const length = (text) => Array.from(text).length;
  // What the host stores: NFC, trimmed, inner runs of white space as one space.
  const normalizeName = (raw) => String(raw == null ? '' : raw).normalize('NFC').replace(/\s+/gu, ' ').trim();
  const normalizeTopic = (raw) => String(raw == null ? '' : raw).normalize('NFC').replace(/\s*[\r\n]+\s*/gu, ' ').trim();

  // ------------------------------------------------------------------ rules

  const readOnlyWhy = () => jt('team.channels.why.readOnly', 'Read-only members can read channels but not change them.');
  // Whether this member may make a channel: null, or why not.
  function createWhy(team) { return team && team.role === 'read_only' ? readOnlyWhy() : null; }

  // `nameOf(member_id)`: a display name or '' (the creator, named in the reason shown to someone else).
  function channelActions(row, team, nameOf = () => '') {
    const actions = ['create', 'rename', 'topic', 'archive', 'unarchive', 'delete'];
    const all = (why) => Object.fromEntries(actions.map((name) => [name, why]));
    const create = createWhy(team);
    if (create) return all(create);
    if (!row) return { ...all(jt('team.channels.why.none', 'This channel cannot be changed here.')), create: null };
    const owner = team.role === 'owner';
    const label = row.kind === 'team' ? 'team' : String(row.name || '');
    if (row.kind === 'team') {
      const fixed = jt('team.channels.why.fixed', '#team is the team’s own channel: everyone is in it and its name stays.');
      return { ...all(fixed), create: null, topic: owner ? null : jt('team.channels.why.teamTopic', 'Only the owner sets #team’s topic.') };
    }
    if (row.kind !== 'channel') return { ...all(jt('team.channels.why.none', 'This channel cannot be changed here.')), create: null };
    const mayEdit = owner || (Boolean(team.member_id) && row.created_by === team.member_id);
    const maker = nameOf(row.created_by);
    const who = maker ? jt('team.channels.why.who', '{name}, who made it, or the owner', { name: maker }) : jt('team.channels.why.whoOwner', 'the owner');
    const editWhy = row.archived ? jt('team.channels.why.archivedEdit', 'It is archived. Unarchive it to change it.')
      : (mayEdit ? null : jt('team.channels.why.only', 'Only {who} can change #{channel}.', { who, channel: label }));
    return {
      create: null, rename: editWhy, topic: editWhy,
      archive: row.archived ? jt('team.channels.why.alreadyArchived', 'It is already archived.') : editWhy,
      unarchive: !row.archived ? jt('team.channels.why.notArchived', 'It is not archived.')
        : (owner ? null : jt('team.channels.why.unarchiveOwner', 'Only the owner can bring an archived channel back.')),
      delete: !owner ? jt('team.channels.why.deleteOwner', 'Only the owner can delete a channel.')
        : (row.archived ? null : jt('team.channels.why.deleteLive', 'Archive it first. A live channel cannot be deleted in one step.')),
    };
  }

  // The problem with a name as typed, in words, or ''. `rows`: the team's channel rows (a name is unique across #team, the live
  // and the archived channels, case ignored); `selfId`: the channel being renamed, which may keep its own name.
  function nameProblem(raw, rows, selfId = '') {
    const name = normalizeName(raw);
    if (!name) return '';
    if (length(name) > NAME_MAX) return jt('team.channels.nameLong', 'Up to {count} characters.', { count: NAME_MAX });
    if (name.startsWith('#')) return jt('team.channels.nameHash', 'Do not start the name with #.');
    const same = name.toLowerCase();
    const hit = (rows || []).find((row) => row && row.channel_id !== selfId && (row.kind === 'team' || row.kind === 'channel') && String(row.name || '').toLowerCase() === same);
    if (!hit) return '';
    return hit.archived ? jt('team.channels.nameArchived', 'An archived channel is named #{name}. Unarchive it, or pick another name.', { name: hit.name })
      : jt('team.channels.nameTaken', 'There is already a #{name}.', { name: hit.name });
  }

  // The host's refusal in words (an answer, or the error it carries).
  function failText(answer) {
    const error = answer && answer.error ? answer.error : answer;
    switch (error && error.reason) {
      case 'team_chat_channel_name_taken': return jt('team.channels.fail.taken', 'There is already a channel with that name.');
      case 'team_chat_channel_name_invalid': return jt('team.channels.fail.name', 'That name is not allowed. Use 1 to 40 characters, with no # at the start.');
      case 'team_chat_channel_topic_invalid': return jt('team.channels.fail.topic', 'That topic is not allowed. Use up to 250 characters on one line.');
      case 'team_chat_channel_cap': return jt('team.channels.fail.cap', 'This team already has {count} channels. Archive one first.', { count: CHANNELS_MAX });
      case 'team_chat_channel_live': return jt('team.channels.fail.live', 'Archive the channel first.');
      case 'team_chat_channel_fixed': return jt('team.channels.fail.fixed', 'That channel cannot be changed.');
      case 'team_chat_archived': return jt('team.channels.fail.archived', 'This channel is archived. Unarchive it to change it.');
      case 'team_chat_stale': return jt('team.channels.fail.stale', 'This channel changed while you were editing. Check its new details and try again.');
      case 'role_forbidden': return jt('team.channels.fail.role', 'You cannot do that in this channel.');
      default: return words.errorText(error || { reason: 'team_unavailable' });
    }
  }

  // ----------------------------------------------------------- change lines

  // One change as a quiet line: the actor in bold ("You" for the viewer), the channel names as isolated text. `c`: the frame
  // context ({ me, nameOf, channelName }).
  function changeHtml(change, c) {
    const actor = change.by === c.me ? jt('team.channels.change.you', 'You') : c.nameOf(change.by);
    const marks = ['', '', '']; // private-use placeholders, replaced after escaping
    const params = { actor: marks[0], channel: marks[1], from: marks[1], to: marks[2] };
    let text;
    switch (change.kind) {
      case 'created': text = jt('team.channels.change.created', '{actor} made {channel} · Everyone on this team can read it', params); break;
      case 'renamed': text = jt('team.channels.change.renamed', '{actor} renamed the channel from {from} to {to}', params); break;
      case 'topic': text = jt('team.channels.change.topic', '{actor} changed the topic', params); break;
      case 'archived': text = jt('team.channels.change.archived', '{actor} archived the channel', params); break;
      case 'unarchived': text = jt('team.channels.change.unarchived', '{actor} brought the channel back', params); break;
      default: return '';
    }
    const values = [actor, '#' + (change.kind === 'renamed' ? change.from : c.channelName), '#' + change.to];
    return escapeHtml(text).replace(/[-]/gu, (mark) => (mark === marks[0] ? '<b dir="auto">' + escapeHtml(values[0]) + '</b>'
      : '<bdi>' + escapeHtml(values[marks.indexOf(mark)]) + '</bdi>'));
  }

  // Where each change goes among the messages held (`list`, oldest first): after the last message at or before its `seq_after`;
  // before the first when none is that early and no older page remains; nowhere while the place may not be loaded yet (older
  // pages unread, or newer ones for a change past the newest held). -> { lead: [change], after: Map(seq -> [change]) }.
  function placeChanges(changes, list, { hasMore = false, hasNewer = false } = {}) {
    const placed = { lead: [], after: new Map() };
    const top = list.length ? list[list.length - 1].seq : 0;
    for (const change of Array.isArray(changes) ? changes : []) {
      if (!change || typeof change !== 'object') continue;
      const at = Number(change.seq_after) || 0;
      let anchor = null;
      for (let i = list.length - 1; i >= 0 && anchor === null; i -= 1) if (list[i].seq <= at) anchor = list[i].seq;
      if (anchor === null) { if (!hasMore) placed.lead.push(change); continue; }
      if (hasNewer && at > top) continue;
      if (!placed.after.has(anchor)) placed.after.set(anchor, []);
      placed.after.get(anchor).push(change);
    }
    return placed;
  }

  // ------------------------------------------------------------ in-place edit

  // The header's markup while a rename or topic edit is open: { name, sub } (each null when it stays as it was).
  function editHtml(edit) {
    if (!edit || typeof globalThis.inventoryTextField !== 'function') return null;
    const hint = '<span class="team-head__hint"' + (edit.error ? ' data-error="true"' : '') + '>'
      + escapeHtml(edit.error || jt('team.channels.edit.hint', 'Enter saves · Esc cancels')) + '</span>';
    const field = (label, max, extra) => globalThis.inventoryTextField({ className: 'team-head__edit' + extra, value: edit.value, ariaLabel: label,
      maxLength: max, spellcheck: false, dataset: { 'chan-edit': edit.field, 'team-tab-action': 'channel-edit' } });
    if (edit.field === 'name') return { name: field(jt('team.channels.edit.nameLabel', 'Channel name'), NAME_MAX * 2, ''), sub: hint };
    return { name: null, sub: field(jt('team.channels.edit.topicLabel', 'Channel topic'), TOPIC_MAX, ' team-head__edit--topic') + hint };
  }

  // ------------------------------------------------------------- controller

  // `deps`: container(), frame(), live() (the tab's page state: errors), chat() (the chat store), team() (the shown team row),
  // channels (renderer-team-channels.js), show(teamId, channelId), render(), syncHead() (the header's markup was patched
  // by hand), exportChannel(teamId, channelId).
  function createChannelUi(deps) {
    const folds = new Map(); // team id -> the Archived group is open (kept for the session)
    let edit = null; // { teamId, channelId, field, initial, value, error, busy }
    let menuOn = false;
    let menuKey = '';
    let dialog = null;
    const doc = () => deps.container().ownerDocument;
    const menuApi = () => (globalThis.inventory && globalThis.inventory.contextMenu) || globalThis.inventoryContextMenu || null;
    const stepModal = () => (globalThis.inventory && globalThis.inventory.stepModal) || globalThis.inventoryStepModal || null;
    const buttonEl = () => deps.container().querySelector('#' + BUTTON_ID);
    const focusButton = () => { const el = buttonEl(); if (el && typeof el.focus === 'function') el.focus({ preventScroll: true }); };
    const nameOf = (teamId) => (id) => { const m = id ? deps.chat().member(teamId, id) : null; return m && m.display_name ? m.display_name : ''; };
    const manage = (method, payload) => deps.chat().manageChannel(method, payload);
    const rowOf = (teamId, channelId) => deps.chat().channel(teamId, channelId);
    const rowsOf = (teamId) => (deps.chat().team(teamId) || {}).channels || [];
    // The column rows' own menu (renderer-team-channel-row-menu.js): Rename shows that channel first, then the same edit.
    const rowMenus = globalThis.rendererTeamChannelRowMenu || (typeof require === 'function' ? require('./renderer-team-channel-row-menu') : null);
    const rowMenu = rowMenus ? rowMenus.createRowMenu({ container: deps.container, team: deps.team, chat: deps.chat, channels: deps.channels, channelActions, nameOf,
      show: (teamId, channelId) => deps.show(teamId, channelId), rename: (team, row) => { deps.show(team.team_id, row.channel_id); startEdit(team, row, 'name'); },
      archive: (team, row, on) => archive(team, row, on), note: (text) => { deps.live().errors.head = text; deps.render(); } }) : null;

    function closeMenu() {
      if (!menuOn) return;
      menuOn = false;
      const api = menuApi();
      if (api && typeof api.hide === 'function') api.hide({ restoreFocus: false });
    }

    // What the open menu was built from: another channel or a change of what the viewer may do closes it.
    const keyOf = (team, channelId, row) => (row && team ? [channelId, row.archived, row.name, row.created_by, team.role].join('|') : '');

    // Part of the tab's view model: the open edit, whether the menu is open and whether the Archived group is. Also drops
    // what no longer fits the shown channel (an edit or menu for another one, or for a row that is gone or archived).
    function read(team, channelId, row) {
      if (rowMenu) rowMenu.attach();
      const key = keyOf(team, channelId, row);
      if (edit && (!team || edit.teamId !== team.team_id || edit.channelId !== channelId || !row || row.archived)) edit = null;
      if (menuOn && menuKey !== key) closeMenu();
      return { edit, menuOpen: menuOn, foldOpen: Boolean(team && folds.get(team.team_id)) };
    }

    // ------------------------------------------------------------- the menu

    function openMenu(team) {
      const teamId = team.team_id;
      const channelId = deps.channels.shownOf(teamId);
      const row = rowOf(teamId, channelId);
      const api = menuApi();
      if (!row || !isChannelRow(row) || !api || typeof api.show !== 'function') return;
      const can = channelActions(row, team, nameOf(teamId));
      const title = '#' + deps.channels.channelName(channelId);
      menuOn = true;
      menuKey = keyOf(team, channelId, row);
      deps.render();
      const anchor = buttonEl();
      const item = (value, label, extra = {}) => ({ value, label, ...(can[value] ? { disabled: true, description: can[value] } : {}), ...extra });
      const items = row.archived
        ? [item('unarchive', jt('team.channels.menu.unarchive', 'Unarchive'), { description: can.unarchive || jt('team.channels.menu.unarchiveDesc', 'Back in Channels; everyone can post again.'), action: () => archive(team, row, false) }),
          { separator: true },
          item('delete', jt('team.channels.menu.delete', 'Delete channel…'), { danger: true, description: can.delete || jt('team.channels.menu.deleteDesc', 'Removes every message and file for everyone.'), action: () => askDelete(team, row) })]
        : [item('rename', jt('team.channels.menu.rename', 'Rename channel'), { action: () => startEdit(team, row, 'name') }),
          item('topic', jt('team.channels.menu.topic', 'Edit topic'), { action: () => startEdit(team, row, 'topic') }),
          { separator: true },
          item('archive', jt('team.channels.menu.archive', 'Archive channel'), { description: can.archive || jt('team.channels.menu.archiveDesc', 'Moves it under Archived. Nobody can post; messages stay readable.'), action: () => archive(team, row, true) }),
          item('delete', jt('team.channels.menu.delete', 'Delete channel…'), { danger: true, action: () => askDelete(team, row) })];
      api.show({ anchorEl: anchor, rootEl: anchor, restoreFocusTo: anchor, className: 'team-channel-menu', ariaLabel: jt('team.channels.menu.label', 'Channel options'),
        heading: title, items, onHide: () => { if (menuOn) { menuOn = false; deps.render(); } } });
    }

    // ------------------------------------------------------------ edit, archive

    function startEdit(team, row, field) {
      const initial = field === 'name' ? String(row.name || '') : String(row.topic || '');
      edit = { teamId: team.team_id, channelId: row.channel_id, field, initial, value: initial, error: '', busy: false };
      deps.render();
      const input = deps.container().querySelector('[data-chan-edit]');
      if (input) { input.focus(); input.select(); }
    }

    function cancelEdit() { edit = null; deps.render(); focusButton(); }

    // The reason, beside the open field (patched in place: the header is not drawn again while the person types).
    function editError(text) {
      if (!edit) return;
      edit.error = text;
      const hint = deps.container().querySelector('.team-head__hint');
      if (hint) { hint.textContent = text || jt('team.channels.edit.hint', 'Enter saves · Esc cancels'); if (text) hint.dataset.error = 'true'; else delete hint.dataset.error; }
      deps.syncHead();
    }

    async function commit() {
      const e = edit;
      if (!e || e.busy) return;
      const row = rowOf(e.teamId, e.channelId);
      const value = e.field === 'name' ? normalizeName(e.value) : normalizeTopic(e.value);
      if (!row || value === (e.field === 'name' ? normalizeName(e.initial) : normalizeTopic(e.initial))) { cancelEdit(); return; }
      if (e.field === 'name') {
        const problem = value ? nameProblem(value, rowsOf(e.teamId), e.channelId) : jt('team.channels.nameEmpty', 'Give the channel a name.');
        if (problem) { editError(problem); return; }
      } else if (length(value) > TOPIC_MAX) { editError(jt('team.channels.topicLong', 'Up to {count} characters.', { count: TOPIC_MAX })); return; }
      e.busy = true;
      const answer = await manage('chatChannelUpdate', { team_id: e.teamId, channel_id: e.channelId, [e.field]: value, expected_rev: Number.isSafeInteger(row.rev) ? row.rev : 0 });
      if (edit !== e) return;
      e.busy = false;
      if (answer.ok) { edit = null; deps.render(); focusButton(); } else editError(failText(answer));
    }

    async function archive(team, row, on) {
      const s = deps.live();
      s.errors.head = '';
      const answer = await manage('chatChannelArchive', { team_id: team.team_id, channel_id: row.channel_id, on });
      if (!answer.ok && deps.live() === s) s.errors.head = failText(answer);
      deps.render();
    }

    // ----------------------------------------------------------- the delete dialog

    function closeDialog() {
      if (!dialog) return;
      const done = dialog;
      dialog = null;
      done.dispose();
      focusButton();
    }

    function askDelete(team, row) {
      const modal = stepModal();
      if (!modal || dialog) return;
      const channel = '#' + String(row.name || '');
      const body = '<p class="team-delete__note">' + escapeHtml(jt('team.channels.delete.body', 'To keep a copy, export it first: it saves the messages you can read as Markdown or JSON on this PC.')) + '</p>'
        + '<p class="team-delete__note team-set-note" role="alert" data-chan-delete-error hidden></p>';
      doc().body.insertAdjacentHTML('beforeend', modal.renderStepModal({ id: DELETE_ID, tone: 'danger', title: jt('team.channels.delete.title', 'Delete {channel}?', { channel }),
        summary: jt('team.channels.delete.summary', 'Its messages, files and pins are removed from the host for every member. Nobody can get them back.'), bodyHtml: body,
        actions: [{ id: 'export', label: jt('team.channels.delete.export', 'Export first…') }, { id: 'cancel', label: jt('team.channels.delete.cancel', 'Cancel') },
          { id: 'delete', label: jt('team.channels.delete.confirm', 'Delete channel'), variant: 'primary' }] }));
      const mount = doc().querySelector('[data-step-modal="' + DELETE_ID + '"]');
      if (!mount) return;
      const lifecycle = modal.createLifecycle({ documentRef: doc(), mountRoot: mount, getOverlayManager: () => globalThis.rendererOverlayManagerController || null,
        inertTargets: () => [doc().getElementById('appShell')].filter(Boolean) });
      let busy = false;
      const note = mount.querySelector('[data-chan-delete-error]');
      const onClick = async (event) => {
        const action = event.target && event.target.closest ? event.target.closest('[data-step-modal-action]') : null;
        if (!action || action.disabled) return;
        const which = action.dataset.stepModalAction;
        if (which === 'cancel') { closeDialog(); return; }
        if (which === 'export') { closeDialog(); deps.exportChannel(team.team_id, row.channel_id); return; }
        if (busy) return;
        busy = true;
        action.disabled = true;
        note.hidden = true;
        const answer = await manage('chatChannelDelete', { team_id: team.team_id, channel_id: row.channel_id });
        if (!dialog) return;
        if (answer.ok) { deps.channels.select(team.team_id, deps.channels.CHANNEL); closeDialog(); deps.render(); return; }
        busy = false;
        action.disabled = false;
        note.textContent = failText(answer);
        note.hidden = false;
      };
      mount.addEventListener('click', onClick);
      lifecycle.open({ id: DELETE_ID, onRequestClose: closeDialog, initialFocusSelector: '[data-step-modal-action="cancel"]' });
      dialog = { dispose() { mount.removeEventListener('click', onClick); lifecycle.dispose(); if (mount.parentNode) mount.parentNode.removeChild(mount); } };
    }

    // ------------------------------------------------------------ create

    // The New channel view's Create: the host's answer; on success the channel is shown by its name until its row is listed.
    async function create(teamId, name, topic) {
      const answer = await manage('chatChannelCreate', { team_id: teamId, name, ...(topic ? { topic } : {}) });
      const here = deps.team();
      if (answer.ok && typeof answer.channel_id === 'string' && here && here.team_id === teamId && deps.channels.shownOf(teamId) === deps.channels.NEW_CHANNEL) {
        deps.channels.expect(teamId, answer.channel_id, name);
        deps.show(teamId, answer.channel_id);
        const frame = deps.frame();
        if (frame && frame.composer) frame.composer.focus();
      }
      return answer;
    }

    // ------------------------------------------------------------ the tab's events

    // The tab's channel actions (`data-team-tab-action`); true when one was handled here.
    function click(action, target, team) {
      switch (action) {
        case 'channel-new': {
          deps.show(team.team_id, deps.channels.NEW_CHANNEL);
          const frame = deps.frame();
          if (frame && frame.picker) frame.picker.focus();
          return true;
        }
        case 'archived-fold': folds.set(team.team_id, !folds.get(team.team_id)); deps.render(); return true;
        case 'channel-menu': if (menuOn) { closeMenu(); deps.render(); } else openMenu(team); return true;
        case 'channel-edit': return true;
        default: return false;
      }
    }

    function onKey(event) {
      if (rowMenu && deps.team() && rowMenu.onKey(event)) return;
      const el = event.target;
      if (!edit || !el || !el.dataset || !el.dataset.chanEdit) return;
      if (event.key === 'Escape') { event.preventDefault(); cancelEdit(); } else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void commit(); }
    }

    function onInput(event) {
      const el = event.target;
      if (!edit || !el || !el.dataset || !el.dataset.chanEdit) return;
      edit.value = el.value;
      if (edit.error) editError('');
      else deps.syncHead();
    }

    function dispose() {
      edit = null;
      if (rowMenu) rowMenu.dispose();
      closeMenu();
      closeDialog();
    }

    return { read, click, onKey, onInput, create, dispose };
  }

  return { BUTTON_ID, DOTS, NAME_MAX, TOPIC_MAX, channelActions, createWhy, nameProblem, normalizeName, normalizeTopic, failText, changeHtml, placeChanges, editHtml, createChannelUi };
});
