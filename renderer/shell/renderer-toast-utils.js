(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererToastUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var TOAST_ALERT_TONES = { warning: true, danger: true };

  // These titles restate the message ("Action Failed" above "Copy failed: …").
  // The tone mark already carries the meaning, so they render no eyebrow.
  var GENERIC_TITLES = {
    'action failed': true,
    'session action failed': true,
    'composer action failed': true,
  };

  // Render-key field separator; never appears in a rendered string.
  var SEP = '\u001f';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  // Shape-distinct marks so the tone does not depend on colour alone.
  var TONE_MARK_PATHS = {
    info: ['M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 0 0 0-12.5', 'M8 7.4v3.9', 'M8 4.8v.7'],
    success: ['M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 0 0 0-12.5', 'M5.3 8.2 7.2 10.1 10.8 6.3'],
    warning: ['M8 2.4 14.6 13.6H1.4Z', 'M8 6.5v3.1', 'M8 11.4v.7'],
    danger: ['M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 0 0 0-12.5', 'M6.1 6.1 9.9 9.9', 'M9.9 6.1 6.1 9.9'],
  };

  // FNV-1a. Only needs to be stable and cheap — it scopes a dedupe key, it is
  // not a security primitive.
  function hashMessage(value) {
    var hash = 0x811c9dc5;
    var text = String(value || '');
    for (var index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(36);
  }

  function createToastController(deps) {
    const { toastStore, toastActionHandlers } = deps;

    const { TOAST_SOURCE } = deps.constants;

    const { toastViewport } = deps.dom;

    // Live DOM nodes keyed by toast id. Reusing nodes across renders is what
    // keeps focus, entrance animations, and screen-reader announcements from
    // being destroyed every time an unrelated toast arrives or leaves.
    const nodesById = new Map();
    let overflowNode = null;

    function enqueueToast(input) {
      return toastStore.enqueue(input);
    }

    function registerToastActions(toastId, actions) {
      if (!toastId) {
        return;
      }
      const nextHandlers = new Map();
      (Array.isArray(actions) ? actions : []).forEach((action) => {
        if (!action || typeof action !== 'object') {
          return;
        }
        const actionId = String(action.id || '').trim();
        if (!actionId || typeof action.onClick !== 'function') {
          return;
        }
        nextHandlers.set(actionId, action.onClick);
      });
      if (nextHandlers.size) {
        toastActionHandlers.set(toastId, nextHandlers);
        return;
      }
      toastActionHandlers.delete(toastId);
    }

    function pruneToastActionHandlers(toasts) {
      const activeToastIds = new Set(
        (Array.isArray(toasts) ? toasts : []).map((toast) => String(toast?.id || '').trim()).filter(Boolean)
      );
      [...toastActionHandlers.keys()].forEach((toastId) => {
        if (!activeToastIds.has(toastId)) {
          toastActionHandlers.delete(toastId);
        }
      });
    }

    function getOverflowCount() {
      return typeof toastStore.getOverflowCount === 'function' ? toastStore.getOverflowCount() : 0;
    }

    function resolveEyebrow(toast) {
      const title = String(toast.title || '').trim();
      if (!title || GENERIC_TITLES[title.toLowerCase()]) {
        return '';
      }
      return title;
    }

    function resolveMessage(toast) {
      const message = String(toast.message || '').trim();
      const repeatCount = Number(toast.repeatCount) || 1;
      return repeatCount > 1 ? `${message} ×${repeatCount}` : message;
    }

    // Built from what is actually on screen — after eyebrow suppression and the
    // repeat suffix — so the key cannot go stale against the rendered text.
    function buildRenderKey(toast) {
      const actions = (Array.isArray(toast.actions) ? toast.actions : [])
        .map((action) => [action.id, action.label, action.kind].join(SEP))
        .join(SEP);
      return [
        toast.tone,
        resolveEyebrow(toast),
        resolveMessage(toast),
        toast.dismissible ? '1' : '0',
        actions,
      ].join(SEP);
    }

    function createToneMark(tone) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'inv-toast__mark');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.4');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      (TONE_MARK_PATHS[tone] || TONE_MARK_PATHS.info).forEach((definition) => {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', definition);
        svg.appendChild(path);
      });
      return svg;
    }

    function createDismissControl(toastId) {
      const dismiss = document.createElement('button');
      dismiss.className = 'inv-toast__dismiss';
      dismiss.type = 'button';
      dismiss.dataset.toastDismiss = toastId;
      dismiss.setAttribute('aria-label', 'Dismiss notification');
      dismiss.title = 'Dismiss notification';
      dismiss.textContent = '×';
      return dismiss;
    }

    function syncToastStructure(node, toast) {
      const mark = createToneMark(toast.tone);
      const existingMark = node.querySelector('.inv-toast__mark');
      if (existingMark) existingMark.replaceWith(mark);
      else node.insertBefore(mark, node.firstChild);

      const dismiss = node.querySelector('.inv-toast__dismiss');
      if (toast.dismissible && !dismiss) node.appendChild(createDismissControl(toast.id));
      else if (!toast.dismissible && dismiss) dismiss.remove();
    }

    function buildToastNode(toast) {
      const node = document.createElement('section');
      node.className = `inv-toast inv-toast--${toast.tone}`;
      node.setAttribute('role', TOAST_ALERT_TONES[toast.tone] ? 'alert' : 'status');
      node.dataset.toastId = toast.id;

      node.appendChild(createToneMark(toast.tone));

      const body = document.createElement('div');
      body.className = 'inv-toast__body';
      node.appendChild(body);

      if (toast.dismissible) {
        node.appendChild(createDismissControl(toast.id));
      }
      return node;
    }

    // Refills the body of an existing (or freshly built) node. Never touches
    // the node itself, so identity and focus survive.
    function paintToastBody(node, toast) {
      const body = node.querySelector('.inv-toast__body');
      if (!body) {
        return;
      }
      body.textContent = '';

      const eyebrow = resolveEyebrow(toast);
      if (eyebrow) {
        const eyebrowNode = document.createElement('p');
        eyebrowNode.className = 'inv-toast__eyebrow';
        eyebrowNode.textContent = eyebrow;
        body.appendChild(eyebrowNode);
      }

      const message = document.createElement('p');
      message.className = 'inv-toast__message';
      message.textContent = resolveMessage(toast);
      body.appendChild(message);

      const actions = Array.isArray(toast.actions) ? toast.actions : [];
      if (!actions.length) {
        return;
      }
      const actionRow = document.createElement('div');
      actionRow.className = 'inv-toast__actions';
      actions.forEach((action) => {
        const kind = String(action.kind || 'secondary');
        const button = document.createElement('button');
        button.className = `inv-toast__action inv-toast__action--${kind}`;
        button.type = 'button';
        button.dataset.toastId = toast.id;
        button.dataset.toastActionId = String(action.id || '');
        button.textContent = String(action.label || 'Action');
        actionRow.appendChild(button);
      });
      body.appendChild(actionRow);
    }

    function detachToastNode(toastId, node) {
      nodesById.delete(toastId);
      toastActionHandlers.delete(toastId);
      if (node && node.parentNode) {
        node.parentNode.removeChild(node);
      }
    }

    // One exit path for both manual dismissal and timer expiry, so an
    // auto-dismissed toast animates out instead of being yanked.
    function beginNodeExit(toastId, node) {
      if (!node || node.classList.contains('toast-exiting')) {
        return;
      }
      // In environments without CSS animation support (jsdom tests) and under
      // prefers-reduced-motion, animationName computes to 'none' and the node
      // is removed synchronously rather than waiting for an animationend that
      // will never fire.
      const view = typeof globalThis !== 'undefined' ? globalThis.window : null;
      const style = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(node) : null;
      if (!style || !style.animationName || style.animationName === 'none') {
        detachToastNode(toastId, node);
        return;
      }

      node.classList.add('toast-exiting');
      let fallbackTimer = null;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        if (fallbackTimer !== null) {
          clearTimeout(fallbackTimer);
        }
        detachToastNode(toastId, node);
      };
      node.addEventListener('animationend', cleanup, { once: true });
      // Derived from the live exit animation so preset-scaled durations (e.g.
      // calm 180ms) never race the timer into a mid-animation removal; the
      // buffer covers event-delivery slop.
      const exitSeconds = parseFloat(view.getComputedStyle(node).animationDuration);
      fallbackTimer = setTimeout(cleanup, Number.isFinite(exitSeconds) ? exitSeconds * 1000 + 60 : 150);
    }

    function renderOverflowLine(count) {
      if (count <= 0) {
        if (overflowNode && overflowNode.parentNode) {
          overflowNode.parentNode.removeChild(overflowNode);
        }
        overflowNode = null;
        return;
      }
      if (!overflowNode) {
        overflowNode = document.createElement('p');
        overflowNode.className = 'toast-viewport__overflow';
        // The queued toasts announce themselves as they promote into view;
        // announcing the count as well is noise.
        overflowNode.setAttribute('aria-hidden', 'true');
      }
      const label = count === 1 ? '1 more notification' : `${count} more notifications`;
      if (overflowNode.textContent !== label) {
        overflowNode.textContent = label;
      }
      toastViewport.appendChild(overflowNode);
    }

    function renderToastViewport() {
      if (!toastViewport) {
        return;
      }
      const toasts = toastStore.getSnapshot();
      pruneToastActionHandlers(toasts);

      const liveIds = new Set(toasts.map((toast) => toast.id));
      [...nodesById.keys()].forEach((toastId) => {
        if (!liveIds.has(toastId)) {
          beginNodeExit(toastId, nodesById.get(toastId));
        }
      });

      let cursor = toastViewport.firstChild;
      toasts.forEach((toast) => {
        let node = nodesById.get(toast.id);
        if (!node) {
          node = buildToastNode(toast);
          nodesById.set(toast.id, node);
        }
        const renderKey = buildRenderKey(toast);
        if (node.dataset.renderKey !== renderKey) {
          node.className = `inv-toast inv-toast--${toast.tone}`;
          node.setAttribute('role', TOAST_ALERT_TONES[toast.tone] ? 'alert' : 'status');
          syncToastStructure(node, toast);
          paintToastBody(node, toast);
          node.dataset.renderKey = renderKey;
        }
        if (cursor === node) {
          cursor = node.nextSibling;
          return;
        }
        toastViewport.insertBefore(node, cursor);
      });

      renderOverflowLine(getOverflowCount());
    }

    function dismissToast(toastId) {
      // The store emits, the reconcile pass notices the departure, and
      // beginNodeExit animates the node out.
      toastStore.dismiss(toastId);
      renderToastViewport();
    }

    function showToastMessage(message, options = {}) {
      const nextMessage = String(message || '').trim();
      if (!nextMessage) {
        return '';
      }
      const actions = Array.isArray(options.actions)
        ? options.actions
            .map((action, index) => {
              const source = action && typeof action === 'object' ? action : {};
              const label = String(source.label || '').trim();
              if (!label) {
                return null;
              }
              return {
                id: String(source.id || `toast_action_${index + 1}`).trim() || `toast_action_${index + 1}`,
                label,
                kind: String(source.kind || '').trim() === 'primary' ? 'primary' : 'secondary',
                onClick: typeof source.onClick === 'function' ? source.onClick : null,
              };
            })
            .filter(Boolean)
        : [];
      const payload = {
        message: nextMessage,
        title: String(options.title || '').trim(),
        tone: String(options.tone || 'info').trim() || 'info',
        source: String(options.source || '').trim(),
        dedupeKey: String(options.dedupeKey || '').trim(),
        dismissible: !Object.prototype.hasOwnProperty.call(options, 'dismissible') || Boolean(options.dismissible),
        actions: actions.map((action) => ({
          id: action.id,
          label: action.label,
          kind: action.kind,
        })),
      };
      // Forward these ONLY when the caller supplied them. Passing them
      // unconditionally defeats the store's hasOwnProperty check and silently
      // overrides every per-tone default.
      if (Object.prototype.hasOwnProperty.call(options, 'sticky')) {
        payload.sticky = Boolean(options.sticky);
      }
      if (Object.prototype.hasOwnProperty.call(options, 'durationMs')) {
        payload.durationMs = options.durationMs;
      }
      const toastId = enqueueToast(payload);
      registerToastActions(toastId, actions);
      return toastId;
    }

    function showShellErrorToast(message, options = {}) {
      const source = String(options.source || TOAST_SOURCE.shellAction || TOAST_SOURCE.composerAction).trim();
      const nextMessage = String(message || '').trim();
      return showToastMessage(nextMessage, {
        title: String(options.title || 'Action Failed').trim(),
        tone: 'danger',
        sticky: true,
        source,
        // Scoped to the message, not just the source: a bare `${source}:error`
        // key makes "Export failed" silently replace "Delete failed".
        dedupeKey: String(options.dedupeKey || `${source}:${hashMessage(nextMessage)}`).trim(),
      });
    }

    function toErrorMessage(error, fallback) {
      const direct = String(error && error.message || error || '').trim();
      return direct || String(fallback || 'Something went wrong.').trim();
    }

    function showSessionActionError(error, title) {
      const message = toErrorMessage(error, 'Session action failed.');
      return showShellErrorToast(message, {
        title: String(title || 'Session Action Failed').trim(),
        source: TOAST_SOURCE.sessionAction,
        dedupeKey: `${TOAST_SOURCE.sessionAction}:${hashMessage(message)}`,
      });
    }

    function showComposerActionError(error, title) {
      const message = toErrorMessage(error, 'Composer action failed.');
      return showShellErrorToast(message, {
        title: String(title || 'Composer Action Failed').trim(),
        source: TOAST_SOURCE.composerAction,
        dedupeKey: `${TOAST_SOURCE.composerAction}:${hashMessage(message)}`,
      });
    }

    // Hovering or tabbing into the stack holds every countdown, so a toast can
    // actually be read (and its actions clicked) before it expires.
    function installToastViewportListeners() {
      if (!toastViewport || typeof toastViewport.addEventListener !== 'function') {
        return function noopDispose() {};
      }
      const pause = () => { toastStore.pauseAll?.(); };
      const resume = () => { toastStore.resumeAll?.(); };
      const onKeyDown = (event) => {
        if (event.key !== 'Escape') {
          return;
        }
        const host = event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-toast-id]')
          : null;
        if (!host) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        dismissToast(host.dataset.toastId);
      };
      toastViewport.addEventListener('pointerenter', pause);
      toastViewport.addEventListener('pointerleave', resume);
      toastViewport.addEventListener('focusin', pause);
      toastViewport.addEventListener('focusout', resume);
      toastViewport.addEventListener('keydown', onKeyDown);
      return function disposeToastViewportListeners() {
        toastViewport.removeEventListener('pointerenter', pause);
        toastViewport.removeEventListener('pointerleave', resume);
        toastViewport.removeEventListener('focusin', pause);
        toastViewport.removeEventListener('focusout', resume);
        toastViewport.removeEventListener('keydown', onKeyDown);
      };
    }

    return {
      enqueueToast,
      registerToastActions,
      dismissToast,
      renderToastViewport,
      installToastViewportListeners,
      showToastMessage,
      showShellErrorToast,
      toErrorMessage,
      showSessionActionError,
      showComposerActionError,
    };
  }

  return { createToastController };
});
