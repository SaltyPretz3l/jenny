// Split view W0-6: the per-pane render runtime.
//
// `uiRuntime` is the renderer's render-memo bag. Everything on it is written
// LAZILY by its consumers (the render-mode signatures, the canonical-message
// and thread-tree caches, the per-surface timers), which is why it has always
// been a bare `{}`. Two panes cannot share those memo fields -- pane 1's render
// would overwrite pane 0's signatures and force a full rebuild every frame --
// but they MUST share the three session-keyed Maps, because a session's
// projection context is one thing wherever it is painted (`activeTurnId` lives
// inside it).
//
// This suite pins that split: what the store owns, what each pane runtime owns,
// and that the store's key list cannot drift from the list the projection cache
// prunes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const paneRuntimeModule = require('../renderer/chat/renderer-pane-runtime.js');

const {
  SHARED_SESSION_CACHE_KEYS,
  createSharedSessionStore,
  createPaneRuntime,
} = paneRuntimeModule;

const ROOT = path.resolve(__dirname, '..');
const PROJECTION_CACHE_PATH = path.join(ROOT, 'renderer/chat/renderer-render-pipeline-projection-cache.js');

const EXPECTED_KEYS = [
  'projectionContextBySession',
  'toolRowProjectionFallbacksBySession',
  'toolRowProjectionFailuresBySession',
];

// Built from strings, not written as /regex/ literals, on purpose:
// scripts/checks/check_vacuous_oracle.py lexes a skeleton that does not lex
// regex literals, and one inside a test block desynchronizes that block's brace
// matching, so the checker cannot see that block's assertions. String literals
// it blanks cleanly. (Verified 2026-09-16: `.source` and `.flags` are identical
// to the literal form, so nothing matched changes.)
const PRUNE_LIST_PATTERN = new RegExp('const uiRuntimeCaches = \\[([\\s\\S]*?)\\];');
// Any array literal of quoted identifiers; the filter below keeps the ones that
// name projectionContextBySession, so the element shape is deliberately loose
// (a future `toolRowMetaBySessionId` must not slip past it).
const SESSION_KEY_ARRAY_PATTERN = new RegExp('\\[\\s*((?:\'[A-Za-z0-9_]+\',?\\s*)+)\\]', 'g');
const QUOTED_NAME_PATTERN = new RegExp('\'([^\']+)\'', 'g');

function quotedNames(source) {
  return [...String(source).matchAll(QUOTED_NAME_PATTERN)].map((match) => match[1]);
}

test('SHARED_SESSION_CACHE_KEYS is the frozen list of the three session-keyed caches', () => {
  assert.deepEqual([...SHARED_SESSION_CACHE_KEYS], EXPECTED_KEYS);
  assert.ok(Object.isFrozen(SHARED_SESSION_CACHE_KEYS), 'the key list is frozen: no consumer may push onto it');
});

test('the shared store is exactly three empty Maps, fresh per call', () => {
  const store = createSharedSessionStore();

  assert.deepEqual(Object.keys(store).sort(), [...EXPECTED_KEYS].sort(), 'the store holds the three caches and nothing else');
  for (const key of EXPECTED_KEYS) {
    assert.ok(store[key] instanceof Map, `${key} is a Map`);
    assert.equal(store[key].size, 0, `${key} starts empty`);
  }

  const second = createSharedSessionStore();
  for (const key of EXPECTED_KEYS) {
    assert.notEqual(second[key], store[key], `${key} is minted fresh per store, never a module singleton`);
  }
});

test('two pane runtimes over one store share Map identity for all three caches', () => {
  const shared = createSharedSessionStore();
  const pane0 = createPaneRuntime({ paneId: 0, shared });
  const pane1 = createPaneRuntime({ paneId: 1, shared });

  for (const key of EXPECTED_KEYS) {
    assert.equal(pane0[key], shared[key], `pane 0's ${key} IS the store's Map`);
    assert.equal(pane1[key], shared[key], `pane 1's ${key} IS the same Map`);
  }

  // Identity, not a copy: a projection context written while painting pane 0
  // is the same object pane 1 reads for that session.
  const context = { activeTurnId: 'turn-1' };
  pane0.projectionContextBySession.set('session-a', context);
  assert.equal(pane1.projectionContextBySession.get('session-a'), context);
});

test('a pane runtime pre-seeds the three Maps and nothing else', () => {
  const runtime = createPaneRuntime({ paneId: 0, shared: createSharedSessionStore() });

  assert.deepEqual(
    Object.keys(runtime).sort(),
    ['paneId', ...EXPECTED_KEYS].sort(),
    'the runtime carries paneId and the three shared caches; every memo field is written lazily by its consumer'
  );
  for (const key of Object.keys(runtime)) {
    assert.notEqual(typeof runtime[key], 'function', `${key} must not be a function: this is a value bag, not an API`);
  }
});

