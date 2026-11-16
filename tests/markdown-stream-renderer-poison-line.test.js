'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const streamRenderer = require('../renderer/shared/markdown-stream-renderer');
const mermaidText = require('../renderer/shared/markdown-mermaid-text');
const mathUtils = require('../renderer/shared/markdown-math-utils');
const { renderStreamingMarkdownUnits } = require('../renderer/shared/markdown-utils');

const scanDependencies = { mermaidText, mathUtils };
const fixtureDirectory = path.join(__dirname, 'fixtures', 'reasoning-stream-poison');
const fixtureNames = [
  'phase5-odd-ticks-first.txt',
  'phase7-odd-ticks-after-prefix.txt',
];

function renderOptions(mode, previousUnits, previousStreamState) {
  return {
    ...(mode === 'plain' ? { mermaid: 'plain' } : {}),
    ...(previousUnits ? { previousUnits, previousStreamState } : {}),
  };
}

function streamInChunks(source, chunkSize, mode = 'answer') {
  let previousUnits = [];
  let previousStreamState = null;
  let model;
  for (let end = chunkSize; ; end += chunkSize) {
    const prefix = source.slice(0, Math.min(end, source.length));
    model = renderStreamingMarkdownUnits(
      prefix,
      renderOptions(mode, previousUnits, previousStreamState)
    );
    previousUnits = model.units;
    previousStreamState = model.streamState;
    if (end >= source.length) break;
  }
  return model;
}

test('odd backtick runs poison only their paragraph', () => {
  const first = 'First para.\n\n';
  const oddParagraph = 'Markers ```` and `` stay literal.\n\n';
  const throughThird = `${first}${oddParagraph}Third para.`;
  const source = `${throughThird}\n\nFourth para.`;

  assert.equal(streamRenderer.findStablePrefixEnd(`${first}${oddParagraph.trimEnd()}`, scanDependencies), 13);
  assert.equal(
    streamRenderer.findStablePrefixEnd(throughThird, scanDependencies),
    first.length + oddParagraph.length
  );
  const streamed = streamInChunks(source, 3, 'plain');
  assert.ok(streamed.streamState.stablePrefixEnd >= `${throughThird}\n\n`.length);
});

test('an odd backtick run on the partial last line holds that paragraph unsettled', () => {
  const first = 'First para.\n\n';
  const source = `${first}unfinished \``;
  assert.equal(streamRenderer.findStablePrefixEnd(source, scanDependencies), first.length);
});

