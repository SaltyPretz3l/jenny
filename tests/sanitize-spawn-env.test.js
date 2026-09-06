'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeSpawnEnv,
  maskToken,
  maskTokensInText,
} = require('../services/backend/sanitize-spawn-env');


test('credential-shaped keys are stripped by default', () => {
  const env = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-abcdef1234567890',
    OPENAI_API_KEY: 'sk-proj-abcdef1234567890',
    GITHUB_TOKEN: 'ghp_abcdef1234567890abcdef',
    AWS_SECRET_ACCESS_KEY: 'secret',
    MY_PASSWORD: 'hunter2',
    MY_PASSWD: 'hunter2',
    MY_PRIVATE_KEY: '-----BEGIN RSA-----',
    SESSION_TOKEN: 'abc',
    HF_TOKEN: 'hf_abc',
    HUGGINGFACE_TOKEN: 'hf_abc',
  };
  const out = sanitizeSpawnEnv(env);
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
  assert.equal(out.OPENAI_API_KEY, undefined);
  assert.equal(out.GITHUB_TOKEN, undefined);
  assert.equal(out.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(out.MY_PASSWORD, undefined);
  assert.equal(out.MY_PASSWD, undefined);
  assert.equal(out.MY_PRIVATE_KEY, undefined);
  assert.equal(out.SESSION_TOKEN, undefined);
  assert.equal(out.HF_TOKEN, undefined);
  assert.equal(out.HUGGINGFACE_TOKEN, undefined);
});


test('always-keep system keys survive', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/user',
    USERPROFILE: 'C:\\Users\\user',
    SYSTEMROOT: 'C:\\Windows',
    TEMP: '/tmp',
    TMP: '/tmp',
    USER: 'alice',
    USERNAME: 'alice',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    LC_CTYPE: 'C',
    PWD: '/home/user',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local',
    APPDATA: 'C:\\Users\\user\\AppData\\Roaming',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    WINDIR: 'C:\\Windows',
  };
  const out = sanitizeSpawnEnv(env);
  for (const [key, value] of Object.entries(env)) {
    assert.equal(out[key], value, `expected ${key} preserved`);
  }
});


test('options.allow extends the keep list with regex patterns', () => {
  const env = {
    PATH: '/usr/bin',
    OLLAMA_HOST: '127.0.0.1:11434',
    OLLAMA_MODELS: '/var/ollama',
    SOMETHING_ELSE: 'value',
    ANTHROPIC_API_KEY: 'leak',
  };
  const out = sanitizeSpawnEnv(env, { allow: [/^OLLAMA_/i] });
  assert.equal(out.OLLAMA_HOST, '127.0.0.1:11434');
  assert.equal(out.OLLAMA_MODELS, '/var/ollama');
  assert.equal(out.SOMETHING_ELSE, 'value'); // not credential-shaped, not denied
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
});


test('options.allow bypasses credential deny for opted-in engine vars', () => {
  const env = {
    PATH: '/usr/bin',
    HF_TOKEN: 'hf_abc1234567890',
    HF_HOME: '/var/hf',
    ANTHROPIC_API_KEY: 'leak',
  };
  const out = sanitizeSpawnEnv(env, { allow: [/^HF_/i] });
  assert.equal(out.HF_TOKEN, 'hf_abc1234567890');
  assert.equal(out.HF_HOME, '/var/hf');
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
});


