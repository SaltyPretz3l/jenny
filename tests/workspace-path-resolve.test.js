'use strict';

// renderer/shared/workspace-path-resolve.js: the one containment rule that maps a path the
// model printed to the workspace (row 95 phase 3). Pure; the main process stays the authority.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveWorkspacePath,
  relativeInRoot,
  parseAbsolutePathText,
  linkableAbsoluteSpans,
  setContextProvider,
  getContext,
  getWorkspaceRoot,
  onContextChange,
  normalizeRelPath,
  isOpenableRelPath,
  clampLine,
  parseInlineCodeRelPath,
  paneOf,
  createPaneScope,
  isEditableTarget,
  hasTextSelection,
  ensureMoreButton,
  MORE_CLASS,
  CHIP_SELECTOR,
} = require('../renderer/shared/workspace-path-resolve');
const { JSDOM } = require('jsdom');

const WIN = 'G:\\ws';
const POSIX = '/home/dev/ws';

function rel(raw, workspaceRoot = WIN) {
  const hit = resolveWorkspacePath(raw, { workspaceRoot });
  assert.ok(hit && hit.kind === 'relative', `expected relative for ${raw}, got ${JSON.stringify(hit)}`);
  return hit;
}

test('a Windows path inside the root maps to a relative path with its line and column', () => {
  const hit = rel('G:\\ws\\src\\app.js:42:7');
  assert.equal(hit.relPath, 'src/app.js');
  assert.equal(hit.line, 42);
  assert.equal(hit.column, 7);
  assert.equal(hit.isDir, false);
});

test('forward slashes, drive-letter case and segment case do not matter on a Windows root', () => {
  assert.equal(rel('G:/ws/src/app.js').relPath, 'src/app.js');
  assert.equal(rel('g:\\WS\\src\\app.js').relPath, 'src/app.js');
  assert.equal(rel('g:/Ws/Src/App.js', 'G:/ws/').relPath, 'Src/App.js');
});

test('(line,col) and (line) suffixes parse', () => {
  const both = rel('G:\\ws\\a.ts(12,3)');
  assert.deepEqual([both.relPath, both.line, both.column], ['a.ts', 12, 3]);
  const one = rel('G:\\ws\\a.ts(9)');
  assert.deepEqual([one.relPath, one.line, one.column], ['a.ts', 9, null]);
});

test('file:/// URLs decode percent escapes and keep the suffix', () => {
  const hit = rel('file:///G:/ws/my%20docs/a.md:3');
  assert.equal(hit.relPath, 'my docs/a.md');
  assert.equal(hit.line, 3);
  assert.equal(rel('file://localhost/home/dev/ws/x.py', POSIX).relPath, 'x.py');
  assert.equal(resolveWorkspacePath('file://evil.example/share/x', { workspaceRoot: WIN }), null);
  assert.equal(resolveWorkspacePath('file:///G:/ws/%ZZ.js', { workspaceRoot: WIN }), null);
  assert.equal(resolveWorkspacePath('https://example.com/a.js', { workspaceRoot: WIN }), null);
});

test('POSIX paths compare case-sensitively', () => {
  assert.equal(rel('/home/dev/ws/src/a.js:5', POSIX).relPath, 'src/a.js');
  const miss = resolveWorkspacePath('/home/dev/WS/src/a.js', { workspaceRoot: POSIX });
  assert.equal(miss.kind, 'outside');
  assert.equal(resolveWorkspacePath('G:\\ws\\a.js', { workspaceRoot: POSIX }).kind, 'outside');
  assert.equal(resolveWorkspacePath('/home/dev/ws/a.js', { workspaceRoot: WIN }).kind, 'outside');
});

test('an absolute path outside the root, or with no root, is outside and carries a display string', () => {
  const out = resolveWorkspacePath('C:/Users/me/secret.txt:9', { workspaceRoot: WIN });
  assert.deepEqual(out, { kind: 'outside', display: 'C:\\Users\\me\\secret.txt', line: 9, column: null, isDir: false });
  assert.equal(resolveWorkspacePath('G:\\ws2\\a.js', { workspaceRoot: WIN }).kind, 'outside', 'a sibling prefix is not inside');
  assert.equal(resolveWorkspacePath('G:\\ws\\a.js', { workspaceRoot: '' }).kind, 'outside');
});

