'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createEditorconfigResolver,
  createEditorconfigApplier,
  parseEditorconfig,
} = require('../renderer/features/renderer-ide-editorconfig');
const { createFakeTimers } = require('./helpers/fake-timers');

// Fake workspace: relPath -> content; counts every readText call.
function makeFs(files) {
  const reads = [];
  return {
    files,
    reads,
    readText: async (rel) => { reads.push(rel); return Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null; },
  };
}

function resolverFor(files, extra = {}) {
  const fs = makeFs(files);
  return { fs, resolver: createEditorconfigResolver({ readText: fs.readText, rootPath: '', ...extra }) };
}

test('closer .editorconfig files override farther ones; root=true files seed the chain', async () => {
  const fs = makeFs({
    '.editorconfig': 'root = true\n[*]\nindent_style = space\nindent_size = 2\n',
    'src/.editorconfig': '[*.js]\nindent_style = tab\n',
  });
  const resolver = createEditorconfigResolver({ readText: fs.readText, rootPath: '' });
  const js = await resolver.resolve('src/app.js');
  assert.equal(js.indent_style, 'tab');
  assert.equal(js.indent_size, 2);
  const md = await resolver.resolve('src/readme.md');
  assert.equal(md.indent_style, 'space');
  assert.equal(md.indent_size, 2);
});

test('within one file a later section overrides an earlier one', async () => {
  const { resolver } = resolverFor({
    '.editorconfig': '[*]\nindent_size = 2\nend_of_line = lf\n[*.py]\nindent_size = 4\n[*.js]\nend_of_line = crlf\n',
  });
  assert.equal((await resolver.resolve('a.py')).indent_size, 4);
  assert.equal((await resolver.resolve('a.py')).end_of_line, 'lf');
  assert.equal((await resolver.resolve('a.js')).end_of_line, 'crlf');
  assert.equal((await resolver.resolve('a.js')).indent_size, 2);
});

test('parser: comments, blank lines, case, unset, invalid values, unknown keys, BOM', () => {
  const parsed = parseEditorconfig([
    '\uFEFF# top comment', '; another', '', 'ROOT = TRUE', '[*.JS]', 'Indent_Style = TAB', 'indent_size = 0',
    'tab_width = banana', 'end_of_line = cr', 'trim_trailing_whitespace = maybe', 'insert_final_newline = TRUE',
    'charset = utf-8', '# inline comment line', 'indent_size = unset', 'garbage line',
  ].join('\r\n'));
  assert.equal(parsed.root, true);
  assert.equal(parsed.sections.length, 1);
  assert.deepEqual(parsed.sections[0].props, {
    indent_style: 'tab', insert_final_newline: true, indent_size: null,
  });
});

test('preamble keys other than root are ignored and root is only read before a section', () => {
  assert.equal(parseEditorconfig('indent_style = tab\n[*]\nroot = true\n').root, false);
  assert.deepEqual(parseEditorconfig('indent_style = tab\n[*]\nindent_size = 2\n').sections[0].props, { indent_size: 2 });
});

test('unset removes a key set by a lower-precedence file', async () => {
  const { resolver } = resolverFor({
    '.editorconfig': '[*]\nindent_style = space\nindent_size = 4\ninsert_final_newline = true\n',
    'sub/.editorconfig': '[*]\nindent_size = unset\ninsert_final_newline = unset\n',
  });
  assert.deepEqual(await resolver.resolve('sub/a.txt'), { indent_style: 'space' });
  assert.equal((await resolver.resolve('top.txt')).indent_size, 4);
});

test('invalid values are ignored and fall back to the earlier valid value', async () => {
  const { resolver } = resolverFor({
    '.editorconfig': '[*]\nindent_size = 4\nindent_size = lots\nend_of_line = lf\nend_of_line = cr\n',
  });
  const props = await resolver.resolve('a.txt');
  assert.equal(props.indent_size, 4);
  assert.equal(props.end_of_line, 'lf');
});

test('returns null when nothing applies', async () => {
  const { resolver } = resolverFor({ '.editorconfig': '[*.py]\nindent_size = 4\n' });
  assert.equal(await resolver.resolve('a.js'), null);
  const empty = resolverFor({});
  assert.equal(await empty.resolver.resolve('a.js'), null);
});