test('document-global reference and raw HTML dependencies still abort promotion', () => {
  assert.equal(streamRenderer.findStablePrefixEnd('[docs]\n\nParagraph.', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('<div>\n\nParagraph.', scanDependencies), 0);
});

test('shortcut references are paragraph-local only in plain mode', () => {
  const source = 'Saw [truncated] here.\n\nNext para.\n\nThird.';
  const plainDependencies = { ...scanDependencies, plainHtml: true };
  assert.ok(streamRenderer.findStablePrefixEnd(source, plainDependencies) > source.indexOf('Next para.'));
  assert.equal(streamRenderer.findStablePrefixEnd(source, scanDependencies), 0);
});

test('inline-code generics do not stop answer-mode promotion', () => {
  const source = 'A\n\nUse `Vec<T>` and `List<String>` here.\n\nC\n\nD';
  assert.ok(streamRenderer.findStablePrefixEnd(source, scanDependencies) >= source.indexOf('C'));
  const streamed = streamInChunks(source, 1);
  assert.equal(streamed.html, renderStreamingMarkdownUnits(source).html);
  assert.ok(streamed.streamState.stablePrefixEnd >= source.indexOf('C'));
});

test('an answer-mode poison line stops promotion at that line instead of resetting it', () => {
  assert.equal(streamRenderer.findStablePrefixEnd('A\n\nsee [1] here\n\nC\n\nD', scanDependencies), 3);
  assert.equal(streamRenderer.findStablePrefixEnd('A\n\nB <div> opens\n\nC\n\nD', scanDependencies), 3);
  assert.equal(streamRenderer.findStablePrefixEnd('A\n\nB\n\n[1]: https://example.com\n\nD', scanDependencies), 6);
});

test('a $$ inside inline code does not hold promotion; a prose $$ holds it until closed', () => {
  const coded = 'A\n\nUse `$$` to open math.\n\nC\n\nD';
  assert.ok(streamRenderer.findStablePrefixEnd(coded, scanDependencies) >= coded.indexOf('C'));
  // Display math pairs across blank lines in the settled render, so a prose
  // opener must hold the tail: a later $$ would turn it into one math block.
  assert.equal(streamRenderer.findStablePrefixEnd('A\n\nPrice is $$5 today\n\nC\n\nD', scanDependencies), 3);
  for (const source of [coded, 'A\n\nPrice is $$5 today\n\nC\n\nD', 'A\n\nPrice is $$5\n\nC\n\nD $$ end']) {
    assert.equal(streamInChunks(source, 1).html, renderStreamingMarkdownUnits(source).html);
  }
});

test('a reference link glued to a word streams byte-equal to the settled render', () => {
  for (const source of [
    'According to the docs[1], it works.\n\nMore text.\n\nEnd.\n\n[1]: https://example.com/docs',
    'Docs say so**[1]** ok.\n\nMore.\n\nEnd.\n\n[1]: https://example.com',
    'Text[^1] here.\n\nMore\n\n[^1]: note',
  ]) {
    assert.equal(streamInChunks(source, 1).html, renderStreamingMarkdownUnits(source).html, source);
  }
});

test('a double-backtick span containing one single backtick matches a full render', () => {
  const source = 'Intro.\n\nUse ``one ` tick`` here.\n\nAfter.\n\nFollowing.';
  const streamed = streamInChunks(source, 2);
  const full = renderStreamingMarkdownUnits(source);
  assert.equal(streamed.html, full.html);
});

for (const fixtureName of fixtureNames) {
  // Fixtures are checked in under `* text=auto`; normalise so a CRLF checkout streams the same bytes as the incident.
  const source = fs.readFileSync(path.join(fixtureDirectory, fixtureName), 'utf8').replace(/\r\n/g, '\n');

  for (const mode of ['plain', 'answer']) {
    test(`${fixtureName} matches full rendering at evenly spaced ${mode} snapshots`, () => {
      let previousUnits = [];
      let previousStreamState = null;
      for (let snapshot = 1; snapshot <= 9; snapshot += 1) {
        const end = Math.round((source.length * snapshot) / 9);
        const prefix = source.slice(0, end);
        const incremental = renderStreamingMarkdownUnits(
          prefix,
          renderOptions(mode, previousUnits, previousStreamState)
        );
        const full = renderStreamingMarkdownUnits(prefix, renderOptions(mode));
        assert.equal(incremental.html, full.html, `${fixtureName} ${mode} snapshot ${snapshot}`);
        previousUnits = incremental.units;
        previousStreamState = incremental.streamState;
      }
    });
  }

  test(`${fixtureName} keeps its 48-character replay tail bounded`, () => {
    let previousUnits = [];
    let previousStreamState = null;
    let noStablePrefixCount = 0;
    let stepCount = 0;
    for (let end = 48; ; end += 48) {
      const streamedLength = Math.min(end, source.length);
      const prefix = source.slice(0, streamedLength);
      const model = renderStreamingMarkdownUnits(
        prefix,
        renderOptions('plain', previousUnits, previousStreamState)
      );
      stepCount += 1;
      if (model.fallbackReason === 'no_stable_prefix') noStablePrefixCount += 1;
      if (streamedLength >= 12000) {
        const unsettledLength = prefix.length - model.streamState.stablePrefixEnd;
        assert.ok(unsettledLength <= 12000, `${fixtureName} tail reached ${unsettledLength} chars`);
      }
      previousUnits = model.units;
      previousStreamState = model.streamState;
      if (end >= source.length) break;
    }
    assert.ok(
      noStablePrefixCount / stepCount < 0.05,
      `${fixtureName} had ${noStablePrefixCount}/${stepCount} no-stable-prefix steps`
    );
  });
}
