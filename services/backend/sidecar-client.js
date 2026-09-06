const { EventEmitter } = require('events');

const { version: DEFAULT_CLIENT_VERSION } = require('../../package.json');

const { SIDECAR_ERROR_CODES } = require('./error-codes');
const {
  CANCEL_REASON_TIMEOUT,
  CANCEL_REASON_USER,
  cancelReasonFromError,
  normalizeCancelReason,
} = require('./chat-stream-terminal-utils');
const {
  MAX_OUTBOUND_FRAME_BODY_BYTES,
  annotateSidecarError,
  encodeFrame,
  parseContentLength,
} = require('./sidecar-client-transport-codec');
const { resolveRequestTimeoutMs } = require('./sidecar-request-timeouts');
const { initializePluginRuntime } = require('./sidecar-client-plugin-runtime');
const {
  endSidecarInput,
  requestSidecarShutdown,
} = require('./sidecar-client-shutdown');
const {
  emitSidecarErrorSafely,
} = require('./sidecar-client-reverse-rpc');
const { handleElectronToolRequest, handlePluginHostRequest } = require('./sidecar-client-request-rpc');
const { notifyEngineActivity, notifySessionRunModeUpdated } = require('./sidecar-client-notifications');
const { armPendingTimeout, suspendRequestTimeout } = require('./sidecar-client-request-timeout');

const API_VERSION = '2026-08-17';
const JSONRPC_VERSION = '2.0';
const CHAT_CANCEL_METHOD = 'chat.cancel';
const TOOL_REQUEST_APPROVAL_METHOD = 'tool.request_approval';
const TOOL_EXECUTE_ELECTRON_METHOD = 'tool.execute_electron';
const PLUGIN_HOST_METHOD = 'plugin.host';
const MCP_INSPECT_METHOD = 'mcp.inspect';
const JSONRPC_CANCEL_REQUEST_METHOD = '$/cancelRequest';
const MAX_HEADER_BYTES = 16 * 1024;
// Must stay aligned with MAX_IMAGE_SIZE_BYTES in services/attachment-asset-store.js:
// a near-cap image wrapped in a chat.send JSON envelope can still exceed this
// frame cap once JSON overhead is added. See docs/operations/resource-budgets.md
// § "Transport frame cap" for the alignment rationale.
const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const CANCELLED_REQUEST_TTL_MS = 5 * 60 * 1000;
const UNMATCHED_NOTIFICATION_MAX_ENTRIES = 1000;
const DEFAULT_SIDECAR_FEATURE_FLAGS = Object.freeze({
  multiplexer: true,
  chat_cancel: true,
});

class SidecarClient extends EventEmitter {
  constructor({ logger } = {}) {
    super({ captureRejections: true });
    this.logger = typeof logger === 'function' ? logger : null;
    this.process = null;
    this._resetStdoutBuffer();
    this.nextId = 1;
    this.pendingRequests = new Map();
    this.notificationHandlers = new Map();
    this.approvalHandlers = new Map();
    this.electronToolHandlers = new Map();
    this.pluginHostHandlers = new Map();
    this.cancelledRequestKeys = new Map();
    // Counts unmatched notifications by request_id so each request warns once.
    this.unmatchedNotificationCounts = new Map();
    this.sidecarFeatureFlags = { ...DEFAULT_SIDECAR_FEATURE_FLAGS };
    this.connected = false;
    this._handleStdoutData = this._handleStdoutData.bind(this);
    this._handleProcessExit = this._handleProcessExit.bind(this);
    this._handleStdinError = this._handleStdinError.bind(this);
  }

  _resetStdoutBuffer() {
    this.buffer = Buffer.alloc(0);
    this.bufferOffset = 0;
  }

