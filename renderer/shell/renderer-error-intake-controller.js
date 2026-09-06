/**
 * renderer/shell/renderer-error-intake-controller.js
 *
 * Flag-gated adapter from the existing toast methods to error intake.
 * When disabled or unavailable, every adapter passes through unchanged.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/error-intake'));
    return;
  }
  root.rendererErrorIntakeControllerUtils = factory(root.rendererErrorIntake);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (injectedIntake) {
  'use strict';

  function resolveIntake(provided) {
    if (provided && typeof provided.routeError === 'function') return provided;
    if (typeof globalThis !== 'undefined') {
      var fromGlobal = globalThis.rendererErrorIntake;
      if (fromGlobal && typeof fromGlobal.routeError === 'function') return fromGlobal;
    }
    if (injectedIntake && typeof injectedIntake.routeError === 'function') return injectedIntake;
    return null;
  }

  function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function createErrorIntakeController(deps) {
    var settings = deps || {};
    var intake = resolveIntake(settings.intake);
    var isEnabled = typeof settings.isEnabled === 'function' ? settings.isEnabled : function () { return false; };
    var constants = settings.constants || {};
    var TOAST_SOURCE = constants.TOAST_SOURCE || {};
    var toast = settings.toast || {};
    var rawShowToastMessage = typeof toast.showToastMessage === 'function' ? toast.showToastMessage : function () { return ''; };
    var rawShowShellErrorToast = typeof toast.showShellErrorToast === 'function' ? toast.showShellErrorToast : rawShowToastMessage;
    var rawShowSessionActionError = typeof toast.showSessionActionError === 'function' ? toast.showSessionActionError : rawShowToastMessage;
    var rawShowComposerActionError = typeof toast.showComposerActionError === 'function' ? toast.showComposerActionError : rawShowToastMessage;
    var toErrorMessage = typeof toast.toErrorMessage === 'function'
      ? toast.toErrorMessage
      : function fallbackToErrorMessage(error, fallback) {
        var direct = normalizeText(String((error && error.message) || error || ''));
        return direct || normalizeText(String(fallback || 'Something went wrong.'));
      };
    var sinks = settings.sinks || {};
    /* Banner/auth/startup surfaces own their rendering, so absent sinks
     * intentionally no-op. */
    var showBanner = typeof sinks.showBanner === 'function' ? sinks.showBanner : null;
    var errorCenter = sinks.errorCenter && typeof sinks.errorCenter.record === 'function' ? sinks.errorCenter : null;
    var onRouted = typeof sinks.onRouted === 'function' ? sinks.onRouted : null;

    function intakeActive() {
      return intake !== null && isEnabled() === true;
    }

    /**
     * Route an error through the intake table and dispatch its primary
     * surface. Accepts anything normalizeErrorEnvelope accepts.
     * @param {*} input
     * @param {Object} [context] - origin/source/ids/inflight signals
     * @returns {{route: Object|null, toastId: string}}
     */
    function reportError(input, context) {
      if (!intake) {
        /* Core unavailable — never lose an error; fall back raw. */
        var fallbackId = rawShowShellErrorToast(toErrorMessage(input, 'Something went wrong.'), {});
        return { route: null, toastId: fallbackId };
      }
      var route = intake.routeError(input, context);
      var toastId = '';
      if (route.surface === 'toast' && route.toast) {
        toastId = rawShowToastMessage(route.toast.message, {
          title: route.toast.title,
          tone: route.toast.tone,
          sticky: route.toast.sticky,
          durationMs: route.toast.sticky ? undefined : route.toast.durationMs,
          source: route.toast.source,
          dedupeKey: route.toast.dedupeKey,
        });
      } else if (route.surface === 'banner' && showBanner) {
        try { showBanner(route.envelope, route.banner); } catch (_err) { /* sink owns its failures */ }
      }
      /* 'timeline' and 'none' suppress the toast by design: the timeline
       * card renders organically from message state via the projector;
       * cancelled/denied and background polls stay history-only. */
      if (route.recordToErrorCenter && errorCenter) {
        try { errorCenter.record(route.envelope); } catch (_err) { /* sink owns its failures */ }
      }
      if (onRouted) {
        try { onRouted(route, toastId); } catch (_err) { /* observability only */ }
      }
      return { route: route, toastId: toastId };
    }

    /**
     * Flag-gated reportError for W9+ callsite migrations: returns null
     * when routing is off (or the core is absent) so callers fall back
     * to their legacy surface, and the route result when it is on.
     * @param {*} input
     * @param {Object} [context]
     * @returns {{route: Object, toastId: string}|null}
     */
    function reportErrorWhenActive(input, context) {
      if (!intakeActive()) return null;
      return reportError(input, context);
    }

    /* ── The four toast method names (compatibility shim) ──
     * showToastMessage stays a passthrough — success/info traffic and
     * direct tone choices are not intake's business in W8. The three
     * error wrappers route when the flag is on. */

    function showToastMessage(message, options) {
      return rawShowToastMessage(message, options || {});
    }

    function showShellErrorToast(message, options) {
      var opts = options || {};
      if (!intakeActive()) {
        return rawShowShellErrorToast(message, opts);
      }
      var source = normalizeText(opts.source) || normalizeText(TOAST_SOURCE.shellAction) || normalizeText(TOAST_SOURCE.composerAction);
      return reportError({
        message: String(message == null ? '' : message),
        options: {
          title: normalizeText(opts.title) || 'Action Failed',
          source: source,
          dedupeKey: normalizeText(opts.dedupeKey) || (source + ':error'),
          tone: 'danger',
        },
      }, { origin: 'shell-action' }).toastId;
    }

    /* showSessionActionError and showComposerActionError share one body:
     * (error, title) -> a danger toast routed through reportError, differing
     * only in the toast source, the default message, and the default title.
     * (showShellErrorToast above keeps its own body — it takes a pre-formed
     * message + an options bag with source/dedupeKey overrides.) */
    function reportShellActionError(rawFn, error, title, source, defaultMessage, defaultTitle) {
      if (!intakeActive()) {
        return rawFn(error, title);
      }
      return reportError({
        message: toErrorMessage(error, defaultMessage),
        options: {
          title: normalizeText(title) || defaultTitle,
          source: source,
          dedupeKey: source + ':error',
          tone: 'danger',
        },
      }, { origin: 'shell-action' }).toastId;
    }

    function showSessionActionError(error, title) {
      return reportShellActionError(
        rawShowSessionActionError, error, title,
        normalizeText(TOAST_SOURCE.sessionAction), 'Session action failed.', 'Session Action Failed'
      );
    }

    function showComposerActionError(error, title) {
      return reportShellActionError(
        rawShowComposerActionError, error, title,
        normalizeText(TOAST_SOURCE.composerAction), 'Composer action failed.', 'Composer Action Failed'
      );
    }

    return {
      reportError: reportError,
      reportErrorWhenActive: reportErrorWhenActive,
      showToastMessage: showToastMessage,
      showShellErrorToast: showShellErrorToast,
      showSessionActionError: showSessionActionError,
      showComposerActionError: showComposerActionError,
    };
  }

  return { createErrorIntakeController: createErrorIntakeController };
});
