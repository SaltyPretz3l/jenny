const test = require('node:test');
const assert = require('node:assert/strict');

const {
  prettifyReasoningMarkdown,
  isProseBoundary,
} = require('../renderer/chat/reasoning-prettify-utils');

const { joinReasoningEntriesMarkdown } = require('../renderer/chat/chat-thinking-utils');

// A newline-free line whose first marker space sits at line offset n.
const lineTo = (n, lead = '') => `${lead}${'x'.repeat(n - 1 - lead.length)}.`;

// [name, input, expected output or null for byte-identical]
const PARAGRAPH_ROWS = [
  ['wall marker at offset 399 stays inline', `${lineTo(399)} So we go.`, null],
  ['wall marker at offset 400 breaks', `${lineTo(400)} So we go.`, `${lineTo(400)}\n\nSo we go.`],
  ['the count restarts after a break (399 more stays inline)', `${lineTo(400)} So ${lineTo(396)} Then go.`, `${lineTo(400)}\n\nSo ${lineTo(396)} Then go.`],
  ['the count restarts after a break (400 more breaks)', `${lineTo(400)} So ${lineTo(397)} Then go.`, `${lineTo(400)}\n\nSo ${lineTo(397)}\n\nThen go.`],
  ['after a real blank line a marker at 1199 stays inline', `Intro.\n\n${lineTo(1199)} So we go.`, null],
  ['after a real blank line a marker at 1200 breaks', `Intro.\n\n${lineTo(1200)} So we go.`, `Intro.\n\n${lineTo(1200)}\n\nSo we go.`],
  ['a blank line holding spaces counts as a real break', `Intro.\n \t\n${lineTo(450)} So we go.`, null],
  ['a CRLF blank line counts as a real break', `Intro.\r\n\r\n${lineTo(450)} So we go.`, null],
  ['a multi-line fence counts as a real break',`\`\`\`js\na\n\`\`\`${lineTo(500)} So we go.`, null],
  ['a formatted paragraph of 494 characters with markers', `Intro.\n\n${'The loader runs. So it reads the cache. Then it stops. '.repeat(9).trim()}`, null],
  ['a formatted paragraph naming members and paths', `Intro.\n\n${'I extend React.Component here. So docs/plans/Foo.Md says it. '.repeat(12).trim()}`, null],
  ['a long blockquote line', `> ${lineTo(600)} So more.`, null],
  ['a long table row', `| a | ${lineTo(600)} So more. |`, null],
  ['a heading line breaks like any line', `# Heading done. So ${lineTo(420)} So it breaks.`, `# Heading done. So ${lineTo(420)}\n\nSo it breaks.`],
  ['a list item breaks like any line', `${lineTo(400, '- ')} So it breaks.`, `${lineTo(400, '- ')}\n\nSo it breaks.`],
  [
    'a stray open quote does not stop breaks, and the quote count restarts at the break',
    `He said "${lineTo(450)} So he wrote "done."Then we go.`,
    `He said "${lineTo(450)}\n\nSo he wrote "done." Then we go.`,
  ],
  ['a closing quote glued to a marker breaks past the threshold', `He said "hi ${lineTo(420)}"So we go.`, `He said "hi ${lineTo(420)}"\n\nSo we go.`],
  ['inline code does not restart the line', `${lineTo(200)} see \`x\` ${lineTo(210)} So we go.`, `${lineTo(200)} see \`x\` ${lineTo(210)}\n\nSo we go.`],
  ['a table row with inline code is never broken', `| a | \`x\` ${lineTo(600)} So more. |`, null],
  ['a quote opened before inline code closes after it', 'He said "use `x` here."Then we go.', 'He said "use `x` here." Then we go.'],
  ['a list started before inline code continues after it', 'Plan:- one `x` done.- two.- three.', 'Plan:\n- one `x` done.\n- two.\n- three.'],
  ['a closed straight quote is broken', `He said "hi" ${lineTo(450)} So we go.`, `He said "hi" ${lineTo(450)}\n\nSo we go.`],
  ['a late real list keeps the breaks above it', `${(`${lineTo(1300)} So we check the loader.\n\n`).repeat(4)}Plan:\n- a\n- b`, `${(`${lineTo(1300)}\n\nSo we check the loader.\n\n`).repeat(4)}Plan:\n- a\n- b`],
  [
    'a long synthesized list line breaks past 400',
    `Notes:- first item. So we check it. ${lineTo(420)} So we check the loader.`,
    `Notes:\n- first item. So we check it. ${lineTo(420)}\n\nSo we check the loader.`,
  ],
];