test('globs: basename anywhere, anchored with a slash, braces, and **', async () => {
  const { resolver } = resolverFor({
    '.editorconfig': [
      '[*.md]', 'indent_size = 1',
      '[src/*.js]', 'indent_size = 2',
      '[*.{ts,tsx}]', 'indent_size = 3',
      '[lib/**.rb]', 'indent_size = 5',
      '[**/test/*.c]', 'indent_size = 6',
      '[Makefile]', 'indent_style = tab',
    ].join('\n'),
  });
  const size = async (p) => (await resolver.resolve(p))?.indent_size;
  assert.equal(await size('docs/deep/a.md'), 1);
  assert.equal(await size('src/a.js'), 2);
  assert.equal(await size('lib/src/a.js'), undefined, 'a slash glob is anchored to the config directory');
  assert.equal(await size('src/x/a.js'), undefined);
  assert.equal(await size('x/y/a.tsx'), 3);
  assert.equal(await size('a.ts'), 3);
  assert.equal(await size('lib/a/b/c.rb'), 5);
  assert.equal(await size('a/test/b.c'), 6);
  assert.equal(await size('test/b.c'), 6);
  assert.equal((await resolver.resolve('pkg/Makefile')).indent_style, 'tab');
});

test('a nested config matches against the path relative to its own directory', async () => {
  const { resolver } = resolverFor({
    'pkg/.editorconfig': '[sub/*.js]\nindent_size = 8\n[*.js]\nindent_style = tab\n',
  });
  assert.equal((await resolver.resolve('pkg/sub/a.js')).indent_size, 8);
  assert.equal(await resolver.resolve('other/sub/a.js'), null);
  assert.equal((await resolver.resolve('pkg/a/b.js')).indent_style, 'tab');
});

// E3 starts every ancestor read at once, so a file past root=true may be read; it never applies.
test('root=true stops the chain: farther files never apply', async () => {
  const { fs, resolver } = resolverFor({
    '.editorconfig': '[*]\nindent_size = 9\n',
    'a/.editorconfig': 'root = true\n[*]\nindent_style = tab\n',
  });
  const props = await resolver.resolve('a/b/c.js');
  assert.deepEqual(props, { indent_style: 'tab' });
  assert.deepEqual(fs.reads.slice(0, 2), ['a/b/.editorconfig', 'a/.editorconfig']);
});

test('E3: ancestor reads start concurrently', async () => {
  const started = [];
  const releases = [];
  const resolver = createEditorconfigResolver({
    rootPath: '',
    readText: (rel) => new Promise((resolve) => { started.push(rel); releases.push(() => resolve(null)); }),
  });
  const pending = resolver.resolve('a/b/c.js');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started, ['a/b/.editorconfig', 'a/.editorconfig', '.editorconfig'], 'all three before any answer');
  releases.forEach((release) => release());
  assert.equal(await pending, null);
});

test('the walk is capped at 16 levels', async () => {
  const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join('/');
  const { fs, resolver } = resolverFor({ '.editorconfig': '[*]\nindent_size = 2\n' });
  assert.equal(await resolver.resolve(`${deep}/f.js`), null);
  assert.equal(fs.reads.length, 16);
  assert.ok(!fs.reads.includes('.editorconfig'));
});

test('absolute, drive and parent-escaping paths resolve to null without reading', async () => {
  const { fs, resolver } = resolverFor({ '.editorconfig': '[*]\nindent_size = 2\n' });
  for (const bad of ['../x.js', 'a/../../x.js', '/etc/x.js', 'C:/x.js', 'C:\\x.js', '', null, undefined]) {
    assert.equal(await resolver.resolve(bad), null, String(bad));
  }
  assert.equal(fs.reads.length, 0);
  assert.equal((await resolver.resolve('a\\.\\b.js')).indent_size, 2, 'backslashes and dot segments normalize');
});

test('parsed configs are cached per directory; invalidate() clears the cache and notifies', async () => {
  let invalidated = 0;
  const { fs, resolver } = resolverFor({ 'src/.editorconfig': '[*]\nindent_size = 2\n' }, { onInvalidate: () => { invalidated += 1; } });
  await resolver.resolve('src/a.js');
  const first = fs.reads.length;
  await resolver.resolve('src/b.js');
  await resolver.resolve('src/c.js');
  assert.equal(fs.reads.length, first, 'siblings reuse the cache');
  fs.files['src/.editorconfig'] = '[*]\nindent_size = 3\n';
  resolver.invalidate();
  assert.equal(invalidated, 1);
  assert.equal((await resolver.resolve('src/a.js')).indent_size, 3);
  assert.ok(fs.reads.length > first);
});

