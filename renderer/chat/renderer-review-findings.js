/* renderer/chat/renderer-review-findings.js
 * Inline code-review findings (row 64). The `report_findings` tool returns its findings as JSON in
 * the persisted output text; this module parses that, builds the chat block (one list, a row per
 * finding that opens on click) and the diff comment the Changes > Working tree page shows under a
 * line, and owns one document delegate for the block's actions:
 *   - toggle: open or close a finding (kept across re-renders for the renderer session);
 *   - Fix / Fix all: send a normal message naming the findings (rendererSuggestedChangesHost);
 *   - Show in diff: open Changes > Working tree with the findings (rendererChatWorkspaceDetail).
 * Every model-provided string is escaped here; paths open through the shared chat path chip.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'), require('../inventory/action-button'));
    return;
  }
  root.rendererReviewFindings = factory(root.stringUtils || {}, root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, inventoryActionButton) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const escapeDefault = stringUtils.escapeHtml;

  const SEVERITIES = Object.freeze(['high', 'medium', 'low']);
  const DOT_CLASS = Object.freeze({ high: 'status-dot--error', medium: 'status-dot--warn', low: 'status-dot--muted' });
  const MAX_FINDINGS = 30;
  const MAX_EXCERPT_LINES = 5;
  const MAX_REMEMBERED = 500;
  const CHEVRON = '<svg class="review-finding-chevron icon-mirror-rtl" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

  // Renderer-session memory of opened and sent findings, keyed session|call|index.
  const openKeys = new Set();
  const closedKeys = new Set();
  const sentKeys = new Set();

  function remember(set, key) {
    set.add(key);
    if (set.size > MAX_REMEMBERED) set.delete(set.values().next().value);
  }

  function findingKey(sessionId, toolCallId, index) {
    return `${String(sessionId || '')}|${String(toolCallId || '')}|${Number(index) || 0}`;
  }

  function severityLabel(severity) {
    if (severity === 'high') return jt('chat.reviewFindings.severityHigh', 'High');
    if (severity === 'low') return jt('chat.reviewFindings.severityLow', 'Low');
    return jt('chat.reviewFindings.severityMedium', 'Medium');
  }

  function toLine(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
  }

  function text(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  }

  function normalizeFinding(raw, position) {
    if (!raw || typeof raw !== 'object') return null;
    const title = text(raw.title, 200);
    if (!title) return null;
    const severity = SEVERITIES.includes(raw.severity) ? raw.severity : 'medium';
    const file = text(raw.file, 512).replace(/\\/g, '/');
    const line = file ? toLine(raw.line) : 0;
    const endLine = line ? Math.max(line, toLine(raw.end_line)) : 0;
    const excerpt = raw.excerpt && typeof raw.excerpt === 'object' && Array.isArray(raw.excerpt.lines) && toLine(raw.excerpt.start)
      ? { start: toLine(raw.excerpt.start), lines: raw.excerpt.lines.slice(0, MAX_EXCERPT_LINES).map((item) => String(item == null ? '' : item).slice(0, 240)) }
      : null;
    return { index: toLine(raw.index) || position + 1, severity, title, body: text(raw.body, 2400), file, line, endLine, excerpt };
  }

  /** Parses the tool's output text; null for anything that is not a review_findings payload. */
  function parseReviewFindings(outputText) {
    let payload = outputText;
    if (typeof outputText === 'string') {
      const trimmed = outputText.trim();
      if (!trimmed.startsWith('{')) return null;
      try { payload = JSON.parse(trimmed); } catch (_error) { return null; }
    }
    if (!payload || typeof payload !== 'object' || payload.kind !== 'review_findings') return null;
    const findings = (Array.isArray(payload.findings) ? payload.findings : [])
      .slice(0, MAX_FINDINGS).map(normalizeFinding).filter(Boolean);
    if (!findings.length) return null;
    return { scope: text(payload.scope, 160), summary: text(payload.summary, 800), findings };
  }

  function countsText(findings) {
    return SEVERITIES
      .map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length])
      .filter(([, count]) => count > 0)
      .map(([severity, count]) => `${count} ${severityLabel(severity).toLowerCase()}`)
      .join(' · ');
  }

  function locationLabel(finding) {
    if (!finding.file) return '';
    const base = finding.file.slice(finding.file.lastIndexOf('/') + 1) || finding.file;
    return finding.line ? `${base}:${finding.line}` : base;
  }

  function locationChip(finding, escape) {
    if (!finding.file) return '';
    const title = finding.line
      ? jt('chat.reviewFindings.openAtLine', 'Open {path} at line {line}', { path: finding.file, line: finding.line })
      : jt('chat.reviewFindings.openFile', 'Open {path}', { path: finding.file });
    const lineAttr = finding.line ? ` data-chat-path-line="${finding.line}"` : '';
    return `<span class="review-finding-loc" role="link" tabindex="0" data-chat-path-open="${escape(finding.file)}"${lineAttr} title="${escape(title)}" aria-label="${escape(title)}">${escape(locationLabel(finding))}</span>`;
  }

  function excerptMarkup(finding, escape) {
    if (!finding.excerpt || !finding.excerpt.lines.length) return '';
    const rows = finding.excerpt.lines.map((line, offset) => {
      const number = finding.excerpt.start + offset;
      const hit = number >= finding.line && number <= finding.endLine;
      return `<div class="review-finding-excerpt-line${hit ? ' is-target' : ''}"><span class="review-finding-excerpt-number">${number}</span><code>${escape(line)}</code></div>`;
    }).join('');
    return `<div class="review-finding-excerpt" data-severity="${finding.severity}" dir="ltr">${rows}</div>`;
  }

  function button(actionButton, options) {
    return typeof actionButton === 'function' ? actionButton(options) : '';
  }

  function actionsMarkup(finding, context, inDiff) {
    const { escape, actionButton, sessionId, toolCallId } = context;
    if (sentKeys.has(findingKey(sessionId, toolCallId, finding.index))) {
      return `<span class="review-finding-sent">${escape(jt('chat.reviewFindings.sent', 'Sent to Jenny'))}</span>`;
    }
    const dataset = { 'review-finding-index': String(finding.index) };
    const fix = button(actionButton, {
      size: 'sm', label: jt('chat.reviewFindings.fix', 'Fix'),
      title: jt('chat.reviewFindings.fixTitle', 'Ask Jenny to fix this finding'),
      dataset: { ...dataset, 'review-finding-action': 'fix' },
    });
    // Show in diff needs a line to put the comment on.
    const showDiff = inDiff || !finding.file || !(finding.line > 0) ? '' : button(actionButton, {
      variant: 'ghost', size: 'sm', label: jt('chat.reviewFindings.showInDiff', 'Show in diff'),
      title: jt('chat.reviewFindings.showInDiffTitle', 'Open Changes with this finding on its line'),
      dataset: { ...dataset, 'review-finding-action': 'show-diff' },
    });
    return fix + showDiff;
  }

  function isOpen(key, position) {
    if (openKeys.has(key)) return true;
    if (closedKeys.has(key)) return false;
    return position === 0;
  }

  function findingMarkup(finding, position, context) {
    const { escape, actionButton, sessionId, toolCallId, domToken } = context;
    const key = findingKey(sessionId, toolCallId, finding.index);
    const open = isOpen(key, position);
    const bodyId = `review-finding-${escape(domToken)}-${finding.index}`;
    const sent = sentKeys.has(key);
    const bodyText = finding.body ? `<p class="review-finding-text" dir="auto">${escape(finding.body)}</p>` : '';
    return `<li class="review-finding" data-review-finding data-finding-index="${finding.index}" data-severity="${finding.severity}"`
      + ` data-file="${escape(finding.file)}" data-line="${finding.line}" data-end-line="${finding.endLine}" data-open="${open}" data-sent="${sent}">`
      + '<div class="review-finding-row">'
      + button(actionButton, {
        plain: true, className: 'review-finding-toggle', ariaExpanded: open, ariaControls: bodyId,
        dataset: { 'review-finding-action': 'toggle' },
        trustedHtml: `<span class="status-dot ${DOT_CLASS[finding.severity]}" aria-hidden="true"></span>`
          + `<span class="review-finding-severity">${escape(severityLabel(finding.severity))}</span>`
          + `<span class="review-finding-title" dir="auto">${escape(finding.title)}</span>${CHEVRON}`,
      })
      + locationChip(finding, escape)
      + '</div>'
      + `<div class="review-finding-body" id="${bodyId}"${open ? '' : ' hidden'}>${bodyText}${excerptMarkup(finding, escape)}`
      + `<div class="review-finding-actions">${actionsMarkup(finding, context, false)}</div></div></li>`;
  }

  /**
   * The chat block for a settled report_findings result. `parsed` is parseReviewFindings output;
   * returns '' when there is nothing to show.
   */
  function buildReviewFindingsBlockMarkup(parsed, options) {
    if (!parsed || !Array.isArray(parsed.findings) || !parsed.findings.length) return '';
    const settings = options || {};
    const escape = typeof settings.escapeHtml === 'function' ? settings.escapeHtml : escapeDefault;
    const actionButton = typeof settings.actionButton === 'function' ? settings.actionButton : inventoryActionButton;
    const sessionId = String(settings.sessionId || '');
    const toolCallId = String(settings.toolCallId || '');
    const context = { escape, actionButton, sessionId, toolCallId, domToken: String(settings.domToken || toolCallId).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) };
    const findings = parsed.findings;
    const unsent = findings.filter((finding) => !sentKeys.has(findingKey(sessionId, toolCallId, finding.index))).length;
    const count = jtn('chat.reviewFindings.count', findings.length, { count: findings.length }, '{count} finding', '{count} findings');
    const meta = [countsText(findings), parsed.scope].filter(Boolean).join(' · ');
    const fixAll = unsent > 1 ? button(actionButton, {
      size: 'sm', className: 'review-findings-fix-all',
      label: jt('chat.reviewFindings.fixAll', 'Fix all {count}', { count: unsent }),
      title: jt('chat.reviewFindings.fixAllTitle', 'Ask Jenny to fix every finding not sent yet'),
      dataset: { 'review-finding-action': 'fix-all' },
    }) : '';
    return `<section class="review-findings" data-review-findings data-tool-call-id="${escape(toolCallId)}" data-session-id="${escape(sessionId)}" aria-label="${escape(jt('chat.reviewFindings.label', 'Review findings'))}">`
      + `<header class="review-findings-head"><span class="review-findings-count">${escape(count)}</span>`
      + (meta ? `<span class="review-findings-meta">${escape(meta)}</span>` : '') + fixAll + '</header>'
      + `<ol class="review-findings-list">${findings.map((finding, position) => findingMarkup(finding, position, context)).join('')}</ol></section>`;
  }

  /** The comment the Working tree diff shows under a finding's line. */
  function buildDiffCommentMarkup(finding, options) {
    const settings = options || {};
    const escape = typeof settings.escapeHtml === 'function' ? settings.escapeHtml : escapeDefault;
    const actionButton = typeof settings.actionButton === 'function' ? settings.actionButton : inventoryActionButton;
    const context = { escape, actionButton, sessionId: String(settings.sessionId || ''), toolCallId: String(settings.toolCallId || '') };
    const where = settings.unplaced && finding.line
      ? `<span class="review-diff-comment-where">${escape(jt('chat.reviewFindings.outsideDiff', 'Line {line}, outside the changed lines', { line: finding.line }))}</span>` : '';
    return `<div class="review-diff-comment" data-review-findings data-review-finding data-tool-call-id="${escape(context.toolCallId)}" data-session-id="${escape(context.sessionId)}"`
      + ` data-finding-index="${finding.index}" data-severity="${finding.severity}" data-file="${escape(finding.file)}" data-line="${finding.line}"${settings.focus ? ' data-review-focus="true"' : ''}>`
      + `<div class="review-diff-comment-head"><span class="status-dot ${DOT_CLASS[finding.severity]}" aria-hidden="true"></span>`
      + `<span class="review-finding-title" dir="auto">${escape(finding.title)}</span><span class="review-finding-severity">${escape(severityLabel(finding.severity))}</span></div>`
      + where + (finding.body ? `<p class="review-finding-text" dir="auto">${escape(finding.body)}</p>` : '')
      + `<div class="review-finding-actions">${actionsMarkup(finding, context, true)}</div></div>`;
  }

  /* ── Fix messages ── */

  function describe(finding) {
    const where = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : '';
    const body = finding.body ? `\n   ${finding.body.replace(/\s*\n\s*/g, ' ')}` : '';
    return `[${severityLabel(finding.severity)}] ${finding.title}${where}${body}`;
  }

  function buildFixMessage(findings) {
    const list = findings.map((finding, position) => `${position + 1}. ${describe(finding)}`).join('\n');
    return findings.length === 1
      ? jt('chat.reviewFindings.fixOneMessage', 'Fix this finding from your review:\n\n{list}\n\nMake the smallest change that fixes it, then tell me what changed.', { list })
      : jt('chat.reviewFindings.fixManyMessage', 'Fix these {count} findings from your review:\n\n{list}\n\nMake the smallest changes that fix them, then tell me what changed.', { count: findings.length, list });
  }

  /** Reads the findings back from a rendered block (or a diff comment's data). */
  function readFindingsFromBlock(block) {
    if (!block || typeof block.querySelectorAll !== 'function') return [];
    return Array.from(block.querySelectorAll('[data-review-finding]')).map((item, position) => normalizeFinding({
      index: Number(item.getAttribute('data-finding-index')),
      severity: item.getAttribute('data-severity'),
      title: item.querySelector('.review-finding-title')?.textContent || '',
      body: item.querySelector('.review-finding-text')?.textContent || '',
      file: item.getAttribute('data-file') || '',
      line: Number(item.getAttribute('data-line')),
      end_line: Number(item.getAttribute('data-end-line')),
    }, position)).filter(Boolean);
  }

  function createReviewFindingsEntry(deps) {
    const d = deps || {};
    const windowRef = d.windowRef || globalThis.window || globalThis;
    const doc = d.documentRef || windowRef.document || null;
    const getHost = typeof d.getHost === 'function' ? d.getHost : () => windowRef.rendererSuggestedChangesHost || null;
    const getWorkspaceDetail = typeof d.getWorkspaceDetail === 'function' ? d.getWorkspaceDetail : () => windowRef.rendererChatWorkspaceDetail || null;
    const getCurrentSessionId = typeof d.getCurrentSessionId === 'function' ? d.getCurrentSessionId : () => '';
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : () => {};
    const showToastMessage = typeof d.showToastMessage === 'function' ? d.showToastMessage : () => {};
    let bound = false;
    let disposed = false;
    const pending = new Set();

    // A diff comment has no list of its own: its siblings are the chat block's findings.
    function blockFindings(container) {
      const toolCallId = container.getAttribute('data-tool-call-id') || '';
      if (container.matches('section[data-review-findings]')) return readFindingsFromBlock(container);
      const chatBlock = toolCallId && doc
        ? Array.from(doc.querySelectorAll('section[data-review-findings]')).find((el) => el.getAttribute('data-tool-call-id') === toolCallId)
        : null;
      return chatBlock ? readFindingsFromBlock(chatBlock) : readFindingsFromBlock(container.parentElement || container);
    }

    function syncSentMarkup(sessionId, toolCallId) {
      if (!doc) return;
      for (const container of doc.querySelectorAll('[data-review-findings]')) {
        if (container.getAttribute('data-tool-call-id') !== toolCallId || container.getAttribute('data-session-id') !== sessionId) continue;
        const items = container.matches('[data-review-finding]') ? [container] : Array.from(container.querySelectorAll('[data-review-finding]'));
        for (const item of items) {
          const index = Number(item.getAttribute('data-finding-index'));
          if (!sentKeys.has(findingKey(sessionId, toolCallId, index))) continue;
          item.setAttribute('data-sent', 'true');
          const actions = item.querySelector('.review-finding-actions');
          if (actions) actions.innerHTML = `<span class="review-finding-sent">${escapeDefault(jt('chat.reviewFindings.sent', 'Sent to Jenny'))}</span>`;
        }
        const fixAll = container.querySelector?.('[data-review-finding-action="fix-all"]');
        if (fixAll && !container.querySelector('[data-review-finding][data-sent="false"] [data-review-finding-action="fix"]')) fixAll.remove();
      }
    }

    async function sendFix(container, onlyIndex) {
      const sessionId = container.getAttribute('data-session-id') || getCurrentSessionId() || '';
      const toolCallId = container.getAttribute('data-tool-call-id') || '';
      const all = blockFindings(container);
      const targets = all.filter((finding) => (onlyIndex ? finding.index === onlyIndex : true)
        && !sentKeys.has(findingKey(sessionId, toolCallId, finding.index)));
      const host = getHost();
      if (!targets.length || !host || typeof host.startPromptSend !== 'function') return false;
      const sendKey = `${sessionId}|${toolCallId}`;
      if (pending.has(sendKey)) return false;
      pending.add(sendKey);
      try {
        const started = await host.startPromptSend(buildFixMessage(targets), { sessionIdOverride: sessionId, preserveComposerDraft: true });
        if (!started || started.rejected) {
          appendClientLog('INFO', 'review_findings.fix_not_sent', { reason: String(started && started.reason || 'blocked').slice(0, 80) });
          showToastMessage(jt('chat.reviewFindings.fixNotSent', 'The fix request was not sent. Try again when Jenny has finished replying.'));
          return false;
        }
        for (const finding of targets) remember(sentKeys, findingKey(sessionId, toolCallId, finding.index));
        appendClientLog('INFO', 'review_findings.fix_sent', { count: targets.length });
        syncSentMarkup(sessionId, toolCallId);
        return true;
      } finally {
        pending.delete(sendKey);
      }
    }

    function toggle(item, container) {
      const open = item.getAttribute('data-open') !== 'true';
      const key = findingKey(container.getAttribute('data-session-id'), container.getAttribute('data-tool-call-id'), item.getAttribute('data-finding-index'));
      if (open) { remember(openKeys, key); closedKeys.delete(key); } else { remember(closedKeys, key); openKeys.delete(key); }
      item.setAttribute('data-open', String(open));
      item.querySelector('[data-review-finding-action="toggle"]')?.setAttribute('aria-expanded', String(open));
      const body = item.querySelector('.review-finding-body');
      if (body) body.hidden = !open;
    }

    function showInDiff(container, index, opener) {
      const sessionId = container.getAttribute('data-session-id') || getCurrentSessionId() || '';
      const detail = getWorkspaceDetail();
      if (!sessionId || !detail || typeof detail.open !== 'function') return false;
      const opened = detail.open({
        surface: 'changes',
        ownerSessionId: sessionId,
        opener,
        reviewFindings: { sessionId, toolCallId: container.getAttribute('data-tool-call-id') || '', focusIndex: index, findings: blockFindings(container) },
      });
      if (!opened) appendClientLog('WARN', 'review_findings.show_in_diff_failed', {});
      return opened;
    }

    function handleClick(event) {
      if (disposed) return;
      const trigger = event.target?.closest?.('[data-review-finding-action]');
      const container = trigger?.closest?.('[data-review-findings]');
      if (!trigger || !container) return;
      const action = trigger.getAttribute('data-review-finding-action');
      const item = trigger.closest('[data-review-finding]');
      const index = Number(trigger.getAttribute('data-review-finding-index') || item?.getAttribute('data-finding-index')) || 0;
      event.preventDefault();
      if (action === 'toggle' && item) toggle(item, container);
      else if (action === 'fix' && index) sendFix(container, index).catch(() => {});
      else if (action === 'fix-all') sendFix(container, 0).catch(() => {});
      else if (action === 'show-diff') showInDiff(container, index, trigger);
    }

    function bind() {
      if (bound || disposed || !doc) return;
      bound = true;
      doc.addEventListener('click', handleClick);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (bound && doc) doc.removeEventListener('click', handleClick);
      bound = false;
    }

    return { bind, dispose, sendFix, showInDiff, handleClick };
  }

  function resetForTests() {
    openKeys.clear();
    closedKeys.clear();
    sentKeys.clear();
  }

  return {
    parseReviewFindings,
    buildReviewFindingsBlockMarkup,
    buildDiffCommentMarkup,
    buildFixMessage,
    createReviewFindingsEntry,
    resetForTests,
  };
});
