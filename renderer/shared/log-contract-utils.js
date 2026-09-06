(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.logContractUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LOG_RETENTION = Object.freeze({
    mainStoreLimit: 400,
    rendererRetainedLimit: 500,
    rendererTrimThreshold: 550,
    diagnosticsCurrentRunLimit: 750,
    diagnosticsPriorRunLimit: 250,
    observabilityRecentLogLimit: 50,
  });

  // Single redaction vocabulary for every JS log surface.
  //
  // services/log-entry-normalizer.js is the only require seam into this module,
  // so main.js log(), services/main/client-log-forwarding.js,
  // services/backend/turn-diagnostic-dump.js and
  // the renderer's user-facing log-report copy all share whatever this file
  // redacts. Before these three constants existed the general path was strictly
  // weaker than the canonical turn-event sanitizer: sentinel ghp_/hf_/xoxb-/AKIA
  // tokens, JWTs, POSIX root paths and base64 data URIs survived into the very
  // artifact a user pastes into a bug report.
  //
  // Shapes are copied verbatim from the two already-reviewed sources so the
  // three vocabularies cannot drift again:
  //   - POSIX root anchoring: services/backend/canonical-turn-event.js:180-181
  //     (root-anchored on purpose — an unanchored rule mangles ordinary prose
  //     and route strings like "GET /api/users" into [redacted:path]).
  //   - Secret shapes + data URI: sidecar/ai/tools/sanitization.py:49-70.
  // Deliberately a strict SUPERSET of the vocabularies it replaces: the
  // ``(?:sk|pk|tok|gh[pousr])_`` prefix group is the canonical-turn-event
  // SECRET_VALUE_RE form (which older diagnostic review code used to carry a
  // near-copy of), unioned with the sanitization.py shape list.
  const SECRET_SHAPE_RE = /\b(?:(?:sk|pk|tok|gh[pousr])_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs][-_][A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_.+/=-]{8,})\b/g;
  const POSIX_ROOT_PATH_RE = /(^|[\s(])\/(?:Users|home|var|tmp|etc|opt|srv|root|private|workspace|mnt|Volumes)\/[^\s"'<>|]+/g;
  const POSIX_ROOT_PATH_AFTER_DELIMITER_RE = /(["':=,])\/(?:Users|home|var|tmp|etc|opt|srv|root|private|workspace|mnt|Volumes)\/[^\s"'<>|]+/g;
  // Deliberately looser than sanitization.py's {256,}: that rule guards model
  // input, this one guards a log line where a short embedded payload is already
  // unreadable noise and may carry private content.
  const DATA_URI_RE = /\bdata:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/=]{64,}/gi;

  function normalizeString(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).trim();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isSensitiveLogKey(key) {
    const normalized = normalizeString(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalized) {
      return false;
    }
    return normalized === 'authorization'
      || normalized === 'contentpreview'
      || normalized === 'email'
      || normalized.endsWith('email')
      || normalized === 'apikey'
      || normalized === 'token'
      || normalized.endsWith('token')
      || normalized === 'secret'
      || normalized.endsWith('secret')
      || normalized === 'password'
      || normalized.endsWith('password')
      || normalized === 'dsn'
      || normalized.endsWith('dsn')
      || normalized === 'cookie'
      || normalized === 'setcookie'
      || normalized === 'privatekey'
      || normalized.endsWith('credential');
  }

  function redactPathPrefixes(text, prefixes) {
    let out = text;
    const values = Array.isArray(prefixes) ? prefixes : [];
    for (const prefix of values) {
      const normalized = normalizeString(prefix);
      if (!normalized) {
        continue;
      }
      const candidates = new Set([
        normalized,
        normalized.replace(/\\/g, '/'),
        normalized.replace(/\//g, '\\'),
      ]);
      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }
        out = out.replace(new RegExp(escapeRegExp(candidate), 'gi'), '[redacted:path]');
      }
    }
    return out;
  }

  function redactLogText(value, options = {}) {
    let text = String(value);
    text = redactPathPrefixes(text, options.prefixes);
    return text
      .replace(/\b[A-Za-z]:[\\/][^\s"'`<>|]+/g, '[redacted:path]')
      .replace(/\\\\[A-Za-z0-9._$-]+\\[^\s"'`<>|]+/g, '[redacted:path]')
      .replace(POSIX_ROOT_PATH_RE, (_match, prefix = '') => `${prefix}[redacted:path]`)
      .replace(POSIX_ROOT_PATH_AFTER_DELIMITER_RE, (_match, prefix = '') => `${prefix}[redacted:path]`)
      .replace(DATA_URI_RE, (_match, mediaType = '') => `data:${mediaType};base64,[redacted:data-uri]`)
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]')
      .replace(/\b(set-cookie|cookie)\s*:\s*[^\r\n]+/gi, '$1: [redacted]')
      .replace(/\b(cookie)\s*=\s*[^\s,;'"{}]+/gi, '$1=[redacted]')
      .replace(
        /\b((?:authorization|api[_-]?key|api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|dsn)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;'"{}]+/gi,
        '$1[redacted]'
      )
      .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"<>]+/gi, '[redacted:dsn]')
      .replace(/\bhttps?:\/\/[^:\s"'<>]+:[^@\s"'<>]+@[^\s"'<>]+/gi, '[redacted:dsn]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
      .replace(SECRET_SHAPE_RE, '[redacted:token]');
  }

  function redactLogReportValue(value, options = {}, seen = new WeakSet(), key = '') {
    if (isSensitiveLogKey(key)) {
      return '[redacted]';
    }
    if (typeof value === 'string') {
      return redactLogText(value, options);
    }
    if (value == null || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value !== 'object') {
      return redactLogText(value, options);
    }
    if (seen.has(value)) {
      return '[redacted:circular]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
      const out = value.map((entry) => redactLogReportValue(entry, options, seen));
      seen.delete(value);
      return out;
    }
    const out = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      out[entryKey] = redactLogReportValue(entryValue, options, seen, entryKey);
    }
    seen.delete(value);
    return out;
  }

  return {
    DATA_URI_RE,
    LOG_RETENTION,
    POSIX_ROOT_PATH_AFTER_DELIMITER_RE,
    POSIX_ROOT_PATH_RE,
    SECRET_SHAPE_RE,
    isSensitiveLogKey,
    redactLogReportValue,
    redactLogText,
  };
});