  attachProcess(childProcess) {
    if (!childProcess || typeof childProcess !== 'object') {
      throw new Error('A child process is required to attach the sidecar client.');
    }
    this.detachProcess();
    this.process = childProcess;
    this._resetStdoutBuffer();
    this.sidecarFeatureFlags = { ...DEFAULT_SIDECAR_FEATURE_FLAGS };
    this.connected = true;

    if (this.process.stdout) {
      this.process.stdout.on('data', this._handleStdoutData);
    }
    if (this.process.stdin) {
      this.process.stdin.on('error', this._handleStdinError);
    }

    this.process.once('exit', this._handleProcessExit);
  }
  async initialize(payload = {}, { timeoutMs, signal, onProgress } = {}) {
    if (payload?.mode === 'plugin_runtime') return initializePluginRuntime(this, payload, { timeoutMs, signal });
    const { config = {}, secrets = {}, clientVersion = DEFAULT_CLIENT_VERSION } = payload || {};
    const requestId = `initialize-${this.nextId}`;
    this.notificationHandlers.set(requestId, typeof onProgress === 'function' ? onProgress : null);
    try {
      return await this.request('initialize', {
        accept_version: API_VERSION,
        client_version: clientVersion,
        request_id: requestId,
        config,
        secrets,
      }, {
        timeoutMs,
        signal,
        requestKey: requestId,
        initializeMode: 'full_runtime',
      });
    } finally {
      this.notificationHandlers.delete(requestId);
    }
  }

  async modelsList(engineType, options = {}) {
    const normalizedInspectModelId = String(options?.inspectModelId || '').trim();
    return this.request('models.list', {
      accept_version: API_VERSION,
      engine_type: String(engineType || '').trim() || 'mock',
      ...(normalizedInspectModelId ? { inspect_model_id: normalizedInspectModelId } : {}),
    });
  }
  async modelsUnload() {
    return this.request('models.unload', {
      accept_version: API_VERSION,
    });
  }

  async backgroundRun(task, params = {}) {
    const normalizedTask = String(task || '').trim().toLowerCase();
    if (!normalizedTask) {
      throw new Error('background.run requires a non-empty task.');
    }
    return this.request('background.run', {
      accept_version: API_VERSION,
      task: normalizedTask,
      ...params,
    });
  }

  async hardwareProfile(params = {}) {
    return this.request('hardware.profile', {
      accept_version: API_VERSION,
      ...params,
    });
  }

  async hardwareVramUsage() {
    return this.request('hardware.vram_usage', { accept_version: API_VERSION });
  }

  async modelsResident() {
    return this.request('models.resident', { accept_version: API_VERSION });
  }

  async modelsOllamaBlob(modelId) {
    return this.request('models.ollama_blob', { accept_version: API_VERSION, model_id: String(modelId || '') });
  }

  async harnessInspect(params = {}) {
    return this.request('harness.inspect', {
      accept_version: API_VERSION,
      ...params,
    });
  }

  async harnessTurnDiagnostic(params = {}) {
    return this.request('harness.turn_diagnostic', {
      accept_version: API_VERSION,
      ...params,
    });
  }

  async chatSend(params, {
    onNotification,
    onApprovalRequest,
    onElectronToolRequest,
    onPluginHostRequest,
    timeoutMs,
    signal,
  } = {}) {
    const requestId = String(params && params.request_id || '').trim();
    if (!requestId) {
      throw new Error('chat.send requires a non-empty request_id.');
    }
    this.notificationHandlers.set(requestId, onNotification || null);
    this.approvalHandlers.set(requestId, onApprovalRequest || null);
    this.electronToolHandlers.set(requestId, onElectronToolRequest || null);
    this.pluginHostHandlers.set(requestId, onPluginHostRequest || null);
    return this.request('chat.send', {
      accept_version: API_VERSION,
      ...params,
    }, {
      timeoutMs,
      signal,
      requestKey: requestId,
      onCleanup: () => {
        this.notificationHandlers.delete(requestId);
        this.approvalHandlers.delete(requestId);
        this.electronToolHandlers.delete(requestId);
        this.pluginHostHandlers.delete(requestId);
      },
    });
  }

  // Manual/on-demand compaction: runs an LLM summarization pass over the
  // session's history, hence the generous default timeout (mirrors the other
  // long-running sidecar calls, not the chat-turn-state polling timeout).
  async chatCompact(sessionId, messages, { timeoutMs, signal } = {}) {
    return this.request('chat.compact', {
      accept_version: API_VERSION,
      session_id: String(sessionId || '').trim(),
      messages,
    }, {
      timeoutMs: timeoutMs ?? 120_000,
      signal,
      requestKey: String(sessionId || '').trim(),
    });
  }

  async shutdown(options = {}) {
    return requestSidecarShutdown(this, { ...options, apiVersion: API_VERSION });
  }

  endInput(attachedProcess = this.process) {
    return endSidecarInput(attachedProcess);
  }

  async _requestWithTimeout(method, params, timeoutMs) {
    return this.request(method, params, { timeoutMs });
  }

