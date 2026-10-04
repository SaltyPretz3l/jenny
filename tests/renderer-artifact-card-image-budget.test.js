'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const cards = require('../renderer/chat/renderer-artifact-card-utils');

const BUDGET = 48 * 1024 * 1024;
const SMALL_IMAGE = 'data:image/png;base64,YQ==';

function dataUrl(chars) {
  const prefix = 'data:image/png;base64,';
  return prefix + 'A'.repeat(chars - prefix.length);
}

// Keep full fake payloads out of a DOM parser. The loader only needs these
// image/figure operations; rendering itself still uses the real figure module.
function loader(t, read) {
  const previousDocument = globalThis.document;
  const previousShell = globalThis.jennyShell;
  const nodes = new Map();
  const reads = [];
  let probe = false;
  cards.resetArtifactImageLoaderForTests();
  globalThis.document = { querySelectorAll: () => nodes.values() };
  globalThis.jennyShell = { artifacts: { read: (sessionId, id) => {
    reads.push(id);
    return probe ? new Promise(() => {}) : read(id, sessionId);
  } } };
  t.after(() => {
    cards.resetArtifactImageLoaderForTests();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousShell === undefined) delete globalThis.jennyShell;
    else globalThis.jennyShell = previousShell;
  });
  function render(id) {
    const attrs = new Map([['data-inv-artifact-image-key', `session:${id}`]]);
    const states = new Map();
    const node = {
      getAttribute: (name) => attrs.get(name),
      setAttribute: (name, value) => attrs.set(name, value),
      closest: () => ({
        setAttribute: (name, value) => states.set(name, value),
        removeAttribute: (name) => states.delete(name),
      }),
      attrs, states,
    };
    nodes.set(id, node);
    cards.renderArtifactCards([{ artifact_id: id, session_id: 'session',
      artifact_kind: 'image', file_name: `${id}.png`, mime_type: 'image/png' }], 'call');
    return node;
  }
  return { render, reads, probe: () => { probe = true; } };
}

// Promise settlement schedules hydration on a zero-delay timer.
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test('30 large images retain at most 24 entries and 48 MiB of characters', async (t) => {
  const src = dataUrl(4 * 1024 * 1024);
  const h = loader(t, () => ({ asset_data_url: src }));
  const ids = Array.from({ length: 30 }, (_, i) => `large-${i}`);
  for (const id of ids) { h.render(id); await settle(); }
  h.probe();
  const retained = ids.filter((id) => {
    const before = h.reads.length;
    h.render(id);
    return h.reads.length === before;
  });
  await settle();
  assert.ok(retained.length <= 24, 'retained image count exceeds 24');
  assert.ok(retained.length * src.length <= BUDGET, 'retained image characters exceed 48 MiB');
  assert.deepEqual(retained, ids.slice(18), 'retain the newest images within the character budget');
});

for (const chars of [SMALL_IMAGE.length, BUDGET / 2]) {
  test(`cache hits refresh LRU order at payload size ${chars}`, async (t) => {
    const capacity = Math.min(24, Math.floor(BUDGET / chars));
    const h = loader(t, () => ({ assetDataUrl: dataUrl(chars) }));
    for (let i = 0; i < capacity; i++) { h.render(`lru-${i}`); await settle(); }
    h.render('lru-0'); await settle();
    assert.equal(h.reads.length, capacity, 'cache hit must not read again');
    h.render('newest'); await settle();
    h.probe();
    h.render('lru-0');
    assert.equal(h.reads.length, capacity + 1, 'recently touched image must survive eviction');
    h.render('lru-1');
    assert.equal(h.reads.length, capacity + 2, 'least recently used image must be evicted');
    await settle();
  });
}

test('an oversize image hydrates the current render without retention or displacing cached images', async (t) => {
  const src = dataUrl(BUDGET + 1);
  const h = loader(t, (id) => ({ asset_data_url: id === 'huge' ? src : SMALL_IMAGE }));
  h.render('small'); await settle();
  const node = h.render('huge'); await settle();
  assert.ok(node.attrs.get('src') === src, 'oversize image must still hydrate');
  h.probe();
  h.render('small');
  assert.equal(h.reads.length, 2, 'oversize image must not displace a retained image');
  h.render('huge');
  assert.equal(h.reads.length, 3, 'oversize image must be read again');
  await settle();
});

test('a burst exceeding the byte budget still hydrates every current image', async (t) => {
  const src = dataUrl(BUDGET / 2);
  const h = loader(t, () => ({ asset_data_url: src }));
  const nodes = [h.render('burst-1'), h.render('burst-2'), h.render('burst-3')];
  await settle();
  for (const node of nodes) assert.ok(node.attrs.get('src') === src, 'burst image must hydrate');
});

for (const rejected of [false, true]) {
  test(`300 ${rejected ? 'rejected reads' : 'invalid payloads'} retain only the newest 256 failures`, async (t) => {
    const h = loader(t, () => rejected ? Promise.reject(new Error('transient')) : {});
    const ids = Array.from({ length: 300 }, (_, i) => `failure-${i}`);
    for (const id of ids) h.render(id);
    await settle();
    h.probe();
    const suppressed = ids.filter((id) => {
      const before = h.reads.length;
      h.render(id);
      return h.reads.length === before;
    });
    await settle();
    assert.ok(suppressed.length <= 256, 'retained failure count exceeds 256');
    assert.deepEqual(suppressed, ids.slice(44), 'oldest failure metadata must be dropped');
  });
}

test('invalid-payload failure expires after five minutes and retries successfully', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let fail = true;
  const h = loader(t, () => fail ? {} : { asset_data_url: SMALL_IMAGE });
  h.render('retry'); await settle();
  now += 5 * 60 * 1000 - 1;
  h.render('retry'); await settle();
  assert.equal(h.reads.length, 1, 'unexpired invalid payload must stay suppressed');
  now += 1;
  fail = false;
  const node = h.render('retry'); await settle();
  assert.equal(h.reads.length, 2, 'expired failure must retry');
  assert.equal(node.attrs.get('src'), SMALL_IMAGE);
  assert.equal(node.states.has('data-inv-artifact-image-state'), false);
});

test('release clears retained images and failure metadata', async (t) => {
  const h = loader(t, (id) => id === 'failed' ? {} : { asset_data_url: SMALL_IMAGE });
  h.render('cached'); h.render('failed'); await settle();
  cards.releaseInlineImages();
  h.probe();
  h.render('cached'); h.render('failed'); await settle();
  assert.deepEqual(h.reads, ['cached', 'failed', 'cached', 'failed']);
});

test('release discards stale reads without clearing a new pending read for the same image', async (t) => {
  const completions = [];
  const h = loader(t, () => new Promise((resolve) => completions.push(resolve)));
  h.render('pending');
  cards.releaseInlineImages();
  const node = h.render('pending');
  completions[0]({ asset_data_url: SMALL_IMAGE }); await settle();
  assert.equal(node.attrs.has('src'), false, 'released read must not hydrate the next session');
  h.render('pending');
  assert.equal(h.reads.length, 2, 'stale completion must not clear the new pending read');
  completions[1]({ asset_data_url: SMALL_IMAGE }); await settle();
  h.render('pending'); await settle();
  assert.equal(h.reads.length, 2);
});
