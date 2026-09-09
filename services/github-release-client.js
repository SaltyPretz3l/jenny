'use strict';

const semver = require('semver');

const RELEASES_URL = 'https://github.com/SaltyPretz3l/jenny/releases';
const LATEST_API_URL = 'https://api.github.com/repos/SaltyPretz3l/jenny/releases/latest';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_NOTES_LENGTH = 65536;

function releaseError(code) {
  return Object.assign(new Error(code), { code });
}

function stableVersion(value) {
  if (typeof value !== 'string' || value.length > 128) return '';
  const version = value.replace(/^v/, '');
  return semver.valid(version) && !semver.prerelease(version) ? version : '';
}

function packageNames(platform, arch) {
  if (platform === 'win32' && arch === 'x64') return ['Jenny-Setup-x64.exe'];
  if (platform === 'darwin' && arch === 'arm64') return ['Jenny-arm64.dmg'];
  if (platform === 'linux' && arch === 'x64') return ['Jenny-x86_64.AppImage', 'Jenny-amd64.deb'];
  return [];
}

function normalizeRelease(payload, { platform, arch }) {
  const version = stableVersion(payload?.tag_name);
  if (!version || payload.draft !== false || payload.prerelease !== false
    || !Array.isArray(payload.assets) || payload.assets.length > 128
    || !Number.isFinite(Date.parse(payload.published_at))) {
    throw releaseError('invalid-metadata');
  }
  const expected = packageNames(platform, arch);
  const base = RELEASES_URL + '/download/' + encodeURIComponent(payload.tag_name) + '/';
  const packageAvailable = payload.assets.some((asset) => asset
    && expected.includes(asset.name)
    && Number.isSafeInteger(asset.size) && asset.size > 0
    && asset.state === 'uploaded'
    && asset.browser_download_url === base + encodeURIComponent(asset.name));
  return {
    latestVersion: version,
    releaseName: typeof payload.name === 'string' ? payload.name.slice(0, 256) : '',
    releaseDate: new Date(payload.published_at).toISOString(),
    releaseNotesMarkdown: typeof payload.body === 'string' ? payload.body.slice(0, MAX_NOTES_LENGTH) : '',
    releaseUrl: RELEASES_URL,
    packageAvailable,
  };
}

async function readBoundedBody(response, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw releaseError('response-too-large');
  }
  if (!response.body) throw releaseError('invalid-metadata');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw releaseError('response-too-large');
      chunks.push(Buffer.from(value));
    }
    if (signal.aborted) throw releaseError('cancelled');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}

// The deadline covers headers AND the streamed body, including a stalled peer.
// Fixed destination + rejected redirects prevents forwarding credentials or
// following remote metadata into another service. There are no retries.
function createGitHubReleaseClient({ fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  return async function checkRelease({ platform, arch, signal } = {}) {
    const controller = new AbortController();
    let timer;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const cancel = () => {
      controller.abort();
      rejectAbort(releaseError('cancelled'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(releaseError('timeout'));
      }, timeoutMs);
    });
    const request = async () => {
      if (signal?.aborted) throw releaseError('cancelled');
      const response = await fetchImpl(LATEST_API_URL, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Jenny-update-check' },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 404) { void response.body?.cancel().catch(() => {}); return null; }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw releaseError([403, 429].includes(response.status) ? 'rate-limited' : 'network');
      }
      return normalizeRelease(await readBoundedBody(response, controller.signal), { platform, arch });
    };
    try {
      return await Promise.race([request(), deadline, aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  };
}

module.exports = { createGitHubReleaseClient, RELEASES_URL, stableVersion, MAX_NOTES_LENGTH };
