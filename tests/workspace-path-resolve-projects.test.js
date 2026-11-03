'use strict';

// renderer/shared/workspace-path-resolve.js, project links: an absolute path outside the workspace
// root but inside a registered project's folder classifies as { mode: 'project', ... } (a
// read-only preview of another project's file). Pure; the main process stays the authority.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const resolve = require('../renderer/shared/workspace-path-resolve');

const ROOTS = [
  { id: 'p-api', rootPath: 'G:\\Work\\api' },
  { id: 'p-api-web', rootPath: 'G:\\Work\\api\\web' },
  { id: 'p-notes', rootPath: 'D:/notes' },
  { id: 'p-posix', rootPath: '/home/dev/site' },
];

function ctx(overrides) {
  return Object.assign({
    enabled: true,
    workspaceRoot: 'G:\\ws',
    projectRoots: ROOTS,
    isOpenable: resolve.isOpenableRelPath,
    normalize: resolve.normalizeRelPath,
  }, overrides || {});
}

function classify(raw, overrides, line, column, kind) {
  return resolve.classifyChipTarget(raw, line || null, column || null, kind || '', ctx(overrides));
}

test('an absolute path in a registered project outside the workspace classifies as a project link', () => {
  assert.deepEqual(classify('D:\\notes\\2026\\plan.md:12:3'), {
    mode: 'project', projectId: 'p-notes', path: '2026/plan.md', line: 12, column: 3, display: 'D:\\notes\\2026\\plan.md',
  });
  const posix = classify('/home/dev/site/src/index.html');
  assert.equal(posix.mode, 'project');
  assert.equal(posix.projectId, 'p-posix');
  assert.equal(posix.path, 'src/index.html');
});

test('the longest matching project root wins', () => {
  const hit = classify('G:/Work/api/web/src/app.js');
  assert.equal(hit.projectId, 'p-api-web');
  assert.equal(hit.path, 'src/app.js');
  assert.equal(classify('G:/Work/api/lib/db.js').projectId, 'p-api');
});

test('drive letter and segment case and either slash direction match a Windows project root', () => {
  assert.equal(classify('d:/NOTES/a.md').projectId, 'p-notes');
  assert.equal(classify('D:\\Notes\\sub\\a.md').path, 'sub/a.md');
  assert.equal(classify('file:///D:/notes/a%20b.md').mode, 'copy', 'a space is not an openable relative path');
  assert.equal(classify('file:///D:/notes/a.md').projectId, 'p-notes');
});

test('a path outside the workspace and every project root stays copy-only', () => {
  assert.deepEqual(classify('C:\\Users\\me\\x.txt'), { mode: 'copy', display: 'C:\\Users\\me\\x.txt' });
  assert.deepEqual(classify('G:\\Work\\apix\\a.js'), { mode: 'copy', display: 'G:\\Work\\apix\\a.js' });
});

test('a directory inside a project, or the project root itself, is copy-only', () => {
  assert.equal(classify('D:\\notes\\2026\\').mode, 'copy');
  assert.equal(classify('D:\\notes\\2026', null, null, null, 'dir').mode, 'copy');
  assert.equal(classify('D:\\notes').mode, 'copy');
});

test('a path inside the workspace root keeps today behavior, even when a project has the same root', () => {
  const same = classify('G:\\ws\\src\\a.js:4', { projectRoots: ROOTS.concat([{ id: 'p-ws', rootPath: 'G:\\ws' }]) });
  assert.deepEqual(same, { mode: 'open', path: 'src/a.js', line: 4, column: null });
  assert.deepEqual(classify('src/a.js'), { mode: 'open', path: 'src/a.js', line: null, column: null });
});

test('with no workspace root the project roots still resolve', () => {
  const hit = classify('D:\\notes\\a.md', { workspaceRoot: '' });
  assert.equal(hit.mode, 'project');
  assert.equal(hit.projectId, 'p-notes');
});

test('the flag off or no project roots leaves the old classification', () => {
  assert.equal(classify('D:\\notes\\a.md', { enabled: false }), null);
  assert.deepEqual(classify('D:\\notes\\a.md', { projectRoots: [] }), { mode: 'copy', display: 'D:\\notes\\a.md' });
  assert.deepEqual(classify('D:\\notes\\a.md', { projectRoots: undefined }), { mode: 'copy', display: 'D:\\notes\\a.md' });
});

test('a ".." escape or a malformed root entry never produces a project link', () => {
  assert.equal(classify('D:\\notes\\..\\..\\etc\\x.txt').mode, 'copy', 'a climbing path is never a project file');
  const junk = classify('D:\\notes\\a.md', { projectRoots: [null, {}, { id: '', rootPath: 'D:/notes' }, { id: 'x', rootPath: '' }] });
  assert.equal(junk.mode, 'copy');
});

