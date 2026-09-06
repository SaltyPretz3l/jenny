'use strict';

/* services/workspace-presentation-service.js — one-shot main→renderer
 * workspace presentation push (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md
 * Phase 6). The `workspace_present` builtin tool validates a request and this
 * service emits exactly one `workspacePresentation.onRequest` bridge event to
 * the MAIN workspace window (never overlay/comet windows — sendBridgeEvent is
 * structurally main-window-only, see main.js sendToWindow). Deliberately NOT
 * transcript-metadata projection: a live push can never replay on reload,
 * rehydrate, or transcript re-render.
 *
 * requestPresentation() is SYNCHRONOUS from the caller's point of view: it
 * validates + dispatches and reports { delivered } without ever awaiting a
 * renderer acknowledgment (the tool's model-facing result is computed from
 * validation and dispatch alone). The payload is snake_case wire shape and
 * carries only redacted, workspace-relative data — never absolute paths. */

const VALID_VIEWS = Object.freeze(['preview', 'file_map', 'change_diff']);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

// Wire-payload path gate: workspace-relative POSIX only. Anything absolute,
// drive-lettered, escaping, or scheme-like collapses to '' — the service is
// the last line before the payload crosses the IPC boundary, so it re-checks
// even though the tool already validated.
function normalizeRelativePosixPath(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const raw = value.trim().replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.includes(':') || raw.startsWith('/')) {
    return '';
  }
  const segments = raw.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (!segments.length || segments.some((segment) => segment === '..')) {
    return '';
  }
  return segments.join('/');
}

function normalizeOpaqueId(value, maxLength = 160) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= maxLength && OPAQUE_ID_PATTERN.test(normalized)
    ? normalized
    : '';
}

class WorkspacePresentationService {
  constructor({ sendBridgeEvent, isRendererAvailable, logger } = {}) {
    this._sendBridgeEvent = typeof sendBridgeEvent === 'function' ? sendBridgeEvent : null;
    this._isRendererAvailable = typeof isRendererAvailable === 'function'
      ? isRendererAvailable
      : () => this._sendBridgeEvent !== null;
    this._logger = typeof logger === 'function' ? logger : () => {};
    this._sequence = 0;
  }

  /**
   * Emit one presentation request. Returns a structured, synchronous result:
   *   { delivered: true, request_id }            — event dispatched
   *   { delivered: false, reason }               — invalid view/renderer gone
   * Never throws across the seam and never awaits the renderer.
   */
  requestPresentation({
    view,
    path = '',
    source = 'tool',
    session_id: sessionId = '',
    workspace_id: workspaceId = '',
    change_id: changeId = '',
  } = {}) {
    if (!VALID_VIEWS.includes(view)) {
      return { delivered: false, reason: 'unsupported_view' };
    }
    if (!this._sendBridgeEvent || this._isRendererAvailable() !== true) {
      this._logger('WARN', 'workspace_presentation.renderer_unavailable', { view });
      return { delivered: false, reason: 'renderer_unavailable' };
    }
    const relPath = normalizeRelativePosixPath(path);
    if (path && !relPath) {
      // The tool validates first, so a rejected path here means a caller bug —
      // fail closed rather than emitting a payload with a dropped field.
      this._logger('WARN', 'workspace_presentation.path_rejected', { view });
      return { delivered: false, reason: 'unsafe_path' };
    }
    const normalizedSessionId = normalizeOpaqueId(sessionId);
    const normalizedWorkspaceId = normalizeOpaqueId(workspaceId, 64);
    const normalizedChangeId = changeId ? normalizeOpaqueId(changeId) : '';
    if (view === 'change_diff' && (!relPath || !normalizedSessionId
      || !/^root_[0-9a-f]{24}$/i.test(normalizedWorkspaceId)
      || (changeId && !normalizedChangeId))) {
      this._logger('WARN', 'workspace_presentation.change_diff_rejected', {
        has_path: Boolean(relPath),
        has_session: Boolean(normalizedSessionId),
        has_workspace: Boolean(normalizedWorkspaceId),
        has_change: Boolean(normalizedChangeId),
      });
      return { delivered: false, reason: 'invalid_change_diff' };
    }
    this._sequence += 1;
    const requestId = `wsp-${Date.now().toString(36)}-${this._sequence}`;
    try {
      this._sendBridgeEvent('workspacePresentation.onRequest', {
        view,
        path: relPath,
        request_id: requestId,
        source: source === 'tool' ? 'tool' : String(source || 'tool').slice(0, 32),
        ...(view === 'change_diff' ? {
          session_id: normalizedSessionId,
          workspace_id: normalizedWorkspaceId.toLowerCase(),
          ...(normalizedChangeId ? { change_id: normalizedChangeId } : {}),
        } : {}),
      });
    } catch (error) {
      this._logger('WARN', 'workspace_presentation.dispatch_failed', {
        error_name: String(error?.name || 'Error').slice(0, 64),
      });
      return { delivered: false, reason: 'dispatch_failed' };
    }
    return { delivered: true, request_id: requestId };
  }
}

module.exports = {
  VALID_VIEWS,
  WorkspacePresentationService,
  normalizeRelativePosixPath,
};
