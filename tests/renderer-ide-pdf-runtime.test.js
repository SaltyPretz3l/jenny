'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createPdfjsLoader, createQuietL10n, decodeBase64, encodeBase64,
} = require('../renderer/features/renderer-ide-pdf-runtime');

test('the PDF viewer imports only after its core global is ready, and concurrent loads share work', async () => {
  const imports = [];
  const core = { GlobalWorkerOptions: {} };
  let resolveCore;
  const pendingCore = new Promise(resolve => { resolveCore = resolve; });
  const load = createPdfjsLoader({
    resolveUrl: value => `file:///app/${value}`,
    importModule: url => {
      imports.push(url);
      return url.endsWith('/pdf.mjs') ? pendingCore : Promise.resolve({ PDFViewer: 'viewer' });
    },
  });
  const first = load();
  const second = load();
  assert.equal(first, second);
  assert.deepEqual(imports, ['file:///app/node_modules/pdfjs-dist/build/pdf.mjs']);
  resolveCore(core);
  const result = await first;
  assert.equal(result.pdfjs, core);
  assert.equal(result.viewer.PDFViewer, 'viewer');
  assert.equal(imports.length, 2);
  assert.equal(core.GlobalWorkerOptions.workerSrc, 'file:///app/node_modules/pdfjs-dist/build/pdf.worker.mjs');
  assert.equal(await load(), result);
});

test('a transient core import failure allows the PDF loader to retry', async () => {
  let calls = 0;
  const load = createPdfjsLoader({
    resolveUrl: value => value,
    importModule: async url => {
      if (++calls === 1) throw new Error('temporary load failure');
      return url.endsWith('/pdf.mjs') ? { GlobalWorkerOptions: {} } : { PDFViewer: 'viewer' };
    },
  });
  await assert.rejects(load(), /temporary load failure/);
  assert.equal((await load()).viewer.PDFViewer, 'viewer');
});

test('the base64 codecs round-trip bytes across chunk boundaries', () => {
  const bytes = new Uint8Array(0x8000 * 2 + 7).map((_value, index) => (index * 31) & 0xff);
  const encoded = encodeBase64(bytes);
  assert.equal(encoded, Buffer.from(bytes).toString('base64'));
  assert.deepEqual(decodeBase64(encoded), bytes);
  assert.equal(decodeBase64('').length, 0);
  assert.throws(() => decodeBase64('not*base64'));
});

test('the quiet l10n answers with the fallback text and never translates', async () => {
  const l10n = createQuietL10n();
  assert.equal(await l10n.get('pdfjs-id', null, 'Fallback'), 'Fallback');
  assert.equal(await l10n.get('pdfjs-id'), 'pdfjs-id');
  assert.equal(l10n.getDirection(), 'ltr');
});
