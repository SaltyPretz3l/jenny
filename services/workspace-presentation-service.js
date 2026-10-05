'use strict';

/* services/workspace-presentation-service.js — one-shot main→renderer
 * workspace presentation push (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md
 * Phase 6). The `workspace_present` builtin tool validates a request and this
 * service emits exactly one `workspacePresentation.onRequest` bridge event to
 * the MAIN workspace window (never a secondary window — sendBridgeEvent is
 * structurally main-window-only, see main.js sendToWindow). Deliberately NOT
 * transcript-metadata projection: a live push can never replay on reload,
 * rehydrate, or transcript re-render.
 *
 * requestPresentation() is SYNCHRONOUS from the caller's point of view: it
 * validates + dispatches and reports { delivered } without ever awaiting a
 * renderer acknowledgment (the tool's model-facing result is computed from
 * validation and dispatch alone). The payload is snake_case wire shape and
 * carries only redacted, workspace-relative data — never absolute paths.
 *
 * Outcomes arrive LATER on the separate `workspacePresentation.reportOutcome`
 * invoke: the renderer reports what it did with each request (shown, held
 * behind the prompt chip, dismissed, superseded …) and, for previews, whether
 * the document rendered. recordOutcome() accepts reports only for request ids
 * this service issued (bounded), mirrors each into the originating tool row's
 * late-event audit, and queues it for the session's NEXT model request
 * (consumeOutcomeNote → the `workspace_presentation` context block), so the
 * model learns what the user actually saw without the tool ever waiting. */

const VALID_VIEWS = Object.freeze(['preview', 'file_map', 'change_diff']);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const OUTCOME_DECISIONS = Object.freeze([
  'shown', 'shown_by_user', 'prompted', 'dismissed', 'superseded', 'rejected', 'dropped',
]);
const OUTCOME_RENDER_STATES = Object.freeze(['loaded', 'failed', 'replaced', 'cancelled']);
const MAX_TRACKED_REQUESTS = 64;
const MAX_OUTCOME_DETAIL_CHARS = 200;
const MAX_RESOURCE_COUNT = 999;
const MAX_NOTE_ENTRIES = 8;
const MAX_NOTE_PATH_CHARS = 160;
// What each renderer decision means for the model, worded as fact.
const DECISION_TEXT = Object.freeze({
  shown: 'shown in the IDE',
  shown_by_user: 'shown after the user clicked Show on the prompt',
  prompted: 'held behind a "Jenny wants to show…" prompt because the user was busy; not shown yet',
  dismissed: 'not shown: the user dismissed the prompt',
  superseded: 'not shown: a newer presentation request replaced it',
  rejected: 'not shown: the IDE could not present it (that surface is off or unavailable, or the request was invalid)',
  dropped: 'not shown: the user switched session or workspace first',
});
const { createProjectPresentationService } = require('./projects/project-presentation-service');

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

// Renderer-relayed detail can carry frame error text (attacker-influenced page
// content): collapse control characters and bound it before it is stored.
function boundedDetail(value) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, MAX_OUTCOME_DETAIL_CHARS);
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_RESOURCE_COUNT) : 0;
}

function describeOutcome(record) {
  // Paths are workspace-relative but may hold quotes or newlines on POSIX
  // filesystems: quote and bound them before they enter the system tier.
  const quotedPath = JSON.stringify(record.path.slice(0, MAX_NOTE_PATH_CHARS));
  const target = record.view === 'preview'
    ? `Preview of ${quotedPath}`
    : record.view === 'change_diff'
      ? `Change diff for ${quotedPath}`
      : record.path ? `File Map at ${quotedPath}` : 'File Map';
  const parts = [record.decision ? DECISION_TEXT[record.decision] : 'no IDE decision reported yet'];
  if (record.render === 'loaded') {
    parts.push('the document rendered');
  } else if (record.render === 'failed') {
    parts.push(record.detail
      ? `the document failed to render (IDE-reported, may quote untrusted page text: ${JSON.stringify(record.detail)})`
      : 'the document failed to render');
  } else if (record.render === 'replaced') {
    parts.push('another preview replaced it before it finished rendering');
  } else if (record.render === 'cancelled') {
    parts.push('the Preview moved to another file or workspace, or closed, before it finished rendering');
  }
  const external = [];
  if (record.externalScripts) external.push(`${record.externalScripts} external script${record.externalScripts === 1 ? '' : 's'}`);
  if (record.externalStylesheets) external.push(`${record.externalStylesheets} external stylesheet${record.externalStylesheets === 1 ? '' : 's'}`);
  if (external.length) {
    parts.push(`it references ${external.join(' and ')}, which the self-contained in-app Preview does not load, so that code did not run and those styles did not apply there`);
  }
  return `- ${target} (request ${record.requestId}): ${parts.join('; ')}.`;
}

