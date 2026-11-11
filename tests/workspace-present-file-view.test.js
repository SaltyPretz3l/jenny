'use strict';

/* workspace_present view="file" (owner pick F1): open a workspace file in the
 * IDE editor, optionally at a 1-based line. Covers the tool's validation
 * (path required, containment, directory/missing/binary refusals, the line
 * bounds and its view-exclusivity), the request-not-outcome wording, the
 * service's wire payload (line only for file) and outcome note, the renderer
 * controller's apply/chip routing through the injected open-file-at-line dep,
 * the IDE QoL composition that wires that dep onto the shared
 * `ide:open-file-at-line` seam, and the canonical manifest schema. */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const tool = require('../services/tools/builtin/workspace-present-tool');
const { ToolPathPolicy } = require('../services/tools/tool-path-policy');
const {
  WorkspacePresentationService,
  VALID_VIEWS,
} = require('../services/workspace-presentation-service');
const {
  createWorkspacePresentationController,
} = require('../renderer/features/renderer-workspace-presentation-controller');
const manifest = require('../services/tools/tool-manifest.json');

// ── Tool ────────────────────────────────────────────────────────────────────

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-wsp-file-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* best-effort */ } });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const x = 1;\n');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x61, 0x00, 0x62]));
  fs.writeFileSync(path.join(root, 'big.log'), 'a'.repeat(1_600_000));
  return root;
}

function makeContext(t) {
  const root = makeWorkspace(t);
  const events = [];
  return {
    events,
    context: {
      workingDirectory: root,
      sessionId: 'session-1',
      callId: 'call-1',
      pathPolicy: new ToolPathPolicy({ fs: fs.promises, path, logger: () => {} }),
      workspacePresentationService: {
        requestPresentation(payload) {
          events.push(payload);
          return { delivered: true, request_id: 'req-1' };
        },
      },
      configService: { getToolsWorkspaceRoot: () => root },
      logger: () => {},
    },
  };
}

test('file view dispatches ONE event carrying the line and reports a request, not an outcome', async (t) => {
  const { context, events } = makeContext(t);
  const result = await tool.execute({ view: 'file', path: 'src\\app.js', line: 42 }, context);
  assert.equal(result.isError, false);
  assert.deepEqual(events, [{
    view: 'file', path: 'src/app.js', line: 42, source: 'tool', session_id: 'session-1', call_id: 'call-1',
  }]);
  assert.match(result.content, /^Requested the file "src\/app\.js" at line 42 in the workspace IDE\./);
  assert.match(result.content, /does not confirm the user sees it/);
  assert.doesNotMatch(result.content, /rendered|self-contained/, 'preview-only caveats stay off the file view');
  assert.equal(result.summary, 'Requested file src/app.js at line 42');
  assert.equal(result.metadata.view, 'file');
  assert.equal(result.metadata.line, 42);
  assert.equal(result.metadata.presentation_state, 'deferred');
});

test('file view without a line omits it; a large text file is not held to the preview size cap', async (t) => {
  const { context, events } = makeContext(t);
  const plain = await tool.execute({ view: 'file', path: 'src/app.js' }, context);
  assert.equal(plain.isError, false);
  assert.equal(Object.prototype.hasOwnProperty.call(events[0], 'line'), false);
  assert.equal(plain.summary, 'Requested file src/app.js');
  assert.equal(Object.prototype.hasOwnProperty.call(plain.metadata, 'line'), false);

  const big = await tool.execute({ view: 'file', path: 'big.log' }, context);
  assert.equal(big.isError, false, 'the IDE editor, not the preview cap, bounds text size');
  assert.equal(events.length, 2);
});

test('file view refuses a missing path, escapes, directories, missing and binary files', async (t) => {
  const { context, events } = makeContext(t);
  const reasons = {};
  for (const [label, input] of Object.entries({
    noPath: { view: 'file' },
    escape: { view: 'file', path: '../outside.js' },
    absolute: { view: 'file', path: 'C:/abs.js' },
    directory: { view: 'file', path: 'src' },
    missing: { view: 'file', path: 'src/nope.js' },
    binary: { view: 'file', path: 'blob.bin' },
  })) {
    const result = await tool.execute(input, context);
    assert.equal(result.isError, true, label);
    reasons[label] = result.metadata.reason;
    assert.ok(!String(result.content).includes(context.workingDirectory), `${label} never echoes the root`);
  }
  assert.deepEqual(reasons, {
    noPath: 'path_required',
    escape: 'unsafe_path',
    absolute: 'unsafe_path',
    directory: 'is_directory',
    missing: 'file_missing',
    binary: 'binary_file',
  });
  assert.equal(events.length, 0);
});

