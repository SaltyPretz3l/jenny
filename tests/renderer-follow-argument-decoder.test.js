'use strict';

// The Follow Jenny argument reader: a streaming JSON reader that hands back the
// file path, the file content and the edits of a write_file / edit_file call
// while the model is still writing the argument text.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFollowArgumentDecoder } = require('../renderer/chat/renderer-follow-argument-decoder');

const NO_EDITS = [];

function expectedFields(partial) {
  return {
    path: '',
    pathDone: false,
    content: '',
    contentStarted: false,
    contentDone: false,
    edits: NO_EDITS,
    done: true,
    failed: false,
    overflow: false,
    ...partial,
  };
}

function edit(partial) {
  return { oldText: '', oldDone: false, newText: '', newStarted: false, newDone: false, replaceAll: false, ...partial };
}

function doneEdit(oldText, newText, replaceAll = false) {
  return edit({ oldText, oldDone: true, newText, newStarted: true, newDone: true, replaceAll });
}

const ALL_ESCAPES = 'q"b\\s/f\b\f\nn\rt\t crlf\r\nx é raw 😀 end   \u0001 \u007f';
const LONE_HIGH = 'a\uD83Dx';
const LONG_CONTENT = 'line of text \\ "quoted" é 😀\n'.repeat(1000).slice(0, 20000);

// Each fixture: a name, the argument object to serialize, and the expected snapshot fields.
const FIXTURES = [
  {
    name: 'write_file path then content',
    value: { path: 'src/app.js', content: 'const a = 1;\n' },
    expected: expectedFields({ path: 'src/app.js', pathDone: true, content: 'const a = 1;\n', contentStarted: true, contentDone: true }),
  },
  {
    name: 'write_file content then path',
    value: { content: 'hello', path: 'a.txt' },
    expected: expectedFields({ path: 'a.txt', pathDone: true, content: 'hello', contentStarted: true, contentDone: true }),
  },
  {
    name: 'write_file aliases file_path and file_content',
    value: { file_path: 'b/c.md', file_content: '# title' },
    expected: expectedFields({ path: 'b/c.md', pathDone: true, content: '# title', contentStarted: true, contentDone: true }),
  },
  {
    name: 'edit_file top level old_string new_string replace_all true',
    value: { file_path: 'x.js', old_string: 'foo', new_string: 'bar', replace_all: true },
    expected: expectedFields({ path: 'x.js', pathDone: true, edits: [doneEdit('foo', 'bar', true)] }),
  },
  {
    name: 'edit_file top level replace_all false and null',
    value: { file_path: 'x.js', replace_all: false, old_string: 'a', new_string: 'b' },
    expected: expectedFields({ path: 'x.js', pathDone: true, edits: [doneEdit('a', 'b', false)] }),
  },
  {
    name: 'edit_file batch of three',
    value: {
      file_path: 'multi.js',
      edits: [
        { old_string: 'one', new_string: '1' },
        { old_string: 'two', new_string: '2', replace_all: true },
        { new_string: '3\n', old_string: 'three "quoted"' },
      ],
    },
    expected: expectedFields({
      path: 'multi.js',
      pathDone: true,
      edits: [doneEdit('one', '1'), doneEdit('two', '2', true), doneEdit('three "quoted"', '3\n')],
    }),
  },
  {
    name: 'top level entry comes before the edits batch',
    value: { edits: [{ old_string: 'b', new_string: 'B' }], file_path: 'm.js', old_string: 'a', new_string: 'A' },
    expected: expectedFields({ path: 'm.js', pathDone: true, edits: [doneEdit('a', 'A'), doneEdit('b', 'B')] }),
  },
  {
    name: 'unknown keys of every type around the captured keys',
    value: {
      note: 'before "x" {',
      count: -12.5e3,
      flag: true,
      other: false,
      nothing: null,
      list: [1, 'two', [3, { content: 'inner list content' }], null],
      path: 'p.txt',
      meta: { content: 'nested content must not count', path: 'nested path', deep: { file_path: 'x', arr: [{ old_string: 'z' }] } },
      mid: 'a string with "}],' + ' text and \\ backslash',
      content: 'real content',
      tail: { a: { b: { c: [] } } },
      empty: {},
      emptyList: [],
    },
    expected: expectedFields({ path: 'p.txt', pathDone: true, content: 'real content', contentStarted: true, contentDone: true }),
  },
  {
    name: 'unknown keys inside edit objects and a nested edits key',
    value: {
      file_path: 'e.js',
      edits: [
        { id: 7, old_string: 'a', extra: { old_string: 'no' }, new_string: 'b', tags: ['x', 'y'], replace_all: false },
        { old_string: 'c', new_string: 'd', content: 'ignored' },
      ],
      misc: { edits: [{ old_string: 'nope', new_string: 'nope' }] },
    },
    expected: expectedFields({ path: 'e.js', pathDone: true, edits: [doneEdit('a', 'b'), doneEdit('c', 'd')] }),
  },
  {
    name: 'empty strings',
    value: { path: '', content: '' },
    expected: expectedFields({ path: '', pathDone: true, content: '', contentStarted: true, contentDone: true }),
  },
  {
    name: 'empty edit strings',
    value: { file_path: 'f', old_string: '', new_string: '' },
    expected: expectedFields({ path: 'f', pathDone: true, edits: [doneEdit('', '')] }),
  },
  {
    name: 'every escape',
    value: { path: 'esc.txt', content: ALL_ESCAPES },
    expected: expectedFields({ path: 'esc.txt', pathDone: true, content: ALL_ESCAPES, contentStarted: true, contentDone: true }),
  },
  {
    name: 'lone high surrogate followed by x',
    value: { path: 'lone', content: LONE_HIGH },
    expected: expectedFields({ path: 'lone', pathDone: true, content: LONE_HIGH, contentStarted: true, contentDone: true }),
  },
  {
    name: 'a content of 20000 characters',
    value: { path: 'big.txt', content: LONG_CONTENT },
    expected: expectedFields({ path: 'big.txt', pathDone: true, content: LONG_CONTENT, contentStarted: true, contentDone: true }),
  },
];