for (const [name, raw, expected] of PARAGRAPH_ROWS) {
  test(`paragraph breaks: ${name}`, () => {
    const out = prettifyReasoningMarkdown(raw);
    assert.equal(out, expected ?? raw, name);
    assert.equal(prettifyReasoningMarkdown(out), out, `${name}: idempotence`);
  });
}

const ONE_PARAGRAPH = 'The user wants the cache fixed. So I should read the loader. Then I can patch it.';

test('a short paragraph is byte-identical and never retracts when a real blank line arrives', () => {
  assert.equal(prettifyReasoningMarkdown(ONE_PARAGRAPH), ONE_PARAGRAPH);
  const full = `${ONE_PARAGRAPH}\n\nSecond`;
  assert.equal(prettifyReasoningMarkdown(full), full);
  for (let cut = 1; cut <= full.length; cut += 1) {
    const out = prettifyReasoningMarkdown(full.slice(0, cut));
    assert.ok(full.startsWith(out), `cut ${cut}: ${JSON.stringify(out)}`);
  }
});

const FORMATTED_LONG_PARAGRAPH = [
  'Para one.', 'Para two.', 'Para three.',
  `${'x'.repeat(200)}. So the cache holds. ${'y'.repeat(150)}. Now the flags. ${'z'.repeat(60)}. Also done.`,
].join('\n\n');

// [name, input, expected output or null for byte-identical]
const BLOCK_REPAIR_ROWS = [
  ['formatted text with a long paragraph', FORMATTED_LONG_PARAGRAPH, null],
  [
    'formatted text with a glued long paragraph gets a space',
    `Para one.\n\n${'x'.repeat(200)} misses.Let me check. ${'y'.repeat(200)}. So we go.`,
    `Para one.\n\n${'x'.repeat(200)} misses. Let me check. ${'y'.repeat(200)}. So we go.`,
  ],
  ['uppercase dotted identifiers', 'React.Component Console.WriteLine Path.Combine', null],
  ['PascalCase member token at the end of the text', 'models.User', null],
  ['camel-case right token', 'models.UserModel', null],
  ['fenced blank lines', '```text\na\n\n\nb\n```', null],
  ['tilde fence', '~~~python\nvalue = "Done.So check"\n~~~', null],
  ['open tilde fence', '~~~python\nvalue = "Done.So check"', null],
  ['unfinished inline span', 'Use `React.Component', null],
  ['longer language-prefix word', 'Use ```jsonify(data)``` here.', 'Use \n\n```\njsonify(data)\n```\n\n here.'],
  ['a glued fence holding a backtick', 'x```a`b=1``` y', 'x\n\n```\na`b=1\n```\n\n y'],
  ['a glued fence closed by a longer run', '```a=1````', '\n\n```\na=1\n```\n\n'],
  [
    'a sure language glued to the first of several code lines',
    'Do:```jsfunction f(){\n  return 1;\n}\n```\n\nAfter.',
    'Do:\n\n```js\nfunction f(){\n  return 1;\n}\n```\n\nAfter.',
  ],
  ['a fence opener glued to prose', 'Do:```JS\nrun();\n```\n\nAfter.', 'Do:\n\n```JS\nrun();\n```\n\nAfter.'],
  ['an indented fence opener', 'Do:\n   ```js\nrun();\n```', null],
  ['an opening line of code without a sure language', '```console.log(x)\nrun();\n```', null],
  ['a stray triple backtick above a line of prose', 'use ``` (three backticks) to open.\nNext line. So more.', null],
  ['a stray triple backtick at a line end', 'wrap it in ```\nand close it. So more.', null],
];

for (const [name, raw, expected] of BLOCK_REPAIR_ROWS) {
  test(`block repair: ${name}`, () => {
    const out = prettifyReasoningMarkdown(raw);
    assert.equal(out, expected ?? raw, name);
    assert.equal(prettifyReasoningMarkdown(out), out, `${name}: idempotence`);
  });
}

