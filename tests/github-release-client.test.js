'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHubReleaseClient, RELEASES_URL } = require('../services/github-release-client');

function release(overrides = {}) {
  return { tag_name: 'v1.0.2', draft: false, prerelease: false, name: 'Jenny',
    published_at: '2026-09-09T00:00:00Z', body: 'Release notes',
    assets: [{ name: 'Jenny-Setup-x64.exe', size: 120, state: 'uploaded',
      browser_download_url: RELEASES_URL + '/download/v1.0.2/Jenny-Setup-x64.exe' }],
    ...overrides };
}
const target = { platform: 'win32', arch: 'x64' };
function clientFor(value) {
  return createGitHubReleaseClient({ fetchImpl: async () => new Response(JSON.stringify(value)) });
}

test('fixed, unauthenticated GitHub request validates stable release and platform package', async () => {
  let calls = 0;
  const client = createGitHubReleaseClient({ fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.github.com/repos/SaltyPretz3l/jenny/releases/latest');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers['x-user-staging-id'], undefined);
    return new Response(JSON.stringify(release()));
  } });
  assert.equal(calls, 0);
  const result = await client(target);
  assert.equal(calls, 1);
  assert.equal(result.latestVersion, '1.0.2');
  assert.equal(result.packageAvailable, true);
  assert.equal(result.releaseUrl, RELEASES_URL);
});

test('missing or untrusted assets never claim an installable package', async () => {
  for (const assets of [[], [{ name: 'Jenny-Setup-x64.exe', size: 3, state: 'uploaded',
    browser_download_url: 'https://evil.invalid/payload.exe' }]]) {
    assert.equal((await clientFor(release({ assets }))(target)).packageAvailable, false);
  }
  assert.equal((await clientFor(release())({ platform: 'darwin', arch: 'arm64' })).packageAvailable, false);
});

test('malformed, draft and prerelease metadata fail closed', async () => {
  for (const change of [{ tag_name: 'main' }, { tag_name: 'v1.0.2-beta.1' },
    { draft: true }, { prerelease: true }, { published_at: 'bad' }, { assets: {} }]) {
    await assert.rejects(clientFor(release(change))(target), { code: 'invalid-metadata' });
  }
});

test('404 is no release; rate limits and network failures do not retry', async () => {
  for (const status of [404, 403, 429, 500]) {
    let calls = 0;
    const client = createGitHubReleaseClient({ fetchImpl: async () => {
      calls += 1; return new Response('', { status });
    } });
    if (status === 404) assert.equal(await client(target), null);
    else await assert.rejects(client(target), { code: status === 500 ? 'network' : 'rate-limited' });
    assert.equal(calls, 1);
  }
  await assert.rejects(createGitHubReleaseClient({ fetchImpl: async () => { throw new Error('offline'); } })(target));
});

test('body limit covers declared and streamed size', async () => {
  for (const headers of [{ 'content-length': '1048577' }, {}]) {
    const client = createGitHubReleaseClient({ fetchImpl: async () =>
      new Response('x'.repeat(1048577), { headers }) });
    await assert.rejects(client(target), { code: 'response-too-large' });
  }
  await assert.rejects(createGitHubReleaseClient({ fetchImpl: async () => new Response('{') })(target));
});

test('total deadline covers stalled headers and stalled body; abort cancels reads', async () => {
  for (const fetchImpl of [
    async () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    await assert.rejects(createGitHubReleaseClient({ fetchImpl, timeoutMs: 15 })(target), { code: 'timeout' });
  }
  const controller = new AbortController();
  let cancelled = false;
  const client = createGitHubReleaseClient({ fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  })) });
  const pending = client({ ...target, signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(cancelled, true);
});