// Argument text that JSON.stringify never writes: escapes spelled out by hand.
const HAND_WRITTEN = [
  {
    name: 'raw emoji, escaped pair, escaped e-acute, solidus, form feed',
    text: '{"path":"h","content":"😀|\\uD83D\\uDE00|\\u00e9|\\/|\\b\\f\\n\\t\\r\\\\|\\""}',
    expected: expectedFields({ path: 'h', pathDone: true, content: '😀|😀|é|/|\b\f\n\t\r\\|"', contentStarted: true, contentDone: true }),
  },
  {
    name: 'lone escaped high surrogate then x, lowercase and uppercase hex',
    text: '{ "content" : "\\ud83dx\\uD83DX" , "path":"l" }',
    expected: expectedFields({ path: 'l', pathDone: true, content: '\uD83Dx\uD83DX', contentStarted: true, contentDone: true }),
  },
  {
    name: 'raw control characters inside a string pass through',
    text: '{"content":"a\nb\tc\r\nd","path":"raw"}',
    expected: expectedFields({ path: 'raw', pathDone: true, content: 'a\nb\tc\r\nd', contentStarted: true, contentDone: true }),
  },
  {
    name: 'escaped key names',
    text: '{"p\\u0061th":"k","con\\u0074ent":"v"}',
    expected: expectedFields({ path: 'k', pathDone: true, content: 'v', contentStarted: true, contentDone: true }),
  },
  {
    name: 'a repeated key: the later value replaces the earlier one',
    repeats: true,
    text: '{"path":"first","content":"one","path":"second","content":"two"}',
    expected: expectedFields({ path: 'second', pathDone: true, content: 'two', contentStarted: true, contentDone: true }),
  },
  {
    name: 'captured keys with values that are not strings',
    text: '{"path":null,"content":7,"old_string":{"a":[1]},"new_string":[true],"replace_all":"true"}',
    expected: expectedFields({
      path: '',
      pathDone: true,
      content: '',
      contentDone: true,
      edits: [edit({ oldDone: true, newDone: true, replaceAll: false })],
    }),
  },
  {
    name: 'edits that is not an array is skipped',
    text: '{"file_path":"n","edits":"nope","content":"c"}',
    expected: expectedFields({ path: 'n', pathDone: true, content: 'c', contentStarted: true, contentDone: true }),
  },
  {
    name: 'numbers and literals at the end of an object',
    text: '{"a":-0.5E+10,"b":0,"c":12345678901234567890,"path":"z","d":null,"e":true,"f":false}',
    expected: expectedFields({ path: 'z', pathDone: true }),
  },
];

function serializations(value) {
  return [JSON.stringify(value), JSON.stringify(value, null, 2)];
}

function allTexts() {
  const texts = [];
  for (const fixture of FIXTURES) {
    serializations(fixture.value).forEach((text, index) => {
      texts.push({ name: `${fixture.name} (${index === 0 ? 'compact' : 'indented'})`, text, expected: fixture.expected, value: fixture.value });
    });
  }
  for (const entry of HAND_WRITTEN) texts.push({ name: entry.name, text: entry.text, expected: entry.expected, repeats: entry.repeats });
  return texts;
}

