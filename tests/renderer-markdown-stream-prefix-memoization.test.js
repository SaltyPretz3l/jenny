'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

global.document = new JSDOM('').window.document;

const markdownUtils = require('../renderer/shared/markdown-utils');

const CHUNK_SIZES = [37, 61, 43, 79, 53];
// Escaped rather than literal: HTML text serialization escapes U+00A0
// alongside & < >, which a hand-rolled code-body serializer missed. Keeping it
// as an escape lets eslint's no-irregular-whitespace rule stay on.
const NBSP = ' ';

function comparableUnits(units) {
  return (Array.isArray(units) ? units : []).map((unit) => ({
    html: unit.html,
    fingerprint: unit.fingerprint,
    sourceHtml: unit.sourceHtml,
    sourceFingerprint: unit.sourceFingerprint,
  }));
}

function streamBody(source) {
  let aggregate = '';
  let offset = 0;
  let chunkIndex = 0;
  let previousUnits = [];
  let model = null;
  while (offset < source.length) {
    const size = CHUNK_SIZES[chunkIndex % CHUNK_SIZES.length];
    aggregate += source.slice(offset, offset + size);
    offset += size;
    chunkIndex += 1;
    model = markdownUtils.renderStreamingMarkdownUnits(aggregate, {
      mermaid: 'plain',
      previousUnits,
    });
    previousUnits = model.units;
  }
  return model;
}

test('streamed Markdown remains byte-identical to one-shot rendering across representative bodies', () => {
  const longFence = [
    '```js',
    ...Array.from(
      { length: 900 },
      (_, index) => `const value${index} = "<tag-${index}> & 'quoted'";`,
    ),
    '```',
  ].join('\r\n');
  const bodies = [
    'First paragraph.\n\nSecond paragraph with **bold** and `code`.\n\nThird paragraph.',
    '- outer\n  - nested one\n  - nested two\n    1. deep\n    2. deeper\n\nAfter the list.',
    longFence,
    '| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n| beta | 2 |\n| gamma | 3 |',
    '[docs]\n\nThe definition arrives later.\n\n[docs]: https://example.com/docs',
    'Inline $x + y$ stays mixed with prose.\n\nAnd $$a^2 + b^2$$ remains stable.',
  ];

  for (const body of bodies) {
    const streamed = streamBody(body);
    const full = markdownUtils.renderStreamingMarkdownUnits(body, { mermaid: 'plain' });
    assert.equal(streamed.html, full.html, body.slice(0, 60));
    assert.deepEqual(comparableUnits(streamed.units), comparableUnits(full.units), body.slice(0, 60));
  }
});

test('stream state survives frozen prefix reuse and keeps later frames incremental', () => {
  const source = Array.from(
    { length: 80 },
    (_, index) => `Paragraph ${index} settles independently.\n\n`,
  ).join('') + 'Mutable tail';
  const model = streamBody(source);

  assert.ok(model.streamState);
  assert.equal(model.streamState.source, source);
  assert.ok(model.streamState.stablePrefixEnd > 0);
  assert.ok(model.streamState.prefixUnits.length > 1);
  assert.equal(model.units[0].streamState, model.streamState);
  assert.equal(model.renderMode, 'incremental');
});

test('changedStartIndex preserves the legacy values across prefix promotions', () => {
  const sequence = [
    ['Alpha', 0, 'full'],
    ['Alpha grows', 0, 'full'],
    ['Alpha grows.\n\nBeta', 0, 'incremental'],
    ['Alpha grows.\n\nBeta grows', 1, 'incremental'],
    ['Alpha grows.\n\nBeta grows\n\n- item', 2, 'incremental'],
    ['Alpha grows.\n\nBeta grows\n\n- item grows', 2, 'incremental'],
    ['Alpha grows.\n\nBeta grows\n\n- item grows\n\nDone', 3, 'incremental'],
  ];
  let previousUnits = [];
  let previousStreamState = null;
  for (const [source, expectedChangedStart, expectedMode] of sequence) {
    const model = markdownUtils.renderStreamingMarkdownUnits(source, {
      mermaid: 'plain', previousUnits, previousStreamState,
    });
    assert.equal(model.changedStartIndex, expectedChangedStart, source);
    assert.equal(model.renderMode, expectedMode, source);
    previousUnits = model.units;
    previousStreamState = model.streamState;
  }
});

test('tampering inside a settled prefix lowers changedStartIndex to the forged unit', () => {
  const source = Array.from(
    { length: 12 },
    (_, index) => `Settled paragraph ${index}.\n\n`,
  ).join('') + 'Mutable tail';
  const model = streamBody(source);
  assert.ok(model.streamState.prefixUnits.length >= 3);

  const forgedUnits = model.units.map((unit, index) => (index === 1 ? {
    ...unit,
    html: '<img src=x onerror=alert(1)>',
  } : unit));
  const repaired = markdownUtils.renderStreamingMarkdownUnits(source, {
    mermaid: 'plain', previousUnits: forgedUnits, previousStreamState: model.streamState,
  });

  assert.equal(repaired.changedStartIndex, 1);
  assert.equal(repaired.units[1].html, model.units[1].html);
  assert.doesNotMatch(repaired.html, /onerror|<img/i);
});

