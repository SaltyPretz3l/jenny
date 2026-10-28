'use strict';

/* services/tools/builtin/preview-test-tool.js — `preview_test`
 *
 * One-shot workspace HTML tester backed by BrowserSessionService. Validation
 * order is security-sensitive: service availability → workspace root realpath
 * → relative HTML path → viewport → bounded wait → bounded click/type/hover/focus/press events
 * → real-path containment → regular-file/size gates → hidden strict-workspace
 * browser session → settle/events/inspect → exactly-one close. No caller script
 * is ever evaluated, and result text never includes resolved absolute paths. */

const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const { waitForAbortable } = require('../../browser-session-input');
const {
  formatRenderSummary,
  summarizeRenderBitmap,
} = require('../../browser-render-summary');
const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeString } = require('../../shared/normalize');
const {
  extensionOf,
  realpathSafe,
  toRelativePosix,
} = require('../../shared/workspace-tool-helpers');
const { toolFailure } = require('./tool-result');
const {
  appliedEventsText,
  boundedEventSelector,
  collectExternalResources,
  eventOutcomeLine,
  externalResourcesLine,
  normalizeObserveInput,
  observationLines,
  observationMetadata,
  observeSelectors,
  redactKnownPaths,
  stripSensitiveValues,
} = require('./preview-test-evidence');
const {
  normalizePreviewEvent,
  unknownArgumentFailure,
} = require('./preview-test-arguments');

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
// Electron's loadURL rejects with a Chromium net error (code ERR_*, "ERR_X (-n)
// loading ..."), and the session service bounds a hung load with its own
// timeout. Only those mean "the page failed to load"; anything else from
// open() (capacity, a disposed service, stale authority) means no browser ran.
const NAVIGATION_TIMEOUT_MESSAGE = 'Browser navigation timed out.';

// Shared failure shape; this tool's callers pass `message` and `extra`.
function failure({ reason, message, summary, errorCode, extra = {} }) {
  return toolFailure('preview_test', {
    content: message, summary, reason, errorCode, metadata: { status: 'failed', ...extra },
  });
}

