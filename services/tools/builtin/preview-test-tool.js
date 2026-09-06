'use strict';

/* services/tools/builtin/preview-test-tool.js — `preview_test`
 *
 * One-shot workspace HTML tester backed by BrowserSessionService. Validation
 * order is security-sensitive: service availability → workspace root realpath
 * → relative HTML path → viewport → bounded wait → bounded click/type events
 * → real-path containment → regular-file/size gates → hidden strict-workspace
 * browser session → settle/events/inspect → exactly-one close. No caller script
 * is ever evaluated, and result text never includes resolved absolute paths. */

const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { safeBrowserReason } = require('../../browser-interaction-utils');
const {
  formatRenderSummary,
  summarizeRenderBitmap,
} = require('../../browser-render-summary');
const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeString } = require('../../shared/normalize');

const PREVIEW_TEST_EXTENSIONS = new Set(['html', 'htm']);
const MAX_PREVIEW_TEST_BYTES = 5_000_000;
const MAX_EVENTS = 10;
const MAX_WAIT_MS = 5000;
const DEFAULT_WAIT_MS = 500;
const VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1280, height: 800 }),
  mobile: Object.freeze({ width: 390, height: 844 }),
  tablet: Object.freeze({ width: 820, height: 1180 }),
});
const MAX_ERROR_TEXTS = 10;
const MAX_ERROR_TEXT_CHARS = 300;

function failure({ reason, errorCode, message, summary }) {
  return {
    content: message,
    summary,
    isError: true,
    errorCode,
    metadata: {
      result_kind: 'preview_test',
      status: 'failed',
      reason,
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

function toRelativePosix(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const raw = value.trim().replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.includes(':') || raw.startsWith('/')) {
    return '';
  }
  const segments = raw.split('/').filter((segment) => segment && segment !== '.');
  if (!segments.length || segments.some((segment) => segment === '..')) {
    return '';
  }
  return segments.join('/');
}

function extensionOf(relPath) {
  const name = relPath.split('/').pop() || relPath;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function clampWaitMs(value) {
  let numeric;
  try {
    numeric = Number(value);
  } catch (_error) {
    return DEFAULT_WAIT_MS;
  }
  if (!Number.isFinite(numeric)) {
    return DEFAULT_WAIT_MS;
  }
  return Math.max(0, Math.min(Math.trunc(numeric), MAX_WAIT_MS));
}

function stripSensitiveValues(text, sensitiveValues) {
  let result = String(text ?? '');
  for (const sensitiveValue of sensitiveValues || []) {
    const candidate = String(sensitiveValue || '').trim();
    if (!candidate) continue;
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), '[workspace path]');
  }
  return result;
}

function redactKnownPaths(value, sensitiveValues) {
  const flattened = safeBrowserReason(value, 'preview_probe_failed').split(/\s+/).join(' ');
  return stripSensitiveValues(flattened, sensitiveValues).slice(0, 500);
}

function sourceBasename(sourceId) {
  const rawSource = String(sourceId ?? '').trim();
  if (!rawSource) {
    return '';
  }
  return rawSource.split(/[?#]/)[0].split(/[\\/]/).filter(Boolean).pop() || '';
}

function sourceLocationText(entry) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }
  const name = sourceBasename(entry.source_id);
  if (!name) {
    return '';
  }
  const line = Number.isInteger(entry.line) && entry.line > 0 ? entry.line : null;
  return line === null ? name : `${name}:${line}`;
}

function basenameStackPaths(value) {
  return String(value ?? '').replace(
    /(?:[a-z][a-z\d+.-]*:\/\/|[a-z]:[\\/]|\/)[^()\s]*?:\d+(?::\d+)?/gi,
    (token) => {
      const match = /^(.*?)(:\d+(?::\d+)?)$/.exec(token);
      if (!match) return token;
      const name = sourceBasename(match[1]);
      return name ? `${name}${match[2]}` : token;
    }
  );
}

function boundedStackLocation(entry, sensitiveValues) {
  if (!entry || typeof entry.stack !== 'string') {
    return '';
  }
  const locationLine = entry.stack
    .split(/\r?\n/)
    .find((line) => /:\d+(?::\d+)?(?=$|[\s)])/.test(line));
  if (!locationLine) {
    return '';
  }
  const flattened = basenameStackPaths(locationLine.trim())
    .split(/\s+/)
    .join(' ');
  return stripSensitiveValues(flattened, sensitiveValues)
    .slice(0, 160);
}

