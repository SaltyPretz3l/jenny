'use strict';

// new-test-file: renderer-team-project-files.js and renderer-team-project-file-pane.js are new modules (row 175 round 2,
// D13): a project's files as a tree in the Team preview column and the workspace panel. No existing file covers the
// explorer; the preview column's own file stays on attachments.
// Browse files on the project page through the Team tab harness (every bridge call checked against main's payload
// rules at teardown): the tree and its states, paging, keys, the file preview (text, Markdown, picture, cut, gone), the
// path menu, the workspace panel and its Esc, and that host names stay text.

const test = require('node:test');
const assert = require('node:assert/strict');

const { P1, P2, OTHER, openProjects, projectRow, region, flush } = require('./helpers/team-project-renderer-host');
const files = require('../renderer/team/renderer-team-project-files');
const panes = require('../renderer/team/renderer-team-project-file-pane');

const file = (path, size = 2048) => ({ path, size, kind: 'file' });
const dir = (path) => ({ path, size: 0, kind: 'dir' });
const page = (entries, over = {}) => ({ ok: true, entries, next_cursor: null, total: entries.length, capped: false, ...over });
const textRead = (path, text, over = {}) => ({ ok: true, path, size: Buffer.byteLength(text), text, truncated: false, binary: false, ...over });
const ENTRIES = [file('README.md', 120), dir('site'), file('site/index.html', 4096), dir('site/js'), file('site/js/app.js', 9000), file('site/js/util.js', 512), file('zeta.txt', 10)];

async function browse(t, answers = {}, options = {}) {
  const opened = await openProjects({ answers: { projectFiles: page(ENTRIES), ...answers }, ...options });
  t.after(() => { panes.closeWorkspace(); opened.h.restore(); });
  const { h } = opened;
  projectRow(h, options.project || P1).click();
  await flush();
  return { ...opened, h };
}
const button = (h, action) => region(h).querySelector(`[data-project-action="${action}"]`);
const column = (h) => h.view.q('aside.team-preview');
const rows = (h, scope = column(h)) => [...scope.querySelectorAll('.team-ftree__row')];
const rowText = (el) => [el.querySelector('.team-row__name').textContent, el.querySelector('.team-row__meta').textContent];
const rowOf = (h, path, scope) => rows(h, scope).find((el) => el.dataset.ftreePath === path);
const act = (h, name, scope = column(h)) => scope.querySelector(`[data-team-files-action="${name}"]`);
const key = (h, el, name, extra = {}) => el.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra }));
const active = (h) => h.window.document.activeElement;

async function openTree(t, answers, options) {
  const opened = await browse(t, answers, options);
  button(opened.h, 'browse-files').click();
  await flush();
  return opened;
}

test('the model: the pages fold into folders first, counts below each folder, and "so far" where a later page could add', () => {
  const tree = files.foldTree(ENTRIES);
  assert.deepEqual([tree.top.count, tree.nodes.get('site').count, tree.nodes.get('site/js').count], [5, 3, 2]);
  const shown = files.visibleRows(tree, new Set(['site']));
  assert.deepEqual(shown.map((r) => r.path), ['site', 'site/js', 'site/index.html', 'README.md', 'zeta.txt']);
  // Rows come in path order: after "site/js/app.js" only "site/js/…" and later paths can come.
  assert.equal(files.soFar('site/js', 'site/js/app.js', false), true);
  assert.equal(files.soFar('site', 'site/js/app.js', false), true);
  assert.equal(files.soFar('docs', 'site/js/app.js', false), false);
  assert.equal(files.soFar('zz', 'site/js/app.js', false), true, 'a folder sorting after the cut may still grow');
  assert.equal(files.soFar('site', 'site/js/app.js', true), false);
  assert.equal(files.isPath('a/../b'), false);
  assert.equal(files.detailFor({ teamId: OTHER, projectId: 'nope' }), null);
});