// F8: deny-first only strips keys whose NAME advertises a credential. The
// model-adjacent spawn sites need the opposite posture, because the leak that
// mattered was not a well-named *_TOKEN — it was every unrecognised var in a
// developer/CI shell reaching a Python process that re-spawns a vendor CLI.
test('allowOnly drops everything outside the allowlist and system baseline', () => {
  const env = {
    PATH: '/usr/bin',
    APPDATA: 'C:/Users/x/AppData/Roaming',
    JENNY_PARENT_PID: '1234',
    PYTHONPATH: '/srv/app',
    VIRTUAL_ENV: '/srv/.venv',
    CUDA_VISIBLE_DEVICES: '0',
    // None of these are credential-SHAPED by key name, so deny-first keeps
    // them all. Two of them carry secrets in their values.
    HTTPS_PROXY: 'https://user:hunter2@proxy.internal:8080',
    AWS_PROFILE: 'prod-admin',
    VENDOR_CONFIG: 'api_key=sk-live-abcdefghijklmnop',
    RANDOM_DEV_VAR: 'whatever',
  };
  const allow = [/^JENNY_/i, /^PYTHON/i, /^VIRTUAL_ENV$/i, /^CUDA_/i];

  const denyFirst = sanitizeSpawnEnv(env, { allow });
  // Pin the gap this option exists to close.
  assert.equal(denyFirst.HTTPS_PROXY, 'https://user:hunter2@proxy.internal:8080');
  assert.equal(denyFirst.VENDOR_CONFIG, 'api_key=sk-live-abcdefghijklmnop');

  const strict = sanitizeSpawnEnv(env, { allow, allowOnly: true });
  assert.equal(strict.HTTPS_PROXY, undefined);
  assert.equal(strict.AWS_PROFILE, undefined);
  assert.equal(strict.VENDOR_CONFIG, undefined);
  assert.equal(strict.RANDOM_DEV_VAR, undefined);
  assert.equal(JSON.stringify(strict).includes('hunter2'), false);
  assert.equal(JSON.stringify(strict).includes('sk-live-abcdefghijklmnop'), false);

  // The allowlist and the system baseline still come through.
  assert.equal(strict.PATH, '/usr/bin');
  assert.equal(strict.APPDATA, 'C:/Users/x/AppData/Roaming');
  assert.equal(strict.JENNY_PARENT_PID, '1234');
  assert.equal(strict.PYTHONPATH, '/srv/app');
  assert.equal(strict.VIRTUAL_ENV, '/srv/.venv');
  assert.equal(strict.CUDA_VISIBLE_DEVICES, '0');
});

test('allowOnly still honours extraDeny ahead of the allowlist', () => {
  const out = sanitizeSpawnEnv(
    { PATH: '/usr/bin', JENNY_SECRET_THING: 'nope', JENNY_PARENT_PID: '7' },
    { allow: [/^JENNY_/i], allowOnly: true, extraDeny: [/^JENNY_SECRET_/i] }
  );
  assert.equal(out.JENNY_SECRET_THING, undefined);
  assert.equal(out.JENNY_PARENT_PID, '7');
  assert.equal(out.PATH, '/usr/bin');
});

test('allowOnly defaults off so existing deny-first callers are unchanged', () => {
  const env = { PATH: '/usr/bin', FOO: 'bar', OPENAI_API_KEY: 'leak' };
  assert.deepEqual({ ...sanitizeSpawnEnv(env) }, { PATH: '/usr/bin', FOO: 'bar' });
  assert.deepEqual({ ...sanitizeSpawnEnv(env, { allowOnly: false }) }, { PATH: '/usr/bin', FOO: 'bar' });
});

test('options.extraDeny removes otherwise-kept keys', () => {
  const env = {
    PATH: '/usr/bin',
    FOO: 'bar',
    CUSTOM_SENSITIVE: 'value',
  };
  const out = sanitizeSpawnEnv(env, { extraDeny: [/^CUSTOM_/] });
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.FOO, 'bar');
  assert.equal(out.CUSTOM_SENSITIVE, undefined);
});


test('non-string values are dropped', () => {
  const env = {
    PATH: '/usr/bin',
    NUMBER_VAL: 42,
    OBJECT_VAL: { a: 1 },
    NULL_VAL: null,
    UNDEF_VAL: undefined,
    BOOL_VAL: true,
    EMPTY_STRING: '',
  };
  const out = sanitizeSpawnEnv(env);
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.NUMBER_VAL, undefined);
  assert.equal(out.OBJECT_VAL, undefined);
  assert.equal(out.NULL_VAL, undefined);
  assert.equal(out.UNDEF_VAL, undefined);
  assert.equal(out.BOOL_VAL, undefined);
  assert.equal(out.EMPTY_STRING, '');
});