test('prose spans chip a project path with no workspace root, carrying the absolute text', () => {
  const text = 'See D:\\notes\\2026\\plan.md:12 and /home/dev/site/a.js. Not C:\\Users\\me\\x.txt.';
  const spans = resolve.linkableAbsoluteSpans(text, '', ROOTS);
  assert.deepEqual(spans.map((s) => [s.relPath, s.line, s.column, s.isDir]), [
    ['D:\\notes\\2026\\plan.md', 12, null, false],
    ['/home/dev/site/a.js', null, null, false],
  ]);
  assert.equal(text.slice(spans[0].index, spans[0].index + spans[0].length), 'D:\\notes\\2026\\plan.md:12');
});

test('prose spans: workspace paths stay relative, project dirs are not chipped, no roots at all is empty', () => {
  const spans = resolve.linkableAbsoluteSpans('G:\\ws\\src\\a.js and D:\\notes\\2026\\ here', 'G:\\ws', ROOTS);
  assert.deepEqual(spans.map((s) => s.relPath), ['src/a.js']);
  assert.deepEqual(resolve.linkableAbsoluteSpans('D:\\notes\\a.md', '', []), []);
  assert.deepEqual(resolve.linkableAbsoluteSpans('D:\\notes\\a.md', '', undefined), []);
});

test('a project chip classifies back to the project link from its own attributes', () => {
  const [span] = resolve.linkableAbsoluteSpans('D:\\notes\\a.md:5', '', ROOTS);
  const hit = classify(span.relPath, null, span.line, span.column);
  assert.deepEqual(hit, { mode: 'project', projectId: 'p-notes', path: 'a.md', line: 5, column: null, display: 'D:\\notes\\a.md' });
});