test('Browse files opens the tree in the preview column: folders first, counts and sizes, the head counts entries', async (t) => {
  const { h } = await openTree(t);
  assert.deepEqual(h.sent('projectFiles').map((c) => c.payload), [{ team_id: OTHER, project_id: P1 }]);
  assert.equal(h.view.q('.team-shell').dataset.preview, 'side');
  assert.equal(column(h).getAttribute('aria-label'), 'Files in jenny-site');
  assert.equal(column(h).querySelector('.team-preview__meta').textContent, 'jenny-site · 7 entries');
  assert.deepEqual(rows(h).map(rowText), [['site', '3 files'], ['README.md', '1 KB'], ['zeta.txt', '1 KB']]);
  assert.equal(rows(h)[0].getAttribute('aria-expanded'), 'false');
  assert.equal(rows(h)[0].getAttribute('role'), 'treeitem');
  rows(h)[0].click();
  await flush();
  assert.deepEqual(rows(h).map((el) => el.dataset.ftreePath), ['site', 'site/js', 'site/index.html', 'README.md', 'zeta.txt']);
  assert.equal(rowOf(h, 'site/js').getAttribute('aria-level'), '2');
  // Close returns the focus to Browse files.
  act(h, 'close').click();
  await flush();
  assert.equal(column(h).hidden, true);
  assert.equal(h.view.q('.team-shell').dataset.preview, undefined);
  assert.equal(active(h), button(h, 'browse-files'));
});