class WorkspacePresentationService {
  constructor({
    sendBridgeEvent,
    isRendererAvailable,
    logger,
    getUiWorkspaceRoot,
    projectAuthorityProvider,
  } = {}) {
    this._sendBridgeEvent = typeof sendBridgeEvent === 'function' ? sendBridgeEvent : null;
    this._isRendererAvailable = typeof isRendererAvailable === 'function'
      ? isRendererAvailable
      : () => this._sendBridgeEvent !== null;
    this._logger = typeof logger === 'function' ? logger : () => {};
    this._getUiWorkspaceRoot = typeof getUiWorkspaceRoot === 'function'
      ? getUiWorkspaceRoot
      : () => '';
    this._projectAuthorityProvider = projectAuthorityProvider;
    this._sequence = 0;
    // request_id → tracked record (insertion-ordered; oldest evicted first).
    this._tracked = new Map();
    this._outcomeListener = null;
  }

  // Late-event audit sink: (sessionId, callId, lateEvent) => void. Wired after
  // the backend service exists (services/main/backend-service-wiring.js).
  setOutcomeListener(listener) {
    this._outcomeListener = typeof listener === 'function' ? listener : null;
  }

  _track(requestId, { view, path, sessionId, callId }) {
    this._tracked.set(requestId, {
      requestId,
      view,
      path,
      sessionId,
      callId,
      decision: '',
      render: '',
      detail: '',
      externalScripts: 0,
      externalStylesheets: 0,
      unreported: false,
    });
    while (this._tracked.size > MAX_TRACKED_REQUESTS) {
      this._tracked.delete(this._tracked.keys().next().value);
    }
  }

