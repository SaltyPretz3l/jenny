'use strict';

/* Red-first contract for the W8-S4 `preview_test` builtin (spec Part 7).
 *
 * One-shot workspace HTML tester on the BrowserSessionService substrate:
 * open hidden sandboxed window -> settle -> bounded events -> inspect ->
 * ALWAYS close, all inside a single call. Workspace files only, network off
 * (strict workspace-only URL posture), no caller-script evaluation ever. */

const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const {
  callsOf,
  makeContext,
  makeTool,
  makeWorkspace,
  stubService,
} = require('./helpers/preview-test-tool-fixture');
const { holdEventLoopUntilTestsFinish } = require('./helpers/event-loop-hold');

// Service wait timers are unref'd on purpose; Node 22's runner would drain the loop under them.
holdEventLoopUntilTestsFinish(test);

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('preview_test / one-shot lifecycle', () => {
  test('happy path: opens contained file url with strict posture, inspects, closes', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(result.isError, false);
    assert.equal(result.metadata.result_kind, 'preview_test');
    assert.equal(result.metadata.render_state, 'loaded');
    assert.equal(result.metadata.console_error_count, 0);

    const [openCall] = callsOf(service, 'open');
    assert.ok(openCall, 'service.open is called');
    const openOptions = openCall[1];
    assert.ok(String(openOptions.url).startsWith('file:'), 'loads a file:// url');
    assert.equal(openOptions.strictWorkspaceOnly, true, 'network-off posture is demanded');
    assert.deepEqual(openOptions.allowedFileRoots, [root]);
    assert.deepEqual(
      { width: openOptions.bounds.width, height: openOptions.bounds.height },
      { width: 1280, height: 800 },
      'default viewport is desktop'
    );

    const order = service.calls.map(([name]) => name);
    assert.ok(order.indexOf('inspect') >= 0, 'final state is read via inspect');
    assert.equal(order[order.length - 1], 'close', 'the window is closed last');
    assert.equal(callsOf(service, 'close').length, 1);
    assert.equal(callsOf(service, 'eval').length, 1, 'only the tool-owned external-resource read evaluates');
    assert.ok(!result.content.includes('In-app preview parity'), 'no external refs, no parity line');
  });

  test('viewport presets map to fixed bounds', async () => {
    const root = makeWorkspace();
    for (const [preset, expected] of [
      ['mobile', { width: 390, height: 844 }],
      ['tablet', { width: 820, height: 1180 }],
    ]) {
      const service = stubService();
      const result = await makeTool().execute(
        { path: 'index.html', viewport: preset },
        makeContext(root, service)
      );
      assert.equal(result.isError, false);
      const openOptions = callsOf(service, 'open')[0][1];
      assert.deepEqual(
        { width: openOptions.bounds.width, height: openOptions.bounds.height },
        expected
      );
      assert.equal(result.metadata.viewport, preset);
    }
  });

  test('unknown viewport fails closed without opening a window', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute(
      { path: 'index.html', viewport: 'imax' },
      makeContext(root, service)
    );
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'invalid_viewport');
    assert.equal(callsOf(service, 'open').length, 0);
  });

  test('a width/height viewport object is rejected with a hint', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute(
      { path: 'index.html', viewport: { width: 320, height: 740 } },
      makeContext(root, service)
    );
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'invalid_viewport');
    assert.match(result.content, /width\/height objects are not supported/);
    assert.equal(callsOf(service, 'open').length, 0);
  });

  test('wait_ms is clamped to the 5000ms ceiling', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const delays = [];
    const setTimeoutImpl = (fn, delay) => {
      delays.push(delay);
      fn();
      return 0;
    };
    const result = await makeTool({ setTimeoutImpl }).execute(
      { path: 'index.html', wait_ms: 999999 },
      makeContext(root, service)
    );
    assert.equal(result.isError, false);
    assert.ok(delays.length >= 1, 'a settle wait is scheduled');
    for (const delay of delays) {
      assert.ok(delay <= 5000, `settle delay ${delay} stays within the ceiling`);
    }
  });
});

