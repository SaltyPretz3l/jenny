// Split view W0-4: pane-scoped chat DOM roots.
//
// Every node a chat pane owns is reached today by id, through one document.
// With two panes an id is no longer unique, so the split-view template needs a
// seam that resolves a pane's nodes RELATIVE to that pane's root. This suite
// pins that seam, the attribute law it depends on, and a shrink-only ledger of
// the lookups that have not migrated yet.
//
// The attribute law, in one line: `data-chat-node="<id>"` and the value is
// always the id. That is what lets pane 0 keep using `getElementById` (today's
// nodes, byte-for-byte) while pane 1 resolves the same names inside its own
// root -- and why a pane root that lacks a node yields `null` and NEVER falls
// back to the document. A fallback would let pane 1 silently steal pane 0's
// nodes, which is the failure mode this whole slice exists to prevent.
//
// Scope, decided 2026-09-16: W0-4 ships the seam, the attributes and the
// ledger. It migrates NO call site. The remaining 40 lookups (plus one that
// reaches its id through a constant) are constructed from at-cap files and
// from modules that install themselves against the document before any
// composition can hand them nodes; migrating them is per-feature work that
// Wave 2 owns, feature by feature. Test 4 is that burn-down ledger: it is an
// EQUALITY, so a new lookup fails and a migrated one fails until the list
// shrinks with it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const {
  CHAT_PANE_NODE_NAMES,
  resolveChatPaneDom,
  createRendererSurfaceDom,
} = require('../renderer/shell/renderer-bootstrap-dom.js');
const { createRendererBootstrap } = require('../renderer/shell/renderer-bootstrap-utils.js');
const { loadRendererApp } = require('./helpers/renderer-shell-harness');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Directories the ledger scan covers. renderer-bootstrap-dom.js is the seam
// itself and is excluded; tests are not production lookups.
const LEDGER_SCAN_ROOTS = Object.freeze([
  'renderer/app.js',
  'renderer/app',
  'renderer/chat',
  'renderer/features',
  'renderer/shell',
]);
const LEDGER_SCAN_EXCLUDED = Object.freeze(['renderer/shell/renderer-bootstrap-dom.js']);

// `chatView` is the VIEW, not a pane node, so it is not in CHAT_PANE_NODE_NAMES --
// but a lookup of it is still a site Wave 2 has to give a pane root, so the
// ledger tracks it alongside the pane names.
const LEDGER_EXTRA_NAMES = Object.freeze(['chatView']);