test('keys: Up, Down, Home and End move; Right opens a folder and steps in; Left folds and steps out', async (t) => {
  const { h } = await openTree(t);
  const first = rows(h)[0];
  first.focus();
  key(h, first, 'ArrowDown');
  assert.equal(active(h).dataset.ftreePath, 'README.md');
  key(h, active(h), 'End');
  assert.equal(active(h).dataset.ftreePath, 'zeta.txt');
  key(h, active(h), 'Home');
  assert.equal(active(h).dataset.ftreePath, 'site');
  key(h, active(h), 'ArrowRight');
  assert.equal(rowOf(h, 'site').getAttribute('aria-expanded'), 'true');
  assert.equal(active(h).dataset.ftreePath, 'site');
  key(h, active(h), 'ArrowRight');
  assert.equal(active(h).dataset.ftreePath, 'site/js');
  key(h, active(h), 'ArrowLeft');
  assert.equal(active(h).dataset.ftreePath, 'site', 'Left on a closed folder steps to its folder');
  key(h, active(h), 'ArrowLeft');
  assert.equal(rowOf(h, 'site').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(rows(h).filter((el) => el.tabIndex === 0).map((el) => el.dataset.ftreePath), ['site'], 'one row holds the tab stop');
});

test('a long list: 500 a page, Show 500 more until complete, the folder the cut falls in says so far', async (t) => {
  const many = Array.from({ length: 700 }, (_, i) => file('big/f' + String(i).padStart(4, '0') + '.txt', 10));
  const all = [dir('big'), ...many];
  const projectFiles = (payload) => {
    const at = payload.cursor || 0;
    const end = Math.min(at + 500, all.length);
    return page(all.slice(at, end), { next_cursor: end < all.length ? end : null, total: all.length });
  };
  const { h } = await openTree(t, { projectFiles });
  assert.deepEqual(rowText(rows(h)[0]), ['big', '499 files so far']);
  assert.match(column(h).querySelector('.team-ftree__foot').textContent, /Showing the first 500 of 701 entries, in path order\./);
  const more = column(h).querySelector('[data-ftree-action="more"]');
  assert.equal(more.textContent, 'Show 201 more');
  more.click();
  await flush();
  assert.deepEqual(h.sent('projectFiles').map((c) => c.payload), [{ team_id: OTHER, project_id: P1 }, { team_id: OTHER, project_id: P1, cursor: 500 }]);
  assert.deepEqual(rowText(rows(h)[0]), ['big', '700 files']);
  assert.equal(column(h).querySelector('.team-ftree__foot'), null);
});

test('the states: loading, empty, unavailable from the host, failed with Try again', async (t) => {
  let release;
  const { h } = await openTree(t, { projectFiles: () => new Promise((resolve) => { release = resolve; }) });
  assert.equal(column(h).querySelector('.team-ftree__state').textContent, 'Reading the list of files…');
  release(page([]));
  await flush();
  assert.match(column(h).querySelector('.team-ftree__state').textContent, /No files yet\.Files appear here when someone uploads a folder or Jenny writes one\./);
});

test('a host refusal in the tree: unavailable says the sentence, any other failure offers Try again', async (t) => {
  let answer = { ok: false, error: { code: '', reason: 'team_project_files_unavailable' } };
  const { h } = await openTree(t, { projectFiles: () => answer });
  assert.match(column(h).querySelector('.team-ftree__state').textContent, /cannot give Jenny confined access to files yet/);
  act(h, 'close').click();
  answer = { ok: false, error: { code: '', reason: 'team_unavailable' } };
  button(h, 'browse-files').click();
  await flush();
  const retry = column(h).querySelector('[data-ftree-action="retry"]');
  assert.ok(retry, 'Try again');
  answer = page(ENTRIES);
  retry.click();
  await flush();
  assert.equal(rows(h).length, 3);
});

test('a file opens with Back to files: numbered lines, folder · type · size, Copy text; Back returns to the tree on it', async (t) => {
  const { h } = await openTree(t, { projectFileRead: (p) => textRead(p.path, 'const a = 1;\nconst b = 2;\n') });
  rows(h)[0].click();
  await flush();
  rowOf(h, 'site/js').click();
  await flush();
  rowOf(h, 'site/js/app.js').click();
  await flush();
  assert.deepEqual(h.sent('projectFileRead').map((c) => c.payload), [{ team_id: OTHER, project_id: P1, path: 'site/js/app.js' }]);
  assert.equal(column(h).querySelector('.team-preview__name').textContent, 'app.js');
  assert.match(column(h).querySelector('.team-preview__meta').textContent, /^site\/js · .+ · 1 KB$/);
  assert.deepEqual([...column(h).querySelectorAll('.artifact-file-preview-row')].map((r) => [r.querySelector('.artifact-file-preview-gutter').textContent, r.querySelector('code').textContent]),
    [['1', 'const a = 1;'], ['2', 'const b = 2;']]);
  assert.equal(active(h), act(h, 'back'));
  act(h, 'copy').click();
  await flush();
  assert.deepEqual(h.copied, ['const a = 1;\nconst b = 2;\n']);
  assert.equal(column(h).querySelector('.team-copied').textContent, 'Copied');
  act(h, 'back').click();
  await flush();
  assert.equal(rowOf(h, 'site/js/app.js').getAttribute('aria-current'), 'true');
  assert.equal(active(h), rowOf(h, 'site/js/app.js'));
  rowOf(h, 'site/js/app.js').click();
  await flush();
  assert.equal(h.sent('projectFileRead').length, 1, 'a second look reads nothing again');
});

test('Markdown: Rendered first, Source as code; markup in it is never an element; a cut file says so', async (t) => {
  const md = '# Title\n\n<img src=x onerror="window.pwned=1"> **bold**';
  const { h } = await openTree(t, { projectFileRead: (p) => textRead(p.path, md, { truncated: true, size: 300 * 1024 }) });
  rowOf(h, 'README.md').click();
  await flush();
  assert.equal(column(h).querySelector('.team-preview__md h1').textContent, 'Title');
  assert.equal(column(h).querySelectorAll('.team-preview__body img, .team-preview__body [onerror]').length, 0);
  assert.equal(column(h).querySelector('.team-preview__note').textContent, 'Showing the first 256 KB of 300 KB. Download a copy of the project for the whole file.');
  globalThis.inventory.segmentedControl.select(column(h).querySelector('[data-inv-segmented="team-files-view-column"]'), 'source');
  assert.equal(column(h).querySelector('.team-preview__md'), null);
  assert.equal(column(h).querySelector('.artifact-file-preview-row code').textContent, '# Title');
});

test('a picture shows as an image fitted to the width with its name as alt; not text, too large and gone say so', async (t) => {
  const answers = {
    'README.md': { ok: true, path: 'README.md', size: 4, image: { mime: 'image/png', data_base64: 'iVBORw==' } },
    'zeta.txt': { ok: true, path: 'zeta.txt', size: 10, text: '', truncated: false, binary: true },
    'site/index.html': { ok: true, path: 'site/index.html', size: 9e6, too_large: true },
  };
  const { h } = await openTree(t, { projectFileRead: (p) => answers[p.path] || { ok: false, error: { code: '', reason: 'team_not_found' } } });
  rowOf(h, 'README.md').click();
  await flush();
  const img = column(h).querySelector('.team-fimg__img');
  assert.equal(img.getAttribute('alt'), 'README.md');
  assert.equal(img.src, 'data:image/png;base64,iVBORw==');
  assert.equal(act(h, 'copy'), null, 'no Copy text for a picture');
  act(h, 'back').click();
  rowOf(h, 'zeta.txt').click();
  await flush();
  assert.match(column(h).querySelector('.team-preview__state').textContent, /^Jenny shows text, code and pictures here\./);
  act(h, 'back').click();
  rows(h)[0].click();
  rowOf(h, 'site/index.html').click();
  await flush();
  assert.match(column(h).querySelector('.team-preview__state').textContent, /^This picture is too large to show here\./);
  // A path the host no longer lists.
  panes.closeWorkspace();
  files.open({ teamId: OTHER, projectId: P1, path: 'site/gone.txt', from: button(h, 'browse-files') });
  await flush();
  assert.match(column(h).querySelector('.team-preview__state').textContent, /^This file is not in the project\.Jenny may have moved or deleted it since\./);
  assert.equal(column(h).querySelector('.team-preview__meta').textContent, 'site');
});

test('a file row\'s menu: Open preview, Copy path, Copy name through the inventory context menu', async (t) => {
  const { h } = await openTree(t, { projectFileRead: (p) => textRead(p.path, 'z') });
  const zeta = rowOf(h, 'zeta.txt');
  zeta.focus();
  key(h, zeta, 'F10', { shiftKey: true });
  const items = () => [...h.window.document.querySelectorAll('.inv-context-menu [role="menuitem"]')];
  assert.deepEqual(items().map((el) => el.textContent.trim()), ['Open preview', 'Copy path', 'Copy name']);
  items()[1].click();
  await flush();
  assert.deepEqual(h.copied, ['zeta.txt']);
  assert.equal(column(h).querySelector('.team-copied').textContent, 'Path copied');
  rowOf(h, 'zeta.txt').dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  items()[0].click();
  await flush();
  assert.equal(column(h).querySelector('.team-preview__name').textContent, 'zeta.txt');
  // A folder row has no menu.
  act(h, 'back').click();
  key(h, rowOf(h, 'site'), 'ContextMenu');
  assert.equal(items().length, 0);
});

test('Open in workspace panel: the tree and the file side by side in a wider panel; Esc closes it and the focus returns', async (t) => {
  const { h } = await openTree(t, { projectFileRead: (p) => textRead(p.path, 'hello') });
  rowOf(h, 'zeta.txt').click();
  await flush();
  const opener = act(h, 'workspace');
  opener.focus();
  opener.click();
  await flush();
  const panel = h.window.document.getElementById('teamFilesPanel');
  assert.ok(panel && !panel.hidden, 'the panel is open');
  assert.equal(panel.querySelector('.inv-drawer-header h2').textContent, 'Files in jenny-site');
  assert.equal(rows(h, panel).length, 3, 'the tree, read once');
  assert.equal(h.sent('projectFiles').length, 1);
  assert.equal(panel.querySelector('.team-fpanel__view .team-preview__name').textContent, 'zeta.txt');
  assert.equal(h.sent('projectFileRead').length, 1, 'the file shown in the column is not read again');
  rowOf(h, 'README.md', panel).click();
  await flush();
  assert.equal(panel.querySelector('.team-fpanel__view .team-preview__name').textContent, 'README.md');
  key(h, active(h), 'Escape');
  await flush();
  assert.equal(panel.hidden, true);
  assert.equal(active(h), opener);
  assert.ok(column(h) && !column(h).hidden, 'the column stays');
  // Close in the panel's own head does the same.
  opener.click();
  await flush();
  act(h, 'close', panel).click();
  assert.equal(panel.hidden, true);
  assert.equal(active(h), opener);
});

test('host names are text: escaped where drawn, dir auto, never an element', async (t) => {
  const evil = '<img src=x onerror="window.pwned=1">.txt';
  const amp = 'Tom & Jerry’s &amp; notes.txt';
  const { h } = await openTree(t, { projectFiles: page([file(evil, 3), file(amp, 3)]), projectFileRead: (p) => textRead(p.path, '<b>x</b>') }, { project: P2 });
  const row = rowOf(h, evil);
  assert.equal(row.querySelector('.team-row__name').textContent, evil);
  assert.equal(row.querySelector('.team-row__name').getAttribute('dir'), 'auto');
  assert.equal(row.getAttribute('title'), evil);
  assert.equal(column(h).querySelectorAll('img, b').length, 0);
  // A path main's payload rules allow (the host lists no name with < > or ").
  rowOf(h, amp).click();
  await flush();
  assert.equal(column(h).querySelector('.team-preview__name').textContent, amp);
  assert.equal(column(h).querySelector('.artifact-file-preview-row code').textContent, '<b>x</b>');
  assert.equal(column(h).querySelectorAll('.team-preview__head img, .team-preview__body b').length, 0);
  assert.equal(globalThis.pwned, undefined);
});

test('H23.3: switching Rendered and Source keeps the focus on the segment control, not on Close', async (t) => {
  const { h } = await openTree(t, { projectFileRead: (p) => textRead(p.path, '# Title\n\nbody') });
  rowOf(h, 'README.md').click();
  await flush();
  const segment = () => column(h).querySelector('[data-inv-segmented="team-files-view-column"]');
  segment().querySelector('[data-value="rendered"]').focus();
  globalThis.inventory.segmentedControl.select(segment(), 'source');
  const now = segment().querySelector('[role="radio"][aria-checked="true"]');
  assert.equal(now.dataset.value, 'source', 'the view switched');
  assert.equal(active(h), now, 'and the focus is on the chosen option of the same control');
  globalThis.inventory.segmentedControl.select(segment(), 'rendered');
  assert.equal(active(h), segment().querySelector('[role="radio"][aria-checked="true"]'), 'back again, still there');
});

test('C18: Refresh, a turn ending or a file tool writing reads the tree again and drops the kept file answers; another project\'s event does nothing', async (t) => {
  let list = ENTRIES;
  const { h } = await openTree(t, { projectFiles: () => page(list), projectFileRead: (p) => textRead(p.path, 'const a = 1;\n') });
  const changed = (detail) => h.window.document.dispatchEvent(new h.window.CustomEvent('team:files-changed', { bubbles: true, detail }));
  const reads = () => h.sent('projectFiles').length;
  assert.equal(rows(h).length, 3);
  list = [...ENTRIES, file('notes.txt', 5)];
  assert.ok(act(h, 'refresh'), 'a Refresh control in the Files column header');
  act(h, 'refresh').click();
  await flush();
  assert.equal(reads(), 2);
  assert.ok(rowOf(h, 'notes.txt'), 'the new file is listed without reopening');
  list = [...list, file('later.txt', 5)];
  changed({ teamId: OTHER, projectId: P2 });
  await flush();
  assert.equal(reads(), 2, 'another project\'s event reads nothing');
  changed({ teamId: OTHER, projectId: P1 });
  await flush();
  assert.equal(reads(), 3);
  assert.ok(rowOf(h, 'later.txt'));
  rowOf(h, 'README.md').click();
  await flush();
  act(h, 'back').click();
  await flush();
  rowOf(h, 'README.md').click();
  await flush();
  assert.equal(h.sent('projectFileRead').length, 1, 'kept: a second look reads nothing');
  act(h, 'back').click();
  await flush();
  changed({ teamId: OTHER, projectId: P1 });
  await flush();
  rowOf(h, 'README.md').click();
  await flush();
  assert.equal(h.sent('projectFileRead').length, 2, 'the kept answer was dropped: read again');
});

test('a project with one file says "1 entry"', async (t) => {
  const { h } = await openTree(t, { projectFiles: page([file('README.md', 120)]) });
  assert.equal(column(h).querySelector('.team-preview__meta').textContent, 'jenny-site · 1 entry');
});
