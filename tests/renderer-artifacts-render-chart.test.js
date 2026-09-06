'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { renderChartArtifactKind } = require('../renderer/features/renderer-artifacts-render-chart.js');
const projection = require('../renderer/features/renderer-artifacts-projection.js');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function makeCtx(t, { content } = {}) {
  const dom = new JSDOM('<body></body>');
  const doc = dom.window.document;
  const previousDocument = globalThis.document;
  globalThis.document = doc;
  t.after(() => { globalThis.document = previousDocument; });
  const el = () => {
    const node = doc.createElement('div');
    doc.body.appendChild(node);
    return node;
  };
  const surface = { key: 'full', previewContent: el(), editorShell: el(), detailNote: el() };
  const deps = {
    state: { artifacts: { loading: false, lastError: '' } },
    escapeHtml,
    prettyPrintJson: projection.prettyPrintJson,
    setDetailNote: (s, text, isError) => {
      s.detailNote.textContent = text;
      s.detailNote.classList.toggle('detail-note-error', Boolean(isError));
    },
    getPreferredEditorValue: () => content,
  };
  return { ctx: { surface, artifact: { id: 'chart-1' }, file: null, editable: false, deps }, surface };
}

test('chart stub shows the JSON spec when no runtime is installed', (t) => {
  const { ctx, surface } = makeCtx(t, { content: '{"mark":"bar","data":{"values":[1,2]}}' });
  assert.equal(globalThis.jennyChartRuntime, undefined);
  renderChartArtifactKind(ctx);
  const html = surface.previewContent.innerHTML;
  assert.ok(html.includes('extension point'), html);
  assert.ok(surface.previewContent.textContent.includes('"mark"'), `spec not shown: ${html}`);
  assert.ok(surface.detailNote.textContent.includes('No chart runtime'), surface.detailNote.textContent);
});

test('chart stub delegates to window.jennyChartRuntime when installed', (t) => {
  const calls = [];
  const previousRuntime = globalThis.jennyChartRuntime;
  globalThis.jennyChartRuntime = { render: (args) => calls.push(args) };
  t.after(() => { globalThis.jennyChartRuntime = previousRuntime; });

  const { ctx, surface } = makeCtx(t, { content: '{"mark":"line"}' });
  renderChartArtifactKind(ctx);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].spec, { mark: 'line' });
  assert.ok(calls[0].host, 'runtime should receive the host node');
  assert.ok(surface.previewContent.innerHTML.includes('artifact-preview-chart-host'), surface.previewContent.innerHTML);
});

test('chart stub falls back to the spec view when the runtime throws', (t) => {
  const previousRuntime = globalThis.jennyChartRuntime;
  globalThis.jennyChartRuntime = { render: () => { throw new Error('runtime exploded'); } };
  t.after(() => { globalThis.jennyChartRuntime = previousRuntime; });

  const { ctx, surface } = makeCtx(t, { content: '{"mark":"area"}' });
  assert.doesNotThrow(() => renderChartArtifactKind(ctx));
  assert.ok(surface.previewContent.innerHTML.includes('extension point'), surface.previewContent.innerHTML);
});

test('chart runtime keeps the panel pending until asynchronous success settles', async (t) => {
  const gate = deferred();
  const previousRuntime = globalThis.jennyChartRuntime;
  globalThis.jennyChartRuntime = { render: () => gate.promise };
  t.after(() => { globalThis.jennyChartRuntime = previousRuntime; });

  const { ctx, surface } = makeCtx(t, { content: '{"mark":"point"}' });
  const renderPromise = renderChartArtifactKind(ctx);
  assert.match(surface.detailNote.textContent, /Rendering chart/);
  gate.resolve();
  await renderPromise;
  assert.match(surface.detailNote.textContent, /Chart rendered/);
});

test('chart runtime routes asynchronous rejection through the spec fallback', async (t) => {
  const previousRuntime = globalThis.jennyChartRuntime;
  globalThis.jennyChartRuntime = {
    render: () => ({ then: (_resolve, reject) => reject(new Error('async boom')) }),
  };
  t.after(() => { globalThis.jennyChartRuntime = previousRuntime; });

  const { ctx, surface } = makeCtx(t, { content: '{"mark":"area"}' });
  await renderChartArtifactKind(ctx);
  assert.match(surface.detailNote.textContent, /showing the JSON spec/i);
  assert.match(surface.previewContent.textContent, /extension point/);
});

test('chart runtime settlement does not update a replaced host', async (t) => {
  const gate = deferred();
  const previousRuntime = globalThis.jennyChartRuntime;
  globalThis.jennyChartRuntime = { render: () => gate.promise };
  t.after(() => { globalThis.jennyChartRuntime = previousRuntime; });

  const { ctx, surface } = makeCtx(t, { content: '{"mark":"line"}' });
  const renderPromise = renderChartArtifactKind(ctx);
  surface.previewContent.innerHTML = '<div data-replacement>new target</div>';
  gate.resolve();
  await renderPromise;
  assert.doesNotMatch(surface.detailNote.textContent, /Chart rendered/);
  assert.ok(surface.previewContent.querySelector('[data-replacement]'));
});

test('chart stub handles unparseable JSON by showing the raw source', (t) => {
  const { ctx, surface } = makeCtx(t, { content: 'not json {' });
  renderChartArtifactKind(ctx);
  assert.ok(surface.detailNote.textContent.includes('could not be parsed'), surface.detailNote.textContent);
  assert.ok(surface.previewContent.innerHTML.includes('not json {'), surface.previewContent.innerHTML);
});