test('concurrent resolves share one read per directory', async () => {
  const { fs, resolver } = resolverFor({ '.editorconfig': '[*]\nindent_size = 2\n' });
  await Promise.all([resolver.resolve('a.js'), resolver.resolve('b.js'), resolver.resolve('c.js')]);
  assert.equal(fs.reads.length, 1);
});

test('indent_size / tab_width mapping', async () => {
  const cases = [
    ['indent_size = tab\ntab_width = 8', { indent_size: 8, tab_width: 8 }],
    ['indent_size = tab', {}],
    ['indent_style = tab\nindent_size = 4', { indent_style: 'tab', indent_size: 4, tab_width: 4 }],
    ['indent_size = 2\ntab_width = 8', { indent_size: 2, tab_width: 8 }],
    ['tab_width = 6', { tab_width: 6 }],
  ];
  for (const [body, expected] of cases) {
    const { resolver } = resolverFor({ '.editorconfig': `[*]\n${body}\n` });
    assert.deepEqual(await resolver.resolve('a.txt'), Object.keys(expected).length ? expected : null, body);
  }
});

test('a failing readText or listDirectory is treated as no config', async () => {
  const resolver = createEditorconfigResolver({ readText: async () => { throw new Error('boom'); }, rootPath: '' });
  assert.equal(await resolver.resolve('a/b.js'), null);
  const listed = [];
  const guarded = createEditorconfigResolver({
    readText: async () => '[*]\nindent_size = 2\n',
    listDirectory: async (dir) => { listed.push(dir); return ['other.txt']; },
    rootPath: '',
  });
  assert.equal(await guarded.resolve('a.js'), null, 'a listing without .editorconfig skips the read');
  assert.deepEqual(listed, ['']);
});

// ---- applier -------------------------------------------------------------

function makeApplier({ files, host, rootKey = null } = {}) {
  const reads = [];
  const listeners = new Set();
  const state = { unsubscribed: 0, rootKey };
  const content = { ...files };
  // Manual timers for the re-apply debounce (E3): runPending() fires every live timer.
  const timers = createFakeTimers();
  const api = {
    readText: async ({ path, intent, maxBytes }) => {
      reads.push({ path, intent, maxBytes });
      return Object.prototype.hasOwnProperty.call(content, path)
        ? { ok: true, content: content[path] }
        : { ok: false, code: 'CMP-WORKSPACEFS-0004' };
    },
    onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); state.unsubscribed += 1; }; },
  };
  const applier = createEditorconfigApplier({
    getWorkspaceFsApi: () => api, editorHost: host, getRootKey: rootKey === null ? null : () => state.rootKey, timers,
  });
  const emit = (changes, extra = {}) => { for (const cb of [...listeners]) cb({ changes, ...extra }); };
  // Lets the invalidation land, fires the debounce, then lets the re-resolve settle.
  const flush = async () => { await settle(); timers.runPending(); await settle(); };
  return { applier, reads, listeners, emit, content, state, timers, flush };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('applier: reads through readText with preview intent and a byte cap, settings shape', async () => {
  const { applier, reads } = makeApplier({
    files: { '.editorconfig': '[*]\nindent_style = tab\nindent_size = 4\nend_of_line = crlf\ntrim_trailing_whitespace = true\ninsert_final_newline = false\n' },
    host: {},
  });
  const settings = await applier.prepare('a.js');
  assert.deepEqual(settings, {
    indent: { source: 'editorconfig', insertSpaces: false, tabSize: 4 },
    endOfLine: 'crlf', trimTrailingWhitespace: true, insertFinalNewline: false,
  });
  assert.deepEqual(reads[0], { path: '.editorconfig', intent: 'preview', maxBytes: 65536 });
  assert.deepEqual(applier.hygieneFor('a.js'), { trimTrailingWhitespace: true, insertFinalNewline: false, endOfLine: 'crlf' });
  assert.equal(applier.hygieneFor('unknown.js'), null);
});

test('applier: indent_style space without a size sets insertSpaces only', async () => {
  const calls = [];
  const { applier } = makeApplier({
    files: { '.editorconfig': '[*]\nindent_style = space\n' },
    host: { setIndent: (path, indent) => calls.push([path, indent]) },
  });
  await applier.prepare('a.js');
  applier.apply('a.js');
  assert.deepEqual(calls, [['a.js', { insertSpaces: true, source: 'editorconfig' }]]);
});