test('a real-path escape caught by assertInsideRoot fails closed for the file view', async (t) => {
  const { context, events } = makeContext(t);
  context.pathPolicy = {
    resolvePath: () => 'X:/outside/evil.js',
    assertInsideRoot: async () => { throw new Error('outside X:/outside'); },
  };
  const result = await tool.execute({ view: 'file', path: 'link/evil.js' }, context);
  assert.equal(result.metadata.reason, 'unsafe_path');
  assert.ok(!String(result.content).includes('X:/outside'));
  assert.equal(events.length, 0);
});

test('line must be an integer 1..1000000 and is only valid with view="file"', async (t) => {
  const { context, events } = makeContext(t);
  for (const line of [0, -3, 1.5, 1_000_001, '42', Number.NaN, true]) {
    const result = await tool.execute({ view: 'file', path: 'src/app.js', line }, context);
    assert.equal(result.isError, true, `line ${String(line)}`);
    assert.equal(result.metadata.reason, 'invalid_line', `line ${String(line)}`);
  }
  const preview = await tool.execute({ view: 'file_map', path: 'src/app.js', line: 3 }, context);
  assert.equal(preview.metadata.reason, 'invalid_line');
  assert.equal(events.length, 0);
  const edge = await tool.execute({ view: 'file', path: 'src/app.js', line: 1_000_000 }, context);
  assert.equal(edge.isError, false);
  assert.equal(events[0].line, 1_000_000);
});

// ── Service ─────────────────────────────────────────────────────────────────

function makeService() {
  const sent = [];
  const service = new WorkspacePresentationService({
    sendBridgeEvent: (methodPath, payload) => sent.push({ methodPath, payload }),
    isRendererAvailable: () => true,
  });
  return { service, sent };
}

test('service: file is a valid view; the payload carries line only for file', () => {
  assert.ok(VALID_VIEWS.includes('file'));
  const { service, sent } = makeService();
  const withLine = service.requestPresentation({ view: 'file', path: 'src\\app.js', line: 42 });
  assert.equal(withLine.delivered, true);
  assert.equal(sent[0].payload.view, 'file');
  assert.equal(sent[0].payload.path, 'src/app.js');
  assert.equal(sent[0].payload.line, 42);

  const noLine = service.requestPresentation({ view: 'file', path: 'src/app.js' });
  assert.equal(noLine.delivered, true);
  assert.equal(Object.prototype.hasOwnProperty.call(sent[1].payload, 'line'), false);

  const preview = service.requestPresentation({ view: 'preview', path: 'docs/a.md' });
  assert.equal(preview.delivered, true);
  assert.equal(Object.prototype.hasOwnProperty.call(sent[2].payload, 'line'), false);
});

test('service: file without a path, a bad line, or a line on another view fails closed', () => {
  const { service, sent } = makeService();
  assert.equal(service.requestPresentation({ view: 'file' }).reason, 'path_required');
  assert.equal(service.requestPresentation({ view: 'file', path: '../x.js' }).reason, 'unsafe_path');
  for (const line of [0, 1_000_001, 2.5, '7']) {
    assert.equal(service.requestPresentation({ view: 'file', path: 'a.js', line }).reason, 'invalid_line');
  }
  assert.equal(service.requestPresentation({ view: 'preview', path: 'a.md', line: 3 }).reason, 'invalid_line');
  assert.equal(sent.length, 0);
});

test('service: the outcome note names the file and line', () => {
  const { service } = makeService();
  const first = service.requestPresentation({
    view: 'file', path: 'src/app.js', line: 42, session_id: 'session-1', call_id: 'call-1',
  });
  const second = service.requestPresentation({
    view: 'file', path: 'README.md', session_id: 'session-1', call_id: 'call-2',
  });
  assert.deepEqual(service.recordOutcome({ request_id: first.request_id, decision: 'shown' }), { ok: true });
  assert.deepEqual(service.recordOutcome({ request_id: second.request_id, decision: 'prompted' }), { ok: true });
  const note = service.consumeOutcomeNote('session-1');
  assert.ok(note.includes(`- File "src/app.js" at line 42 (request ${first.request_id}): shown in the IDE.`), note);
  assert.ok(note.includes(`- File "README.md" (request ${second.request_id}): held behind`), note);
});