  /**
   * Renderer report for one issued request. Payload (snake_case wire shape):
   *   { request_id, decision?, render?, detail?, external_scripts?, external_stylesheets? }
   * Returns { ok: true } or { ok: false, reason } — never throws across IPC.
   */
  recordOutcome(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, reason: 'invalid_payload' };
    }
    const record = this._tracked.get(normalizeOpaqueId(payload.request_id));
    if (!record) {
      return { ok: false, reason: 'unknown_request' };
    }
    const decision = payload.decision === undefined ? '' : String(payload.decision);
    const render = payload.render === undefined ? '' : String(payload.render);
    if ((decision && !OUTCOME_DECISIONS.includes(decision))
      || (render && !OUTCOME_RENDER_STATES.includes(render))
      || (!decision && !render)) {
      return { ok: false, reason: 'invalid_outcome' };
    }
    if (decision) record.decision = decision;
    if (render) {
      record.render = render;
      record.detail = render === 'failed' ? boundedDetail(payload.detail) : '';
      record.externalScripts = boundedCount(payload.external_scripts);
      record.externalStylesheets = boundedCount(payload.external_stylesheets);
    }
    record.unreported = true;
    // Best-effort audit: a report that beats the tool row's persistence (an
    // immediate rejection) finds no row and is not retried; the model-facing
    // note below never depends on it.
    if (this._outcomeListener && record.sessionId && record.callId) {
      try {
        this._outcomeListener(record.sessionId, record.callId, {
          kind: 'presentation_outcome',
          method: 'workspacePresentation.reportOutcome',
          request_id: record.requestId,
          decision: record.decision,
          render: record.render,
          external_scripts: record.externalScripts,
          external_stylesheets: record.externalStylesheets,
          received_at: new Date().toISOString(),
        });
      } catch (error) {
        this._logger('WARN', 'workspace_presentation.outcome_audit_failed', {
          error_name: String(error?.name || 'Error').slice(0, 64),
        });
      }
    }
    return { ok: true };
  }

  /**
   * The session's not-yet-reported outcomes as one model-facing note (or ''),
   * marking them reported. Called once per chat request during context
   * assembly, so each outcome reaches the model on the next request after it
   * arrives.
   */
  consumeOutcomeNote(sessionId) {
    const normalizedSessionId = normalizeOpaqueId(sessionId);
    if (!normalizedSessionId) return '';
    const pending = [...this._tracked.values()]
      .filter((record) => record.unreported && record.sessionId === normalizedSessionId);
    if (!pending.length) return '';
    for (const record of pending) record.unreported = false;
    const shown = pending.slice(-MAX_NOTE_ENTRIES);
    return [
      '## Workspace Presentation Updates',
      'What the user\'s IDE did with your earlier workspace_present requests (reported by the IDE after those tool results were returned):',
      ...shown.map(describeOutcome),
      ...(pending.length > shown.length ? [`(${pending.length - shown.length} older update(s) omitted.)`] : []),
    ].join('\n');
  }

  forSessionAuthority(authority, sessionId) {
    if (this._projectAuthorityProvider === undefined || this._projectAuthorityProvider === null) {
      throw new TypeError('Scoped presentation requires a project authority provider.');
    }
    return createProjectPresentationService({
      owner: this,
      authority,
      sessionId,
      projectAuthorityProvider: this._projectAuthorityProvider,
      getUiWorkspaceRoot: this._getUiWorkspaceRoot,
    });
  }

  _requestPresentationForAuthority(payload, scopedService) {
    return this.requestPresentation(payload, scopedService);
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
    call_id: callId = '',
  } = {}, scopedService = null) {
    let scopedIdentity = null;
    if (scopedService) {
      try {
        scopedIdentity = scopedService.assertCurrent();
      } catch (error) {
        this._logger('WARN', 'workspace_presentation.context_rejected', {
          reason: String(error?.reason || 'project_authority_stale').slice(0, 64),
        });
        return { delivered: false, reason: 'workspace_context_changed' };
      }
    }
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
    const normalizedSessionId = normalizeOpaqueId(scopedIdentity?.session_id || sessionId);
    const normalizedWorkspaceId = normalizeOpaqueId(scopedIdentity?.workspace_id || workspaceId, 64);
    const normalizedChangeId = changeId ? normalizeOpaqueId(changeId) : '';
    if (scopedService && (!normalizedSessionId
      || !/^root_[0-9a-f]{24}$/i.test(normalizedWorkspaceId))) {
      return { delivered: false, reason: 'workspace_context_changed' };
    }
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
      if (scopedService) scopedService.assertCurrent();
      this._sendBridgeEvent('workspacePresentation.onRequest', {
        view,
        path: relPath,
        request_id: requestId,
        source: source === 'tool' ? 'tool' : String(source || 'tool').slice(0, 32),
        ...(scopedService || view === 'change_diff' ? {
          session_id: normalizedSessionId,
          workspace_id: normalizedWorkspaceId.toLowerCase(),
        } : {}),
        ...(view === 'change_diff' && normalizedChangeId ? { change_id: normalizedChangeId } : {}),
      });
    } catch (error) {
      if (error?.reason) {
        this._logger('WARN', 'workspace_presentation.context_rejected', {
          reason: String(error.reason).slice(0, 64),
        });
        return { delivered: false, reason: 'workspace_context_changed' };
      }
      this._logger('WARN', 'workspace_presentation.dispatch_failed', {
        error_name: String(error?.name || 'Error').slice(0, 64),
      });
      return { delivered: false, reason: 'dispatch_failed' };
    }
    this._track(requestId, {
      view,
      path: relPath,
      sessionId: normalizedSessionId,
      callId: normalizeOpaqueId(callId),
    });
    return { delivered: true, request_id: requestId };
  }
}

module.exports = {
  OUTCOME_DECISIONS,
  OUTCOME_RENDER_STATES,
  VALID_VIEWS,
  WorkspacePresentationService,
  normalizeRelativePosixPath,
};