test('empty / nullish env returns an empty object', () => {
  assert.deepEqual(Object.assign({}, sanitizeSpawnEnv(undefined)), {});
  assert.deepEqual(Object.assign({}, sanitizeSpawnEnv(null)), {});
  assert.deepEqual(Object.assign({}, sanitizeSpawnEnv({})), {});
});


test('sanitizeSpawnEnv returns a fresh object (does not mutate input)', () => {
  const env = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'leak',
  };
  const out = sanitizeSpawnEnv(env);
  assert.notEqual(out, env);
  assert.equal(env.ANTHROPIC_API_KEY, 'leak', 'input must not be mutated');
});


test('maskToken redacts long strings keeping prefix + last 4', () => {
  assert.equal(maskToken('sk-abcdef1234567890'), 'sk-***7890');
  assert.equal(maskToken('ghp_0123456789abcdef0123'), 'ghp_***0123');
  assert.equal(maskToken('opaque-long-value-abcdef'), '***cdef');
});


test('maskToken returns *** for short values', () => {
  assert.equal(maskToken('short'), '***');
  assert.equal(maskToken(''), '');
  assert.equal(maskToken('sk-abc'), '***');
});


test('maskToken handles nullish input without throwing', () => {
  assert.equal(maskToken(undefined), '');
  assert.equal(maskToken(null), '');
  // A numeric 0 is coerced to "0" (length 1), falling through the
  // short-value path and returning the fixed redaction marker.
  assert.equal(maskToken(0), '***');
});


test('maskTokensInText redacts inline token shapes', () => {
  const text = 'error: AuthorizationFailed token=sk-abcdef1234567890 please retry';
  const masked = maskTokensInText(text);
  assert.ok(!masked.includes('sk-abcdef1234567890'), `expected token to be masked in: ${masked}`);
  assert.ok(masked.includes('sk-***7890'));
});


test('maskTokensInText handles multiple tokens in one string', () => {
  const text = 'token1=sk-aaaaaaaaaaaaaaaa token2=ghp_bbbbbbbbbbbbbbbbbbbb';
  const masked = maskTokensInText(text);
  assert.ok(!masked.includes('sk-aaaaaaaaaaaaaaaa'));
  assert.ok(!masked.includes('ghp_bbbbbbbbbbbbbbbbbbbb'));
});


test('maskTokensInText handles nullish input', () => {
  assert.equal(maskTokensInText(undefined), '');
  assert.equal(maskTokensInText(null), '');
  assert.equal(maskTokensInText(''), '');
});


test('maskTokensInText leaves benign text intact', () => {
  const text = 'This is just regular log output with nothing to mask.';
  assert.equal(maskTokensInText(text), text);
});


test('credential regex does not match partial-word false positives', () => {
  const env = {
    TOKENIZER_PARALLELISM: 'false',
    PUBLIC_KEY_PATH: '/etc/ssl/pub',
  };
  const out = sanitizeSpawnEnv(env);
  assert.equal(out.TOKENIZER_PARALLELISM, 'false');
  assert.equal(out.PUBLIC_KEY_PATH, '/etc/ssl/pub');
});


test('ANTHROPIC / OPENAI prefix keys are denied', () => {
  const env = {
    PATH: '/usr/bin',
    ANTHROPIC_BASE_URL: 'https://api.example',
    OPENAI_BASE_URL: 'https://api.example',
  };
  const out = sanitizeSpawnEnv(env);
  assert.equal(out.ANTHROPIC_BASE_URL, undefined);
  assert.equal(out.OPENAI_BASE_URL, undefined);
});
