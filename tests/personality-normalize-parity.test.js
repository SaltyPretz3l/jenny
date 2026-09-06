const assert = require('node:assert/strict');
const test = require('node:test');

const electron = require('../services/personality-workspace-compile');
const renderer = require('../renderer/features/renderer-personality-counters');

// The Settings preview claims to be the EXACT request contribution. That claim
// is only true while the renderer's pure helpers agree with Electron's
// character for character -- the old preview lied precisely because it had its
// own compile path. Electron is the oracle here; the renderer is the copy.
//
// Deterministic PRNG so a failing case is reproducible from its index alone.
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const FRAGMENTS = [
  'Be terse.',
  'Always cite sources when you can.',
  '# House rules',
  '## Not an H1',
  '<!-- an aside -->',
  '<!-- unterminated',
  '-->',
  '---',
  '---\ntimezone: America/Chicago\n---',
  '---\ntz: X\n---\n',
  '',
  '   ',
  '\t',
  '\n',
  '\r\n',
  'Slang is fine — em dashes too.',
  '\u{1F600}\u{1F680}\u{1F9E0}',
  '漢字がたくさんある文章です。',
  'ünïcödé blend',
  'a'.repeat(40),
  '漢'.repeat(40),
  '\u{1F600}'.repeat(20),
];

function buildCase(random) {
  const parts = [];
  if (random() < 0.15) parts.push('﻿');
  if (random() < 0.2) parts.push('\n\n');
  const count = 1 + Math.floor(random() * 6);
  for (let index = 0; index < count; index += 1) {
    parts.push(FRAGMENTS[Math.floor(random() * FRAGMENTS.length)]);
    if (random() < 0.5) parts.push(random() < 0.3 ? '\r\n' : '\n\n');
  }
  return parts.join('');
}

// Bodies sized to land exactly on, just under, and just over each clip
// boundary -- including on a surrogate pair and a 3-byte CJK char.
function buildBoundaryCases() {
  const cases = [];
  for (const budget of [1500, 1000, 24, 8, 4, 1]) {
    for (const filler of ['a', '漢', '\u{1F600}']) {
      for (const delta of [-2, -1, 0, 1, 2]) {
        const units = Math.max(budget + delta, 0);
        const repeats = Math.ceil(units / filler.length);
        cases.push({ body: filler.repeat(repeats).slice(0, units), budget });
      }
    }
    cases.push({ body: `${'a'.repeat(Math.max(budget - 5, 0))}\u{1F600}tail`, budget });
    cases.push({ body: `${'漢'.repeat(Math.max(budget - 3, 0))}\u{1F600}`, budget });
  }
  return cases;
}

test('normalizeBody agrees with the renderer twin across generated inputs', () => {
  const random = createRandom(0x5eed);
  const mismatches = [];
  for (let index = 0; index < 200; index += 1) {
    const input = buildCase(random);
    const expected = electron.normalizeBody(input);
    const actual = renderer.normalizeBody(input);
    if (actual !== expected) mismatches.push({ index, input, expected, actual });
  }
  assert.deepEqual(mismatches, [], `renderer normalizeBody drifted on ${mismatches.length} input(s)`);

  // Named regressions the generator would only hit by luck.
  const named = [
    ['leading H1', '# Rules\n\nBe terse.'],
    ['frontmatter after H1', '# About you\n---\ntimezone: America/Chicago\n---\n\nBrendan.'],
    ['leading frontmatter', '---\ntimezone: X\n---\nBrendan.'],
    ['BOM', '﻿Be terse.'],
    ['CRLF frontmatter', '---\r\ntz: X\r\n---\r\nBody'],
    ['blank then frontmatter', '\n\n---\ntz: X\n---\nBody'],
    ['frontmatter with no trailing newline', '---\ntz: X\n---'],
    ['multiple H1', '# One\n\ntext\n\n# Two'],
    ['unterminated comment', 'Be terse. <!-- oops'],
    ['comment then H1', '<!-- merged -->\n\n# Identity\n\nvoice'],
    ['thematic break mid-body', 'Intro\n\n---\n\nOutro'],
  ];
  for (const [label, input] of named) {
    assert.equal(renderer.normalizeBody(input), electron.normalizeBody(input), label);
  }
});

test('clipToBudget agrees with the renderer twin on every clip boundary', () => {
  const mismatches = [];
  for (const { body, budget } of buildBoundaryCases()) {
    const expected = electron.clipToBudget(body, budget);
    const actual = renderer.clipToBudget(body, budget);
    if (actual.text !== expected.text || actual.clipped !== expected.clipped) {
      mismatches.push({ budget, length: body.length, expected, actual });
    }
  }
  assert.deepEqual(mismatches, [], `renderer clipToBudget drifted on ${mismatches.length} case(s)`);

  // Electron's own invariant, asserted here so the oracle itself is pinned:
  // clipping never exceeds the budget and never INTRODUCES a lone surrogate.
  // (Some boundary inputs are deliberately built by slicing through a pair --
  // those stay malformed on both sides, which is exactly the parity the half
  // above proves.)
  for (const { body, budget } of buildBoundaryCases()) {
    const { text, clipped } = electron.clipToBudget(body, budget);
    if (!clipped) {
      assert.equal(text, body, 'an unclipped body must come back untouched');
      continue;
    }
    // A budget smaller than the marker itself cannot be honoured; every real
    // budget (1,000 / 1,500) is orders of magnitude larger.
    assert.ok(
      text.length <= Math.max(budget, electron.CLIP_MARKER.length),
      `clip exceeded budget ${budget}: got ${text.length}`
    );
    assert.ok(text.endsWith(electron.CLIP_MARKER), 'a clipped body must carry the marker');
    if (!/[\uD800-\uDBFF]$/.test(body)) {
      assert.equal(/[\uD800-\uDBFF]$/.test(text), false, 'clip left a high surrogate dangling');
    }
  }
});

test('the renderer preview reproduces the wire message byte-for-byte, backstop included', () => {
  const budgets = { ...electron.SECTION_BUDGETS };
  const drafts = [
    { personality: 'Be terse.', user: 'Brendan. CST.', memory: 'Ships on Fridays.' },
    { personality: '漢'.repeat(1400), user: '漢'.repeat(900), memory: '漢'.repeat(1400) },
    { personality: '\u{1F600}'.repeat(900), user: 'plain', memory: '漢'.repeat(1500) },
    { personality: '', user: '', memory: '' },
    { personality: 'a'.repeat(4000), user: '', memory: 'b'.repeat(4000) },
  ];
  for (const draft of drafts) {
    const wire = electron.compilePersonalitySections(draft, budgets);
    const expected = electron.buildPersonalityMessage('Jenny', wire.content);
    const preview = renderer.buildCompiledText({ agentName: 'Jenny', ...draft }, budgets);
    assert.equal(preview, expected, `preview drifted for draft ${JSON.stringify(Object.keys(draft))}`);
    assert.ok(
      Buffer.byteLength(wire.content, 'utf8') <= electron.ADVANCED_CONTEXT_MAX_BYTES,
      'wire content exceeded the 4 KiB backstop'
    );
  }
});