function isNavigationFailure(error) {
  const message = String(error?.message || '');
  return /^ERR_[A-Z_]+$/.test(String(error?.code || ''))
    || /\bERR_[A-Z_]+ \(-\d+\)/.test(message)
    || message === NAVIGATION_TIMEOUT_MESSAGE;
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
} = {}) {
  const settle = (delayMs) => new Promise((resolve) => {
    setTimeoutImpl(resolve, delayMs)?.unref?.();
  });

  return {
    name: 'preview_test',
    description: 'Load one workspace HTML file in a hidden, network-isolated sandbox and report what happened: render state, console errors, and page errors, optionally after bounded click/type/hover/focus/press interactions and at a chosen viewport. Each event outcome is listed; a "clicked", "hovered", "focused" or "pressed" status only means the input was dispatched, so pass observe (CSS selectors) to read back match count, visibility and text after the events and verify the effect. A screenshot is taken after a fresh frame is presented, so it reflects the post-event state. The page loads real workspace files, but the in-app Preview is self-contained: external scripts and stylesheets do not load there, and the result warns when the page references any. Read-only and one-shot; it never navigates off the file, reaches the network, or evaluates caller scripts (observation uses a tool-owned read-only script).',
    category: 'builtin',
    readOnly: true,
    workspaceRequired: true,
    // parameters: the manifest's schema, applied by withManifestSchema at registration.

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
          message: 'viewport must be the string "desktop", "mobile", or "tablet"; width/height objects are not supported.',
          summary: 'Invalid preview viewport',
        });
      }

      const waitMs = clampWaitMs(input?.wait_ms === undefined ? DEFAULT_WAIT_MS : input.wait_ms);
      const unknownArgument = unknownArgumentFailure(input);
      if (unknownArgument) return failure({ ...unknownArgument, errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED });
      const rawEvents = input?.events;
      if (rawEvents !== undefined && !Array.isArray(rawEvents)) {
        return failure({
          reason: 'invalid_event',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: 'events must be an array of click, type, hover, focus or press interactions.',
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
      const observeInput = normalizeObserveInput(input?.observe);
      if (!observeInput.ok) {
        return failure({
          reason: 'invalid_observe',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: observeInput.message,
          summary: 'Invalid preview observe list',
        });
      }
      const observe = observeInput.observe;
      const events = [];
      for (const rawEvent of rawEvents || []) {
        const parsed = normalizePreviewEvent(rawEvent);
        if (parsed.failure) return failure({ ...parsed.failure, errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED });
        events.push(parsed.event);
      }

      let resolvedRealPath;
      try {
        const resolved = context.pathPolicy.resolvePath(relPath, context);
        resolvedRealPath = await context.pathPolicy.assertInsideRoot(resolved, context) || resolved;
      } catch (error) {
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
      const abortSignal = context.abortSignal || null;
      const abortOption = abortSignal ? { abortSignal } : {};
      const wantsScreenshot = input?.screenshot === true;
      let opened = false;
      try {
        let openPromise = null;
        try {
          openPromise = Promise.resolve(service.open({
            sessionId,
            streamId: sessionId,
            url,
            bounds: VIEWPORTS[viewport],
            allowedFileRoots: [realWorkspaceRoot],
            strictWorkspaceOnly: true,
            ...abortOption,
          }));
          // A hung load must not outlive the call's cancellation.
          await waitForAbortable(openPromise, abortSignal);
          opened = true;
        } catch (error) {
          if (abortSignal?.aborted) {
            // The load may still be in flight: close its window now instead of
            // when the navigation timer fires.
            openPromise?.catch(() => {});
            await Promise.resolve().then(() => service.close(sessionId)).catch(() => {});
            return failure({
              reason: 'cancelled',
              errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
              message: `Preview testing "${relPath}" was cancelled before the page loaded.`,
              summary: 'Preview test cancelled',
            });
          }
          const reason = redactKnownPaths(error?.message || error, sensitiveValues);
          if (!isNavigationFailure(error)) {
            return failure({
              reason: 'browser_unavailable',
              errorCode: TOOL_ERROR_CODES.DISABLED,
              message: `Preview testing "${relPath}" could not start a browser session: ${reason}`,
              summary: 'Preview browser unavailable',
            });
          }
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
        const externalResources = await collectExternalResources(service, sessionId, sensitiveValues);
        const eventResults = [];
        for (const event of events) {
          // click/hover/focus take a selector; press also carries its key.
          let options = { selector: event.selector, ...abortOption };
          if (event.action === 'type') options = { ...options, text: event.text, press_enter: event.press_enter };
          if (event.action === 'press') options = { key: event.key, selector: event.selector, ...abortOption };
          const entry = {
            action: event.action,
            selector: boundedEventSelector(event.selector),
            ...(event.action === 'press' ? { key: event.key } : {}),
          };
          try {
            const result = await service[event.action](sessionId, options);
            eventResults.push({ ...entry, status: String(result?.status || '') });
          } catch (error) {
            // One failed interaction is that event's finding, not the probe's;
            // cancellation still ends the whole probe.
            if (abortSignal?.aborted) throw error;
            eventResults.push({
              ...entry,
              status: 'error',
              error: redactKnownPaths(error?.message || error, sensitiveValues).slice(0, 200),
            });
          }
        }
        if (events.length) {
          await settle(waitMs);
        }
        const observed = observe.length
          ? await observeSelectors(service, sessionId, observe, sensitiveValues)
          : null;

        const inspected = await service.inspect(sessionId);
        let screenshotCapture = null;
        let renderSummary = null;
        let screenshotError = '';
        if (typeof service.screenshot === 'function') {
          try {
            // Without a requested screenshot only the render-summary thumbnail is
            // read, so the service may skip the full PNG encode.
            screenshotCapture = await service.screenshot(sessionId, {
              modelImage: wantsScreenshot,
              thumbnailOnly: !wantsScreenshot,
              ...abortOption,
            });
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
        const modelImage = wantsScreenshot ? screenshotCapture?.model_image : null;
        let artifactError = '';
        if (wantsScreenshot) {
          const chatSessionId = normalizeString(context.sessionId);
          if (
            !chatSessionId
            || typeof context.artifactService?.createBinaryArtifact !== 'function'
          ) {
            artifactError = 'artifact service unavailable';
          } else if (!Buffer.isBuffer(modelImage?.buffer)) {
            artifactError = 'bounded screenshot unavailable';
          } else {
            try {
              const created = await context.artifactService.createBinaryArtifact(chatSessionId, {
                previewScreenshot: true,
                content: modelImage.buffer,
                width: modelImage.width,
                height: modelImage.height,
              });
              // The artifact service returns `{ output, metadata }`; the
              // bridge consumes the metadata record (artifact_id, display_path, ...).
              const artifact = created?.metadata;
              if (!artifact?.artifact_id) {
                throw new Error('artifact service returned no artifact record');
              }
              generatedArtifacts = [artifact];
              screenshotLine = `Screenshot attached: ${artifact.display_path} (bounded storage; new captures do not evict saved screenshots).`;
            } catch (error) {
              artifactError = redactKnownPaths(error?.message || error, sensitiveValues);
            }
          }
        }
        const contentLines = [
          `Preview-tested "${relPath}": loaded with ${consoleErrorCount} console error(s), applied ${appliedEventsText(eventResults)} event(s), viewport ${viewport}.`,
        ];
        if (eventResults.length) contentLines.push(eventOutcomeLine(eventResults));
        contentLines.push(formatRenderSummary(renderSummary));
        contentLines.push(...observationLines(observe, observed));
        if (externalResources) contentLines.push(externalResourcesLine(externalResources));
        if (screenshotLine) contentLines.push(screenshotLine);
        if (wantsScreenshot) {
          contentLines.push(`Screenshot capture: ${screenshotCapture ? 'captured' : 'unavailable'}.`);
          if (artifactError) contentLines.push(`Screenshot save failed: ${artifactError}`);
          if (!modelImage) contentLines.push('Model image unavailable: bounded screenshot encoding failed.');
        }
        if (screenshotError) contentLines.push(`Screenshot capture failed: ${screenshotError}`);
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
        Object.assign(metadata, observationMetadata(observe, observed));
        if (externalResources) metadata.external_resources = externalResources;
        if (screenshotError) metadata.screenshot_error = screenshotError;
        if (artifactError) metadata.screenshot_error ||= artifactError;
        if (wantsScreenshot) {
          metadata.capture_status = screenshotCapture ? 'captured' : 'unavailable';
          metadata.artifact_status = generatedArtifacts ? 'saved_temporary' : 'unavailable';
          metadata.model_delivery_status = modelImage ? 'pending' : 'unavailable';
          if (modelImage) metadata.model_image_dimensions = { width: modelImage.width, height: modelImage.height };
        }
        if (generatedArtifacts) metadata.generatedArtifacts = generatedArtifacts;
        return {
          content: contentLines.join('\n'),
          summary: `Preview-tested ${relPath}: ${consoleErrorCount} console error(s)${verdictSuffix}`,
          isError: false,
          metadata,
          ...(modelImage ? { previewImage: modelImage } : {}),
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
