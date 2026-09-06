/* renderer/features/renderer-ide-confirm-dialog.js
 *
 * Promise-returning Save / Don't Save / Cancel confirm for closing dirty tabs.
 * Built on the inventory help-overlay primitive (focus trap, Esc, scrim, focus
 * restoration) so this file carries no raw HTML primitives - the action buttons
 * render through the inventory action-button. A single batched prompt covers a
 * multi-file Close All.
 *
 * Resolves 'save' | 'discard' | 'cancel'. Esc / scrim / the overlay close button
 * all resolve 'cancel' (the safe, non-destructive default). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeConfirmDialog = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function defaultEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function basename(path) {
    const str = String(path || '');
    const slash = str.lastIndexOf('/');
    return slash === -1 ? str : str.slice(slash + 1);
  }

  function createIdeConfirmDialog(deps) {
    const options = deps || {};
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const escapeHtml = typeof options.escapeHtml === 'function' ? options.escapeHtml : defaultEscape;
    const actionButton = typeof options.actionButton === 'function' ? options.actionButton : null;
    const helpOverlayFactory = typeof options.helpOverlayFactory === 'function'
      ? options.helpOverlayFactory
      : null;
    // Additional consumers pass their own hostId
    // so two dialog instances never mint duplicate overlay host DOM ids.
    const hostId = String(options.hostId || 'ideConfirmCloseOverlay');

    let overlay = null;

    function ensureOverlay() {
      if (overlay || !helpOverlayFactory || !doc) {
        return overlay;
      }
      overlay = helpOverlayFactory({ document: doc, hostId });
      return overlay;
    }

    function buildBodyHtml(dirtyPaths) {
      const count = dirtyPaths.length;
      const message = count === 1
        ? `<p class="ide-confirm-message">“${escapeHtml(basename(dirtyPaths[0]))}” has unsaved changes. Save before closing?</p>`
        : `<p class="ide-confirm-message">${count} files have unsaved changes. Save them before closing?</p>`;
      const list = count > 1
        ? `<ul class="ide-confirm-list">${dirtyPaths
          .map((path) => `<li title="${escapeHtml(path)}">${escapeHtml(basename(path))}</li>`)
          .join('')}</ul>`
        : '';
      const buttons = actionButton
        ? actionButton({ label: count > 1 ? 'Save All' : 'Save', variant: 'primary', dataset: { 'ide-confirm-action': 'save' } })
          + actionButton({ label: 'Don’t Save', variant: 'danger', dataset: { 'ide-confirm-action': 'discard' } })
          + actionButton({ label: 'Cancel', variant: 'ghost', dataset: { 'ide-confirm-action': 'cancel' } })
        : '';
      return `${message}${list}<div class="ide-confirm-actions">${buttons}</div>`;
    }

    // Open the singleton overlay with `config.bodyHtml`, resolve to whichever
    // data-ide-confirm-action button is clicked (restricted to `config.actions`),
    // or `config.onDismiss` on Esc / scrim / the close button / a missing
    // overlay. The three public dialogs below are thin wrappers over this one
    // Promise + capturing-listener lifecycle.
    function runActionDialog(config) {
      const actions = Array.isArray(config.actions) ? config.actions : [];
      const onDismiss = config.onDismiss;
      const inst = ensureOverlay();
      if (!inst || !doc) {
        return Promise.resolve(onDismiss);
      }
      return new Promise((resolve) => {
        let settled = false;
        function finish(result) {
          if (settled) {
            return;
          }
          settled = true;
          doc.removeEventListener('click', onClick, true);
          try { inst.close(); } catch (_error) { /* best-effort */ }
          resolve(result);
        }
        function onClick(event) {
          const target = event.target;
          const btn = target && typeof target.closest === 'function'
            ? target.closest('[data-ide-confirm-action]')
            : null;
          if (!btn) {
            return;
          }
          const action = btn.getAttribute('data-ide-confirm-action');
          if (actions.indexOf(action) !== -1) {
            event.preventDefault();
            finish(action);
          }
        }
        doc.addEventListener('click', onClick, true);
        inst.open({
          title: config.title,
          titleId: config.titleId,
          bodyHtml: config.bodyHtml,
          closeLabel: config.closeLabel,
          onClose: () => finish(onDismiss),
        });
      });
    }

    // Save / Don't Save / Cancel for closing dirty tabs. If the overlay
    // primitive is unavailable (a restricted shell), resolves 'cancel' rather
    // than silently discarding.
    function confirmClose(payload) {
      const dirtyPaths = (payload && Array.isArray(payload.dirtyPaths) ? payload.dirtyPaths : [])
        .map((path) => String(path || ''))
        .filter(Boolean);
      return runActionDialog({
        title: 'Unsaved changes',
        titleId: 'ideConfirmCloseTitle',
        bodyHtml: buildBodyHtml(dirtyPaths),
        closeLabel: 'Cancel and keep editing',
        actions: ['save', 'discard', 'cancel'],
        onDismiss: 'cancel',
      });
    }

    // Generic yes/no confirm. Resolves true only on the confirm button; Esc /
    // scrim / cancel / a missing overlay all resolve false (the safe,
    // non-destructive default). Used by the git slice for "Discard Changes".
    function confirm(payload) {
      const config = payload || {};
      const variant = config.variant === 'danger' ? 'danger' : 'primary';
      const cancelLabel = String(config.cancelLabel || 'Cancel');
      if (!actionButton) {
        return Promise.resolve(false);
      }
      const buttons = actionButton({ label: String(config.confirmLabel || 'Confirm'), variant, dataset: { 'ide-confirm-action': 'confirm' } })
        + actionButton({ label: cancelLabel, variant: 'ghost', dataset: { 'ide-confirm-action': 'cancel' } });
      return runActionDialog({
        title: String(config.title || 'Are you sure?'),
        titleId: 'ideConfirmGenericTitle',
        bodyHtml: `<p class="ide-confirm-message">${escapeHtml(String(config.message || ''))}</p>`
          + `<div class="ide-confirm-actions">${buttons}</div>`,
        closeLabel: cancelLabel,
        actions: ['confirm', 'cancel'],
        onDismiss: 'cancel',
      }).then((result) => result === 'confirm');
    }

    // Three-choice guard for switching branches with a dirty working tree.
    // Resolves 'shelve' | 'switch' | 'cancel' (the last on dismiss). Copy is a
    // static template with a computed, pluralized count - no narration. The
    // caller owns the headline (single source of the count copy); falls back to
    // the same template when it is not supplied.
    function confirmBranchSwitch(payload) {
      const config = payload || {};
      const count = Math.max(0, Number(config.count) || 0);
      if (!actionButton) {
        return Promise.resolve('cancel');
      }
      const headline = typeof config.message === 'string' && config.message
        ? config.message
        : `You have ${count} uncommitted change${count === 1 ? '' : 's'}.`;
      const buttons = actionButton({ label: 'Shelve & switch', variant: 'primary', dataset: { 'ide-confirm-action': 'shelve' } })
        + actionButton({ label: 'Switch anyway', variant: 'danger', dataset: { 'ide-confirm-action': 'switch' } })
        + actionButton({ label: 'Cancel', variant: 'ghost', dataset: { 'ide-confirm-action': 'cancel' } });
      return runActionDialog({
        title: 'Switch branch?',
        titleId: 'ideConfirmBranchSwitchTitle',
        bodyHtml: `<p class="ide-confirm-message">${escapeHtml(headline)}</p>`
          + '<p class="ide-confirm-message">Shelving sets them aside so you can restore them '
          + 'later. Switching anyway carries them to the new branch.</p>'
          + `<div class="ide-confirm-actions">${buttons}</div>`,
        closeLabel: 'Cancel',
        actions: ['shelve', 'switch', 'cancel'],
        onDismiss: 'cancel',
      });
    }

    function dispose() {
      if (overlay) {
        try { overlay.destroy(); } catch (_error) { /* best-effort */ }
        overlay = null;
      }
    }

    return { confirm, confirmClose, confirmBranchSwitch, dispose };
  }

  return { createIdeConfirmDialog };
});