// Real glue shapes captured from an ornith15:9b-q6-256k session
// (sess_1788049580063: 19/19 reasoning entries with zero newlines) plus the
// member, digit, acronym, ellipsis, inline-code, quote and bullet rules.
// [input, expected output or null for byte-identical]
const PROSE_ROWS = [
  [
    'those failures since they were not relevant to my task anyway.My actual next step is editing reset() to initialize the new effect fields.',
    'those failures since they were not relevant to my task anyway. My actual next step is editing reset() to initialize the new effect fields.',
  ],
  ['new player effect fields wired into reset().Does the IIFE see them?Yes, they are in scope.', 'new player effect fields wired into reset(). Does the IIFE see them? Yes, they are in scope.'],
  ['Okay.Let me think', 'Okay. Let me think'],
  ['Hmm.Wait, that is off', 'Hmm. Wait, that is off'],
  ['cache misses.Let me check', 'cache misses. Let me check'],
  ['the café.Then we go', 'the café. Then we go'],
  ['Done!Now inspect the cache. Why?Let me check.', 'Done! Now inspect the cache. Why? Let me check.'],
  [
    'So timer maintenance will not happen while paused. Good. Actually there is a subtlety with the session clock. Let me keep it simple and consistent.',
    null,
  ],
  ['First paragraph ends here. Actually this stays inline.\n\nSecond paragraph. Let me also stay put.\n\nThird paragraph.\n', null],
  // Sentence starters used as member names.
  ['then rows.Next() returns false.', null],
  ['use Assert.That(result, Is.True) here.', null],
  ['call items.First() on it.', null],
  ['await task.Wait() first.', null],
  ['chain promise.Then(next) after.', null],
  ['query.Or(a).And(b) composes.', null],
  ['I use Python.Then I run it', 'I use Python. Then I run it'],
  ['that works.Good.Now move on.', 'that works. Good. Now move on.'],
  // Digits, acronyms and ellipses before a strong starter.
  ['the answer is 42.Then we stop.', 'the answer is 42. Then we stop.'],
  ['read the JSON.Then parse it.', 'read the JSON. Then parse it.'],
  ['Hmm...Actually that is wrong.', 'Hmm... Actually that is wrong.'],
  ['check the map…Then go.', 'check the map… Then go.'],
  ['1.First do X 2.Then do Y', '1. First do X 2. Then do Y'],
  ['the U.S.A is large.', null],
  ['section 3.A describes it.', null],
  ['v1.2.3 shipped and System.IO stays.', null],
  ['call JSON.parse(x) and API.For(x) here.', null],
  ['the doc at docs/v2.Then stays a path.', null],
  // Decimals, versions, identifiers, abbreviations and paths.
  ['v0.9 shipped with x at Math.min(160,W*.23) and a 0.23 ratio.', null],
  ['Object.assign(player,{x:1}) already handles it.', null],
  ['see e.g. the earlier draft for details.', null],
  ['the doc at docs/plans/Foo.Md stays a path.', null],
  ['the file at C:\\Users\\example\\Notes.My stays a path.', null],
  ['the canvas.UI uses the variables live.', null],
  // Known limit: lowercase.PascalCase outside backticks splits; backticks protect it.
  ['the value in config.Models drives it.', 'the value in config. Models drives it.'],
  ['the value in `config.Models` drives it.', null],
  // I-statements and single-letter enumerators.
  ["Let me draft.I'll create an offscreen approach? No, direct drawing is fine.", "Let me draft. I'll create an offscreen approach? No, direct drawing is fine."],
  ['that guess was wrong.I think the fix is small.', 'that guess was wrong. I think the fix is small.'],
  ['Efficient enough if I read selectively.(b) Animate a JS time param on toggle.', 'Efficient enough if I read selectively. (b) Animate a JS time param on toggle.'],
  ['this happens rarely.(see below) for details.', null],
  ['this happens rarely.(ibid) Then we moved on.', null],
  // A sentence that ends in inline code.
  ["I'll call `reset()`.Then I check the fields.", "I'll call `reset()`. Then I check the fields."],
  ['see `cfg`.My next step is wiring.', 'see `cfg`. My next step is wiring.'],
  ['is it `x`?Yes, it is.', 'is it `x`? Yes, it is.'],
  ['use `obj`.Method(x) here.', null],
  ['the `a`.b member.', null],
  // Quotes: straight-quote parity is local to a block; single quotes never fire.
  [
    'That violates "smoothly changing the sky."So I need the canvas to transition too.\n'.repeat(6).trimEnd(),
    'That violates "smoothly changing the sky." So I need the canvas to transition too.\n'.repeat(6).trimEnd(),
  ],
  ['the plan said “done.”Then we moved on to sizing.\nAnd here.', 'the plan said “done.” Then we moved on to sizing.\nAnd here.'],
  ['read docs/plans."Next steps live there.', null],
  ['The instruction is clear."Do not edit files."', null],
  ['Check example.com."So the DNS is fine."', null],
  ["value is \"true\".'Value' is the key.", null],
  ['The answer is 42."Great," he said.', null],
  ['He said "unterminated here\n\nNext paragraph is clear."Do not edit files."', null],
  ['He said "done."Then we moved on.', 'He said "done." Then we moved on.'],
  // Glued bullets: ":" starts a list, "." continues one.
  ['Steps:- read the JSON.- write the CSV.- ship it.', 'Steps:\n- read the JSON.\n- write the CSV.\n- ship it.'],
  ['Steps:- wait 5.- then go home.- finally sleep tight.', 'Steps:\n- wait 5.- then go home.\n- finally sleep tight.'],
  ['Plan:\n- one.- two.- three.', 'Plan:\n- one.\n- two.\n- three.'],
  ['it ended.- then nothing else was listed here.', null],
  ['see pages 3.- Five for the relevant part of the spec.', null],
  ['the total costs about:- 5 dollars per unit which is fine for now.', null],
  ['A list already exists:- inline oddity kept.\n\nBecause this text has real paragraphs.', 'A list already exists:\n- inline oddity kept.\n\nBecause this text has real paragraphs.'],
  ['errors:- guard it. Actually, check the ratio.- handle resize.- done for now.', 'errors:\n- guard it. Actually, check the ratio.\n- handle resize.\n- done for now.'],
  [
    "Let me be careful to avoid console errors:- Guard devicePixelRatio.- Ensure canvas.getContext('2d') works.- Handle window resize.Let me now think about the projection math.",
    "Let me be careful to avoid console errors:\n- Guard devicePixelRatio.\n- Ensure canvas.getContext('2d') works.\n- Handle window resize. Let me now think about the projection math.",
  ],
];

