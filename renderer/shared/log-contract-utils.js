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
  // Path bodies cross spaces ("G:\AI Tools\llama b10683\llama-server.exe");
  // stopping at the first whitespace leaked every name behind it. A segment
  // followed by a separator is a directory and keeps its space-joined words.
  // The final segment crosses a space only while the next word cannot be told
  // apart from the name. It ends after clause punctuation (", retrying" and
  // "? retrying" stay visible; a comma before a capitalised name stays inside,
  // "Smith, John.pdf"), a complete file name ("x.gguf in 3s"), a sentence
  // period (initials and abbreviations such as "Dr." stay inside) or an
  // unmatched ")", and before a verb that starts prose (" does not exist").
  // No crossing enters a flag, a shell operator, an error code, a key=value
  // field, another path or a word that holds the anchor of a secret rule
  // below: a path that swallowed "token:" and stopped at a pipe inside the
  // value would orphan the rest of the secret. Quotes, backticks (but see
  // POSIX_PATH_BODY), <>|, tabs, line breaks, double spaces and the end of the
  // text end a path body. Prose that cannot be told apart from an extensionless
  // name stays redacted: over-redacting a log line beats leaking a path's tail.
  // Every zero-width choice is exclusive, which keeps matching linear.
  // libuv codes, os.constants.errno names and the Win32/winsock name shapes.
  const ERROR_CODES = [
    'E2BIG', 'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EAGAIN', 'EALREADY', 'EBADF', 'EBADMSG',
    'EBUSY', 'ECANCELED', 'ECHARSET', 'ECHILD', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EDEADLK',
    'EDESTADDRREQ', 'EDOM', 'EDQUOT', 'EEXIST', 'EFAULT', 'EFBIG', 'EFTYPE', 'EHOSTDOWN', 'EHOSTUNREACH', 'EIDRM',
    'EILSEQ', 'EINPROGRESS', 'EINTR', 'EINVAL', 'EIO', 'EISCONN', 'EISDIR', 'ELOOP', 'EMFILE', 'EMLINK',
    'EMSGSIZE', 'EMULTIHOP', 'ENAMETOOLONG', 'ENETDOWN', 'ENETRESET', 'ENETUNREACH', 'ENFILE', 'ENOBUFS',
    'ENODATA', 'ENODEV', 'ENOENT', 'ENOEXEC', 'ENOLCK', 'ENOLINK', 'ENOMEM', 'ENOMSG', 'ENONET', 'ENOPROTOOPT',
    'ENOSPC', 'ENOSR', 'ENOSTR', 'ENOSYS', 'ENOTCONN', 'ENOTDIR', 'ENOTEMPTY', 'ENOTFOUND', 'ENOTSOCK',
    'ENOTSUP', 'ENOTTY', 'ENXIO', 'EOF', 'EOPNOTSUPP', 'EOVERFLOW', 'EPERM', 'EPIPE', 'EPROTO',
    'EPROTONOSUPPORT', 'EPROTOTYPE', 'ERANGE', 'EREMOTEIO', 'EROFS', 'ESHUTDOWN', 'ESOCKTNOSUPPORT', 'ESPIPE',
    'ESRCH', 'ESTALE', 'ETIME', 'ETIMEDOUT', 'ETXTBSY', 'EUNATCH', 'EWOULDBLOCK', 'EXDEV', 'UNKNOWN',
    'ERR_[A-Z0-9_]+', 'ERROR_[A-Z0-9_]+', 'WSA[A-Z0-9_]+', 'EAI_[A-Z]+',
  ];
  const PROSE_VERBS = [
    'is', 'isn', 'was', 'wasn', 'are', 'aren', 'does', 'doesn', 'did', 'didn', 'not', 'has', 'hasn',
    'have', 'haven', 'had', 'could', 'couldn', 'cannot', 'already', 'exited', 'failed',
  ];
  // Letters match either case without the i flag, which would also loosen the
  // case-sensitive path rules these sources are embedded in.
  const caseless = (source) => source.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
  const SECRET_KEYS = caseless('authorization|api[_-]?key|api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|dsn');
  // Where a secret rule below starts: a key, a bearer token or, for a crossing,
  // any URL. Value runs stop only at the URLs the DSN rules hide and swallow
  // any other, as before.
  const KEY_ANCHOR = String.raw`\b(?:${SECRET_KEYS}|${caseless('cookie')})\s*[:=]`;
  const BEARER_ANCHOR = String.raw`\b${caseless('bearer')}\s+[A-Za-z0-9._~+/=-]{6}`;
  const SECRET_ANCHOR = String.raw`(?:${KEY_ANCHOR}|${BEARER_ANCHOR}|\b[A-Za-z][A-Za-z0-9+.-]{0,15}:\/\/)`;
  const VALUE_STOP = String.raw`(?:${KEY_ANCHOR}|${BEARER_ANCHOR}|\b(?:${caseless(String.raw`postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp`)}:\/\/|${caseless('https?')}:\/\/[^:\s"'<>\/]+:[^@\s"'<>\/]+@))`;
  const PATH_SPACE = String.raw`[ \u00A0\u2000-\u200A\u202F\u205F\u3000]`;
  // A whole word, not the stem of a file name ("failed.log", "UNKNOWN.mp3").
  const WORD_END = String.raw`\b(?!\.[A-Za-z0-9])`;
  // "x.gguf", "main.c", "a.7z", "b.m4a", "c.log.1", "app.ts:10:5)", "d.xlsx**".
  const FILE_NAME_END = String.raw`\.(?:[A-Za-z]{2}[A-Za-z0-9]*|[a-z]\d[a-z0-9]*|[a-z]|\d[a-z][a-z0-9]*)(?:\.\d+)*(?::\d+)*[)\]}*_~’”»…—]*`;
  const DRIVE_ROOT = String.raw`[A-Za-z]:[\\/]`;
  const UNC_ROOT = String.raw`\\\\[A-Za-z0-9._$-]+\\`;
  const POSIX_ROOT = '/(?:Users|home|var|tmp|etc|opt|srv|root|private|workspace|mnt|Volumes)/';
  const TOKEN = String.raw`\[redacted:path\]`;
  // quotes: the quote marks that end a path besides whitespace and <>|.
  // kind: 'posix' lets a directory crossing run into another POSIX root;
  // 'value' ends the body where a value stops.
  function pathBody(quotes, kind) {
    const char = String.raw`(?:${kind === 'value' ? `(?!${VALUE_STOP})` : ''}[^\s${quotes}<>|\\/])`;
    const scan = String.raw`[^\s${quotes}<>|]*?`;
    const posixRootInWord = String.raw`${scan}(?<![^\s("':=,])${POSIX_ROOT}`;
    // Where the next word starts, or anywhere in it for a secret anchor.
    const refused = [
      String.raw`-[-A-Za-z]|&&|\d*[<>]|[-=]>|(?:${ERROR_CODES.join('|')})${WORD_END}`,
      String.raw`[A-Za-z_][\w.-]*=|[A-Za-z_][\w-]*:(?![\\/])|[A-Z][A-Z\d_]*:|${DRIVE_ROOT}|${TOKEN}|${scan}${SECRET_ANCHOR}`,
    ].join('|');
    // A later separator proves a directory, so its crossing may run into a
    // path list ("a b,C:\c"); only a POSIX list runs into a POSIX root.
    const directoryCrossing = [
      String.raw`(?<!${FILE_NAME_END}[,;:?!])`,
      PATH_SPACE,
      `(?!${refused}${kind === 'posix' ? '' : `|${posixRootInWord}`})`,
    ].join('');
    const nameCrossing = [
      String.raw`(?<![;:?!])(?<![\s\\/][^\s\\/(]*\))(?<![\s\\/][^\s\\/[]*\])(?<!${FILE_NAME_END})`,
      String.raw`(?:(?<!,)|(?<=,)(?<!${FILE_NAME_END},)(?=${PATH_SPACE}[A-Z](?![a-z]*ing\b)))`,
      String.raw`(?:(?<!\.)|(?<=[^A-Za-z0-9](?:[A-Z][a-z]{0,2}|vs)\.))`,
      PATH_SPACE,
      String.raw`(?!${refused}|${posixRootInWord}|${scan}(?:\b${DRIVE_ROOT}|${TOKEN}(?:(?!${TOKEN})${char})*[\\/])`,
      `|(?:${PROSE_VERBS.join('|')})${WORD_END})`,
    ].join('');
    return [
      String.raw`(?=[^\s${quotes}<>|])`,
      String.raw`(?:(?:${char}+(?:${directoryCrossing}${char}+)*)?[\\/])*`,
      `(?:${char}+(?:${nameCrossing}${char}+)*)?`,
      // Trailing punctuation stays outside only before whitespace or the end.
      String.raw`(?:(?<![,;:.?!])|(?<=[,;:.?!])(?=[^\s,;:.?!]))`,
    ].join('');
  }
  // A body runs on through an earlier redaction glued to it, as before.
  const PATH_BODY = pathBody(String.raw`"'\x60`, 'path');
  // POSIX paths ran on through a backtick before, so they still do, flat as
  // then, but stop where a value stops.
  const POSIX_PATH_BODY = String.raw`(?:${pathBody(String.raw`"'\x60`, 'posix')}|(?=\x60))(?:\x60(?:(?!${VALUE_STOP})[^\s"'<>|])*)?`;
  const POSIX_ROOT_PATH_RE = new RegExp(String.raw`(^|[\s(])${POSIX_ROOT}${POSIX_PATH_BODY}`, 'g');
  const POSIX_ROOT_PATH_AFTER_DELIMITER_RE = new RegExp(`(["':=,])${POSIX_ROOT}${POSIX_PATH_BODY}`, 'g');
  const DRIVE_PATH_RE = new RegExp(String.raw`\b${DRIVE_ROOT}${PATH_BODY}`, 'g');
  const UNC_PATH_RE = new RegExp(UNC_ROOT + PATH_BODY, 'g');
  // Known-prefix redaction keeps the relative tail ("[redacted:path]\AI Tools\x"),
  // or the rest of a name when the prefix ends inside one; the tail crosses
  // spaces by the same rules as any other path body.
  const REDACTED_PATH_TAIL_RE = new RegExp(String.raw`${TOKEN}(?:(?![)\]}])${PATH_BODY})?`, 'g');
  // A keyed value that starts with a prefix redaction takes the tail along, so
  // "token: [redacted:path]\My Keys\key.pem" cannot leave " Keys\key.pem". It
  // does so only when the tail ends where a value ends; otherwise the value
  // runs to whitespace, but not into a later secret. A value may start with a
  // key word ("password=Secret:x") but holds no later key.
  const VALUE_PATH_BODY = pathBody(String.raw`"'\x60,;{}`, 'value');
  const SECRET_VALUE = String.raw`(?:${TOKEN}(?:${VALUE_PATH_BODY}(?=[.:?!]*(?![^\s,;'"{}]))|(?:(?!${VALUE_STOP})[^\s,;'"{}])*)|[^\s,;'"{}](?:(?!${KEY_ANCHOR})[^\s,;'"{}])*)`;
  const COOKIE_VALUE_RE = new RegExp(String.raw`\b(${caseless('cookie')})\s*=\s*${SECRET_VALUE}`, 'g');
  const KEYED_SECRET_RE = new RegExp(String.raw`\b((?:${SECRET_KEYS})\s*[:=]\s*)(?:${caseless('bearer')}\s+)?${SECRET_VALUE}`, 'g');
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
      .replace(DRIVE_PATH_RE, '[redacted:path]')
      .replace(UNC_PATH_RE, '[redacted:path]')
      .replace(POSIX_ROOT_PATH_RE, (_match, prefix = '') => `${prefix}[redacted:path]`)
      .replace(POSIX_ROOT_PATH_AFTER_DELIMITER_RE, (_match, prefix = '') => `${prefix}[redacted:path]`)
      .replace(DATA_URI_RE, (_match, mediaType = '') => `data:${mediaType};base64,[redacted:data-uri]`)
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]')
      .replace(/\b(set-cookie|cookie)\s*:\s*[^\r\n]+/gi, '$1: [redacted]')
      .replace(COOKIE_VALUE_RE, '$1=[redacted]')
      .replace(KEYED_SECRET_RE, '$1[redacted]')
      .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"<>]+/gi, '[redacted:dsn]')
      .replace(/\bhttps?:\/\/[^:\s"'<>]+:[^@\s"'<>]+@[^\s"'<>]+/gi, '[redacted:dsn]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
      .replace(SECRET_SHAPE_RE, '[redacted:token]');
  }

  // For surfaces that must hide the whole path: collapses each [redacted:path]
  // token and the relative tail after it into one literal replacement.
  function collapseRedactedPathTails(value, replacement = '[redacted]') {
    return String(value).replace(REDACTED_PATH_TAIL_RE, () => replacement);
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
    collapseRedactedPathTails,
    isSensitiveLogKey,
    redactLogReportValue,
    redactLogText,
  };
});