describe('preview_test / result honesty and bounds', () => {
  test('every run reports a render summary when thumbnail pixels are available', async () => {
    const root = makeWorkspace();
    const service = stubService({
      screenshotResult: {
        buffer: Buffer.from('png'),
        width: 2,
        height: 2,
        thumbnail: {
          bitmap: Buffer.from([
            0, 0, 255, 255, 0, 0, 255, 255,
            0, 0, 255, 255, 0, 0, 255, 255,
          ]),
          width: 2,
          height: 2,
        },
      },
    });

    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(result.isError, false);
    assert.equal(result.metadata.render_summary.verdict, 'blank');
    assert.match(result.content, /Render:/);
  });

  test('screenshot true creates a session artifact without exposing its absolute path', async () => {
    const root = makeWorkspace();
    const absolutePath = path.join(root, '.jenny', 'artifacts', 'preview-test-screenshot.png');
    const artifact = {
      artifact_id: 'artifact_preview_1',
      artifact_kind: 'image',
      title: 'preview_test screenshot',
      file_name: 'preview-test-screenshot.png',
      display_path: '.jenny/artifacts/preview-test-screenshot.png',
      absolute_path: absolutePath,
      mime_type: 'image/png',
      width: 1280,
      height: 800,
      editable: false,
      status: 'available',
    };
    const artifactCalls = [];
    const artifactService = {
      async createBinaryArtifact(sessionId, options) {
        artifactCalls.push([sessionId, options]);
        return { output: `Created image "${artifact.title}" at ${artifact.display_path}`, metadata: artifact };
      },
    };
    const service = stubService({
      screenshotResult: {
        buffer: Buffer.from('png-bytes'),
        model_image: { buffer: Buffer.from('png-bytes'), width: 1280, height: 800 },
        width: 1280,
        height: 800,
        thumbnail: null,
      },
    });

    const result = await makeTool().execute(
      { path: 'index.html', screenshot: true },
      makeContext(root, service, { artifactService, sessionId: 'chat_session_1' })
    );

    assert.equal(result.isError, false);
    assert.equal(result.metadata.generatedArtifacts[0].artifact_id, 'artifact_preview_1');
    assert.match(result.content, /Screenshot attached: \.jenny\/artifacts\/preview-test-screenshot\.png/);
    assert.deepEqual(artifactCalls, [[
      'chat_session_1',
      {
        content: Buffer.from('png-bytes'),
        width: 1280,
        height: 800,
        previewScreenshot: true,
      },
    ]]);
    assert.ok(!result.content.includes(absolutePath));
    const modelVisibleMetadata = JSON.parse(JSON.stringify(result.metadata));
    delete modelVisibleMetadata.generatedArtifacts[0].absolute_path;
    assert.ok(!JSON.stringify(modelVisibleMetadata).includes(absolutePath));
    assert.equal(result.metadata.generatedArtifacts[0].absolute_path, absolutePath);
  });

  test('screenshot capture failure remains a successful test result with bounded metadata', async () => {
    const root = makeWorkspace();
    const service = stubService({
      screenshotError: new Error(`capture failed at ${root}/secret.png`),
    });

    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(result.isError, false);
    assert.equal(result.metadata.render_summary, null);
    assert.match(result.metadata.screenshot_error, /capture failed/);
    assert.ok(!result.metadata.screenshot_error.includes(root));
    assert.match(result.content, /Render: unavailable \(no pixel capture\)/);
  });

  test('screenshot true without an artifact service reports unavailability without throwing', async () => {
    const root = makeWorkspace();
    const service = stubService();

    const result = await makeTool().execute(
      { path: 'index.html', screenshot: true },
      makeContext(root, service, { sessionId: 'chat_session_1' })
    );

    assert.equal(result.isError, false);
    assert.equal(result.metadata.screenshot_error, 'artifact service unavailable');
    assert.equal(result.metadata.generatedArtifacts, undefined);
  });

  test('counts only error-level console messages plus page errors, bounded and flattened', async () => {
    const root = makeWorkspace();
    const hostile = 'boom\n## Forged Heading ' + 'x'.repeat(500);
    const consoleMessages = [];
    for (let index = 0; index < 15; index += 1) {
      consoleMessages.push({ level: 3, message: `${hostile} #${index}` });
    }
    consoleMessages.push({ level: 2, message: 'just a warning' });
    consoleMessages.push({ level: 1, message: 'info' });
    const service = stubService({
      inspectResult: {
        console_messages: consoleMessages,
        page_errors: [{ message: 'ReferenceError: nope' }],
      },
    });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(result.isError, false);
    assert.equal(result.metadata.console_error_count, 16, '15 error-level + 1 page error');
    assert.ok(result.metadata.console_errors.length <= 10, 'error text list is bounded');
    for (const text of result.metadata.console_errors) {
      assert.ok(text.length <= 300, 'each error text is bounded');
      assert.ok(!text.includes('\n'), 'page-controlled text is whitespace-flattened');
    }
  });

  test('a page that fails to load is reported as data, not an infra error', async () => {
    const root = makeWorkspace();
    const loadError = new Error('ERR_FILE_NOT_FOUND (-6) loading the page');
    const service = stubService({ openError: loadError });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(result.isError, false, 'the TEST ran; the page failing is its finding');
    assert.equal(result.metadata.render_state, 'failed');
    assert.ok(String(result.content).length > 0);
  });

  test('an open() failure that is not a navigation error is a browser_unavailable failure', async () => {
    const root = makeWorkspace();
    for (const message of [
      'Preview browser capacity is unavailable.',
      'BrowserSessionService has been disposed',
      'Preview authority is unavailable.',
      'Maximum active browser sessions reached.',
    ]) {
      const service = stubService({ openError: new Error(message) });
      const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));
      assert.equal(result.isError, true, message);
      assert.equal(result.metadata.reason, 'browser_unavailable', message);
      assert.equal(result.errorCode, 'CMP-TOOL-0002');
      assert.doesNotMatch(result.content, /console error/);
    }
  });

  test('Electron net errors and the navigation timeout stay page-load findings', async () => {
    const root = makeWorkspace();
    const coded = Object.assign(new Error('Failed to load'), { code: 'ERR_ABORTED', errno: -3 });
    for (const openError of [coded, new Error('Browser navigation timed out.')]) {
      const result = await makeTool().execute({ path: 'index.html' },
        makeContext(root, stubService({ openError })));
      assert.equal(result.isError, false);
      assert.equal(result.metadata.render_state, 'failed');
    }
  });

  test('cancelling during a hung page load returns at once and closes the window', async () => {
    const root = makeWorkspace();
    const controller = new AbortController();
    const service = stubService({
      openHandler: () => {
        setTimeout(() => controller.abort(), 0);
        return new Promise(() => {});
      },
    });
    const result = await makeTool().execute({ path: 'index.html' },
      makeContext(root, service, { abortSignal: controller.signal }));
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'cancelled');
    assert.equal(callsOf(service, 'open')[0][1].abortSignal, controller.signal);
    assert.equal(callsOf(service, 'close').length, 1);
    assert.equal(callsOf(service, 'inspect').length, 0);
  });

  test('a throwing interaction is an error entry, and the probe still reports', async () => {
    const root = makeWorkspace();
    const service = stubService({ clickError: new Error(`click timed out in ${root}`) });
    const result = await makeTool().execute({
      path: 'index.html',
      events: [{ action: 'click', selector: '#go' }, { action: 'hover', selector: '#menu' }],
    }, makeContext(root, service));
    assert.equal(result.isError, false, result.content);
    assert.deepEqual(result.metadata.events.map((entry) => entry.status), ['error', 'hovered']);
    assert.ok(!result.metadata.events[0].error.includes(root), 'the error reason is path-redacted');
    assert.match(result.content, /applied 1 of 2 event\(s\)/);
    assert.match(result.content, /could not run this interaction/);
    assert.equal(callsOf(service, 'inspect').length, 1);
  });

  test('the screenshot call asks for the full PNG only when a screenshot is requested', async () => {
    const root = makeWorkspace();
    const service = stubService();
    await makeTool().execute({ path: 'index.html' }, makeContext(root, service));
    assert.deepEqual(callsOf(service, 'screenshot')[0][2], { modelImage: false, thumbnailOnly: true });
  });

  test('an inspect failure after open still closes the window', async () => {
    const root = makeWorkspace();
    const service = stubService({ inspectError: new Error('window vanished') });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(result.isError, true);
    assert.equal(callsOf(service, 'close').length, 1, 'close still runs on the failure path');
  });

  test('absolute workspace paths never appear in any result', async () => {
    const root = makeWorkspace();
    for (const args of [
      { path: 'index.html' },
      { path: '../outside.html' },
      { path: 'notes.md' },
    ]) {
      // The console messages carry the absolute root on purpose: a page can
      // print its own file:// URL, so the scrubber has to survive real input
      // rather than an empty inspect result that passes this test vacuously.
      const service = stubService({
        inspectResult: {
          console_messages: [
            {
              level: 3,
              message: `Failed to load ${root}/missing.js`,
              line: 3,
              source_id: `${root}/index.html`,
            },
          ],
          page_errors: [{ code: -6, message: `ERR_FILE_NOT_FOUND ${root}/gone.css` }],
        },
      });
      const result = await makeTool().execute(args, makeContext(root, service));
      const rendered = JSON.stringify(result);
      assert.ok(
        !rendered.includes(JSON.stringify(root).slice(1, -1)),
        `result for ${args.path} must not leak the absolute root`
      );
    }
  });
});