// Wave 2 burn-down ledger: every `getElementById('<pane node>')` still standing
// in production, in BOTH call forms (`x.getElementById('id')` and the optional
// call `x?.getElementById?.('id')`), as `relative/path.js|id`, with the Wave 2
// owner that retires it. EQUALITY, not a subset: adding a lookup fails here,
// and so does removing one without shrinking this list. Pinned 2026-09-16 at
// 40 pairs / 23 files (26 plain-form, 14 optional-call-form; the first cut of
// the pattern knew only the plain form and pinned 26, which review caught).
// Grouped by owning feature rather than sorted, because the grouping is the
// point of the ledger; it is sorted at the comparison and pinned unique.
const REMAINING_LOOKUP_SITES = Object.freeze([
  // Wave 2 -- composer + wayfinder
  'renderer/app/renderer-app-controller-composition.js|composerWayfinderHost',
  'renderer/app/renderer-app-shell-bindings.js|stopStreamButton',
  'renderer/chat/renderer-chat-wayfinder-utils.js|composerWayfinderHost',
  'renderer/chat/renderer-render-pipeline-chrome.js|composerWayfinderHost',
  'renderer/chat/renderer-skill-slash-commands.js|chatInput',
  'renderer/chat/renderer-slash-autocomplete.js|chatInput',
  'renderer/chat/renderer-slash-autocomplete.js|composerTerminalShortcut',
  'renderer/chat/renderer-stream-handler-terminal.js|composerWrap',
  // Wave 2 -- chat chrome (timeline utility cluster, transcript bindings,
  // subagent monitor, shell runtime helpers)
  'renderer/app/renderer-app-lifecycle-composition.js|artifactSplitViewToggle',
  'renderer/chat/renderer-chat-event-transcript-bindings.js|chatInput',
  'renderer/chat/renderer-chat-event-transcript-bindings.js|timelineCollapseExpandToggle',
  'renderer/chat/renderer-chat-keyboard-utils.js|chatSelectionOverlayHost',
  'renderer/chat/renderer-chat-keyboard-utils.js|chatView',
  'renderer/chat/renderer-subagent-monitor-controller.js|chatView',
  'renderer/shell/renderer-shell-runtime-utils.js|chatTimeline',
  // Wave 2 -- chat search (its HOST_ID constant lookup is in INDIRECT_LOOKUP_SITES)
  'renderer/chat/renderer-chat-search-overlay.js|chatTimeline',
  'renderer/chat/renderer-chat-search-overlay.js|chatView',
  // Wave 2 -- codebase citations
  'renderer/chat/renderer-chat-codebase-cite-utils.js|chatTimeline',
  // Wave 2 -- plan document
  'renderer/chat/renderer-plan-document-controller.js|chatTimeline',
  // Wave 2 -- artifact review panel belongs to a pane
  'renderer/features/renderer-artifact-file-preview.js|artifactReviewPanel',
  'renderer/shell/renderer-shell-artifact-bridge.js|artifactReviewPanel',
  'renderer/shell/renderer-shell-artifact-bridge.js|artifactSplitViewToggle',
  'renderer/shell/renderer-shell-artifact-bridge.js|chatInput',
  'renderer/shell/renderer-shell-artifact-bridge.js|chatTimelineUtilityCluster',
  // Wave 2 -- IDE dock
  'renderer/features/renderer-ide-active-file-context.js|composerWrap',
  'renderer/features/renderer-ide-chat-dock.js|artifactReviewResizer',
  'renderer/features/renderer-ide-chat-dock.js|chatInput',
  'renderer/features/renderer-ide-chat-dock.js|chatThreadScroll',
  'renderer/features/renderer-ide-chat-dock.js|chatThreadStage',
  'renderer/features/renderer-ide-chat-dock.js|chatTimeline',
  'renderer/features/renderer-ide-chat-dock.js|chatView',
  'renderer/features/renderer-ide-chat-dock.js|composerWrap',
  'renderer/features/renderer-ide-mention-autocomplete.js|chatInput',
  // Wave 2 -- task rail + dashboard (focused-pane consumers)
  'renderer/features/renderer-dashboard-manager.js|chatInput',
  'renderer/features/renderer-task-rail.js|artifactReviewPanel',
  'renderer/features/renderer-task-rail.js|chatInput',
  'renderer/features/renderer-task-rail.js|chatTimelineUtilityCluster',
  // Wave 2 -- agent hooks
  'renderer/shell/renderer-agent-hooks.js|chatInput',
  'renderer/shell/renderer-agent-hooks.js|chatTimeline',
  'renderer/shell/renderer-agent-hooks.js|sendButton',
]);

// The lookups the pattern above cannot see: the id is reached through a
// CONSTANT (`var HOST_ID = 'chatSearchOverlayHost'; ... getElementById(HOST_ID)`).
// A second scan resolves the identifier through its string assignment in the
// same file, and this list is pinned by the same equality. One site today.
const INDIRECT_LOOKUP_SITES = Object.freeze([
  // Wave 2 -- chat search (HOST_ID; the overlay also CREATES a duplicate-id host
  // when the node is missing, so its pane migration must go through the pane's
  // own chatSearchOverlayHost)
  'renderer/chat/renderer-chat-search-overlay.js|chatSearchOverlayHost',
]);

