'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const AUTH_ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_ISSUER}/oauth/authorize`;
const TOKEN_URL = `${AUTH_ISSUER}/oauth/token`;
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const PROVIDER_ID = 'chatgpt';
const SCOPES = 'openid profile email offline_access';
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const FALLBACK_EXPIRY_MS = 8 * 24 * 60 * 60 * 1000;
const PERMANENT_REFRESH_FAILURES = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
]);
const SUCCESS_HTML = '<!doctype html><title>Jenny</title><p>Signed in to Jenny — you can close this tab.</p>';
const ERROR_HTML = '<!doctype html><title>Jenny</title><p>Could not sign in to Jenny — you can close this tab.</p>';
// POLICY CONSTANT — do not fold back into a caller default. The token refresh
// owns its own deadline so a hung/half-open OpenAI token endpoint is reported
// here as `refresh_failed` instead of surfacing 5 minutes later as a generic
// managed-initialize timeout: this must stay BELOW local-engine-status.js's
// DEFAULT_INACTIVITY_TIMEOUT_MS (300_000). Without it a stalled fetch pins the
// single-flight `refreshPromise` non-null forever and every later caller hangs.
const DEFAULT_REFRESH_TIMEOUT_MS = 20_000;
// POLICY CONSTANT — bound on tearing the loopback callback server down. A
// half-open socket (partial request headers, never a CRLFCRLF) keeps
// `server.close()` pending indefinitely, which would stall cancel()/timeout
// teardown and leak the listener port for the rest of the process lifetime.
const CLOSE_SERVER_TIMEOUT_MS = 2000;

class AuthServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthServiceError';
    this.code = code;
  }
}

function boundedError(code, message) {
  return { code: String(code || 'auth_failed'), message: String(message || 'Authentication failed.').slice(0, 240) };
}

function authError(code, message) {
  return new AuthServiceError(code, message);
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeJwtPayload(token) {
  try {
    const segments = String(token || '').split('.');
    if (segments.length < 2 || !segments[1]) {
      return null;
    }
    const normalized = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const value = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_error) {
    return null;
  }
}

function boundedString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function extractIdentity(idToken) {
  const claims = decodeJwtPayload(idToken) || {};
  const authClaims = claims['https://api.openai.com/auth'];
  const profileClaims = claims['https://api.openai.com/profile'];
  const auth = authClaims && typeof authClaims === 'object' ? authClaims : {};
  const profile = profileClaims && typeof profileClaims === 'object' ? profileClaims : {};
  return {
    account_id: boundedString(auth.chatgpt_account_id, 256),
    plan_type: boundedString(auth.chatgpt_plan_type, 64),
    email: boundedString(claims.email || profile.email, 320),
  };
}

function normalizeStoredRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const refreshToken = boundedString(value.refresh_token, 32768);
  if (!refreshToken) {
    return null;
  }
  const lastRefreshMs = Number(value.last_refresh_ms);
  return {
    refresh_token: refreshToken,
    id_token: boundedString(value.id_token, 131072),
    access_token: boundedString(value.access_token, 131072),
    account_id: boundedString(value.account_id, 256),
    plan_type: boundedString(value.plan_type, 64),
    email: boundedString(value.email, 320),
    last_refresh_ms: Number.isFinite(lastRefreshMs) && lastRefreshMs >= 0 ? lastRefreshMs : 0,
  };
}

function parseStoredRecord(rawValue) {
  if (!rawValue) {
    return null;
  }
  try {
    return normalizeStoredRecord(JSON.parse(rawValue));
  } catch (_error) {
    return null;
  }
}

function accessTokenExpiresAt(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const expirySeconds = Number(payload?.exp);
  return Number.isFinite(expirySeconds) && expirySeconds > 0 ? expirySeconds * 1000 : 0;
}

function isAccessTokenFresh(record, nowMs) {
  if (!record?.access_token) {
    return false;
  }
  const expiresAt = accessTokenExpiresAt(record.access_token);
  if (expiresAt) {
    return nowMs < expiresAt - EXPIRY_SKEW_MS;
  }
  return record.last_refresh_ms > 0 && nowMs < record.last_refresh_ms + FALLBACK_EXPIRY_MS;
}

