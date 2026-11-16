'use strict';

// "Fetch title" for a link card (plan PROJECT_BOARD_2026-11-13, section 6.1). Main process only: it runs on the
// owner's own machine, on a button press, and gives back one thing, the page's title.
//
//   fetchLinkTitle({ url }) -> { ok: true, title } | { ok: false, reason }
//   reason: 'invalid' (not an http or https address) | 'refused' (the URL guard) | 'timeout' | 'not_html' |
//           'no_title' | 'too_large' | 'failed'. It never rejects. (`disabled`, the flag being off, is the IPC layer's.)
//
// Every hop (the address, then each redirect, at most 3) goes through services/browser-use/url-guard.js: the guard
// classifies the address, the host is resolved here, and every resolved address must be public. The connection is then
// pinned to the address that was checked (`init.address`; see pinnedFetch), so a resolver that answers differently the
// second time changes nothing. No cookies, no credentials, no referrer, a fixed plain User-Agent. 8 seconds for the
// whole call, 256 KiB of a text/html or application/xhtml+xml body, and only the cleaned title leaves. Nothing about the
// address, the page or the title is logged here.
//
// `fetch` and `lookup` are injected so the tests never touch a network. An injected fetch is called as
// fetch(url, { method, headers, redirect: 'manual', credentials, referrerPolicy, signal, address, family }) and returns
// { status, headers: { get(name) }, body: async-iterable of bytes } (a WHATWG Response fits).

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const { createUrlGuard } = require('../browser-use/url-guard');

const LIMITS = Object.freeze({
  timeoutMs: 8000,
  maxBodyBytes: 256 * 1024,
  maxRedirects: 3,
  maxTitleChars: 200,
  maxUrlChars: 4096,
});
const USER_AGENT = 'Mozilla/5.0 (compatible; JennyLinkTitle/1.0)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€',
});
const TIMED_OUT = Symbol('timeout');

const failure = (reason) => ({ ok: false, reason });

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : '';
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function cleanTitle(text) {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point.
  let out = text.replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
  if (out.length > LIMITS.maxTitleChars) {
    out = out.slice(0, LIMITS.maxTitleChars);
    if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
    out = out.trimEnd();
  }
  return out;
}

/** The first <title> element's text, entities decoded, controls removed, white space collapsed, at most 200 characters; '' when there is none. */
function extractTitle(html) {
  // One pass with indexOf, never a backtracking pattern: the page is hostile and this runs in the main process, where
  // a page of thousands of unclosed `<!--` or `<title>` would otherwise cost a scan to the end for each of them.
  const text = withoutComments(String(html));
  const lower = text.replace(/[A-Z]/g, (letter) => letter.toLowerCase()); // ASCII only, so every index still lines up
  for (let at = lower.indexOf('<title'); at !== -1; at = lower.indexOf('<title', at + 6)) {
    const next = lower[at + 6];
    if (next !== '>' && !/\s/.test(next || '')) continue; // <titlebar>, or the text ended
    const open = lower.indexOf('>', at + 6);
    const close = open === -1 ? -1 : lower.indexOf('</title', open + 1);
    return close === -1 ? '' : cleanTitle(decodeEntities(text.slice(open + 1, close)));
  }
  return '';
}

/** The text with its comments removed; an unclosed comment takes the rest, as it does in a browser. */
function withoutComments(text) {
  const kept = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf('<!--', at);
    if (open === -1) { kept.push(text.slice(at)); break; }
    kept.push(text.slice(at, open));
    const close = text.indexOf('-->', open + 4);
    if (close === -1) break;
    at = close + 3;
  }
  return kept.join('');
}

function defaultLookup(host) {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

/**
 * One request to `address` whatever `url`'s host says: the name is kept for the Host header and for TLS, but the
 * socket is opened to the address the guard checked. A redirect is returned, never followed.
 */
function pinnedFetch(url, init) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    const lib = secure ? https : http;
    const request = lib.request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: init.headers,
      agent: false,
      signal: init.signal,
      lookup: (_host, options, callback) => {
        if (options && options.all) callback(null, [{ address: init.address, family: init.family }]);
        else callback(null, init.address, init.family);
      },
    });
    request.on('error', reject);
    request.on('response', (response) => {
      const close = () => { response.destroy(); request.destroy(); };
      async function* chunks() {
        try { for await (const chunk of response) yield chunk; } finally { close(); }
      }
      resolve({
        status: response.statusCode,
        headers: { get: (name) => { const value = response.headers[String(name).toLowerCase()]; return Array.isArray(value) ? value[0] : (value === undefined ? null : value); } },
        body: chunks(),
        close,
      });
    });
    request.end();
  });
}

function discard(response) {
  try {
    if (typeof response.close === 'function') response.close();
    else if (response.body && typeof response.body.cancel === 'function') response.body.cancel().catch(() => {});
    else if (response.body && typeof response.body.return === 'function') response.body.return();
  } catch (_error) { /* nothing left to release */ }
}