// Built from strings rather than written as /regex/ literals: the vacuous-oracle
// gate (scripts/checks/check_vacuous_oracle.py) lexes a skeleton that does not
// lex regex literals, and one inside a test block desynchronizes that block's
// brace matching.
// Both call forms. `(\?\.)?` is the optional call `getElementById?.(`, the
// dominant idiom in this tree; the string id is group 2.
function lookupPattern() {
  const names = [...CHAT_PANE_NODE_NAMES, ...LEDGER_EXTRA_NAMES].join('|');
  return new RegExp(`getElementById(\\?\\.)?\\(\\s*['"](${names})['"]`, 'g');
}

// A lookup whose argument is a bare identifier, in either call form.
function indirectLookupPattern() {
  return new RegExp('getElementById(\\?\\.)?\\(\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\)', 'g');
}

/**
 * The ledger scan, over a { relativePath: source } map so the same code can be
 * pointed at the real tree and at a synthetic one (see the self-proof below).
 * Line numbers are deliberately absent: a lookup moving inside its file is not
 * a change this ledger should notice.
 */
function collectLookupSites(sourcesByPath) {
  const pattern = lookupPattern();
  const sites = new Set();
  for (const [relativePath, source] of Object.entries(sourcesByPath)) {
    pattern.lastIndex = 0;
    let match = pattern.exec(String(source));
    while (match !== null) {
      sites.add(`${relativePath}|${match[2]}`);
      match = pattern.exec(String(source));
    }
  }
  return [...sites].sort();
}

/**
 * The constant-argument scan: `getElementById(IDENT)` where IDENT is assigned
 * a pane node id as a string somewhere in the same file. Same output shape.
 */
function collectIndirectLookupSites(sourcesByPath) {
  const names = [...CHAT_PANE_NODE_NAMES, ...LEDGER_EXTRA_NAMES];
  const sites = new Set();
  for (const [relativePath, source] of Object.entries(sourcesByPath)) {
    const text = String(source);
    const pattern = indirectLookupPattern();
    let match = pattern.exec(text);
    while (match !== null) {
      const identifier = match[2].split('$').join('\\$');
      const assignment = new RegExp(`\\b${identifier}\\s*=\\s*['"]([A-Za-z0-9_]+)['"]`).exec(text);
      if (assignment && names.includes(assignment[1])) sites.add(`${relativePath}|${assignment[1]}`);
      match = pattern.exec(text);
    }
  }
  return [...sites].sort();
}

function readProductionSources() {
  const sources = {};
  function walk(absolutePath, relativePath) {
    if (LEDGER_SCAN_EXCLUDED.includes(relativePath)) return;
    if (fs.statSync(absolutePath).isFile()) {
      if (relativePath.endsWith('.js')) sources[relativePath] = fs.readFileSync(absolutePath, 'utf8');
      return;
    }
    for (const entry of fs.readdirSync(absolutePath).sort()) {
      walk(path.join(absolutePath, entry), `${relativePath}/${entry}`);
    }
  }
  for (const scanRoot of LEDGER_SCAN_ROOTS) walk(path.join(ROOT, scanRoot), scanRoot);
  return sources;
}

function indexHtmlDocument() {
  return new JSDOM(INDEX_HTML).window.document;
}

test('with no pane root every chat pane node resolves to today\'s document node', () => {
  const documentRef = indexHtmlDocument();
  const resolved = resolveChatPaneDom(documentRef, null);

  assert.deepEqual(
    Object.keys(resolved).sort(),
    [...CHAT_PANE_NODE_NAMES].sort(),
    'the resolver returns exactly the pane node names'
  );
  for (const name of CHAT_PANE_NODE_NAMES) {
    assert.notEqual(resolved[name], null, `${name} must resolve without a pane root`);
    assert.equal(
      resolved[name],
      documentRef.getElementById(name),
      `${name} without a pane root must be exactly the node getElementById returns today`
    );
  }
  // undefined is the same answer as null: pane 0 is "no root given".
  const viaUndefined = resolveChatPaneDom(documentRef, undefined);
  for (const name of CHAT_PANE_NODE_NAMES) {
    assert.equal(viaUndefined[name], resolved[name], `${name} resolves the same for undefined and null`);
  }
});