  async request(method, params = {}, options = {}) {
    if (!this.process || !this.connected || !this.process.stdin) {
      throw new Error('Sidecar process is not connected.');
    }

    const id = this.nextId;
    this.nextId += 1;

    const payload = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      params,
    };
    const timeoutMs = resolveRequestTimeoutMs(method, options);
    const signal = options && typeof options === 'object' ? options.signal : null;
    const requestKey = String(
      options && typeof options === 'object' ? options.requestKey || '' : ''
    ).trim();
    const onCleanup = options && typeof options.onCleanup === 'function'
      ? options.onCleanup
      : null;

    return new Promise((resolve, reject) => {
      const pending = {
        id, resolve, reject, method, requestKey, onCleanup,
        initializeMode: String(options?.initializeMode || ''),
        timer: null, removeAbortListener: null, frameWritten: false,
        // suspendRequestTimeout() suspend state.
        timeoutMs: null, timeoutRemainingMs: 0, timeoutSuspendDepth: 0,
      };
      this.pendingRequests.set(id, pending);

      if (signal && typeof signal === 'object') {
        const handleAbort = () => {
          if (method === 'chat.send' && requestKey && this._batch4TransportEnabled()) {
            const cancelReason = this._cancelReasonFromSignal(signal, CANCEL_REASON_USER);
            this._recordCancelledRequestKey(requestKey);
            this._sendBestEffortChatCancel({
              requestId: requestKey,
              traceId: String(params && params.trace_id || '').trim() || requestKey,
              sessionId: String(params && params.session_id || '').trim(),
              cancelReason,
            });
          }
          if (method === MCP_INSPECT_METHOD && pending.frameWritten) {
            this._sendBestEffortRequestCancel(id);
          }
          this._finalizePendingRequest(id, {
            type: 'reject',
            error: this._createAbortError(method, signal),
          });
        };
        if (signal.aborted) {
          handleAbort();
          return;
        }
        signal.addEventListener('abort', handleAbort, { once: true });
        pending.removeAbortListener = () => {
          signal.removeEventListener('abort', handleAbort);
        };
      }

      if (timeoutMs != null) {
        pending.timeoutMs = timeoutMs;
        pending.timeoutRemainingMs = timeoutMs;
        armPendingTimeout(this, pending, timeoutMs);
      }

      const onWriteError = (error) => {
        this._finalizePendingRequest(id, {
          type: 'reject',
          error: this._createStdinWriteError(error),
        });
      };
      if (!this._writeFrame(payload, { onWriteError, onThrow: onWriteError })) {
        onWriteError(new Error('Sidecar process is not connected.'));
      } else {
        pending.frameWritten = true;
      }
    });
  }

  _createTimeoutError(method, timeoutMs) {
    return annotateSidecarError(
      new Error(`Sidecar ${method} timed out after ${timeoutMs}ms`),
      {
        errorCode: SIDECAR_ERROR_CODES.TIMEOUT,
        category: 'timeout',
        retryable: true,
      }
    );
  }

  // Extends a pending request's RPC deadline by an ask_user human-wait; see
  // sidecar-client-request-timeout.js.
  suspendRequestTimeout(requestKey) {
    return suspendRequestTimeout(this, requestKey);
  }

  _cancelReasonFromSignal(signal, fallback = CANCEL_REASON_USER) {
    const reason = signal && 'reason' in signal
      ? signal.reason
      : null;
    if (reason instanceof Error) {
      return cancelReasonFromError(reason, fallback);
    }
    if (typeof reason === 'string' && reason.trim()) {
      return normalizeCancelReason(reason, fallback);
    }
    return normalizeCancelReason('', fallback);
  }

  _createAbortError(method, signal) {
    const reason = signal && 'reason' in signal
      ? signal.reason
      : null;
    const cancelReason = this._cancelReasonFromSignal(
      signal,
      method === 'chat.send' ? CANCEL_REASON_USER : 'transport_abort'
    );
    if (reason instanceof Error) {
      return annotateSidecarError(reason, {
        errorCode: reason.error_code || SIDECAR_ERROR_CODES.ABORTED,
        category: reason.category || (cancelReason === CANCEL_REASON_TIMEOUT ? 'timeout' : 'cancelled'),
        cancelReason,
        terminalSubcode: cancelReason,
        retryable: true,
      });
    }
    if (typeof reason === 'string' && reason.trim()) {
      return annotateSidecarError(new Error(reason.trim()), {
        errorCode: SIDECAR_ERROR_CODES.ABORTED,
        category: 'cancelled',
        cancelReason,
        terminalSubcode: cancelReason,
        retryable: true,
      });
    }
    const error = new Error(`Sidecar ${method} aborted.`);
    error.name = 'AbortError';
    return annotateSidecarError(error, {
      errorCode: SIDECAR_ERROR_CODES.ABORTED,
      category: 'cancelled',
      cancelReason,
      terminalSubcode: cancelReason,
      retryable: true,
    });
  }

  _createStdinWriteError(error) {
    const writeError = error instanceof Error
      ? error
      : new Error(String(error || 'Sidecar stdin write failed.'));
    return annotateSidecarError(writeError, {
      errorCode: SIDECAR_ERROR_CODES.TRANSPORT,
      category: 'transport',
      // Preserve a pre-annotated non-retryable verdict (e.g. the oversized
      // frame error: resending the same payload cannot succeed).
      retryable: writeError.retryable !== false,
    });
  }

  _createOversizedFrameError(bodyLength) {
    const error = new Error(
      `Sidecar request frame is ${bodyLength} bytes, exceeding the `
      + `${MAX_OUTBOUND_FRAME_BODY_BYTES}-byte protocol cap.`
    );
    error.error_type = 'FrameTooLargeError';
    error.error_message = error.message;
    // Not retryable: resending the same oversized payload cannot succeed.
    return annotateSidecarError(error, {
      errorCode: SIDECAR_ERROR_CODES.TRANSPORT,
      category: 'transport',
      retryable: false,
    });
  }

  _writeFrame(message, { onWriteError, onThrow } = {}) {
    if (!this.process || !this.connected || !this.process.stdin) {
      return false;
    }
    const handleWriteError = typeof onWriteError === 'function'
      ? onWriteError
      : this._handleStdinError;
    const handleThrow = typeof onThrow === 'function'
      ? onThrow
      : handleWriteError;
    const { frame, bodyLength } = encodeFrame(message);
    if (bodyLength > MAX_OUTBOUND_FRAME_BODY_BYTES) {
      // The sidecar's stdin reader dies terminally on an oversized
      // Content-Length, so the frame must never reach the pipe. Requests
      // reject with a typed error via onWriteError; response/notification
      // frames are dropped (the sidecar's own bounded wait expires) rather
      // than routed to _handleStdinError, which would tear down the healthy
      // transport and reject every pending request.
      if (typeof onWriteError === 'function') {
        onWriteError(this._createOversizedFrameError(bodyLength));
      } else if (this.logger) {
        this.logger('WARN', 'sidecar.outbound_frame_too_large', {
          bodyLength,
          maxBytes: MAX_OUTBOUND_FRAME_BODY_BYTES,
          method: String((message && message.method) || ''),
        });
      }
      return true;
    }
    try {
      this.process.stdin.write(frame, (error) => {
        if (error) {
          handleWriteError(error);
        }
      });
      return true;
    } catch (error) {
      handleThrow(error);
      return true;
    }
  }

  _finalizePendingRequest(id, outcome) {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return false;
    }
    this.pendingRequests.delete(id);

    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    if (typeof pending.removeAbortListener === 'function') {
      pending.removeAbortListener();
    }
    if (pending.requestKey) {
      this.unmatchedNotificationCounts.delete(pending.requestKey);
      this.notificationHandlers.delete(pending.requestKey);
      this.approvalHandlers.delete(pending.requestKey);
      this.electronToolHandlers.delete(pending.requestKey);
      this.pluginHostHandlers.delete(pending.requestKey);
      if (outcome && outcome.type === 'resolve') {
        this.cancelledRequestKeys.delete(pending.requestKey);
      }
    }
    if (typeof pending.onCleanup === 'function') {
      try {
        pending.onCleanup();
      } catch (error) {
        this.emit('error', error);
      }
    }
    if (outcome && outcome.type === 'resolve') {
      pending.resolve(outcome.value || {});
      return true;
    }
    pending.reject(outcome && outcome.error ? outcome.error : new Error('Sidecar request failed.'));
    return true;
  }

  detachProcess() {
    if (!this.process) {
      this.connected = false;
      this._resetStdoutBuffer();
      return;
    }

    if (this.process.stdout && typeof this.process.stdout.off === 'function') {
      this.process.stdout.off('data', this._handleStdoutData);
    } else if (this.process.stdout && typeof this.process.stdout.removeListener === 'function') {
      this.process.stdout.removeListener('data', this._handleStdoutData);
    }
    if (this.process.stdin && typeof this.process.stdin.off === 'function') {
      this.process.stdin.off('error', this._handleStdinError);
    } else if (this.process.stdin && typeof this.process.stdin.removeListener === 'function') {
      this.process.stdin.removeListener('error', this._handleStdinError);
    }

    if (typeof this.process.off === 'function') {
      this.process.off('exit', this._handleProcessExit);
    } else if (typeof this.process.removeListener === 'function') {
      this.process.removeListener('exit', this._handleProcessExit);
    }

    this.process = null;
    this.connected = false;
    this._resetStdoutBuffer();
    this.sidecarFeatureFlags = { ...DEFAULT_SIDECAR_FEATURE_FLAGS };
  }

  dispose() {
    this.detachProcess();
    this._rejectAllPending(new Error('Sidecar client disposed.'));
    this.notificationHandlers.clear();
    this.approvalHandlers.clear();
    this.electronToolHandlers.clear();
    this.pluginHostHandlers.clear();
    this.cancelledRequestKeys.clear();
    this.unmatchedNotificationCounts.clear();
    this.sidecarFeatureFlags = { ...DEFAULT_SIDECAR_FEATURE_FLAGS };
  }

  _rejectAllPending(error) {
    for (const id of [...this.pendingRequests.keys()]) {
      this._finalizePendingRequest(id, {
        type: 'reject',
        error,
      });
    }
  }

  _handleStdoutData(chunk) {
    try {
      this._handleStdoutChunk(chunk);
    } catch (error) {
      this._rejectAllPending(error);
      this.emit('error', error);
    }
  }

  _handleStdinError(error) {
    const writeError = this._createStdinWriteError(error);
    const pendingCount = this.pendingRequests.size;
    this.connected = false;
    if (this.logger) {
      this.logger('WARN', 'sidecar.stdin_error', {
        code: writeError.code || null,
        message: writeError.message || String(writeError),
        pendingRequests: pendingCount,
      });
    }
    this._rejectAllPending(writeError);
    if (this.listenerCount('error') > 0) {
      this.emit('error', writeError);
    }
  }

  _handleProcessExit(code, signal) {
    const currentProcess = this.process;
    if (currentProcess?.stdout && typeof currentProcess.stdout.off === 'function') {
      currentProcess.stdout.off('data', this._handleStdoutData);
    } else if (currentProcess?.stdout && typeof currentProcess.stdout.removeListener === 'function') {
      currentProcess.stdout.removeListener('data', this._handleStdoutData);
    }
    if (currentProcess?.stdin && typeof currentProcess.stdin.off === 'function') {
      currentProcess.stdin.off('error', this._handleStdinError);
    } else if (currentProcess?.stdin && typeof currentProcess.stdin.removeListener === 'function') {
      currentProcess.stdin.removeListener('error', this._handleStdinError);
    }
    const pendingCount = this.pendingRequests.size;
    this.connected = false;
    this.process = null;
    this._resetStdoutBuffer();
    const message = new Error(
      `Sidecar process exited (code=${code == null ? 'null' : code} signal=${signal || 'none'}).`
    );
    annotateSidecarError(message, {
      errorCode: SIDECAR_ERROR_CODES.PROCESS_EXIT,
      category: 'process_exit',
      retryable: true,
    });
    if (this.logger) {
      this.logger('WARN', 'sidecar.process_exit', {
        code: code == null ? null : code,
        signal: signal || null,
        pendingRequests: pendingCount,
      });
    }
    this._rejectAllPending(message);
    this.emit('exit', { code, signal });
  }

  _handleStdoutChunk(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.bufferOffset === this.buffer.length
      ? incoming
      : Buffer.concat([this.buffer.subarray(this.bufferOffset), incoming]);
    this.bufferOffset = 0;
    while (this.bufferOffset < this.buffer.length) {
      const availableBytes = this.buffer.length - this.bufferOffset;
      const separatorIndex = this.buffer.indexOf('\r\n\r\n', this.bufferOffset);
      if (separatorIndex === -1) {
        if (availableBytes > MAX_HEADER_BYTES) this._failTransport(new Error('Sidecar transport header exceeded the maximum allowed size.'));
        break;
      }
      const headerLength = separatorIndex - this.bufferOffset;
      if (headerLength > MAX_HEADER_BYTES) this._failTransport(new Error('Sidecar transport header exceeded the maximum allowed size.'));
      if (availableBytes > headerLength + 4 + MAX_FRAME_BYTES) this._failTransport(new Error('Sidecar transport exceeded the maximum buffered frame size.'));
      const contentLength = parseContentLength(this.buffer.toString('utf8', this.bufferOffset, separatorIndex));
      if (!contentLength || contentLength > MAX_FRAME_BYTES) this._failTransport(new Error('Sidecar transport declared an invalid frame size.'));
      if (availableBytes < headerLength + 4 + contentLength) break;
      const bodyStart = separatorIndex + 4;
      const bodyBuffer = this.buffer.subarray(bodyStart, bodyStart + contentLength);
      this.bufferOffset = bodyStart + contentLength;
      let message;
      try {
        message = JSON.parse(bodyBuffer.toString('utf8'));
      } catch (parseError) {
        if (this.logger) {
          this.logger('ERROR', 'sidecar.frame_parse_error', {
            byteLength: bodyBuffer.length,
            message: parseError.message || String(parseError),
          });
        }
        this.emit('parse-error', parseError);
        continue;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        if (this.logger) {
          this.logger('WARN', 'sidecar.invalid_message_type', {
            type: typeof message,
          });
        }
        continue;
      }
      this._handleMessage(message);
    }
    const remainingBytes = this.buffer.length - this.bufferOffset;
    if (remainingBytes === 0) this._resetStdoutBuffer();
    else if (this.buffer.buffer.byteLength >= 64 * 1024 && remainingBytes <= 4 * 1024) {
      // Copy tiny tails out of large allocations so partial frames do not pin the parent.
      this.buffer = Buffer.from(this.buffer.subarray(this.bufferOffset));
      this.bufferOffset = 0;
    }
  }

  _failTransport(error) {
    annotateSidecarError(error, {
      errorCode: SIDECAR_ERROR_CODES.TRANSPORT,
      category: 'transport',
      retryable: true,
    });
    this._resetStdoutBuffer();
    this.detachProcess();
    this._rejectAllPending(error);
    this.notificationHandlers.clear();
    this.approvalHandlers.clear();
    this.electronToolHandlers.clear();
    this.pluginHostHandlers.clear();
    this.unmatchedNotificationCounts.clear();
    throw error;
  }

  [Symbol.for('nodejs.rejection')](error, eventName, message) {
    const normalizedEventName = String(eventName || '').trim();
    if (normalizedEventName === 'notification' || normalizedEventName === 'late-notification') {
      this._logNotificationListenerFailure(error, message, normalizedEventName);
      return;
    }
    if (this.logger) {
      this.logger('WARN', 'sidecar.event_listener_rejection', {
        event_name: normalizedEventName,
        message: String(error?.message || error || '').slice(0, 500),
      });
    }
  }

  _handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
      if (!this.pendingRequests.has(message.id)) {
        if (this.logger) {
          this.logger('WARN', 'sidecar.unmatched_response', {
            incoming_id: message.id,
            has_error: Boolean(message.error),
          });
        }
        return;
      }
      const pending = this.pendingRequests.get(message.id);
      if (message.error) {
        const error = new Error(
          String(
            message.error.message ||
            message.error.data?.detail ||
            message.error.data?.error_code ||
            message.error.data?.code ||
            'Sidecar request failed.'
          )
        );
        error.rpc = message.error;
        annotateSidecarError(error, {
          // Python sidecar errors carry their semantic CMP code under
          // data.error_code; Electron tool-bridge errors use data.code. Read
          // error_code first so harness codes (e.g. CMP-HARN-0001) survive,
          // and keep data.code so tool-bridge codes (CMP-TOOL-0008) still work.
          errorCode: String(message.error?.data?.error_code || message.error?.data?.code || SIDECAR_ERROR_CODES.RPC),
          category: String(message.error?.data?.category || 'rpc'),
          retryable: message.error?.data?.retryable !== false,
        });
        this._finalizePendingRequest(message.id, {
          type: 'reject',
          error,
        });
        return;
      }
      if (
        pending
        && pending.method === 'initialize'
        && pending.initializeMode !== 'plugin_runtime'
        && message.result
        && typeof message.result === 'object'
      ) {
        this._setSidecarFeatureFlags(message.result.feature_flags);
      }
      this._finalizePendingRequest(message.id, {
        type: 'resolve',
        value: message.result || {},
      });
      return;
    }

    if (message.method === TOOL_REQUEST_APPROVAL_METHOD) {
      void this._handleApprovalRequest(message);
      return;
    }

    if (message.method === TOOL_EXECUTE_ELECTRON_METHOD) {
      void this._handleElectronToolExecuteRequest(message);
      return;
    }

    if (message.method === PLUGIN_HOST_METHOD) {
      void this._handlePluginHostRequest(message);
      return;
    }

    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const requestId = String(params.request_id || '').trim();
    const handler = requestId ? this.notificationHandlers.get(requestId) : null;
    if (typeof handler === 'function') {
      try {
        const result = handler(message);
        this._observeNotificationListenerResult(result, message, 'request_handler');
      } catch (error) {
        this._logNotificationListenerFailure(error, message, 'request_handler');
      }
    } else if (
      requestId
      && this._batch4TransportEnabled()
      && this._isCancelledRequestKey(requestId)
    ) {
      if (this.logger) {
        this.logger('WARN', 'sidecar.late_notification', {
          request_id: requestId,
          trace_id: String(params.trace_id || requestId).trim() || requestId,
          late_event: true,
          incoming_method: String(message.method || '').trim(),
          incoming_id: Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : null,
        });
      }
      this._safeEmitNotificationEvent('late-notification', message);
    } else if (requestId) {
      // Warn once per request_id because a dead stream can emit many notifications;
      // continue counting subsequent events.
      const unmatchedCount = (this.unmatchedNotificationCounts.get(requestId) || 0) + 1;
      this.unmatchedNotificationCounts.delete(requestId);
      this.unmatchedNotificationCounts.set(requestId, unmatchedCount);
      while (this.unmatchedNotificationCounts.size > UNMATCHED_NOTIFICATION_MAX_ENTRIES) {
        this.unmatchedNotificationCounts.delete(this.unmatchedNotificationCounts.keys().next().value);
      }
      if (unmatchedCount === 1 && this.logger) {
        this.logger('WARN', 'sidecar.unmatched_notification', {
          request_id: requestId,
          incoming_method: String(message.method || '').trim(),
        });
      }
    }
    this._safeEmitNotificationEvent('notification', message);
  }

  _logNotificationListenerFailure(error, message, source = 'event_listener') {
    if (!this.logger) {
      return;
    }
    const params = message?.params && typeof message.params === 'object' ? message.params : {};
    const requestId = String(params.request_id || '').trim();
    this.logger('WARN', 'sidecar.notification_listener_failed', {
      request_id: requestId,
      trace_id: String(params.trace_id || requestId).trim() || requestId,
      incoming_method: String(message?.method || '').trim(),
      incoming_id: Object.prototype.hasOwnProperty.call(message || {}, 'id') ? message.id : null,
      source,
      message: String(error?.message || error || '').slice(0, 500),
    });
  }

  _safeEmitNotificationEvent(eventName, message) {
    try {
      this.emit(eventName, message);
    } catch (error) {
      this._logNotificationListenerFailure(error, message, eventName);
    }
  }

  _observeNotificationListenerResult(result, message, source) {
    if (!result || typeof result.then !== 'function') {
      return;
    }
    result.catch((error) => {
      this._logNotificationListenerFailure(error, message, source);
    });
  }

  async _handleApprovalRequest(message) {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const requestId = String(params.request_id || '').trim();
    const handler = requestId ? this.approvalHandlers.get(requestId) : null;
    const isLateCancelledApproval =
      requestId
      && this._batch4TransportEnabled()
      && this._isCancelledRequestKey(requestId);
    let approvalResult = false;
    let handlerError = null;

    if (isLateCancelledApproval) {
      if (this.logger) {
        this.logger('WARN', 'sidecar.late_approval_request', {
          request_id: requestId,
          trace_id: String(params.trace_id || requestId).trim() || requestId,
          late_event: true,
          incoming_method: TOOL_REQUEST_APPROVAL_METHOD,
          incoming_id: message.id,
        });
      }
      this._safeEmitNotificationEvent('late-notification', message);
    }

    try {
      if (!isLateCancelledApproval && typeof handler === 'function') {
        approvalResult = await handler(params);
      }
    } catch (error) {
      approvalResult = false;
      handlerError = error instanceof Error ? error : new Error(String(error));
    } finally {
      this._writeFrame({
        jsonrpc: JSONRPC_VERSION,
        id: message.id,
        result: approvalResult && typeof approvalResult === 'object'
          ? {
            approved: approvalResult.approved === true,
            ...(typeof approvalResult.decision === 'string'
              ? { decision: approvalResult.decision.slice(0, 40) }
              : {}),
            ...(typeof approvalResult.feedback === 'string'
              ? { feedback: approvalResult.feedback.slice(0, 800) }
              : {}),
          }
          : { approved: approvalResult === true },
      });
    }

    if (handlerError) {
      emitSidecarErrorSafely(this, handlerError, 'approval_handler');
    }
  }

  async _handleElectronToolExecuteRequest(message) {
    return handleElectronToolRequest(this, message);
  }

  async _handlePluginHostRequest(message) {
    return handlePluginHostRequest(this, message);
  }

  _recordCancelledRequestKey(requestKey) {
    const normalized = String(requestKey || '').trim();
    if (!normalized) {
      return;
    }
    this._pruneCancelledRequestKeys();
    this.cancelledRequestKeys.set(normalized, Date.now() + CANCELLED_REQUEST_TTL_MS);
  }

  _isCancelledRequestKey(requestKey) {
    const normalized = String(requestKey || '').trim();
    if (!normalized) {
      return false;
    }
    this._pruneCancelledRequestKeys();
    return this.cancelledRequestKeys.has(normalized);
  }

  _pruneCancelledRequestKeys() {
    const now = Date.now();
    for (const [requestKey, expiresAt] of this.cancelledRequestKeys.entries()) {
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        this.cancelledRequestKeys.delete(requestKey);
      }
    }
  }

  _setSidecarFeatureFlags(value) {
    const nextFlags = { ...DEFAULT_SIDECAR_FEATURE_FLAGS };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, rawValue] of Object.entries(value)) {
        if (typeof rawValue !== 'boolean') {
          continue;
        }
        nextFlags[String(key || '').trim().toLowerCase()] = rawValue;
      }
    }
    this.sidecarFeatureFlags = nextFlags;
  }

  _batch4TransportEnabled() {
    return this.sidecarFeatureFlags.multiplexer === true
      && this.sidecarFeatureFlags.chat_cancel === true;
  }

  // Fire-and-forget notification (no id, no response): the managed local
  // engine produced observable work (decode/prompt-eval/load telemetry on its
  // captured stderr). Feeds the sidecar's stream-inactivity watchdog so a
  // silently-busy engine (Ollama buffering a huge tool call) is not killed as
  // hung. Throttled by the caller; routed by the sidecar multiplexer.
  notifyEngineActivity() {
    notifyEngineActivity(this);
  }

  notifySessionRunModeUpdated(params = {}) {
    notifySessionRunModeUpdated(this, params);
  }

  _sendBestEffortChatCancel({ requestId, traceId, sessionId, cancelReason } = {}) {
    const normalizedRequestId = String(requestId || '').trim();
    const normalizedTraceId = String(traceId || '').trim() || normalizedRequestId;
    const normalizedSessionId = String(sessionId || '').trim();
    const normalizedCancelReason = normalizeCancelReason(cancelReason, CANCEL_REASON_USER);
    if (!normalizedRequestId || !this.process || !this.process.stdin || !this.connected) {
      return;
    }
    const id = this.nextId;
    this.nextId += 1;
    this._writeFrame({
      jsonrpc: JSONRPC_VERSION,
      id,
      method: CHAT_CANCEL_METHOD,
      params: {
        accept_version: API_VERSION,
        request_id: normalizedRequestId,
        trace_id: normalizedTraceId,
        ...(normalizedSessionId ? { session_id: normalizedSessionId } : {}),
        cancel_reason: normalizedCancelReason,
      },
    }, {
      onThrow: (error) => {
        if (this.logger) {
          this.logger('WARN', 'sidecar.chat_cancel_send_failed', {
            request_id: normalizedRequestId,
            message: error?.message || String(error),
          });
        }
      },
    });
  }

  _sendBestEffortRequestCancel(requestId) {
    if (!this.process || !this.process.stdin || !this.connected) return;
    this._writeFrame({
      jsonrpc: JSONRPC_VERSION,
      method: JSONRPC_CANCEL_REQUEST_METHOD,
      params: { id: requestId },
    }, { onThrow: () => {} });
  }
}

module.exports = {
  API_VERSION,
  MAX_FRAME_BYTES,
  MAX_HEADER_BYTES,
  SidecarClient,
  TOOL_EXECUTE_ELECTRON_METHOD,
  TOOL_REQUEST_APPROVAL_METHOD,
  PLUGIN_HOST_METHOD,
};
