'use strict';

const http = require('node:http');

const CALLBACK_PATH = '/plugin-oauth/callback';
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

function failure(reason) {
  return { ok: false, reason, retryable: false };
}

function createLoopbackAuthorization({ oauthFlowService, openExternal,
  createServer = http.createServer } = {}) {
  const listeners = new Map();
  let disposed = false;

  async function begin(input) {
    if (disposed || typeof openExternal !== 'function') {
      return failure('oauth_loopback_unavailable');
    }
    let settleCallback;
    let callbackStarted = false;
    let closed = false;
    const server = createServer(async (request, response) => {
      let pathname;
      try { pathname = new URL(String(request.url || ''), 'http://127.0.0.1').pathname; }
      catch (_error) { pathname = ''; }
      if (request.method !== 'GET' || pathname !== CALLBACK_PATH) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      if (callbackStarted || !settleCallback) {
        response.writeHead(409, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end('Authorization callback already handled.');
        return;
      }
      callbackStarted = true;
      const address = server.address();
      const callbackUrl = `http://127.0.0.1:${address.port}${request.url}`;
      let result;
      try {
        result = await oauthFlowService.completeAuthorization({
          flow_id: settleCallback.flowId,
          callback_url: callbackUrl,
        });
      } catch (_error) {
        result = failure('oauth_callback_failed');
      }
      response.writeHead(result.ok ? 200 : 400, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(result.ok
        ? 'Jenny authorization complete. You can close this window.'
        : 'Jenny authorization failed. Return to Jenny and try again.');
      settleCallback.close();
    });
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(settleCallback?.timer);
      listeners.delete(server);
      try { server.close(); } catch (_error) { /* already closed */ }
    };
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      if (disposed) {
        close();
        return failure('oauth_loopback_unavailable');
      }
      listeners.set(server, close);
      const address = server.address();
      if (!address || typeof address !== 'object') {
        close();
        return failure('oauth_loopback_unavailable');
      }
      const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      const begun = await oauthFlowService.beginAuthorization({
        ...input,
        redirect_uri: redirectUri,
      });
      if (disposed) {
        close();
        return failure('oauth_loopback_unavailable');
      }
      if (!begun.ok) {
        close();
        return begun;
      }
      const timer = setTimeout(close, CALLBACK_TIMEOUT_MS);
      timer.unref?.();
      settleCallback = { flowId: begun.flow_id, timer, close };
      try {
        const authorizationUrl = new URL(begun.authorization_url);
        if (authorizationUrl.protocol !== 'https:') {
          close();
          return failure('oauth_authorization_url_invalid');
        }
        await openExternal(authorizationUrl.href);
        if (disposed) {
          close();
          return failure('oauth_loopback_unavailable');
        }
      } catch (_error) {
        close();
        return failure('oauth_browser_open_failed');
      }
      const { authorization_url: _authorizationUrl, ...publicResult } = begun;
      return { ...publicResult, browser_opened: true };
    } catch (_error) {
      close();
      return failure('oauth_loopback_unavailable');
    }
  }

  function dispose() {
    disposed = true;
    for (const close of [...listeners.values()]) close();
    listeners.clear();
  }

  return Object.freeze({ begin, dispose });
}

module.exports = {
  createLoopbackAuthorization,
};
