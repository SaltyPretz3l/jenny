(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tool-call-utils'));
    return;
  }
  root.rendererStreamToolPatchUtils = factory(root.toolCallUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (toolCallUtils) {
  'use strict';

  const FALLBACK_LOG_WINDOW_MS = 2000;

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function escapeSelectorValue(value) {
    const text = String(value || '');
    if (typeof globalThis !== 'undefined' && globalThis.CSS && typeof globalThis.CSS.escape === 'function') {
      return globalThis.CSS.escape(text);
    }
    return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

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

  function findByAttribute(rootNode, selector, attribute, value) {
    const normalizedValue = normalizeId(value);
    if (!rootNode || !normalizedValue || typeof rootNode.querySelectorAll !== 'function') {
      return null;
    }
    const nodes = Array.from(rootNode.querySelectorAll(selector));
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (normalizeId(node?.getAttribute?.(attribute)) === normalizedValue) {
        return node;
      }
    }
    return null;
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
      const approvalState = normalizeId(payload?.approvalState || payload?.approval_state).toLowerCase();
      if (approvalState === 'denied') return 'denied';
      if (payload?.isError === true || payload?.is_error === true) return 'errored';
      return 'completed';
    }
    const rawStatus = normalizeId(payload?.status || payload?.tool_call?.status || 'running').toLowerCase();
    if (rawStatus === 'pending_approval') return 'awaiting_approval';
    if (rawStatus === 'error') return 'errored';
    if (rawStatus === 'timeout') return 'timed_out';
    if (rawStatus === 'preempted') return 'cancelled';
    return rawStatus || 'running';
  }

  function getStatusLabel(status) {
    if (toolCallUtils && typeof toolCallUtils.getStatusLabel === 'function') {
      return toolCallUtils.getStatusLabel(status);
    }
    // Canonical labels live in tool-call-utils.getStatusLabel (always present via
    // document load order / CommonJS require). This branch is only reached if that
    // module is somehow absent; degrade to a passthrough rather than re-introduce a
    // divergent label set ('Errored'/'Completed' vs canonical 'Error'/'Success').
    return String(status || '').trim() || 'Tool';
  }

  function getStatusTone(status) {
    if (toolCallUtils && typeof toolCallUtils.statusToneFor === 'function') {
      return toolCallUtils.statusToneFor(status, status === 'running');
    }
    if (status === 'completed') return 'success';
    if (status === 'errored' || status === 'denied' || status === 'timed_out') return 'danger';
    if (status === 'awaiting_approval') return 'warning';
    if (status === 'running') return 'pending';
    return 'muted';
  }

  function formatDurationMs(value) {
    const durationMs = Number(value);
    if (!Number.isFinite(durationMs) || durationMs <= 0) return '';
    if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
    return `${(durationMs / 1000).toFixed(1)}s`;
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
    let row = safeQuerySelectorLast(chatTimeline, `.chat-row[data-tool-call-id="${escapedCallId}"]`)
      || findByAttribute(chatTimeline, '.chat-row[data-tool-call-id]', 'data-tool-call-id', normalizedCallId);
    let block = row
      ? (
        safeQuerySelectorLast(row, `.tool-call-block[data-call-id="${escapedCallId}"]`)
        || findByAttribute(row, '.tool-call-block[data-call-id]', 'data-call-id', normalizedCallId)
        || safeQuerySelector(row, '.tool-call-block')
      )
      : (
        safeQuerySelectorLast(chatTimeline, `.tool-call-block[data-call-id="${escapedCallId}"]`)
        || findByAttribute(chatTimeline, '.tool-call-block[data-call-id]', 'data-call-id', normalizedCallId)
      );
    let toolCallRow = row
      ? (
        findByAttribute(row, '.tool-call-row[data-tool-call-id]', 'data-tool-call-id', normalizedCallId)
        || safeQuerySelector(row, '.tool-call-row')
      )
      : (
        safeQuerySelectorLast(chatTimeline, `.tool-call-row[data-tool-call-id="${escapedCallId}"]`)
        || findByAttribute(chatTimeline, '.tool-call-row[data-tool-call-id]', 'data-tool-call-id', normalizedCallId)
      );
    let toolResultRow = row
      ? (
        findByAttribute(row, '.tool-result-row[data-tool-call-id]', 'data-tool-call-id', normalizedCallId)
        || safeQuerySelector(row, '.tool-result-row')
      )
      : (
        safeQuerySelectorLast(chatTimeline, `.tool-result-row[data-tool-call-id="${escapedCallId}"]`)
        || findByAttribute(chatTimeline, '.tool-result-row[data-tool-call-id]', 'data-tool-call-id', normalizedCallId)
      );
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
    completed: { politeness: 'polite', phrase: (name) => `${name} finished` },
    errored: { politeness: 'assertive', phrase: (name) => `${name} failed` },
    denied: { politeness: 'assertive', phrase: (name) => `${name} was denied` },
    timed_out: { politeness: 'assertive', phrase: (name) => `${name} timed out` },
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

  function patchStatus(targets, status, announceCtx) {
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
    const statusLabel = getStatusLabel(status);
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

  function patchToolTarget(targets, entry, announcer) {
    const payload = entry?.payload || {};
    const status = resolvePatchStatus(payload, entry?.eventType);
    const toolName = resolveToolName(payload);
    const summary = resolveSummary(payload);
    const outputText = resolveOutputText(payload);
    const durationLabel = formatDurationMs(payload.durationMs || payload.duration_ms || payload.tool_result?.duration_ms);
    patchStatus(targets, status, announcer ? { announcer, callId: entry?.callId, toolName } : null);
    if (toolName) {
      setTextIfPresent(targets.root, '.tool-call-name, .tool-result-label', toolName);
    }
    if (summary) {
      setTextIfPresent(targets.root, '.tool-call-summary', summary);
    }
    if (durationLabel) {
      setTextIfPresent(targets.root, '.tool-call-duration, .tool-result-duration', durationLabel);
    }
    patchOutputText(targets, outputText);
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
  };
});
