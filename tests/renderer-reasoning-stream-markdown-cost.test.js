'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const markdownUtils = require('../renderer/shared/markdown-utils');
const { createReasoningV2Renderer } = require('../renderer/chat/renderer-transcript-reasoning-v2');
const {
  ThinkingPanelController,
  groupReasoningByPhase,
  shouldShowThinkingToggle,
} = require('../renderer/chat/chat-thinking-utils');

const MODE_CEILING_MS = 60_000;
const CHUNK_SIZES = [137, 211, 389, 173, 263, 331, 101, 307];
const BODY_CASES = [
  ['phase-realistic ~3K', 3 * 1024],
  ['~5K', 5 * 1024],
  ['~16K', 16 * 1024],
  ['~48K', 48 * 1024],
];

function buildReasoningMarkdown(minimumChars) {
  let markdown = '';
  let section = 1;
  while (markdown.length < minimumChars) {
    markdown += [
      `## Inspecting path ${section}`,
      '',
      '**Working theory:** the streaming update should preserve settled blocks while the active tail grows.',
      '',
      `- Read the current owner for branch ${section}.`,
      '- Compare the incoming provider delta with the accumulated transcript.',
      '- Check the fallback contract before choosing the next step.',
      '',
      '```js',
      `const branch${section} = { stable: true, attempt: ${section} };`,
      `if (branch${section}.stable) verify('append-only reasoning');`,
      '```',
      '',
      `The evidence for step ${section} is consistent, so the next pass can narrow the remaining uncertainty.`,
      '',
    ].join('\n');
    section += 1;
  }
  return markdown;
}

function splitProviderChunks(body) {
  const chunks = [];
  let offset = 0;
  let chunkIndex = 0;
  while (offset < body.length) {
    const remaining = body.length - offset;
    let size = CHUNK_SIZES[chunkIndex % CHUNK_SIZES.length];
    if (remaining <= 400) {
      size = remaining;
    } else if (remaining - size < 100) {
      size = remaining - 100;
    }
    chunks.push(body.slice(offset, offset + size));
    offset += size;
    chunkIndex += 1;
  }
  return chunks;
}

function measureMode(chunks, usePreviousUnits) {
  markdownUtils.clearMarkdownRenderCache();
  let aggregate = '';
  let previousUnits;
  let finalModel = null;
  let totalMs = 0;
  let everyRenderHadShape = true;

  for (const chunk of chunks) {
    aggregate += chunk;
    const options = usePreviousUnits
      ? { mermaid: 'plain', previousUnits }
      : { mermaid: 'plain' };
    const startedAt = performance.now();
    const model = markdownUtils.renderStreamingMarkdownUnits(aggregate, options);
    totalMs += performance.now() - startedAt;
    everyRenderHadShape = everyRenderHadShape
      && Array.isArray(model?.units)
      && model.units.length > 0
      && typeof model.html === 'string'
      && model.html.length > 0;
    finalModel = model;
    if (usePreviousUnits) previousUnits = model?.units;
  }

  return {
    totalMs,
    meanMs: totalMs / chunks.length,
    finalModel,
    everyRenderHadShape,
  };
}