// ── Renderer controller ─────────────────────────────────────────────────────

function makeController({ openFileAtLine, getActiveView, draft = '' } = {}) {
  const dom = new JSDOM('<div id="ideMain"></div>');
  const ideMain = dom.window.document.getElementById('ideMain');
  const calls = { opens: [], reports: [], previews: [], maps: 0 };
  let clock = 100_000;
  const timers = [];
  const windowRef = {
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn) => timers.push(fn),
    clearTimeout() {},
    document: dom.window.document,
    jennyShell: {
      workspacePresentation: {
        onRequest: () => () => {},
        reportOutcome(payload) {
          calls.reports.push(payload);
          return Promise.resolve({ ok: true });
        },
      },
    },
  };
  const controller = createWorkspacePresentationController({
    getDom: () => ({ ideMain, chatInput: { value: draft } }),
    windowRef,
    escapeHtml: (v) => String(v == null ? '' : v),
    getActiveView: getActiveView || (() => 'ide'),
    openPreview: (p) => calls.previews.push(p),
    openFileMap: () => { calls.maps += 1; },
    openFileAtLine: openFileAtLine === undefined
      ? (p, line) => { calls.opens.push({ path: p, line }); return true; }
      : openFileAtLine,
    isSurfaceEnabled: () => true,
    now: () => clock,
    isApprovalPending: () => false,
  });
  return {
    controller,
    calls,
    advance: (ms) => { clock += ms; },
    fireTimers: () => { for (const fn of timers.splice(0)) fn(); },
    chip: () => ideMain.querySelector('.ide-presentation-chip'),
  };
}

test('controller: a safe file request opens the file at the line and reports shown', (t) => {
  const h = makeController();
  t.after(() => h.controller.dispose());
  h.controller.handleRequest({ view: 'file', path: 'src/app.js', line: 42, request_id: 'wsp-1' });
  h.fireTimers();
  assert.deepEqual(h.calls.opens, [{ path: 'src/app.js', line: 42 }]);
  assert.deepEqual(h.calls.previews, []);
  assert.equal(h.calls.maps, 0);
  assert.deepEqual(h.calls.reports, [{ request_id: 'wsp-1', decision: 'shown' }]);

  h.controller.handleRequest({ view: 'file', path: 'README.md', request_id: 'wsp-2' });
  h.fireTimers();
  assert.deepEqual(h.calls.opens[1], { path: 'README.md', line: null });
});

test('controller: a busy user gets the chip; Show opens the file and reports shown_by_user', (t) => {
  const h = makeController({ getActiveView: () => 'chat', draft: 'half a sentence' });
  t.after(() => h.controller.dispose());
  h.controller.handleRequest({ view: 'file', path: 'src/app.js', line: 7, request_id: 'wsp-3' });
  h.fireTimers();
  const chip = h.chip();
  assert.ok(chip, 'chip raised');
  assert.equal(chip.querySelector('.ide-presentation-chip-copy').textContent, 'Jenny wants to show the file src/app.js at line 7');
  const show = chip.querySelector('[data-presentation-show]');
  assert.equal(show.getAttribute('title'), 'Show the file src/app.js');
  assert.deepEqual(h.calls.opens, []);
  show.dispatchEvent(new chip.ownerDocument.defaultView.Event('click', { bubbles: true }));
  assert.deepEqual(h.calls.opens, [{ path: 'src/app.js', line: 7 }]);
  assert.deepEqual(h.calls.reports.map((r) => r.decision), ['prompted', 'shown_by_user']);
});