test('a ".." that climbs out of the root is rejected or outside, never relative', () => {
  assert.equal(resolveWorkspacePath('G:\\ws\\..\\..\\secret', { workspaceRoot: WIN }), null);
  assert.equal(resolveWorkspacePath('G:\\ws\\sub\\..\\..\\secret.txt', { workspaceRoot: WIN }), null);
  const outside = resolveWorkspacePath('G:\\other\\..\\..\\x', { workspaceRoot: WIN });
  assert.ok(outside === null || outside.kind === 'outside');
  assert.equal(resolveWorkspacePath('../up.js', { workspaceRoot: WIN }), null);
  assert.equal(rel('a/b/../c.js').relPath, 'a/c.js');
});

test('UNC, device and NTFS stream names are rejected', () => {
  for (const bad of [
    '\\\\server\\share\\a.js',
    '//server/share/a.js',
    '\\\\?\\G:\\ws\\a.js',
    '\\\\.\\PhysicalDrive0',
    'file:////server/share/a.js',
    'G:\\ws\\a.js:stream',
    'G:\\ws\\a.js:stream:$DATA',
    'a/b.js:evil',
    'G:foo.js',
    'G:\\ws\\*.js',
    'G:\\ws\\a?.js',
  ]) {
    assert.equal(resolveWorkspacePath(bad, { workspaceRoot: WIN }), null, bad);
  }
});

test('junk and control characters resolve to null', () => {
  assert.equal(resolveWorkspacePath('', { workspaceRoot: WIN }), null);
  assert.equal(resolveWorkspacePath('   ', { workspaceRoot: WIN }), null);
  assert.equal(resolveWorkspacePath(null, { workspaceRoot: WIN }), null);
  assert.equal(resolveWorkspacePath('G:\\ws\\a\u0000b.js', { workspaceRoot: WIN }), null);
  assert.equal(resolveWorkspacePath('x'.repeat(2000), { workspaceRoot: WIN }), null);
});

test('relative paths pass through, and a trailing slash marks a directory', () => {
  const file = rel('src/app.js:3');
  assert.deepEqual([file.relPath, file.line], ['src/app.js', 3]);
  const dir = rel('G:\\ws\\src\\');
  assert.equal(dir.relPath, 'src');
  assert.equal(dir.isDir, true);
  assert.equal(rel('G:\\ws').relPath, '', 'the root itself has an empty relative path');
});

test('relativeInRoot is the bare containment rule file-link-detect uses', () => {
  assert.equal(relativeInRoot('G:\\ws\\src\\a.js', 'G:\\ws'), 'src/a.js');
  assert.equal(relativeInRoot('G:\\other\\a.js', 'G:\\ws'), null);
  assert.equal(relativeInRoot('/etc/passwd', ''), null);
  assert.equal(relativeInRoot('lib/a.js', '', 'pkg'), 'pkg/lib/a.js');
  assert.equal(relativeInRoot('../x.js', 'G:\\ws', ''), null);
});

test('parseAbsolutePathText accepts whole-text absolute paths only', () => {
  assert.deepEqual(parseAbsolutePathText('G:\\ws\\src\\app.js:42:7'), { path: 'G:/ws/src/app.js', line: 42, column: 7, isDir: false });
  assert.deepEqual(parseAbsolutePathText('/home/dev/ws/src/'), { path: '/home/dev/ws/src/', line: null, column: null, isDir: true });
  assert.equal(parseAbsolutePathText('/clear'), null, 'a slash command is not a path');
  assert.equal(parseAbsolutePathText('/api/'), null, 'one segment is not enough');
  assert.equal(parseAbsolutePathText('G:\\ws\\..\\x.js'), null);
  assert.equal(parseAbsolutePathText('\\\\srv\\share\\a.js'), null);
  assert.equal(parseAbsolutePathText('src/app.js'), null);
  assert.equal(parseAbsolutePathText('see G:\\ws\\a.js'), null);
  assert.equal(parseAbsolutePathText('file:///G:/ws/a%20b.js:4').path, 'G:/ws/a b.js');
});

