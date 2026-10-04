'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatgptModelCatalogService, normalizeCatalog, CATALOG_URL,
  MAX_RESPONSE_BYTES } = require('../services/backend/chatgpt-model-catalog-service');

function row(overrides = {}) {
  return { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list',
    context_window: 1050000, input_modalities: ['text', 'image'],
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'max' },
      { effort: 'ultra' }], default_reasoning_level: 'medium', ...overrides };
}
function response(models = [row()]) { return new Response(JSON.stringify({ models })); }
function fixture(t, options = {}) {
  let clock = 1000;
  let account = 'account-a';
  let epoch = 1;
  let authority = { generation_id: 'gen-a', commit_epoch: 1 };
  let credential = true;
  let statusCallback;
  let calls = 0;
  const requests = [];
  const logs = [];
  const service = createChatgptModelCatalogService({
    authService: { hasCredential: () => credential, getAccountId: () => account,
      getCredentialEpoch: () => epoch, getAccessToken: async () => 'fixture-token',
      onStatusChange(callback) { statusCallback = callback; return () => { statusCallback = null; }; } },
    getAuthority: () => authority,
    now: () => clock, ttlMs: 100, backoffMs: 50,
    fetchImpl: async (url, request) => {
      calls += 1; requests.push({ url, request });
      return options.fetchImpl ? options.fetchImpl(url, request) : response();
    },
    log: (event, data) => logs.push({ event, data }),
    ...options.serviceOptions,
  });
  t.after(() => service.dispose());
  return { service, requests, logs, calls: () => calls,
    advance: (ms) => { clock += ms; }, changeAccount: () => { account = 'account-b'; epoch += 1; },
    revoke: () => { authority = null; }, changeGeneration: () => { authority = { generation_id: 'gen-b', commit_epoch: 2 }; },
    signOut: () => { credential = false; epoch += 1; statusCallback?.(); } };
}

test('discovery uses the fixed authenticated endpoint and publishes metadata only', async (t) => {
  const f = fixture(t, { fetchImpl: async () => response([row({ instructions: 'untrusted prompt' }),
    row({ slug: 'hidden-model', visibility: 'hide' })]) });
  const result = await f.service.refresh();
  assert.equal(result.stale, false);
  assert.deepEqual(result.models, [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol',
    context_length: 272000, reasoning_efforts: ['low', 'medium', 'max'],
    default_reasoning_effort: 'medium', vision: true }]);
  assert.equal(f.requests[0].url, CATALOG_URL);
  assert.equal(f.requests[0].request.redirect, 'error');
  assert.equal(f.requests[0].request.headers.Authorization, 'Bearer fixture-token');
  assert.equal(f.requests[0].request.headers['ChatGPT-Account-ID'], 'account-a');
  assert.doesNotMatch(JSON.stringify([result, f.logs]), /fixture-token|account-a|untrusted prompt/);
  result.models[0].id = 'mutated';
  assert.equal(f.service.snapshot().models[0].id, 'gpt-6.1-sol');
});

test('concurrent reads share one request, reuse fresh results, and refresh at expiry', async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, { fetchImpl: () => pending });
  const first = f.service.refresh();
  const second = f.service.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls(), 1);
  release(response());
  await Promise.all([first, second]);
  await f.service.refresh();
  assert.equal(f.calls(), 1);
  f.advance(100);
  await f.service.refresh();
  assert.equal(f.calls(), 2);
});

test('a failed refresh retains the same-account catalog and applies failure backoff', async (t) => {
  let fail = false;
  const f = fixture(t, { fetchImpl: async () => {
    if (fail) throw new Error('Bearer fixture-token account-a');
    return response();
  } });
  await f.service.refresh();
  fail = true; f.advance(100);
  const stale = await f.service.refresh();
  assert.equal(stale.stale, true);
  assert.equal(stale.models[0].id, 'gpt-6.1-sol');
  await f.service.refresh();
  assert.equal(f.calls(), 2);
  assert.doesNotMatch(JSON.stringify(f.logs), /fixture-token|account-a/);
  f.advance(50);
  await f.service.refresh();
  assert.equal(f.calls(), 3);
});

for (const failure of ['invalid_json', 'empty', 'duplicate', 'oversized_header', 'oversized_body', 'redirect', 'http']) {
  test(`invalid discovery (${failure}) returns the static fallback`, async (t) => {
    const f = fixture(t, { fetchImpl: async () => {
      if (failure === 'invalid_json') return new Response('{');
      if (failure === 'empty') return response([]);
      if (failure === 'duplicate') return response([row(), row()]);
      if (failure === 'oversized_header') return new Response('{}', {
        headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } });
      if (failure === 'oversized_body') return new Response(' '.repeat(MAX_RESPONSE_BYTES + 1));
      if (failure === 'redirect') return new Response(null, { status: 302 });
      return new Response('{}', { status: 503 });
    } });
    const result = await f.service.refresh();
    assert.equal(result.models, null);
    assert.equal(result.stale, true);
    assert.equal(result.source, 'chatgpt_static_catalog');
  });
}

for (const transition of ['changeAccount', 'changeGeneration', 'revoke', 'signOut']) {
  test(`${transition} discards a late response and the previous catalog`, async (t) => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const f = fixture(t, { fetchImpl: () => pending });
    const read = f.service.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    f[transition]();
    f.service.snapshot();
    release(response());
    assert.equal((await read).models, null);
    assert.equal(f.service.snapshot().models, null);
  });
}

test('signed-out or disabled providers make no discovery requests', async (t) => {
  const f = fixture(t);
  f.revoke();
  assert.equal((await f.service.refresh()).models, null);
  f.signOut();
  await f.service.refresh();
  assert.equal(f.calls(), 0);
});

test('deadline bounds both an uncooperative fetch and a stalled response body', async (t) => {
  for (const body of [false, true]) {
    const f = fixture(t, { serviceOptions: { timeoutMs: 15 }, fetchImpl: () => body
      ? new Response(new ReadableStream({ pull: () => new Promise(() => {}) }))
      : new Promise(() => {}) });
    assert.equal((await f.service.refresh()).models, null);
    assert.equal(f.service.snapshot().stale, true);
  }
});

test('normalizer rejects oversized lists, invalid identifiers, and unsafe labels', () => {
  for (const models of [Array.from({ length: 129 }, () => row()), [row({ slug: '../bad' })],
    [row({ display_name: '\u202eHidden' })], [row({ context_window: -1 })]]) {
    assert.throws(() => normalizeCatalog({ models }));
  }
});


test('a rejected access token is refreshed once within the same discovery deadline', async (t) => {
  const force = [];
  let attempts = 0;
  const f = fixture(t, { serviceOptions: { authService: {
    hasCredential: () => true, getAccountId: () => 'account-a', getCredentialEpoch: () => 1,
    getAccessToken: async (options) => { force.push(options?.force === true); return 'fixture-token'; },
  } }, fetchImpl: async () => { attempts += 1; return attempts === 1
    ? new Response('{}', { status: 401 }) : response(); } });
  assert.equal((await f.service.refresh()).models[0].id, 'gpt-6.1-sol');
  assert.deepEqual(force, [false, true]);
  assert.equal(attempts, 2);
});
