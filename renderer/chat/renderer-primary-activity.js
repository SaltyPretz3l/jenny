(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-chat-messages-copy'), require('./renderer-chat-messages-dialog'));
    return;
  }
  root.rendererPrimaryActivity = factory(root.rendererChatMessagesCopy, root.rendererChatMessagesDialog);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (copy, dialogs) {
  'use strict';

  // The Activity dialog of the profile-wide Jenny chat (row 76): what it did across the user's chats
  // (Activity pane) and what it may do (Permissions pane: standing launch permissions with a grant form,
  // live message grants, one-turn grants). It reuses the Review dialog's shell and chat-review__* grammar.
  // Everything shown comes from window.jennyShell.primaryChat; titles, project names and details belong
  // to other chats and reach the DOM only through escapeHtml. A fetch repaints, never a local guess.

  const { jt, jtn, escapeHtml } = copy;
  const MODAL_ID = 'primary-chat-activity';
  const ACTIVITY_LIMIT = 60;
  const ERROR_WORDS = new Set(['failed', 'denied', 'cancelled', 'timeout', 'discarded', 'revoked']);
  const PENDING_WORDS = new Set(['pending', 'prepared', 'queued', 'reserved', 'live']);
  const WORK_PENDING_WORDS = new Set(['queued', 'pending', 'running', 'starting', 'started', 'active', 'in_progress', 'claimed']);
  const HISTORY_KINDS = new Set(['paused', 'resumed', 'reset', 'forgot']);

  function kindLabel(entry) {
    switch (entry.kind) {
      case 'message_sent': return jt('chat.primary.kind.message_sent', 'Message sent');
      case 'report_sent': return jt('chat.primary.kind.report_sent', 'Report sent');
      case 'message_received': return jt('chat.primary.kind.message_received', 'Message received');
      case 'report_received': return jt('chat.primary.kind.report_received', 'Report received');
      case 'woken': return jt('chat.primary.kind.woken', 'Woken');
      case 'proposal': return String(entry.status || '').startsWith('accepted/')
        ? jt('chat.primary.kind.proposalStarted', 'Started a chat') : jt('chat.primary.kind.proposal', 'Proposed a chat');
      case 'stop': return jt('chat.primary.kind.stop', 'Stop requested');
      case 'permission_granted': return jt('chat.primary.kind.permission_granted', 'Permission');
      case 'permission_revoked': return jt('chat.primary.kind.permission_revoked', 'Permission revoked');
      case 'grant_created': return jt('chat.primary.kind.grant_created', 'Message grant');
      case 'grant_revoked': return jt('chat.primary.kind.grant_revoked', 'Message grant revoked');
      case 'launch_grant': return jt('chat.primary.kind.launch_grant', 'One-turn grant');
      case 'paused': return jt('chat.primary.kind.paused', 'Paused');
      case 'resumed': return jt('chat.primary.kind.resumed', 'Resumed');
      case 'reset': return jt('chat.primary.kind.reset', 'Reset');
      case 'forgot': return jt('chat.primary.kind.forgot', 'Forgot');
      default: return String(entry.kind || '').replace(/_/g, ' ');
    }
  }

  function historyText(kind) {
    switch (kind) {
      case 'paused': return jt('chat.primary.history.paused', 'You paused Jenny.');
      case 'resumed': return jt('chat.primary.history.resumed', 'You resumed Jenny.');
      case 'reset': return jt('chat.primary.history.reset', 'You reset the Jenny chat.');
      default: return jt('chat.primary.history.forgot', 'You had Jenny forget this chat.');
    }
  }

  function wordLabel(word) {
    switch (word) {
      case 'prepared': return jt('chat.primary.status.prepared', 'Prepared');
      case 'pending': return jt('chat.primary.status.pending', 'Pending');
      case 'delivered': return jt('chat.primary.status.delivered', 'Delivered');
      case 'failed': return jt('chat.primary.status.failed', 'Failed');
      case 'cancelled': return jt('chat.primary.status.cancelled', 'Cancelled');
      case 'denied': return jt('chat.primary.status.denied', 'Denied');
      case 'queued': return jt('chat.primary.status.queued', 'Queued');
      case 'reserved': return jt('chat.primary.status.reserved', 'Reserved');
      case 'included': return jt('chat.primary.status.included', 'Included');
      case 'excluded': return jt('chat.primary.status.excluded', 'Excluded');
      case 'discarded': return jt('chat.primary.status.discarded', 'Discarded');
      case 'approved': return jt('chat.primary.status.approved', 'Approved');
      case 'approved_auto': return jt('chat.primary.status.approved_auto', 'Approved automatically');
      case 'timeout': return jt('chat.primary.status.timeout', 'Timed out');
      case 'preempted': return jt('chat.primary.status.preempted', 'Preempted');
      case 'auto': return jt('chat.primary.status.auto', 'Automatic');
      case 'live': return jt('chat.primary.status.live', 'Live');
      case 'spent': return jt('chat.primary.status.spent', 'Used up');
      case 'expired': return jt('chat.primary.status.expired', 'Expired');
      case 'revoked': return jt('chat.primary.status.revoked', 'Revoked');
      case 'accepted': return jt('chat.primary.status.accepted', 'Accepted');
      case 'declined': return jt('chat.primary.status.declined', 'Declined');
      case 'dismissed': return jt('chat.primary.status.dismissed', 'Dismissed');
      case 'completed': return jt('chat.primary.status.completed', 'Completed');
      case 'running': return jt('chat.primary.status.running', 'Running');
      default: {
        const text = String(word || '').replace(/_/g, ' ').trim();
        return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
      }
    }
  }

  function authLabel(entry) {
    switch (entry.authorization) {
      case 'permission': return jt('chat.primary.auth.permission', 'under your permission');
      case 'linked': return jt('chat.primary.auth.linked', 'by your request');
      case 'offer': return jt('chat.primary.auth.offer', 'you chose');
      case 'grant': return jt('chat.primary.auth.grant', 'under a grant');
      case 'approval': return jt('chat.primary.auth.approval', 'approved by you');
      case 'user': return jt('chat.primary.auth.user', 'sent by you');
      default: return '';
    }
  }

  /** { tone, label } of an entry's status line; null when the entry has none. */
  function statusFor(entry) {
    if (HISTORY_KINDS.has(entry.kind) || typeof entry.status !== 'string' || !entry.status) return null;
    const word = entry.kind === 'proposal' ? entry.status.split('/')[0] : entry.status;
    let tone = 'ok';
    if (ERROR_WORDS.has(word)) tone = 'error';
    else if (PENDING_WORDS.has(word) || (entry.kind === 'woken' && WORK_PENDING_WORDS.has(word))) tone = 'pending';
    const auth = authLabel(entry);
    const label = wordLabel(word);
    return { tone, label: auth ? `${label} · ${auth}` : label };
  }

  /** A moment as a clock time today, or a short date and time on another day ('' when unreadable). */
  function whenText(value, now) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.valueOf())) return '';
    const ref = now || new Date();
    const sameDay = date.getFullYear() === ref.getFullYear() && date.getMonth() === ref.getMonth() && date.getDate() === ref.getDate();
    return sameDay ? copy.formatTime(value) : copy.formatGrantExpiry(value);
  }

  function entryMarkup(entry) {
    const project = entry.project && entry.project.name ? copy.projectName(entry.project.name) : '';
    const when = whenText(entry.at);
    const title = entry.title ? copy.clip(entry.title, 120) : '';
    const meta = `${project ? `${escapeHtml(project)} · ` : ''}${escapeHtml(when)}`;
    const detail = HISTORY_KINDS.has(entry.kind) ? historyText(entry.kind) : (entry.detail || '');
    const status = statusFor(entry);
    const dot = status ? (status.tone === 'error' ? 'error' : status.tone === 'pending' ? 'pending' : 'ok') : '';
    return `<li class="chat-review__item" data-activity-kind="${escapeHtml(entry.kind)}">`
      + `<div class="chat-review__head"><span class="chat-review__chip primary-activity__kind">${escapeHtml(kindLabel(entry))}</span>`
      + `${title ? ` <strong>${escapeHtml(title)}</strong>` : ''}<span class="chat-review__meta"> · ${meta}</span></div>`
      + `${detail ? `<p class="chat-review__body">${escapeHtml(detail)}</p>` : ''}`
      + `${status ? `<div class="chat-review__status" data-tone="${status.tone}"><span class="status-dot status-dot--${dot}" aria-hidden="true"></span>`
        + `<span class="chat-review__state">${escapeHtml(status.label)}</span></div>` : ''}</li>`;
  }

  const note = (text) => `<p class="chat-review__note">${escapeHtml(text)}</p>`;
  const errorNotice = (text) => `<p class="chat-review__notice" data-tone="error" role="alert">${escapeHtml(text)}</p>`;

  function activityPaneMarkup(activity) {
    if (activity === undefined) return note(jt('common.loading', 'Loading…'));
    if (!activity) return errorNotice(jt('chat.primary.unavailable', "Jenny's activity is not available right now."));
    const entries = Array.isArray(activity.entries) ? activity.entries.filter((entry) => copy.isObject(entry) && typeof entry.kind === 'string') : [];
    if (!entries.length) return note(jt('chat.primary.activity.empty', 'Nothing yet.'));
    return `<ul class="chat-review__list">${entries.map(entryMarkup).join('')}</ul>`
      + (activity.truncated ? note(jt('chat.primary.activity.older', 'Older entries are not shown.')) : '');
  }

  function modesText(modes) {
    if (!Array.isArray(modes)) return jt('chat.primary.perm.anyMode', 'Any run mode');
    const names = modes.map((mode) => {
      switch (mode) {
        case 'ask': return jt('chat.primary.mode.ask', 'Ask');
        case 'auto': return jt('chat.primary.mode.auto', 'Auto');
        case 'plan': return jt('chat.primary.mode.plan', 'Plan');
        case 'propose': return jt('chat.primary.mode.propose', 'Propose');
        default: return String(mode);
      }
    });
    return jt('chat.primary.perm.onlyModes', 'Only while Jenny is in {modes}', { modes: names.join(', ') });
  }

  function permRow(title, meta, revokeAttr, revokeId, id, actionButton) {
    const act = revokeAttr ? actionButton({
      plain: true, className: 'chat-review__link primary-activity__perm-act', label: jt('common.revoke', 'Revoke'), dataset: { [revokeAttr]: revokeId },
    }) : '';
    return `<div class="primary-activity__perm" data-permission-id="${escapeHtml(id)}"><div class="primary-activity__perm-title">${escapeHtml(title)}</div>`
      + `<div class="primary-activity__perm-meta">${escapeHtml(meta)}</div>${act}</div>`;
  }

  const kicker = (text) => `<div class="primary-activity__kicker">${escapeHtml(text)}</div>`;
  const live = (row) => copy.isObject(row) && !row.revoked_at && row.live !== false;
  const everyProject = () => jt('chat.primary.everyProject', 'Every project');

  function launchRows(perms, ui) {
    const rows = (Array.isArray(perms.launch) ? perms.launch : []).filter((row) => copy.isObject(row) && !row.revoked_at);
    if (!rows.length) return note(jt('chat.primary.permissions.none', 'None. Jenny shows you a choice before starting a chat.'));
    return rows.map((row) => {
      const title = row.project && row.project.name ? row.project.name
        : (row.project_id === '*' ? everyProject() : jt('chat.primary.unknownProject', 'A project that no longer exists'));
      const max = Number.isSafeInteger(row.max_children_per_turn) ? row.max_children_per_turn : 1;
      const children = jtn('chat.primary.perm.children', max, { count: max }, '1 chat per request', '{count} chats per request');
      const meta = `${modesText(row.run_modes)} · ${children} · ${jt('chat.primary.perm.granted', 'granted {when}', { when: whenText(row.created_at) })}`;
      return permRow(title, meta, 'primary-permission-revoke', row.permission_id, row.permission_id, ui.actionButton);
    }).join('');
  }

  function formMarkup(form, projects, ui) {
    const options = projects.map((project) => ({ value: project.id, label: project.name })).concat([{ value: '*', label: everyProject() }]);
    const value = options.some((option) => option.value === form.project) ? form.project : options[0].value;
    return '<div class="primary-activity__form">'
      + `<span>${escapeHtml(jt('chat.primary.permissions.allowIn', 'Allow in'))}</span>`
      + ui.selectField({
        id: 'primary-grant-project', ariaLabel: jt('chat.primary.permissions.projectLabel', 'Project'), value, options, dataset: { 'primary-grant-project': '1' },
      })
      + ui.checkbox({
        id: 'primary-grant-auto', label: jt('chat.primary.permissions.autoOnly', 'only while Jenny is in Auto'), checked: form.auto, dataset: { 'primary-grant-auto': '1' },
      })
      + ui.actionButton({ variant: 'secondary', size: 'sm', label: jt('chat.primary.permissions.allow', 'Allow'), dataset: { 'primary-grant-submit': '1' } })
      + '</div>';
  }

  function messageGrantRows(perms, ui) {
    const rows = (Array.isArray(perms.message_grants) ? perms.message_grants : []).filter(live);
    if (!rows.length) return note(jt('chat.primary.permissions.noMessageGrants', 'None live.'));
    return rows.map((row) => {
      const title = copy.chatTitle(row.destination && row.destination.title, true);
      const sends = jtn('chat.primary.perm.sendsLeft', row.remaining_sends, { count: row.remaining_sends }, '{count} send left', '{count} sends left');
      const meta = `"${copy.clip(row.purpose, 120)}" · ${sends} · ${jt('chat.primary.perm.expires', 'expires {when}', { when: whenText(row.expires_at) })}`;
      return permRow(title, meta, 'primary-message-grant-revoke', row.grant_id, row.grant_id, ui.actionButton);
    }).join('');
  }

  function turnGrantRows(perms, ui) {
    const rows = (Array.isArray(perms.turn_grants) ? perms.turn_grants : []).filter(live);
    if (!rows.length) return note(jt('chat.primary.permissions.noTurnGrants', 'None live. A /linked request grants one for an hour.'));
    return rows.map((row) => permRow(
      jt('chat.primary.perm.turnGrant', 'A /linked request'),
      jt('chat.primary.perm.expires', 'expires {when}', { when: whenText(row.expires_at) }),
      '', '', row.authorization_ref, ui.actionButton,
    )).join('');
  }

  function permissionsPaneMarkup(model, ui) {
    if (model.perms === undefined) return note(jt('common.loading', 'Loading…'));
    if (!model.perms) return errorNotice(jt('chat.primary.unavailable', "Jenny's activity is not available right now."));
    const flags = model.state && model.state.flags;
    const canGrant = Boolean(flags && flags.launch_permission);
    return kicker(jt('chat.primary.permissions.launchKicker', 'Jenny may start chats in'))
      + launchRows(model.perms, ui)
      + (canGrant ? formMarkup(model.form, model.projects, ui) : '')
      + kicker(jt('chat.primary.permissions.messageKicker', 'Message grants')) + messageGrantRows(model.perms, ui)
      + kicker(jt('chat.primary.permissions.turnKicker', 'One-turn grants')) + turnGrantRows(model.perms, ui);
  }

  function bodyMarkup(model, ui) {
    const tabs = ui.segmentedControl({
      id: 'primary-activity-tabs',
      value: model.pane,
      options: [
        { value: 'activity', label: jt('chat.primary.activity.tab', 'Activity') },
        { value: 'permissions', label: jt('chat.primary.permissions.tab', 'Permissions') },
      ],
      dataset: { 'primary-activity-tabs': '1' },
    });
    const notice = model.notice ? errorNotice(model.notice) : '';
    return `<div class="primary-activity__tabs">${tabs}</div>${notice}`
      + `<div class="primary-activity__pane" data-primary-pane="activity"${model.pane === 'activity' ? '' : ' hidden'}>${activityPaneMarkup(model.activity)}</div>`
      + `<div class="primary-activity__pane" data-primary-pane="permissions"${model.pane === 'permissions' ? '' : ' hidden'}>${permissionsPaneMarkup(model, ui)}</div>`;
  }

  function defaultBridge() {
    const shell = globalThis.window ? globalThis.window.jennyShell : globalThis.jennyShell;
    return (shell && shell.primaryChat) || null;
  }

  function defaultMessagesBridge() {
    const shell = globalThis.window ? globalThis.window.jennyShell : globalThis.jennyShell;
    return (shell && shell.chatMessages) || null;
  }

  function cleanProjects(list) {
    const rows = Array.isArray(list) ? list : (list && Array.isArray(list.projects) ? list.projects : []);
    return rows
      .filter((project) => copy.isObject(project) && typeof project.id === 'string' && project.id && project.id !== '*' && typeof project.name === 'string' && project.name)
      .map((project) => ({ id: project.id, name: copy.clip(project.name, 80) }));
  }

  function createPrimaryActivity(deps) {
    const d = deps || {};
    const documentRef = d.documentRef || (typeof document !== 'undefined' ? document : null);
    const inv = (name, file) => d[name] || globalThis[`inventory${name.charAt(0).toUpperCase()}${name.slice(1)}`] || (typeof require === 'function' ? require(`../inventory/${file}`) : null);
    const ui = {
      actionButton: inv('actionButton', 'action-button'),
      checkbox: (() => { const c = inv('checkbox', 'checkbox'); return typeof c === 'function' ? c : (c && c.checkbox) || null; })(), // the module exports { checkbox, radio, setChecked }
      selectField: inv('selectField', 'select-field'),
      segmentedControl: inv('segmentedControl', 'segmented-control'),
    };
    const getBridge = typeof d.getBridge === 'function' ? d.getBridge : defaultBridge;
    const log = typeof d.appendClientLog === 'function' ? d.appendClientLog : () => {};
    const state = d.state && typeof d.state === 'object' ? d.state : {};
    let session = null;

    async function readProjects() {
      try {
        const source = typeof d.listProjects === 'function' ? d.listProjects()
          : (Array.isArray(state.projects) && state.projects.length ? state.projects
            : ((globalThis.window && globalThis.window.jennyShell && globalThis.window.jennyShell.projects && globalThis.window.jennyShell.projects.list)
              ? globalThis.window.jennyShell.projects.list() : []));
        return cleanProjects(await source);
      } catch (_error) {
        return [];
      }
    }

    async function call(method, request) {
      const bridge = getBridge();
      if (!bridge || typeof bridge[method] !== 'function') return null;
      try {
        const response = await bridge[method](request);
        return copy.isObject(response) ? response : null;
      } catch (error) {
        log('WARN', 'primary_activity.call_failed', { method, reason: (error && (error.code || error.name)) || 'error' });
        return null;
      }
    }

    function paint(s) {
      const host = s.mountRoot && s.mountRoot.querySelector('[data-primary-activity-body]');
      if (!host) return;
      const active = documentRef.activeElement;
      const focusKey = active && host.contains(active) ? focusKeyOf(active) : '';
      const select = host.querySelector('[data-primary-grant-project]');
      const auto = host.querySelector('[data-primary-grant-auto]');
      if (select) s.form.project = select.value;
      if (auto) s.form.auto = auto.checked;
      host.innerHTML = bodyMarkup({
        pane: s.pane, notice: s.notice, activity: s.activity, perms: s.perms, state: s.state, projects: s.projects, form: s.form,
      }, ui);
      if (focusKey) {
        const next = Array.from(host.querySelectorAll('[data-primary-grant-project], [data-primary-grant-auto], [data-primary-grant-submit], [data-primary-permission-revoke], [data-primary-message-grant-revoke], .inv-segmented-option--on'))
          .find((node) => focusKeyOf(node) === focusKey);
        if (next) next.focus();
      }
      paintStatus(s);
    }

    // The header status word ("Paused") exists only when the modal was rendered with one, so add or drop the span here.
    function paintStatus(s) {
      const word = s.state && s.state.paused ? jt('chat.primary.pausedWord', 'Paused') : '';
      let node = s.mountRoot.querySelector('.inv-step-modal-status');
      if (!word) { if (node) node.remove(); return; }
      if (!node) {
        const row = s.mountRoot.querySelector('.inv-step-modal-title-row');
        if (!row) return;
        node = documentRef.createElement('span');
        node.className = 'inv-step-modal-status';
        row.appendChild(node);
      }
      node.textContent = word;
    }

    function focusKeyOf(node) {
      for (const attr of ['data-primary-permission-revoke', 'data-primary-message-grant-revoke']) {
        if (node.hasAttribute(attr)) return `${attr}=${node.getAttribute(attr)}`;
      }
      for (const attr of ['data-primary-grant-project', 'data-primary-grant-auto', 'data-primary-grant-submit']) {
        if (node.hasAttribute(attr)) return attr;
      }
      return node.classList && node.classList.contains('inv-segmented-option') ? 'tab' : '';
    }

    async function load(s) {
      if (s.loading) { s.dirty = true; return; }
      s.loading = true;
      do {
        s.dirty = false;
        const [stateResp, activityResp, permsResp, projects] = await Promise.all([
          call('getState', { schema_version: 1 }),
          call('activity', { schema_version: 1, limit: ACTIVITY_LIMIT }),
          call('permissions', { schema_version: 1 }),
          readProjects(),
        ]);
        if (session !== s) return;
        s.state = stateResp && stateResp.ok === true ? stateResp : s.state;
        s.activity = activityResp && activityResp.ok === true ? activityResp : null;
        s.perms = permsResp && permsResp.ok === true ? permsResp : null;
        s.projects = projects;
        if (!s.sessionId) s.sessionId = String((s.state && s.state.session_id) || (s.activity && s.activity.session_id) || '');
        paint(s);
      } while (s.dirty);
      s.loading = false;
    }

    function schedule(s) {
      if (s.scheduled) return;
      s.scheduled = true;
      Promise.resolve().then(() => {
        s.scheduled = false;
        if (session === s) void load(s);
      });
    }

    async function allow(s) {
      const host = s.mountRoot.querySelector('[data-primary-activity-body]');
      const select = host && host.querySelector('[data-primary-grant-project]');
      const auto = host && host.querySelector('[data-primary-grant-auto]');
      if (!select) return;
      s.form.project = select.value;
      s.form.auto = Boolean(auto && auto.checked);
      const response = await call('grantLaunch', { schema_version: 1, project_id: select.value, run_modes: s.form.auto ? ['auto'] : null });
      if (session !== s) return;
      if (response && response.ok === true) s.notice = '';
      else if (response && response.reason === 'capacity') s.notice = jt('chat.primary.grantCapacity', 'The permission list is full; revoke one first.');
      else s.notice = jt('chat.primary.grantFailed', 'Could not grant that permission.');
      if (s.notice) paint(s);
      await load(s);
    }

    async function revoke(s, kind, id) {
      let response;
      if (kind === 'launch') {
        response = await call('revokeLaunch', { schema_version: 1, permission_id: id });
      } else {
        const bridge = defaultMessagesBridge();
        try {
          response = bridge && typeof bridge.revokeGrant === 'function'
            ? await bridge.revokeGrant({ schema_version: 1, source_session_id: s.sessionId, grant_id: id }) : null;
        } catch (_error) { response = null; }
      }
      if (session !== s) return;
      s.notice = response && response.ok === true ? '' : jt('chat.primary.revokeFailed', 'Could not revoke that permission.');
      if (s.notice) paint(s);
      await load(s);
    }

    function onClick(s, event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest('[data-primary-grant-submit]')) { void allow(s); return; }
      const launch = target.closest('[data-primary-permission-revoke]');
      if (launch) { void revoke(s, 'launch', launch.getAttribute('data-primary-permission-revoke')); return; }
      const grant = target.closest('[data-primary-message-grant-revoke]');
      if (grant) { void revoke(s, 'message', grant.getAttribute('data-primary-message-grant-revoke')); return; }
      const step = target.closest('[data-step-modal-action]');
      if (step && step.getAttribute('data-step-modal-action') === 'close') { close(); return; }
      if (!target.closest('.inv-step-modal')) close();
    }

    function close() {
      const s = session;
      if (!s) return;
      session = null;
      if (s.unsubscribe) s.unsubscribe();
      if (s.handle) s.handle.dispose();
    }

    function open(options) {
      const o = options || {};
      const bridge = getBridge();
      if (!bridge || !dialogs || !ui.actionButton || !ui.segmentedControl) return false;
      if (session) close();
      const s = {
        sessionId: String(o.sessionId || '').trim(), pane: o.pane === 'permissions' ? 'permissions' : 'activity', notice: '',
        activity: undefined, perms: undefined, state: null, projects: [], form: { project: '', auto: false },
        handle: null, mountRoot: null, unsubscribe: null, loading: false, dirty: false, scheduled: false,
      };
      session = s;
      const handle = dialogs.mountDialog({ documentRef, stepModal: d.stepModal, overlayManager: d.overlayManager, appendClientLog: log }, {
        id: MODAL_ID,
        modal: {
          eyebrow: jt('chat.primary.eyebrow', 'Jenny chat'),
          title: jt('chat.primary.activity.title', 'Activity'),
          status: '',
          summary: jt('chat.primary.activity.summary', 'What Jenny did across your chats, and what it may do.'),
          bodyHtml: '<div class="primary-activity" data-primary-activity-body></div>',
          actions: [{ id: 'close', label: jt('common.close', 'Close'), variant: 'primary' }],
        },
        onRequestClose: close,
        initialFocusSelector: '.inv-segmented-option--on, [data-step-modal-action="close"]',
        restoreFocusTo: o.trigger || undefined,
      });
      if (!handle) { session = null; return false; }
      s.handle = handle;
      s.mountRoot = handle.mountRoot;
      handle.mountRoot.addEventListener('click', (event) => onClick(s, event));
      if (typeof ui.segmentedControl.initSegmentedHandlers === 'function') ui.segmentedControl.initSegmentedHandlers(handle.mountRoot);
      handle.mountRoot.addEventListener('inv-segmented-change', (event) => {
        if (!event.detail || event.detail.id !== 'primary-activity-tabs') return;
        s.pane = event.detail.value === 'permissions' ? 'permissions' : 'activity';
        paint(s);
      });
      if (typeof bridge.onChanged === 'function') {
        try { s.unsubscribe = bridge.onChanged(() => schedule(s)); } catch (_error) { s.unsubscribe = null; }
      }
      paint(s);
      void load(s);
      return true;
    }

    return { open, close, dispose: close, isOpen: () => Boolean(session) };
  }

  let defaultActivity = null;
  function getDefaultPrimaryActivity(deps) {
    if (!defaultActivity) defaultActivity = createPrimaryActivity(deps);
    return defaultActivity;
  }

  return { createPrimaryActivity, getDefaultPrimaryActivity, statusFor, kindLabel, whenText, MODAL_ID };
});