test('prose rows: sentence glue, member guards, quotes and glued bullets', () => {
  for (const [raw, expected] of PROSE_ROWS) {
    const out = prettifyReasoningMarkdown(raw);
    assert.equal(out, expected ?? raw, raw);
    assert.equal(prettifyReasoningMarkdown(out), out, `${raw}: idempotence`);
  }
});

test('isProseBoundary accepts a prefix that ends in prose or after a closed code segment', () => {
  assert.equal(isProseBoundary('plain prose'), true);
  assert.equal(isProseBoundary(''), true);
  assert.equal(isProseBoundary('`"` said "hi'), true, 'quote parity is block-local, so an odd quote is a safe boundary');
  assert.equal(isProseBoundary('a "b" c `"`'), true, 'a closed inline span');
  assert.equal(isProseBoundary('A ```x ~~~``` b ~~~ c'), false, 'tilde fence left open');
  assert.equal(isProseBoundary('```js\ncode\n```'), true);
  assert.equal(isProseBoundary('```js\ncode'), false);
  assert.equal(isProseBoundary('use `open'), false);
});

test('bounded glue-token scan still preserves a 200-character path token', () => {
  const token = `docs/${'a'.repeat(192)}.Aa`;
  assert.equal(token.length, 200);
  assert.equal(prettifyReasoningMarkdown(token), token);
});

