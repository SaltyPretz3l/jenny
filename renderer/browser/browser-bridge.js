/*
 * Browser transport for the hosted Jenny surface.
 *
 * The bridge keeps credentials in this tab's memory only. It deliberately
 * exposes the fixed HTTP command vocabulary as a small adapter instead of
 * turning the browser into a generic IPC client.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyBrowserBridge = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const API_VERSION = 1;
  const DEFAULT_BASE_PATH = '/api/v1';
  const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
  const NO_SESSION_OPERATIONS = new Set(['sessions.list', 'sessions.create', 'requests.status']);
  const ATTACHMENT_MIME_TYPES = Object.freeze(new Set([
    'image/png', 'image/jpeg', 'image/webp', 'text/plain',
  ]));
  const ARTIFACT_MIME_TYPES = Object.freeze(new Set([
    'text/plain', 'html', 'markdown', 'svg+xml', 'png', 'jpeg', 'webp', 'json', 'octet-stream',
  ]));
  const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

  function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function randomId(prefix, random = Math.random) {
    const part = `${Date.now().toString(36)}${Math.floor(Math.abs(random()) * 0xFFFFFFF).toString(36)}`;
    return `${prefix}_${part}`.slice(0, 128);
  }

  class BrowserBridgeError extends Error {
    constructor(message, details = {}) {
      super(message);
      this.name = 'BrowserBridgeError';
      this.code = text(details.code, 'bridge_unavailable');
      this.status = Number.isFinite(details.status) ? details.status : 0;
      this.retryable = details.retryable === true;
      this.payload = isRecord(details.payload) ? details.payload : null;
    }
  }

  function publicFailure(payload, status) {
    const error = isRecord(payload?.error) ? payload.error : {};
    return new BrowserBridgeError(
      text(error.reason, status === 401 ? 'authentication_required' : 'request_failed'),
      {
        code: text(error.code, status === 401 ? 'auth_required' : 'request_failed'),
        status,
        retryable: error.retryable === true || status >= 500,
        payload,
      },
    );
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch (_error) {
      throw new BrowserBridgeError('invalid_server_response', {
        code: 'invalid_server_response',
        status: response?.status,
        retryable: response?.status >= 500,
      });
    }
  }

  function attachmentName(value) {
    const name = text(value).split(/[\\/]/).pop().trim();
    return name.slice(0, 255) || 'attachment';
  }

  function artifactMimeType(value) {
    const raw = text(value).toLowerCase();
    const aliases = { 'text/html': 'html', 'text/markdown': 'markdown', 'image/svg+xml': 'svg+xml', 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'application/json': 'json' };
    const normalized = aliases[raw] || raw;
    return ARTIFACT_MIME_TYPES.has(normalized) ? normalized : 'octet-stream';
  }

  async function readBinary(response) {
    if (typeof response?.blob === 'function') return response.blob();
    if (typeof response?.arrayBuffer === 'function') {
      const bytes = await response.arrayBuffer();
      if (typeof Blob === 'function') return new Blob([bytes], { type: text(response.headers?.get?.('content-type')) });
      return bytes;
    }
    throw new BrowserBridgeError('invalid_server_response', { code: 'invalid_server_response', status: response?.status });
  }

  function parseEventId(value) {
    const raw = text(value).trim();
    const separator = raw.lastIndexOf(':');
    if (separator < 1) return null;
    const bootEpoch = raw.slice(0, separator);
    const cursor = Number(raw.slice(separator + 1));
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(bootEpoch) || !Number.isSafeInteger(cursor) || cursor < 0) return null;
    return { bootEpoch, cursor };
  }

  function createSseParser(onMessage) {
    let buffer = '';
    let eventName = '';
    let eventId = '';
    let dataLines = [];

    function dispatch() {
      if (!dataLines.length) {
        eventName = '';
        eventId = '';
        return;
      }
      const payload = dataLines.join('\n');
      const frame = { event: eventName || 'message', id: eventId, data: payload };
      dataLines = [];
      eventName = '';
      eventId = '';
      onMessage(frame);
    }

    function consume(chunk, flush = false) {
      buffer += text(chunk);
      // A trailing CR may be the first byte of CRLF in the next read.
      const pendingCr = !flush && buffer.endsWith('\r');
      const lines = (pendingCr ? buffer.slice(0, -1) : buffer).split(/\r\n|\n|\r/);
      buffer = (lines.pop() || '') + (pendingCr ? '\r' : '');
      for (const line of lines) {
        if (line === '') {
          dispatch();
          continue;
        }
        if (line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
        if (field === 'event') eventName = value;
        else if (field === 'id') eventId = value;
        else if (field === 'data') dataLines.push(value);
      }
      if (flush) {
        if (buffer !== '') {
          const line = buffer;
          buffer = '';
          if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          else if (line.startsWith('id:')) eventId = line.slice(3).replace(/^ /, '');
          else if (line.startsWith('event:')) eventName = line.slice(6).replace(/^ /, '');
        }
        dispatch();
      }
    }

    return { consume };
  }

  class BrowserBridge {
    constructor(options = {}) {
      this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
      this.basePath = text(options.basePath, DEFAULT_BASE_PATH).replace(/\/$/, '');
      this.random = typeof options.random === 'function' ? options.random : Math.random;
      this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
        ? options.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
      this.identityGeneration = 0;
      this.csrfToken = '';
      this.bootEpoch = '';
      this.session = null;
      this.clientId = '';
      this.clientToken = '';
      this.cursor = 0;
      this.disposed = false;
      this.eventsAbort = null;
    }

    _assertAvailable() {
      if (this.disposed) throw new BrowserBridgeError('bridge_disposed', { code: 'bridge_disposed' });
      if (typeof this.fetchImpl !== 'function') throw new BrowserBridgeError('fetch_unavailable', { code: 'fetch_unavailable' });
    }

    async _request(path, options = {}) {
      this._assertAvailable();
      const headers = { Accept: 'application/json', ...(options.headers || {}) };
      const generation = this.identityGeneration;
      const { timeoutMs, ...fetchOptions } = options;
      let response;
      let payload;
      try {
        const result = await this._fetchWithDeadline(`${this.basePath}${path}`, {
          credentials: 'same-origin',
          ...fetchOptions,
          headers,
        }, timeoutMs, async (received) => {
          response = received;
          return { response: received, payload: await readJson(received) };
        });
        response = result.response;
        payload = result.payload;
      } catch (error) {
        if (error instanceof BrowserBridgeError) {
          this._invalidateUnauthorized(response?.status, generation);
          throw error;
        }
        throw new BrowserBridgeError('host_unavailable', { code: 'host_unavailable', retryable: true });
      }
      if (!response.ok || payload?.ok === false) {
        this._invalidateUnauthorized(response.status, generation);
        throw publicFailure(payload, response.status);
      }
      return payload;
    }

    async _fetchWithDeadline(url, options = {}, timeoutMs, consumeResponse = (response) => response) {
      const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.requestTimeoutMs;
      const controller = new AbortController();
      const callerSignal = options.signal;
      const abortFromCaller = () => controller.abort();
      if (callerSignal?.aborted) abortFromCaller();
      else callerSignal?.addEventListener?.('abort', abortFromCaller, { once: true });
      let timer = null;
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new BrowserBridgeError('request_timeout', { code: 'request_timeout', retryable: true }));
        }, duration);
      });
      try {
        return await Promise.race([
          Promise.resolve(this.fetchImpl(url, { ...options, signal: controller.signal })).then(consumeResponse),
          deadline,
        ]);
      } finally {
        if (timer !== null) clearTimeout(timer);
        callerSignal?.removeEventListener?.('abort', abortFromCaller);
      }
    }

    _invalidateUnauthorized(status, generation) {
      if (status === 401 && generation === this.identityGeneration) this.clearCredentials();
    }

    async login(password) {
      this.clearCredentials();
      const generation = this.identityGeneration;
      if (!text(password).trim()) throw new BrowserBridgeError('password_required', { code: 'password_required' });
      const payload = await this._request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: text(password) }),
      });
      if (generation !== this.identityGeneration || this.disposed) throw new BrowserBridgeError('identity_changed');
      if (payload.ok !== true || !text(payload.csrf_token) || !isRecord(payload.session)) {
        throw new BrowserBridgeError('invalid_login_response', { code: 'invalid_server_response', payload });
      }
      this.csrfToken = payload.csrf_token;
      this.session = payload.session;
      this.bootEpoch = text(payload.boot_epoch, this.bootEpoch);
      this.clientId = '';
      this.clientToken = '';
      this.cursor = 0;
      return payload;
    }

    async bootstrap() {
      const generation = this.identityGeneration;
      const previousEpoch = this.bootEpoch;
      const payload = await this._request('/bootstrap', { method: 'GET' });
      if (generation !== this.identityGeneration || this.disposed) throw new BrowserBridgeError('identity_changed');
      if (payload.ok !== true || payload.api_version !== API_VERSION
        || !text(payload.boot_epoch) || !text(payload.csrf_token) || !isRecord(payload.session)) {
        throw new BrowserBridgeError('invalid_bootstrap_response', { code: 'invalid_server_response', payload });
      }
      this.bootEpoch = payload.boot_epoch;
      this.csrfToken = payload.csrf_token;
      this.session = payload.session;
      if (previousEpoch && previousEpoch !== this.bootEpoch) {
        this.clientId = '';
        this.clientToken = '';
        this.cursor = 0;
      }
      return payload;
    }

    async registerClient() {
      const generation = this.identityGeneration;
      if (!this.csrfToken) throw new BrowserBridgeError('bootstrap_required', { code: 'bootstrap_required' });
      const payload = await this._request('/clients', {
        method: 'POST',
        headers: { 'X-CSRF-Token': this.csrfToken },
      });
      if (generation !== this.identityGeneration || this.disposed) throw new BrowserBridgeError('identity_changed');
      if (payload.ok !== true || !text(payload.client_id) || !text(payload.client_token)) {
        throw new BrowserBridgeError('invalid_client_response', { code: 'invalid_server_response', payload });
      }
      this.clientId = payload.client_id;
      this.clientToken = payload.client_token;
      return payload;
    }

    buildCommand(operation, options = {}) {
      if (!this.bootEpoch || !this.clientId || !this.clientToken) {
        throw new BrowserBridgeError('client_registration_required', { code: 'client_registration_required' });
      }
      const operationName = text(operation);
      const includeSession = !NO_SESSION_OPERATIONS.has(operationName) || text(options.sessionId);
      const command = {
        api_version: API_VERSION,
        operation: operationName,
        request_id: text(options.requestId) || randomId('request', this.random),
        client_id: this.clientId,
        boot_epoch: this.bootEpoch,
        ...(includeSession ? { session_id: text(options.sessionId) } : {}),
        ...(Number.isSafeInteger(options.controlGeneration) && options.controlGeneration >= 1
          ? { control_generation: options.controlGeneration } : {}),
        expected_revision: text(options.expectedRevision),
        params: isRecord(options.params) ? options.params : {},
      };
      return command;
    }

    async command(operation, options = {}) {
      const command = this.buildCommand(operation, options);
      try {
        return await this._sendCommand(command, options.signal);
      } catch (error) {
        if (error instanceof BrowserBridgeError) {
          error.requestId = command.request_id;
          error.command = command;
        }
        throw error;
      }
    }

    async _sendCommand(command, signal) {
      const payload = await this._request('/commands', {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': this.csrfToken,
          'X-Client-Token': this.clientToken,
        },
        body: JSON.stringify(command),
      });
      if (!isRecord(payload) || typeof payload.ok !== 'boolean') {
        throw new BrowserBridgeError('invalid_server_response', {
          code: 'invalid_server_response',
          retryable: true,
          payload,
        });
      }
      return payload;
    }

    async retryCommand(command, options = {}) {
      if (!isRecord(command) || !text(command.request_id) || command.client_id !== this.clientId
        || command.boot_epoch !== this.bootEpoch) {
        throw new BrowserBridgeError('identity_changed', { code: 'identity_changed' });
      }
      try {
        return await this._sendCommand(command, options.signal);
      } catch (error) {
        if (error instanceof BrowserBridgeError) {
          error.requestId = command.request_id;
          error.command = command;
        }
        throw error;
      }
    }

    // Read-only receipt lookup for a request whose mutation result was
    // ambiguous. Callers must inspect this result before deciding what to do;
    // the bridge never resubmits the original command.
    async requestStatus(requestId) {
      const normalized = text(requestId);
      if (!normalized) throw new BrowserBridgeError('request_identity_required', { code: 'request_identity_required' });
      return this.command('requests.status', { params: { request_id: normalized } });
    }

    async uploadAttachment(file, options = {}) {
      this._assertAvailable();
      const mimeType = text(file?.type).toLowerCase();
      if (!ATTACHMENT_MIME_TYPES.has(mimeType)) {
        throw new BrowserBridgeError('unsupported_attachment_type', { code: 'unsupported_attachment_type' });
      }
      const body = file && (typeof file.arrayBuffer === 'function' || typeof file.stream === 'function' || typeof ArrayBuffer !== 'undefined' && (ArrayBuffer.isView(file) || file instanceof ArrayBuffer));
      if (!body) throw new BrowserBridgeError('attachment_body_required', { code: 'attachment_body_required' });
      if (!this.csrfToken || !this.clientId || !this.clientToken) {
        throw new BrowserBridgeError('client_registration_required', { code: 'client_registration_required' });
      }
      const generation = this.identityGeneration;
      let response;
      let payload;
      try {
        const result = await this._fetchWithDeadline(`${this.basePath}/attachments`, {
          method: 'POST',
          credentials: 'same-origin',
          signal: options.signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': mimeType,
            'X-File-Name': encodeURIComponent(attachmentName(options.displayName || file.name)),
            'X-CSRF-Token': this.csrfToken,
            'X-Client-Id': this.clientId,
            'X-Client-Token': this.clientToken,
          },
          body: file,
        }, options.timeoutMs, async (received) => {
          response = received;
          return { response: received, payload: await readJson(received) };
        });
        response = result.response;
        payload = result.payload;
      } catch (error) {
        if (error instanceof BrowserBridgeError) {
          this._invalidateUnauthorized(response?.status, generation);
          throw error;
        }
        if (options.signal?.aborted) throw new BrowserBridgeError('attachment_upload_cancelled', { code: 'attachment_upload_cancelled' });
        throw new BrowserBridgeError('host_unavailable', { code: 'host_unavailable', retryable: true });
      }
      if (!response.ok || payload?.ok === false) {
        this._invalidateUnauthorized(response.status, generation);
        throw publicFailure(payload, response.status);
      }
      const attachment = payload?.attachment;
      if (payload.ok !== true || !isRecord(attachment) || !text(attachment.id)
        || !text(attachment.display_name) || !text(attachment.mime_type)
        || !Number.isSafeInteger(attachment.size_bytes) || attachment.size_bytes < 0) {
        throw new BrowserBridgeError('invalid_attachment_response', { code: 'invalid_server_response', payload });
      }
      return payload;
    }

    async _downloadBinary(resourcePath, cancellationCode, options) {
      if (!this.clientId || !this.clientToken) {
        throw new BrowserBridgeError('client_registration_required', { code: 'client_registration_required' });
      }
      const generation = this.identityGeneration;
      let response;
      let payload;
      let blob;
      try {
        const result = await this._fetchWithDeadline(this.basePath + resourcePath, {
          method: 'GET',
          credentials: 'same-origin',
          signal: options.signal,
          headers: {
            Accept: '*/*',
            'X-Client-Id': this.clientId,
            'X-Client-Token': this.clientToken,
          },
        }, options.timeoutMs, async (received) => {
          if (received.ok) return { response: received, blob: await readBinary(received), payload: null };
          let failure = null;
          try { failure = await readJson(received); } catch (_error) { /* bounded public failure below */ }
          return { response: received, blob: null, payload: failure };
        });
        ({ response, payload, blob } = result);
      } catch (error) {
        if (error instanceof BrowserBridgeError) throw error;
        if (options.signal?.aborted) throw new BrowserBridgeError(cancellationCode, { code: cancellationCode });
        throw new BrowserBridgeError('host_unavailable', { code: 'host_unavailable', retryable: true });
      }
      if (!response.ok) {
        this._invalidateUnauthorized(response.status, generation);
        throw publicFailure(payload, response.status);
      }
      return { response, blob };
    }

    async downloadAttachment(sessionId, attachmentId, options = {}) {
      this._assertAvailable();
      const normalizedSessionId = text(sessionId);
      const normalizedAttachmentId = text(attachmentId);
      if (!normalizedSessionId || !normalizedAttachmentId) {
        throw new BrowserBridgeError('attachment_identity_required', { code: 'attachment_identity_required' });
      }
      const { response, blob } = await this._downloadBinary(
        `/sessions/${encodeURIComponent(normalizedSessionId)}/attachments/${encodeURIComponent(normalizedAttachmentId)}`,
        'attachment_download_cancelled', options
      );
      return { blob, mimeType: text(response.headers?.get?.('content-type')) };
    }

    async downloadArtifact(sessionId, artifactId, options = {}) {
      this._assertAvailable();
      const normalizedSessionId = text(sessionId);
      const normalizedArtifactId = text(artifactId);
      if (!normalizedSessionId || normalizedSessionId.length > 128 || !ARTIFACT_ID_PATTERN.test(normalizedArtifactId)) {
        throw new BrowserBridgeError('artifact_identity_required', { code: 'artifact_identity_required' });
      }
      const { response, blob } = await this._downloadBinary(
        `/sessions/${encodeURIComponent(normalizedSessionId)}/artifacts/${encodeURIComponent(normalizedArtifactId)}`,
        'artifact_download_cancelled', options
      );
      return {
        blob,
        artifactMimeType: artifactMimeType(response.headers?.get?.('x-artifact-mime-type') || 'octet-stream'),
        contentDisposition: text(response.headers?.get?.('content-disposition')),
      };
    }

    async listAuthSessions() {
      const payload = await this._request('/auth/sessions', { method: 'GET' });
      if (payload.ok !== true || !Array.isArray(payload.sessions)) {
        throw new BrowserBridgeError('invalid_auth_sessions_response', { code: 'invalid_server_response', payload });
      }
      return payload;
    }

    async revokeAuthSession(sessionId) {
      const normalized = text(sessionId);
      if (!normalized || normalized.length > 256) {
        throw new BrowserBridgeError('auth_session_identity_required', { code: 'auth_session_identity_required' });
      }
      if (!this.csrfToken) throw new BrowserBridgeError('authentication_required', { code: 'auth_required', status: 401 });
      const payload = await this._request('/auth/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken },
        body: JSON.stringify({ session_id: normalized }),
      });
      if (payload.ok !== true || payload.revoked !== true) {
        throw new BrowserBridgeError('invalid_auth_revoke_response', { code: 'invalid_server_response', payload });
      }
      return payload;
    }

    async fetchFullMessage(sessionId, messageId, options = {}) {
      const normalizedSessionId = text(sessionId);
      const normalizedMessageId = text(messageId);
      if (!normalizedSessionId || !normalizedMessageId) {
        throw new BrowserBridgeError('message_identity_required', { code: 'message_identity_required' });
      }
      const payload = await this._request(`/sessions/${encodeURIComponent(normalizedSessionId)}/messages/${encodeURIComponent(normalizedMessageId)}`, {
        method: 'GET',
        signal: options.signal,
        headers: {
          'X-Client-Id': this.clientId,
          'X-Client-Token': this.clientToken,
        },
      });
      if (payload.ok !== true || !isRecord(payload.message) || !text(payload.message.id)) {
        throw new BrowserBridgeError('invalid_message_response', { code: 'invalid_server_response', payload });
      }
      return payload;
    }

    async connectEvents(options = {}) {
      if (!this.clientId || !this.clientToken || !this.bootEpoch) {
        throw new BrowserBridgeError('client_registration_required', { code: 'client_registration_required' });
      }
      this.closeEvents();
      const abortController = new AbortController();
      this.eventsAbort = abortController;
      const cursor = Number.isSafeInteger(options.cursor) && options.cursor >= 0 ? options.cursor : this.cursor;
      const generation = this.identityGeneration;
      let response;
      try {
        response = await this.fetchImpl(`${this.basePath}/events`, {
          method: 'GET',
          credentials: 'same-origin',
          signal: abortController.signal,
          headers: {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Client-Id': this.clientId,
            'X-Client-Token': this.clientToken,
            'Last-Event-ID': `${this.bootEpoch}:${cursor}`,
          },
        });
      } catch (_error) {
        if (abortController.signal.aborted) throw new BrowserBridgeError('events_closed', { code: 'events_closed' });
        throw new BrowserBridgeError('events_unavailable', { code: 'events_unavailable', retryable: true });
      }
      const isCurrent = () => this.eventsAbort === abortController && !abortController.signal.aborted;
      if (!isCurrent()) {
        await response.body?.cancel?.().catch(() => {});
        throw new BrowserBridgeError('events_closed', { code: 'events_closed' });
      }
      if (!response.ok || !response.body || typeof response.body.getReader !== 'function') {
        if (this.eventsAbort === abortController) this.eventsAbort = null;
        try { await response.body?.cancel?.(); } catch (_error) { /* failed event response */ }
        this._invalidateUnauthorized(response.status, generation);
        throw publicFailure({ ok: false, error: { reason: response.status === 401 ? 'authentication_required' : 'events_unavailable', retryable: response.status >= 500 } }, response.status);
      }
      const parser = createSseParser((frame) => {
        if (!isCurrent()) return;
        let payload;
        try { payload = JSON.parse(frame.data); } catch (_error) {
          options.onError?.(new BrowserBridgeError('invalid_event', { code: 'invalid_event' }));
          return;
        }
        if (!isRecord(payload)) return;
        const eventId = parseEventId(frame.id);
        if (!eventId || payload.api_version !== 1 || payload.boot_epoch !== eventId.bootEpoch
          || payload.cursor !== eventId.cursor || frame.event !== 'jenny') {
          options.onError?.(new BrowserBridgeError('invalid_event_envelope', { code: 'invalid_event' }));
          return;
        }
        if (eventId.bootEpoch !== this.bootEpoch) {
          options.onEpochMismatch?.(eventId.bootEpoch);
          return;
        }
        const nextCursor = eventId.cursor;
        if (nextCursor <= this.cursor && payload.event_type !== 'resync_required') return;
        this.cursor = Math.max(this.cursor, nextCursor);
        options.onEvent?.(payload);
      });
      const done = this._consumeEvents(response.body.getReader(), parser, abortController.signal)
        .finally(() => {
          if (this.eventsAbort === abortController) this.eventsAbort = null;
        });
      return { close: () => abortController.abort(), done };
    }

    async _consumeEvents(reader, parser, signal) {
      const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;
      try {
        while (!signal.aborted) {
          const result = await reader.read();
          if (signal.aborted) return;
          if (result.done) {
            parser.consume(decoder ? decoder.decode() : '', true);
            return;
          }
          parser.consume(decoder ? decoder.decode(result.value, { stream: true }) : String(result.value || ''));
        }
      } finally {
        try { await reader.cancel(); } catch (_error) { /* closed stream */ }
      }
    }

    closeEvents() {
      if (this.eventsAbort) this.eventsAbort.abort();
      this.eventsAbort = null;
    }

    clearCredentials() {
      this.identityGeneration += 1;
      this.closeEvents();
      this.csrfToken = '';
      this.bootEpoch = '';
      this.session = null;
      this.clientId = '';
      this.clientToken = '';
      this.cursor = 0;
    }

    async logout({ remote = true } = {}) {
      let failure = null;
      if (remote && this.csrfToken) {
        try {
          await this._request('/auth/logout', {
            method: 'POST',
            headers: { 'X-CSRF-Token': this.csrfToken },
          });
        } catch (error) {
          failure = error;
        }
      }
      this.clearCredentials();
      if (failure) throw failure;
      return { ok: true };
    }

    dispose() {
      this.disposed = true;
      this.clearCredentials();
    }
  }

  return { API_VERSION, DEFAULT_REQUEST_TIMEOUT_MS, ATTACHMENT_MIME_TYPES, ARTIFACT_MIME_TYPES, ARTIFACT_ID_PATTERN, BrowserBridge, BrowserBridgeError, createSseParser, parseEventId, artifactMimeType };
});