function formatTable(rows) {
  const header = '| body | chars | chunks | no-state total ms | no-state mean ms/chunk-render | previousUnits total ms | previousUnits mean ms/chunk-render | ratio (no-state / previousUnits) |';
  const divider = '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |';
  return [
    'Renderer-call cost only (not end-to-end streaming cost)',
    header,
    divider,
    ...rows.map((row) => [
      `| ${row.label}`,
      row.chars,
      row.chunks,
      row.noState.totalMs.toFixed(2),
      row.noState.meanMs.toFixed(3),
      row.withState.totalMs.toFixed(2),
      row.withState.meanMs.toFixed(3),
      `${(row.noState.totalMs / row.withState.totalMs).toFixed(2)}x |`,
    ].join(' | ')),
  ].join('\n');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function comparableUnits(units) {
  return (Array.isArray(units) ? units : []).map(({ streamState: _streamState, ...unit }) => unit);
}

function buildCollapsibleFence(label) {
  return ['```text', ...Array.from({ length: 30 }, (_, index) => `${label} line ${index}`), '```', ''].join('\n');
}

function buildFixedLineFence(exactChars, lineCount) {
  const opener = '```text\n'; const closer = '```';
  const payloadChars = exactChars - opener.length - closer.length - lineCount;
  const base = Math.floor(payloadChars / lineCount); let remainder = payloadChars % lineCount;
  const body = Array.from({ length: lineCount }, (_, index) => {
    const prefix = `line ${String(index).padStart(4, '0')} `;
    return prefix + 'x'.repeat(base + (remainder-- > 0 ? 1 : 0) - prefix.length) + '\n';
  }).join('');
  return opener + body + closer;
}

test('prefix and tail rendering preserves reproducible non-bulk code-block ids', () => {
  for (const settledCodeBlockCount of [0, 1, 3]) {
    const prefix = [
      `Prefix ${settledCodeBlockCount}.`,
      '',
      ...Array.from({ length: settledCodeBlockCount }, (_, index) => buildCollapsibleFence(`settled-${index}`)),
    ].join('\n');
    const source = prefix + buildCollapsibleFence('live');
    const prefixModel = markdownUtils.renderStreamingMarkdownUnits(prefix, { mermaid: 'plain' });
    const streamed = markdownUtils.renderStreamingMarkdownUnits(source, {
      mermaid: 'plain', previousUnits: prefixModel.units, previousStreamState: prefixModel.streamState,
    });
    const full = markdownUtils.renderStreamingMarkdownUnits(source, { mermaid: 'plain' });

    assert.deepEqual(
      [...full.html.matchAll(/id="(md-codeblock-\d+-pre)"/g)].map((match) => match[1]),
      Array.from({ length: settledCodeBlockCount + 1 }, (_, index) => `md-codeblock-${index + 1}-pre`),
      `${settledCodeBlockCount} settled code-block ids`,
    );
    assert.equal(streamed.html, full.html, `${settledCodeBlockCount} settled code blocks`);
    assert.deepEqual(
      comparableUnits(streamed.units),
      comparableUnits(full.units),
      `${settledCodeBlockCount} settled code-block units`,
    );
  }
});

test('byte-gated fence shapes remain byte-identical to a from-scratch render', () => {
  for (const [label, chars, lines] of [
    ['120 KB / 1200 lines', 120_000, 1200],
    ['120 KB / 300 lines', 120_000, 300],
    ['240 KB / 300 lines', 240_000, 300],
  ]) {
    markdownUtils.clearMarkdownRenderCache();
    const source = buildFixedLineFence(chars, lines);
    let previousUnits = []; let previousStreamState = null; let model;
    for (let index = 0; index < 40; index += 1) {
      const end = Math.floor(source.length * (index + 1) / 40);
      model = markdownUtils.renderStreamingMarkdownUnits(source.slice(0, end), {
        mermaid: 'plain', previousUnits, previousStreamState,
      });
      previousUnits = model.units;
      previousStreamState = model.streamState;
    }
    const full = markdownUtils.renderStreamingMarkdownUnits(source, { mermaid: 'plain' });
    assert.equal(model.html, full.html, `${label} final HTML`);
    assert.deepEqual(comparableUnits(model.units), comparableUnits(full.units), `${label} final units`);
  }
});

test('measures reasoning streaming markdown renderer-call cost with and without previousUnits', (t) => {
  const warmupChunks = splitProviderChunks(buildReasoningMarkdown(1024));
  measureMode(warmupChunks, false);
  measureMode(warmupChunks, true);

  const rows = BODY_CASES.map(([label, minimumChars]) => {
    const body = buildReasoningMarkdown(minimumChars);
    const chunks = splitProviderChunks(body);
    assert.ok(chunks.every((chunk) => chunk.length >= 100 && chunk.length <= 400));

    const noState = measureMode(chunks, false);
    const withState = measureMode(chunks, true);

    assert.equal(noState.everyRenderHadShape, true, `${label} no-state render shape`);
    assert.equal(withState.everyRenderHadShape, true, `${label} previousUnits render shape`);
    assert.ok(noState.finalModel.units.length > 0, `${label} no-state final units`);
    assert.ok(withState.finalModel.units.length > 0, `${label} previousUnits final units`);
    assert.ok(noState.finalModel.html.length > 0, `${label} no-state final html`);
    assert.ok(withState.finalModel.html.length > 0, `${label} previousUnits final html`);
    assert.equal(withState.finalModel.html, noState.finalModel.html, `${label} final html equivalence`);
    assert.ok(noState.totalMs < MODE_CEILING_MS, `${label} no-state exceeded ${MODE_CEILING_MS}ms`);
    assert.ok(withState.totalMs < MODE_CEILING_MS, `${label} previousUnits exceeded ${MODE_CEILING_MS}ms`);

    return { label, chars: body.length, chunks: chunks.length, noState, withState };
  });

  t.diagnostic(formatTable(rows));
});

test('reasoning renderPhase incrementally renders a growing ~48K body without corrupting output', (t) => {
  markdownUtils.clearMarkdownRenderCache();
  const body = buildReasoningMarkdown(48 * 1024);
  const frameCount = 30;
  const models = [];
  const renderer = createReasoningV2Renderer({
    escapeHtml,
    groupReasoningByPhase,
    getReasoningEntries: (message) => message?.reasoning?.entries || [],
    renderMarkdown: markdownUtils.renderMarkdown,
    renderStreamingMarkdownUnits(source, options) {
      const model = markdownUtils.renderStreamingMarkdownUnits(source, options);
      models.push(model);
      return model;
    },
    shouldShowThinkingToggle,
    thinkingController: new ThinkingPanelController(),
  });

  for (let frame = 1; frame <= frameCount; frame += 1) {
    const end = Math.ceil(body.length * frame / frameCount);
    renderer.renderThinkingWidget({
      id: 'reasoning_cost_message',
      role: 'assistant',
      status: 'streaming',
      reasoning: {
        source: 'provider',
        status: 'streaming',
        entries: [{ id: 'reasoning_cost_entry', thinkingId: 'reasoning_cost_phase', text: body.slice(0, end) }],
      },
    }, 'reasoning_cost_message');
  }

  const incrementalCount = models.filter((model) => model.renderMode === 'incremental').length;
  const incrementalRate = incrementalCount / models.length;
  const fallbackDistribution = Object.fromEntries(models.reduce((counts, model) => {
    const reason = model.fallbackReason || 'none';
    counts.set(reason, (counts.get(reason) || 0) + 1);
    return counts;
  }, new Map()));
  t.diagnostic(`reasoning renderPhase incremental rate: ${(incrementalRate * 100).toFixed(1)}% (${incrementalCount}/${models.length})`);
  t.diagnostic(`reasoning renderPhase fallback distribution: ${JSON.stringify(fallbackDistribution)}`);

  const finalModel = models[models.length - 1];
  const fullModel = markdownUtils.renderStreamingMarkdownUnits(body, { mermaid: 'plain' });
  assert.equal(finalModel.html, fullModel.html, 'final HTML matches a from-scratch full render');
  assert.deepEqual(
    comparableUnits(finalModel.units),
    comparableUnits(fullModel.units),
    'final units match a from-scratch full render',
  );
  assert.ok(incrementalRate >= 0.5, `expected at least 50% incremental frames, observed ${(incrementalRate * 100).toFixed(1)}%`);
});
