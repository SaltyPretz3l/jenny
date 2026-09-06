'use strict';

/* `workspace_present` builtin tool (services/tools/builtin/workspace-present-tool.js).
 * Covers the plan's validation matrix: unsafe paths, symlink escapes,
 * directories-for-preview, no workspace, workspace-root mismatch, unsupported
 * view, unsupported/missing/binary/too-large files → structured failures with
 * redacted messages; a valid request emits exactly ONE presentation event and
 * returns synchronously from validation+dispatch (no renderer ack); the
 * model-facing summary is request-not-outcome ("Requested…"). Uses the REAL
 * ToolPathPolicy against a temp workspace for the containment path. */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tool = require('../services/tools/builtin/workspace-present-tool');
const { ToolPathPolicy } = require('../services/tools/tool-path-policy');

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-wsp-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* best-effort */ } });
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'readme.md'), '# hi');
  fs.writeFileSync(path.join(root, 'site.html'), '<h1>x</h1>');
  fs.writeFileSync(path.join(root, 'app.js'), 'const x = 1;');
  fs.writeFileSync(path.join(root, 'blob.md'), Buffer.from([0x61, 0x00, 0x62]));
  fs.writeFileSync(path.join(root, 'big.md'), 'a'.repeat(1_500_001));
  return root;
}

function makeContext(t, { root, ideRoot, delivered = true, presentationService } = {}) {
  const workspaceRoot = root ?? makeWorkspace(t);
  const events = [];
  const service = presentationService !== undefined ? presentationService : {
    requestPresentation(payload) {
      events.push(payload);
      return delivered ? { delivered: true, request_id: 'req-1' } : { delivered: false, reason: 'renderer_unavailable' };
    },
  };
  const pathPolicy = new ToolPathPolicy({ fs: fs.promises, path, logger: () => {} });
  return {
    context: {
      workingDirectory: workspaceRoot,
      sessionId: 'session-1',
      pathPolicy,
      workspacePresentationService: service,
      configService: { getToolsWorkspaceRoot: () => (ideRoot === undefined ? workspaceRoot : ideRoot) },
      logger: () => {},
    },
    events,
    workspaceRoot,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('valid preview request emits ONE event and reports a request, not an outcome', async (t) => {
  const { context, events } = makeContext(t, {});
  const result = await tool.execute({ view: 'preview', path: 'docs\\readme.md' }, context);
  assert.equal(result.isError, false);
  assert.equal(events.length, 1, 'exactly one presentation event');
  assert.deepEqual(events[0], { view: 'preview', path: 'docs/readme.md', source: 'tool' });
  assert.match(result.summary, /^Requested preview of docs\/readme\.md$/);
  assert.match(result.content, /^Requested a preview/, 'request-not-outcome wording');
  assert.equal(result.metadata.request_id, 'req-1');
});

// W8: honest presentation state. The renderer holds tool-initiated requests
// behind a non-stealing chip and there is NO renderer-ack channel back to the
// main process, so the tool must report the state it can actually know —
// deferred/not_started — never a hardcoded 'requested' that implies success.
test('successful dispatch reports honest deferred/not_started state', async (t) => {
  const { context } = makeContext(t, {});
  const result = await tool.execute({ view: 'preview', path: 'docs\\readme.md' }, context);
  assert.equal(result.isError, false);
  assert.equal(result.metadata.presentation_state, 'deferred');
  assert.equal(result.metadata.render_state, 'not_started');
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.metadata, 'status'),
    false,
    'the misleading status:"requested" field is retired'
  );
});

test('file_map works without a path, and a MISSING reveal path still dispatches (bounded renderer state)', async (t) => {
  const { context, events } = makeContext(t, {});
  const bare = await tool.execute({ view: 'file_map' }, context);
  assert.equal(bare.isError, false);
  assert.equal(events[0].path, '');
  assert.match(bare.summary, /^Requested File Map$/);

  const missing = await tool.execute({ view: 'file_map', path: 'not/scanned/или/deleted.js' }, context);
  assert.equal(missing.isError, false, 'missing map targets are the renderer\'s bounded not-in-map state');
  assert.equal(events.length, 2);
});

