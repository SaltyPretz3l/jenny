(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(globalThis); return; }
  root.rendererMemoryPageViewUtils = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  // Settings › Memory page markup (row 58 W4, owner pick "list first"):
  // scope tabs, the always-on meter, one flat list with a ⋯ menu per row,
  // the "Waiting for your OK" group, and the Forgotten and History folds.
  // Pure string builders; renderer-memory-settings-utils.js composes them.
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const GENERAL_PROJECT_ID = 'project_general';
  const MAX_TEXT_CHARS = 240;
  // Mirrors sidecar/ai/memory/contracts.py; `memory.status` sends the live values.
  const DEFAULT_ALWAYS_ON_BUDGET = Object.freeze({ budgetChars: 1200, headingReserve: 144, rowOverhead: 16 });

  function memoryScope(memory) {
    const id = String(memory?.project_id || '').trim();
    return id || GENERAL_PROJECT_ID;
  }

  // General first, then every project that holds a memory (active or only
  // forgotten, from `memory.status`), plus the open tab.
  function buildScopeTabs(memories, projects, currentScope, getProjectLabel, forgottenScopes = []) {
    const counts = new Map([[GENERAL_PROJECT_ID, 0]]);
    for (const memory of memories) counts.set(memoryScope(memory), (counts.get(memoryScope(memory)) || 0) + 1);
    for (const id of forgottenScopes) if (!counts.has(id)) counts.set(id, 0);
    if (currentScope && !counts.has(currentScope)) counts.set(currentScope, 0);
    const order = [GENERAL_PROJECT_ID, ...projects.map((project) => project.id).filter((id) => id !== GENERAL_PROJECT_ID && counts.has(id))];
    for (const id of counts.keys()) if (!order.includes(id)) order.push(id);
    return order.map((id) => ({ id, label: getProjectLabel(id), count: counts.get(id) || 0 }));
  }

  // A project tab whose project is gone from a loaded registry (deleted). An
  // empty or unread registry proves nothing, so it never marks a scope deleted.
  function isDeletedProjectScope(scope, projects) {
    if (!scope || scope === GENERAL_PROJECT_ID || !Array.isArray(projects) || !projects.length) return false;
    return !projects.some((project) => project?.id === scope);
  }

  // The rendered `## Always-on memories` cost: General rows first, then the
  // project's, oldest id first; rows past the budget stay recall-only.
  function alwaysOnUsage(memories, scope, budget) {
    const limits = { ...DEFAULT_ALWAYS_ON_BUDGET, ...(budget || {}) };
    const scopes = scope === GENERAL_PROJECT_ID ? [GENERAL_PROJECT_ID] : [GENERAL_PROJECT_ID, scope];
    const pinned = memories
      .filter((memory) => memory.always_on && !memory.scope_session_id && scopes.includes(memoryScope(memory)))
      .sort((left, right) => scopes.indexOf(memoryScope(left)) - scopes.indexOf(memoryScope(right)) || left.id - right.id);
    let used = limits.headingReserve;
    let overflow = 0;
    for (const memory of pinned) {
      const cost = memory.lesson_text.length + limits.rowOverhead;
      if (used + cost > limits.budgetChars) overflow += 1;
      else used += cost;
    }
    return { used: pinned.length ? used : 0, budget: limits.budgetChars, pinned: pinned.length, overflow };
  }

  function formatDay(value) {
    const time = Date.parse(String(value || ''));
    if (!Number.isFinite(time)) return '';
    try {
      return new Intl.DateTimeFormat(root.jennyI18n?.locale || undefined, { month: 'short', day: 'numeric' }).format(new Date(time));
    } catch (_error) {
      return String(value).slice(0, 10);
    }
  }

  function originLabel(memory) {
    if (memory.origin === 'user') return jt('memory.page.originYou', 'You');
    if (memory.origin === 'reflection') return jt('memory.page.originNote', 'Jenny’s note');
    if (memory.origin === 'legacy') return jt('memory.page.originEarlier', 'Earlier version');
    return jt('memory.page.originJenny', 'Jenny');
  }

  function createMemoryPageView(deps) {
    const escapeHtml = deps?.escapeHtml || ((value) => String(value || ''));
    const getKindLabel = deps?.getKindLabel || ((kind) => String(kind || ''));
    const chatTitle = deps?.chatTitle || (() => '');
    const button = (options) => (typeof root.inventoryActionButton === 'function' ? root.inventoryActionButton(options) : '');
    const link = (options) => button({ plain: true, ...options, className: `memory-link${options.className ? ` ${options.className}` : ''}` });

    function tabsMarkup(tabs, currentScope) {
      return '<div class="memory-scope-tabs" role="tablist" aria-label="' + escapeHtml(jt('memory.page.scopeTabsLabel', 'Memory scope')) + '">'
        + tabs.map((tab) => button({
          plain: true,
          className: `memory-scope-tab${tab.id === currentScope ? ' is-active' : ''}`,
          role: 'tab',
          ariaSelected: tab.id === currentScope ? 'true' : 'false',
          tabIndex: tab.id === currentScope ? 0 : -1,
          label: tab.label,
          trustedHtml: `${escapeHtml(tab.label)}<span class="memory-scope-tab-count">${tab.count}</span>`,
          dataset: { 'memory-scope': tab.id },
        })).join('')
        + '</div>';
    }

    function meterMarkup(usage, scope) {
      if (!usage.pinned) return '';
      const over = usage.overflow > 0;
      const text = scope === GENERAL_PROJECT_ID
        ? jt('memory.page.meterGeneral', '{used} / {budget} characters', { used: usage.used.toLocaleString(), budget: usage.budget.toLocaleString() })
        : jt('memory.page.meterProject', '{used} / {budget} characters with General', { used: usage.used.toLocaleString(), budget: usage.budget.toLocaleString() });
      const bar = typeof root.inventoryProgressBar?.progressBar === 'function'
        ? root.inventoryProgressBar.progressBar({ value: usage.used, max: usage.budget, label: text, className: 'memory-meter-bar', warningThreshold: over ? 0 : 2, dangerThreshold: 2 })
        : '';
      return `<span class="memory-meter-label">${escapeHtml(jt('memory.page.alwaysOn', 'Always on'))}</span>${bar}<span>${escapeHtml(text)}</span>`
        + (over ? `<span class="memory-meter-over">${escapeHtml(jtn('memory.page.meterOverflow', usage.overflow, { count: usage.overflow }, '{count} pinned memory doesn’t fit; Jenny recalls it only when it’s relevant.', '{count} pinned memories don’t fit; Jenny recalls them only when they’re relevant.'))}</span>` : '');
    }

    function metaMarkup(memory, sourceAvailable) {
      const parts = [`<span class="memory-kind">${escapeHtml(getKindLabel(memory.lesson_kind))}</span>`];
      const day = formatDay(memory.created_at);
      parts.push(`<span class="memory-meta-item">${escapeHtml(day ? `${originLabel(memory)} · ${day}` : originLabel(memory))}</span>`);
      if (memory.scope_session_id) {
        const title = chatTitle(memory.scope_session_id);
        parts.push(`<span class="memory-meta-item">${escapeHtml(title
          ? jt('memory.page.chatOnlyTitled', 'This chat only: “{title}”', { title })
          : jt('memory.page.chatOnly', 'This chat only'))}</span>`);
      }
      if (memory.protected) parts.push(`<span class="memory-meta-item memory-meta-edited">${escapeHtml(jt('memory.page.editedByYou', 'Edited by you'))}</span>`);
      if (memory.provenance === 'source_removed') {
        parts.push(`<span class="memory-meta-item">${escapeHtml(jt('memory.page.sourceRemoved', 'Source chat deleted'))}</span>`);
      } else if (sourceAvailable) {
        parts.push(`<span class="memory-meta-item">${link({ id: `memory-why-${memory.id}`, label: jt('memory.page.why', 'Why did Jenny remember this?'), dataset: { 'memory-page-action': 'why', 'memory-id': String(memory.id) } })}</span>`);
      }
      return `<div class="memory-meta">${parts.join('')}</div>`;
    }

    function editMarkup(memory, draftText, busy) {
      const textField = typeof root.inventoryTextField === 'function' ? root.inventoryTextField : null;
      const field = textField
        ? textField({ id: `memoryText${memory.id}`, label: jt('memory.settings.memoryLabel', 'Memory'), value: draftText, maxLength: MAX_TEXT_CHARS, multiline: true, spellcheck: true, dataset: { 'memory-draft-field': 'lesson_text', 'memory-id': String(memory.id) } })
        : '';
      return `<div class="memory-edit">${field}<div class="memory-edit-footer">`
        + `<span class="memory-edit-hint">${escapeHtml(jt('memory.page.editHint', 'Your edit keeps Jenny from changing this memory.'))}</span>`
        + '<span class="memory-edit-actions">'
        + link({ id: `cancel-memory-${memory.id}`, label: jt('common.cancel', 'Cancel'), disabled: busy, dataset: { 'memory-action': 'cancel', 'memory-id': String(memory.id) } })
        + button({ id: `save-memory-${memory.id}`, label: busy ? jt('memory.actions.saving', 'Saving…') : jt('common.save', 'Save'), variant: 'primary', size: 'sm', disabled: busy || !draftText.trim() || draftText === memory.lesson_text, dataset: { 'memory-action': 'save', 'memory-id': String(memory.id) } })
        + '</span></div></div>';
    }

    function recordMarkup(memory, options) {
      const { editing = false, draftText = '', busy = false, sourceAvailable = false } = options || {};
      if (editing) {
        return `<article class="memory-record memory-record--editing" role="listitem" data-memory-id="${memory.id}">${editMarkup(memory, draftText, busy)}</article>`;
      }
      const alwaysOn = memory.scope_session_id ? '' : (root.inventoryToggleSwitch?.toggleSwitch?.({
        id: `memoryAlwaysOn-${memory.id}`,
        label: jt('memory.page.alwaysOn', 'Always on'),
        tooltip: memoryScope(memory) === GENERAL_PROJECT_ID
          ? jt('memory.page.alwaysOnTipGeneral', 'Included in every chat')
          : jt('memory.page.alwaysOnTipProject', 'Included in every chat in this project'),
        checked: memory.always_on,
        disabled: busy,
        className: 'memory-always-on',
      }) || '');
      const more = button({
        id: `memory-more-${memory.id}`,
        variant: 'ghost',
        size: 'sm',
        className: 'memory-more',
        label: '⋯',
        ariaLabel: jt('memory.page.moreActions', 'More actions for this memory'),
        ariaHaspopup: 'menu',
        ariaExpanded: 'false',
        disabled: busy,
        dataset: { 'memory-page-action': 'menu', 'memory-id': String(memory.id) },
      });
      return `<article class="memory-record" role="listitem" data-memory-id="${memory.id}">`
        + `<div class="memory-record-main"><p class="memory-text">${escapeHtml(memory.lesson_text)}</p>${metaMarkup(memory, sourceAvailable)}</div>`
        + `<div class="memory-record-side">${alwaysOn}${more}</div></article>`;
    }

    function pendingMarkup(candidates, buildKey, actionByKey, projectLabel) {
      if (!candidates.length) return '';
      const rows = candidates.map((candidate) => {
        const key = buildKey(candidate.session_id, candidate.content_fingerprint);
        const busy = Boolean(actionByKey.get(key));
        const data = { 'session-id': candidate.session_id, fingerprint: candidate.content_fingerprint, 'project-id': candidate.project_id };
        const where = chatTitle(candidate.session_id)
          ? jt('memory.page.pendingFromChat', 'Jenny · from “{title}”', { title: chatTitle(candidate.session_id) })
          : jt('memory.page.pendingIn', 'Jenny · {scope}', { scope: projectLabel(candidate.project_id || GENERAL_PROJECT_ID) });
        return `<article class="memory-record" role="listitem" data-pending-memory-key="${escapeHtml(key)}">`
          + `<div class="memory-record-main"><p class="memory-text">${escapeHtml(candidate.lesson_text)}</p>`
          + `<div class="memory-meta"><span class="memory-kind">${escapeHtml(getKindLabel(candidate.lesson_kind))}</span><span class="memory-meta-item">${escapeHtml(where)}</span></div></div>`
          + '<div class="memory-record-side">'
          + link({ id: `approve-${escapeHtml(key)}`, label: jt('common.save', 'Save'), disabled: busy, dataset: { 'pending-memory-action': 'approve', ...data } })
          + link({ id: `dismiss-${escapeHtml(key)}`, label: jt('common.dismiss', 'Dismiss'), disabled: busy, dataset: { 'pending-memory-action': 'discard', ...data } })
          + '</div></article>';
      }).join('');
      return `<div class="memory-pending" role="group" aria-labelledby="memoryPendingHeading">`
        + `<h4 class="memory-pending-heading" id="memoryPendingHeading">${escapeHtml(jt('memory.page.pendingHeading', 'Waiting for your OK'))} <span class="memory-count">${candidates.length}</span></h4>`
        + `<div class="memory-record-list" role="list">${rows}</div></div>`;
    }

    function foldMarkup(id, open, title, countText, body) {
      const trigger = typeof root.inventoryCollapsible?.trigger === 'function'
        ? root.inventoryCollapsible.trigger({ id: `${id}Panel`, open, className: 'memory-fold-trigger', children: `<span class="memory-fold-title">${escapeHtml(title)}</span>${countText ? `<span class="memory-count">${escapeHtml(countText)}</span>` : ''}`, dataAttrs: { 'memory-fold': id } })
        : '';
      const content = typeof root.inventoryCollapsible?.content === 'function'
        ? root.inventoryCollapsible.content({ id: `${id}Panel`, open, className: 'memory-fold-panel', children: body })
        : '';
      return `<div class="memory-fold" id="${id}">${trigger}${content}</div>`;
    }

    // A deleted project's rows (deletedProject) restore into another project
    // through "Restore to…"; its chat notes can only be erased.
    function restoreLinkMarkup(memory, busy, deletedProject) {
      if (!deletedProject) {
        return link({ id: `restore-memory-${memory.id}`, label: jt('memory.page.restore', 'Restore'), disabled: busy, dataset: { 'memory-page-action': 'restore', 'memory-id': String(memory.id) } });
      }
      if (memory.scope_session_id) return '';
      return link({ id: `restore-memory-${memory.id}`, label: jt('memory.page.restoreTo', 'Restore to…'), ariaHaspopup: 'menu', ariaExpanded: 'false', disabled: busy, dataset: { 'memory-page-action': 'restore-to', 'memory-id': String(memory.id) } });
    }

    function forgottenMarkup(rows, options) {
      const { open = false, loading = false, busyIds = new Set(), deletedProject = false } = options || {};
      const list = rows.map((memory) => {
        const busy = busyIds.has(memory.id);
        const day = formatDay(memory.archived_at || memory.updated_at);
        return `<article class="memory-record" role="listitem" data-archived-memory-id="${memory.id}">`
          + `<div class="memory-record-main"><p class="memory-text">${escapeHtml(memory.lesson_text)}</p>`
          + `<div class="memory-meta"><span class="memory-kind">${escapeHtml(getKindLabel(memory.lesson_kind))}</span>${day ? `<span class="memory-meta-item">${escapeHtml(jt('memory.page.forgottenOn', 'Forgotten {date}', { date: day }))}</span>` : ''}</div></div>`
          + '<div class="memory-record-side">'
          + restoreLinkMarkup(memory, busy, deletedProject)
          + link({ id: `erase-archived-${memory.id}`, label: jt('memory.page.eraseNow', 'Erase now'), className: 'memory-link--danger', disabled: busy, dataset: { 'memory-page-action': 'erase', 'memory-id': String(memory.id) } })
          + '</div></article>';
      }).join('');
      const note = deletedProject
        ? jt('memory.page.forgottenDeletedNote', 'This project was deleted. Restore a memory into another project, or erase it for good.')
        : jt('memory.page.forgottenNote', 'Jenny won’t save these again on her own. Restore one to use it again, or erase it for good.');
      const body = `<p class="memory-fold-note">${escapeHtml(note)}</p>`
        + (loading ? `<p class="memory-fold-note" role="status">${escapeHtml(jt('memory.page.loading', 'Loading…'))}</p>` : '')
        + (rows.length ? `<div class="memory-record-list" role="list">${list}</div>` : (loading ? '' : `<p class="memory-fold-note">${escapeHtml(jt('memory.page.forgottenEmpty', 'Nothing forgotten here.'))}</p>`))
        + `<p class="memory-fold-note">${escapeHtml(jt('memory.page.clearForgottenNote', 'Clearing the list lets Jenny save these texts again if they come up.'))} `
        + link({ id: 'memoryClearForgotten', label: jt('memory.page.clearForgotten', 'Clear forgotten list'), dataset: { 'memory-page-action': 'clear-forgotten' } }) + '</p>';
      return foldMarkup('memoryForgottenFold', open, jt('memory.page.forgotten', 'Forgotten'), rows.length ? String(rows.length) : '', body);
    }

    function operationText(operation, memory) {
      const text = memory ? `“${memory.lesson_text.slice(0, 120)}”` : '';
      if (!text) return { text: jt('memory.page.historyGone', 'A memory that is no longer here'), gone: true };
      const byUser = operation.origin === 'user';
      const op = String(operation.op || '');
      if (op === 'forget' || op === 'archive') return { text: byUser ? jt('memory.page.historyForgotYou', 'You forgot {text}', { text }) : jt('memory.page.historyForgotJenny', 'Jenny forgot {text}', { text }) };
      if (op === 'update') return { text: byUser ? jt('memory.page.historyEditedYou', 'You edited {text}', { text }) : jt('memory.page.historyEditedJenny', 'Jenny updated {text}', { text }) };
      if (op === 'restore' || op === 'undo') return { text: jt('memory.page.historyRestored', 'Restored {text}', { text }) };
      if (operation.origin === 'reflection') return { text: jt('memory.page.historyNote', 'Jenny took a note: {text}', { text }) };
      return { text: byUser ? jt('memory.page.historySavedYou', 'You saved {text}', { text }) : jt('memory.page.historySavedJenny', 'Jenny saved {text}', { text }) };
    }

    function historyMarkup(operations, memoriesById, options) {
      const { open = false, loading = false, busyIds = new Set() } = options || {};
      const rows = operations.map((operation) => {
        const { text, gone } = operationText(operation, memoriesById.get(Number(operation.memory_id)));
        const when = formatDay(operation.created_at);
        const undo = operation.undoable && !operation.undone_at
          ? link({ id: `undo-op-${escapeHtml(operation.operation_id)}`, label: jt('memory.actions.undo', 'Undo'), disabled: busyIds.has(operation.operation_id), dataset: { 'memory-page-action': 'undo-operation', 'operation-id': operation.operation_id } })
          : '';
        return `<li class="memory-history-row"><span class="memory-history-when">${escapeHtml(when)}</span>`
          + `<span class="${gone ? 'memory-history-gone' : 'memory-history-text'}">${escapeHtml(text)}${operation.undone_at ? ` · ${escapeHtml(jt('memory.page.historyUndone', 'undone'))}` : ''}</span>${undo}</li>`;
      }).join('');
      const body = loading && !operations.length
        ? `<p class="memory-fold-note" role="status">${escapeHtml(jt('memory.page.loading', 'Loading…'))}</p>`
        : operations.length
          ? `<ul class="memory-history" role="list">${rows}</ul>`
          : `<p class="memory-fold-note">${escapeHtml(jt('memory.page.historyEmpty', 'No changes yet.'))}</p>`;
      return foldMarkup('memoryHistoryFold', open, jt('memory.page.history', 'History'), jt('memory.page.historyScope', 'last 50 changes'), body);
    }

    function filesMarkup() {
      return `<p class="settings-group-copy">${escapeHtml(jt('memory.page.filesNote', 'Always-on text you write yourself. Jenny reads these files but never edits them.'))}</p>`
        + '<div class="memory-files">'
        + `<span class="memory-file">${escapeHtml(jt('memory.page.fileUser', 'About you'))} ${link({ id: 'memoryOpenUserFile', label: jt('memory.page.openUserFile', 'Open USER.md'), dataset: { 'memory-page-action': 'open-file', file: 'USER.md' } })}</span>`
        + `<span class="memory-file">${escapeHtml(jt('memory.page.fileNotes', 'Long-term notes'))} ${link({ id: 'memoryOpenNotesFile', label: jt('memory.page.openNotesFile', 'Open MEMORY.md'), dataset: { 'memory-page-action': 'open-file', file: 'MEMORY.md' } })}</span>`
        + '</div>';
    }

    return { tabsMarkup, meterMarkup, recordMarkup, pendingMarkup, forgottenMarkup, historyMarkup, filesMarkup };
  }

  return {
    GENERAL_PROJECT_ID,
    memoryScope,
    buildScopeTabs,
    alwaysOnUsage,
    isDeletedProjectScope,
    createMemoryPageView,
  };
});