test('paneId defaults to 0 and is carried through when given', () => {
  assert.equal(createPaneRuntime({ shared: createSharedSessionStore() }).paneId, 0);
  assert.equal(createPaneRuntime({}).paneId, 0);
  assert.equal(createPaneRuntime().paneId, 0);
  assert.equal(createPaneRuntime({ paneId: 1, shared: createSharedSessionStore() }).paneId, 1);
  // A pane id is an index into the pane array (renderer-pane-model.js re-numbers
  // 0..N-1), so anything that is not a non-negative integer means "pane 0".
  assert.equal(createPaneRuntime({ paneId: -1 }).paneId, 0);
  assert.equal(createPaneRuntime({ paneId: '1' }).paneId, 0);
  assert.equal(createPaneRuntime({ paneId: 1.5 }).paneId, 0);
});

test('the pane runtime stays a plain mutable bag and each pane memoizes on its own', () => {
  const shared = createSharedSessionStore();
  const pane0 = createPaneRuntime({ paneId: 0, shared });
  const pane1 = createPaneRuntime({ paneId: 1, shared });

  assert.ok(!Object.isFrozen(pane0), 'the runtime is not frozen: every consumer assigns onto it');
  assert.ok(!Object.isSealed(pane0), 'the runtime is not sealed: the memo fields do not exist until a render writes them');

  // The whole point of the slice: the memo fields are PER PANE.
  pane0.messageRenderSignature = 'sig-a';
  pane0.cachedCanonicalMessages = [{ id: 'a1' }];
  pane0.viewportRefreshFrame = 7;
  assert.equal(pane1.messageRenderSignature, undefined, 'pane 1 does not see pane 0\'s render signature');
  assert.equal(pane1.cachedCanonicalMessages, undefined, 'pane 1 does not see pane 0\'s canonical message cache');
  assert.equal(pane1.viewportRefreshFrame, undefined, 'pane 1 does not see pane 0\'s surface timer handle');
  assert.equal(pane0.messageRenderSignature, 'sig-a', 'pane 0 keeps its own');
});

test('a runtime built without a shared store still gets three working, private Maps', () => {
  const standalone = createPaneRuntime({ paneId: 0 });
  const other = createPaneRuntime();

  for (const key of EXPECTED_KEYS) {
    assert.ok(standalone[key] instanceof Map, `${key} is a working Map without a store`);
    assert.notEqual(other[key], standalone[key], `${key} is private to each standalone runtime`);
  }
  standalone.projectionContextBySession.set('session-a', {});
  assert.equal(other.projectionContextBySession.has('session-a'), false);
});

test('a store missing a cache is repaired IN the store, so two panes still converge on one Map', () => {
  const partial = { projectionContextBySession: new Map() };
  const pane0 = createPaneRuntime({ paneId: 0, shared: partial });
  const pane1 = createPaneRuntime({ paneId: 1, shared: partial });

  for (const key of EXPECTED_KEYS) {
    assert.ok(pane0[key] instanceof Map, `${key} resolves to a Map`);
    assert.equal(pane0[key], pane1[key], `${key} is one Map across both panes even when the store arrived incomplete`);
    assert.equal(partial[key], pane0[key], `the repair lands in the store, not only on the runtime (${key})`);
  }
});

// The projection cache creates each of these Maps lazily and prunes them
// together through a hardcoded key list. If that list and this module's list
// ever diverge, a pane runtime pre-seeds a Map the prune never sweeps (a leak)
// or the prune reaches for a key no pane runtime seeds. Read the cache's own
// source so the two cannot drift silently.
test('SHARED_SESSION_CACHE_KEYS matches every uiRuntime cache-key list the projection cache carries', () => {
  const source = fs.readFileSync(PROJECTION_CACHE_PATH, 'utf8');

  const pruneMatch = source.match(PRUNE_LIST_PATTERN);
  assert.notEqual(pruneMatch, null, 'the projection cache should still declare `const uiRuntimeCaches = [...]` (update this guard if the prune moved)');
  assert.deepEqual(
    quotedNames(pruneMatch[1]),
    [...SHARED_SESSION_CACHE_KEYS],
    'the prune list and the shared-store key list must be the same three names'
  );

  // Every other array literal in that file that names projectionContextBySession
  // is the same set (clearProjectionContextCacheForSession's, today).
  const arrayLiterals = [...source.matchAll(SESSION_KEY_ARRAY_PATTERN)]
    .map((match) => quotedNames(match[1]))
    .filter((keys) => keys.includes('projectionContextBySession'));
  assert.ok(arrayLiterals.length >= 2, `expected the prune list and at least one sibling key list, got ${arrayLiterals.length}`);
  for (const keys of arrayLiterals) {
    assert.deepEqual(keys, [...SHARED_SESSION_CACHE_KEYS], 'every uiRuntime cache-key list in the projection cache is the shared set');
  }
});