test('change_diff derives session/workspace identity and dispatches exactly one recorded change intent', async (t) => {
  const { context, events } = makeContext(t, {});
  const result = await tool.execute({
    view: 'change_diff',
    path: 'app.js',
    change_id: 'change:turn:tool:1',
  }, context);

  assert.equal(result.isError, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].view, 'change_diff');
  assert.equal(events[0].path, 'app.js');
  assert.equal(events[0].session_id, 'session-1');
  assert.match(events[0].workspace_id, /^root_[0-9a-f]{24}$/);
  assert.equal(events[0].change_id, 'change:turn:tool:1');
  assert.match(result.summary, /Requested change diff for app\.js/);
});

test('change_diff rejects missing context and malformed change ids without dispatch', async (t) => {
  const { context, events } = makeContext(t, {});
  context.sessionId = '';
  const noSession = await tool.execute({ view: 'change_diff', path: 'app.js' }, context);
  assert.equal(noSession.metadata.reason, 'presentation_context_unavailable');
  const badId = await tool.execute({ view: 'change_diff', path: 'app.js', change_id: 'bad id' }, {
    ...context,
    sessionId: 'session-1',
  });
  assert.equal(badId.metadata.reason, 'invalid_change_id');
  assert.equal(events.length, 0);
});

test('unsafe paths reject with redacted structured failures (no absolute paths echoed)', async (t) => {
  const { context, events, workspaceRoot } = makeContext(t, {});
  for (const bad of ['../escape.md', 'C:/abs.md', '/rooted.md', 'a\0b.md', 'preview://x.md']) {
    const result = await tool.execute({ view: 'preview', path: bad }, context);
    assert.equal(result.isError, true, `${bad} must fail`);
    assert.equal(result.metadata.reason, 'unsafe_path');
    assert.ok(!String(result.content).includes(workspaceRoot), 'message never echoes the absolute root');
    assert.ok(!String(result.content).includes(bad), 'unsafe caller input is not echoed');
  }
  assert.equal(events.length, 0, 'no event for any rejected path');
});

test('a real-path escape caught by assertInsideRoot fails closed as unsafe_path', async (t) => {
  const { context, events } = makeContext(t, {});
  context.pathPolicy = {
    resolvePath: () => 'X:/outside/evil.md',
    assertInsideRoot: async () => { throw new Error('Path "X:/outside/evil.md" resolves outside the working directory "secret"'); },
  };
  const result = await tool.execute({ view: 'preview', path: 'docs/readme.md' }, context);
  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, 'unsafe_path');
  assert.ok(!String(result.content).includes('X:/outside'), 'policy error text (with absolute paths) is not echoed');
  assert.equal(events.length, 0);
});

test('preview content gates: directory, unsupported, missing, binary, too-large', async (t) => {
  const { context, events } = makeContext(t, {});
  const cases = [
    [{ view: 'preview', path: 'docs' }, 'unsupported_file'], // no extension → unsupported before stat
    [{ view: 'preview', path: 'app.js' }, 'unsupported_file'],
    [{ view: 'preview', path: 'nope.md' }, 'file_missing'],
    [{ view: 'preview', path: 'blob.md' }, 'binary_file'],
    [{ view: 'preview', path: 'big.md' }, 'too_large'],
    [{ view: 'preview' }, 'path_required'],
  ];
  for (const [input, reason] of cases) {
    const result = await tool.execute(input, context);
    assert.equal(result.isError, true, `${JSON.stringify(input)} must fail`);
    assert.equal(result.metadata.reason, reason);
  }
  assert.equal(events.length, 0);
});

test('a directory with a previewable extension still fails as a directory', async (t) => {
  const { context, workspaceRoot } = makeContext(t, {});
  fs.mkdirSync(path.join(workspaceRoot, 'folder.md'));
  const result = await tool.execute({ view: 'preview', path: 'folder.md' }, context);
  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, 'is_directory');
});

test('wide-043: preview rejects non-regular files before open', async (t) => {
  assert.equal(typeof tool.createWorkspacePresentTool, 'function');
  let openCalls = 0;
  const injected = tool.createWorkspacePresentTool({
    fsLike: {
      realpath: async (target) => target,
      stat: async () => ({ isDirectory: () => false, isFile: () => false, size: 0 }),
      open: async () => { openCalls += 1; throw new Error('must not open a FIFO/socket/device'); },
    },
  });
  const { context, events } = makeContext(t, {});
  const result = await injected.execute({ view: 'preview', path: 'notes.md' }, context);
  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, 'unsupported_file_kind');
  assert.equal(openCalls, 0);
  assert.equal(events.length, 0);
});