test('the data-chat-node attributes in index.html are exactly the pane node names', () => {
  const documentRef = indexHtmlDocument();
  const marked = [...documentRef.querySelectorAll('[data-chat-node]')];
  const values = marked.map((node) => node.getAttribute('data-chat-node'));

  assert.deepEqual(
    [...values].sort(),
    [...CHAT_PANE_NODE_NAMES].sort(),
    'index.html must carry one data-chat-node per pane node name, none missing and none stray'
  );
  assert.equal(new Set(values).size, values.length, 'no data-chat-node value may appear twice');

  // The attribute value IS the id. Everything else in the seam depends on it.
  for (const node of marked) {
    assert.equal(
      node.getAttribute('data-chat-node'),
      node.getAttribute('id'),
      `data-chat-node must equal the id it mirrors (${node.getAttribute('id') || node.tagName})`
    );
  }
});

test('a pane root resolves its OWN nodes and never falls back to the document', () => {
  const documentRef = indexHtmlDocument();
  const originals = resolveChatPaneDom(documentRef, null);

  // A second pane: the same markup with every id stripped, because ids cannot
  // be duplicated. This is the shape W1 clones for pane 1.
  const paneRoot = documentRef.getElementById('chatView').cloneNode(true);
  paneRoot.removeAttribute('id');
  for (const node of paneRoot.querySelectorAll('[id]')) node.removeAttribute('id');
  documentRef.body.appendChild(paneRoot);

  const resolved = resolveChatPaneDom(documentRef, paneRoot);
  for (const name of CHAT_PANE_NODE_NAMES) {
    assert.notEqual(resolved[name], null, `${name} must resolve inside the pane root`);
    assert.equal(paneRoot.contains(resolved[name]), true, `${name} must resolve to a node INSIDE the pane root`);
    assert.notEqual(resolved[name], originals[name], `${name} must not be pane 0's node`);
  }

  // The load-bearing half: a root missing a node yields null, not the
  // document's node. Otherwise pane 1 steals pane 0's timeline.
  const timelineInRoot = resolved.chatTimeline;
  timelineInRoot.parentNode.removeChild(timelineInRoot);
  const afterRemoval = resolveChatPaneDom(documentRef, paneRoot);
  assert.equal(afterRemoval.chatTimeline, null, 'a pane root without the node resolves null');
  assert.notEqual(
    afterRemoval.chatTimeline,
    originals.chatTimeline,
    'a pane root must NEVER fall back to the document node'
  );
  // Its siblings still resolve: one missing node is not a broken pane.
  assert.notEqual(afterRemoval.chatInput, null, 'the rest of the pane still resolves');
});

// Review finding, 2026-09-16: only null/undefined mean pane 0. A root that was
// GIVEN but cannot be queried (a wrapper object, a ref, a stale id string) must
// not fall through to the document, or `resolvePane({ root })` would hand a
// second pane the first pane's whole surface.
test('a root that was given but cannot be queried resolves nothing, never the document', () => {
  const documentRef = indexHtmlDocument();
  const originals = resolveChatPaneDom(documentRef, null);
  const chatView = documentRef.getElementById('chatView');

  for (const bogusRoot of [{ root: chatView }, 'chatView', 1, true, Object.create(null)]) {
    const resolved = resolveChatPaneDom(documentRef, bogusRoot);
    assert.deepEqual(
      Object.keys(resolved).sort(),
      [...CHAT_PANE_NODE_NAMES].sort(),
      'the shape is the same: every name, all null'
    );
    for (const name of CHAT_PANE_NODE_NAMES) {
      assert.equal(resolved[name], null, `${name} must be null for a non-element root (${typeof bogusRoot})`);
    }
    assert.notEqual(resolved.chatTimeline, originals.chatTimeline, 'and in particular never pane 0\'s timeline');
  }
});

