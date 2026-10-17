(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMemoryChatEntry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  // The chat row for the sidecar memory tool (memory v2, row 58 W1): one line per
  // saved or pending write, with Undo while the operation can still be undone.
  // The memory text never enters the markup; only the tool's bounded text_preview does.
  const MEMORY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5h7v11L8 11l-3.5 2.5z"/></svg>';
  const CARET_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
  const RENDERED_STATUSES = new Set(['saved', 'pending_approval']);
  const RENDERED_ACTIONS = new Set(['remember', 'update', 'forget']);
  // An undo the store refuses for these reasons can never succeed: the memory changed since.
  const STALE_REASONS = new Set(['stale_revision', 'operation_expired', 'not_found', 'operation_mismatch']);
  const OPERATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/; // backend-memory.js and the store agree
  const MAX_PREVIEW_CHARS = 120;
  // The bound entry: the row builder asks it whether an operation was undone or overtaken.
  let activeEntry = null;

  function fallbackEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  function resolveActionButton(explicit) {
    if (typeof explicit === 'function') return explicit;
    const candidates = [globalThis.inventoryActionButton, globalThis.inventory?.actionButton];
    return candidates.find((candidate) => typeof candidate === 'function') || null;
  }

  function resolveCollapsible(explicit) {
    const candidate = explicit || globalThis.inventoryCollapsible || globalThis.inventory?.collapsible;
    return typeof candidate?.trigger === 'function' && typeof candidate?.content === 'function' ? candidate : null;
  }

  function kindLabel(kind) {
    switch (kind) {
      case 'preference': return jt('memory.kinds.preference', 'Preference');
      case 'fact': return jt('memory.kinds.fact', 'Fact');
      case 'decision': return jt('memory.kinds.decision', 'Decision');
      case 'convention': return jt('memory.kinds.convention', 'Convention');
      case 'person': return jt('memory.kinds.person', 'Person');
      case 'routine': return jt('memory.kinds.routine', 'Routine');
      case 'lesson': return jt('memory.kinds.lesson', 'Lesson');
      default: return '';
    }
  }

  function scopeLabel(scope) {
    switch (scope) {
      case 'chat': return jt('memory.chat.scopeChat', 'This chat');
      case 'project': return jt('memory.chat.scopeProject', 'This project');
      case 'global': return jt('memory.chat.scopeGlobal', 'Everywhere');
      default: return '';
    }
  }

  function titleFor(meta) {
    if (meta.status === 'pending_approval') return jt('memory.chat.pending', 'Memory waiting for approval');
    if (meta.action === 'update') return jt('memory.chat.updated', 'Updated a memory');
    if (meta.action === 'forget') return jt('memory.chat.forgot', 'Forgot a memory');
    if (meta.origin === 'reflection') return jt('memory.chat.tookNote', 'Jenny took a note');
    return jt('memory.chat.remembered', 'Remembered');
  }

  function boundedPreview(value) {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS - 1)}…` : text;
  }

  function restingText(kind) {
    return kind === 'undone' ? jt('ide.changes.undone', 'Undone') : jt('memory.chat.changedSince', 'Changed since');
  }

  function restingMarkup(kind, escapeHtml) {
    const className = kind === 'undone' ? 'notes-chat__undone' : 'notes-chat__stale';
    return `<span class="${className}">${escapeHtml(restingText(kind))}</span>`;
  }

  function operationIdOf(meta) {
    const id = typeof meta.operation_id === 'string' ? meta.operation_id : '';
    return OPERATION_ID_PATTERN.test(id) ? id : '';
  }

  /** The tool row's header meta (tool-call-utils.js formatToolResultMeta): the chip title, or ''. */
  function formatMemoryResultMeta(metadata) {
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    return RENDERED_STATUSES.has(meta.status) && RENDERED_ACTIONS.has(meta.action) ? titleFor(meta) : '';
  }

  /** The chat row for a memory tool result, or '' for recall/list/refused/conflict. */
  function buildMemoryResultBlockMarkup(metadata, deps) {
    const meta = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null;
    if (!meta || meta.result_kind !== 'memory') return '';
    if (!RENDERED_STATUSES.has(meta.status) || !RENDERED_ACTIONS.has(meta.action)) return '';
    const options = deps || {};
    const escapeHtml = typeof options.escapeHtml === 'function' ? options.escapeHtml : fallbackEscapeHtml;
    const operationId = operationIdOf(meta);
    // The row names its chat, so an Undo in a split pane reaches the right session.
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
    // Inside a group the header says who took the notes; each row leads with its kind.
    const grouped = options.grouped === true && Boolean(kindLabel(meta.kind));
    const title = grouped ? kindLabel(meta.kind) : titleFor(meta);
    const metaText = [grouped ? '' : kindLabel(meta.kind), scopeLabel(meta.scope), boundedPreview(meta.text_preview)]
      .filter(Boolean).join(' · ');
    let undo = '';
    if (meta.undoable === true && meta.status === 'saved' && operationId) {
      const known = activeEntry?.operationState?.(operationId) || '';
      const actionButton = resolveActionButton(options.actionButton);
      if (known) {
        undo = restingMarkup(known, escapeHtml);
      } else if (actionButton) {
        undo = actionButton({
          variant: 'ghost', size: 'sm', className: 'notes-chat__undo',
          label: jt('dashboard.calendar.agenda.undo', 'Undo'),
          ariaLabel: jt('memory.chat.undoAria', 'Undo the memory change'),
          title: jt('memory.chat.undoAria', 'Undo the memory change'),
          dataset: { 'memory-undo': operationId },
        });
      }
    }
    const sessionAttr = sessionId ? ` data-memory-session="${escapeHtml(sessionId)}"` : '';
    return `<div class="notes-chat__row notes-chat__row--memory" data-memory-operation="${escapeHtml(operationId)}"${sessionAttr}>`
      + `<span class="notes-chat__icon" aria-hidden="true">${MEMORY_ICON}</span>`
      + `<span class="notes-chat__title">${escapeHtml(title)}</span>`
      + `<span class="notes-chat__meta">${escapeHtml(metaText)}</span>${undo}</div>`;
  }

  /**
   * The chat row(s) for a reflection receipt (row 58 W2): one note renders as its
   * chip; two or more fold under one "Jenny took N notes" row that opens to the
   * chips, each with its own Undo, so a run never stacks rows in the timeline.
   */
  function buildMemoryNotesMarkup(notes, deps) {
    const options = deps || {};
    const list = (Array.isArray(notes) ? notes : [])
      .map((meta) => ({ meta, markup: buildMemoryResultBlockMarkup(meta, { ...options, grouped: true }) }))
      .filter((entry) => entry.markup);
    if (list.length < 2) return list.length ? buildMemoryResultBlockMarkup(list[0].meta, options) : '';
    const collapsible = resolveCollapsible(options.collapsible);
    if (!collapsible) return list.map((entry) => buildMemoryResultBlockMarkup(entry.meta, options)).join('');
    const escapeHtml = typeof options.escapeHtml === 'function' ? options.escapeHtml : fallbackEscapeHtml;
    const groupId = `memory-notes-${String(options.groupId || operationIdOf(list[0].meta)).replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const open = activeEntry?.isGroupOpen?.(groupId) === true;
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
    const sessionAttr = sessionId ? ` data-memory-session="${escapeHtml(sessionId)}"` : '';
    const previews = list.map((entry) => boundedPreview(entry.meta.text_preview)).filter(Boolean).join(' · ');
    const count = list.length;
    const title = jtn('memory.chat.tookNotes', count, { count }, 'Jenny took {count} note', 'Jenny took {count} notes');
    const header = `<span class="notes-chat__icon" aria-hidden="true">${MEMORY_ICON}</span>`
      + `<span class="notes-chat__title">${escapeHtml(title)}</span>`
      + `<span class="notes-chat__meta">${escapeHtml(previews)}</span>`
      + `<span class="notes-chat__caret" aria-hidden="true">${CARET_ICON}</span>`;
    return `<div class="notes-chat__group" data-memory-notes-group="${escapeHtml(groupId)}"${sessionAttr}>`
      + collapsible.trigger({ id: groupId, open, className: 'notes-chat__row notes-chat__row--memory notes-chat__group-header', children: header })
      + collapsible.content({ id: groupId, open, className: 'notes-chat__group-rows', children: list.map((entry) => entry.markup).join('') })
      + '</div>';
  }

  function createMemoryChatEntry(deps) {
    const d = deps || {};
    const state = d.state;
    if (!state || typeof state !== 'object') throw new Error('renderer-memory-chat-entry: state dep is required');
    const windowRef = d.windowRef || globalThis.window || globalThis;
    const doc = windowRef.document;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : () => {};
    const showToastMessage = typeof d.showToastMessage === 'function' ? d.showToastMessage : () => {};
    const operations = new Map(); // operation id -> 'undone' | 'stale'
    const openGroups = new Set(); // note groups the user opened stay open across a re-render
    let bound = false;
    let disposed = false;

    const memoryApi = () => windowRef.jennyShell?.memory || null;
    const operationState = (operationId) => operations.get(String(operationId || '')) || '';

    // Every row for the operation settles together (a transcript can show it twice).
    function settle(operationId, kind, focusTrigger) {
      operations.set(operationId, kind);
      for (const trigger of [...(doc?.querySelectorAll?.('[data-memory-undo]') || [])]) {
        if (trigger.dataset.memoryUndo !== operationId) continue;
        const span = trigger.ownerDocument.createElement('span');
        span.className = kind === 'undone' ? 'notes-chat__undone' : 'notes-chat__stale';
        span.textContent = restingText(kind);
        trigger.replaceWith(span);
        // A keyboard Undo keeps its place: focus lands on the result, not on <body>.
        if (trigger === focusTrigger) {
          span.setAttribute('tabindex', '-1');
          span.focus?.();
        }
      }
    }

    function release(trigger) {
      delete trigger.dataset.memoryBusy;
      trigger.disabled = false;
    }

    async function runUndo(trigger) {
      if (trigger.dataset.memoryBusy === '1') return;
      const operationId = trigger.dataset.memoryUndo || '';
      const sessionId = String(trigger.closest?.('[data-memory-session]')?.dataset.memorySession || state.currentSessionId || '');
      const api = memoryApi();
      if (!OPERATION_ID_PATTERN.test(operationId) || !sessionId || typeof api?.undo !== 'function') return;
      const hadFocus = trigger.ownerDocument.activeElement === trigger; // disabling it drops focus
      trigger.dataset.memoryBusy = '1';
      trigger.disabled = true;
      let result = null;
      try {
        result = await api.undo({ sessionId, operationId });
      } catch (error) {
        appendClientLog('WARN', 'memory.undo_failed', { message: String(error?.message || error || '').slice(0, 200) });
      }
      if (disposed) return;
      const reason = typeof result?.reason === 'string' ? result.reason : '';
      if (result?.status === 'saved') {
        settle(operationId, 'undone', hadFocus ? trigger : null);
      } else if (result?.status === 'conflict' || (result?.status === 'refused' && STALE_REASONS.has(reason))) {
        settle(operationId, 'stale', hadFocus ? trigger : null);
      } else {
        release(trigger);
        if (result) appendClientLog('INFO', 'memory.undo_refused', { reason: reason || 'unknown' });
        showToastMessage(jt('memory.chat.undoFailed', 'Could not undo the memory change. Try again.'));
      }
    }

    // The collapsible primitive toggles the group on the same event; read its state after.
    function rememberGroup(event) {
      const header = event.target?.closest?.('[data-memory-notes-group] > [data-inv-collapsible]');
      if (!header) return;
      queueMicrotask(() => {
        const groupId = header.getAttribute('data-inv-collapsible') || '';
        if (header.getAttribute('aria-expanded') === 'true') openGroups.add(groupId);
        else openGroups.delete(groupId);
      });
    }

    function handleDocumentClick(event) {
      if (disposed) return;
      const trigger = event.target?.closest?.('[data-memory-undo]');
      if (trigger) void runUndo(trigger);
      else rememberGroup(event);
    }

    function handleDocumentKeydown(event) {
      if (disposed || (event.key !== 'Enter' && event.key !== ' ')) return;
      rememberGroup(event);
    }

    function bind() {
      if (bound || disposed) return;
      bound = true;
      doc?.addEventListener('click', handleDocumentClick);
      doc?.addEventListener('keydown', handleDocumentKeydown);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      doc?.removeEventListener?.('click', handleDocumentClick);
      doc?.removeEventListener?.('keydown', handleDocumentKeydown);
      if (activeEntry === api) activeEntry = null;
    }

    const api = { bind, dispose, operationState, isGroupOpen: (groupId) => openGroups.has(String(groupId || '')) };
    activeEntry = api;
    return api;
  }

  return { buildMemoryNotesMarkup, buildMemoryResultBlockMarkup, createMemoryChatEntry, formatMemoryResultMeta };
});