test('wide-043: post-open handle identity wins if a regular file is swapped', async (t) => {
  let closeCalls = 0;
  const injected = tool.createWorkspacePresentTool({
    fsLike: {
      realpath: async (target) => target,
      stat: async () => ({ isDirectory: () => false, isFile: () => true, size: 8 }),
      open: async () => ({
        stat: async () => ({ isFile: () => false, size: 0 }),
        close: async () => { closeCalls += 1; },
      }),
    },
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  const { context, events } = makeContext(t, {});
  context.pathPolicy = {
    resolvePath: (relPath) => path.join(context.workingDirectory, relPath),
    assertInsideRoot: async (target) => target,
  };
  const result = await injected.execute({ view: 'preview', path: 'notes.md' }, context);
  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, 'unsupported_file_kind');
  assert.equal(closeCalls, 1);
  assert.equal(events.length, 0);
});

test('wide-043: a hanging preview open is deadline-bounded and closes a late handle', async (t) => {
  assert.equal(typeof tool.createWorkspacePresentTool, 'function');
  const openGate = deferred();
  let fireDeadline = null;
  let closeCalls = 0;
  const injected = tool.createWorkspacePresentTool({
    fsLike: {
      realpath: async (target) => target,
      stat: async () => ({ isDirectory: () => false, isFile: () => true, size: 8 }),
      open: () => openGate.promise,
    },
    sniffTimeoutMs: 50,
    setTimeoutImpl: (callback) => { fireDeadline = callback; return 1; },
    clearTimeoutImpl: () => {},
  });
  const { context, events } = makeContext(t, {});
  const logs = [];
  context.logger = (level, event, details) => logs.push({ level, event, details });
  context.pathPolicy = {
    resolvePath: (relPath) => path.join(context.workingDirectory, relPath),
    assertInsideRoot: async (target) => target,
  };
  const pending = injected.execute({ view: 'preview', path: 'notes.md' }, context);
  for (let turn = 0; turn < 20 && typeof fireDeadline !== 'function'; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(typeof fireDeadline, 'function');
  fireDeadline();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, 'file_unreadable');
  assert.equal(events.length, 0);
  assert.ok(logs.some((entry) => entry.event === 'workspace_present.sniff_timeout'));

  openGate.resolve({ close: async () => { closeCalls += 1; } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(closeCalls, 1, 'a file handle arriving after timeout is not leaked');
});

test('unsupported view / no workspace / root mismatch / service+renderer unavailable', async (t) => {
  const base = makeContext(t, {});
  const badView = await tool.execute({ view: 'editor' }, base.context);
  assert.equal(badView.metadata.reason, 'unsupported_view');

  const noRoot = makeContext(t, {});
  noRoot.context.workingDirectory = '';
  assert.equal((await tool.execute({ view: 'file_map' }, noRoot.context)).metadata.reason, 'no_workspace_root');

  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-wsp-other-'));
  t.after(() => { try { fs.rmSync(otherRoot, { recursive: true, force: true }); } catch (_e) { /* best-effort */ } });
  const mismatch = makeContext(t, { ideRoot: otherRoot });
  assert.equal((await tool.execute({ view: 'file_map' }, mismatch.context)).metadata.reason, 'workspace_root_mismatch');

  const noService = makeContext(t, { presentationService: null });
  assert.equal((await tool.execute({ view: 'file_map' }, noService.context)).metadata.reason, 'unavailable');

  const undelivered = makeContext(t, { delivered: false });
  const result = await tool.execute({ view: 'file_map' }, undelivered.context);
  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, 'renderer_unavailable');
});

test('the tool result is computed synchronously from dispatch (never awaits a renderer ack)', async (t) => {
  const { context } = makeContext(t, {
    presentationService: {
      // A service whose (hypothetical) renderer round-trip never resolves —
      // requestPresentation itself stays synchronous, which is the contract.
      requestPresentation: () => ({ delivered: true, request_id: 'sync-1' }),
    },
  });
  let timeoutHandle = null;
  let result;
  try {
    result = await Promise.race([
      tool.execute({ view: 'file_map' }, context),
      new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve('TIMED_OUT'), 2000);
      }),
    ]);
  } finally {
    // The loser of the race is never settled, so without this the referenced
    // 2s timer keeps the whole file's process alive after the last assertion.
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
  assert.notEqual(result, 'TIMED_OUT');
  assert.equal(result.metadata.request_id, 'sync-1');
});