function boundedErrorText(value, sensitiveValues, { pageError = false } = {}) {
  const raw = value && typeof value === 'object' ? value.message : value;
  const flattened = String(raw ?? '').split(/\s+/).join(' ').trim();
  const message = stripSensitiveValues(flattened, sensitiveValues);
  const stackLocation = pageError ? boundedStackLocation(value, sensitiveValues) : '';
  const location = stackLocation || sourceLocationText(value);
  const suffix = location ? ` (${location})` : '';
  return `${message.slice(0, Math.max(0, MAX_ERROR_TEXT_CHARS - suffix.length))}${suffix}`
    .slice(0, MAX_ERROR_TEXT_CHARS);
}

function createPreviewTestTool({
  fsLike = require('node:fs/promises'),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const settle = (delayMs) => new Promise((resolve) => {
    let timer = null;
    timer = setTimeoutImpl(() => {
      if (timer !== null) clearTimeoutImpl(timer);
      resolve();
    }, delayMs);
    timer?.unref?.();
  });

  return {
    name: 'preview_test',
    description: 'Load one workspace HTML file in a hidden, network-isolated sandbox and report what happened: render state, console errors, and page errors, optionally after bounded click/type interactions and at a chosen viewport. Read-only and one-shot; it never navigates off the file, reaches the network, or evaluates caller scripts.',
    category: 'builtin',
    readOnly: true,
    workspaceRequired: true,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative path of the .html/.htm file to test.',
        },
        viewport: {
          type: 'string',
          enum: ['desktop', 'mobile', 'tablet'],
          description: 'Viewport preset for responsiveness checks. Default desktop (1280x800); mobile is 390x844, tablet 820x1180.',
        },
        wait_ms: {
          type: 'integer',
          description: 'Settle time in milliseconds after load (and after events) before results are read. 0-5000, default 500.',
        },
        screenshot: {
          type: 'boolean',
          description: 'Attach a PNG screenshot of the rendered page as a session artifact. Default false.',
        },
        events: {
          type: 'array',
          description: 'Up to 10 bounded interactions applied in order after load. Each item: {action: "click"|"type", selector, text?, press_enter?}. Selector misses are reported per event, not fatal.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['click', 'type'] },
              selector: { type: 'string' },
              text: { type: 'string' },
              press_enter: { type: 'boolean' },
            },
            required: ['action', 'selector'],
          },
        },
      },
      required: ['path'],
    },

    summarize(input) {
      const relPath = normalizeString(input?.path) || 'HTML file';
      const viewport = normalizeString(input?.viewport) || 'desktop';
      return `Preview-test ${relPath} (${viewport})`.slice(0, 500);
    },

    async execute(input, context = {}) {
      const service = context.browserSessionService;
      if (
        !service
        || typeof service.open !== 'function'
        || typeof service.inspect !== 'function'
        || typeof service.close !== 'function'
      ) {
        return failure({
          reason: 'unavailable',
          errorCode: TOOL_ERROR_CODES.DISABLED,
          message: 'Workspace preview testing is unavailable in this session.',
          summary: 'Preview test unavailable',
        });
      }

      // This tool never touches the IDE window, so it intentionally has no
      // tool-root/IDE-root match check. The browser and path policy own access.
      const workingDirectory = normalizeString(context.workingDirectory);
      if (!workingDirectory) {
        return failure({
          reason: 'no_workspace_root',
          errorCode: TOOL_ERROR_CODES.DISABLED,
          message: 'No tools workspace root is configured; preview testing is blocked.',
          summary: 'No workspace root',
        });
      }
      const realWorkspaceRoot = await realpathSafe(fsLike, workingDirectory);

      const rawPath = normalizeString(input?.path);
      if (!rawPath) {
        return failure({
          reason: 'path_required',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: 'preview_test requires a workspace-relative HTML file path.',
          summary: 'Preview test needs a path',
        });
      }
      const relPath = toRelativePosix(rawPath);
      if (!relPath) {
        return failure({
          reason: 'unsafe_path',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: 'The requested file is not identified by a safe workspace-relative path.',
          summary: 'Unsafe preview path',
        });
      }
      if (!PREVIEW_TEST_EXTENSIONS.has(extensionOf(relPath))) {
        return failure({
          reason: 'unsupported_extension',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: `"${relPath}" is not an HTML file; preview_test supports .html and .htm.`,
          summary: 'Unsupported preview extension',
        });
      }

      const viewport = normalizeString(input?.viewport) || 'desktop';
      if (!Object.prototype.hasOwnProperty.call(VIEWPORTS, viewport)) {
        return failure({
          reason: 'invalid_viewport',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: 'viewport must be "desktop", "mobile", or "tablet".',
          summary: 'Invalid preview viewport',
        });
      }

      const waitMs = clampWaitMs(input?.wait_ms === undefined ? DEFAULT_WAIT_MS : input.wait_ms);
      const rawEvents = input?.events;
      if (rawEvents !== undefined && !Array.isArray(rawEvents)) {
        return failure({
          reason: 'invalid_event',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: 'events must be an array of click or type interactions.',
          summary: 'Invalid preview event',
        });
      }
      if (Array.isArray(rawEvents) && rawEvents.length > MAX_EVENTS) {
        return failure({
          reason: 'too_many_events',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: `preview_test accepts at most ${MAX_EVENTS} events.`,
          summary: 'Too many preview events',
        });
      }
      const events = [];
      for (const event of rawEvents || []) {
        const action = normalizeString(event?.action);
        const selector = normalizeString(event?.selector);
        if (
          !event
          || typeof event !== 'object'
          || Array.isArray(event)
          || !['click', 'type'].includes(action)
          || !selector
        ) {
          return failure({
            reason: 'invalid_event',
            errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
            message: 'Each event must provide action "click" or "type" and a non-empty selector.',
            summary: 'Invalid preview event',
          });
        }
        events.push({
          action,
          selector,
          text: String(event.text ?? ''),
          press_enter: event.press_enter === true,
        });
      }

      let resolvedRealPath;
      let resolved;
      try {
        resolved = context.pathPolicy.resolvePath(relPath, context);
        resolvedRealPath = await context.pathPolicy.assertInsideRoot(resolved, context) || resolved;
      } catch (error) {
        if (error?.code === 'ENOENT' && resolved) {
          // A missing leaf cannot be realpathed by some path-policy fakes. It
          // still proceeds only to the non-mutating stat gate, which reports
          // unreadable_file; no browser window can open for a missing target.
          resolvedRealPath = resolved;
        } else {
          context.logger?.('WARN', 'preview_test.path_rejected', {
            error_name: String(error?.name || 'Error').slice(0, 64),
          });
          return failure({
            reason: 'unsafe_path',
            errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
            message: 'The requested file resolves outside the workspace and cannot be preview-tested.',
            summary: 'Unsafe preview path',
          });
        }
      }

      let stat;
      try {
        stat = await fsLike.stat(resolvedRealPath);
      } catch (_error) {
        return failure({
          reason: 'unreadable_file',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: `"${relPath}" does not exist or cannot be read.`,
          summary: 'Preview file unreadable',
        });
      }
      if (!stat?.isFile?.()) {
        return failure({
          reason: 'unsupported_file_kind',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: `"${relPath}" is not a regular file and cannot be preview-tested.`,
          summary: 'Unsupported preview file kind',
        });
      }
      if (Number(stat.size) > MAX_PREVIEW_TEST_BYTES) {
        return failure({
          reason: 'too_large',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: `"${relPath}" is too large to preview-test safely.`,
          summary: 'Preview file too large',
        });
      }

      const sessionId = `preview_test_${crypto.randomBytes(6).toString('hex')}`;
      const url = pathToFileURL(resolvedRealPath).toString();
      const sensitiveValues = [realWorkspaceRoot, resolvedRealPath, url];
      let opened = false;
      try {
        try {
          await service.open({
            sessionId,
            streamId: sessionId,
            url,
            bounds: VIEWPORTS[viewport],
            allowedFileRoots: [realWorkspaceRoot],
            strictWorkspaceOnly: true,
          });
          opened = true;
        } catch (error) {
          const reason = redactKnownPaths(error?.message || error, sensitiveValues);
          return {
            content: `Preview-tested "${relPath}": the page failed to load (${reason}); viewport ${viewport}.`,
            summary: `Preview-tested ${relPath}: 0 console errors`,
            isError: false,
            metadata: {
              result_kind: 'preview_test',
              render_state: 'failed',
              viewport,
              path: relPath,
              console_error_count: 0,
              console_errors: [],
              page_errors: [],
              events: [],
            },
          };
        }

        await settle(waitMs);
        const eventResults = [];
        for (const event of events) {
          const result = event.action === 'click'
            ? await service.click(sessionId, { selector: event.selector })
            : await service.type(sessionId, {
              selector: event.selector,
              text: event.text,
              press_enter: event.press_enter,
            });
          eventResults.push({ action: event.action, status: String(result?.status || '') });
        }
        if (events.length) {
          await settle(waitMs);
        }

        const inspected = await service.inspect(sessionId);
        let screenshotCapture = null;
        let renderSummary = null;
        let screenshotError = '';
        if (typeof service.screenshot === 'function') {
          try {
            screenshotCapture = await service.screenshot(sessionId);
            const thumbnail = screenshotCapture?.thumbnail;
            renderSummary = summarizeRenderBitmap({
              bitmap: thumbnail?.bitmap,
              width: thumbnail?.width,
              height: thumbnail?.height,
            });
          } catch (error) {
            screenshotError = redactKnownPaths(error?.message || error, sensitiveValues);
          }
        }
        const consoleEntries = Array.isArray(inspected?.console_messages)
          ? inspected.console_messages.filter((entry) => entry?.level === 3)
          : [];
        const pageEntries = Array.isArray(inspected?.page_errors) ? inspected.page_errors : [];
        const consoleErrors = consoleEntries
          .slice(0, MAX_ERROR_TEXTS)
          .map((entry) => boundedErrorText(entry, sensitiveValues));
        const pageErrors = pageEntries
          .slice(0, MAX_ERROR_TEXTS)
          .map((entry) => boundedErrorText(entry, sensitiveValues, { pageError: true }));
        const consoleErrorCount = consoleEntries.length + pageEntries.length;
        let generatedArtifacts;
        let screenshotLine = '';
        if (input?.screenshot === true) {
          const chatSessionId = normalizeString(context.sessionId);
          if (
            !chatSessionId
            || typeof context.artifactService?.createBinaryArtifact !== 'function'
          ) {
            screenshotError ||= 'artifact service unavailable';
          } else if (!Buffer.isBuffer(screenshotCapture?.buffer)) {
            screenshotError ||= 'screenshot capture unavailable';
          } else {
            try {
              const created = await context.artifactService.createBinaryArtifact(chatSessionId, {
                content: screenshotCapture.buffer,
                mimeType: 'image/png',
                artifactKind: 'image',
                title: 'preview_test screenshot',
                fileName: 'preview-test-screenshot.png',
                width: screenshotCapture.width,
                height: screenshotCapture.height,
                png_validated: true,
              });
              // The artifact service returns `{ output, metadata }`; the
              // bridge consumes the metadata record (artifact_id, display_path, ...).
              const artifact = created?.metadata;
              if (!artifact?.artifact_id) {
                throw new Error('artifact service returned no artifact record');
              }
              generatedArtifacts = [artifact];
              screenshotLine = `Screenshot attached: ${artifact.display_path}`;
            } catch (error) {
              screenshotError = redactKnownPaths(error?.message || error, sensitiveValues);
            }
          }
        }
        const contentLines = [
          `Preview-tested "${relPath}": loaded with ${consoleErrorCount} console error(s), applied ${eventResults.length} event(s), viewport ${viewport}.`,
          formatRenderSummary(renderSummary),
        ];
        if (screenshotLine) contentLines.push(screenshotLine);
        const verdictSuffix = ['blank', 'near-uniform'].includes(renderSummary?.verdict)
          ? `; render ${renderSummary.verdict}`
          : '';
        const metadata = {
          result_kind: 'preview_test',
          render_state: 'loaded',
          render_summary: renderSummary,
          viewport,
          path: relPath,
          console_error_count: consoleErrorCount,
          console_errors: consoleErrors,
          page_error_count: pageEntries.length,
          page_errors: pageErrors,
          events: eventResults,
        };
        if (screenshotError) metadata.screenshot_error = screenshotError;
        if (generatedArtifacts) metadata.generatedArtifacts = generatedArtifacts;
        return {
          content: contentLines.join('\n'),
          summary: `Preview-tested ${relPath}: ${consoleErrorCount} console error(s)${verdictSuffix}`,
          isError: false,
          metadata,
        };
      } catch (error) {
        const reason = redactKnownPaths(error?.message || error, sensitiveValues);
        return failure({
          reason: 'preview_probe_failed',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: `Preview testing "${relPath}" failed during the browser probe: ${reason}`,
          summary: 'Preview browser probe failed',
        });
      } finally {
        if (opened) {
          await service.close(sessionId).catch(() => {});
        }
      }
    },
  };
}

const previewTestTool = createPreviewTestTool();

module.exports = Object.assign(previewTestTool, {
  createPreviewTestTool,
});