test('a late code fence cannot retract list repairs', () => {
  const prose = 'no newlines here at all as the model rambles about the fix:- read the config.- write the output.';
  const fence = '```js\n' + 'const a = 1;\n'.repeat(14) + '```';
  const out = prettifyReasoningMarkdown(prose + fence);
  assert.ok(
    out.includes(':\n- read the config.\n- write the output.'),
    `prose repairs must survive a trailing fence, got: ${JSON.stringify(out)}`,
  );
});

test('fenced code keeps its glued colon-hyphen content', () => {
  assert.ok(prettifyReasoningMarkdown('Check:```yamlkey:- one```').includes('key:- one'));
});

test('rebuilds a glued one-line ```js fence into a real fenced block', () => {
  const raw = "The line is:```jsfunction reset(){distance=0;shards=0;scoreEl.textContent='0'}```I need to add resetting of powerup fields.";
  const out = prettifyReasoningMarkdown(raw);
  assert.equal(
    out,
    "The line is:\n\n```js\nfunction reset(){distance=0;shards=0;scoreEl.textContent='0'}\n```\n\nI need to add resetting of powerup fields.",
  );
});

// [text between the triple backticks, language or '' for none, code or null for the whole text]
const FENCE_LANG_ROWS = [
  ['jsfunction reset(){}', 'js', 'function reset(){}'],
  ['jsconst a={x:1};', 'js', 'const a={x:1};'],
  ['pyimport os; os.getcwd()', 'py', 'import os; os.getcwd()'],
  ['json{"a":1}', 'json', '{"a":1}'],
  ['js const a = 1;', 'js', 'const a = 1;'],
  ['c int main(){}', 'c', 'int main(){}'],
  ['JSfunction f(){}', 'js', 'function f(){}'],
  ...[
    'console.log(x)', 'ctx.fillStyle="red";', 'canvas.width = W;', 'count = 0', 'shards=0;',
    'shutil.copy(a, b)', 'json.dumps(x)', 'c = a + b', 'c[i] = 0;', 'diff = a - b', 'diff(a, b)',
    'ts = time.time()', 'pygame.init()', 'sqlite3.connect(p)', 'cssText = "a{}"', 'jsonData = {a:1}',
    'cd foo; ls', 'yaml.safe_load(f)', 'html.escape(s)', 'check(x)', 'cprint("x", "red")',
    'const Uex = Ux*cR + bz*sR;', 'python manage.py migrate; echo ok', 'sh -c "a; b"',
    'python x = 1', 'pythonx = 1', 'js(reset())',
  ].map((text) => [text, '', null]),
];

test('a glued fence keeps its whole text unless a language is certain', () => {
  for (const [text, lang, code] of FENCE_LANG_ROWS) {
    const out = prettifyReasoningMarkdown(`\`\`\`${text}\`\`\``);
    assert.equal(out, `\n\n\`\`\`${lang}\n${code ?? text}\n\`\`\`\n\n`, text);
    assert.equal(prettifyReasoningMarkdown(out), out, `${text}: idempotence`);
  }
});

test('the open repair of a glued fence stays a prefix of the closed repair', () => {
  for (const text of ['console.log(x)', 'jsfunction reset(){}', 'a`b=1; c']) {
    const closed = prettifyReasoningMarkdown(`\`\`\`${text}\`\`\``);
    for (let cut = 1; cut <= text.length; cut += 1) {
      const prefix = text.slice(0, cut);
      if (!/[{};=()<>[\]]/.test(prefix)) continue;
      const open = prettifyReasoningMarkdown(`\`\`\`${prefix}`);
      assert.ok(closed.startsWith(open.trimEnd()), `${prefix}: ${JSON.stringify(open)}`);
      assert.equal(prettifyReasoningMarkdown(open), open, `${prefix}: idempotence`);
    }
  }
});

const RUN_LENGTH_UNCHANGED = [
  '````md\n```js\nmodels.User misses.Let me\n```\n````',
  '````md\n```js\nmodels.User misses.Let me',
  'inline ``a `b` misses.Let c`` end',
];

test('code segments follow backtick run length, so nested fences and spans stay untouched', () => {
  for (const raw of RUN_LENGTH_UNCHANGED) {
    assert.equal(prettifyReasoningMarkdown(raw), raw, raw);
  }
  assert.equal(isProseBoundary('````md\n```\nx\n````'), true, 'a four-backtick fence closes on four');
  assert.equal(isProseBoundary('````md\n```\nx\n```'), false, 'three backticks do not close a four-backtick fence');
  assert.equal(isProseBoundary('a ``x `y` z`` b'), true);
  assert.equal(isProseBoundary('a ``x `y` z'), false, 'an unfinished double-backtick span');
});

