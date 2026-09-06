const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LOG_RETENTION,
  SECRET_SHAPE_RE,
  redactLogReportValue,
  redactLogText,
} = require('../renderer/shared/log-contract-utils');

test('log contract exposes the shared retention limits used by Logs V2', () => {
  assert.deepEqual(LOG_RETENTION, {
    mainStoreLimit: 400,
    rendererRetainedLimit: 500,
    rendererTrimThreshold: 550,
    diagnosticsCurrentRunLimit: 750,
    diagnosticsPriorRunLimit: 250,
    observabilityRecentLogLimit: 50,
  });
});

test('log report redaction removes sensitive keys, token-shaped text, and local paths', () => {
  const redacted = redactLogReportValue({
    authorization: 'Bearer secret-token-value',
    apiKey: 'sk-testsecret123456789',
    file: 'G:\\Users\\Jenny\\AppData\\Roaming\\jenny\\sessions.json',
    nested: {
      message: 'failed with token=abc123secret at C:\\Projects\\private\\notes.md',
    },
  });

  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes('secret-token-value'), false);
  assert.equal(serialized.includes('sk-testsecret123456789'), false);
  assert.equal(serialized.includes('G:\\Users\\Jenny'), false);
  assert.equal(serialized.includes('C:\\Projects\\private'), false);
  assert.equal(redacted.authorization, '[redacted]');
  assert.equal(redacted.apiKey, '[redacted]');
  assert.match(redacted.file, /\[redacted:path\]/);
  assert.match(redacted.nested.message, /\[redacted\]/);
  assert.match(redacted.nested.message, /\[redacted:path\]/);
});

// F17: this module is the SINGLE require seam behind services/log-entry-normalizer.js,
// so it is the one vocabulary for main.js log(), client-log-forwarding,
// turn-diagnostic-dump AND the user-facing
// log-report copy. Before this slice the general path was materially weaker
// than the canonical turn-event sanitizer: these sentinel shapes survived
// straight into the artifact a user pastes into a bug report.
const SENTINEL_SECRETS = [
  ['github pat (ghp_)', 'ghp_ABCDEFGHIJKLMNOP0123'],
  ['github pat (gho_)', 'gho_ABCDEFGHIJKLMNOP0123'],
  ['github fine-grained pat', 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz'],
  ['huggingface token', 'hf_QwErTyUiOpAsDfGhJkLzXcVbNm1234567890'],
  // Joined at runtime: GitHub push protection blocks a contiguous Slack-token
  // literal in the public repo, and the redactor only sees the joined value.
  ['slack bot token', `xoxb-${'1234567890-0987654321-AbCdEfGhIjKlMnOpQr'}`],
  ['aws access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
];

for (const [label, secret] of SENTINEL_SECRETS) {
  test(`redactLogText strips a ${label} planted in child output`, () => {
    const line = `codex stderr: auth failed using ${secret} (retrying)`;
    const redacted = redactLogText(line);
    assert.equal(redacted.includes(secret), false, `${label} survived redaction`);
    assert.match(redacted, /\[redacted(:token)?\]/);
    // Surrounding diagnostic context must survive — this is a log, not a hash.
    assert.match(redacted, /codex stderr/);
    assert.match(redacted, /retrying/);
  });
}

test('log report redaction strips sentinel secrets from nested details and arrays', () => {
  const redacted = redactLogReportValue({
    stderr_tail: [
      'GITHUB ghp_ABCDEFGHIJKLMNOP0123',
      { line: 'HF hf_QwErTyUiOpAsDfGhJkLzXcVbNm1234567890' },
    ],
    nested: { deeper: { note: 'AKIAIOSFODNN7EXAMPLE and xoxb-1234567890-abcdefghijkl' } },
  });
  const serialized = JSON.stringify(redacted);
  for (const [, secret] of SENTINEL_SECRETS.slice(0, 2)) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.equal(serialized.includes('xoxb-1234567890'), false);
});

test('redactLogText redacts POSIX root paths but leaves route-shaped strings alone', () => {
  assert.match(redactLogText('crash reading /Users/example/notes.md'), /\[redacted:path\]/);
  assert.equal(redactLogText('crash reading /Users/example/notes.md').includes('example'), false);
  assert.match(redactLogText('failed at /home/ci/build/app.py'), /\[redacted:path\]/);
  assert.match(redactLogText('{"config":"/etc/passwd"}'), /\[redacted:path\]/);
  assert.match(redactLogText('opened (/var/log/jenny.log)'), /\[redacted:path\]/);

  // Root-anchored on purpose: an unanchored rule mangles ordinary prose and
  // route strings, which is why canonical-turn-event.js anchors it too.
  assert.equal(redactLogText('GET /api/users returned 200'), 'GET /api/users returned 200');
  assert.equal(redactLogText("app.get('/api/users')"), "app.get('/api/users')");
});

test('redactLogText collapses base64 data URIs instead of copying them into the report', () => {
  const payload = `data:image/png;base64,${'A'.repeat(400)}`;
  const redacted = redactLogText(`attachment ${payload}`);
  assert.equal(redacted.includes('A'.repeat(64)), false);
  assert.match(redacted, /data:image\/png;base64,\[redacted:data-uri\]/);
});

test('SECRET_SHAPE_RE is a strict superset of the vocabularies it replaced', () => {
  // The retired diagnostic reviewer used to carry its own TOKEN_PATTERN with the
  // underscore-prefixed forms; dropping it must not weaken anything.
  for (const secret of ['sk_testsecret123456', 'pk_livesecret123456', 'tok_abcdefgh1234']) {
    SECRET_SHAPE_RE.lastIndex = 0;
    assert.equal(SECRET_SHAPE_RE.test(secret), true, `${secret} must still match`);
    assert.equal(redactLogText(`value ${secret}`).includes(secret), false);
  }
});

test('log report redaction handles circular values without throwing', () => {
  const circular = { token: 'secret-token-value' };
  circular.self = circular;

  const redacted = redactLogReportValue(circular);

  assert.equal(redacted.token, '[redacted]');
  assert.equal(redacted.self, '[redacted:circular]');
});
