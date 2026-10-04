const http = require('http');

const MAX_BODY_CHARS = 1024 * 1024;
// The socket idle timeout never fires once the socket is destroyed, and it is
// reset by every byte of a trickling response, so each probe also carries an
// independent total deadline as a multiple of the idle timeout.
const DEADLINE_MULTIPLIER = 4;

// True only when `GET /api/tags` answers 2xx with a JSON body holding a models
// array. Resolves false, exactly once, on every other outcome.
function probeOllamaHealth({ host, port, timeoutMs, httpImpl = http } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let request = null;
    let deadline = null;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    deadline = setTimeout(() => {
      try {
        if (request) request.destroy();
      } catch (_error) {
        // best effort only
      }
      finish(false);
    }, DEADLINE_MULTIPLIER * timeoutMs);
    try {
      const url = `http://${host}:${port}/api/tags`;
      request = httpImpl.get(url, { timeout: timeoutMs }, (response) => {
        const statusCode = response.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          finish(false);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += String(chunk || '');
          if (body.length > MAX_BODY_CHARS) {
            request.destroy();
            finish(false);
          }
        });
        response.on('end', () => {
          try {
            const payload = JSON.parse(body);
            finish(Boolean(payload && Array.isArray(payload.models)));
          } catch (_error) {
            finish(false);
          }
        });
        // A response cut off mid-body never reaches 'end'.
        response.on('aborted', () => finish(false));
        response.on('error', () => finish(false));
        response.on('close', () => finish(false));
      });
      request.on('timeout', () => {
        request.destroy();
        finish(false);
      });
      request.on('error', () => finish(false));
    } catch (_error) {
      finish(false);
    }
  });
}

// True only when nothing is listening on the port (the connection is refused).
// A timeout, a reset, or any HTTP answer proves nothing about the daemon being
// gone: a hung daemon can still hold a model on the GPU.
function probeOllamaRefused({ host, port, timeoutMs, httpImpl = http } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let request = null;
    let deadline = null;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    deadline = setTimeout(() => {
      try {
        if (request) request.destroy();
      } catch (_error) {
        // best effort only
      }
      finish(false);
    }, DEADLINE_MULTIPLIER * timeoutMs);
    try {
      request = httpImpl.get(`http://${host}:${port}/api/tags`, { timeout: timeoutMs }, (response) => {
        response.resume();
        finish(false);
      });
      request.on('timeout', () => {
        request.destroy();
        finish(false);
      });
      request.on('error', (error) => finish(Boolean(error) && error.code === 'ECONNREFUSED'));
    } catch (_error) {
      finish(false);
    }
  });
}

module.exports = { probeOllamaHealth, probeOllamaRefused };