const OPEN_CONTEXT = 'Line one.\nLine two.\nThe line is:```jsfunction reset(){a=0;';

test('an open glued fence is repaired at the streaming tail, and the closer extends it', () => {
  const open = prettifyReasoningMarkdown(OPEN_CONTEXT);
  assert.equal(open, 'Line one.\nLine two.\nThe line is:\n\n```js\nfunction reset(){a=0;');
  assert.equal(prettifyReasoningMarkdown(open), open, 'open repair is idempotent');
  const closed = prettifyReasoningMarkdown(`${OPEN_CONTEXT}}\`\`\``);
  assert.ok(closed.startsWith(open), 'the closed repair starts with the open repair');
  assert.equal(prettifyReasoningMarkdown(closed), closed, 'closed repair is idempotent');
  const moreLines = prettifyReasoningMarkdown(`${OPEN_CONTEXT}\n  b=1;\n}\n\`\`\`\n\nDone.`);
  assert.equal(moreLines, `${open}\n  b=1;\n}\n\`\`\`\n\nDone.`, 'code lines below keep the open repair');
  assert.equal(prettifyReasoningMarkdown(moreLines), moreLines, 'the repair with code lines below is idempotent');
});

test('leaves well-formed fences, inline code, and non-code triple-backtick spans alone', () => {
  const wellFormed = 'Check this:\n\n```js\nconst a = 1;\n```\n\nand `player` inline.';
  assert.equal(prettifyReasoningMarkdown(wellFormed), wellFormed);
  const noLang = 'a weird ```foo bar``` span stays inline.';
  assert.equal(prettifyReasoningMarkdown(noLang), noLang);
  const langOnly = 'an empty ```js``` mention stays inline.';
  assert.equal(prettifyReasoningMarkdown(langOnly), langOnly);
});

test('streams colliding keywords as append-stable language-less fences', () => {
  const partial = '```const Uex = Ux*cR + bz*sR;';
  const open = prettifyReasoningMarkdown(partial);
  const closed = prettifyReasoningMarkdown(`${partial}\`\`\``);
  assert.equal(open, '\n\n```\nconst Uex = Ux*cR + bz*sR;');
  assert.equal(prettifyReasoningMarkdown(open), open, 'open repair is idempotent');
  assert.ok(closed.startsWith(open), 'pair repair preserves the open-fence prefix');
  assert.equal(closed, `${open}\n\`\`\`\n\n`);
});

test('prose rules never touch code segments', () => {
  const raw = 'Before.```jsconst a={x:1};if(a.Value){run()}```After.Wait, check `list.Sort` too.';
  const out = prettifyReasoningMarkdown(raw);
  assert.ok(out.includes('if(a.Value){run()}'), 'fenced code keeps its dotted identifier');
  assert.ok(out.includes('`list.Sort`'), 'inline code keeps its dotted identifier');
  assert.ok(out.includes('Before.\n\n```js'), 'prose before the fence gets the block break');
});

const GLUE_SAMPLES = [
  {
    name: 'fence + discourse sample',
    // Widest deliberately-deferred tail: a glued fence opener whose code
    // hasn't produced a code-hint character yet ("```jsfunction reset" = 19
    // chars) plus a marker lookahead.
    tailWindow: 32,
    raw: "Now step2 - add shared plumbing wired into reset().Let me look at the current state.The line is:```jsfunction reset(){distance=0;time=0}```I need to add the effect fields.Also there is powerups=[] now declared as let.Good.",
  },
  {
    name: 'I-contraction + glued bullets + quoted ender + enumerator sample',
    // Every rule exercised here has a short bounded lookahead, so the
    // window is much tighter than the fence sample's.
    tailWindow: 16,
    raw: "Let me draft.I'll avoid console errors:- Guard devicePixelRatio.- Ensure canvas.getContext('2d') works.- Handle window resize.- Debounce the observer callback.- Cache the gradient stops.That violates \"smoothly changing the sky.\"So I need the canvas to transition too.Efficient enough if I read selectively.(b) Animate a JS time param on toggle.Now the plan said “done.”Then we sized it.",
  },
];

