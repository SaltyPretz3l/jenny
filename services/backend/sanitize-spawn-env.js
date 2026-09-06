/**
 * sanitize-spawn-env — deny-first environment-variable filter for
 * child-process spawn sites, plus a small ``maskToken`` helper for
 * log hygiene.
 *
 * Why this exists
 * ---------------
 * Several spawn sites in ``services/backend`` historically cloned
 * ``process.env`` wholesale into the child.  Credential-shaped keys
 * (API_KEY, TOKEN, SECRET, PASSWORD, PRIVATE_KEY, etc.) leak through
 * that path into every Ollama/vLLM subprocess, which means any
 * misbehaving downstream tool or logging path sees the parent
 * process's credentials even when the child has no business with them.
 * The threat model: the subprocess itself is trusted, but its stdout/
 * stderr, crash dumps, and any in-process telemetry are not — a single
 * stack trace containing the env table would be enough to exfiltrate
 * secrets into a log file.
 *
 * Posture
 * -------
 * Deny-first: if a key's name matches the credential regex, it is
 * stripped regardless of value shape.  A small allowlist of
 * system-essential keys (PATH, HOME, SYSTEMROOT, etc.) is always
 * preserved.  Callers can ``options.allow`` extra regex patterns for
 * engine-specific vars (``OLLAMA_*``, ``VLLM_*``), or
 * ``options.extraDeny`` to tighten the deny list further.
 *
 * Non-goals
 * ---------
 * - We do not inspect values — only key names.  A value that happens
 *   to contain an API key but lives under a benign key (e.g.
 *   ``FOO_CONFIG=api_key=sk-...``) will pass through.  That shape is
 *   the caller's responsibility, not this module's.
 * - We do not touch ``process.env``.  ``sanitizeSpawnEnv`` returns a
 *   fresh object; the caller passes it into ``spawn``.
 */

'use strict';

const CREDENTIAL_KEY_RE = /(^|_)(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?KEY|SESSION[_-]?KEY|BEARER)(_|$)/i;
const CREDENTIAL_PREFIX_RE = /^(ANTHROPIC|OPENAI|GITHUB|GH|AWS|AZURE|GCP|GOOGLE|HUGGINGFACE|HF_TOKEN|CLAUDE|GEMINI|COHERE|MISTRAL)_/i;

const ALWAYS_KEEP = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PWD',
  'SHELL',
  'COMSPEC',
  'LOCALAPPDATA',
  'APPDATA',
  'WINDIR',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'TERM',
  'COLORTERM',
  // Non-secret machine facts an interpreter or native ML stack reads at
  // startup. In the default deny-first mode these already survived (nothing
  // denied them), so listing them is a no-op there; they matter only in
  // ``allowOnly`` mode, where an omission would silently break a child.
  'PATHEXT',
  'HOMEDRIVE',
  'HOMEPATH',
  'ALLUSERSPROFILE',
  'COMPUTERNAME',
  'USERDOMAIN',
  'SESSIONNAME',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
]);

const ALWAYS_KEEP_PREFIX_RE = /^(LC_|PROGRAMFILES|PROGRAMDATA|PUBLIC|COMMONPROGRAMFILES)/i;

/**
 * Copy ``env`` into a fresh object, dropping any key whose name looks
 * like a credential.  Callers can relax via ``options.allow`` (regex
 * patterns the key name must match to survive the deny pass) or
 * tighten via ``options.extraDeny`` (regex patterns that force a key
 * out even if the default rules would keep it).
 *
 * ``options.allowOnly`` flips the posture from deny-first to allow-only: a key
 * survives ONLY if it matches ``options.allow`` or the ALWAYS_KEEP system
 * baseline, and every other key is dropped regardless of whether its name looks
 * like a credential.  Deny-first cannot protect a child from a credential whose
 * key name does not advertise itself -- ``HTTPS_PROXY=https://user:pass@host``,
 * a vendor CLI's bespoke ``*_CONFIG`` var, an inherited ``AWS_PROFILE`` -- so
 * spawn sites whose child has a small, enumerable set of vars it actually reads
 * should use allow-only.  The default stays deny-first: callers like the vLLM
 * launcher legitimately need most of the parent environment and opt specific
 * credentials back IN via ``options.allow``, which is why the allow pass keeps
 * running before the deny pass.
 *
 * @param {NodeJS.ProcessEnv | Record<string, unknown>} env - source env
 * @param {{ allow?: RegExp[], extraDeny?: RegExp[], allowOnly?: boolean }} [options]
 * @returns {Record<string, string>} fresh, sanitized env map
 */
function sanitizeSpawnEnv(env, options = {}) {
  const source = env && typeof env === 'object' ? env : {};
  const allowList = Array.isArray(options.allow) ? options.allow.filter((r) => r instanceof RegExp) : [];
  const extraDenyList = Array.isArray(options.extraDeny) ? options.extraDeny.filter((r) => r instanceof RegExp) : [];
  const allowOnly = options.allowOnly === true;

  const out = Object.create(null);
  for (const rawKey of Object.keys(source)) {
    if (typeof rawKey !== 'string' || !rawKey) {
      continue;
    }
    const value = source[rawKey];
    if (typeof value !== 'string') {
      continue;
    }

    const key = rawKey;
    const upper = key.toUpperCase();

    if (extraDenyList.some((re) => re.test(key))) {
      continue;
    }

    if (allowList.some((re) => re.test(key))) {
      out[key] = value;
      continue;
    }

    if (ALWAYS_KEEP.has(upper) || ALWAYS_KEEP_PREFIX_RE.test(upper)) {
      out[key] = value;
      continue;
    }

    if (allowOnly) {
      continue;
    }

    if (CREDENTIAL_KEY_RE.test(key) || CREDENTIAL_PREFIX_RE.test(key)) {
      continue;
    }

    out[key] = value;
  }
  return out;
}

/**
 * Mask a token-shaped string for logging.  Keeps a short prefix and
 * the last 4 characters so the log is still diagnosable ("which
 * token?") but the full value is not recoverable.
 *
 * Short values (<= 12 chars) are treated as fully sensitive and
 * returned as a fixed redaction so we don't leak the full secret via
 * length.
 *
 * @param {unknown} value
 * @returns {string}
 */
function maskToken(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (!str) {
    return '';
  }
  if (str.length <= 12) {
    return '***';
  }
  const prefixMatch = str.match(/^([A-Za-z]{1,4}[-_])/);
  const prefix = prefixMatch ? prefixMatch[1] : '';
  const tail = str.slice(-4);
  return `${prefix}***${tail}`;
}

/**
 * Run ``text`` through a regex that masks the usual shapes of API keys
 * and bearer tokens.  Intended for use on log lines derived from
 * subprocess stdout/stderr tails, where a vendor CLI might echo a
 * token in an error message.
 *
 * Covers: ``sk-...``, ``ghp_...``, ``gho_...``, ``ghs_...``,
 * ``github_pat_...``, ``AKIA...``, ``xox[bpars]-...`` (Slack),
 * bearer headers, generic JWT-shaped triples.
 *
 * @param {unknown} text
 * @returns {string}
 */
function maskTokensInText(text) {
  if (text === null || text === undefined) {
    return '';
  }
  let out = String(text);
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    /\b(?:ghp|gho|ghs|ghr|ghu)_[A-Za-z0-9]{16,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
    /\beyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_.+/=-]{8,}\b/g,
  ];
  for (const pattern of patterns) {
    out = out.replace(pattern, (match) => maskToken(match));
  }
  return out;
}

module.exports = {
  sanitizeSpawnEnv,
  maskToken,
  maskTokensInText,
};
