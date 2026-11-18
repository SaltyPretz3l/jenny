'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers/renderer-ide-harness');

// The git status store debounces its pull by 120 ms
// (renderer-ide-git-status-store.js, and this harness does not override it), so
// a fixed sleep shorter than that is a race the test can only win when the
// event loop is busy enough to slip its own timer past the debounce — which is
// why this file passed inside the parallel suite and failed when run alone on
// an idle machine. Poll the condition the assertion is actually about, with a
// deadline far above the debounce, so neither machine load nor future renderer
// work can re-break it.
async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), message);
}

test('wide-033: IDE activation resolving after dispose cannot restart root-bound services', async () => {
  const harness = createHarness();
  let resolveHydrate;
  harness.bridge.jennyShell.workspaceIde.getState = () => new Promise((resolve) => {
    resolveHydrate = resolve;
  });
  const activation = harness.controller.activateIde();
  await Promise.resolve();
  harness.dispose();
  resolveHydrate({
    ok: true,
    context: {
      rootPath: 'G:/fake-root', rootId: 'root_fake', generation: 0, phase: 'ready',
    },
    openTabs: [],
    activeTabPath: '',
    expandedDirs: [],
  });
  await activation;
  assert.equal(harness.bridge.calls.watchStart.length, 0,
    'a late activation cannot restart the watcher after teardown');
});

test('JCA-001/002/005: a committed root transition resets git state and broadcasts to the composer singletons', async () => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'body' },
      git: {
        branch: 'root-a',
        files: [{ path: 'src/app.js', index: ' ', worktree: 'M', state: 'modified' }],
      },
    },
  });
  try {
    await harness.controller.activateIde();
    // Initial debounced git pull.
    await waitFor(() => harness.bridge.calls.gitGetStatus.length >= 1,
      'the git slice pulled status for root A');
    const baseline = harness.bridge.calls.gitGetStatus.length;

    const rootEvents = [];
    harness.dom.window.addEventListener('ide:workspace-root-committed', (event) => {
      rootEvents.push(event.detail && event.detail.context);
    });

    // Advance the bridge stub to root B so persistence hydration sees a
    // matching (non-stale) context for the committed transition.
    harness.bridge.state.rootPath = 'G:/root-b';
    harness.bridge.state.rootGeneration = 2;
    await harness.controller.handleWorkspaceRootCommitted({
      context: { rootPath: 'G:/root-b', rootId: 'root_fake', generation: 2, phase: 'ready' },
    });
    await waitFor(() => harness.bridge.calls.gitGetStatus.length > baseline,
      'the root commit re-pulls git status for the new root instead of waiting for a watcher event');
    assert.equal(rootEvents.length, 1, 'the controller broadcasts the committed transition on the window');
    assert.equal(rootEvents[0].rootPath, 'G:/root-b');
  } finally {
    harness.dispose();
  }
});

test('wide-033: a committed-root notification after dispose is a complete no-op', async () => {
  const harness = createHarness();
  let hydrateCalls = 0;
  harness.state.ui.ide = {};
  harness.state.ui.ide.openTabs = ['keep.js'];
  harness.state.ui.ide.activeTabPath = 'keep.js';
  harness.bridge.jennyShell.workspaceIde.getState = () => {
    hydrateCalls += 1;
    throw new Error('disposed root commit must not hydrate');
  };
  harness.dispose();
  await harness.controller.handleWorkspaceRootCommitted({
    context: { rootPath: 'G:/new-root', rootId: 'root_new', generation: 2, phase: 'ready' },
  });
  assert.equal(harness.bridge.calls.watchStart.length, 0,
    'a disposed controller cannot restart root-bound children');
  assert.equal(hydrateCalls, 0, 'a disposed controller cannot begin persistence hydration');
  assert.deepEqual(harness.state.ui.ide.openTabs, ['keep.js'],
    'a disposed controller cannot clear the existing tab state');
  assert.equal(harness.state.ui.ide.activeTabPath, 'keep.js');
});

test('a debounced window resize re-renders the Workspace only while it is the active view', async () => {
  const harness = createHarness();
  try {
    await harness.controller.activateIde();
    // A workbench render re-applies each stack's data-state; clearing it is a render probe.
    const stack = harness.dom.window.document.querySelector('#ideWorkbench .wb-stack[data-kind="views"]');
    await waitFor(() => stack?.getAttribute('data-state') === 'open', 'precondition: the Workspace rendered');
    const fireResize = async () => {
      harness.dom.window.dispatchEvent(new harness.dom.window.Event('resize'));
      await new Promise((resolve) => setTimeout(resolve, 250));
    };

    harness.state.ui.activeView = 'chat';
    stack.removeAttribute('data-state');
    await fireResize();
    assert.equal(stack.getAttribute('data-state'), null, 'a hidden Workspace skips the full re-render');

    harness.state.ui.activeView = 'ide';
    await fireResize();
    assert.equal(stack.getAttribute('data-state'), 'open', 'the visible Workspace re-renders on resize');
  } finally {
    harness.dispose();
  }
});

