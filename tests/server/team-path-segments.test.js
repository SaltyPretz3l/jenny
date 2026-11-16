'use strict';

// Slice 3-8a, T1: the Node form of the "Segment names" table
// (docs/plans/TEAM_WINDOWS_FILE_ACCESS_SPEC.md), applied on every platform,
// plus the relative-path bounds of TEAM_PROJECTS_SPEC "Upload and download".

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PATH_LIMITS, SEGMENT_REASONS, SENSITIVE_NAMES, isSensitiveSegment, sensitiveSegment, validateRelativePath, validateSegment,
} = require('../../server/team/path-segments');

function refused(result, reason) {
  assert.equal(result.ok, false);
  assert.equal(result.reason, reason);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason']);
  assert.ok(SEGMENT_REASONS.includes(result.reason), `closed reason: ${result.reason}`);
}

// One case per row of the table, each row with every listed member.
const SEGMENT_ROWS = [
  { row: 'empty', names: [''], reason: 'segment_empty' },
  { row: 'dot and dot-dot', names: ['.', '..'], reason: 'segment_dot' },
  { row: 'separators', names: ['a\\b', 'a/b', 'a:b', 'file.txt:stream'], reason: 'segment_separator' },
  { row: 'Win32-invalid characters', names: ['a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b'], reason: 'segment_character' },
  {
    row: 'control characters, DEL, lone surrogates',
    names: ['a\u0000b', 'a\u0001b', 'tab\there', 'a\u001fb', 'a\u007fb', 'a\ud800b', 'a\udc00b', '\ud83d'],
    reason: 'segment_control',
  },
  { row: 'trailing dot or space', names: ['name.', 'name ', 'name. ', 'name...'], reason: 'segment_trailing' },
  {
    row: 'reserved device names, case folded, with or without an extension',
    names: ['CON', 'con', 'Prn', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9', 'con.txt', 'NUL.tar.gz', 'aux.c',
      'COM\u00b9', 'com\u00b2', 'COM\u00b3.log', 'LPT\u00b9', 'lpt\u00b2', 'LPT\u00b3', 'CONIN$', 'conout$', 'CONIN$.txt',
      'con .txt', 'NUL  .tar', 'com1 .c',
      // Slice 3-8b: COM0 and LPT0, as the Windows file access spec's table and vectors have them.
      'COM0', 'lpt0', 'com0.txt', 'LPT0 .log'],
    reason: 'segment_reserved',
  },
  { row: 'longer than 255 UTF-16 code units', names: ['a'.repeat(256), '\u00e9'.repeat(256)], reason: 'segment_too_long' },
];

for (const { row, names, reason } of SEGMENT_ROWS) {
  test(`validateSegment refuses: ${row}`, () => {
    for (const name of names) refused(validateSegment(name), reason);
  });
}

test('validateSegment refuses a segment over 255 bytes of UTF-8 on every host, at its edge', () => {
  // 86 CJK characters are 258 bytes: under the code-unit bound, over a Linux NAME_MAX.
  refused(validateSegment('字'.repeat(86)), 'segment_too_long');
  refused(validateSegment(`${'a'.repeat(254)}é`), 'segment_too_long');
  refused(validateSegment('😀'.repeat(64)), 'segment_too_long');
  refused(validateRelativePath(`src/${'字'.repeat(86)}`), 'segment_too_long');
  for (const name of ['字'.repeat(85), 'a'.repeat(255), `${'a'.repeat(253)}é`, '😀'.repeat(63)]) {
    assert.deepEqual(validateSegment(name), { ok: true }, `${Buffer.byteLength(name)} bytes`);
  }
});

test('validateSegment refuses a value that is not a string', () => {
  for (const value of [undefined, null, 7, {}, ['a'], Buffer.from('a')]) refused(validateSegment(value), 'segment_not_string');
});

test('validateSegment accepts ordinary names, case variants and near-misses of reserved names', () => {
  const accepted = [
    'README.md', 'readme.MD', 'a', 'a'.repeat(255), '.gitignore', '.env.local', 'src', 'con2', 'COM10',
    'lpt', 'console.log', 'nul-file', 'auxiliary', 'caf\u00e9', 'caf\u0065\u0301', '\ud83d\ude00.png', 'a b', '-x',
  ];
  for (const name of accepted) assert.deepEqual(validateSegment(name), { ok: true }, JSON.stringify(name));
});

test('validateSegment never echoes the name', () => {
  const secret = 'top-secret-name\u0000';
  const result = validateSegment(secret);
  assert.equal(JSON.stringify(result).includes('top-secret'), false);
});

// ------------------------------------------------------------------ paths

test('validateRelativePath accepts relative slash-separated paths within the bounds', () => {
  const accepted = [
    'a', 'src/index.js', 'docs/a b/c.md', Array.from({ length: PATH_LIMITS.MAX_SEGMENTS }, () => 'd').join('/'),
    `${'a'.repeat(254)}/${'b'.repeat(255)}/c`,
  ];
  assert.equal(Buffer.byteLength(accepted.at(-1)), PATH_LIMITS.MAX_BYTES);
  for (const value of accepted) assert.deepEqual(validateRelativePath(value), { ok: true });
});