test('the Wave 2 burn-down ledger of un-migrated getElementById lookups is exact', () => {
  const actual = collectLookupSites(readProductionSources());

  assert.deepEqual(
    actual,
    [...REMAINING_LOOKUP_SITES].sort(),
    'this list is an EQUALITY ledger: a NEW pane-node getElementById in production must be added '
    + 'with its Wave 2 owner, and a lookup Wave 2 migrates to an injected pane root must be REMOVED '
    + 'from it. It may only shrink.'
  );
  assert.equal(
    new Set(REMAINING_LOOKUP_SITES).size,
    REMAINING_LOOKUP_SITES.length,
    'no ledger entry may be listed twice'
  );
  assert.equal(
    REMAINING_LOOKUP_SITES.length,
    40,
    'the ledger was pinned at 40 pairs on 2026-09-16 (26 plain-form, 14 optional-call-form)'
  );
  assert.equal(
    new Set(REMAINING_LOOKUP_SITES.map((pair) => pair.split('|')[0])).size,
    23,
    'across 23 files, each named with the Wave 2 feature that owns its migration'
  );

  // The constant-argument lookups the pattern cannot see: same equality, same
  // shrink-only rule.
  assert.deepEqual(
    collectIndirectLookupSites(readProductionSources()),
    [...INDIRECT_LOOKUP_SITES].sort(),
    'a getElementById(CONSTANT) site naming a pane node must be added here with its owner, and removed when migrated'
  );
});

test('the ledger scan itself detects both an added and a removed lookup', () => {
  // Without this, the equality above could be comparing two empty lists.
  const baseline = { 'renderer/chat/fake-a.js': "doc.getElementById('chatTimeline');" };
  assert.deepEqual(collectLookupSites(baseline), ['renderer/chat/fake-a.js|chatTimeline']);

  const withExtra = {
    ...baseline,
    'renderer/chat/fake-b.js': "document.getElementById( 'chatInput' )",
  };
  assert.deepEqual(
    collectLookupSites(withExtra),
    ['renderer/chat/fake-a.js|chatTimeline', 'renderer/chat/fake-b.js|chatInput'],
    'one site more must change the scan result'
  );

  assert.deepEqual(collectLookupSites({}), [], 'one site fewer must change it too');

  // A non-pane id is not a pane lookup, so the ledger cannot be padded by
  // unrelated getElementById calls.
  assert.deepEqual(
    collectLookupSites({ 'renderer/chat/fake-c.js': "doc.getElementById('settingsView')" }),
    [],
    'only CHAT_PANE_NODE_NAMES (plus chatView) count as pane lookups'
  );

  // The optional-call form counts: it is the dominant idiom in this tree, and
  // a pattern that missed it once pinned 26 sites of 40 and called it exact.
  assert.deepEqual(
    collectLookupSites({ 'renderer/chat/fake-d.js': "windowRef?.document?.getElementById?.('chatTimeline')" }),
    ['renderer/chat/fake-d.js|chatTimeline'],
    'x?.getElementById?.(\'id\') is a lookup'
  );

  // And the constant-argument scan resolves an identifier through its
  // assignment, in either call form, and ignores constants naming non-pane ids.
  assert.deepEqual(
    collectIndirectLookupSites({
      'renderer/chat/fake-e.js': "var HOST_ID = 'chatSearchOverlayHost';\nfunction f(doc) { return doc.getElementById(HOST_ID); }",
      'renderer/chat/fake-f.js': "const TIMELINE_ID = 'chatTimeline';\ndoc?.getElementById?.(TIMELINE_ID);",
      'renderer/chat/fake-g.js': "var HOST_ID = 'settingsView';\ndoc.getElementById(HOST_ID);",
    }),
    ['renderer/chat/fake-e.js|chatSearchOverlayHost', 'renderer/chat/fake-f.js|chatTimeline'],
    'a constant resolving to a pane node id is a lookup; one resolving elsewhere is not'
  );
  assert.deepEqual(collectIndirectLookupSites({}), [], 'and an empty tree yields an empty ledger');
});

