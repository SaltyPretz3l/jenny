'use strict';

/* services/tools/builtin/workspace-present-tool.js — `workspace_present`
 * The tool is gated by the default-on `tools_workspace_present_enabled` feature
 * flag at registry construction (services/tools/index.js), so a flag-off build
 * never registers it.
 *
 * Presents a workspace file in the user's IDE: view='preview' targets the
 * unified Preview stage (markdown/mermaid/self-contained HTML); view=
 * 'file_map' opens the File Map stage and optionally reveals a path. The tool
 * mutates UI only — it never reads content into the transcript and never
 * edits files.
 *
 * Validation order (security-sensitive, in this exact sequence): workspace root
 * required → tool-root/IDE-root realpath match → view validated → path
 * validated where required → pathPolicy.resolvePath + assertInsideRoot (real
 * fs.realpath, symlink/junction escape guard) → stat/binary gates for preview
 * → ONE presentation event → structured synchronous result. It never awaits a
 * renderer acknowledgment, and its model-facing summary describes the REQUEST
 * ("Requested…"), never a guaranteed outcome — the renderer may coalesce or
 * defer behind a non-stealing affordance while the user is typing.
 *
 * Failures are structured and REDACTED: reasons are stable snake_case tokens
 * and messages never echo absolute/resolved paths (only the caller's own
 * workspace-relative input). */

const path = require('node:path');
const fsConstants = require('node:fs').constants;
const defaultFs = require('node:fs/promises');

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeString } = require('../../shared/normalize');
const { workspaceRootId } = require('../../workspace-root-identity');

// Kept in sync BY CONVENTION with renderer/features/renderer-ide-preview-stage.js
// (MARKDOWN_EXTENSIONS / HTML_EXTENSIONS / MAX_PREVIEW_BYTES — the renderer
// UMD and services cannot share an import; the RAIL_PANELS precedent).
const PREVIEWABLE_EXTENSIONS = new Set(['md', 'markdown', 'mmd', 'mermaid', 'html', 'htm']);
const MAX_PREVIEW_BYTES = 1_500_000;
const BINARY_SNIFF_BYTES = 8_192;
const BINARY_SNIFF_TIMEOUT_MS = 2000;
const VALID_VIEWS = new Set(['preview', 'file_map', 'change_diff']);
const CHANGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

