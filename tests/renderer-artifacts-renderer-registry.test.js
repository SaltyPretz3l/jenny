'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  RENDER_KINDS,
  resolveArtifactRenderKind,
  createArtifactRendererRegistry,
  registerPluginRenderer,
  clearPluginRenderers,
} = require('../renderer/features/renderer-artifacts-renderer-registry');

const projection = require('../renderer/features/renderer-artifacts-projection');

function projectionPredicates(overrides = {}) {
  return {
    isGeneratedFile: projection.isGeneratedFile,
    isImageArtifact: projection.isImageArtifact,
    isMermaidGeneratedArtifact: projection.isMermaidGeneratedArtifact,
    isMarkdownGeneratedArtifact: projection.isMarkdownGeneratedArtifact,
    isHtmlGeneratedArtifact: projection.isHtmlGeneratedArtifact,
    isSvgGeneratedArtifact: projection.isSvgGeneratedArtifact,
    isChartGeneratedArtifact: projection.isChartGeneratedArtifact,
    extractMermaidSourceFromToolArtifact: projection.extractMermaidSourceFromToolArtifact,
    ...overrides,
  };
}

function generatedArtifact(file = {}) {
  return {
    artifactType: 'generated_file',
    generatedFile: { artifactId: 'a1', language: '', fileName: '', displayPath: '', ...file },
  };
}

/* ── kind resolution truth table ── */

test('RENDER_KINDS carries the eight shipped kinds', () => {
  assert.deepEqual(
    RENDER_KINDS,
    ['mermaid', 'chart', 'code', 'markdown', 'html', 'svg', 'image', 'text']
  );
});

test('resolveArtifactRenderKind truth table over projected artifact shapes', () => {
  const deps = projectionPredicates();
  const table = [
    [{ artifactType: 'image', image: {} }, 'image'],
    [generatedArtifact({ language: 'mermaid' }), 'mermaid'],
    [generatedArtifact({ fileName: 'diagram.mmd' }), 'mermaid'],
    [generatedArtifact({ language: 'markdown' }), 'markdown'],
    [generatedArtifact({ fileName: 'notes.md' }), 'markdown'],
    [generatedArtifact({ language: 'html' }), 'html'],
    [generatedArtifact({ fileName: 'page.html' }), 'html'],
    [generatedArtifact({ language: 'svg' }), 'svg'],
    [generatedArtifact({ fileName: 'icon.svg' }), 'svg'],
    [generatedArtifact({ language: 'chart' }), 'chart'],
    [generatedArtifact({ fileName: 'sales.vl.json' }), 'chart'],
    [generatedArtifact({ language: 'python', fileName: 'main.py' }), 'code'],
    [generatedArtifact({}), 'code'],
    [{ artifactType: 'tool_output', tool: { toolName: 'mermaid_generate' }, outputText: 'flowchart TD\nA-->B' }, 'mermaid'],
    [{ artifactType: 'tool_output', tool: { toolName: 'run_command' }, outputText: 'done' }, 'text'],
    [null, 'text'],
    [undefined, 'text'],
  ];
  for (const [artifact, expected] of table) {
    assert.equal(
      resolveArtifactRenderKind(artifact, deps),
      expected,
      `expected ${expected} for ${JSON.stringify(artifact && (artifact.generatedFile || artifact.artifactType))}`
    );
  }
});

test('resolveArtifactRenderKind prefers mermaid over markdown for a .mmd markdown-flagged edge', () => {
  // Mirrors the legacy dispatcher precedence: isMermaidGenerated wins, then markdown.
  const deps = projectionPredicates();
  const artifact = generatedArtifact({ language: 'mermaid', fileName: 'diagram.mmd' });
  artifact.generatedFile.isMarkdownDocument = true;
  assert.equal(resolveArtifactRenderKind(artifact, deps), 'mermaid');
});