test('createRendererSurfaceDom exposes resolvePane bound to the document it was given', () => {
  const documentRef = indexHtmlDocument();
  const surfaceDom = createRendererSurfaceDom(
    { chatTimeline: documentRef.getElementById('chatTimeline') },
    {},
    documentRef
  );

  assert.equal(typeof surfaceDom.chat.resolvePane, 'function', 'the chat surface group exposes resolvePane');
  assert.equal(
    surfaceDom.chat.resolvePane(null).chatTimeline,
    documentRef.getElementById('chatTimeline'),
    'resolvePane(null) is pane 0 over the document the bundle was built for'
  );

  const paneRoot = documentRef.createElement('div');
  const timeline = documentRef.createElement('div');
  timeline.setAttribute('data-chat-node', 'chatTimeline');
  paneRoot.appendChild(timeline);
  const scoped = surfaceDom.chat.resolvePane(paneRoot);
  assert.equal(scoped.chatTimeline, timeline, 'a pane root resolves its own node');
  assert.equal(scoped.chatInput, null, 'and nothing it does not hold');
});

test('the renderer boot threads its document into surfaceDom.chat.resolvePane', () => {
  // The bootstrap captures createRendererSurfaceDom at module load, so a test
  // that wrapped the global after the scripts ran could never see this wiring.
  // Build the real bootstrap over the real markup instead.
  const documentRef = indexHtmlDocument();
  const bootstrap = createRendererBootstrap({
    document: documentRef,
    getDefaultAppearancePreferences: () => ({}),
    appearanceUtils: { STORAGE_KEY: 'jenny.appearance.test' },
  });

  const resolvePane = bootstrap.surfaceDom.chat.resolvePane;
  assert.equal(typeof resolvePane, 'function', 'the boot must pass its document as the third argument');
  for (const name of CHAT_PANE_NODE_NAMES) {
    assert.equal(
      resolvePane(null)[name],
      documentRef.getElementById(name),
      `${name} resolves through the booted bundle to the boot document's node`
    );
  }
});

test('a real renderer boot resolves every chat pane node from the production markup', async (t) => {
  const app = await loadRendererApp({});
  t.after(async () => { await app.dispose(); });
  const { window } = app;

  assert.equal(
    typeof window.rendererBootstrapDom?.resolveChatPaneDom,
    'function',
    'the seam must be on the booted window'
  );
  const resolved = window.rendererBootstrapDom.resolveChatPaneDom(window.document, null);
  const missing = [...CHAT_PANE_NODE_NAMES].filter(
    (name) => resolved[name] !== window.document.getElementById(name) || resolved[name] == null
  );
  assert.deepEqual(missing, [], 'every pane node must resolve in a live boot of the real index.html');

  // And the pane-scoped path works against the live document, not just a
  // parsed one: this is the query the split-view template will run.
  const paneRoot = window.document.getElementById('chatView').cloneNode(true);
  paneRoot.removeAttribute('id');
  for (const node of paneRoot.querySelectorAll('[id]')) node.removeAttribute('id');
  window.document.body.appendChild(paneRoot);
  const scoped = window.rendererBootstrapDom.resolveChatPaneDom(window.document, paneRoot);
  assert.equal(paneRoot.contains(scoped.chatTimeline), true, 'the pane root resolves its own timeline');
  assert.notEqual(scoped.chatTimeline, resolved.chatTimeline, 'and not pane 0\'s');
});