function extensionOf(relPath) {
  const name = relPath.split('/').pop() || relPath;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// Wire-safe workspace-relative POSIX form of the caller's path input; '' when
// the input is not expressible as one (absolute, drive, escape, scheme-like).
function toRelativePosix(value) {
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

function failure({ reason, message, summary, errorCode = TOOL_ERROR_CODES.EXECUTION_FAILED, extra = {} }) {
  return {
    content: message,
    summary,
    isError: true,
    errorCode,
    metadata: {
      result_kind: 'workspace_present',
      status: 'failed',
      reason,
      ...extra,
    },
  };
}

async function realpathSafe(fsLike, target) {
  try {
    return await fsLike.realpath(target);
  } catch (_error) {
    return path.resolve(target);
  }
}

function normalizeForComparison(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function sniffPreviewFile({
  fsLike,
  resolved,
  preStat,
  timeoutMs,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  let handle = null;
  let closed = false;
  let timedOut = false;
  let timer = null;
  const closeOnce = async (candidate = handle) => {
    if (!candidate || closed) return;
    closed = true;
    try { await candidate.close?.(); } catch (_error) { /* close is best effort after a bounded sniff */ }
  };
  const flags = fsConstants.O_RDONLY
    | (fsConstants.O_NONBLOCK || 0)
    | (fsConstants.O_NOFOLLOW || 0);
  const openPromise = Promise.resolve().then(() => fsLike.open(resolved, flags));
  const operation = openPromise.then(async (opened) => {
    handle = opened;
    if (timedOut) {
      await closeOnce(opened);
      return { kind: 'timeout' };
    }
    const openedStat = typeof opened.stat === 'function' ? await opened.stat() : preStat;
    if (!openedStat?.isFile?.()) return { kind: 'unsupported_file_kind' };
    if (Number(openedStat.size) > MAX_PREVIEW_BYTES) return { kind: 'too_large' };
    const scanSize = Math.min(Math.max(0, Number(openedStat.size) || 0), BINARY_SNIFF_BYTES);
    const buffer = Buffer.alloc(scanSize);
    await opened.read(buffer, 0, scanSize, 0);
    return { kind: buffer.includes(0) ? 'binary_file' : 'ok' };
  }).catch(() => ({ kind: 'unreadable' }));
  const timeout = new Promise((resolve) => {
    timer = setTimeoutImpl(() => resolve({ kind: 'timeout' }), timeoutMs);
    timer?.unref?.();
  });
  const outcome = await Promise.race([operation, timeout]);
  if (timer !== null) clearTimeoutImpl(timer);
  if (outcome.kind === 'timeout') {
    timedOut = true;
    void openPromise.then((opened) => closeOnce(opened), () => {});
    void closeOnce();
    return outcome;
  }
  await closeOnce();
  return outcome;
}

function createWorkspacePresentTool({
  fsLike = defaultFs,
  sniffTimeoutMs = BINARY_SNIFF_TIMEOUT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const safeSniffTimeoutMs = Math.max(1, Math.min(
    Math.trunc(Number(sniffTimeoutMs)) || BINARY_SNIFF_TIMEOUT_MS,
    30_000
  ));
  return {
  name: 'workspace_present',
  description: 'Request that the user\'s workspace IDE presents a workspace surface: view="preview" renders a supported file, view="file_map" opens the dependency map, and view="change_diff" opens a recorded Jenny change for review. This is a presentation request, so the UI may defer it while the user is actively working.',
  category: 'builtin',
  readOnly: true,
  workspaceRequired: true,
  parameters: {
    type: 'object',
    properties: {
      view: {
        type: 'string',
        enum: ['preview', 'file_map', 'change_diff'],
        description: 'Which workspace surface to present.',
      },
      path: {
        type: 'string',
        description: 'Workspace-relative file path. Required for view="preview" and view="change_diff"; optional for view="file_map".',
      },
      change_id: {
        type: 'string',
        description: 'Optional recorded change id used to select the exact change when view="change_diff".',
      },
    },
    required: ['view'],
  },

  summarize(input) {
    const view = normalizeString(input?.view);
    const target = normalizeString(input?.path);
    return `Present ${view || 'workspace view'}${target ? ` of ${target}` : ''}`.trim();
  },

  async execute(input, context) {
    const service = context.workspacePresentationService;
    if (!service || typeof service.requestPresentation !== 'function') {
      return failure({
        reason: 'unavailable',
        errorCode: TOOL_ERROR_CODES.DISABLED,
        message: 'Workspace presentation is unavailable in this session.',
        summary: 'Workspace present unavailable',
      });
    }

    // 1. Workspace root required (tools are blocked without an explicit root).
    const workingDirectory = normalizeString(context.workingDirectory);
    if (!workingDirectory) {
      return failure({
        reason: 'no_workspace_root',
        errorCode: TOOL_ERROR_CODES.DISABLED,
        message: 'No tools workspace root is configured; workspace presentation is blocked.',
        summary: 'No workspace root',
      });
    }

    // 2. Tool root and IDE root must refer to the same REAL directory. The IDE
    // reads configService.getToolsWorkspaceRoot(); a drifted tool working
    // directory (stale loop state, mid-flight root switch) must fail closed
    // rather than present a file from a root the IDE is not showing.
    const configService = context.configService || context.backendService?.configService || null;
    const ideRoot = normalizeString(configService?.getToolsWorkspaceRoot?.());
    if (!ideRoot) {
      return failure({
        reason: 'no_workspace_root',
        errorCode: TOOL_ERROR_CODES.DISABLED,
        message: 'The IDE has no configured workspace root; workspace presentation is blocked.',
        summary: 'No workspace root',
      });
    }
    const [toolRootReal, ideRootReal] = await Promise.all([
      realpathSafe(fsLike, workingDirectory),
      realpathSafe(fsLike, ideRoot),
    ]);
    if (normalizeForComparison(toolRootReal) !== normalizeForComparison(ideRootReal)) {
      return failure({
        reason: 'workspace_root_mismatch',
        message: 'The tool workspace root and the IDE workspace root do not match; refusing to present across roots.',
        summary: 'Workspace root mismatch',
      });
    }

    // 3. View.
    const view = normalizeString(input?.view);
    if (!VALID_VIEWS.has(view)) {
      return failure({
        reason: 'unsupported_view',
        message: 'view must be "preview", "file_map", or "change_diff".',
        summary: 'Unsupported view',
      });
    }

    // 4. Path (required for preview; optional reveal target for file_map).
    const rawPath = normalizeString(input?.path);
    const relPath = toRelativePosix(rawPath);
    if ((view === 'preview' || view === 'change_diff') && !rawPath) {
      return failure({
        reason: 'path_required',
        message: `${view} requires a workspace-relative file path.`,
        summary: 'Presentation needs a path',
      });
    }
    if (rawPath && !relPath) {
      return failure({
        reason: 'unsafe_path',
        message: 'The requested file is not identified by a safe workspace-relative path.',
        summary: 'Unsafe path',
      });
    }
    const rawChangeId = normalizeString(input?.change_id);
    if (rawChangeId && (view !== 'change_diff' || !CHANGE_ID_PATTERN.test(rawChangeId))) {
      return failure({
        reason: 'invalid_change_id',
        message: 'change_id must be a bounded recorded change identifier for view="change_diff".',
        summary: 'Invalid change id',
      });
    }

    if (relPath) {
      // 5. Real-path containment (symlink/junction escape guard).
      let resolved;
      try {
        resolved = context.pathPolicy.resolvePath(relPath, context);
        resolved = await context.pathPolicy.assertInsideRoot(resolved, context) || resolved;
      } catch (error) {
        context.logger?.('WARN', 'workspace_present.path_rejected', {
          error_name: String(error?.name || 'Error').slice(0, 64),
        });
        return failure({
          reason: 'unsafe_path',
          message: 'The requested file resolves outside the workspace and cannot be presented.',
          summary: 'Unsafe path',
        });
      }

      // 6. Preview-only content gates: must be an existing, previewable,
      // reasonably-sized text file. file_map reveal targets skip these — a
      // missing/gitignored/unscanned node is the renderer's bounded
      // "not in map" state, never a failure here.
      if (view === 'preview') {
        const extension = extensionOf(relPath);
        if (!PREVIEWABLE_EXTENSIONS.has(extension)) {
          return failure({
            reason: 'unsupported_file',
            message: `"${relPath}" is not previewable — supported: .md, .markdown, .mmd, .mermaid, .html, .htm.`,
            summary: 'Unsupported file type',
          });
        }
        let stat;
        try {
          stat = await fsLike.stat(resolved);
        } catch (_error) {
          return failure({
            reason: 'file_missing',
            message: `"${relPath}" does not exist in the workspace.`,
            summary: 'File not found',
          });
        }
        if (stat.isDirectory()) {
          return failure({
            reason: 'is_directory',
            message: `"${relPath}" is a directory; preview needs a file.`,
            summary: 'Directory not previewable',
          });
        }
        if (!stat.isFile?.()) {
          return failure({
            reason: 'unsupported_file_kind',
            message: `"${relPath}" is not a regular file and cannot be previewed.`,
            summary: 'Unsupported file kind',
          });
        }
        if (stat.size > MAX_PREVIEW_BYTES) {
          return failure({
            reason: 'too_large',
            message: `"${relPath}" is too large to preview safely.`,
            summary: 'File too large',
          });
        }
        const sniff = await sniffPreviewFile({
          fsLike,
          resolved,
          preStat: stat,
          timeoutMs: safeSniffTimeoutMs,
          setTimeoutImpl,
          clearTimeoutImpl,
        });
        if (sniff.kind === 'unsupported_file_kind') {
          return failure({
            reason: 'unsupported_file_kind',
            message: `"${relPath}" changed into a non-regular file and cannot be previewed.`,
            summary: 'Unsupported file kind',
          });
        }
        if (sniff.kind === 'too_large') {
          return failure({
            reason: 'too_large',
            message: `"${relPath}" is too large to preview safely.`,
            summary: 'File too large',
          });
        }
        if (sniff.kind === 'binary_file') {
          return failure({
            reason: 'binary_file',
            message: `"${relPath}" appears to be binary and cannot be previewed.`,
            summary: 'Binary file',
          });
        }
        if (sniff.kind !== 'ok') {
          const event = sniff.kind === 'timeout'
            ? 'workspace_present.sniff_timeout'
            : 'workspace_present.sniff_failed';
          context.logger?.('WARN', event, { timeout_ms: safeSniffTimeoutMs });
          return failure({
            reason: 'file_unreadable',
            message: `"${relPath}" could not be read for preview.`,
            summary: 'File unreadable',
          });
        }
      }
    }

    // 7. Exactly one presentation event; the result is computed from
    // validation + dispatch only (no renderer acknowledgment is awaited).
    const sessionId = normalizeString(context.sessionId);
    const workspaceId = workspaceRootId(workingDirectory) || '';
    if (view === 'change_diff' && (!sessionId || !workspaceId)) {
      return failure({
        reason: 'presentation_context_unavailable',
        message: 'The current session or workspace identity is unavailable; refusing to present a change.',
        summary: 'Change presentation unavailable',
      });
    }
    const dispatch = service.requestPresentation({
      view,
      path: relPath,
      source: 'tool',
      ...(view === 'change_diff' ? {
        session_id: sessionId,
        workspace_id: workspaceId,
        ...(rawChangeId ? { change_id: rawChangeId } : {}),
      } : {}),
    });
    if (!dispatch || dispatch.delivered !== true) {
      return failure({
        reason: dispatch?.reason || 'renderer_unavailable',
        message: 'The workspace window is not available to receive the presentation request.',
        summary: 'Workspace window unavailable',
      });
    }

    // 8. Honest request-not-outcome wording: the renderer may
    // coalesce this request or hold it behind a non-stealing affordance.
    const what = view === 'preview'
      ? `a preview of "${relPath}"`
      : view === 'change_diff'
        ? `the recorded change to "${relPath}"`
      : relPath
        ? `the File Map highlighting "${relPath}"`
        : 'the File Map';
    return {
      content: `Requested ${what} in the workspace IDE. If the user is actively working, the IDE shows a non-intrusive prompt instead of switching immediately.`,
      summary: view === 'preview'
        ? `Requested preview of ${relPath}`
        : view === 'change_diff'
          ? `Requested change diff for ${relPath}`
        : `Requested File Map${relPath ? ` reveal of ${relPath}` : ''}`,
      isError: false,
      metadata: {
        result_kind: 'workspace_present',
        // Honest state: the renderer holds tool-initiated requests behind a
        // non-stealing chip and never acknowledges back across the bridge, so
        // deferred/not_started is everything this process can truthfully
        // claim. 'shown'/'dismissed' and 'loaded'/'failed' are reserved for a
        // future renderer-ack channel.
        presentation_state: 'deferred',
        render_state: 'not_started',
        view,
        path: relPath,
        ...(rawChangeId ? { change_id: rawChangeId } : {}),
        request_id: dispatch.request_id || '',
      },
    };
  },
  };
}

const workspacePresentTool = createWorkspacePresentTool();

module.exports = Object.assign(workspacePresentTool, {
  createWorkspacePresentTool,
});
