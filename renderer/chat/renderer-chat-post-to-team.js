(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-chat-messages-copy'), require('./renderer-chat-messages-dialog'));
    return;
  }
  root.rendererChatPostToTeam = factory(root.rendererChatMessagesCopy, root.rendererChatMessagesDialog);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (copy, dialogs) {
  'use strict';

  // "Post to Team..." (row 175 F12, owner decision D5): a local Jenny answer, or text selected in a chat, goes into a
  // Team channel or direct conversation the member can write, through one confirming dialog. The dialog shows the
  // exact text that will be posted (read-only, escaped) and says who can read it; Post goes through the team chat
  // post the composer uses (queued by the chat client). Never into a project conversation (every message there
  // starts a Jenny turn); a project's own channel (`chan_project_*`, kind `project`, OD-8) is a human channel and is
  // offered, by its project name, when this member writes in that project. The menu item is never hidden: with no team, a read-only team, no connection or too long a
  // text it is greyed out with its reason.
  // - `menuItem({ text, trigger })` answers a context-menu item for any menu that offers "Send to chat..." or Pin.
  // - `cleanText(text)` is what is posted: attachments, previews and `jenny-team:` tokens are taken out.

  const { jt, escapeHtml } = copy;
  const MODAL_ID = 'chat-post-to-team';
  // The team chat store's own cap (services/host/team-chat-schema.js isMessageText: 16,000 code points), below the
  // wire's 32,000-character chatText limit; a longer text would always be refused.
  const MAX_CHARS = 16000;
  const CHANNEL_TEAM = 'chan_team';
  const WRITER_ROLES = new Set(['owner', 'member']);
  // The team states that lock a member out (renderer-team-chat-store.js LOCKED_STATES): nothing is posted to them.
  const LOCKED_STATES = new Set(['pending', 'revoked', 'update_required', 'needs_repair', 'force_local']);
  const QUEUED_STATES = new Set(['offline', 'reconnecting', 'connecting']);
  const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g; // direction marks in another member's text

  // A `jenny-team:<team>/<channel>/<seq>/<message>[/<root>]` link, whole (a link means nothing to another reader's Jenny).
  const TEAM_TOKEN = /jenny-team:[A-Za-z0-9_/-]+/gu;
  // Markdown pictures and the tags that draw an attachment or a preview carry nothing a team can read.
  const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/gu;
  const MEDIA_TAG = /<\/?(?:img|iframe|object|embed|video|audio|source|attachment|preview)\b[^>]*>/giu;

  function cleanText(text) {
    return String(text == null ? '' : text)
      .replace(TEAM_TOKEN, '')
      .replace(MARKDOWN_IMAGE, '')
      .replace(MEDIA_TAG, '')
      // The store refuses control characters other than tab, line feed and carriage return.
      .replace(/[^\P{Cc}\t\n\r]/gu, '')
      .replace(/[ \t]+$/gmu, '')
      .replace(/\n{3,}/gu, '\n\n')
      .trim();
  }

  const charCount = (text) => Array.from(text).length;
  const tooLong = (text) => charCount(text) > MAX_CHARS;

  function readersLine(kind, teamName, projectName = '') {
    if (kind === 'dm') return jt('chat.postToTeam.readers.dm', "The people in this conversation and the team's host can read this.");
    if (kind === 'project') return jt('chat.postToTeam.readers.project', "The members of {project} and the team's host can read this.", { project: projectName });
    return jt('chat.postToTeam.readers.channel', "Everyone in {team} and the team's host can read this.", { team: teamName });
  }

  const reasonText = (token) => ({
    noTeam: jt('chat.postToTeam.reason.noTeam', 'Join a team to post there.'),
    readOnly: jt('chat.postToTeam.reason.readOnly', 'You can only read in this team.'),
    offline: jt('chat.postToTeam.reason.offline', 'You are offline.'),
    tooLong: jt('chat.postToTeam.reason.tooLong', 'Too long to post (16,000 characters at most).'),
  }[token] || '');

  function lazy(globalName, path) {
    if (globalThis[globalName]) return globalThis[globalName];
    return typeof require === 'function' ? require(path) : null;
  }

  function createPostToTeam(deps) {
    const d = deps || {};
    const documentRef = d.documentRef || (typeof document !== 'undefined' ? document : null);
    const actionButton = d.actionButton || globalThis.inventoryActionButton || (typeof require === 'function' ? require('../inventory/action-button') : null);
    const textField = d.textField || globalThis.inventoryTextField || (typeof require === 'function' ? require('../inventory/text-field') : null);
    const getTeams = typeof d.getTeams === 'function' ? d.getTeams : () => {
      const store = lazy('rendererTeamStore', '../team/renderer-team-store');
      return store ? store.getTeamStore().snapshot().teams : [];
    };
    const getChatTeam = typeof d.getChatTeam === 'function' ? d.getChatTeam : (teamId) => {
      const store = lazy('rendererTeamChatStore', '../team/renderer-team-chat-store');
      return store ? store.getChatStore().team(teamId) : null;
    };
    // The project store's row for a project channel (`chan_<project id>`), or null: the name to show and this member's role in it.
    const getProject = typeof d.getProject === 'function' ? d.getProject : (teamId, projectId) => {
      const holder = lazy('rendererTeamProjectStore', '../team/renderer-team-project-store');
      return holder ? holder.getProjectStore().project(teamId, projectId) : null;
    };
    const post = typeof d.post === 'function' ? d.post : (payload) => {
      const store = lazy('rendererTeamStore', '../team/renderer-team-store');
      return store.getTeamStore().call('chatPost', payload);
    };
    const failText = typeof d.failText === 'function' ? d.failText : (answer) => {
      const writes = lazy('rendererTeamChatWrites', '../team/renderer-team-chat-writes');
      return writes ? writes.failText(answer) : '';
    };
    const announce = (message, key) => {
      const channel = d.announcer || (globalThis.window && globalThis.window.rendererLiveAnnouncerInstance) || null;
      if (channel && typeof channel.announce === 'function') channel.announce(message, { key });
    };
    let session = null;

    // ---- who can be written to --------------------------------------------------------------
    const teamsList = () => (Array.isArray(getTeams()) ? getTeams().filter((team) => team && typeof team.team_id === 'string') : []);
    const joined = () => teamsList().filter((team) => !LOCKED_STATES.has(team.state));
    const writable = (team) => WRITER_ROLES.has(team.role);
    const reachable = (team) => team.state === 'online' || (d.canQueue === true && QUEUED_STATES.has(team.state));
    const teamLabel = (team) => team.team_name || jt('settings.team.joined.unnamed', 'Unnamed team');

    function dmLabel(row, team, members) {
      const names = new Map((Array.isArray(members) ? members : []).map((member) => [member.member_id, member.display_name]));
      const former = jt('team.chat.formerMember', 'Former member');
      return row.participants.filter((id) => id !== team.member_id).map((id) => names.get(id) || former).join(', ') || former;
    }

    // One team's rows: #team, its live custom channels, the project channels this member writes in, then its direct conversations
    // (never a project's conversation).
    function optionsOf(team) {
      const chat = getChatTeam(team.team_id);
      const rows = chat && Array.isArray(chat.channels) ? chat.channels.filter(Boolean) : [];
      const options = [{ team_id: team.team_id, channel_id: CHANNEL_TEAM, kind: 'channel', label: jt('chat.postToTeam.teamChannel', '#team') }];
      for (const row of rows) {
        if (row.archived) continue;
        if (row.kind === 'project') {
          const project = String(row.channel_id).startsWith('chan_') ? getProject(team.team_id, String(row.channel_id).slice(5)) : null;
          const name = project && project.role !== 'reader' && typeof project.name === 'string' ? project.name.replace(BIDI, '').trim() : '';
          if (name) options.push({ team_id: team.team_id, channel_id: row.channel_id, kind: 'project', name, label: '#' + name });
        } else if (row.kind === 'channel' && row.name) options.push({ team_id: team.team_id, channel_id: row.channel_id, kind: 'channel', label: '#' + row.name });
        else if (row.kind === 'dm' && Array.isArray(row.participants)) options.push({ team_id: team.team_id, channel_id: row.channel_id, kind: 'dm', label: dmLabel(row, team, chat.members) });
      }
      return options;
    }

    /** Teams this member can post to now, each with its options: [{ team_id, name, options }]. */
    function destinations() {
      return joined().filter((team) => writable(team) && reachable(team)).map((team) => ({ team_id: team.team_id, name: teamLabel(team), options: optionsOf(team) }));
    }

    /** { ok, reason } for "Post to Team..." with this text now. */
    function availability(text) {
      const teams = joined();
      if (!teams.length) return { ok: false, reason: reasonText('noTeam') };
      const writers = teams.filter(writable);
      if (!writers.length) return { ok: false, reason: reasonText('readOnly') };
      if (!writers.some(reachable)) return { ok: false, reason: reasonText('offline') };
      // Asked per answer on each transcript draw: text no longer than the cap in UTF-16 units fits without cleaning.
      if (String(text || '').length > MAX_CHARS && tooLong(cleanText(text))) return { ok: false, reason: reasonText('tooLong') };
      return { ok: true, reason: '' };
    }

    // ---- the dialog -------------------------------------------------------------------------
    const $ = (s, selector) => (s.mountRoot ? s.mountRoot.querySelector(selector) : null);
    const picked = (s) => s.groups.flatMap((group) => group.options).find((o) => o.team_id + '|' + o.channel_id === s.selected) || null;
    const canPost = (s) => !s.posting && Boolean(s.selected) && s.text.length > 0 && !tooLong(s.text);

    function optionMarkup(s, option) {
      const key = option.team_id + '|' + option.channel_id;
      return actionButton({
        plain: true,
        className: 'chat-send__option',
        role: 'option',
        ariaSelected: s.selected === key,
        dataset: { 'chat-post-option': key },
        title: option.label,
        trustedHtml: `<span class="chat-send__option-title">${escapeHtml(option.label)}</span>`,
      });
    }

    function listMarkup(s) {
      return s.groups.map((group) => `<div class="chat-send__label" data-chat-post-team>${escapeHtml(group.name)}</div>`
        + group.options.map((option) => optionMarkup(s, option)).join('')).join('');
    }

    function bodyMarkup(s) {
      return `<div class="chat-send">`
        + `<div class="chat-send__label">${escapeHtml(jt('chat.postToTeam.to', 'To'))}</div>`
        + `<div class="chat-send__list" role="listbox" aria-label="${escapeHtml(jt('chat.postToTeam.listLabel', 'Channels and conversations'))}" data-chat-post-list>${listMarkup(s)}</div>`
        + `<p class="chat-send__note" data-chat-post-readers></p>`
        + textField({
          id: 'chat-post-preview',
          label: jt('chat.postToTeam.previewLabel', 'Posted exactly as shown'),
          multiline: true,
          rows: 6,
          readonly: true,
          value: s.text,
          dataset: { 'chat-post-preview': 'true' },
        })
        + `<p class="chat-send__error" data-chat-post-error${tooLong(s.text) ? '' : ' hidden'}>${escapeHtml(tooLong(s.text) ? reasonText('tooLong') : '')}</p>`
        + `</div>`;
    }

    function paintPost(s) {
      const button = $(s, '[data-step-modal-action="post"]');
      if (!button) return;
      button.disabled = !canPost(s);
      button.textContent = s.posting ? jt('chat.postToTeam.posting', 'Posting…') : jt('chat.postToTeam.post', 'Post');
    }

    function paintSelection(s) {
      const list = $(s, '[data-chat-post-list]');
      if (list) list.innerHTML = listMarkup(s);
      const option = picked(s);
      const readers = $(s, '[data-chat-post-readers]');
      if (readers) {
        const group = option && s.groups.find((entry) => entry.team_id === option.team_id);
        readers.textContent = option ? readersLine(option.kind, group ? group.name : '', option.name) : '';
      }
      paintPost(s);
    }

    function showError(s, text) {
      const node = $(s, '[data-chat-post-error]');
      if (node) { node.textContent = text || ''; node.hidden = !text; }
      if (text) announce(text, 'chat-post-error');
    }

    function select(s, key) {
      if (s.posting) return;
      s.selected = key;
      showError(s, tooLong(s.text) ? reasonText('tooLong') : '');
      paintSelection(s);
      const node = Array.from(s.mountRoot.querySelectorAll('[data-chat-post-option]')).find((el) => el.getAttribute('data-chat-post-option') === key);
      if (node) node.focus();
    }

    function done(s, option) {
      const group = s.groups.find((entry) => entry.team_id === option.team_id);
      const message = jt('chat.postToTeam.posted', 'Posted to {where} in {team}', { where: option.label, team: group ? group.name : '' });
      close();
      if (typeof d.showToast === 'function') d.showToast(message, { tone: 'info', source: d.toastSource, dedupeKey: `chat-post-to-team:${option.team_id}:${option.channel_id}` });
      else announce(message, 'chat-post-done');
    }

    async function submit(s) {
      const option = picked(s);
      if (!canPost(s) || !option) return;
      s.posting = true;
      showError(s, '');
      paintPost(s);
      let answer;
      try {
        answer = await post({ team_id: option.team_id, channel_id: option.channel_id, text: s.text });
      } catch (_error) { answer = null; }
      if (session !== s) return;
      s.posting = false;
      if (answer && answer.ok === true) { done(s, option); return; }
      showError(s, failText(answer) || jt('chat.postToTeam.failed', 'Could not post. Try again.'));
      paintPost(s);
    }

    function moveFocus(s, current, step) {
      const options = Array.from(s.mountRoot.querySelectorAll('[data-chat-post-option]'));
      const index = options.indexOf(current);
      const next = options[Math.max(0, Math.min(options.length - 1, index + step))];
      if (next) next.focus();
    }

    function onClick(s, event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const option = target.closest('[data-chat-post-option]');
      if (option) { select(s, option.getAttribute('data-chat-post-option')); return; }
      const step = target.closest('[data-step-modal-action]');
      if (step) {
        const id = step.getAttribute('data-step-modal-action');
        if (id === 'post') void submit(s);
        else if (id === 'cancel' && !s.posting) close();
        return;
      }
      if (!target.closest('.inv-step-modal') && !s.posting) close();
    }

    function onKeydown(s, event) {
      const option = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-chat-post-option]') : null;
      if (!option || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
      event.preventDefault();
      moveFocus(s, option, event.key === 'ArrowDown' ? 1 : -1);
    }

    function close() {
      const s = session;
      if (!s) return;
      session = null;
      if (s.handle) s.handle.dispose();
    }

    /** Opens the dialog for `text`. Returns false when it cannot be offered (the menu item says why). */
    function open(options) {
      const o = options || {};
      const text = cleanText(o.text);
      if (!text || !availability(o.text).ok || !actionButton || !textField || !dialogs) return false;
      if (session) close();
      const s = { text, groups: destinations().filter((group) => group.options.length), selected: '', posting: false, handle: null, mountRoot: null };
      if (!s.groups.length) return false;
      session = s;
      const handle = dialogs.mountDialog({ documentRef, stepModal: d.stepModal, overlayManager: d.overlayManager, appendClientLog: d.appendClientLog }, {
        id: MODAL_ID,
        modal: {
          eyebrow: jt('chat.postToTeam.eyebrow', 'Team'),
          title: jt('chat.postToTeam.title', 'Post to Team'),
          summary: jt('chat.postToTeam.summary', 'Only the text below is posted. No files, previews or links to other messages go with it.'),
          bodyHtml: bodyMarkup(s),
          actions: [
            { id: 'cancel', label: jt('common.cancel', 'Cancel'), variant: 'secondary' },
            { id: 'post', label: jt('chat.postToTeam.post', 'Post'), variant: 'primary', disabled: true },
          ],
        },
        onRequestClose: () => { if (session === s && !s.posting) close(); },
        initialFocusSelector: '[data-chat-post-option]',
        restoreFocusTo: o.trigger || undefined,
      });
      if (!handle) { session = null; return false; }
      s.handle = handle;
      s.mountRoot = handle.mountRoot;
      handle.mountRoot.addEventListener('click', (event) => onClick(s, event));
      handle.mountRoot.addEventListener('keydown', (event) => onKeydown(s, event));
      paintPost(s);
      return true;
    }

    /** A context-menu item: never hidden, greyed out with its reason (shown under the label) when it cannot be used. */
    function menuItem(options) {
      const o = options || {};
      if (!cleanText(o.text)) return null;
      const state = availability(o.text);
      const item = { label: jt('chat.postToTeam.menu', 'Post to Team…'), value: 'post-to-team', action: () => { open(o); } };
      return state.ok ? item : { ...item, disabled: true, description: state.reason, title: state.reason };
    }

    return { open, close, dispose: close, isOpen: () => Boolean(session), menuItem, availability, destinations };
  }

  let defaultInstance = null;
  function getDefault(deps) {
    if (!defaultInstance) defaultInstance = createPostToTeam(deps);
    return defaultInstance;
  }

  return { createPostToTeam, getDefault, cleanText, readersLine, MAX_CHARS, MODAL_ID };
});
