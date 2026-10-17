(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSessionMessageRows = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // Addressed session messages (row 59 checkpoint 4) in the timeline. Two persisted
  // role:'context' rows exist: the included row (kind session_message, written before the
  // turn's user anchor when a turn admitted the message) and the discard receipt (kind
  // session_message_receipt). Both project to ONE row kind, `session_message`, whose payload
  // carries the disposition. The body, the source title and the project name are untrusted:
  // every string goes through escapeHtml, the body is plain text (newlines kept by CSS),
  // never markdown. Pending arrivals (queued / waiting / excluded) are NOT timeline rows;
  // they live in the composer backlog and its Review dialog.
  const KIND_INCLUDED = 'session_message';
  const KIND_RECEIPT = 'session_message_receipt';
  const ROW_KIND = 'session_message';
  // Background prepared by a parent chat for a linked child (row 59 checkpoint 5a): one
  // persisted role:'context' row of kind session_handoff, written before the child's first
  // user anchor. It projects to its own row kind and renders as an attributed card with no
  // state line (it is always part of the first turn); a missing parent reads "Original chat unavailable".
  const KIND_HANDOFF = 'session_handoff';
  const ROW_KIND_HANDOFF = 'session_handoff';
  const GENERAL_PROJECT_IDS = new Set(['', 'project_general']);

  const requireOptional = (path) => {
    if (typeof require !== 'function') return null;
    try { return require(path); } catch (_error) { return null; }
  };

  function str(value) {
    return String(value == null ? '' : value).trim();
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function isSessionMessageRecord(message) {
    const source = asObject(message);
    if (!source || str(source.role).toLowerCase() !== 'context') return false;
    const kind = str(source.kind).toLowerCase();
    return kind === KIND_INCLUDED || kind === KIND_RECEIPT || kind === KIND_HANDOFF;
  }

  function buildHandoffRow(message) {
    const id = str(message.id);
    return {
      row_id: `row:${id}:${ROW_KIND_HANDOFF}`,
      turn_id: str(message.turn_id || message.turnId),
      kind: ROW_KIND_HANDOFF,
      primary_message_id: id,
      render_message_id: id,
      source_message_ids: id ? [id] : [],
      payload: {
        content: String(message.content == null ? '' : message.content),
        handoff: asObject(message.session_handoff) || {},
        timestamp: str(message.timestamp),
      },
    };
  }

  /** The canonical projected row for one persisted context message, or null for anything else. */
  function buildSessionMessageRow(message) {
    if (!isSessionMessageRecord(message)) return null;
    if (str(message.kind).toLowerCase() === KIND_HANDOFF) return buildHandoffRow(message);
    const id = str(message.id);
    const discarded = str(message.kind).toLowerCase() === KIND_RECEIPT || str(message.disposition) === 'discarded';
    return {
      row_id: `row:${id}:${ROW_KIND}`,
      turn_id: str(message.turn_id || message.turnId),
      kind: ROW_KIND,
      primary_message_id: id,
      render_message_id: id,
      source_message_ids: id ? [id] : [],
      payload: {
        disposition: discarded ? 'discarded' : 'included',
        content: String(message.content == null ? '' : message.content),
        envelope: asObject(message.session_message) || {},
        timestamp: str(message.timestamp),
      },
    };
  }

  // Module-level lookups the app composition may install once; per-call overrides win.
  const configured = { getSessions: null, getProjectName: null, formatTime: null };

  function configure(options) {
    const next = options || {};
    for (const key of Object.keys(configured)) {
      if (Object.prototype.hasOwnProperty.call(next, key)) {
        configured[key] = typeof next[key] === 'function' ? next[key] : null;
      }
    }
  }

  function defaultFormatTime(value) {
    const stamp = Date.parse(str(value));
    if (!Number.isFinite(stamp)) return '';
    try {
      return new Date(stamp).toLocaleTimeString(globalThis.jennyI18n?.tag?.(), {
        hour: 'numeric', ...globalThis.jennyI18n?.timeOptions?.(), minute: '2-digit',
      });
    } catch (_error) {
      return '';
    }
  }

  function resolveDeps(overrides) {
    const given = overrides || {};
    const stringUtils = globalThis.stringUtils || requireOptional('../shared/string-utils') || {};
    const pick = (key) => (typeof given[key] === 'function' ? given[key] : configured[key]);
    return {
      escapeHtml: typeof given.escapeHtml === 'function' ? given.escapeHtml : stringUtils.escapeHtml,
      getSessions: pick('getSessions') || (() => []),
      getProjectName: pick('getProjectName') || (() => ''),
      formatTime: pick('formatTime') || defaultFormatTime,
      actionButton: typeof given.actionButton === 'function' ? given.actionButton
        : (globalThis.inventoryActionButton || requireOptional('../inventory/action-button')),
    };
  }

  /** Source chat + project from the live summaries. A chat that is gone (or replaced by a new
   *  incarnation under the same id) is "Deleted chat" and its chip is not a link. */
  function resolveSource(envelope, deps) {
    const sessionId = str(envelope.source_session_id);
    const sessions = deps.getSessions();
    const session = sessionId && Array.isArray(sessions)
      ? sessions.find((entry) => entry && str(entry.id) === sessionId)
      : null;
    const incarnation = str(session && session.session_incarnation);
    const replaced = Boolean(incarnation && str(envelope.source_session_incarnation)
      && incarnation !== str(envelope.source_session_incarnation));
    const projectId = session && !replaced ? str(session.project_id) : str(envelope.source_project_id);
    const projectName = GENERAL_PROJECT_IDS.has(projectId)
      ? jt('projects.switcher.generalName', 'General')
      : str(deps.getProjectName(projectId));
    if (!session || replaced) {
      return { available: false, sessionId: '', title: jt('chat.sessionMessage.deletedChat', 'Deleted chat'), projectName };
    }
    return {
      available: true,
      sessionId,
      title: str(session.title) || jt('chat.sessionMessage.untitledChat', 'Untitled chat'),
      projectName,
    };
  }

  // The shared words of the addressed-message surfaces (outcome words, clipped marker); loaded lazily
  // because this script runs before renderer-chat-messages-copy.js in the page.
  const messageCopy = () => globalThis.rendererChatMessagesCopy || requireOptional('./renderer-chat-messages-copy');

  function statusMarkup(deps, row, controls) {
    const { escapeHtml } = deps;
    const extra = controls || '';
    if (row.payload.disposition === 'discarded') {
      return '<div class="session-message-status" data-tone="muted"><span class="status-dot status-dot--muted" aria-hidden="true"></span>'
        + `<span class="session-message-state">${escapeHtml(jt('chat.sessionMessage.discarded', 'Discarded · never shown to the model'))}</span>${extra}</div>`;
    }
    const time = deps.formatTime(row.payload.timestamp);
    const word = time
      ? jt('chat.sessionMessage.includedAt', 'Included in the turn at {time}', { time })
      : jt('chat.sessionMessage.included', 'Included in the turn');
    return '<div class="session-message-status" data-tone="ok"><span class="status-dot status-dot--ok" aria-hidden="true"></span>'
      + `<span class="session-message-state">${escapeHtml(word)}</span>${extra}</div>`;
  }

  /** The Background card: "Background from {parent}" (a button while the parent exists), the text as is. */
  function buildHandoffMarkup(row, payload, deps) {
    const { escapeHtml } = deps;
    const handoff = asObject(payload.handoff) || {};
    const source = resolveSource(handoff, deps);
    const label = source.available ? jt('chat.sessionHandoff.from', 'Background from') : jt('chat.sessionHandoff.label', 'Background');
    const title = source.available ? source.title : jt('chat.sessionHandoff.unavailable', 'Original chat unavailable');
    const chipInner = `<span class="session-message-from-label">${escapeHtml(label)}</span>`
      + `<span class="session-message-from-title">${escapeHtml(title)}</span>`;
    const chip = source.available
      ? deps.actionButton({
        plain: true, className: 'session-message-from', trustedHtml: chipInner,
        dataset: { 'session-message-open': source.sessionId },
        ariaLabel: jt('chat.sessionHandoff.openParent', 'Open chat {title}', { title: source.title }),
      })
      : `<span class="session-message-from session-message-from--static">${chipInner}</span>`;
    const aria = source.available
      ? jt('chat.sessionHandoff.cardAria', 'Background from {title}', { title: source.title })
      : jt('chat.sessionHandoff.cardAriaUnavailable', 'Background, original chat unavailable');
    return `<section class="session-message-card session-message-card--handoff" role="group" data-session-handoff-id="${escapeHtml(str(row.primary_message_id))}"`
      + ` aria-label="${escapeHtml(aria)}">`
      + `<div class="session-message-header">${chip}</div>`
      + `<div class="session-message-body" dir="auto">${escapeHtml(payload.content)}</div></section>`;
  }

  /** "Started from {parent}" for a child chat's origin chip; '' when the chat was not started from another. */
  function buildStartedFromLabel(session, sessions) {
    const spawned = asObject(session && session.spawned_from);
    const parentId = str(spawned && spawned.parent_session_id);
    if (!parentId) return '';
    const list = Array.isArray(sessions) ? sessions : [];
    const parent = list.find((entry) => entry && str(entry.id) === parentId);
    const parentIncarnation = str(spawned.parent_session_incarnation);
    const replaced = Boolean(parent && parentIncarnation && str(parent.session_incarnation)
      && str(parent.session_incarnation) !== parentIncarnation);
    if (!parent || replaced) return jt('chat.sessionHandoff.startedFromUnavailable', 'Started from an unavailable chat');
    return jt('chat.sessionHandoff.startedFrom', 'Started from {title}', {
      title: str(parent.title) || jt('chat.sessionMessage.untitledChat', 'Untitled chat'),
    });
  }

  /** The attributed card for one projected row. */
  function buildSessionMessageRowMarkup(row, overrides) {
    const payload = asObject(row && row.payload);
    if (!payload) return '';
    const deps = resolveDeps(overrides);
    if (row.kind === ROW_KIND_HANDOFF) return buildHandoffMarkup(row, payload, deps);
    const { escapeHtml } = deps;
    const envelope = asObject(payload.envelope) || {};
    if (envelope.kind === 'terminal_report') return buildReportMarkup(row, payload, envelope, deps);
    const source = resolveSource(envelope, deps);
    const label = jt('chat.sessionMessage.from', 'From');
    const chipInner = `<span class="session-message-from-label">${escapeHtml(label)}</span>`
      + `<span class="session-message-from-title">${escapeHtml(source.title)}</span>`;
    const chip = source.available
      ? deps.actionButton({
        plain: true, className: 'session-message-from', trustedHtml: chipInner,
        dataset: { 'session-message-open': source.sessionId },
        ariaLabel: jt('chat.sessionMessage.openSource', 'Open chat {title}', { title: source.title }),
      })
      : `<span class="session-message-from session-message-from--static">${chipInner}</span>`;
    const sentAt = deps.formatTime(envelope.created_at);
    const meta = [source.projectName, sentAt].filter(Boolean).map((part) => `· ${part}`).join(' ');
    return `<section class="session-message-card" role="group" data-session-message-id="${escapeHtml(str(row.primary_message_id))}"`
      + ` data-session-message-state="${payload.disposition === 'discarded' ? 'discarded' : 'included'}"`
      + ` aria-label="${escapeHtml(jt('chat.sessionMessage.cardAria', 'Message from {title}', { title: source.title }))}">`
      + `<div class="session-message-header">${chip}${meta ? `<span class="session-message-meta">${escapeHtml(meta)}</span>` : ''}</div>`
      + `<div class="session-message-body" dir="auto">${escapeHtml(payload.content)}</div>`
      + `${statusMarkup(deps, row)}</section>`;
  }

  /** The report card (cp5b-1): "Report from {child}", the outcome word, the plain answer, the clipped marker
   *  and an Open chat link while the child exists. The persisted row and its state line are the message's own. */
  function buildReportMarkup(row, payload, envelope, deps) {
    const { escapeHtml } = deps;
    const wording = messageCopy();
    const outcome = wording ? wording.reportOutcome(envelope) : { outcome: '', tone: 'muted', word: '' };
    const source = resolveSource(envelope, deps);
    const chipInner = `<span class="session-message-from-label">${escapeHtml(wording ? wording.reportFromLabel() : '')}</span>`
      + `<span class="session-message-from-title">${escapeHtml(source.title)}</span>`;
    const chip = source.available
      ? deps.actionButton({
        plain: true, className: 'session-message-from', trustedHtml: chipInner, title: source.title,
        dataset: { 'session-message-open': source.sessionId },
        ariaLabel: jt('chat.sessionMessage.openSource', 'Open chat {title}', { title: source.title }),
      })
      : `<span class="session-message-from session-message-from--static">${chipInner}</span>`;
    const sentAt = deps.formatTime(envelope.created_at);
    const meta = [source.projectName, sentAt].filter(Boolean).map((part) => `· ${part}`).join(' ');
    const outcomeMarkup = outcome.word
      ? `<span class="session-message-outcome" data-tone="${escapeHtml(outcome.tone)}">${escapeHtml(`· ${outcome.word}`)}</span>` : '';
    const clipped = wording && wording.isReportClipped(envelope)
      ? `<div class="session-message-clipped">${escapeHtml(wording.reportClippedText())}</div>` : '';
    const openChat = source.available && wording
      ? deps.actionButton({
        plain: true, className: 'session-message-link', label: wording.reportOpenChatLabel(),
        dataset: { 'session-message-open': source.sessionId },
      })
      : '';
    return `<section class="session-message-card session-message-card--report" role="group" data-session-message-id="${escapeHtml(str(row.primary_message_id))}"`
      + ` data-session-message-state="${payload.disposition === 'discarded' ? 'discarded' : 'included'}"`
      + ` data-report-outcome="${escapeHtml(outcome.outcome)}"`
      + ` aria-label="${escapeHtml(wording ? wording.reportCardAria(source.title) : source.title)}">`
      + `<div class="session-message-header">${chip}${outcomeMarkup}${meta ? `<span class="session-message-meta">${escapeHtml(meta)}</span>` : ''}</div>`
      + `<div class="session-message-body" dir="auto">${escapeHtml(payload.content)}</div>${clipped}`
      + `${statusMarkup(deps, row, openChat)}</section>`;
  }

  /** Persisted context message -> card markup; '' for any other message. */
  function renderSessionMessage(message, overrides) {
    const row = buildSessionMessageRow(message);
    return row ? buildSessionMessageRowMarkup(row, overrides) : '';
  }

  /** One delegated listener per timeline: the From chip opens the source chat. */
  function bindSessionMessageCards(rootElement, options) {
    const openSession = options && options.openSession;
    if (!rootElement || typeof rootElement.addEventListener !== 'function' || typeof openSession !== 'function') {
      return function noop() {};
    }
    const onClick = (event) => {
      const target = event && event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-session-message-open]')
        : null;
      if (!target || (typeof rootElement.contains === 'function' && !rootElement.contains(target))) return;
      const sessionId = str(target.getAttribute('data-session-message-open'));
      if (!sessionId) return;
      event.preventDefault();
      openSession(sessionId);
    };
    rootElement.addEventListener('click', onClick);
    return function dispose() { rootElement.removeEventListener('click', onClick); };
  }

  return {
    ROW_KIND,
    ROW_KIND_HANDOFF,
    buildStartedFromLabel,
    isSessionMessageRecord,
    buildSessionMessageRow,
    buildSessionMessageRowMarkup,
    renderSessionMessage,
    bindSessionMessageCards,
    configure,
  };
});