for (const { name, raw, tailWindow } of GLUE_SAMPLES) {
  test(`${name}: idempotent and append-stable near the live tail`, () => {
    const full = prettifyReasoningMarkdown(raw);
    assert.equal(prettifyReasoningMarkdown(full), full);
    for (let cut = 10; cut < raw.length; cut += 7) {
      const partial = prettifyReasoningMarkdown(raw.slice(0, cut));
      let common = 0;
      while (common < partial.length && common < full.length && partial[common] === full[common]) {
        common += 1;
      }
      assert.ok(
        common >= partial.length - tailWindow,
        `cut ${cut}: settled output reflowed ${partial.length - common} chars from the tail`,
      );
    }
  });
}

const PROPERTY_FRAGMENTS = [
  'the cache misses.', 'Let me check the loader', ' So we go. ', ' Actually, wait. ', 'He said "done."', 'Then "more',
  ' `inline.Code` ', '`open ', '\n', '\n\n', '```js\nconst a = 1;\n```', '```jsfunction f(){return 1}```', '~~~',
  'Plan:- first.- second.', ' models.User ', ' docs/plans/Foo.Md ', ' word'.repeat(90), '.(b) next',
  '- item one. So it stays', '> quote. So more', '42.Then ', '...Actually ', 'rows.Next', '()', '| a | b. So |',
  '"', ' wrote "done."Then ', '.- next item', ' `x`.So ', 'Do:```js\nrun();\n```', '```jsconst b = 2;', '\n \n', '`',
];
// A space waits for its starter word and the character after it; the
// longest starter ("Alternatively") plus that character is 14. The largest
// retraction on this seed is 8 ("...Actually" waiting for its space).
const PREFIX_RETRACTION_BOUND = 16;

test('properties: idempotent, prefix-determined, and block-local past a real blank line', () => {
  let seed = 20261122;
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const collapse = (text) => text.replace(/\n{3,}/g, '\n\n');
  const remainder = (text) => prettifyReasoningMarkdown(`\n\n${text}`).replace(/^\n+/, '');
  for (let round = 0; round < 2000; round += 1) {
    let raw = '';
    for (let count = 4 + next(15); count > 0; count -= 1) raw += PROPERTY_FRAGMENTS[next(PROPERTY_FRAGMENTS.length)];
    const out = prettifyReasoningMarkdown(raw);
    assert.equal(prettifyReasoningMarkdown(out), out, `I1: ${JSON.stringify(raw)}`);
    let previousRaw = '';
    let previous = '';
    for (let cut = 0; cut < raw.length;) {
      cut = Math.min(raw.length, cut + 1 + next(12));
      const current = prettifyReasoningMarkdown(raw.slice(0, cut));
      // A backtick or tilde run at the tail can still grow into a different
      // closer, so that step's lookahead is incomplete.
      if (isProseBoundary(previousRaw) && !/[`~]$/.test(previousRaw)) {
        let common = 0;
        while (common < previous.length && previous[common] === current[common]) common += 1;
        assert.ok(common >= previous.length - PREFIX_RETRACTION_BOUND, `I2 at ${cut}: ${JSON.stringify(raw)}`);
      }
      previousRaw = raw.slice(0, cut);
      previous = current;
    }
    for (let at = raw.indexOf('\n\n'); at !== -1; at = raw.indexOf('\n\n', at + 1)) {
      const prefix = raw.slice(0, at);
      if (!isProseBoundary(prefix)) continue;
      const split = `${prettifyReasoningMarkdown(prefix)}\n\n${remainder(raw.slice(at + 2))}`;
      assert.equal(collapse(out), collapse(split), `I3 at ${at}: ${JSON.stringify(raw)}`);
    }
  }
});

test('joinReasoningEntriesMarkdown prettifies glued reasoning text', () => {
  const entries = [{ text: 'the guard held.Now wire the reset fields.' }];
  assert.equal(
    joinReasoningEntriesMarkdown(entries),
    'the guard held. Now wire the reset fields.',
  );
});
