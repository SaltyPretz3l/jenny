/* renderer/features/renderer-open-loop-row.js - one Open Loops board row (UMD)
 *
 * Builds a loop row: title, one quiet meta line (source · session · timing),
 * a two-line-clamped body, and an action bar whose layout never varies —
 * primary first, inline actions next, History and the overflow menu pinned to
 * the trailing edge. Actions arrive pre-placed by the companion service
 * (action.slot); this module only lays them out. Buttons come from the
 * inventory action-button primitive.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererOpenLoopRow = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const stringUtils = windowRef.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null);
  const actionButton = windowRef.inventoryActionButton || (typeof require === 'function' ? require('../inventory/action-button') : null);
  if (!stringUtils || typeof actionButton !== 'function') {
    throw new Error('rendererOpenLoopRow: string-utils and inventory/action-button must load first');
  }
  const { stripInlineMarkdownLabel } = stringUtils;

  /* Without layout (hidden panel, tests) a length heuristic decides whether
   * the "Show more" toggle is worth showing; with layout the clamp decides. */
  const BODY_CLAMP_FALLBACK_CHARS = 180;
  const HISTORY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 8v4l2 2"></path><path d="M3.05 11a9 9 0 1 1 .5 4M3 4v4h4"></path></svg>';
  const MORE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg>';

  function parseIsoDate(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return null;
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.valueOf()) ? null : parsed;
  }

  function formatLoopDate(parsed) {
    return parsed.toLocaleDateString(globalThis.jennyI18n?.tag?.(), { month: 'short', day: 'numeric' });
  }

  function formatLoopTime(parsed) {
    return parsed.toLocaleTimeString(globalThis.jennyI18n?.tag?.(), { hour: 'numeric', ...globalThis.jennyI18n?.timeOptions?.(), minute: '2-digit' });
  }

  function formatDeferredUntil(parsed) {
    return jt('companion.followUps.deferredUntil', 'Deferred until {date}, {time}', {
      date: formatLoopDate(parsed),
      time: formatLoopTime(parsed),
    });
  }

  /* Timing text follows the UI locale, built from the ISO fields. A known
   * status with a missing or invalid timestamp still says its status, just
   * without a date. */
  function formatLoopTiming(loop) {
    if (loop.isDue) {
      return jt('companion.openLoops.timing.dueNow', 'Due now');
    }
    switch (loop.status) {
      case 'deferred': {
        const at = parseIsoDate(loop.deferredUntil);
        return at ? formatDeferredUntil(at) : jt('companion.openLoops.timing.deferredUndated', 'Deferred');
      }
      case 'resolved': {
        const at = parseIsoDate(loop.resolvedAt);
        return at
          ? jt('companion.openLoops.timing.completed', 'Completed {date}', { date: formatLoopDate(at) })
          : jt('companion.openLoops.timing.completedUndated', 'Completed');
      }
      case 'archived': {
        const at = parseIsoDate(loop.archivedAt);
        return at
          ? jt('companion.openLoops.timing.archived', 'Archived {date}', { date: formatLoopDate(at) })
          : jt('companion.openLoops.timing.archivedUndated', 'Archived');
      }
      default:
        return '';
    }
  }

  function formatHistoryTimestamp(parsed) {
    return parsed.toLocaleString(globalThis.jennyI18n?.tag?.(), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      ...globalThis.jennyI18n?.timeOptions?.(),
      minute: '2-digit',
    });
  }

  function sourceBadgeLabel(loop) {
    switch (loop.sourceKind) {
      case 'agent_task': return jt('companion.openLoops.source.agentTask', 'Agent task');
      case 'assistant_reply': return jt('companion.openLoops.source.assistantReply', 'Assistant reply');
      case 'proactive_suggestion': return jt('companion.openLoops.source.proactiveSuggestion', 'Proactive suggestion');
      case 'reminder': return jt('companion.openLoops.source.reminder', 'Reminder');
      case 'manual': return jt('companion.openLoops.source.manual', 'Manual');
      default: return String(loop.sourceBadge || '');
    }
  }

  function sessionBadgeLabel(loop) {
    switch (loop.sessionState) {
      case 'current': return jt('companion.openLoops.session.current', 'Current session');
      case 'open': return jt('companion.openLoops.session.open', 'Open session');
      case 'saved': return jt('companion.openLoops.session.saved', 'Saved from session');
      case 'missing': return '';
      default: return String(loop.sessionBadge || '');
    }
  }

  /* The service names each label by key; unknown keys keep its English. */
  function openLoopActionLabel(action) {
    switch (action?.labelKey) {
      case 'companion.actions.resumeThread': return jt('companion.actions.resumeThread', 'Resume thread');
      case 'companion.actions.startSession': return jt('companion.actions.startSession', 'Start a session');
      case 'companion.actions.startNewSession': return jt('companion.actions.startNewSession', 'Start a new session');
      case 'companion.actions.done': return jt('companion.actions.done', 'Done');
      case 'companion.actions.later': return jt('companion.actions.later', 'Later');
      case 'companion.actions.makeActive': return jt('companion.actions.makeActive', 'Make active');
      case 'companion.actions.reopen': return jt('companion.actions.reopen', 'Reopen');
      case 'companion.actions.restore': return jt('companion.actions.restore', 'Restore');
      case 'companion.actions.archive': return jt('companion.actions.archive', 'Archive');
      case 'companion.actions.edit': return jt('companion.actions.edit', 'Edit');
      case 'companion.actions.delete': return jt('companion.actions.delete', 'Delete');
      default: return String(action?.label || '');
    }
  }

  /* Loop titles/bodies are captured from raw message text, and loops saved
   * before capture-time cleanup persist markdown markers — so display
   * cleanup has to happen here at render time, via the shared conservative
   * flattener that leaves identifiers like __init__.py intact.
   *
   * Save-from-message loops derive the title by clipping the body, so the
   * body line is pure repetition unless it extends past the title. */
  function isBodyRedundantWithTitle(title, body) {
    const strippedTitle = stripInlineMarkdownLabel(title).replace(/\.\.\.$/, '').trim();
    const strippedBody = stripInlineMarkdownLabel(body).trim();
    if (!strippedTitle || !strippedBody) {
      return false;
    }
    return strippedBody === strippedTitle;
  }

  /* Collision-free: every character outside [A-Za-z0-9-] becomes _<hex>_,
   * so ids like "a:b" and "a-b" keep distinct aria-controls targets. */
  function toDomIdPart(value) {
    return String(value || '').replace(/[^A-Za-z0-9-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}_`);
  }

  function cssAttrValue(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function loopRowSelector(followUpId) {
    return `.home-summary-item[data-follow-up-id="${cssAttrValue(followUpId)}"]`;
  }

  function createOpenLoopRowRenderer({
    documentRef,
    isHistoryExpanded = () => false,
    isBodyExpanded = () => false,
  } = {}) {
    function createText(className, value) {
      const node = documentRef.createElement('div');
      node.className = className;
      node.textContent = value;
      return node;
    }

    function createMetaPart(value) {
      const node = documentRef.createElement('span');
      node.textContent = value;
      return node;
    }

    /* The session title is context, not content, so it rides the tooltip
     * instead of repeating on every row. */
    function renderLoopMeta(loop) {
      const meta = documentRef.createElement('div');
      meta.className = 'home-loop-meta';
      if (loop.contextLine) {
        meta.title = loop.contextLine;
      }
      for (const badge of [sourceBadgeLabel(loop), sessionBadgeLabel(loop)]) {
        if (badge) {
          const node = createMetaPart(badge);
          node.className = 'home-loop-badge';
          meta.append(node);
        }
      }
      const timing = formatLoopTiming(loop);
      if (timing) {
        const node = createMetaPart(timing);
        if (loop.isDue) {
          node.className = 'home-loop-meta__due';
        }
        meta.append(node);
      }
      return meta.childElementCount ? meta : null;
    }

    function renderLoopBody(item, loop, domId) {
      if (!loop.body || isBodyRedundantWithTitle(loop.title, loop.body)) {
        return;
      }
      const text = stripInlineMarkdownLabel(loop.body);
      const expanded = Boolean(loop.followUpId) && isBodyExpanded(loop.followUpId);
      const body = createText('home-card-note', text);
      body.classList.add('home-loop-body');
      body.id = `${domId}-body`;
      if (expanded) {
        body.dataset.expanded = 'true';
      }
      item.append(body);
      if (!loop.followUpId) {
        return;
      }
      item.insertAdjacentHTML('beforeend', actionButton({
        plain: true,
        className: 'home-loop-text-toggle',
        label: expanded ? jt('companion.openLoops.showLess', 'Show less') : jt('companion.openLoops.showMore', 'Show more'),
        ariaExpanded: expanded,
        ariaControls: body.id,
        dataset: { 'loop-body-toggle': loop.followUpId },
      }));
      item.lastElementChild.hidden = !expanded && text.length <= BODY_CLAMP_FALLBACK_CHARS;
    }

    function renderLoopActionBar(loop, historyListId) {
      const actions = Array.isArray(loop.actions) ? loop.actions : [];
      const historyCount = Array.isArray(loop.history) ? loop.history.length : 0;
      const hasOverflow = actions.some((action) => action.slot === 'overflow');
      const parts = [];
      for (const slot of ['primary', 'inline']) {
        for (const action of actions.filter((entry) => entry.slot === slot)) {
          const label = openLoopActionLabel(action);
          parts.push(actionButton({
            variant: slot === 'primary' ? 'primary' : 'secondary',
            size: 'sm',
            label,
            /* The session title is only a hover tooltip on the meta line;
             * Resume carries it too, so keyboard focus shows it and screen
             * readers announce it as the button's description. */
            title: action.type === 'continue_session' && loop.contextLine
              ? jt('companion.openLoops.resumeInSession', '{action}: {session}', { action: label, session: loop.contextLine })
              : undefined,
            dataset: { 'companion-action-id': action.id },
          }));
        }
      }
      const trailing = [];
      if (historyCount && loop.followUpId) {
        const label = jt('companion.openLoops.historyCount', 'History ({count})', { count: historyCount });
        trailing.push(actionButton({
          variant: 'ghost',
          size: 'sm',
          className: 'home-loop-icon-btn',
          ariaLabel: label,
          title: label,
          ariaExpanded: isHistoryExpanded(loop.followUpId),
          ariaControls: historyListId,
          dataset: { 'loop-history-toggle': loop.followUpId },
          trustedHtml: `${HISTORY_ICON}<span class="home-loop-icon-btn__count" aria-hidden="true">${historyCount}</span>`,
        }));
      }
      if (hasOverflow && loop.followUpId) {
        const label = jt('companion.openLoops.moreActionsFor', 'More actions for {title}', { title: stripInlineMarkdownLabel(loop.title) });
        trailing.push(actionButton({
          variant: 'ghost',
          size: 'sm',
          className: 'home-loop-icon-btn',
          ariaLabel: label,
          title: label,
          ariaHaspopup: 'menu',
          ariaExpanded: false,
          dataset: { 'loop-overflow': loop.followUpId },
          trustedHtml: MORE_ICON,
        }));
      }
      if (!parts.length && !trailing.length) {
        return null;
      }
      const bar = documentRef.createElement('div');
      bar.className = 'home-loop-actions';
      /* One trailing group, pushed to the end edge, so History and the menu
       * stay together and flush right even when the row wraps. */
      const trailingGroup = trailing.length
        ? `<span class="home-loop-actions__trailing">${trailing.join('')}</span>`
        : '';
      bar.insertAdjacentHTML('beforeend', parts.join('') + trailingGroup);
      return bar;
    }

    function renderLoopHistory(loop, historyListId) {
      const entries = Array.isArray(loop.history) ? loop.history : [];
      if (!entries.length || !loop.followUpId) {
        return null;
      }
      const list = documentRef.createElement('ul');
      list.className = 'home-loop-history-list';
      list.id = historyListId;
      list.hidden = !isHistoryExpanded(loop.followUpId);
      entries.forEach((entry) => {
        const row = documentRef.createElement('li');
        row.className = 'home-loop-history-item';
        const when = parseIsoDate(entry.at);
        const label = when ? formatHistoryTimestamp(when) : entry.at;
        row.append(createText('home-summary-label', `${entry.kind} / ${label}`));
        if (entry.detail) {
          row.append(createText('home-summary-meta', entry.detail));
        }
        list.append(row);
      });
      return list;
    }

    function createLoopSummaryItem(loop, sectionKey) {
      const item = documentRef.createElement('article');
      item.className = 'home-summary-item';
      item.setAttribute('role', 'listitem');
      if (loop.followUpId) {
        item.dataset.followUpId = String(loop.followUpId);
      }
      item.dataset.loopStatus = loop.status;
      const domId = `home-loop-${toDomIdPart(sectionKey)}-${toDomIdPart(loop.followUpId || loop.id)}`;
      const historyListId = `${domId}-history`;
      item.append(createText('home-summary-value', stripInlineMarkdownLabel(loop.title)));
      const meta = renderLoopMeta(loop);
      if (meta) {
        item.append(meta);
      }
      renderLoopBody(item, loop, domId);
      const actionBar = renderLoopActionBar(loop, historyListId);
      if (actionBar) {
        item.append(actionBar);
      }
      const history = renderLoopHistory(loop, historyListId);
      if (history) {
        item.append(history);
      }
      return item;
    }

    /* With layout available, show "Show more" only when the clamp actually
     * cut text; otherwise the build-time length heuristic stands. All reads
     * happen before any write, so one pass costs one layout. */
    function syncBodyToggles(container) {
      if (!container || typeof container.querySelectorAll !== 'function') {
        return;
      }
      const measured = [];
      for (const body of container.querySelectorAll('.home-loop-body:not([data-expanded])')) {
        const toggle = body.nextElementSibling;
        if (!toggle || !toggle.matches?.('[data-loop-body-toggle]') || !body.clientHeight) {
          continue;
        }
        measured.push([toggle, body.scrollHeight <= body.clientHeight + 1]);
      }
      for (const [toggle, fits] of measured) {
        toggle.hidden = fits;
      }
    }

    return { createLoopSummaryItem, syncBodyToggles };
  }

  return {
    createOpenLoopRowRenderer,
    cssAttrValue,
    formatDeferredUntil,
    formatLoopTiming,
    loopRowSelector,
    openLoopActionLabel,
    parseIsoDate,
  };
});
