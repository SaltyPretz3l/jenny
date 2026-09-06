'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  sha256Hex,
  isValidDigest,
  contentPath,
  putContent,
  getContent,
  hasContent,
  listContentDigests,
  removeContent,
} = require('../../../services/plugins/store/content-store');

test('isValidDigest accepts a lowercase 64-hex string and rejects anything else', () => {
  assert.equal(isValidDigest('a'.repeat(64)), true);
  assert.equal(isValidDigest('A'.repeat(64)), false);
  assert.equal(isValidDigest('a'.repeat(63)), false);
  assert.equal(isValidDigest(123), false);
});

test('putContent stores bytes under their own sha256 address', async () => {
  const facade = createMemoryFsFacade();
  const result = await putContent(facade, 'plugins', 'hello world');
  assert.equal(result.ok, true);
  assert.equal(result.digest, sha256Hex('hello world'));
  assert.equal(result.alreadyExisted, false);
});

test('putContent removes its temp file when publication fails', async () => {
  const facade = createMemoryFsFacade();
  const error = Object.assign(new Error('rename blocked'), { code: 'EACCES' });
  facade.renameFile = async () => { throw error; };

  await assert.rejects(() => putContent(facade, 'plugins', 'bytes'), (caught) => caught === error);

  const digest = sha256Hex('bytes');
  assert.deepEqual(await facade.list(`plugins/packages/${digest}`), []);
});

test('putContent preserves arbitrary binary archive bytes exactly', async () => {
  const facade = createMemoryFsFacade();
  const archiveBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80]);
  const put = await putContent(facade, 'plugins', archiveBytes);
  const get = await getContent(facade, 'plugins', put.digest);
  assert.equal(put.ok, true);
  assert.equal(get.ok, true);
  assert.equal(Buffer.isBuffer(get.bytes), true);
  assert.deepEqual(get.bytes, archiveBytes);
  assert.equal(put.digest, sha256Hex(archiveBytes));
});

test('putContent with identical bytes to an existing address is a safe no-op (alreadyExisted:true)', async () => {
  const facade = createMemoryFsFacade();
  const first = await putContent(facade, 'plugins', 'hello world');
  const second = await putContent(facade, 'plugins', 'hello world');
  assert.equal(second.ok, true);
  assert.equal(second.alreadyExisted, true);
  assert.equal(second.digest, first.digest);
});

test('putContent detects existing bytes at an address that no longer hash to that address (fail closed, never overwrites)', async () => {
  const facade = createMemoryFsFacade();
  const first = await putContent(facade, 'plugins', 'hello world');
  await facade.writeFile(contentPath('plugins', first.digest), 'tampered bytes');
  const result = await putContent(facade, 'plugins', 'hello world');
  assert.deepEqual(result, { ok: false, reason: 'existing_content_corrupted', digest: first.digest });
});

test('getContent verifies the actual bytes still hash to the requested digest', async () => {
  const facade = createMemoryFsFacade();
  const put = await putContent(facade, 'plugins', 'hello world');
  const get = await getContent(facade, 'plugins', put.digest);
  assert.equal(get.ok, true);
  assert.deepEqual(get.bytes, Buffer.from('hello world', 'utf8'));
});

test('getContent rejects a tampered blob as digest_mismatch instead of serving unverified bytes', async () => {
  const facade = createMemoryFsFacade();
  const put = await putContent(facade, 'plugins', 'hello world');
  await facade.writeFile(contentPath('plugins', put.digest), 'tampered bytes');
  const get = await getContent(facade, 'plugins', put.digest);
  assert.deepEqual(get, { ok: false, reason: 'digest_mismatch' });
});

test('getContent reports content_not_found for an address with nothing stored', async () => {
  const facade = createMemoryFsFacade();
  const get = await getContent(facade, 'plugins', 'a'.repeat(64));
  assert.deepEqual(get, { ok: false, reason: 'content_not_found' });
});

test('getContent rejects a malformed digest before touching the facade', async () => {
  const facade = createMemoryFsFacade();
  const get = await getContent(facade, 'plugins', 'not-a-digest');
  assert.deepEqual(get, { ok: false, reason: 'invalid_digest' });
});

test('hasContent is a cheap existence probe that does not require digest verification', async () => {
  const facade = createMemoryFsFacade();
  const put = await putContent(facade, 'plugins', 'hello world');
  assert.equal(await hasContent(facade, 'plugins', put.digest), true);
  assert.equal(await hasContent(facade, 'plugins', 'a'.repeat(64)), false);
});

test('listContentDigests returns every stored digest and removeContent deletes one', async () => {
  const facade = createMemoryFsFacade();
  const a = await putContent(facade, 'plugins', 'alpha');
  const b = await putContent(facade, 'plugins', 'beta');
  const digests = await listContentDigests(facade, 'plugins');
  assert.deepEqual(digests.slice().sort(), [a.digest, b.digest].sort());
  await removeContent(facade, 'plugins', a.digest);
  assert.equal(await hasContent(facade, 'plugins', a.digest), false);
  assert.equal(await hasContent(facade, 'plugins', b.digest), true);
});