function readAll(chunks, options) {
  const decoder = createFollowArgumentDecoder(options);
  for (const chunk of chunks) decoder.push(chunk);
  return decoder.snapshot();
}

test('the fixtures themselves round trip through JSON.parse', () => {
  for (const entry of allTexts()) {
    if (entry.value) assert.deepEqual(JSON.parse(entry.text), entry.value, entry.name);
  }
});

test('a fresh decoder starts empty and snapshots are new objects', () => {
  const decoder = createFollowArgumentDecoder();
  const first = decoder.snapshot();
  assert.deepEqual(first, {
    path: '',
    pathDone: false,
    content: '',
    contentStarted: false,
    contentDone: false,
    edits: [],
    done: false,
    failed: false,
    overflow: false,
  });
  assert.notEqual(decoder.snapshot(), first);
  assert.notEqual(decoder.snapshot().edits, first.edits);
});

test('the whole text in one push gives the expected fields', () => {
  for (const entry of allTexts()) {
    assert.deepEqual(readAll([entry.text]), entry.expected, entry.name);
  }
});

test('the text split in two at every index gives the expected fields', () => {
  for (const entry of allTexts()) {
    const { text } = entry;
    // The 20,000 character fixture is split at a spread of indexes to keep the test quick.
    const step = text.length > 5000 ? 97 : 1;
    for (let cut = 0; cut <= text.length; cut += step) {
      assert.deepEqual(readAll([text.slice(0, cut), text.slice(cut)]), entry.expected, `${entry.name} cut at ${cut}`);
    }
    for (const cut of [1, 2, text.length - 2, text.length - 1]) {
      if (cut > 0 && cut < text.length) {
        assert.deepEqual(readAll([text.slice(0, cut), text.slice(cut)]), entry.expected, `${entry.name} edge cut ${cut}`);
      }
    }
  }
});

test('the text pushed one character at a time gives the expected fields', () => {
  for (const entry of allTexts()) {
    assert.deepEqual(readAll(Array.from(entry.text.split(''))), entry.expected, entry.name);
  }
});

test('the text pushed in three uneven pieces gives the expected fields', () => {
  for (const entry of allTexts()) {
    const { text } = entry;
    const a = Math.floor(text.length / 3);
    const b = Math.floor((text.length * 2) / 3) + 1;
    assert.deepEqual(readAll([text.slice(0, a), text.slice(a, b), text.slice(b)]), entry.expected, entry.name);
  }
});

function isPrefix(shorter, longer) {
  return longer.startsWith(shorter);
}

function endsInLoneHigh(text) {
  if (!text) return false;
  const code = text.charCodeAt(text.length - 1);
  return code >= 0xD800 && code <= 0xDBFF;
}

test('each text field only grows, and never ends in a lone high surrogate while arriving', () => {
  for (const entry of allTexts()) {
    // A fixture whose own final text ends in a lone high surrogate does not exist, so the rule is absolute.
    const decoder = createFollowArgumentDecoder();
    const snapshots = [];
    for (const ch of entry.text.split('')) {
      decoder.push(ch);
      snapshots.push(decoder.snapshot());
    }
    const final = snapshots[snapshots.length - 1];
    assert.deepEqual(final, entry.expected, entry.name);
    const monotonic = !entry.repeats;
    let previous = null;
    for (const snap of snapshots) {
      assert.equal(endsInLoneHigh(snap.path), false, `${entry.name} path`);
      assert.equal(endsInLoneHigh(snap.content), false, `${entry.name} content`);
      for (const e of snap.edits) {
        assert.equal(endsInLoneHigh(e.oldText), false, `${entry.name} oldText`);
        assert.equal(endsInLoneHigh(e.newText), false, `${entry.name} newText`);
      }
      if (monotonic) {
        assert.ok(isPrefix(snap.path, final.path), `${entry.name} path prefix`);
        assert.ok(isPrefix(snap.content, final.content), `${entry.name} content prefix`);
      }
      if (previous && monotonic) {
        assert.ok(isPrefix(previous.path, snap.path), `${entry.name} path grows`);
        assert.ok(isPrefix(previous.content, snap.content), `${entry.name} content grows`);
        // done flags never go back
        for (const flag of ['pathDone', 'contentStarted', 'contentDone', 'done']) {
          if (previous[flag]) assert.equal(snap[flag], true, `${entry.name} ${flag} stays set`);
        }
      }
      previous = snap;
    }
  }
});

