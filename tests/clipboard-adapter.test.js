'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createClipboardAdapter } = require('../services/main/clipboard-adapter');

class FakeClipboardItem {
  constructor(items) {
    this.items = items;
  }
}

function fakeClipboard(calls) {
  return {
    writeText: async (text) => { calls.push(['writeText', text]); },
    write: async (items) => { calls.push(['write', items]); },
  };
}

test('writeText passes the text to the Electron 44+ promise API', async () => {
  const calls = [];
  const adapter = createClipboardAdapter({ clipboard: fakeClipboard(calls), ClipboardItem: FakeClipboardItem });
  await adapter.writeText('hello');
  assert.deepEqual(calls, [['writeText', 'hello']]);
});

test('writeImage writes one image/png ClipboardItem holding the PNG bytes', async () => {
  const calls = [];
  const adapter = createClipboardAdapter({ clipboard: fakeClipboard(calls), ClipboardItem: FakeClipboardItem });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await adapter.writeImage({ toPNG: () => png });

  assert.equal(calls.length, 1);
  const [method, items] = calls[0];
  assert.equal(method, 'write');
  assert.equal(items.length, 1);
  assert.ok(items[0] instanceof FakeClipboardItem);
  assert.deepEqual(Object.keys(items[0].items), ['image/png']);
  const blob = items[0].items['image/png'];
  assert.equal(blob.type, 'image/png');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png);
});