test('applier: apply() uses editorHost.setIndent when present', async () => {
  const calls = [];
  const { applier } = makeApplier({
    files: { '.editorconfig': '[*]\nindent_style = tab\nindent_size = 3\n' },
    host: { setIndent: (path, indent) => calls.push([path, indent]), getModel: () => { throw new Error('unused'); } },
  });
  applier.apply('a.js'); // nothing prepared yet: no-op
  assert.equal(calls.length, 0);
  await applier.prepare('a.js');
  applier.apply('a.js');
  assert.deepEqual(calls, [['a.js', { insertSpaces: false, tabSize: 3, source: 'editorconfig' }]]);
});

test('applier: without setIndent it falls back to model.updateOptions with only the defined keys', async () => {
  const updates = [];
  const model = { updateOptions: (options) => updates.push(options), getLineCount: () => 5 };
  const { applier } = makeApplier({
    files: { '.editorconfig': '[*.js]\nindent_size = 2\n[*.py]\nindent_style = space\n' },
    host: { getModel: () => model },
  });
  await applier.prepare('a.js');
  await applier.prepare('a.py');
  applier.apply('a.js');
  applier.apply('a.py');
  assert.deepEqual(updates, [{ tabSize: 2 }, { insertSpaces: true }]);
  // A host with neither never throws.
  const bare = makeApplier({ files: { '.editorconfig': '[*]\nindent_size = 2\n' }, host: {} });
  await bare.applier.prepare('a.js');
  assert.doesNotThrow(() => bare.applier.apply('a.js'));
});

test('applier: EOL is applied at open only to a document with no line break yet', async () => {
  const eols = new Map([['empty.txt', 'lf'], ['multi.txt', 'lf'], ['same.txt', 'crlf'], ['line.txt', 'lf']]);
  const lineCounts = { 'empty.txt': 1, 'multi.txt': 4, 'same.txt': 1, 'line.txt': 1 };
  const setCalls = [];
  const host = {
    getEol: (p) => eols.get(p),
    setEol: (p, eol) => { setCalls.push([p, eol]); eols.set(p, eol); },
    getModel: (p) => ({ getLineCount: () => lineCounts[p] }),
  };
  const { applier } = makeApplier({ files: { '.editorconfig': '[*]\nend_of_line = crlf\n' }, host });
  for (const p of ['empty.txt', 'multi.txt', 'same.txt']) {
    await applier.prepare(p);
    applier.apply(p);
  }
  assert.deepEqual(setCalls, [['empty.txt', 'crlf']]);
  applier.apply('empty.txt'); // already handled once; does not re-run
  assert.equal(setCalls.length, 1);
  // The save-time path still carries the EOL for the multi-line document.
  assert.equal(applier.hygieneFor('multi.txt').endOfLine, 'crlf');
});

test('applier: textarea fallback judges line breaks from the buffer, never from a missing model', async () => {
  const setCalls = [];
  const values = { 'one.txt': 'abc', 'two.txt': 'a\nb' };
  const host = {
    getEol: () => 'lf', setEol: (p, e) => setCalls.push([p, e]), getValue: (p) => values[p],
  };
  const { applier } = makeApplier({ files: { '.editorconfig': '[*]\nend_of_line = crlf\n' }, host });
  for (const p of ['one.txt', 'two.txt']) { await applier.prepare(p); applier.apply(p); }
  assert.deepEqual(setCalls, [['one.txt', 'crlf']]);
});