test('html and fingerprints are lazy, cached, enumerable, and survive object spread', () => {
  const model = markdownUtils.renderStreamingMarkdownUnits('First.\n\nSecond.', { mermaid: 'plain' });
  assert.equal(typeof Object.getOwnPropertyDescriptor(model, 'html')?.get, 'function');
  assert.equal(typeof Object.getOwnPropertyDescriptor(model, 'fingerprints')?.get, 'function');

  const html = model.html;
  const fingerprints = model.fingerprints;
  assert.equal(model.html, html);
  assert.equal(model.fingerprints, fingerprints);
  assert.equal(Object.getOwnPropertyDescriptor(model, 'html')?.value, html);
  assert.equal(Object.getOwnPropertyDescriptor(model, 'fingerprints')?.value, fingerprints);

  const spread = { ...model };
  assert.equal(spread.html, html);
  assert.deepEqual(spread.fingerprints, fingerprints);
});

// Regression guard for a corruption class, not a perf property.
//
// Bulk (>MAX_BODY_LINES) code blocks get an id embedding the block's index
// within its rendered fragment. Streaming renders the settled prefix and the
// mutable tail as SEPARATE fragments, so that index restarts at 0 in the tail
// and has to be offset by however many blocks already settled.
//
// Doing that offset by regex-rewriting the already-rendered HTML silently
// rewrote answer text that merely CONTAINED an id-shaped string -- first for
// any occurrence, then, after narrowing the pattern to attribute syntax, still
// for prose and code that legitimately contains `id="md-codeblock-..."` (the
// sanitizer keeps those quotes literal in text content). The offset is now
// passed into the renderer so the id is correct when generated and no rendered
// output is ever rewritten.
//
// Each case streams a document whose tail contains an id-shaped string and
// asserts the streamed html is byte-identical to a one-shot render.
function streamToCompletion(source, chunkSize) {
  let previousUnits = [];
  let previousStreamState = null;
  let model;
  for (let end = chunkSize; ; end += chunkSize) {
    model = markdownUtils.renderStreamingMarkdownUnits(source.slice(0, Math.min(end, source.length)), {
      mermaid: 'plain', previousUnits, previousStreamState,
    });
    previousUnits = model.units;
    previousStreamState = model.streamState;
    if (end >= source.length) break;
  }
  return model;
}

function bulkFence(lines) {
  let out = '```text\n';
  for (let index = 0; index < lines; index += 1) {
    out += `payload line ${String(index).padStart(4, '0')} of a bulk code block\n`;
  }
  return `${out}\`\`\`\n\n`;
}

test('streamed output never rewrites answer text that looks like a code-block id', () => {
  const prefix = bulkFence(450);
  const cases = [
    ['bare id token in prose', 'See id md-codeblock-12_abc123-0-pre in the docs.\n\n'],
    ['literal id attribute in prose', 'Use id="md-codeblock-12_abc123-0-pre" to target it.\n\n'],
    ['literal aria-controls attribute in prose', 'Set aria-controls="md-codeblock-99_deadbeef-0-pre" on it.\n\n'],
    ['inline code containing the attribute', 'Write `id="md-codeblock-7_aaa111-0-pre"` in the markup.\n\n'],
    ['a second fence whose body contains the attribute', '```html\n<pre id="md-codeblock-3_bbb222-0-pre">x</pre>\n```\n\n'],
  ];

  for (const [name, tail] of cases) {
    const source = prefix + tail;
    const oneShot = markdownUtils.renderStreamingMarkdownUnits(source, { mermaid: 'plain' });
    for (const chunkSize of [200, 61]) {
      assert.equal(
        streamToCompletion(source, chunkSize).html,
        oneShot.html,
        `${name} diverged from a one-shot render at chunk size ${chunkSize}`
      );
    }
  }
});

test('promoted fence bodies match a one-shot render for indented and nbsp content', () => {
  // Both cases came from re-deriving the rendered code body from raw Markdown
  // by hand: that skipped CommonMark's fence indent stripping and missed
  // U+00A0, which HTML text serialization escapes alongside & < >.
  const indented = (() => {
    let out = '  ```text\n';
    for (let index = 0; index < 600; index += 1) {
      out += `  line ${String(index).padStart(5, '0')} carries boundary-free code text\n`;
    }
    return out;
  })();
  const nbsp = (() => {
    let out = '```text\n';
    for (let index = 0; index < 600; index += 1) {
      out += `line ${String(index).padStart(5, '0')}${NBSP}carries a non-breaking space\n`;
    }
    return out;
  })();

  for (const [name, source] of [['indented fence', indented], ['nbsp fence', nbsp]]) {
    const oneShot = markdownUtils.renderStreamingMarkdownUnits(source, { mermaid: 'plain' });
    assert.equal(streamToCompletion(source, 200).html, oneShot.html, `${name} diverged`);
  }
});