function stateMatches(expected, received) {
  const left = Buffer.from(String(expected || ''), 'utf8');
  const right = Buffer.from(String(received || ''), 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function respondHtml(response, statusCode, body) {
  if (response.writableEnded) {
    return;
  }
  const payload = Buffer.from(body, 'utf8');
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': payload.length,
    'content-type': 'text/html; charset=utf-8',
  });
  response.end(payload);
}

async function readJsonResponse(response) {
  try {
    if (typeof response?.json === 'function') {
      const value = await response.json();
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
    if (typeof response?.text === 'function') {
      const value = JSON.parse(await response.text());
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
  } catch (_error) {
    return {};
  }
  return {};
}

function responseIsOk(response) {
  const status = Number(response?.status);
  return response?.ok === true || (Number.isFinite(status) && status >= 200 && status < 300);
}

function providerErrorCode(body) {
  const candidates = [body?.code, body?.error, body?.error?.code];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const code = candidate.trim();
      if (PERMANENT_REFRESH_FAILURES.has(code)) {
        return code;
      }
    }
  }
  return '';
}

function createChatGptAuthService({
  secureStore,
  openExternal,
  fetchImpl = global.fetch,
  logger = null,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  listenPorts = [1455, 1457],
  refreshTimeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
} = {}) {
  let loaded = false;
  let record = null;
  let statusState = 'signed_out';
  let statusError = null;
  let activeFlow = null;
  let refreshPromise = null;
  // The deadline is owned by the shared single flight, not by a caller: a
  // per-caller abort would let caller A's short bound poison caller B with a
  // spurious `refresh_failed`. Armed when the flight starts, cleared in its
  // finally; callers wanting a tighter bound race it WITHOUT aborting.
  let activeRefreshDeadline = null;
  // Bumped whenever the credential is replaced outside a refresh (sign-out,
  // permanent expiry, fresh sign-in) so an in-flight refresh cannot resurrect a
  // deleted record. This is the single revocation clock the chat-turn admission
  // gate compares the running sidecar's credential generation against.
  let credentialEpoch = 0;
  const subscribers = new Set();

  function clearCredentialInMemory() {
    credentialEpoch += 1;
    record = null;
  }

  function createRefreshDeadline(timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      dispose: () => clearTimeout(timer),
    };
  }

  // An injected fetchImpl (and some transports) ignore the AbortSignal, so the
  // await itself is raced against the deadline rather than trusting the
  // transport to reject. The signal is still handed to fetch so a real socket
  // is torn down when sign-out revokes the credential mid-flight.
  function awaitBoundedBySignal(task, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = () => settle(
        reject,
        authError('refresh_failed', 'ChatGPT credentials could not be refreshed.')
      );
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(task).then(
        (value) => settle(resolve, value),
        (error) => settle(reject, error)
      );
    });
  }

  // The BODY read needs its own bound: an injected fetchImpl's .json() ignores
  // signals, so a headers-returned/body-never-ends response would hang here.
  // Resolves {} on abort or on any failure — the caller's epoch/abort checks
  // decide what an empty payload means.
  function readJsonResponseBounded(response, signal) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish({});
      if (signal.aborted) {
        finish({});
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      readJsonResponse(response).then(finish, () => finish({}));
    });
  }

  function snapshot(errorOverride) {
    const error = arguments.length > 0 ? errorOverride : statusError;
    return {
      state: statusState,
      email: record?.email || '',
      planType: record?.plan_type || '',
      accountId: record?.account_id || '',
      error: error ? { code: error.code, message: error.message } : null,
    };
  }

  function emitStatus() {
    const value = snapshot();
    for (const callback of [...subscribers]) {
      try {
        callback(value);
      } catch (_error) {
        // Subscriber failures must not alter authentication state.
      }
    }
  }

  function transition(nextState, nextError = null) {
    const errorChanged = (statusError?.code || '') !== (nextError?.code || '')
      || (statusError?.message || '') !== (nextError?.message || '');
    const changed = statusState !== nextState || errorChanged;
    statusState = nextState;
    statusError = nextError;
    if (changed) {
      emitStatus();
    }
  }

  function logBounded(level, event, error) {
    if (typeof logger !== 'function') {
      return;
    }
    const safe = boundedError(error?.code, error?.message);
    try {
      logger(level, event, safe);
    } catch (_error) {
      // Logging is best-effort and must never affect auth state.
    }
  }

  function ensureLoaded() {
    if (loaded) {
      return;
    }
    loaded = true;
    try {
      record = parseStoredRecord(secureStore?.getModelProviderOAuth(PROVIDER_ID));
    } catch (_error) {
      record = null;
      logBounded('WARN', 'chatgpt_auth.load_failed', boundedError('storage_unavailable', 'Saved sign-in could not be loaded.'));
    }
    if (record) {
      transition('signed_in');
    }
  }

  function saveRecord(nextRecord) {
    secureStore.setModelProviderOAuth(PROVIDER_ID, JSON.stringify(nextRecord));
  }

  function removeRecord() {
    secureStore.deleteModelProviderOAuth(PROVIDER_ID);
  }

  function abortFlow(flow, code, message) {
    if (!flow || flow.controller.signal.aborted) {
      return;
    }
    flow.abortError = authError(code, message);
    flow.controller.abort();
  }

  function flowAbortPromise(flow, executor) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        flow.controller.signal.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = () => settle(reject, flow.abortError || authError('auth_cancelled', 'Sign-in was cancelled.'));
      const start = executor(
        (value) => settle(resolve, value),
        (error) => settle(reject, error)
      );
      if (flow.controller.signal.aborted) {
        onAbort();
      } else {
        flow.controller.signal.addEventListener('abort', onAbort, { once: true });
        start?.();
      }
    });
  }

  function createCallbackPromise(flow) {
    return flowAbortPromise(flow, (resolve, reject) => {
      flow.resolveCallback = resolve;
      flow.rejectCallback = reject;
    });
  }

  function awaitWithFlowAbort(task, flow) {
    return flowAbortPromise(flow, (resolve, reject) => () => {
      Promise.resolve(task).then(resolve, reject);
    });
  }

  function handleCallback(flow, expectedState, request, response) {
    let callbackUrl;
    try {
      callbackUrl = new URL(request.url || '/', 'http://localhost');
    } catch (_error) {
      respondHtml(response, 400, ERROR_HTML);
      return;
    }
    if (callbackUrl.pathname !== '/auth/callback') {
      respondHtml(response, 404, ERROR_HTML);
      return;
    }
    if (flow.callbackReceived) {
      respondHtml(response, 410, ERROR_HTML);
      return;
    }
    if (!stateMatches(expectedState, callbackUrl.searchParams.get('state'))) {
      // A non-matching state is ignored (not consumed): any local process can
      // GET the loopback port, and aborting here would let it grief the flow.
      respondHtml(response, 400, ERROR_HTML);
      return;
    }
    flow.callbackReceived = true;
    const code = callbackUrl.searchParams.get('code') || '';
    if (!code || code.length > 8192) {
      respondHtml(response, 400, ERROR_HTML);
      abortFlow(flow, 'invalid_callback', 'Sign-in did not return an authorization code.');
      return;
    }
    respondHtml(response, 200, SUCCESS_HTML);
    // The browser's own socket must be closed gracefully (end(), not destroy())
    // so the success page finishes flushing; every other tracked socket is
    // destroyed on teardown. See closeFlowServer.
    flow.gracefulSocket = request.socket;
    flow.resolveCallback(code);
  }

  async function listenForCallback(flow, expectedState) {
    const ports = Array.isArray(listenPorts) ? listenPorts : [];
    for (const candidate of ports) {
      if (flow.controller.signal.aborted) {
        throw flow.abortError;
      }
      const port = Number(candidate);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        continue;
      }
      const server = http.createServer((request, response) => handleCallback(flow, expectedState, request, response));
      // Track every accepted connection: any local process can open the
      // loopback port and stall mid-headers, and an open socket keeps
      // server.close() pending forever (the port would never be released).
      const sockets = new Set();
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      const result = await new Promise((resolve) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          resolve({ error });
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve({ port });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      if (result.port) {
        flow.server = server;
        flow.serverSockets = sockets;
        return port;
      }
      if (result.error?.code !== 'EADDRINUSE') {
        throw authError('listener_unavailable', 'The local sign-in listener could not be started.');
      }
    }
    throw authError('listener_unavailable', 'No local sign-in port is available.');
  }

  async function closeFlowServer(flow) {
    const server = flow?.server;
    const sockets = flow?.serverSockets;
    const gracefulSocket = flow?.gracefulSocket;
    if (flow) {
      // Null every handle first so the second call (runAuthFlow closes once
      // after the callback and again in its finally) is a no-op.
      flow.server = null;
      flow.serverSockets = null;
      flow.gracefulSocket = null;
    }
    for (const socket of sockets || []) {
      try {
        if (socket === gracefulSocket) {
          // end() flushes the queued success page before FIN. destroy() here
          // silently truncates the browser tab, because runAuthFlow closes the
          // server immediately after the callback resolves — before
          // respondHtml's response.end() has flushed.
          socket.end();
        } else {
          socket.destroy();
        }
      } catch (_error) {
        // The socket is already gone; teardown continues.
      }
    }
    if (!server?.listening) {
      return;
    }
    server.unref?.();
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, CLOSE_SERVER_TIMEOUT_MS);
      timer.unref?.();
      server.close(finish);
    });
  }

  function buildAuthorizationUrl(port, state, challenge) {
    const redirectUri = `http://localhost:${port}/auth/callback`;
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('originator', 'jenny');
    url.searchParams.set('state', state);
    return { authUrl: url.toString(), redirectUri };
  }

  async function exchangeAuthorizationCode(code, redirectUri, verifier, flow) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }).toString();
    let response;
    try {
      response = await awaitWithFlowAbort(fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: flow.controller.signal,
      }), flow);
    } catch (_error) {
      if (flow.controller.signal.aborted) {
        throw flow.abortError || authError('auth_cancelled', 'Sign-in was cancelled.');
      }
      throw authError('code_exchange_failed', 'The sign-in code could not be exchanged.');
    }
    const payload = await awaitWithFlowAbort(readJsonResponse(response), flow);
    if (!responseIsOk(response)) {
      throw authError('code_exchange_failed', 'The sign-in code was rejected.');
    }
    const idToken = boundedString(payload.id_token, 131072);
    const accessToken = boundedString(payload.access_token, 131072);
    const refreshToken = boundedString(payload.refresh_token, 32768);
    if (!idToken || !accessToken || !refreshToken) {
      throw authError('invalid_token_response', 'The sign-in response was incomplete.');
    }
    return { idToken, accessToken, refreshToken };
  }

  async function runAuthFlow(flow, timeoutMs) {
    const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0 ? Number(timeoutMs) : 180000;
    flow.timer = setTimeout(
      () => abortFlow(flow, 'auth_timeout', 'Sign-in timed out.'),
      timeout
    );
    const callbackPromise = createCallbackPromise(flow);
    callbackPromise.catch(() => {});
    try {
      transition('connecting');
      const verifier = base64Url(randomBytes(64));
      const state = base64Url(randomBytes(32));
      const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
      const port = await listenForCallback(flow, state);
      if (flow.controller.signal.aborted) {
        throw flow.abortError;
      }
      const { authUrl, redirectUri } = buildAuthorizationUrl(port, state, challenge);
      try {
        await awaitWithFlowAbort(Promise.resolve().then(() => openExternal(authUrl)), flow);
      } catch (_error) {
        if (flow.controller.signal.aborted) {
          throw flow.abortError;
        }
        throw authError('browser_open_failed', 'The system browser could not be opened.');
      }
      const code = await callbackPromise;
      await closeFlowServer(flow);
      const tokens = await exchangeAuthorizationCode(code, redirectUri, verifier, flow);
      const identity = extractIdentity(tokens.idToken);
      const nextRecord = {
        refresh_token: tokens.refreshToken,
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        account_id: identity.account_id,
        plan_type: identity.plan_type,
        email: identity.email,
        last_refresh_ms: Number(now()),
      };
      try {
        saveRecord(nextRecord);
      } catch (_error) {
        throw authError('storage_failed', 'Sign-in credentials could not be saved securely.');
      }
      credentialEpoch += 1;
      record = nextRecord;
      transition('signed_in');
      return snapshot();
    } catch (error) {
      const safe = error instanceof AuthServiceError
        ? boundedError(error.code, error.message)
        : boundedError('auth_failed', 'Sign-in failed.');
      if (safe.code === 'signed_out') {
        transition('signed_out');
      } else if (safe.code === 'auth_timeout' || safe.code === 'auth_cancelled') {
        transition('signed_out', safe);
      } else {
        transition('error', safe);
      }
      logBounded('WARN', 'chatgpt_auth.flow_failed', safe);
      return snapshot();
    } finally {
      clearTimeout(flow.timer);
      await closeFlowServer(flow);
    }
  }

  async function start({ timeoutMs = 180000 } = {}) {
    ensureLoaded();
    if (activeFlow) {
      return snapshot(boundedError('already_connecting', 'A sign-in flow is already in progress.'));
    }
    const flow = {
      abortError: null,
      callbackReceived: false,
      controller: new AbortController(),
      gracefulSocket: null,
      server: null,
      serverSockets: null,
      timer: null,
    };
    activeFlow = flow;
    flow.promise = runAuthFlow(flow, timeoutMs).finally(() => {
      if (activeFlow === flow) {
        activeFlow = null;
      }
    });
    return flow.promise;
  }

  function cancel() {
    ensureLoaded();
    if (activeFlow) {
      abortFlow(activeFlow, 'auth_cancelled', 'Sign-in was cancelled.');
    }
  }

  // Fail closed: a secure-store delete failure must NOT leave the in-memory
  // credential live. The wire shape stays state:'signed_out' with a non-null
  // error — the user genuinely IS signed out, so state:'error' would show a
  // permanent red badge and swap the renderer's primary action to "Try again".
  async function signOut() {
    ensureLoaded();
    if (activeFlow) {
      abortFlow(activeFlow, 'signed_out', 'Signed out.');
    }
    let storageError = null;
    try {
      removeRecord();
    } catch (_error) {
      storageError = boundedError(
        'storage_failed',
        'Signed out. Saved credentials could not be removed from secure storage.'
      );
    }
    clearCredentialInMemory();
    // Tear down an in-flight refresh socket; its epoch guard already makes the
    // result unusable, but the connection should not outlive the credential.
    activeRefreshDeadline?.abort();
    transition('signed_out', storageError);
    if (storageError) {
      logBounded('WARN', 'chatgpt_auth.sign_out_storage_failed', storageError);
    }
    return snapshot();
  }

  function getStatus() {
    ensureLoaded();
    return snapshot();
  }

  function getCachedAccessToken() {
    ensureLoaded();
    return isAccessTokenFresh(record, Number(now())) ? record.access_token : '';
  }

  async function permanentlyExpireAuth() {
    try {
      removeRecord();
    } catch (_error) {
      // The in-memory credential is still cleared so a rejected token cannot be reused.
    }
    // Routes through the same revocation clock as signOut so a concurrent
    // refresh cannot re-persist the credential the provider just rejected.
    clearCredentialInMemory();
    transition('error', boundedError('auth_expired', 'Your ChatGPT sign-in has expired. Sign in again.'));
    return '';
  }

  async function refreshAccessToken(force, previousAccessToken, signal) {
    const epochAtStart = credentialEpoch;
    const expectedAccountId = record?.account_id || '';
    let latest;
    try {
      latest = parseStoredRecord(secureStore.getModelProviderOAuth(PROVIDER_ID));
    } catch (_error) {
      throw authError('refresh_failed', 'ChatGPT credentials could not be refreshed.');
    }
    if (!latest) {
      record = null;
      transition('signed_out');
      return '';
    }
    if (expectedAccountId && latest.account_id && expectedAccountId !== latest.account_id) {
      throw authError('refresh_failed', 'ChatGPT credentials could not be refreshed.');
    }
    record = latest;
    const currentNow = Number(now());
    if (!force && isAccessTokenFresh(latest, currentNow)) {
      return latest.access_token;
    }
    if (force && latest.access_token !== previousAccessToken && isAccessTokenFresh(latest, currentNow)) {
      return latest.access_token;
    }
    let response;
    try {
      response = await awaitBoundedBySignal(fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: latest.refresh_token,
        }),
        signal,
      }), signal);
    } catch (_error) {
      // Epoch first: when sign-out aborts the socket the fetch rejects, and
      // throwing here would break the contract that a sign-out racing a refresh
      // yields '' rather than a spurious refresh_failed.
      if (credentialEpoch !== epochAtStart) {
        return '';
      }
      throw authError('refresh_failed', 'ChatGPT credentials could not be refreshed.');
    }
    const payload = await readJsonResponseBounded(response, signal);
    if (credentialEpoch !== epochAtStart) {
      // Sign-out (or a fresh sign-in) replaced the credential while the
      // refresh was in flight; persisting now would resurrect a deleted record.
      return '';
    }
    if (signal.aborted) {
      throw authError('refresh_failed', 'ChatGPT credentials could not be refreshed.');
    }
    if (!responseIsOk(response)) {
      if (providerErrorCode(payload)) {
        return permanentlyExpireAuth();
      }
      throw authError('refresh_failed', 'ChatGPT credentials could not be refreshed.');
    }
    const replacement = (field, maxLength) => {
      const value = boundedString(payload[field], maxLength);
      return value || latest[field];
    };
    const nextIdToken = replacement('id_token', 131072);
    const identity = extractIdentity(nextIdToken);
    const nextRecord = {
      refresh_token: replacement('refresh_token', 32768),
      id_token: nextIdToken,
      access_token: replacement('access_token', 131072),
      account_id: identity.account_id || latest.account_id,
      plan_type: identity.plan_type || latest.plan_type,
      email: identity.email || latest.email,
      last_refresh_ms: Number(now()),
    };
    try {
      saveRecord(nextRecord);
    } catch (_error) {
      throw authError('refresh_failed', 'ChatGPT credentials could not be refreshed.');
    }
    record = nextRecord;
    return nextRecord.access_token;
  }

  async function getAccessToken({ force = false } = {}) {
    ensureLoaded();
    if (!record) {
      return '';
    }
    if (!force) {
      const cached = getCachedAccessToken();
      if (cached) {
        return cached;
      }
    }
    if (!refreshPromise) {
      const previousAccessToken = record.access_token;
      const deadline = createRefreshDeadline(refreshTimeoutMs);
      activeRefreshDeadline = deadline;
      refreshPromise = refreshAccessToken(force === true, previousAccessToken, deadline.signal)
        .catch((error) => {
          const safe = error instanceof AuthServiceError
            ? error
            : authError('refresh_failed', 'ChatGPT credentials could not be refreshed.');
          logBounded('WARN', 'chatgpt_auth.refresh_failed', safe);
          throw safe;
        })
        .finally(() => {
          deadline.dispose();
          if (activeRefreshDeadline === deadline) {
            activeRefreshDeadline = null;
          }
          refreshPromise = null;
        });
    }
    return refreshPromise;
  }

  function getAccountId() {
    ensureLoaded();
    return record?.account_id || '';
  }

  // Deliberately NOT getCachedAccessToken() !== '': that also reports '' for a
  // merely-stale-but-refreshable token, which is a normal signed-in state.
  function hasCredential() {
    ensureLoaded();
    return Boolean(record);
  }

  function getCredentialEpoch() {
    return credentialEpoch;
  }

  function onStatusChange(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }

  return {
    start,
    cancel,
    signOut,
    permanentlyExpireAuth,
    getStatus,
    getCachedAccessToken,
    getAccessToken,
    getAccountId,
    hasCredential,
    getCredentialEpoch,
    onStatusChange,
  };
}

module.exports = {
  AUTH_ISSUER,
  AUTHORIZE_URL,
  CLOSE_SERVER_TIMEOUT_MS,
  DEFAULT_REFRESH_TIMEOUT_MS,
  TOKEN_URL,
  CLIENT_ID,
  createChatGptAuthService,
};