test('Activity subscribes when flags arrive after IDE binding, and stays inert while disabled',async()=>{
 let subscriptions=0,reads=0,disposed=0;
 const harness=createHarness({featureFlags:{activity_monitor:false},beforeController:(_win,bridge)=>{
  bridge.jennyShell.activity={onChanged:()=>{subscriptions++;return()=>disposed++;},subscribe:async()=>{reads++;return{available:true,epoch:'test',revision:1,items:[]};}};
 }});
 try{
  await harness.controller.activateIde();harness.controller.renderIde();await Promise.resolve();
  assert.equal(subscriptions,0);assert.equal(reads,0);
  harness.state.features.featureFlags.activity_monitor=true;harness.controller.renderIde();await Promise.resolve();
  assert.equal(subscriptions,1);assert.ok(reads>0);harness.controller.renderIde();assert.equal(subscriptions,1);
 }finally{harness.dispose();}
 assert.equal(disposed,1);
});

// terminal_run (runInTaskTerminal): the controller drives a fake terminal set through the module table's global seam.
async function withFakeTerminalSet(results, run) {
  const calls = [];
  let failure = null;
  const queue = results.slice();
  const fakeSet = new Proxy({
    openTaskTerminal: async (...args) => { calls.push(args); const next = queue.length > 1 ? queue.shift() : queue[0]; failure = next.failure || null; return next.task; },
    lastTaskStartFailure: () => (failure ? { ...failure } : null),
  }, { get: (target, key) => (key in target ? target[key] : () => undefined) }); // every other set method is an inert no-op
  const previous = globalThis.rendererIdeTerminalSet;
  globalThis.rendererIdeTerminalSet = { createIdeTerminalSet: () => fakeSet };
  const harness = createHarness();
  try {
    await run(harness, calls);
  } finally {
    harness.dispose();
    if (previous === undefined) delete globalThis.rendererIdeTerminalSet; else globalThis.rendererIdeTerminalSet = previous;
  }
}

test('runInTaskTerminal waits for the IDE activation before it opens a task terminal', async () => {
  const task = { getSessionId: () => 'pty-2', sendCommand: async () => true };
  await withFakeTerminalSet([{ task }], async (harness, calls) => {
    let finishHydrate;
    harness.bridge.jennyShell.workspaceIde.getState = () => new Promise((resolve) => { finishHydrate = resolve; });
    const running = harness.controller.runInTaskTerminal('npm test');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 0, 'nothing opened while the IDE is still activating');
    finishHydrate({ ok: true, context: { rootPath: 'G:/fake-root', rootId: 'root_fake', generation: 0, phase: 'ready' }, openTabs: [], activeTabPath: '', expandedDirs: [] });
    assert.deepEqual(await running, { ok: true, session_id: 'pty-2' });
    assert.equal(calls.length, 1);
  });
});

test('runInTaskTerminal passes the start_folder place only when asked, and sends the command to the terminal', async () => {
  const sent = [];
  const task = { getSessionId: () => 'pty-2', sendCommand: async (command) => { sent.push(command); return true; } };
  await withFakeTerminalSet([{ task }], async (harness, calls) => {
    await harness.controller.runInTaskTerminal('ls', { place: 'start_folder' });
    await harness.controller.runInTaskTerminal('pwd', { place: 'elsewhere' });
    await harness.controller.runInTaskTerminal('whoami');
    assert.deepEqual(calls, [[undefined, { place: 'start_folder' }], [undefined, undefined], [undefined, undefined]]);
    assert.deepEqual(sent, ['ls', 'pwd', 'whoami']);
  });
});

test('runInTaskTerminal retries once when the first start is false with no recorded failure', async () => {
  const task = { getSessionId: () => 'pty-3', sendCommand: async () => true };
  await withFakeTerminalSet([{ task: false }, { task }], async (harness, calls) => {
    assert.deepEqual(await harness.controller.runInTaskTerminal('ls', { place: 'start_folder' }), { ok: true, session_id: 'pty-3' });
    assert.equal(calls.length, 2, 'one retry');
    assert.deepEqual(calls[1], [undefined, { place: 'start_folder' }], 'the retry asks for the same place');
  });
  await withFakeTerminalSet([{ task: false }], async (harness, calls) => {
    assert.deepEqual(await harness.controller.runInTaskTerminal('ls'), { ok: false, reason: 'start_failed' });
    assert.equal(calls.length, 2, 'a second false is final: only one retry');
  });
});

test('runInTaskTerminal does not retry a start that failed with a code, and maps the code to a reason', async () => {
  for (const [code, reason] of [['CMP-TERMINAL-0006', 'start_folder_unavailable'], ['CMP-TERMINAL-0002', 'root_missing'], ['CMP-TERMINAL-0099', 'start_failed'], ['', 'start_failed']]) {
    await withFakeTerminalSet([{ task: false, failure: { status: 'failed', code } }], async (harness, calls) => {
      assert.deepEqual(await harness.controller.runInTaskTerminal('ls'), { ok: false, reason }, code || 'no code');
      assert.equal(calls.length, 1, 'a recorded failure is not retried');
    });
  }
});

test('runInTaskTerminal answers no_free_terminal for null, and send_failed when the line is not accepted', async () => {
  await withFakeTerminalSet([{ task: null }], async (harness, calls) => {
    assert.deepEqual(await harness.controller.runInTaskTerminal('ls'), { ok: false, reason: 'no_free_terminal' });
    assert.equal(calls.length, 1, 'null is not retried');
  });
  await withFakeTerminalSet([{ task: { getSessionId: () => 'pty-2', sendCommand: async () => false } }], async (harness) => {
    assert.deepEqual(await harness.controller.runInTaskTerminal('ls'), { ok: false, reason: 'send_failed' });
  });
});