test('an edit grows in order: old text, then the new text, entry by entry', () => {
  const value = { file_path: 'g.js', edits: [{ old_string: 'alpha', new_string: 'beta' }, { old_string: 'gamma', new_string: 'delta' }] };
  const text = JSON.stringify(value);
  const decoder = createFollowArgumentDecoder();
  let sawSecondBeforeFirstDone = false;
  let previousLength = 0;
  for (const ch of text.split('')) {
    decoder.push(ch);
    const snap = decoder.snapshot();
    assert.ok(snap.edits.length >= previousLength, 'entries are never removed');
    previousLength = snap.edits.length;
    if (snap.edits.length === 2 && !snap.edits[0].newDone) sawSecondBeforeFirstDone = true;
    for (const e of snap.edits) {
      if (e.newStarted) assert.equal(e.oldDone, true, 'the old text closes before the new text opens');
    }
  }
  assert.equal(sawSecondBeforeFirstDone, false);
  assert.deepEqual(decoder.snapshot().edits, [doneEdit('alpha', 'beta'), doneEdit('gamma', 'delta')]);
});

test('an edit entry exists as soon as its brace or its first key is read', () => {
  const batch = createFollowArgumentDecoder();
  batch.push('{"edits":[');
  assert.equal(batch.snapshot().edits.length, 0);
  batch.push('{');
  assert.deepEqual(batch.snapshot().edits, [edit({})]);
  batch.push('"old_string":"ab');
  assert.deepEqual(batch.snapshot().edits, [edit({ oldText: 'ab' })]);

  const flat = createFollowArgumentDecoder();
  flat.push('{"file_path":"f","old_str');
  assert.equal(flat.snapshot().edits.length, 0);
  flat.push('ing":"x');
  assert.deepEqual(flat.snapshot().edits, [edit({ oldText: 'x' })]);
  flat.push('","new_string":"');
  assert.deepEqual(flat.snapshot().edits, [edit({ oldText: 'x', oldDone: true, newStarted: true })]);
});

test('an escape cut by the end of a chunk is held, never emitted in part', () => {
  const decoder = createFollowArgumentDecoder();
  decoder.push('{"content":"a\\');
  assert.equal(decoder.snapshot().content, 'a');
  decoder.push('u00');
  assert.equal(decoder.snapshot().content, 'a');
  decoder.push('e');
  assert.equal(decoder.snapshot().content, 'a');
  decoder.push('9b');
  assert.equal(decoder.snapshot().content, 'aéb');
  decoder.push('\\uD83D');
  assert.equal(decoder.snapshot().content, 'aéb');
  decoder.push('\\uDE00"');
  assert.equal(decoder.snapshot().content, 'aéb😀');
  assert.equal(decoder.snapshot().contentDone, true);
});

test('a raw high surrogate waits for the next code unit, a lone one is flushed by the closing quote', () => {
  const decoder = createFollowArgumentDecoder();
  const emoji = '😀';
  decoder.push(`{"content":"x${emoji[0]}`);
  assert.equal(decoder.snapshot().content, 'x');
  decoder.push(emoji[1]);
  assert.equal(decoder.snapshot().content, `x${emoji}`);

  const lone = createFollowArgumentDecoder();
  lone.push(`{"content":"x${emoji[0]}`);
  lone.push('"}');
  assert.equal(lone.snapshot().content, `x${emoji[0]}`);
  assert.equal(lone.snapshot().done, true);
});

test('failure: an array at the top level', () => {
  const snap = readAll(['[1,2]']);
  assert.equal(snap.failed, true);
  assert.equal(snap.done, false);
});

test('failure: other things that are not an object at the top level', () => {
  for (const text of ['"str"', '12', 'null', 'true', 'x']) {
    assert.equal(readAll([text]).failed, true, text);
  }
});

test('failure: an invalid escape keeps the last good values', () => {
  for (const bad of ['\\x', '\\u12G4', '\\u', '\\ ']) {
    const decoder = createFollowArgumentDecoder();
    decoder.push('{"path":"p","content":"good');
    decoder.push(bad);
    decoder.push('more"}');
    const snap = decoder.snapshot();
    assert.equal(snap.failed, true, bad);
    assert.equal(snap.content.startsWith('good'), true, bad);
    assert.equal(snap.content.includes('more'), false, bad);
    assert.equal(snap.path, 'p');
    assert.equal(snap.done, false);
  }
});

test('failure: an invalid escape in a skipped string also fails', () => {
  assert.equal(readAll(['{"other":"a\\qb","path":"p"}']).failed, true);
});

