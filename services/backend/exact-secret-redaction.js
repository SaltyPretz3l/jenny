'use strict';

// Exact-value redaction for user API-provider keys (row 78), the Electron twin
// of sidecar/runtime/exact_secret_redaction.py. The shape redactors catch
// sk-/bearer/JWT-like values; a provider key need not have any known shape, so
// every key Jenny stores or hands to the sidecar is registered here and the
// log, transcript-export and tool-input redactors also replace that exact
// value. Main process only: the renderer never holds a key. Process-global by
// design and bounded (oldest out); a replaced key stays registered because a
// buffered line may still carry it.

const MAX_EXACT_SECRETS = 32;
// Shorter values would redact ordinary words; a real key is far longer.
const MIN_EXACT_SECRET_CHARS = 12;
const REDACTED_EXACT_SECRET = '[redacted:api-key]';
const MAX_VALUE_DEPTH = 32;

const secrets = new Set();

function registerExactSecret(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (token.length < MIN_EXACT_SECRET_CHARS) return false;
  secrets.delete(token);
  secrets.add(token);
  while (secrets.size > MAX_EXACT_SECRETS) {
    secrets.delete(secrets.values().next().value);
  }
  return true;
}

function redactExactSecrets(text) {
  if (typeof text !== 'string' || !text || secrets.size === 0) return text;
  let out = text;
  // Longest first, so a key containing another registered key is replaced whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED_EXACT_SECRET);
  }
  return out;
}

// Plain objects and arrays only; anything else passes through untouched.
function redactExactSecretsInValue(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactExactSecrets(value);
  if (secrets.size === 0 || !value || typeof value !== 'object' || depth > MAX_VALUE_DEPTH || seen.has(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const out = value.map((entry) => redactExactSecretsInValue(entry, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  seen.add(value);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(out, redactExactSecrets(key), {
      value: redactExactSecretsInValue(entry, depth + 1, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  seen.delete(value);
  return out;
}

function registeredExactSecretCount() {
  return secrets.size;
}

function clearExactSecretsForTests() {
  secrets.clear();
}

module.exports = {
  MAX_EXACT_SECRETS,
  MIN_EXACT_SECRET_CHARS,
  REDACTED_EXACT_SECRET,
  clearExactSecretsForTests,
  redactExactSecrets,
  redactExactSecretsInValue,
  registerExactSecret,
  registeredExactSecretCount,
};
