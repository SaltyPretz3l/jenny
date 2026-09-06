const test = require('node:test');
const assert = require('node:assert/strict');

const {
  prettifyReasoningMarkdown,
  hasSparseNewlines,
} = require('../renderer/chat/reasoning-prettify-utils');

const { joinReasoningEntriesMarkdown } = require('../renderer/chat/chat-thinking-utils');

const PARAGRAPH_MARKER_RE = /([.!?]['")\]’”]?) (?=(?:Actually|Alternatively|But wait|Let me|Wait|Hmm|Okay|OK|Now|Also|First|Next|Then|So|Good|But)[ ,])/g;

function oldSynthesizeParagraphs(prose) {
  return prose.replace(PARAGRAPH_MARKER_RE, (match, ender, offset) => {
    const lineStart = prose.lastIndexOf('\n', offset) + 1;
    return prose.startsWith('- ', lineStart) ? match : `${ender}\n\n`;
  });
}

test('synthesizeParagraphs matches the prior backward-scan algorithm', () => {
  const fixtures = Array.from({ length: 36 }, (_, index) => {
    const sections = [
      `Fixture ${index} starts here. Actually, inspect this part. Then, continue carefully.`,
      index % 2 === 0 ? '\nA new line ends. Now, consider its marker.' : ' Sparse prose ends. Also, keep going.',
      index % 3 === 0 ? '\n- List item ends. Now, this marker stays inline. Good. But, so does this one.' : '',
      index % 4 === 0 ? '\n\nFormatted paragraph ends. Let me, verify it.' : '\nFinal line ends? Wait, check it.',
    ];
    return sections.join('') + ' trailing prose'.repeat(200);
  });

  for (const fixture of fixtures) {
    assert.equal(prettifyReasoningMarkdown(fixture), oldSynthesizeParagraphs(fixture));
  }
});

test('prettifies a 200K newline-free reasoning wall within 100 ms', () => {
  const { performance } = require('node:perf_hooks');
  const chunk = `${'a'.repeat(69)}. Actually, `;
  const prose = chunk.repeat(Math.ceil(200_000 / chunk.length)).slice(0, 200_000);
  const timings = [];
  for (let run = 0; run < 3; run += 1) {
    const startedAt = performance.now();
    prettifyReasoningMarkdown(prose);
    timings.push(performance.now() - startedAt);
  }

  assert.ok(Math.min(...timings) < 100, `fastest run was ${Math.min(...timings).toFixed(1)} ms`);
});

test('bounds whitespace-free glue-token scans below 50 ms', () => {
  const { performance } = require('node:perf_hooks');
  const prose = 'a.Aa'.repeat(4096);
  const timings = [];
  for (let run = 0; run < 3; run += 1) {
    const startedAt = performance.now();
    prettifyReasoningMarkdown(prose);
    timings.push(performance.now() - startedAt);
  }

  assert.ok(Math.min(...timings) < 50, `fastest run was ${Math.min(...timings).toFixed(1)} ms`);
});

test('bounded glue-token scan still preserves a 200-character path token', () => {
  const token = `docs/${'a'.repeat(192)}.Aa`;
  assert.equal(token.length, 200);
  assert.equal(prettifyReasoningMarkdown(token), token);
});

// Real glue shapes captured from an ornith15:9b-q6-256k session
// (sess_1788049580063: 19/19 reasoning entries with zero newlines).

test('repairs sentence glue after periods, question marks, and closers', () => {
  assert.equal(
    prettifyReasoningMarkdown('those failures since they were not relevant to my task anyway.My actual next step is editing reset() to initialize the new effect fields.'),
    'those failures since they were not relevant to my task anyway. My actual next step is editing reset() to initialize the new effect fields.',
  );
  assert.equal(
    prettifyReasoningMarkdown('new player effect fields wired into reset().Does the IIFE see them?Yes, they are in scope.'),
    'new player effect fields wired into reset(). Does the IIFE see them? Yes, they are in scope.',
  );
});

test('leaves decimals, versions, dotted identifiers, abbreviations, and paths untouched', () => {
  const untouched = [
    'v0.9 shipped with x at Math.min(160,W*.23) and a 0.23 ratio.',
    'Object.assign(player,{x:1}) already handles it.',
    'see e.g. the earlier draft for details.',
    'System.IO stays as an identifier here.',
    'the doc at docs/plans/Foo.Md stays a path.',
    'the file at C:\\Users\\example\\Notes.My stays a path.',
  ];
  for (const sample of untouched) {
    assert.equal(prettifyReasoningMarkdown(sample), sample, sample);
  }
});

test('known limitation: dotted lowercase.PascalCase identifiers outside backticks do split', () => {
  // Accepted trade-off on a thinking-only surface; backticked identifiers
  // (the common model habit) are protected by code masking below.
  assert.equal(
    prettifyReasoningMarkdown('the value in config.Models drives it.'),
    'the value in config. Models drives it.',
  );
  assert.equal(
    prettifyReasoningMarkdown('the value in `config.Models` drives it.'),
    'the value in `config.Models` drives it.',
  );
});

test('repairs sentence glue before I-contractions and bare I', () => {
  assert.equal(
    prettifyReasoningMarkdown("Let me draft.I'll create an offscreen approach? No, direct drawing is fine."),
    "Let me draft. I'll create an offscreen approach? No, direct drawing is fine.",
  );
  assert.equal(
    prettifyReasoningMarkdown('that guess was wrong.I think the fix is small.'),
    'that guess was wrong. I think the fix is small.',
  );
  // ALL-CAPS starts stay glued on purpose — that exclusion protects
  // dotted identifiers like System.IO and canvas.UI.
  assert.equal(
    prettifyReasoningMarkdown('the canvas.UI uses the variables live.'),
    'the canvas.UI uses the variables live.',
  );
});

test('repairs an ender glued through a closing quote to a capital', () => {
  assert.equal(
    prettifyReasoningMarkdown('That violates "smoothly changing the sky."So I need the canvas to transition too.\n'.repeat(6).trimEnd()),
    'That violates "smoothly changing the sky." So I need the canvas to transition too.\n'.repeat(6).trimEnd(),
  );
  assert.equal(
    prettifyReasoningMarkdown('the plan said “done.”Then we moved on to sizing and layout.\nMore already-formatted text follows here.\nAnd here.\nAnd here.'),
    'the plan said “done.” Then we moved on to sizing and layout.\nMore already-formatted text follows here.\nAnd here.\nAnd here.',
  );
  // Path tokens keep the guard every dot rule uses.
  assert.equal(
    prettifyReasoningMarkdown('read docs/plans."Next steps live there.'),
    'read docs/plans."Next steps live there.',
  );
});

test('straight-quote repair fires only on closing quotes (segment parity)', () => {
  // An odd-numbered straight quote opens a quotation — inserting a space
  // there would put it INSIDE the quote ('clear." Do not…').
  assert.equal(
    prettifyReasoningMarkdown('The instruction is clear."Do not edit files."'),
    'The instruction is clear."Do not edit files."',
  );
  assert.equal(
    prettifyReasoningMarkdown('Check example.com."So the DNS is fine."'),
    'Check example.com."So the DNS is fine."',
  );
  // Straight single quotes are excluded outright — contractions and
  // possessives make open/close parity meaningless for them.
  assert.equal(
    prettifyReasoningMarkdown("value is \"true\".'Value' is the key."),
    "value is \"true\".'Value' is the key.",
  );
  // A digit before the ender rides the same parity guard: opening quote, no fire.
  assert.equal(
    prettifyReasoningMarkdown('The answer is 42."Great," he said.'),
    'The answer is 42."Great," he said.',
  );
});

test('repairs an ender glued to a single-letter enumerator', () => {
  assert.equal(
    prettifyReasoningMarkdown('Efficient enough if I read selectively.(b) Animate a JS time param on toggle.'),
    'Efficient enough if I read selectively. (b) Animate a JS time param on toggle.',
  );
  assert.equal(
    prettifyReasoningMarkdown('this happens rarely.(see below) for details.'),
    'this happens rarely.(see below) for details.',
  );
});

test('synthesizes a markdown list from glued hyphen bullets in sparse text', () => {
  const raw = "Let me be careful to avoid console errors:- Guard devicePixelRatio.- Ensure canvas.getContext('2d') works.- Handle window resize.Let me now think about the projection math.";
  // Trailing prose stays on the last bullet: paragraph markers are
  // suppressed on list-item lines (splitting a synthesized list into
  // list/paragraph/list fragments is worse than a long final item).
  assert.equal(
    prettifyReasoningMarkdown(raw),
    "Let me be careful to avoid console errors:\n- Guard devicePixelRatio.\n- Ensure canvas.getContext('2d') works.\n- Handle window resize. Let me now think about the projection math.",
  );
});

test('acronym-ending bullets keep the list going; digit endings do not', () => {
  // Uppercase before the ender is a valid item boundary — thinking text is
  // full of bullets ending in JSON/CSS/API.
  assert.equal(
    prettifyReasoningMarkdown('Steps:- read the JSON.- write the CSV.- ship it.'),
    'Steps:\n- read the JSON.\n- write the CSV.\n- ship it.',
  );
  // Known limitation: a digit before the ender never opens a bullet (protects
  // "v1.2.- Then" and "pages 3.- 5"), so a digit-ending item glues to the next.
  assert.equal(
    prettifyReasoningMarkdown('Steps:- wait 5.- then go home.- finally sleep tight.'),
    'Steps:\n- wait 5.- then go home.\n- finally sleep tight.',
  );
});

test('paragraph markers never split a synthesized list', () => {
  assert.equal(
    prettifyReasoningMarkdown('errors:- guard it. Actually, check the ratio.- handle resize.- done for now.'),
    'errors:\n- guard it. Actually, check the ratio.\n- handle resize.\n- done for now.',
  );
});

test('list synthesis guards are each independently load-bearing', () => {
  // A digit before the ender is not a bullet lead-in — locks the left-hand
  // character class on its own (the "3.- 5" case is also blocked by the
  // lookahead, so it cannot prove this guard).
  assert.equal(
    prettifyReasoningMarkdown('see pages 3.- Five for the relevant part of the spec.'),
    'see pages 3.- Five for the relevant part of the spec.',
  );
  // A non-word character after the bullet is not a list item — locks the
  // [A-Za-z(] lookahead on its own.
  assert.equal(
    prettifyReasoningMarkdown('the total costs about:- 5 dollars per unit which is fine for now.'),
    'the total costs about:- 5 dollars per unit which is fine for now.',
  );
});

test('only single-letter parentheticals read as enumerators', () => {
  // "(see below)" is rejected by the space inside it, not by its length, so a
  // one-word multi-letter parenthetical is what actually locks \([a-z]\).
  assert.equal(
    prettifyReasoningMarkdown('this happens rarely.(ibid) Then we moved on.'),
    'this happens rarely.(ibid) Then we moved on.',
  );
});

test('sparsity is judged on prose only — a late code fence cannot retract repairs', () => {
  // A glued ramble that ends in a multi-line fenced block: the fence's
  // newlines must not flip the sparse gate and collapse the already-rendered
  // list back into a wall (retroactive rewrite on screen).
  const prose = 'no newlines here at all as the model rambles about the fix:- read the config.- write the output.';
  const fence = '```js\n' + 'const a = 1;\n'.repeat(14) + '```';
  const out = prettifyReasoningMarkdown(prose + fence);
  assert.ok(
    out.includes(':\n- read the config.\n- write the output.'),
    `prose repairs must survive a trailing fence, got: ${JSON.stringify(out)}`,
  );
});

test('list synthesis stays away from formatted text, ranges, and code', () => {
  const formatted = 'A list already exists:- inline oddity kept.\n\nBecause this text has real paragraphs.\n\nAnd more.\n\nAnd more.\n\nAnd more.';
  assert.equal(prettifyReasoningMarkdown(formatted), formatted);
  assert.equal(
    prettifyReasoningMarkdown('see pages 3.- 5 for the relevant part of the spec.'),
    'see pages 3.- 5 for the relevant part of the spec.',
  );
  const code = 'Check:```yamlkey:- one```';
  assert.ok(
    prettifyReasoningMarkdown(code).includes('key:- one'),
    'fenced code keeps its glued colon-hyphen content',
  );
});

test('rebuilds a glued one-line ```js fence into a real fenced block', () => {
  const raw = "The line is:```jsfunction reset(){distance=0;shards=0;scoreEl.textContent='0'}```I need to add resetting of powerup fields.";
  const out = prettifyReasoningMarkdown(raw);
  assert.equal(
    out,
    "The line is:\n\n```js\nfunction reset(){distance=0;shards=0;scoreEl.textContent='0'}\n```\n\nI need to add resetting of powerup fields.",
  );
});

test('keeps colliding code keywords intact in language-less fences', () => {
  const raw = '```const Uex = Ux*cR + bz*sR;```';
  const out = prettifyReasoningMarkdown(raw);
  assert.equal(out, '\n\n```\nconst Uex = Ux*cR + bz*sR;\n```\n\n');
  assert.equal(prettifyReasoningMarkdown(out), out, 'language-less repair is idempotent');
  assert.equal(
    prettifyReasoningMarkdown('```value = 1```'),
    '\n\n```\nvalue = 1\n```\n\n',
    'code without a known language is still rebuilt',
  );
});

test('keeps glued language prefixes and recognizes complete language tokens', () => {
  assert.equal(
    prettifyReasoningMarkdown('```jsfunction reset(){}```'),
    '\n\n```js\nfunction reset(){}\n```\n\n',
  );
  assert.equal(
    prettifyReasoningMarkdown('```python x = 1```'),
    '\n\n```python\nx = 1\n```\n\n',
  );
  assert.equal(
    prettifyReasoningMarkdown('```pythonx = 1```'),
    '\n\n```python\nx = 1\n```\n\n',
  );
});

test('leaves well-formed fences, inline code, and non-code triple-backtick spans alone', () => {
  const wellFormed = 'Check this:\n\n```js\nconst a = 1;\n```\n\nand `player` inline.';
  assert.equal(prettifyReasoningMarkdown(wellFormed), wellFormed);
  const noLang = 'a weird ```foo bar``` span stays inline.';
  assert.equal(prettifyReasoningMarkdown(noLang), noLang);
  const langOnly = 'an empty ```js``` mention stays inline.';
  assert.equal(prettifyReasoningMarkdown(langOnly), langOnly);
});

test('opens a glued fence early at a sparse streaming tail', () => {
  const partial = 'The line is:```jsfunction reset(){distance=0;sha';
  assert.equal(
    prettifyReasoningMarkdown(partial),
    'The line is:\n\n```js\nfunction reset(){distance=0;sha',
  );
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

test('synthesizes paragraphs at discourse markers only in sparse text', () => {
  const sparse = 'So timer maintenance will not happen while paused. Good. Actually there is a subtlety with the session clock. Let me keep it simple and consistent.';
  assert.equal(
    prettifyReasoningMarkdown(sparse),
    'So timer maintenance will not happen while paused. Good.\n\nActually there is a subtlety with the session clock.\n\nLet me keep it simple and consistent.',
  );
  // A model that already writes paragraphs is left byte-identical.
  const formatted = 'First paragraph ends here. Actually this stays inline because the text is already formatted.\n\nSecond paragraph. Let me also stay put.\n\nThird paragraph.\n\nFourth line.\n';
  assert.equal(prettifyReasoningMarkdown(formatted), formatted);
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

for (const { name, raw } of GLUE_SAMPLES) {
  test(`is idempotent on the ${name}: f(f(x)) === f(x)`, () => {
    const once = prettifyReasoningMarkdown(raw);
    assert.equal(prettifyReasoningMarkdown(once), once);
  });
}

for (const { name, raw, tailWindow } of GLUE_SAMPLES) {
  test(`is append-stable on the ${name}: earlier output only ever changes near the live tail`, () => {
    const full = prettifyReasoningMarkdown(raw);
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

test('hasSparseNewlines separates unformatted walls from formatted thinking', () => {
  assert.equal(hasSparseNewlines('a'.repeat(2000)), true);
  assert.equal(hasSparseNewlines(Array.from({ length: 10 }, () => 'para '.repeat(20)).join('\n\n')), false);
});

test('joinReasoningEntriesMarkdown prettifies by default and honors the kill switch', () => {
  const entries = [{ text: 'the guard held.Now wire the reset fields.' }];
  assert.equal(
    joinReasoningEntriesMarkdown(entries),
    'the guard held.\n\nNow wire the reset fields.',
  );

  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const priorDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset: { reasoningPrettify: 'false' } } };
  try {
    assert.equal(
      joinReasoningEntriesMarkdown(entries),
      'the guard held.Now wire the reset fields.',
      'flag-off must be byte-identical to the raw join',
    );
  } finally {
    if (hadDocument) {
      globalThis.document = priorDocument;
    } else {
      delete globalThis.document;
    }
  }
});
