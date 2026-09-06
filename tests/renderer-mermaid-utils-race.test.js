const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

// Bounded: an unbounded `while (...) await setImmediate(...)` spins forever if
// the render path never enqueues, so a regression here surfaced as the runner's
// 120s per-file TIMEOUT instead of a failure naming what never happened.
async function spinUntil(predicate, label, maxTicks = 20000) {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`spinUntil gave up after ${maxTicks} ticks waiting for ${label}`);
}

test('direct Mermaid rendering keeps the newest render when an older request resolves last', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div>', {
    url: 'file:///app/index.html',
  });
  global.window = dom.window;
  global.document = dom.window.document;

  const pending = [];
  dom.window.mermaid = {
    initialize() {},
    render(_id, source) {
      return new Promise((resolve) => pending.push({ source, resolve }));
    },
  };

  delete require.cache[require.resolve('../renderer/features/renderer-mermaid-utils')];
  const mermaidUtils = require('../renderer/features/renderer-mermaid-utils');
  const host = dom.window.document.getElementById('host');
  const callbacks = [];

  const older = mermaidUtils.renderMermaidDirect(host, 'flowchart TD\nA[old]', {
    onSuccess() { callbacks.push('old'); },
  });
  await spinUntil(() => pending.length >= 1, 'the first mermaid render request');
  const newer = mermaidUtils.renderMermaidDirect(host, 'flowchart TD\nA[new]', {
    onSuccess() { callbacks.push('new'); },
  });

  await spinUntil(() => pending.length >= 2, 'the second mermaid render request');
  pending.find((entry) => entry.source.includes('[new]')).resolve({ svg: '<svg id="new"></svg>' });
  await newer;
  pending.find((entry) => entry.source.includes('[old]')).resolve({ svg: '<svg id="old"></svg>' });
  await older;

  assert.equal(host.querySelector('svg')?.id, 'new');
  assert.deepEqual(callbacks, ['new']);

  dom.window.close();
  delete global.window;
  delete global.document;
});
