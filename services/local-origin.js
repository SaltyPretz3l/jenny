'use strict';

// Origin identity for local HTTP endpoints. Used wherever Jenny must decide
// whether an endpoint IS its managed llama-server before handing over the
// server's api key: the sidecar secrets broker and setup endpoint validation.
// `localhost` and `127.0.0.1` are the same server for this purpose.

function localOriginOf(value) {
  try {
    const parsed = new URL(String(value || ''));
    const host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return `${parsed.protocol}//${host}:${port}`;
  } catch (_error) {
    return '';
  }
}

function sameLocalOrigin(leftUrl, rightUrl) {
  const left = localOriginOf(leftUrl);
  return Boolean(left) && left === localOriginOf(rightUrl);
}

module.exports = {
  localOriginOf,
  sameLocalOrigin,
};
