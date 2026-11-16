'use strict';

// new-test-file: slice 3-12's path matcher for "Always allowed" rules (server/team/project-rules-match.js), a new
// surface with no test file of its own.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RULE_TOOL_NAMES, folderCovers, isRuleTool, ruleTarget, targetSegments, validateFolder,
} = require('../../server/team/project-rules-match');

const POSIX_ROOT = '/srv/team/projects/project_a';
const WIN_ROOT = 'C:\\team\\projects\\project_a';
const posix = (value) => targetSegments(value, { root: POSIX_ROOT, platform: 'linux' });
const win = (value) => targetSegments(value, { root: WIN_ROOT, platform: 'win32' });

test('only edit_file and write_file can be ruled; the closed list cannot be changed', () => {
  assert.deepEqual([...RULE_TOOL_NAMES].sort(), ['edit_file', 'write_file']);
  assert.equal(Object.isFrozen(RULE_TOOL_NAMES), true);
  assert.throws(() => { 'use strict'; RULE_TOOL_NAMES.push('run_command'); }, TypeError);
  assert.equal(isRuleTool('run_command'), false);
  assert.equal(isRuleTool('edit_file') && isRuleTool('write_file'), true);
  assert.equal(Object.values(require('../../server/team/project-rules-match')).some((value) => value instanceof Set), false);
  for (const tool of ['create_artifact', 'run_command', 'read_file', 'propose_change', '']) {
    assert.equal(ruleTarget(tool, { path: 'a.md' }, { root: POSIX_ROOT, platform: 'linux' }), null, tool);
  }
});

test('a relative or root-anchored path becomes whole project-relative segments', () => {
  assert.deepEqual(posix('posts/a.md'), ['posts', 'a.md']);
  assert.deepEqual(posix('./posts/./a.md'), ['posts', 'a.md']);
  assert.deepEqual(posix(`${POSIX_ROOT}/posts/a.md`), ['posts', 'a.md']);
  assert.deepEqual(win('posts\\a.md'), ['posts', 'a.md']);
  assert.deepEqual(win('C:/team/projects/project_a/posts/a.md'), ['posts', 'a.md']);
  assert.deepEqual(win(`${WIN_ROOT}\\posts\\a.md`), ['posts', 'a.md']);
});

test('every form that cannot be compared safely is no target (a person is asked)', () => {
  const refused = ['', ' posts/a.md', 'posts/a.md ', '../a.md', 'posts/../../a.md', 'posts//a.md', '/etc/passwd',
    '/srv/team/projects/project_b/a.md', '/srv/team/projects/project_a', '~/a.md', '~', 'posts/a\u0000.md',
    '/posts/a.md', 'posts\\a.md', 'C:/x/a.md', '.', 'posts/', 'posts/con.txt', 'posts/a.md.', 'posts/a:b'];
  for (const value of refused) assert.equal(posix(value), null, JSON.stringify(value));
  for (const value of ['C:foo\\a.md', '\\\\server\\share\\a.md', 'D:\\team\\projects\\project_a\\a.md',
    'c:\\team\\projects\\project_a\\a.md', '\\a.md', 'posts\\..\\..\\a.md']) {
    assert.equal(win(value), null, JSON.stringify(value));
  }
  // An absolute path with no known root is no target; a relative one needs none.
  assert.equal(targetSegments(`${POSIX_ROOT}/a.md`, { root: null, platform: 'linux' }), null);
  assert.deepEqual(targetSegments('a.md', { root: null, platform: 'linux' }), ['a.md']);
  assert.equal(posix(42), null);
  assert.equal(posix('a'.repeat(5000)), null);
});

test('the tool input: path or file_path, both only when equal, never anything else', () => {
  const opts = { root: POSIX_ROOT, platform: 'linux' };
  assert.deepEqual(ruleTarget('write_file', { path: 'a.md', content: 'x' }, opts), ['a.md']);
  assert.deepEqual(ruleTarget('write_file', { file_path: 'a.md' }, opts), ['a.md']);
  assert.deepEqual(ruleTarget('edit_file', { file_path: 'a.md', old_string: 'a', new_string: 'b' }, opts), ['a.md']);
  assert.deepEqual(ruleTarget('write_file', { path: 'a.md', file_path: 'a.md' }, opts), ['a.md']);
  assert.equal(ruleTarget('write_file', { path: 'a.md', file_path: 'b.md' }, opts), null);
  assert.equal(ruleTarget('write_file', {}, opts), null);
  assert.equal(ruleTarget('write_file', null, opts), null);
  assert.equal(ruleTarget('write_file', ['a.md'], opts), null);
  assert.equal(ruleTarget('write_file', { path: ['a.md'] }, opts), null);
});

test('a folder covers whole segments below it only, compared exactly (case and Unicode form)', () => {
  assert.equal(folderCovers(null, ['a.md']), true);
  assert.equal(folderCovers('posts', ['posts', 'a.md']), true);
  assert.equal(folderCovers('posts', ['posts', 'x', 'a.md']), true);
  assert.equal(folderCovers('posts/x', ['posts', 'x', 'a.md']), true);
  assert.equal(folderCovers('posts', ['posts-old', 'a.md']), false);
  assert.equal(folderCovers('posts', ['postsx', 'a.md']), false);
  assert.equal(folderCovers('posts', ['posts']), false);
  assert.equal(folderCovers('posts/x', ['posts', 'a.md']), false);
  assert.equal(folderCovers('posts', ['Posts', 'a.md']), false);
  assert.equal(folderCovers('caf\u00e9', ['cafe\u0301', 'a.md']), false);
  assert.equal(folderCovers('caf\u00e9', ['caf\u00e9', 'a.md']), true);
});