test('linkableAbsoluteSpans keeps only in-root paths and trims prose punctuation', () => {
  const text = 'Edited G:\\ws\\src\\a.js:12. Also C:\\Users\\me\\x.txt and G:/ws/lib/ (a folder) plus https://h.io/a/b/c.js.';
  const spans = linkableAbsoluteSpans(text, WIN);
  assert.deepEqual(spans.map((s) => [text.slice(s.index, s.index + s.length), s.relPath, s.line]), [
    ['G:\\ws\\src\\a.js:12', 'src/a.js', 12],
    ['G:/ws/lib/', 'lib', null],
  ]);
  assert.equal(spans[1].isDir, true);
  assert.deepEqual(linkableAbsoluteSpans('see G:\\ws\\a.js', ''), []);
  const posix = linkableAbsoluteSpans('wrote /home/dev/ws/out/r.md, then /etc/hosts', POSIX);
  assert.deepEqual(posix.map((s) => s.relPath), ['out/r.md']);
  assert.deepEqual(linkableAbsoluteSpans('see G:\\ws\\..\\..\\secret.txt', WIN), []);
});

test('the context provider is off until set and survives a throwing provider', () => {
  assert.deepEqual(getContext(), { enabled: false, workspaceRoot: '' });
  setContextProvider(() => ({ enabled: true, workspaceRoot: WIN }));
  assert.deepEqual(getContext(), { enabled: true, workspaceRoot: WIN });
  setContextProvider(() => { throw new Error('gone'); });
  assert.equal(getContext().enabled, false);
  setContextProvider(null);
  assert.equal(getContext().enabled, false);
});

// ---- chat path helpers (moved here from renderer-chat-path-open.js) ----

test('isOpenableRelPath accepts contained relative paths and rejects escapes', () => {
  assert.equal(isOpenableRelPath('renderer/app.js'), true);
  assert.equal(isOpenableRelPath('a/b/c.spec.ts'), true);
  for (const bad of ['/etc/passwd', 'C:/secrets.txt', 'a/../../b.js', '../up.js', 'has space.js', '', 'a\u0000b', 'a/' + 'x'.repeat(520)]) {
    assert.equal(isOpenableRelPath(bad), false, bad);
  }
});

test('normalizeRelPath trims and flips backslashes; clampLine keeps positive integers only', () => {
  assert.equal(normalizeRelPath('  a\\b\\c.js '), 'a/b/c.js');
  assert.equal(normalizeRelPath(null), '');
  assert.equal(clampLine('7'), 7);
  assert.equal(clampLine('0'), null);
  assert.equal(clampLine('x'), null);
});

test('parseInlineCodeRelPath reads relative paths with an optional :line[:column] and nothing else', () => {
  assert.deepEqual(parseInlineCodeRelPath('src/a.js'), { path: 'src/a.js', line: null, column: null });
  assert.deepEqual(parseInlineCodeRelPath('./src\\a.js:42:7'), { path: './src/a.js', line: 42, column: 7 });
  for (const inert of ['state.ui.followLatest', 'a.js', 'C:/x/y.js', '/abs/path.js', '../up/a.js', 'src/a b.js', '']) {
    assert.equal(parseInlineCodeRelPath(inert), null, inert);
  }
});

test('isEditableTarget and hasTextSelection guard the native menu', () => {
  const dom = new JSDOM('<input id="i"><div contenteditable="true"><b id="e">x</b></div><p id="p">hello</p>');
  const doc = dom.window.document;
  assert.equal(isEditableTarget(doc.getElementById('i')), true);
  assert.equal(isEditableTarget(doc.getElementById('e')), true);
  assert.equal(isEditableTarget(doc.getElementById('p')), false);
  assert.equal(isEditableTarget(null), false);
  assert.equal(hasTextSelection(dom.window), false);
  assert.equal(hasTextSelection(null), false);
  const range = doc.createRange();
  range.selectNodeContents(doc.getElementById('p'));
  dom.window.getSelection().addRange(range);
  assert.equal(hasTextSelection(dom.window), true);
});