test('getContext publishes sanitized project roots only while links are on, and announces a new set once', async () => {
  let ctxValue = { enabled: true, workspaceRoot: '', projectRoots: [{ id: 'p1', rootPath: 'D:/notes', extra: 'x' }, { id: 7 }, null] };
  let announced = 0;
  const stop = resolve.onContextChange(() => { announced += 1; });
  resolve.setContextProvider(() => ctxValue);
  assert.deepEqual(resolve.getContext().projectRoots, [{ id: 'p1', rootPath: 'D:/notes' }]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(announced, 1, 'project roots alone make the context usable');
  resolve.getContext();
  await Promise.resolve();
  assert.equal(announced, 1, 'an unchanged context does not re-announce');
  ctxValue = { enabled: false, workspaceRoot: '', projectRoots: [{ id: 'p1', rootPath: 'D:/notes' }] };
  assert.deepEqual(resolve.getContext(), { enabled: false, workspaceRoot: '' });
  stop();
  resolve.setContextProvider(null);
});

function fakeSwitcher(projects, overrides) {
  const listeners = new Set();
  const calls = { opened: [], refreshed: 0 };
  const switcher = Object.assign({
    getProjects: () => projects,
    onProjectsChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    refresh() { calls.refreshed += 1; return Promise.resolve(projects); },
    openProjectAsWorkspace(id) { calls.opened.push(id); return Promise.resolve({ committed: true }); },
  }, overrides || {});
  return { switcher, calls, emit: () => listeners.forEach((fn) => fn()) };
}

const flushAll = () => new Promise((resolve) => setImmediate(resolve));

test('project link hooks cache the registered folders (not General, not missing) and re-announce when they load', async () => {
  const f = fakeSwitcher([
    { id: 'general', rootPath: '' },
    { id: 'p1', rootPath: 'D:/notes', folderMissing: false },
    { id: 'p2', rootPath: 'D:/gone', folderMissing: true },
  ]);
  const hooks = resolve.createProjectLinkHooks({ getProjectSwitcher: () => Promise.resolve(f.switcher), openIdeFileAtLine: async () => true, setActiveView() {} });
  assert.deepEqual(hooks.getProjectRoots(), [], 'cheap and synchronous before the switcher loads');
  let announced = 0;
  const stop = resolve.onContextChange(() => { announced += 1; });
  resolve.setContextProvider(() => ({ enabled: true, workspaceRoot: '', projectRoots: hooks.getProjectRoots() }));
  await flushAll();
  assert.deepEqual(hooks.getProjectRoots(), [{ id: 'p1', rootPath: 'D:/notes' }]);
  assert.equal(f.calls.refreshed, 1, 'warmed once');
  assert.ok(announced >= 1, 'the prose pass is told the folders arrived');
  hooks.getProjectRoots();
  await flushAll();
  assert.equal(f.calls.refreshed, 1, 'never re-warmed');
  stop();
  resolve.setContextProvider(null);
});

test('project link hooks stay empty and quiet when there is no switcher (hosted)', async () => {
  const hooks = resolve.createProjectLinkHooks({ getProjectSwitcher: () => Promise.resolve(null), openIdeFileAtLine: async () => true, setActiveView() {} });
  assert.deepEqual(hooks.getProjectRoots(), []);
  await flushAll();
  assert.deepEqual(hooks.getProjectRoots(), []);
  assert.equal(await hooks.openProjectFileInIde({ projectId: 'p1', path: 'a.md' }), false);
  const throwing = resolve.createProjectLinkHooks({ getProjectSwitcher: () => Promise.reject(new Error('load failed')), openIdeFileAtLine() {}, setActiveView() {} });
  assert.deepEqual(throwing.getProjectRoots(), []);
  await flushAll();
});

test('openProjectFileInIde switches the Workspace to the project, then opens the file in the IDE', async () => {
  const f = fakeSwitcher([]);
  const opened = [];
  const views = [];
  const hooks = resolve.createProjectLinkHooks({
    getProjectSwitcher: () => Promise.resolve(f.switcher),
    openIdeFileAtLine: async (path, line, column) => { opened.push({ path, line, column, afterSwitch: f.calls.opened.length }); return true; },
    setActiveView: (view) => views.push(view),
  });
  assert.equal(await hooks.openProjectFileInIde({ projectId: 'p1', path: 'src/a.js', line: 3, column: 2 }), true);
  assert.deepEqual(f.calls.opened, ['p1']);
  assert.deepEqual(opened, [{ path: 'src/a.js', line: 3, column: 2, afterSwitch: 1 }]);
  assert.deepEqual(views, ['ide']);
});

test('openProjectFileInIde opens on a noop switch and never on a blocked, refused or cancelled one', async () => {
  for (const [outcome, expected] of [[{ committed: false, noop: true }, true], [{ committed: false, blocked: true, code: 'workspace_folder_missing' }, false], [{ committed: false }, false], [null, false]]) {
    const f = fakeSwitcher([], { openProjectAsWorkspace: () => Promise.resolve(outcome) });
    let opens = 0;
    const hooks = resolve.createProjectLinkHooks({ getProjectSwitcher: () => Promise.resolve(f.switcher), openIdeFileAtLine: async () => { opens += 1; return true; }, setActiveView() {} });
    assert.equal(await hooks.openProjectFileInIde({ projectId: 'p1', path: 'a.js' }), expected, JSON.stringify(outcome));
    assert.equal(opens, expected ? 1 : 0);
  }
  const declined = resolve.createProjectLinkHooks({ getProjectSwitcher: () => Promise.resolve(fakeSwitcher([]).switcher), openIdeFileAtLine: async () => false, setActiveView() {} });
  assert.equal(await declined.openProjectFileInIde({ projectId: 'p1', path: 'a.js' }), false, 'an IDE decline is false');
});

test('createProjectLinks claims only a well-formed project event; a plain click never switches the Workspace', async () => {
  const calls = { preview: [], ide: [], fail: [] };
  let canPreview = true;
  const links = resolve.createProjectLinks({
    preview: async (target) => { calls.preview.push(target); return true; },
    ide: async (target) => { calls.ide.push(target); return true; },
    canPreview: () => canPreview,
    fail: (display, error) => calls.fail.push([display, error && error.message]),
  });
  const link = { projectId: 'p1', path: 'a.md', line: null, column: null, display: 'D:\\notes\\a.md' };
  assert.equal(await links.open(link, false), true);
  canPreview = false;
  assert.equal(await links.open(link, false), false, 'no rail: the click fails, it does not take the IDE route');
  assert.deepEqual([calls.preview.length, calls.ide.length], [1, 0]);
  assert.equal(await links.open(link, true), true, 'Open in IDE is the explicit route');
  assert.equal(links.claim({ projectId: 'p1', path: '../x' }), false);
  assert.equal(links.claim({ projectId: 3, path: 'a.md' }), false);
  assert.equal(links.claim({ projectId: 'p1', path: 'a.md', line: '4' }), true);
  await flushAll();
  assert.deepEqual(calls.ide[1], { projectId: 'p1', path: 'a.md', line: 4, column: null });
  const failing = resolve.createProjectLinks({ preview: async () => { throw new Error('nope'); }, ide: null, canPreview: () => true, fail: (d, e) => calls.fail.push([d, e && e.message]) });
  assert.equal(await failing.open(link, false), false);
  assert.equal(await failing.open(link, true), false, 'no IDE hook is a failure, not a throw');
  assert.deepEqual(calls.fail, [['D:\\notes\\a.md', null], ['D:\\notes\\a.md', 'nope'], ['D:\\notes\\a.md', null]]);
  assert.equal(failing.claim({ projectId: 'p1', path: 'a.md' }), false, 'no IDE hook: unclaimed');
});