function charsetOf(contentType) {
  const found = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType);
  return found ? found[1] : 'utf-8';
}

function decodeBytes(bytes, label) {
  try { return new TextDecoder(label).decode(bytes); } catch (_error) { return new TextDecoder('utf-8').decode(bytes); }
}

async function readTitle(body, label) {
  const cap = LIMITS.maxBodyBytes;
  const chunks = [];
  let total = 0;
  let truncated = false;
  let tail = '';
  for await (const raw of body) {
    let chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (chunk.length > cap - total) { chunk = chunk.subarray(0, cap - total); truncated = true; }
    chunks.push(chunk);
    total += chunk.length;
    const seen = `${tail}${chunk.toString('latin1')}`.toLowerCase();
    tail = seen.slice(-8);
    // Stop reading as soon as a title has been closed, so a big page costs one chunk.
    if (seen.includes('</title') && extractTitle(decodeBytes(Buffer.concat(chunks), label))) break;
    if (truncated) break;
  }
  const title = extractTitle(decodeBytes(Buffer.concat(chunks), label));
  if (title) return { ok: true, title };
  return failure(truncated ? 'too_large' : 'no_title');
}

/** The guard's verdict for one hop, with the address to pin: { ok: true, address, family } or a failure. */
async function checkHop(rawUrl, hop, lookup) {
  const guard = createUrlGuard();
  const verdict = guard.classify(rawUrl, { kind: 'navigation' });
  if (!verdict.allowed) {
    const unusable = verdict.reason === 'invalid_url' || verdict.reason === 'unsupported_scheme';
    return failure(unusable && hop === 0 ? 'invalid' : 'refused');
  }
  if (verdict.isLoopback) return failure('refused');
  if (!verdict.needsDns) return { ok: true, address: verdict.host, family: verdict.host.includes(':') ? 6 : 4 };
  let answers;
  try { answers = await lookup(verdict.host); } catch (_error) { return failure('failed'); }
  const endpoints = Array.isArray(answers) ? answers.filter((entry) => entry && typeof entry.address === 'string') : [];
  if (!endpoints.length) return failure('failed');
  // The guard's own rule over every answer: one private address among them refuses the host.
  const checked = await createUrlGuard({ resolveHost: async () => ({ endpoints }) }).check(rawUrl, { kind: 'navigation' });
  if (!checked.allowed) return failure(checked.reason === 'unresolved_host' || checked.reason === 'resolver_unavailable' ? 'failed' : 'refused');
  const first = endpoints[0];
  return { ok: true, address: first.address, family: first.family === 6 || first.address.includes(':') ? 6 : 4 };
}

function createLinkTitleFetcher({ fetch = pinnedFetch, lookup = defaultLookup, timeoutMs = LIMITS.timeoutMs } = {}) {
  async function follow(startUrl, signal, state) {
    let current = startUrl;
    for (let hop = 0; hop <= LIMITS.maxRedirects; hop += 1) {
      const checked = await checkHop(current, hop, lookup);
      if (!checked.ok) return checked;
      const response = await fetch(current, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity' },
        redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal, address: checked.address, family: checked.family,
      });
      const status = Number(response && response.status);
      if (REDIRECT_STATUSES.has(status)) {
        discard(response);
        const location = response.headers.get('location');
        if (!location || hop === LIMITS.maxRedirects) return failure('failed');
        try { current = new URL(location, current).href; } catch (_error) { return failure('refused'); }
        continue;
      }
      if (!(status >= 200 && status < 300) || status === 204) { discard(response); return failure('failed'); }
      const contentType = String(response.headers.get('content-type') || '');
      if (!HTML_TYPES.has(contentType.split(';')[0].trim().toLowerCase())) { discard(response); return failure('not_html'); }
      state.reading = true;
      return readTitle(response.body, charsetOf(contentType));
    }
    return failure('failed');
  }

  return async function fetchLinkTitle(request) {
    const raw = request && typeof request.url === 'string' ? request.url.trim() : '';
    if (!raw || raw.length > LIMITS.maxUrlChars) return failure('invalid');
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return failure('invalid');
    } catch (_error) { return failure('invalid'); }
    const controller = new AbortController();
    const state = { timedOut: false, reading: false };
    let timer = null;
    const clock = new Promise((resolve) => {
      timer = setTimeout(() => { state.timedOut = true; controller.abort(); resolve(TIMED_OUT); }, timeoutMs);
    });
    const work = follow(raw, controller.signal, state).catch(() => failure(state.timedOut ? 'timeout' : 'failed'));
    try {
      const outcome = await Promise.race([work, clock]);
      return outcome === TIMED_OUT ? failure('timeout') : outcome;
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = {
  LIMITS, USER_AGENT, createLinkTitleFetcher, extractTitle, pinnedFetch,
  fetchLinkTitle: (request) => createLinkTitleFetcher()(request),
};
