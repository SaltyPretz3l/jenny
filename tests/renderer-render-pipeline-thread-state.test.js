const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createThreadStatePipeline,
  ensureThreadBranchesCollapsedMap,
  getThreadCollapsedSetForState,
  clearThreadBranchCollapseState,
} = require('../renderer/chat/renderer-render-pipeline-thread-state');

test('thread collapse store repairs malformed containers and session entries', () => {
  const state = {
    currentSessionId: 'session-1',
    ui: { threadBranchesCollapsedBySession: { stale: true } },
  };

  const collapsedSet = getThreadCollapsedSetForState(state, 'session-1', { create: true });
  assert.equal(collapsedSet instanceof Set, true);
  assert.equal(ensureThreadBranchesCollapsedMap(state) instanceof Map, true);

  state.ui.threadBranchesCollapsedBySession.set('session-2', ['not-a-set']);
  assert.equal(getThreadCollapsedSetForState(state, 'session-2'), null);
  assert.equal(state.ui.threadBranchesCollapsedBySession.has('session-2'), false);

  state.ui.threadBranchesCollapsedBySession = new WeakMap();
  const repairedSet = getThreadCollapsedSetForState(state, 'session-3', { create: true });
  assert.equal(repairedSet instanceof Set, true);
  assert.equal(state.ui.threadBranchesCollapsedBySession instanceof Map, true);

  state.ui.threadBranchesCollapsedBySession.set('session-4', new WeakSet());
  assert.equal(getThreadCollapsedSetForState(state, 'session-4'), null);
  assert.equal(state.ui.threadBranchesCollapsedBySession.has('session-4'), false);
});

test('thread collapse store rejects behavioral collection counterfeits without invoking them', () => {
  let invoked = false;
  const throwingMapLike = {
    size: 1,
    get() { invoked = true; throw new Error('get must not run'); },
    set() { invoked = true; throw new Error('set must not run'); },
    has() { invoked = true; throw new Error('has must not run'); },
    delete() { invoked = true; throw new Error('delete must not run'); },
    clear() { invoked = true; throw new Error('clear must not run'); },
    forEach() { invoked = true; throw new Error('forEach must not run'); },
    [Symbol.iterator]() { invoked = true; throw new Error('iterator must not run'); },
  };
  const state = {
    currentSessionId: 'session-1',
    ui: { threadBranchesCollapsedBySession: throwingMapLike },
  };

  const collapsedSet = getThreadCollapsedSetForState(state, 'session-1', { create: true });

  assert.equal(invoked, false);
  assert.equal(collapsedSet instanceof Set, true);
  assert.equal(state.ui.threadBranchesCollapsedBySession instanceof Map, true);
});

test('thread state pipeline toggles, prunes, and force-opens grouped branches', () => {
  const state = {
    currentSessionId: 'session-1',
    ui: { threadBranchesCollapsedBySession: new Map() },
  };
  let renderCount = 0;
  const pipeline = createThreadStatePipeline({
    state,
    callbacks: {
      renderMessages() { renderCount += 1; },
      shouldShowThreadToggle(node) { return node?.toggle === true; },
    },
  });

  pipeline.toggleThreadBranch('assistant-1');
  assert.equal(pipeline.isThreadBranchCollapsed('assistant-1', 'session-1'), true);
  assert.equal(renderCount, 1);

  const threadTree = {
    nodeById: new Map([
      ['assistant-1', { id: 'assistant-1', toggle: true }],
      ['stale', { id: 'stale', toggle: false }],
    ]),
  };
  state.ui.threadBranchesCollapsedBySession.get('session-1').add('stale');
  pipeline.pruneThreadBranchState('session-1', threadTree);
  assert.deepEqual([...state.ui.threadBranchesCollapsedBySession.get('session-1')], ['assistant-1']);
  assert.equal(pipeline.buildThreadExpansionSignature(threadTree, 'session-1', new Set()), 'assistant-1');
  assert.equal(pipeline.buildThreadExpansionSignature(threadTree, 'session-1', new Set(['assistant-1'])), '');

  pipeline.toggleThreadBranch('assistant-1');
  assert.equal(state.ui.threadBranchesCollapsedBySession.has('session-1'), false);
  assert.equal(renderCount, 2);
});

test('thread collapse state clears without replacing a valid map', () => {
  const collapsedBySession = new Map([['session-1', new Set(['assistant-1'])]]);
  const state = { ui: { threadBranchesCollapsedBySession: collapsedBySession } };

  assert.equal(clearThreadBranchCollapseState(state), true);
  assert.equal(state.ui.threadBranchesCollapsedBySession, collapsedBySession);
  assert.equal(collapsedBySession.size, 0);
});

test('thread collapse clear replaces a counterfeit collection without calling clear', () => {
  let clearCalled = false;
  const state = {
    ui: {
      threadBranchesCollapsedBySession: {
        clear() {
          clearCalled = true;
          throw new Error('counterfeit clear must not run');
        },
      },
    },
  };

  assert.equal(clearThreadBranchCollapseState(state), false);
  assert.equal(clearCalled, false);
  assert.equal(state.ui.threadBranchesCollapsedBySession instanceof Map, true);
  assert.equal(state.ui.threadBranchesCollapsedBySession.size, 0);
});