test('resolveArtifactRenderKind tolerates missing predicate deps (falls back to text/code)', () => {
  assert.equal(resolveArtifactRenderKind({ artifactType: 'tool_output' }, {}), 'text');
  assert.equal(resolveArtifactRenderKind(generatedArtifact({}), {
    isGeneratedFile: projection.isGeneratedFile,
  }), 'code');
});

/* ── registry dispatch ── */

test('createArtifactRendererRegistry dispatches to builtin renderers with the ctx', () => {
  const calls = [];
  const registry = createArtifactRendererRegistry({
    mermaid: (ctx) => calls.push(['mermaid', ctx]),
    text: (ctx) => calls.push(['text', ctx]),
  });
  const ctx = { surface: { key: 'full' }, artifact: {}, file: null, editable: false, deps: {} };
  assert.equal(registry.has('mermaid'), true);
  assert.equal(registry.has('code'), false);
  assert.equal(registry.render('mermaid', ctx), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'mermaid');
  assert.equal(calls[0][1], ctx);
});

test('registry falls back to the text renderer for an unknown or unregistered kind', () => {
  const calls = [];
  const registry = createArtifactRendererRegistry({
    text: (ctx) => calls.push(ctx),
  });
  assert.equal(registry.render('chart', { artifact: {} }), true);
  assert.equal(registry.render('never-heard-of-it', { artifact: {} }), true);
  assert.equal(calls.length, 2);
});

test('registry.render returns false when no renderer and no text fallback exist', () => {
  const registry = createArtifactRendererRegistry({});
  assert.equal(registry.render('mermaid', {}), false);
});

test('register() adds a renderer post-construction (the chart extension point)', () => {
  const calls = [];
  const registry = createArtifactRendererRegistry({ text: () => calls.push('text') });
  assert.equal(registry.has('chart'), false);
  assert.equal(registry.register('chart', (ctx) => calls.push(['chart', ctx])), true);
  assert.equal(registry.has('chart'), true);
  registry.render('chart', { artifact: {} });
  assert.deepEqual(calls[0][0], 'chart');
});

test('register() rejects junk without throwing', () => {
  const registry = createArtifactRendererRegistry({});
  assert.equal(registry.register('', () => {}), false);
  assert.equal(registry.register('   ', () => {}), false);
  assert.equal(registry.register('chart', 'not-a-function'), false);
  assert.equal(registry.register(null, () => {}), false);
  assert.equal(registry.has('chart'), false);
});

test('kinds() lists shipped kinds plus registered extensions, without duplicates', () => {
  const registry = createArtifactRendererRegistry({ text: () => {} });
  registry.register('chart', () => {});
  registry.register('vega-custom', () => {});
  const kinds = registry.kinds();
  for (const kind of RENDER_KINDS) assert.ok(kinds.includes(kind), `missing shipped kind ${kind}`);
  assert.ok(kinds.includes('vega-custom'));
  assert.equal(new Set(kinds).size, kinds.length);
});

test('a renderer that throws is contained: render() returns false, does not throw', () => {
  const registry = createArtifactRendererRegistry({
    mermaid: () => { throw new Error('renderer exploded'); },
    text: () => { throw new Error('fallback exploded'); },
  });
  let result;
  assert.doesNotThrow(() => { result = registry.render('mermaid', {}); });
  assert.equal(result, false);
});

test('namespaced plugin renderers cannot override built-ins and fall back to standard text', () => {
  clearPluginRenderers();
  const calls = [];
  assert.equal(registerPluginRenderer('sample:diagram', () => { throw new Error('isolated failure'); }), true);
  assert.equal(registerPluginRenderer('html', () => {}), false);
  assert.equal(registerPluginRenderer('bad namespace:kind', () => {}), false);
  const registry = createArtifactRendererRegistry({ text: () => calls.push('text') });
  assert.equal(resolveArtifactRenderKind({ artifactKind: 'sample:diagram' }), 'sample:diagram');
  assert.equal(registry.render('sample:diagram', {}), true);
  assert.deepEqual(calls, ['text']);
  clearPluginRenderers();
});