test('failure: tokens JSON does not allow', () => {
  const cases = [
    '{"a" 1}',
    '{"a":}',
    '{"a":1,}',
    '{,}',
    '{"a":[1,]}',
    '{"a":[,1]}',
    '{a:1}',
    '{"a":tru}',
    '{"a":01x}',
    '{"a":"x" "b":1}',
    '{"a":1 "b":2}',
    '{"a":[1}',
    '{"a":{]}',
    '{"path":"p"]',
  ];
  for (const text of cases) {
    const snap = readAll([text]);
    assert.equal(snap.failed, true, text);
    assert.equal(snap.done, false, text);
  }
});

test('failure: pushes after failed change nothing', () => {
  const decoder = createFollowArgumentDecoder();
  decoder.push('[');
  const before = decoder.snapshot();
  decoder.push('{"path":"p"}');
  assert.deepEqual(decoder.snapshot(), before);
});

test('overflow: more than maxChars characters are cut off and the rest is ignored', () => {
  const decoder = createFollowArgumentDecoder({ maxChars: 20 });
  decoder.push('{"content":"0123456789');
  assert.equal(decoder.snapshot().overflow, true);
  assert.equal(decoder.snapshot().content, '01234567');
  decoder.push('abcdef"}');
  const snap = decoder.snapshot();
  assert.equal(snap.content, '01234567');
  assert.equal(snap.overflow, true);
  assert.equal(snap.done, false);
  assert.equal(snap.failed, false);
});

test('overflow: exactly maxChars characters is not an overflow', () => {
  const text = '{"path":"p"}';
  const snap = readAll([text], { maxChars: text.length });
  assert.equal(snap.overflow, false);
  assert.equal(snap.done, true);
  assert.equal(snap.path, 'p');
});

test('overflow: counted across pushes', () => {
  const decoder = createFollowArgumentDecoder({ maxChars: 15 });
  decoder.push('{"content":"');
  decoder.push('abcdef');
  const snap = decoder.snapshot();
  assert.equal(snap.overflow, true);
  assert.equal(snap.content, 'abc');
});

test('pushes after done are ignored, including trailing text', () => {
  const decoder = createFollowArgumentDecoder();
  decoder.push('{"path":"p","content":"c"}');
  const done = decoder.snapshot();
  assert.equal(done.done, true);
  decoder.push('{"path":"other"}');
  decoder.push('garbage ]');
  assert.deepEqual(decoder.snapshot(), done);
});

test('leading whitespace before the object is allowed, other pushes of the wrong type are ignored', () => {
  const decoder = createFollowArgumentDecoder();
  decoder.push('  \n ');
  decoder.push(undefined);
  decoder.push(42);
  decoder.push(null);
  decoder.push('');
  decoder.push('{"path":"p"}');
  const snap = decoder.snapshot();
  assert.equal(snap.path, 'p');
  assert.equal(snap.done, true);
  assert.equal(snap.failed, false);
});

test('a long key is skipped like an unknown key', () => {
  const longKey = 'k'.repeat(500);
  const snap = readAll([`{"${longKey}":"v","path":"p"}`]);
  assert.equal(snap.path, 'p');
  assert.equal(snap.done, true);
});

test('cost guard: a 400000 character content pushed in 80 character chunks is exact', () => {
  const content = 'abcdefghi\n"\\é😀'.repeat(40000).slice(0, 400000);
  const text = JSON.stringify({ path: 'huge.txt', content });
  const decoder = createFollowArgumentDecoder({ maxChars: 4000000 });
  for (let at = 0; at < text.length; at += 80) {
    decoder.push(text.slice(at, at + 80));
    // snapshots stay cheap and never copy the growing text again
    if (at % 80000 === 0) decoder.snapshot();
  }
  const snap = decoder.snapshot();
  assert.equal(snap.done, true);
  assert.equal(snap.failed, false);
  assert.equal(snap.overflow, false);
  assert.equal(snap.path, 'huge.txt');
  assert.equal(snap.content.length, content.length);
  assert.equal(snap.content === content, true);
});

test('cost guard: a thousand small edits pushed one character at a time', () => {
  const edits = [];
  for (let i = 0; i < 1000; i += 1) edits.push({ old_string: `old ${i}`, new_string: `new ${i}\n` });
  const text = JSON.stringify({ file_path: 'many.js', edits });
  const decoder = createFollowArgumentDecoder();
  for (const ch of text.split('')) decoder.push(ch);
  const snap = decoder.snapshot();
  assert.equal(snap.done, true);
  assert.equal(snap.edits.length, 1000);
  assert.deepEqual(snap.edits[999], doneEdit('old 999', 'new 999\n'));
});
