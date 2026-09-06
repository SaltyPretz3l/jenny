(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererApprovalBatchUtils = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';

  const TURN_NODE_SELECTOR = '.chat-thread-node[data-thread-message-id]';
  // Plan-variant gap rows are deliberately actionless (the plan card owns the
  // decision), so they never join the batch Allow All / Deny All count.
  const APPROVAL_ROW_SELECTOR = '.approval-gap-row[data-approval-status="pending"]:not([data-approval-variant="plan"])';
  const BATCH_BANNER_CLASS = 'approval-batch-banner';
  const BATCH_BANNER_DATA = 'data-approval-batch-banner';

  const escapeHtml = stringUtils.escapeHtml;

  function getTurnId(turnNode) {
    if (!turnNode || typeof turnNode.getAttribute !== 'function') return '';
    return String(turnNode.getAttribute('data-thread-message-id') || '').trim();
  }

  function collectPendingApprovalGaps(turnNode) {
    if (!turnNode || typeof turnNode.querySelectorAll !== 'function') return [];
    const rows = turnNode.querySelectorAll(APPROVAL_ROW_SELECTOR);
    return Array.from(rows).filter((row) => {
      if (!row || typeof row.getAttribute !== 'function') return false;
      return row.getAttribute('data-approval-resolved') !== 'true';
    });
  }

  function buildBatchBannerMarkup(count, turnId) {
    const safeCount = escapeHtml(String(count));
    const safeTurn = escapeHtml(turnId);
    const phrase = count === 1
      ? '1 tool waiting for approval'
      : safeCount + ' tools waiting for approval';
    return ''
      + '<div class="' + BATCH_BANNER_CLASS + '" ' + BATCH_BANNER_DATA + '="' + safeTurn + '"'
      + ' data-pending-count="' + safeCount + '"'
      + ' role="region" aria-label="Pending tool approvals">'
      + '<div class="approval-batch-banner-body">'
      + '<span class="approval-batch-banner-icon" aria-hidden="true"></span>'
      + '<span class="approval-batch-banner-title">' + escapeHtml(phrase) + '</span>'
      + '</div>'
      + '<div class="approval-batch-banner-actions">'
      + '<button type="button" class="approval-batch-action approval-batch-action--allow"'
      + ' data-approval-batch-action="approve-all"'
      + ' data-turn-id="' + safeTurn + '">Allow All</button>'
      + '<button type="button" class="approval-batch-action approval-batch-action--allow-once"'
      + ' data-approval-batch-action="approve-all-once"'
      + ' data-turn-id="' + safeTurn + '">Allow All Once</button>'
      + '<button type="button" class="approval-batch-action approval-batch-action--deny"'
      + ' data-approval-batch-action="deny-all"'
      + ' data-turn-id="' + safeTurn + '">Deny All</button>'
      + '</div>'
      + '</div>';
  }

  function findExistingBanner(turnNode) {
    if (!turnNode || typeof turnNode.querySelector !== 'function') return null;
    return turnNode.querySelector(':scope > .' + BATCH_BANNER_CLASS)
      || turnNode.querySelector('.' + BATCH_BANNER_CLASS + '[data-approval-batch-banner]');
  }

  function findRowsHost(turnNode) {
    if (!turnNode || typeof turnNode.querySelector !== 'function') return null;
    return turnNode.querySelector(':scope > .chat-thread-children')
      || turnNode.querySelector('.chat-thread-children')
      || turnNode;
  }

  function syncBannerForTurn(turnNode, documentRef) {
    const turnId = getTurnId(turnNode);
    const pending = collectPendingApprovalGaps(turnNode);
    let banner = findExistingBanner(turnNode);

    if (pending.length < 2) {
      if (banner && banner.parentNode) {
        banner.parentNode.removeChild(banner);
      }
      return;
    }

    const markup = buildBatchBannerMarkup(pending.length, turnId);
    if (banner) {
      if (
        banner.getAttribute('data-pending-count') === String(pending.length)
        && banner.getAttribute(BATCH_BANNER_DATA) === turnId
      ) {
        return;
      }
      const wrapper = documentRef.createElement('div');
      wrapper.innerHTML = markup;
      const fresh = wrapper.firstElementChild;
      if (fresh) {
        banner.replaceWith(fresh);
      }
      return;
    }
    const host = findRowsHost(turnNode);
    if (!host) return;
    const wrapper = documentRef.createElement('div');
    wrapper.innerHTML = markup;
    const node = wrapper.firstElementChild;
    if (!node) return;
    if (host === turnNode) {
      host.appendChild(node);
    } else {
      host.parentNode?.insertBefore(node, host);
    }
  }

  function createApprovalReconciliationController(options = {}) {
    const scopeRoot = options.scopeRoot;
    const getActiveTurnState = options.getActiveTurnState;
    const rehydrateSession = options.rehydrateSession;
    const setBlockBusy = options.setBlockBusy || function noopSetBlockBusy() {};
    const appendClientLog = options.appendClientLog || function noopAppendClientLog() {};
    const getCurrentSessionId = options.getCurrentSessionId || function emptySessionId() { return ''; };
    const schedule = options.setTimeoutFn || setTimeout;
    const cancelSchedule = options.clearTimeoutFn || clearTimeout;
    const delay = Math.min(10000, Math.max(100, Number(options.delayMs) || 2500));
    const maxPending = Math.min(64, Math.max(1, Number(options.maxPending) || 32));
    const Observer = options.MutationObserver || scopeRoot?.ownerDocument?.defaultView?.MutationObserver;
    const pending = new Map();
    let observer = null;
    let disposed = false;

    function normalizeIdentity(value) {
      return String(value || '').trim();
    }

    function bounded(value, max = 60) {
      return String(value || '').trim().slice(0, max);
    }

    function release(key, reason, reenable = false) {
      const entry = pending.get(key);
      if (!entry) return;
      pending.delete(key);
      cancelSchedule(entry.timer);
      if (reenable && entry.row?.isConnected) setBlockBusy(entry.block, false);
      if (entry.row?.isConnected) entry.row.setAttribute('data-approval-reconciliation', reason);
      if (!pending.size && observer) {
        observer.disconnect();
        observer = null;
      }
    }

    function sweepSettledRows() {
      for (const [key, entry] of pending) {
        if (!entry.row?.isConnected) release(key, 'settled');
        else if (normalizeIdentity(getCurrentSessionId()) !== entry.sessionId) release(key, 'session_changed', true);
      }
    }

    function ensureObserver() {
      if (observer || typeof Observer !== 'function' || !scopeRoot) return;
      observer = new Observer(sweepSettledRows);
      observer.observe(scopeRoot, { childList: true, subtree: true });
    }

    function pendingApprovalMatches(snapshot, reference) {
      const approval = snapshot?.pending_approval;
      return Boolean(approval && typeof approval === 'object'
        && [approval.approval_id, approval.call_id].some((value) => normalizeIdentity(value) === reference));
    }

    async function reconcile(key) {
      const entry = pending.get(key);
      if (!entry || disposed) return;
      if (normalizeIdentity(getCurrentSessionId()) !== entry.sessionId) {
        release(key, 'session_changed', true);
        return;
      }
      let snapshot = null;
      let available = typeof getActiveTurnState === 'function';
      try {
        snapshot = available ? await getActiveTurnState(entry.sessionId) : null;
      } catch (error) {
        available = false;
        appendClientLog('WARN', 'approval.reconcile_active_turn_failed', {
          sessionId: bounded(entry.sessionId),
          approvalId: bounded(entry.reference),
          message: bounded(error?.message || error, 160),
        });
      }
      try {
        if (typeof rehydrateSession === 'function') await rehydrateSession(entry.sessionId);
      } catch (error) {
        available = false;
        appendClientLog('WARN', 'approval.reconcile_rehydrate_failed', {
          sessionId: bounded(entry.sessionId),
          approvalId: bounded(entry.reference),
          message: bounded(error?.message || error, 160),
        });
      }
      if (pending.get(key) !== entry || disposed || !entry.row?.isConnected) {
        release(key, 'settled');
        return;
      }
      if (normalizeIdentity(getCurrentSessionId()) !== entry.sessionId) {
        release(key, 'session_changed', true);
        return;
      }
      const reason = available && pendingApprovalMatches(snapshot, entry.reference) ? 'pending' : 'unknown';
      release(key, reason, true);
      appendClientLog(available ? 'INFO' : 'WARN', 'approval.reconcile_recoverable', {
        sessionId: bounded(entry.sessionId),
        approvalId: bounded(entry.reference),
        status: reason,
      });
    }

    function start({ sessionId, reference, row, block }) {
      if (disposed || !row || !block) return;
      const normalizedSessionId = normalizeIdentity(sessionId);
      const normalizedReference = normalizeIdentity(reference);
      if (!normalizedSessionId || !normalizedReference) {
        setBlockBusy(block, false);
        return;
      }
      if (normalizeIdentity(getCurrentSessionId()) !== normalizedSessionId) {
        setBlockBusy(block, false);
        if (row.isConnected) row.setAttribute('data-approval-reconciliation', 'session_changed');
        return;
      }
      if (!row.isConnected) {
        setBlockBusy(block, false);
        return;
      }
      const key = JSON.stringify([normalizedSessionId, normalizedReference]);
      release(key, 'restarted');
      while (pending.size >= maxPending) {
        const [oldestKey, oldest] = pending.entries().next().value;
        release(oldestKey, 'evicted', true);
        appendClientLog('WARN', 'approval.reconcile_evicted', {
          sessionId: bounded(oldest.sessionId),
          approvalId: bounded(oldest.reference),
        });
      }
      row.setAttribute('data-approval-reconciliation', 'waiting');
      pending.set(key, {
        sessionId: normalizedSessionId,
        reference: normalizedReference,
        row,
        block,
        timer: schedule(() => reconcile(key), delay),
      });
      ensureObserver();
    }

    function dispose() {
      disposed = true;
      for (const key of [...pending.keys()]) release(key, 'disposed');
    }

    return { dispose, start };
  }

  function syncAllTurns(scopeRoot, documentRef) {
    if (!scopeRoot || typeof scopeRoot.querySelectorAll !== 'function') return;
    // Skip scanning when neither pending approvals nor a stale batch banner exists; checking for a banner preserves resolved-turn cleanup.
    if (typeof scopeRoot.querySelector === 'function'
      && !scopeRoot.querySelector(APPROVAL_ROW_SELECTOR)
      && !scopeRoot.querySelector('[' + BATCH_BANNER_DATA + ']')) {
      return;
    }
    const turns = scopeRoot.querySelectorAll(TURN_NODE_SELECTOR);
    turns.forEach((turn) => syncBannerForTurn(turn, documentRef));
  }

  function bindApprovalBatchUx(options) {
    const opts = options || {};
    const scopeRoot = opts.scopeRoot;
    const documentRef = opts.document
      || (typeof document !== 'undefined' ? document : null);
    const callbacks = opts.callbacks || {};
    const approveOne = typeof callbacks.approveOne === 'function' ? callbacks.approveOne : null;
    const denyOne = typeof callbacks.denyOne === 'function' ? callbacks.denyOne : null;
    const onError = typeof callbacks.onError === 'function' ? callbacks.onError : null;

    if (!scopeRoot || !documentRef || !approveOne || !denyOne) {
      return { sync: function noop() {}, dispose: function noop() {} };
    }

    let observer = null;
    let scheduled = false;
    let disposed = false;
    // Retain the scheduled frame and matching canceller, and fence the callback after disposal.
    let frameHandle = null;
    let cancelFrame = null;
    const busyBanners = new WeakSet();
    const claimedTurnIds = new Set();

    function scheduleSync() {
      if (disposed || scheduled) return;
      scheduled = true;
      const win = (typeof window !== 'undefined' ? window : null);
      const requestFrame = win && typeof win.requestAnimationFrame === 'function'
        ? win.requestAnimationFrame.bind(win)
        : function frameFallback(callback) { return setTimeout(callback, 16); };
      cancelFrame = win && typeof win.cancelAnimationFrame === 'function'
        ? win.cancelAnimationFrame.bind(win)
        : function cancelFallback(id) { clearTimeout(id); };
      frameHandle = requestFrame(function frameTick() {
        scheduled = false;
        frameHandle = null;
        if (disposed) return;
        syncAllTurns(scopeRoot, documentRef);
        claimedTurnIds.forEach((turnId) => {
          const turnNode = scopeRoot.querySelector(
            '.chat-thread-node[data-thread-message-id="' + cssEscape(turnId) + '"]'
          );
          setBannerBusy(findExistingBanner(turnNode), true);
        });
      });
    }

    function setBannerBusy(banner, busy) {
      if (!banner || typeof banner.querySelectorAll !== 'function') return;
      if (busy) {
        busyBanners.add(banner);
        banner.setAttribute('data-approval-batch-busy', 'true');
      } else {
        busyBanners.delete(banner);
        banner.removeAttribute('data-approval-batch-busy');
      }
      banner.querySelectorAll('[data-approval-batch-action]').forEach((button) => {
        button.disabled = busy;
        button.setAttribute('aria-disabled', busy ? 'true' : 'false');
      });
    }

    function buildFalseResultError(action) {
      const method = action === 'deny-all' ? 'tools.deny' : 'tools.approve';
      return new Error(method + ' returned false');
    }

    async function resolveBatchRow(row, action) {
      const callId = row.getAttribute('data-approval-id')
        || row.getAttribute('data-tool-call-id')
        || row.getAttribute('data-call-id')
        || '';
      if (!callId) return;
      try {
        let result;
        if (action === 'approve-all') {
          result = await approveOne(callId, { alwaysAllow: true });
        } else if (action === 'approve-all-once') {
          result = await approveOne(callId, { alwaysAllow: false });
        } else if (action === 'deny-all') {
          result = await denyOne(callId);
        } else {
          return;
        }
        if (result === false) {
          throw buildFalseResultError(action);
        }
        row.setAttribute('data-approval-resolved', 'true');
      } catch (error) {
        if (onError) onError(action, callId, error);
      }
    }

    async function processBatch(button, action, pending, turnId) {
      const banner = button.closest('.' + BATCH_BANNER_CLASS);
      setBannerBusy(banner, true);
      try {
        await Promise.all(pending.map((row) => resolveBatchRow(row, action)));
      } finally {
        claimedTurnIds.delete(turnId);
        setBannerBusy(banner, false);
        scheduleSync();
      }
    }

    function handleClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const button = target.closest('[data-approval-batch-action]');
      if (!button || !scopeRoot.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      const banner = button.closest('.' + BATCH_BANNER_CLASS);
      if (banner && busyBanners.has(banner)) return;
      const action = String(button.getAttribute('data-approval-batch-action') || '').trim();
      const turnId = String(button.getAttribute('data-turn-id') || '').trim();
      const turnNode = turnId
        ? scopeRoot.querySelector('.chat-thread-node[data-thread-message-id="' + cssEscape(turnId) + '"]')
        : button.closest(TURN_NODE_SELECTOR);
      if (!turnNode) return;
      const claimedTurnId = turnId || getTurnId(turnNode);
      if (!claimedTurnId || claimedTurnIds.has(claimedTurnId)) return;
      const pending = collectPendingApprovalGaps(turnNode);
      if (pending.length === 0) return;

      claimedTurnIds.add(claimedTurnId);
      processBatch(button, action, pending, claimedTurnId);
    }

    function cssEscape(value) {
      const win = typeof window !== 'undefined' ? window : null;
      const escaper = win && win.CSS && typeof win.CSS.escape === 'function' ? win.CSS.escape : null;
      if (escaper) return escaper(String(value || ''));
      return String(value || '').replace(/[^a-zA-Z0-9_-]/g, function (ch) {
        return '\\' + ch;
      });
    }

    scopeRoot.addEventListener('click', handleClick, true);

    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(() => scheduleSync());
      observer.observe(scopeRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-approval-resolved'] });
    }

    scheduleSync();

    return {
      sync: function sync() { scheduleSync(); },
      dispose: function dispose() {
        if (disposed) return;
        disposed = true;
        scopeRoot.removeEventListener('click', handleClick, true);
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        claimedTurnIds.clear();
        if (frameHandle != null && typeof cancelFrame === 'function') {
          try { cancelFrame(frameHandle); } catch (_error) { /* best-effort */ }
        }
        scheduled = false;
        frameHandle = null;
      },
    };
  }

  return {
    bindApprovalBatchUx,
    createApprovalReconciliationController,
  };
});