test('applier: a change naming .editorconfig invalidates, re-resolves and re-applies indent (not EOL)', async () => {
  const indents = [];
  const eolCalls = [];
  const host = {
    setIndent: (p, i) => indents.push([p, i.tabSize]),
    getEol: () => 'lf', setEol: (p, e) => eolCalls.push([p, e]), getModel: () => ({ getLineCount: () => 1 }),
  };
  const ctx = makeApplier({ files: { '.editorconfig': '[*]\nindent_size = 2\nend_of_line = lf\n' }, host });
  await ctx.applier.prepare('a.js');
  ctx.applier.apply('a.js');
  assert.deepEqual(indents, [['a.js', 2]]);
  const readsBefore = ctx.reads.length;
  ctx.emit([{ relPath: 'src/other.js', kind: 'changed' }]);
  await ctx.flush();
  assert.equal(ctx.reads.length, readsBefore, 'unrelated changes do not invalidate');
  ctx.content['.editorconfig'] = '[*]\nindent_size = 8\nend_of_line = crlf\n';
  ctx.emit([{ relPath: '.editorconfig', kind: 'changed' }]);
  await ctx.flush();
  assert.deepEqual(indents, [['a.js', 2], ['a.js', 8]]);
  assert.equal(eolCalls.length, 0, 'EOL is never re-applied by an invalidation');
  assert.equal(ctx.applier.hygieneFor('a.js').endOfLine, 'crlf');
  // A nested .editorconfig path (backslashes too) re-applies its own subtree.
  await ctx.applier.prepare('pkg/b.js');
  ctx.applier.apply('pkg/b.js');
  ctx.content['pkg/.editorconfig'] = '[*]\nindent_size = 5\n';
  ctx.emit([{ relPath: 'pkg\\.editorconfig', kind: 'created' }]);
  await ctx.flush();
  assert.deepEqual(indents.at(-1), ['pkg/b.js', 5]);
  // A truncated batch flushes everything.
  ctx.content['.editorconfig'] = '[*]\nindent_size = 6\n';
  ctx.emit([], { truncated: true });
  await ctx.flush();
  assert.deepEqual(indents.slice(-2).sort(), [['a.js', 6], ['pkg/b.js', 5]]);
});

test('E3: an edit invalidates only its subtree', async () => {
  const indents = [];
  const ctx = makeApplier({
    files: { '.editorconfig': '[*]\nindent_size = 2\n', 'pkg/.editorconfig': '[*]\nindent_size = 4\n' },
    host: { setIndent: (p, i) => indents.push([p, i.tabSize]) },
  });
  for (const p of ['a.js', 'pkg/b.js', 'pkg/deep/c.js', 'other/d.js']) {
    await ctx.applier.prepare(p);
    ctx.applier.apply(p);
  }
  indents.length = 0;
  const readsBefore = ctx.reads.length;
  ctx.content['pkg/.editorconfig'] = '[*]\nindent_size = 6\n';
  ctx.emit([{ relPath: 'pkg/.editorconfig', kind: 'changed' }]);
  await ctx.flush();
  assert.deepEqual(ctx.reads.slice(readsBefore).map((r) => r.path), ['pkg/.editorconfig'], 'only the edited file is read again');
  assert.deepEqual(indents.sort(), [['pkg/b.js', 6], ['pkg/deep/c.js', 6]], 'files outside pkg/ are not touched');
});

test('E3: three edits in 100 ms re-apply once', async () => {
  const indents = [];
  const ctx = makeApplier({ files: { '.editorconfig': '[*]\nindent_size = 2\n' }, host: { setIndent: (p, i) => indents.push([p, i.tabSize]) } });
  await ctx.applier.prepare('a.js');
  ctx.applier.apply('a.js');
  for (const size of [3, 4, 5]) {
    ctx.content['.editorconfig'] = `[*]\nindent_size = ${size}\n`;
    ctx.emit([{ relPath: '.editorconfig', kind: 'changed' }]);
  }
  await settle();
  assert.equal(ctx.timers.pending(), 1, 'one pending re-apply');
  assert.deepEqual(ctx.timers.delays(), [200]);
  assert.deepEqual(indents, [['a.js', 2]], 'nothing re-applied before the debounce');
  await ctx.flush();
  assert.deepEqual(indents, [['a.js', 2], ['a.js', 5]]);
});

test('E2: removing the section restores the user default indent', async () => {
  const docIndent = { insertSpaces: true, tabSize: 4, source: 'default' };
  const indents = [];
  const host = {
    getIndentInfo: () => ({ ...docIndent }),
    setIndent: (p, indent) => { indents.push([p, indent]); Object.assign(docIndent, { source: 'file' }, indent); },
  };
  const ctx = makeApplier({ files: { '.editorconfig': '[*.js]\nindent_style = tab\nindent_size = 2\n' }, host });
  await ctx.applier.prepare('a.js');
  ctx.applier.apply('a.js');
  assert.deepEqual(indents.at(-1), ['a.js', { source: 'editorconfig', insertSpaces: false, tabSize: 2 }]);
  ctx.content['.editorconfig'] = '[*.py]\nindent_size = 8\n';
  ctx.emit([{ relPath: '.editorconfig', kind: 'changed' }]);
  await ctx.flush();
  assert.deepEqual(indents.at(-1), ['a.js', { insertSpaces: true, tabSize: 4, source: 'default' }]);
  // Putting the section back applies it again.
  ctx.content['.editorconfig'] = '[*.js]\nindent_size = 3\n';
  ctx.emit([{ relPath: '.editorconfig', kind: 'changed' }]);
  await ctx.flush();
  assert.deepEqual(indents.at(-1), ['a.js', { source: 'editorconfig', tabSize: 3 }]);
});

