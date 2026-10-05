/* renderer/chat/renderer-approval-focus-restore.js
 *
 * Keyboard focus hand-off for an approval (or user-questions) row that is
 * answered and then removed from the transcript. The row's removal is driven
 * by a later stream event through the reducer and render pipeline, not by the
 * click that answered it, so the fallback target is snapshotted at click time
 * and focused when the row actually leaves the DOM.
 *
 * One instance per pane timeline; `dispose()` disconnects every watcher still
 * waiting.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererApprovalFocusRestore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createApprovalFocusRestore({ chatTimeline, doc }) {
    const watchers = new Set();

    // A2: snapshot the fallback focus target BEFORE the approval row can be
    // removed from the DOM. Row removal (removeApprovalGapRow) is driven by a
    // later stream event through the reducer/render pipeline, not by this
    // click handler, so we can't rely on a single post-render callback here —
    // instead a MutationObserver watches for the row's actual removal and
    // focuses the fallback the moment it happens (no setTimeout race).
    function resolveApprovalFocusFallback(currentRow) {
      if (!chatTimeline || typeof chatTimeline.querySelectorAll !== 'function') {
        return null;
      }
      // Plan-variant gap rows are deliberately actionless (no buttons, no
      // tabindex — see renderer-approval-block.js), so they can never receive
      // focus; keep them out of the fallback pool (lockstep with the batch
      // selector in renderer-approval-batch-utils.js).
      const pendingRows = Array.from(
        chatTimeline.querySelectorAll('.approval-gap-row:not([data-approval-variant="plan"]):not([data-approval-status="resolved"]), .tool-approval-block:not([data-approval-status="resolved"]), .user-questions-block')
      );
      const nextRow = pendingRows.find((candidate) => candidate !== currentRow
        && !currentRow.contains(candidate)
        && !candidate.contains(currentRow));
      if (nextRow) {
        return nextRow.querySelector('.tool-approve-btn, .tool-deny-btn') || nextRow;
      }
      const composerInput = doc && typeof doc.getElementById === 'function'
        ? doc.getElementById('chatInput')
        : null;
      return composerInput || null;
    }

    function focusApprovalFallback(fallbackTarget) {
      if (!fallbackTarget || typeof fallbackTarget.focus !== 'function') {
        return;
      }
      // The fallback may itself have been removed/replaced between the
      // snapshot and the row actually disappearing (e.g. resolved out of
      // order); skip focusing a detached node.
      if (typeof fallbackTarget.isConnected === 'boolean' && !fallbackTarget.isConnected) {
        return;
      }
      try {
        fallbackTarget.focus();
      } catch (_error) {
        // Best-effort only — focus restoration must never throw into the
        // click handler's promise chain.
      }
    }

    // Observes `approvalRow` for its own removal from the DOM (which
    // removeApprovalGapRow performs via Array.splice-equivalent DOM removal
    // once the reducer sees the call resolve) and focuses the pre-snapshotted
    // fallback the moment that happens. Self-disconnects after firing once or
    // after a real timeout so a row that never gets
    // removed (e.g. a resolution that doesn't retire the row for some reason)
    // doesn't leak an observer forever.
    //
    // `heldFocus` is a snapshot (taken at click time, before any async gap)
    // of whether the approval row actually held focus when the user clicked
    // Allow/Deny. Without this gate, the restore fires unconditionally on
    // removal — stealing focus back from wherever the user has since moved
    // it (e.g. into the composer to keep typing) even though the row wasn't
    // focused to begin with.
    function watchApprovalRowRemoval(approvalRow, fallbackTarget, heldFocus) {
      if (!approvalRow || !fallbackTarget) {
        return;
      }
      const win = doc && doc.defaultView ? doc.defaultView : (typeof window !== 'undefined' ? window : null);
      if (!win || typeof win.MutationObserver !== 'function') {
        // No MutationObserver available (non-browser environment) — fall back
        // to focusing immediately, since there is no reliable removal signal
        // to wait for.
        if (heldFocus) {
          focusApprovalFallback(fallbackTarget);
        }
        return;
      }
      let settled = false;
      let timeoutHandle = null;
      const watcher = {
        disconnect() {
          if (settled) return;
          settled = true;
          observer.disconnect();
          if (timeoutHandle !== null && typeof win.clearTimeout === 'function') {
            win.clearTimeout(timeoutHandle);
          }
          timeoutHandle = null;
          watchers.delete(watcher);
        },
      };
      const observer = new win.MutationObserver(() => {
        if (settled) {
          return;
        }
        // Gone, or morphed in place into its resolved receipt (HB-038 H2):
        // either way the buttons that held focus are gone.
        if (!approvalRow.isConnected || approvalRow.getAttribute('data-approval-status') === 'resolved') {
          watcher.disconnect();
          // Only restore focus if the row held it at click time AND focus is
          // still orphaned by the removal (nothing else claimed it in the
          // meantime) — never pull focus away from an element the user has
          // since moved to on their own.
          const active = doc ? doc.activeElement : null;
          const focusOrphaned = !active || active === doc.body || approvalRow.contains(active);
          if (heldFocus && focusOrphaned) {
            focusApprovalFallback(fallbackTarget);
          }
        }
      });
      const observeRoot = (approvalRow.parentNode && approvalRow.parentNode.isConnected)
        ? approvalRow.parentNode
        : chatTimeline;
      if (!observeRoot) {
        focusApprovalFallback(fallbackTarget);
        return;
      }
      observer.observe(observeRoot, { childList: true, subtree: true });
      watchers.add(watcher);
      timeoutHandle = win.setTimeout(() => watcher.disconnect(), 5000);
    }

    function dispose() {
      for (const watcher of [...watchers]) watcher.disconnect();
    }

    return { resolveApprovalFocusFallback, watchApprovalRowRemoval, dispose };
  }

  return { createApprovalFocusRestore };
});