test('the folder field: the segment rules, 8 segments and 255 characters, no absolute or parent path', () => {
  assert.deepEqual(validateFolder(null), { ok: true, folder: null });
  assert.deepEqual(validateFolder('posts/2026'), { ok: true, folder: 'posts/2026' });
  assert.equal(validateFolder(Array(8).fill('a').join('/')).ok, true);
  assert.equal(validateFolder('a'.repeat(255)).ok, true);
  const refused = ['', '..', 'posts/..', '/posts', 'C:/posts', 'C:posts', 'posts\\old', 'con', 'posts/aux.txt',
    'posts.', 'posts ', Array(9).fill('a').join('/'), 'a'.repeat(256), 'po\u0007sts', '<b>posts</b>', 'posts/',
    './posts', 'posts//x', 42, undefined];
  for (const value of refused) {
    const answer = validateFolder(value);
    assert.equal(answer.ok, false, JSON.stringify(value));
    assert.equal(answer.reason, 'team_rule_folder_invalid');
  }
});

test('hidden folders (owner, 2026-11-13): any dot-leading segment is no target under any rule, and no rule folder', () => {
  for (const value of ['.git/hooks/pre-commit', 'src/.env', '.github/workflows/x.yml', '.vscode/settings.json', '.jenny/x',
    '.env', 'posts/.draft.md', `${POSIX_ROOT}/.git/config`, './.git/config']) {
    assert.equal(posix(value), null, value);
    assert.equal(ruleTarget('write_file', { path: value, content: 'x' }, { root: POSIX_ROOT, platform: 'linux' }), null, value);
  }
  assert.equal(win('.github\\workflows\\x.yml'), null);
  // A dot inside a name is not hidden.
  assert.deepEqual(posix('posts/a.b.md'), ['posts', 'a.b.md']);
  for (const folder of ['.git', '.github/workflows', 'src/.env', 'posts/.hidden', '.x']) {
    assert.deepEqual(validateFolder(folder), { ok: false, reason: 'team_rule_folder_invalid' }, folder);
  }
  assert.equal(validateFolder('posts.d/x').ok, true);
});

test('characters the sidecar may read differently are refused anywhere in the path', () => {
  const classes = {
    c1: ['\u0080', '\u0085', '\u009f'],
    separators: ['\u2028', '\u2029'],
    bidi: ['\u202a', '\u202e', '\u2066', '\u2069'],
    zeroWidth: ['\u200b', '\u200c', '\u200d', '\ufeff'],
    surrogate: ['\ud800', '\udfff'],
    control: ['\u0001', '\u001c', '\u001f', '\u007f'],
  };
  for (const [name, characters] of Object.entries(classes)) {
    for (const ch of characters) {
      for (const value of [`${ch}posts/a.md`, `posts/a.md${ch}`, `posts/a${ch}.md`, `po${ch}sts/a.md`]) {
        assert.equal(posix(value), null, `${name} ${JSON.stringify(value)}`);
      }
      assert.equal(validateFolder(`po${ch}sts`).ok, false, `${name} folder`);
    }
  }
  // An ordinary non-ASCII name, and a no-break space inside a name (both sides keep it), still compare.
  assert.deepEqual(posix('caf\u00e9/a\u00a0b.md'), ['caf\u00e9', 'a\u00a0b.md']);
  // Surrounding Unicode space is surrounding space.
  for (const value of ['\u00a0posts/a.md', 'posts/a.md\u3000', '\u2003a.md']) assert.equal(posix(value), null, JSON.stringify(value));
});

test('path forms: parents after the root, doubled or trailing slashes, device and long names, \\\\?\\ prefixes', () => {
  for (const value of [`${POSIX_ROOT}/../other/a.md`, `${POSIX_ROOT}//posts/a.md`, '/srv//team/projects/project_a/a.md',
    `${POSIX_ROOT}/`, `${POSIX_ROOT}/posts/`, `posts/${'x'.repeat(256)}`, `posts/${'\u00e9'.repeat(128)}`, 'nul', 'posts/nul.txt',
    'com1', 'posts/COM1.log', 'lpt1.txt', 'posts/con .txt', 'posts/a\tb.md', 'posts/a\nb.md']) {
    assert.equal(posix(value), null, JSON.stringify(value));
  }
  assert.deepEqual(posix(`posts/${'x'.repeat(255)}`), ['posts', 'x'.repeat(255)]);
  for (const value of ['\\\\?\\C:\\team\\projects\\project_a\\a.md', '//?/C:/team/projects/project_a/a.md',
    '\\\\.\\C:\\team\\projects\\project_a\\a.md', 'C:\\team\\projects\\project_a\\..\\other\\a.md',
    'C:\\team\\projects\\project_a\\\\a.md']) {
    assert.equal(win(value), null, JSON.stringify(value));
  }
  // A root given with a trailing separator is the same root.
  assert.deepEqual(targetSegments(`${POSIX_ROOT}/posts/a.md`, { root: `${POSIX_ROOT}/`, platform: 'linux' }), ['posts', 'a.md']);
  assert.deepEqual(targetSegments(`${WIN_ROOT}\\posts\\a.md`, { root: `${WIN_ROOT}\\`, platform: 'win32' }), ['posts', 'a.md']);
});