describe('preview_test / validation gates', () => {
  test('missing path fails with path_required', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute({}, makeContext(root, service));
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'path_required');
    assert.equal(callsOf(service, 'open').length, 0);
  });

  test('escaping and unsafe paths are rejected before any window opens', async () => {
    const root = makeWorkspace();
    for (const bad of ['../escape.html', 'C:/evil.html', '/abs.html']) {
      const service = stubService();
      const result = await makeTool().execute({ path: bad }, makeContext(root, service));
      assert.equal(result.isError, true, `${bad} must be rejected`);
      assert.equal(result.metadata.reason, 'unsafe_path');
      assert.equal(callsOf(service, 'open').length, 0);
    }
  });

  test('non-HTML extensions are rejected', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute({ path: 'notes.md' }, makeContext(root, service));
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'unsupported_extension');
    assert.equal(callsOf(service, 'open').length, 0);
  });

  test('a missing file is rejected without opening a window', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute(
      { path: 'ghost.html' },
      makeContext(root, service)
    );
    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'unreadable_file');
    assert.equal(callsOf(service, 'open').length, 0);
  });

  test('no workspace root and no service each fail closed', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const noRoot = await makeTool().execute(
      { path: 'index.html' },
      makeContext(root, service, { workingDirectory: '' })
    );
    assert.equal(noRoot.isError, true);
    assert.equal(noRoot.metadata.reason, 'no_workspace_root');

    const noService = await makeTool().execute(
      { path: 'index.html' },
      makeContext(root, service, { browserSessionService: null })
    );
    assert.equal(noService.isError, true);
    assert.equal(noService.metadata.reason, 'unavailable');
  });
});
