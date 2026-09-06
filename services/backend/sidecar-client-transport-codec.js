// Owns instance-independent frame/error primitives, depends only on Node globals,
// and must not import SidecarClient so dependency direction remains one-way.

// Mirrors sidecar/server.py MAX_CONTENT_LENGTH_BYTES: the sidecar's framed
// stdin reader raises terminally on a Content-Length above this (framing.py
// read_message -> BackgroundMessageReader._pump), so an oversized frame must
// never reach the pipe.
const MAX_OUTBOUND_FRAME_BODY_BYTES = 10 * 1024 * 1024;

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  return { frame: Buffer.concat([header, body]), bodyLength: body.length };
}

function parseContentLength(headerText) {
  const lines = String(headerText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^Content-Length:\s*(\d+)$/i);
    if (match) {
      return Number(match[1]);
    }
  }
  return 0;
}

function annotateSidecarError(error, {
  errorCode = '',
  category = '',
  cancelReason = '',
  terminalSubcode = '',
  retryable = true,
} = {}) {
  if (!error || typeof error !== 'object') {
    return error;
  }
  if (errorCode) {
    error.error_code = String(errorCode);
  }
  if (category) {
    error.category = String(category);
  }
  if (cancelReason) {
    error.cancel_reason = String(cancelReason);
    error.cancelReason = String(cancelReason);
  }
  if (terminalSubcode) {
    error.terminal_subcode = String(terminalSubcode);
  }
  error.retryable = retryable === true;
  return error;
}

module.exports = {
  MAX_OUTBOUND_FRAME_BODY_BYTES,
  annotateSidecarError,
  encodeFrame,
  parseContentLength,
};