test('E2: a status-bar pick outranks the restore', async () => {
  const docIndent = { insertSpaces: true, tabSize: 4, source: 'default' };
  const indents = [];
  const host = {
    getIndentInfo: () => ({ ...docIndent }),
    setIndent: (p, indent) => { indents.push([p, indent]); Object.assign(docIndent, { source: 'file' }, indent); },
  };
  const ctx = makeApplier({ files: { '.editorconfig': '[*]\nindent_size = 2\n' }, host });
  await ctx.applier.prepare('a.js');
  ctx.applier.apply('a.js');
  Object.assign(docIndent, { insertSpaces: false, tabSize: 8, source: 'file' }); // the user's pick
  const before = indents.length;
  ctx.content['.editorconfig'] = '';
  ctx.emit([{ relPath: '.editorconfig', kind: 'changed' }]);
  await ctx.flush();
  assert.equal(indents.length, before, 'the pick stays');
});

test('applier: forgotten paths are not re-applied and forget() clears hygiene', async () => {
  const indents = [];
  const ctx = makeApplier({
    files: { '.editorconfig': '[*]\nindent_size = 2\ninsert_final_newline = true\n' },
    host: { setIndent: (p) => indents.push(p) },
  });
  await ctx.applier.prepare('a.js');
  await ctx.applier.prepare('b.js');
  ctx.applier.forget('a.js');
  assert.equal(ctx.applier.hygieneFor('a.js'), null);
  ctx.emit([{ relPath: '.editorconfig', kind: 'changed' }]);
  await ctx.flush();
  assert.deepEqual(indents, ['b.js']);
});

test('applier: reset() bumps the epoch - an in-flight prepare resolves null and stores nothing', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const listeners = new Set();
  let unsubscribed = 0;
  const api = {
    readText: async () => { await gate; return { ok: true, content: '[*]\nindent_size = 2\n' }; },
    onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); unsubscribed += 1; }; },
  };
  const applier = createEditorconfigApplier({ getWorkspaceFsApi: () => api, editorHost: {} });
  const pending = applier.prepare('a.js');
  await settle();
  assert.equal(listeners.size, 1, 'subscribed once, lazily');
  applier.reset();
  assert.equal(unsubscribed, 1);
  assert.equal(listeners.size, 0);
  release();
  assert.equal(await pending, null);
  assert.equal(applier.hygieneFor('a.js'), null);
  // After a reset the applier rebuilds its resolver and subscription on demand.
  assert.deepEqual((await applier.prepare('b.js')).indent, { source: 'editorconfig', tabSize: 2 });
  assert.equal(listeners.size, 1);
});

test('applier: a changed root key resets automatically; a missing bridge yields null', async () => {
  const ctx = makeApplier({ files: { '.editorconfig': '[*]\nindent_size = 2\n' }, host: {}, rootKey: 'root-a' });
  await ctx.applier.prepare('a.js');
  assert.ok(ctx.applier.hygieneFor('a.js') === null && ctx.reads.length === 1);
  ctx.state.rootKey = 'root-b';
  await ctx.applier.prepare('a.js');
  assert.equal(ctx.reads.length, 2, 'new root rebuilt the resolver (cache dropped)');
  const none = createEditorconfigApplier({ getWorkspaceFsApi: () => null, editorHost: {} });
  assert.equal(await none.prepare('a.js'), null);
  assert.doesNotThrow(() => none.apply('a.js'));
  none.dispose();
  assert.equal(await none.prepare('a.js'), null);
});

test('applier: never writes a preference and tolerates an editor host that throws', async () => {
  const attempts = [];
  const ctx = makeApplier({
    files: { '.editorconfig': '[*]\nindent_size = 2\ntrim_trailing_whitespace = true\n' },
    host: { setIndent: (path, indent) => { attempts.push([path, indent]); throw new Error('editor gone'); } },
  });
  await ctx.applier.prepare('a.js');
  assert.equal(ctx.applier.apply('a.js'), undefined, 'a throwing host is swallowed');
  assert.deepEqual(attempts, [['a.js', { source: 'editorconfig', tabSize: 2 }]]);
  // The failed apply leaves the per-file settings intact for the save path.
  assert.deepEqual(ctx.applier.hygieneFor('a.js'), { trimTrailingWhitespace: true });
});