test('controller: an unclaimed open, a missing opener, a bad line or no path reports rejected', (t) => {
  const declined = makeController({ openFileAtLine: () => false });
  t.after(() => declined.controller.dispose());
  declined.controller.handleRequest({ view: 'file', path: 'a.js', request_id: 'wsp-4' });
  declined.fireTimers();
  assert.deepEqual(declined.calls.reports, [{ request_id: 'wsp-4', decision: 'rejected' }]);

  const absent = makeController({ openFileAtLine: null });
  t.after(() => absent.controller.dispose());
  absent.controller.handleRequest({ view: 'file', path: 'a.js', request_id: 'wsp-5' });
  absent.fireTimers();
  assert.deepEqual(absent.calls.reports, [{ request_id: 'wsp-5', decision: 'rejected' }]);

  const h = makeController();
  t.after(() => h.controller.dispose());
  h.controller.handleRequest({ view: 'file', path: 'a.js', line: 0, request_id: 'wsp-6' });
  h.controller.handleRequest({ view: 'file', path: 'a.js', line: '9', request_id: 'wsp-7' });
  h.controller.handleRequest({ view: 'file', request_id: 'wsp-8' });
  h.controller.handleRequest({ view: 'file', path: '../up.js', request_id: 'wsp-9' });
  h.fireTimers();
  assert.deepEqual(h.calls.opens, []);
  assert.deepEqual(h.calls.reports.map((r) => [r.request_id, r.decision]), [
    ['wsp-6', 'rejected'], ['wsp-7', 'rejected'], ['wsp-8', 'rejected'], ['wsp-9', 'rejected'],
  ]);
});

// ── IDE QoL composition ─────────────────────────────────────────────────────

test('QoL wiring injects an opener on the shared ide:open-file-at-line seam and enables the file surface', () => {
  const { createIdeQolWiring } = require('../renderer/features/renderer-ide-qol-wiring');
  const stubKeys = ['rendererIdeBreadcrumbs', 'rendererIdeMruSwitcher', 'rendererIdeSaveHygiene', 'rendererWorkspacePresentationController'];
  const prev = Object.fromEntries(stubKeys.map((key) => [key, globalThis[key]]));
  let seen = null;
  globalThis.rendererIdeBreadcrumbs = { createIdeBreadcrumbs: () => null };
  globalThis.rendererIdeMruSwitcher = { createIdeMruSwitcher: () => null };
  globalThis.rendererIdeSaveHygiene = { createIdeSaveHygiene: () => null };
  globalThis.rendererWorkspacePresentationController = {
    createWorkspacePresentationController: (deps) => {
      seen = deps;
      return { bindEvents() {}, dispose() {}, handleContextChange() {} };
    },
  };
  try {
    const dom = new JSDOM('<div></div>');
    const win = dom.window;
    const events = [];
    let claim = true;
    win.addEventListener('ide:open-file-at-line', (event) => {
      events.push({ detail: { ...event.detail }, cancelable: event.cancelable });
      if (claim) event.preventDefault();
    });
    const qol = createIdeQolWiring({ getDom: () => ({}), getIde: () => ({}), windowRef: win });
    assert.equal(typeof seen.openFileAtLine, 'function');
    assert.equal(seen.isSurfaceEnabled('file'), true);
    assert.equal(seen.openFileAtLine('src/app.js', 42), true, 'a claimed event means the IDE took it');
    assert.deepEqual(events[0], {
      detail: { path: 'src/app.js', line: 42, column: 1, preferIde: true },
      cancelable: true,
    });
    claim = false;
    assert.equal(seen.openFileAtLine('src/app.js', null), false, 'an unclaimed event is not an open');
    assert.equal(events[1].detail.line, null);
    qol.disposeAll();
  } finally {
    for (const key of stubKeys) {
      if (prev[key] === undefined) delete globalThis[key];
      else globalThis[key] = prev[key];
    }
  }
});

// ── Manifest ────────────────────────────────────────────────────────────────

test('manifest: workspace_present lists the file view, a bounded line, and requires a path for it', () => {
  const entry = manifest.tools.find((candidate) => candidate.name === 'workspace_present');
  const props = entry.parameters.properties;
  assert.ok(props.view.enum.includes('file'));
  const { description, ...line } = props.line;
  assert.deepEqual(line, { type: 'integer', minimum: 1, maximum: 1000000 });
  assert.match(description, /view="file"/);
  assert.match(entry.description, /file view|view="file"|editor/i);
  const pathBranch = entry.parameters.anyOf.find((branch) => (branch.required || []).includes('path'));
  assert.ok(pathBranch.properties.view.enum.includes('file'));
});
