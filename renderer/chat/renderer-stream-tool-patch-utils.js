(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tool-call-utils'), require('./renderer-stream-dom-patch-utils'));
    return;
  }
  root.rendererStreamToolPatchUtils = factory(root.toolCallUtils || {}, root.rendererStreamDomPatchUtils || null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (toolCallUtils, streamDomPatchUtils) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const FALLBACK_LOG_WINDOW_MS = 2000;

  const normalizeId = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).normalizeId;
  const { formatToolDurationMs: formatDurationMs } = toolCallUtils;
  const { escapeSelectorValue } = streamDomPatchUtils;
  // An approved/denied/timed-out/cancelled call retracts its approval_gap row
  // (the Allow/Deny block), which only a structural render can remove.
  const APPROVAL_SETTLING_STATUSES = new Set(['approved', 'denied', 'timed_out', 'cancelled']);
  const APPROVAL_GAP_ROW_SELECTOR = '[data-row-kind="approval_gap"]';

  function removeClassPrefix(node, prefix) {
    if (!node || !node.classList) return;
    Array.from(node.classList).forEach((className) => {
      if (className.startsWith(prefix)) {
        node.classList.remove(className);
      }
    });
  }

  function setTextIfPresent(rootNode, selector, value) {
    const text = String(value || '');
    if (!rootNode || !text || typeof rootNode.querySelectorAll !== 'function') {
      return false;
    }
    const nodes = Array.from(rootNode.querySelectorAll(selector));
    nodes.forEach((node) => {
      if (node.textContent !== text) {
        node.textContent = text;
      }
    });
    return nodes.length > 0;
  }

  function safeQuerySelector(rootNode, selector) {
    if (!rootNode || typeof rootNode.querySelector !== 'function') {
      return null;
    }
    try {
      return rootNode.querySelector(selector);
    } catch (_error) {
      return null;
    }
  }

  function safeQuerySelectorLast(rootNode, selector) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') {
      return null;
    }
    try {
      const nodes = rootNode.querySelectorAll(selector);
      return nodes.length > 0 ? nodes[nodes.length - 1] : null;
    } catch (_error) {
      return null;
    }
  }

  function resolveCallId(payload) {
    return normalizeId(
      payload && (
        payload.callId
        || payload.call_id
        || payload.toolCallId
        || payload.tool_call_id
        || payload.tool_call?.call_id
        || payload.tool_result?.call_id
      )
    );
  }

  function resolvePatchStatus(payload, eventType) {
    const type = normalizeId(eventType || payload?.type);
    if (type === 'tool_approval_needed') {
      return 'awaiting_approval';
    }
    if (type === 'tool_result') {
      // Only the result fields: the merged patch payload can carry an unrelated
      // call status (running/success) that the helper would read as the verdict.
      return toolCallUtils.statusForToolResult({
        approval_state: normalizeId(payload?.approvalState || payload?.approval_state).toLowerCase(),
        is_error: payload?.isError === true || payload?.is_error === true,
        error_code: normalizeId(payload?.errorCode || payload?.error_code),
        metadata: payload?.metadata || payload?.tool_result?.metadata,
      });
    }
    const rawStatus = normalizeId(payload?.status || payload?.tool_call?.status || 'running').toLowerCase();
    if (rawStatus === 'pending_approval') return 'awaiting_approval';
    if (rawStatus === 'error') return 'errored';
    if (rawStatus === 'timeout') return 'timed_out';
    if (rawStatus === 'preempted') return 'cancelled';
    return rawStatus || 'running';
  }

  // Canonical labels and tones live in tool-call-utils (always present via
  // document load order / CommonJS require).
  function getStatusLabel(status) {
    return toolCallUtils.getStatusLabel(status);
  }

  function getStatusTone(status) {
    return toolCallUtils.statusToneFor(status, status === 'running');
  }

  function resolveToolName(payload) {
    return normalizeId(payload?.toolName || payload?.tool_name || payload?.tool_call?.tool_name || payload?.tool_result?.tool_name);
  }

  function resolveSummary(payload) {
    return String(
      payload?.summary
      || payload?.resultSummary
      || payload?.result_summary
      || payload?.tool_call?.summary
      || payload?.tool_result?.summary
      || ''
    ).trim();
  }

  function resolveOutputText(payload) {
    return String(
      payload?.content
      || payload?.outputText
      || payload?.output_text
      || payload?.tool_result?.output_text
      || ''
    );
  }

  function mergePatchEntry(previous, next) {
    const prevPayload = previous?.payload && typeof previous.payload === 'object' ? previous.payload : {};
    const nextPayload = next?.payload && typeof next.payload === 'object' ? next.payload : {};
    const toolName = resolveToolName(nextPayload) || resolveToolName(prevPayload);
    const summary = resolveSummary(nextPayload) || resolveSummary(prevPayload);
    const content = resolveOutputText(nextPayload) || resolveOutputText(prevPayload);
    return {
      ...previous,
      ...next,
      payload: {
        ...prevPayload,
        ...nextPayload,
        toolName,
        tool_name: toolName,
        summary,
        content,
      },
    };
  }

  function findTargets(chatTimeline, callId, options = {}) {
    const normalizedCallId = normalizeId(callId);
    if (!chatTimeline || !normalizedCallId || typeof chatTimeline.querySelector !== 'function') {
      return null;
    }
    const escapedCallId = escapeSelectorValue(normalizedCallId);
    // The call's approval_gap row carries the same data-tool-call-id and sits
    // after the call row: it is never the patch target (the call row is).
    let row = safeQuerySelectorLast(
      chatTimeline,
      `.chat-row[data-tool-call-id="${escapedCallId}"]:not(${APPROVAL_GAP_ROW_SELECTOR})`
    );
    const scope = row || chatTimeline;
    const block = safeQuerySelectorLast(scope, `.tool-call-block[data-call-id="${escapedCallId}"]`)
      || (row ? safeQuerySelector(row, '.tool-call-block') : null);
    const toolCallRow = safeQuerySelectorLast(scope, `.tool-call-row[data-tool-call-id="${escapedCallId}"]`)
      || (row ? safeQuerySelector(row, '.tool-call-row') : null);
    const toolResultRow = safeQuerySelectorLast(scope, `.tool-result-row[data-tool-call-id="${escapedCallId}"]`)
      || (row ? safeQuerySelector(row, '.tool-result-row') : null);
    if (!row && block) {
      row = block.closest?.('.chat-row') || null;
    }
    const root = block || toolCallRow || toolResultRow || row;
    if (root) {
      return { root, row, block, toolCallRow, toolResultRow };
    }
    const timelineVirtualizer = options.timelineVirtualizer || null;
    if (
      !options.skipVirtualizedMount
      && timelineVirtualizer
      && typeof timelineVirtualizer.ensureMountedForToolCallId === 'function'
    ) {
      try {
        if (timelineVirtualizer.ensureMountedForToolCallId(normalizedCallId)) {
          return findTargets(chatTimeline, normalizedCallId, {
            ...options,
            skipVirtualizedMount: true,
          });
        }
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  // An approval verdict on a call still awaiting it, or any event for a call
  // that still shows an unresolved approval_gap row, must reach a structural
  // render: a field patch would settle the call row and leave the Allow/Deny
  // block behind. A timeout or stop of a running call still patches in place.
  function needsApprovalGapRender(chatTimeline, callId, payload, eventType, targets) {
    const status = resolvePatchStatus(payload, eventType);
    const currentStatus = (targets.toolCallRow || targets.block)?.getAttribute?.('data-tool-status') || '';
    if (status === 'approved'
      || (APPROVAL_SETTLING_STATUSES.has(status) && currentStatus === 'awaiting_approval')) {
      return true;
    }
    return Boolean(safeQuerySelector(
      chatTimeline,
      `.chat-row${APPROVAL_GAP_ROW_SELECTOR}[data-tool-call-id="${escapeSelectorValue(callId)}"]:not([data-row-state="resolved"])`
    ));
  }

  function isNodeAttachedToTimeline(chatTimeline, node) {
    if (!node) return true;
    if (node.isConnected === false) return false;
    if (chatTimeline && typeof chatTimeline.contains === 'function' && node !== chatTimeline) {
      try {
        return chatTimeline.contains(node) === true;
      } catch (_error) {
        return node.isConnected !== false;
      }
    }
    return true;
  }

  function areTargetsAttachedToTimeline(chatTimeline, targets) {
    if (!targets) return false;
    return [targets.root, targets.row, targets.block, targets.toolCallRow, targets.toolResultRow]
      .every((node) => isNodeAttachedToTimeline(chatTimeline, node));
  }

  function updateBusyAttribute(node, status) {
    if (!node || typeof node.setAttribute !== 'function') return;
    if (status === 'running') {
      node.setAttribute('aria-busy', 'true');
    } else {
      node.removeAttribute('aria-busy');
    }
  }

  /* UIUX-029 ("tool activity" is currently visual-only): terminal outcomes get exactly one
     announcement through the shared live-announcer channel (renderer/shared/renderer-live-announcer.js).
     Intermediate statuses (requested/running/approved/executing) stay silent -- announcing every
     lifecycle hop would spam a multi-tool turn. awaiting_approval is deliberately excluded too: it
     already gets its own role="status" region from renderApprovalBlock
     (renderer/chat/renderer-approval-block.js), and duplicating it here is exactly the
     "conflicting and nested announcements" UIUX-029 flags. */
  const TERMINAL_ANNOUNCE_SPECS = {
    completed: { politeness: 'polite', phrase: (name) => jt('chat.toolCall.finishedAnnouncement', '{tool} finished', { tool: name }) },
    errored: { politeness: 'assertive', phrase: (name) => jt('chat.toolCall.failedAnnouncement', '{tool} failed', { tool: name }) },
    denied: { politeness: 'assertive', phrase: (name) => jt('chat.toolCall.deniedAnnouncement', '{tool} was denied', { tool: name }) },
    timed_out: { politeness: 'assertive', phrase: (name) => jt('chat.toolCall.timedOutAnnouncement', '{tool} timed out', { tool: name }) },
    cancelled: { politeness: 'polite', phrase: (name) => `${name}: ${getStatusLabel('cancelled')}` },
    blocked: { politeness: 'assertive', phrase: (name) => `${name}: ${getStatusLabel('blocked')}` },
    interrupted: { politeness: 'assertive', phrase: (name) => `${name}: ${getStatusLabel('interrupted')}` },
  };

  function announceTerminalStatusChange(announcer, callId, previousStatus, nextStatus, toolName) {
    if (!announcer || typeof announcer.announce !== 'function') return;
    if (previousStatus === nextStatus) return; // no real transition -- redundant/replayed patch
    const spec = TERMINAL_ANNOUNCE_SPECS[nextStatus];
    if (!spec) return;
    const label = toolName || 'Tool';
    announcer.announce(spec.phrase(label), {
      politeness: spec.politeness,
      key: `tool-status:${callId || label}`,
    });
  }

  /* Detach a settled row's live elapsed node from the transcript clock: once
     data-turn-elapsed is gone the clock's scan no longer matches it,
     so the settled duration text can't be overwritten by a later tick. */
  function settleLiveElapsedNodes(targets, status) {
    if (status === 'running' || status === 'executing') return;
    const nodes = targets.root?.querySelectorAll?.('.tool-result-duration[data-turn-elapsed]');
    if (!nodes) return;
    for (const node of nodes) {
      node.removeAttribute('data-turn-elapsed');
      node.removeAttribute('data-elapsed-started-at');
      node.setAttribute('data-elapsed-running', 'false');
    }
  }

  function patchFileOperationPresentation(targets, status) {
    const node = targets.block || targets.toolCallRow;
    if (!node?.classList?.contains('tool-call-file-operation')) return;
    const composing = status === 'running' || status === 'executing';
    const settled = typeof toolCallUtils.isFileOperationSettledStatus === 'function'
      && toolCallUtils.isFileOperationSettledStatus(status);
    node.classList.toggle('tool-call-file-composing', composing);
    node.classList.toggle('tool-call-file-settled', !composing && settled);
  }

  function patchStatus(targets, status, announceCtx, resultPayload) {
    const previousStatus = (targets.toolCallRow || targets.block)?.getAttribute?.('data-tool-status') || '';
    [targets.row, targets.block, targets.toolCallRow].filter(Boolean).forEach((node) => {
      if (node === targets.row) {
        node.setAttribute('data-row-state', status);
      }
      if (node === targets.block || node === targets.toolCallRow) {
        node.setAttribute('data-tool-status', status);
      }
      updateBusyAttribute(node, status);
    });
    patchFileOperationPresentation(targets, status);
    if (targets.toolResultRow) {
      targets.toolResultRow.setAttribute('data-is-error', status === 'errored' ? 'true' : 'false');
    }
    // A command that exited non-zero reads "exit N" here too (HB-035).
    const statusLabel = resultPayload && typeof toolCallUtils.getResultStatusLabel === 'function'
      ? toolCallUtils.getResultStatusLabel(status, {
        exit_code: resultPayload.exit_code ?? resultPayload.tool_result?.exit_code,
        metadata: resultPayload.metadata || resultPayload.tool_result?.metadata,
      })
      : getStatusLabel(status);
    const tone = getStatusTone(status);
    setTextIfPresent(targets.root, '.tool-call-status-label', statusLabel);
    setTextIfPresent(targets.root, '.tool-call-status-badge', statusLabel);
    // Quiet grammar: the settled-success word is a11y-only (the leading dot
    // carries the signal); every other state keeps its visible word. Keep the
    // patched class in sync with what a fresh render would emit.
    Array.from(targets.root.querySelectorAll?.('.tool-call-status-label, .tool-call-status-badge') || []).forEach((node) => {
      node.classList.toggle('sr-only', status === 'completed');
    });
    Array.from(targets.root.querySelectorAll?.('.tool-call-status') || []).forEach((node) => {
      removeClassPrefix(node, 'tool-call-status-');
      node.classList.add(`tool-call-status-${status}`);
    });
    Array.from(targets.root.querySelectorAll?.('.status-dot') || []).forEach((node) => {
      removeClassPrefix(node, 'status-dot--');
      node.classList.add(`status-dot--${tone}`);
    });
    settleLiveElapsedNodes(targets, status);
    if (announceCtx) {
      announceTerminalStatusChange(announceCtx.announcer, announceCtx.callId, previousStatus, status, announceCtx.toolName);
    }
  }

  function patchOutputText(targets, outputText) {
    if (!outputText) return false;
    const detailRoot = targets.block?.querySelector?.('.tool-call-details')
      || targets.root;
    const outputNode = detailRoot?.querySelector?.('.tool-call-output, .tool-call-output-text');
    if (outputNode) {
      if (outputNode.textContent !== outputText) {
        outputNode.textContent = outputText;
      }
      return true;
    }
    if (!detailRoot?.ownerDocument) {
      return false;
    }
    // Minimal rows own deferred output through the keyed detail renderer.
    // Block rows retain the legacy raw-pre patch until their next full render.
    if (typeof detailRoot.closest === 'function'
      && detailRoot.closest('.tool-call-row--minimal')) {
      return false;
    }
    if (detailRoot.querySelector?.('.tool-call-row--minimal')
      || detailRoot.querySelector?.('.tool-detail-body')) {
      return false;
    }
    const pre = detailRoot.ownerDocument.createElement('pre');
    pre.className = 'tool-call-output';
    pre.textContent = outputText;
    detailRoot.appendChild(pre);
    return true;
  }

  // Answers tool run (renderer-turn-row-list-utils): a status patch on a
  // member row re-derives its run's summary from the members' patched DOM
  // state, through the same summarizeToolRun a full render uses, so the live
  // label and done count never wait for the next structural render.
  // A step that turned running through a patch has no elapsed anchor: the run
  // remembers when it first saw it running, keyed by the member node, which
  // the keyed morph reuses (an attribute stamp would be dropped by it).
  const toolRunRunningSince = new WeakMap();
  function refreshToolRunSummary(memberRow, durationMs) {
    const runId = memberRow?.getAttribute?.('data-run-id');
    const list = runId ? memberRow.closest?.('.turn-row-list') : null;
    if (!list || typeof toolCallUtils.summarizeToolRun !== 'function') return;
    if (Number(durationMs) > 0) memberRow.setAttribute('data-run-duration-ms', String(Number(durationMs)));
    const rows = toolCallUtils.getToolRunRows(list, runId);
    const summaryRow = rows.find((node) => node.getAttribute('data-row-kind') === 'tool_run');
    const toggle = summaryRow?.querySelector?.('[data-tool-run-toggle]');
    if (!toggle) return;
    const members = rows.filter((node) => node.getAttribute('data-run-member') === 'step').map((node) => {
      // The same tool-row attributes the row-list builder reads from markup.
      const toolRow = node.querySelector('[data-tool-status]');
      const status = toolRow?.getAttribute('data-tool-status') || node.getAttribute('data-row-state') || '';
      let startedAtMs = Number(node.querySelector('[data-elapsed-started-at]')?.getAttribute('data-elapsed-started-at'))
        || toolRunRunningSince.get(node) || 0;
      if (!startedAtMs && (status === 'running' || status === 'executing')) {
        startedAtMs = Date.now();
        toolRunRunningSince.set(node, startedAtMs);
      }
      return {
        ...toolCallUtils.readToolRunMemberAttributes(node),
        status,
        isError: toolRow?.getAttribute('data-is-error') === 'true',
        startedAtMs,
      };
    });
    const summary = toolCallUtils.summarizeToolRun(members);
    const template = toggle.ownerDocument?.createElement?.('template');
    if (!template) return;
    template.innerHTML = toolCallUtils.buildToolRunToggleInner(summary);
    // The turn clock owns the ticking label: keep its text so a patch that
    // lands on a new second does not rebuild the row and restart the shimmer.
    const liveElapsed = toggle.querySelector('[data-elapsed-started-at]');
    const nextElapsed = template.content.querySelector('[data-elapsed-started-at]');
    if (liveElapsed && nextElapsed
      && liveElapsed.getAttribute('data-elapsed-started-at') === nextElapsed.getAttribute('data-elapsed-started-at')) {
      nextElapsed.textContent = liveElapsed.textContent;
    }
    if (toggle.innerHTML !== template.innerHTML) toggle.innerHTML = template.innerHTML;
    summaryRow.querySelector('.tool-run-row')?.setAttribute('data-tool-run-state', toolCallUtils.toolRunState(summary));
  }

  // A minimal row's result presentation (detail model, failure line, output)
  // comes from the keyed full render, not from this field-level patch.
  function isMinimalRowTarget(targets) {
    return !targets.block && targets.toolCallRow?.classList?.contains('tool-call-row--minimal') === true;
  }

  function patchToolTarget(targets, entry, announcer) {
    const payload = entry?.payload || {};
    // This lane writes the row's DOM directly: drop the row-list reconcile
    // stamp so an identical later segment re-checks the row (timeline-perf).
    streamDomPatchUtils?.invalidateRowStamp?.(targets.row || targets.root);
    const status = resolvePatchStatus(payload, entry?.eventType);
    const toolName = resolveToolName(payload);
    const summary = resolveSummary(payload);
    const outputText = resolveOutputText(payload);
    const durationLabel = formatDurationMs(payload.durationMs || payload.duration_ms || payload.tool_result?.duration_ms);
    // The row's name label is fixed at render time (getToolDisplayName); the
    // raw tool id is never written over it.
    const announceCtx = announcer
      ? { announcer, callId: entry?.callId, toolName: toolName ? toolCallUtils.getToolDisplayName(toolName) : '' }
      : null;
    patchStatus(targets, status, announceCtx,
      entry?.eventType === 'tool_result' || payload.type === 'tool_result' ? payload : null);
    if (summary) {
      setTextIfPresent(targets.root, '.tool-call-summary', summary);
    }
    if (durationLabel) {
      setTextIfPresent(targets.root, '.tool-call-duration, .tool-result-duration', durationLabel);
    }
    patchOutputText(targets, outputText);
    if (entry?.eventType === 'tool_result' && isMinimalRowTarget(targets)) {
      targets.toolCallRow.setAttribute('data-is-error', payload.isError === true || payload.is_error === true ? 'true' : 'false');
    }
    refreshToolRunSummary(targets.row, payload.durationMs || payload.duration_ms || payload.tool_result?.duration_ms);
    return true;
  }

  function createLiveToolPatchController(options = {}) {
    const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
    const windowRef = options.windowRef || globalRef.window || globalRef;
    const requestFrame = typeof windowRef.requestAnimationFrame === 'function'
      ? windowRef.requestAnimationFrame.bind(windowRef)
      : (callback) => {
        const setTimeoutRef = typeof windowRef.setTimeout === 'function'
          ? windowRef.setTimeout.bind(windowRef)
          : globalRef.setTimeout;
        return setTimeoutRef(callback, 16);
      };
    const cancelFrame = typeof windowRef.cancelAnimationFrame === 'function'
      ? windowRef.cancelAnimationFrame.bind(windowRef)
      : (handle) => {
        const clearTimeoutRef = typeof windowRef.clearTimeout === 'function'
          ? windowRef.clearTimeout.bind(windowRef)
          : globalRef.clearTimeout;
        if (typeof clearTimeoutRef === 'function') {
          clearTimeoutRef(handle);
        }
      };
    const chatTimeline = options.chatTimeline || null;
    const timelineVirtualizer = options.timelineVirtualizer || null;
    // Optional (UIUX-029): shared live-announcer instance (renderer/shared/renderer-live-announcer.js).
    // Absent in callers/tests that don't wire it -- patchStatus no-ops the announce call in that case.
    const announcer = options.announcer || null;
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : () => {};
    const isVisibleChatSession = typeof options.isVisibleChatSession === 'function' ? options.isVisibleChatSession : () => true;
    const shouldBlockLivePatch = typeof options.shouldBlockLivePatch === 'function' ? options.shouldBlockLivePatch : () => false;
    const onFallback = typeof options.onFallback === 'function' ? options.onFallback : () => {};
    const onPatched = typeof options.onPatched === 'function' ? options.onPatched : () => {};
    const pendingByKey = new Map();
    let frameHandle = 0;
    let lastFallbackLogAt = 0;
    let suppressedFallbackLogs = 0;

    function logFallback(reason, entry) {
      const now = Date.now();
      if (now - lastFallbackLogAt < FALLBACK_LOG_WINDOW_MS) {
        suppressedFallbackLogs += 1;
        return;
      }
      const suppressedCount = suppressedFallbackLogs;
      suppressedFallbackLogs = 0;
      lastFallbackLogAt = now;
      appendClientLog('DEBUG', 'stream.live_tool_patch_fallback', {
        reason,
        sessionId: normalizeId(entry?.sessionId).slice(0, 30),
        callId: normalizeId(entry?.callId).slice(0, 60),
        eventType: normalizeId(entry?.eventType).slice(0, 60),
        suppressedCount,
      });
    }

    function canPatchVisibleSession(entry) {
      try {
        return isVisibleChatSession(entry.sessionId) === true;
      } catch (error) {
        logFallback('visibility_check_failed', entry);
        appendClientLog('WARN', 'stream.live_tool_patch_visibility_failed', {
          sessionId: normalizeId(entry.sessionId).slice(0, 30),
          callId: normalizeId(entry.callId).slice(0, 60),
          message: String(error?.message || error).slice(0, 200),
        });
        return false;
      }
    }

    function isDirectPatchBlocked(entry) {
      try {
        if (shouldBlockLivePatch(entry.sessionId, entry.payload, {
          callId: entry.callId,
          eventType: entry.eventType,
        }) === true) {
          logFallback('direct_patch_blocked', entry);
          return true;
        }
        return false;
      } catch (error) {
        logFallback('direct_patch_block_check_failed', entry);
        appendClientLog('WARN', 'stream.live_tool_patch_block_check_failed', {
          sessionId: normalizeId(entry.sessionId).slice(0, 30),
          callId: normalizeId(entry.callId).slice(0, 60),
          eventType: normalizeId(entry.eventType).slice(0, 60),
          message: String(error?.message || error).slice(0, 200),
        });
        return true;
      }
    }

    function callFallback(entry, reason) {
      try {
        onFallback(entry.sessionId, entry.payload, { reason, eventType: entry.eventType });
      } catch (error) {
        appendClientLog('WARN', 'stream.live_tool_patch_fallback_failed', {
          sessionId: normalizeId(entry.sessionId).slice(0, 30),
          callId: normalizeId(entry.callId).slice(0, 60),
          eventType: normalizeId(entry.eventType).slice(0, 60),
          message: String(error?.message || error).slice(0, 200),
        });
      }
    }

    function callPatched(entry) {
      try {
        onPatched(entry.sessionId, entry.payload, { eventType: entry.eventType });
      } catch (error) {
        appendClientLog('WARN', 'stream.live_tool_patch_callback_failed', {
          sessionId: normalizeId(entry.sessionId).slice(0, 30),
          callId: normalizeId(entry.callId).slice(0, 60),
          eventType: normalizeId(entry.eventType).slice(0, 60),
          message: String(error?.message || error).slice(0, 200),
        });
      }
    }

    function scheduleFlush() {
      if (frameHandle) return;
      frameHandle = requestFrame(() => {
        frameHandle = 0;
        const entries = Array.from(pendingByKey.values());
        pendingByKey.clear();
        entries.forEach((entry) => {
          if (!canPatchVisibleSession(entry)) {
            logFallback('inactive_session', entry);
            callFallback(entry, 'inactive_session');
            return;
          }
          if (isDirectPatchBlocked(entry)) {
            callFallback(entry, 'direct_patch_blocked');
            return;
          }
          // Reuse the targets validated at queue time; only re-resolve if they
          // are missing or the virtualizer recycled the nodes.
          let targets = entry._cachedTargets || null;
          if (!targets || !areTargetsAttachedToTimeline(chatTimeline, targets)) {
            targets = findTargets(chatTimeline, entry.callId, { timelineVirtualizer });
          }
          if (!targets) {
            logFallback('missing_target', entry);
            callFallback(entry, 'missing_target');
            return;
          }
          if (!areTargetsAttachedToTimeline(chatTimeline, targets)) {
            logFallback('detached_target', entry);
            callFallback(entry, 'detached_target');
            return;
          }
          try {
            patchToolTarget(targets, entry, announcer);
            callPatched(entry);
            if (entry.eventType === 'tool_result' && isMinimalRowTarget(targets)) {
              callFallback(entry, 'result_needs_render');
            }
          } catch (error) {
            logFallback('patch_failed', entry);
            appendClientLog('WARN', 'stream.live_tool_patch_failed', {
              sessionId: normalizeId(entry.sessionId).slice(0, 30),
              callId: normalizeId(entry.callId).slice(0, 60),
              eventType: normalizeId(entry.eventType).slice(0, 60),
              message: String(error?.message || error).slice(0, 200),
            });
            callFallback(entry, 'patch_failed');
          }
        });
      });
    }

    function queueToolPatch(payload, details = {}) {
      const sessionId = normalizeId(payload?.sessionId || payload?.session_id);
      const callId = resolveCallId(payload);
      const eventType = normalizeId(details.eventType || payload?.type || 'tool');
      const entry = { sessionId, callId, eventType, payload };
      if (!sessionId || !callId) {
        logFallback(!sessionId ? 'missing_session_id' : 'missing_call_id', entry);
        return false;
      }
      if (isDirectPatchBlocked(entry)) {
        return false;
      }
      if (!canPatchVisibleSession(entry)) {
        return false;
      }
      if (!chatTimeline) {
        logFallback('missing_timeline', entry);
        return false;
      }
      const targets = findTargets(chatTimeline, callId, { timelineVirtualizer });
      if (!targets) {
        logFallback('missing_target', entry);
        return false;
      }
      if (needsApprovalGapRender(chatTimeline, callId, payload, eventType, targets)) {
        logFallback('approval_gap_render', entry);
        return false;
      }
      if (!areTargetsAttachedToTimeline(chatTimeline, targets)) {
        logFallback('detached_target', entry);
        return false;
      }
      // Stash the validated targets so the flush rAF reuses them instead of
      // re-running findTargets a second time per tool event.
      // mergePatchEntry spreads the new entry last, so the latest targets win.
      entry._cachedTargets = targets;
      const key =`${sessionId}\u001f${callId}`;
      pendingByKey.set(key, mergePatchEntry(pendingByKey.get(key), entry));
      scheduleFlush();
      return true;
    }

    function dispose() {
      if (frameHandle) {
        cancelFrame(frameHandle);
        frameHandle = 0;
      }
      pendingByKey.clear();
    }

    return {
      queueToolPatch,
      dispose,
    };
  }

  return {
    createLiveToolPatchController,
    refreshToolRunSummary,
  };
});