test('validateRelativePath refuses traversal in any position', () => {
  for (const value of ['..', '../a', 'a/../b', 'a/..', '.', './a', 'a/./b']) refused(validateRelativePath(value), 'segment_dot');
});

test('validateRelativePath refuses absolute paths', () => {
  for (const value of ['/a', '/', '//server/share/a', '/etc/passwd']) refused(validateRelativePath(value), 'path_absolute');
});

test('validateRelativePath refuses drive letters', () => {
  for (const value of ['C:', 'C:/a', 'c:a', 'z:/windows/system32']) refused(validateRelativePath(value), 'path_drive');
});

test('validateRelativePath refuses backslashes', () => {
  for (const value of ['a\\b', '\\a', '..\\a', 'C\\a', '\\\\server\\share']) {
    refused(validateRelativePath(value), 'segment_separator');
  }
});

test('validateRelativePath refuses empty segments', () => {
  for (const value of ['', 'a//b', 'a/', 'a/b/']) refused(validateRelativePath(value), 'segment_empty');
});

test('validateRelativePath refuses 17 segments', () => {
  const value = Array.from({ length: PATH_LIMITS.MAX_SEGMENTS + 1 }, () => 'd').join('/');
  refused(validateRelativePath(value), 'path_too_deep');
});

test('validateRelativePath refuses 513 bytes of UTF-8, counted in bytes not characters', () => {
  refused(validateRelativePath('x'.repeat(PATH_LIMITS.MAX_BYTES + 1)), 'path_too_long');
  // A three-byte character: 171 * 3 = 513 bytes in 171 characters.
  refused(validateRelativePath('\u20ac'.repeat(171)), 'path_too_long');
  // Two segments of 255 bytes each (a segment is bounded at 255 bytes): 511 bytes.
  assert.deepEqual(validateRelativePath(`${'\u20ac'.repeat(85)}/${'\u20ac'.repeat(85)}`), { ok: true });
  // Exactly 512 bytes needs three segments: 255 + 1 + 252 + 1 + 3.
  const edge = `${'\u20ac'.repeat(85)}/${'\u20ac'.repeat(84)}/abc`;
  assert.equal(Buffer.byteLength(edge), PATH_LIMITS.MAX_BYTES);
  assert.deepEqual(validateRelativePath(edge), { ok: true });
});

test('validateRelativePath applies every segment rule to every segment', () => {
  refused(validateRelativePath('src/CON/a.txt'), 'segment_reserved');
  refused(validateRelativePath('src/a.txt.'), 'segment_trailing');
  refused(validateRelativePath('src/a\u0000/b'), 'segment_control');
  refused(validateRelativePath('src/a*b'), 'segment_character');
  refused(validateRelativePath('src/a:b'), 'segment_separator');
  refused(validateRelativePath(42), 'path_not_string');
});

test('E69: a segment longer than any listed name can fold to is not sensitive and is never folded', () => {
  const { isSensitiveSegment, sensitiveSegment } = require('../../server/team/path-segments');
  const long = '.git' + 'x'.repeat(1024 * 1024);
  const started = process.hrtime.bigint();
  assert.equal(isSensitiveSegment(long), false);
  assert.equal(sensitiveSegment(`${long}/a.txt`), null);
  assert.ok(Number(process.hrtime.bigint() - started) < 50e6, 'no fold over a megabyte name');
  assert.equal(isSensitiveSegment('.git'.padEnd(32, ' ')), false);
});

test('E69: the sensitive names are the approval rules\' five, compared case folded on every platform', () => {
  assert.deepEqual([...SENSITIVE_NAMES], ['.git', '.github', '.vscode', '.env', '.jenny']);
  assert.ok(Object.isFrozen(SENSITIVE_NAMES));
  for (const name of ['.git', '.GIT', '.Git', '.GitHub', '.VSCODE', '.Env', '.JENNY', '.g\u0131t', '\uff0egit']) {
    assert.equal(isSensitiveSegment(name), true, name);
  }
  for (const name of ['.gitignore', '.editorconfig', '.envrc', '.env.local', 'git', '.gitx', '.', '..', '', 7, null]) {
    assert.equal(isSensitiveSegment(name), false, String(name));
  }
  // The first listed segment of a relative path, as spelled, or null.
  assert.equal(sensitiveSegment('.git/config'), '.git');
  assert.equal(sensitiveSegment('src/.VSCode/tasks.json'), '.VSCode');
  assert.equal(sensitiveSegment('a/b/.env'), '.env');
  assert.equal(sensitiveSegment('.gitignore'), null);
  assert.equal(sensitiveSegment('src/.editorconfig'), null);
  assert.equal(sensitiveSegment(7), null);
});