test('paneOf names the split-view pane; createPaneScope finds another pane\'s roots at event time', () => {
  const dom = new JSDOM('<div id="host"><div class="chat-pane" data-pane-id="0"><div data-chat-node="chatTimeline" id="t0"><i id="a"></i></div></div>'
    + '<div class="chat-pane" data-pane-id="1"><div data-chat-node="chatTimeline" id="t1"><i id="b"></i></div>'
    + '<div data-chat-node="subagentInspector" id="s1"><i id="c"></i></div></div></div><i id="out"></i>');
  const doc = dom.window.document;
  const el = (id) => doc.getElementById(id);
  assert.equal(paneOf(el('a')), 0);
  assert.equal(paneOf(el('b')), 1);
  assert.equal(paneOf(el('out')), 0);
  assert.equal(paneOf(null), 0);
  const scope = createPaneScope({ paneHost: doc, chatTimeline: el('t0'), pathRoots: [el('t0')] });
  assert.equal(scope.otherPaneRoot(el('a')), null, 'pane 0 keeps its own direct listeners');
  assert.equal(scope.otherPaneRoot(el('b')), el('t1'));
  assert.equal(scope.otherPaneRoot(el('c')), el('s1'));
  assert.equal(scope.insideTimeline(el('b')), true);
  assert.equal(scope.insideTimeline(el('c')), false, 'an inspector is not the timeline');
  assert.equal(scope.insidePathRoot(el('c')), true);
  assert.equal(scope.insidePathRoot(el('out')), false);
  const seen = [];
  const handler = scope.forOtherPane((event) => seen.push(event.target.id));
  handler({ target: el('a') });
  handler({ target: el('b') });
  assert.deepEqual(seen, ['b']);
});

test('ensureMoreButton inserts one menu button right after the chip and reuses it', () => {
  const dom = new JSDOM('<p><span class="tool-path-chip" data-chat-path-open="a/b.js">a/b.js</span> tail</p>');
  const chip = dom.window.document.querySelector(CHIP_SELECTOR);
  assert.ok(chip, 'tool-row and prose chips match the selector');
  const button = ensureMoreButton(chip, 'More for this path');
  assert.equal(ensureMoreButton(chip, 'More for this path'), button);
  assert.equal(chip.nextElementSibling, button);
  assert.equal(button.className, MORE_CLASS);
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(dom.window.document.querySelectorAll('.' + MORE_CLASS).length, 1);
});

test('clampLine takes an optional ceiling (the cite cap) and stays uncapped without one', () => {
  assert.equal(clampLine('999999999999'), 999999999999);
  assert.equal(clampLine('999999999999', 100000000), 100000000);
  assert.equal(clampLine('5', 100000000), 5);
  assert.equal(clampLine('0', 10), null);
});

test('onContextChange fires once when the flag and a root first become usable, and getWorkspaceRoot ignores the flag', async () => {
  let ctx = { enabled: true, workspaceRoot: '' };
  const seen = [];
  const stop = onContextChange(() => seen.push('change'));
  setContextProvider(() => ctx);
  await Promise.resolve();
  assert.deepEqual(seen, [], 'no root yet: nothing usable to announce');
  ctx = { enabled: true, workspaceRoot: WIN };
  getContext();
  getContext();
  await Promise.resolve();
  assert.deepEqual(seen, ['change'], 'announced once for the new root');
  ctx = { enabled: false, workspaceRoot: WIN };
  assert.equal(getContext().enabled, false);
  assert.equal(getWorkspaceRoot(), WIN, 'the rail job menu needs the root even with absolute links off');
  ctx = { enabled: true, workspaceRoot: WIN };
  getContext();
  await Promise.resolve();
  assert.deepEqual(seen, ['change', 'change'], 'turning links back on announces again');
  stop();
  ctx = { enabled: true, workspaceRoot: POSIX };
  getContext();
  await Promise.resolve();
  assert.equal(seen.length, 2, 'an unsubscribed listener stays quiet');
  setContextProvider(null);
  assert.equal(getWorkspaceRoot(), '');
});
