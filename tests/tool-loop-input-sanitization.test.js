// Coverage for services/backend/tool-loop-input-sanitization.js path
// redaction: platform parity for file:// URLs (the POSIX form previously
// escaped redaction while the Windows form was caught), delimiter-prefixed
// POSIX paths, and the carve-out that keeps web URLs legible.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REDACTED_PATH_TOKEN,
  redactPathLikeText,
  sanitizeApprovalReason,
  sanitizeApprovalPolicyText,
  sanitizeToolInputValue,
  sanitizeToolSummary,
  buildPersistedToolInputSnapshot,
  buildInvalidToolArgumentsMessage,
} = require('../services/backend/tool-loop-input-sanitization');
const { redactTranscriptPaths } = require('../services/backend/transcript-export-redaction');
const {
  sanitizeApprovalPolicyPresentation,
} = require('../services/backend/chat-stream-tool-payload-utils');
const canonicalFixtureCases = require('./fixtures/canonical-turn-events/cases.json').cases;

test('approval policy text is typed, redacted, whitespace-normalized, and code-point bounded', () => {
  assert.equal(sanitizeApprovalPolicyText({ unsafe: true }), '');
  assert.equal(
    sanitizeApprovalPolicyText('May change  C:/Users/example/private.txt  with api_key=sk-abcdefghijklmnop'),
    'May change [redacted:path]/private.txt with api_key="[redacted]"'
  );
  assert.equal(Array.from(sanitizeApprovalPolicyText('😀'.repeat(140))).length, 120);
});

test('approval reason is typed, redacted, whitespace-normalized, and visibly bounded', () => {
  assert.equal(sanitizeApprovalReason({ unsafe: true }), '');
  assert.equal(
    sanitizeApprovalReason('  This command uses  api_key=sk-abcdefghijklmnop\n before running.  '),
    'This command uses api_key="[redacted]" before running.'
  );
  assert.equal(sanitizeApprovalReason('x'.repeat(600)), `${'x'.repeat(512)}...`);
  // Bidi overrides and zero-width characters could reorder or hide part of
  // the sentence the user is approving.
  assert.equal(sanitizeApprovalReason('Deletes \u202Etxt.sgol\u202C and a\u200Bb\u0007.'), 'Deletes txt.sgol and ab.');
});

test('approval policy presentation accepts known fields independently and rejects future copy', () => {
  assert.deepEqual(sanitizeApprovalPolicyPresentation({
    policy_scope: 'Workspace files',
    policy_consequence: 'Future assuring consequence',
  }), {
    policyScope: 'Workspace files',
    policyConsequence: '',
  });
});

test('tool input sanitization preserves __proto__ and constructor as own JSON fields', () => {
  const value = { safe: 1 };
  Object.defineProperty(value, '__proto__', {
    value: { injected: 'yes' },
    enumerable: true,
  });
  Object.defineProperty(value, 'constructor', {
    value: { name: 'attacker' },
    enumerable: true,
  });

  const sanitized = sanitizeToolInputValue(value);

  assert.equal(Object.hasOwn(sanitized, '__proto__'), true);
  assert.equal(Object.hasOwn(sanitized, 'constructor'), true);
  assert.equal(sanitized.injected, undefined);
  assert.equal(
    JSON.stringify(sanitized),
    '{"safe":1,"__proto__":{"injected":"yes"},"constructor":{"name":"attacker"}}'
  );
});

// HB-012: the persisted transcript presents real paths (timeline and model
// history); only secrets are redacted at persist time.
test('transcript sanitizers keep real paths and still redact secrets', () => {
  const python = 'D:\\Work\\bank_recon\\.venv\\Scripts\\python';
  const input = {
    path: 'D:\\Work\\bank_recon\\agentj.md',
    command: `${python} -m pytest -q`,
    cwd: '/home/me/ws',
    api_key: 'secret-value',
    note: 'uses Bearer abcdefghijklmnopqrstuvwxyz',
  };
  const snapshot = buildPersistedToolInputSnapshot(input);
  assert.deepEqual(snapshot.input, {
    path: 'D:\\Work\\bank_recon\\agentj.md',
    command: `${python} -m pytest -q`,
    cwd: '/home/me/ws',
    api_key: '[redacted]',
    note: 'uses [redacted]',
  });
  assert.deepEqual(JSON.parse(snapshot.inputJson), snapshot.input);
  assert.equal(sanitizeToolSummary(`Bash ${python} token=abc`), `Bash ${python} token="[redacted]"`);
  assert.equal(
    sanitizeApprovalReason('Writes C:/Users/example/private.txt with api_key=sk-abcdefghijklmnop'),
    'Writes C:/Users/example/private.txt with api_key="[redacted]"'
  );
  assert.ok(buildInvalidToolArgumentsMessage('read_file', '{"path":"C:\\ws\\a.js"').includes('C:\\ws\\a.js'));
});

test('file:// URLs redact identically on Windows and POSIX shapes', () => {
  assert.equal(
    redactPathLikeText('file:///C:/Users/someone/report.html'),
    `file:///${REDACTED_PATH_TOKEN}/report.html`,
    'Windows file URL keeps the historical presentation'
  );
  assert.equal(
    redactPathLikeText('file:///Users/someone/report.html'),
    `file:///${REDACTED_PATH_TOKEN}/report.html`,
    'POSIX file URL redacts the same way (platform parity)'
  );
  assert.equal(
    redactPathLikeText('open file://localhost/Users/someone/report.html now'),
    `open file:///${REDACTED_PATH_TOKEN}/report.html now`,
    'host-qualified file URL collapses to the same token'
  );
});

test('web URLs stay legible — no path redaction inside http(s) URLs', () => {
  const url = 'https://example.com/deep/path/segment?q=1';
  assert.equal(redactPathLikeText(url), url);
  assert.equal(redactPathLikeText('see http://example.org/a/b'), 'see http://example.org/a/b');
});

test('delimiter-prefixed POSIX paths redact like their Windows equivalents', () => {
  assert.equal(
    redactPathLikeText('path:/home/someone/secrets.txt'),
    `path:${REDACTED_PATH_TOKEN}/secrets.txt`
  );
  assert.equal(
    redactPathLikeText('root=/var/lib/jenny'),
    `root=${REDACTED_PATH_TOKEN}/jenny`
  );
});

test('matched paths keep their final segment while roots and single segments stay fully redacted', () => {
  assert.equal(
    redactPathLikeText('C:\\Users\\someone\\file.txt'),
    `${REDACTED_PATH_TOKEN}\\file.txt`
  );
  assert.equal(
    redactPathLikeText('read /home/someone/notes.md please'),
    `read ${REDACTED_PATH_TOKEN}/notes.md please`
  );
  assert.equal(redactPathLikeText('C:\\'), 'C:\\', 'a bare drive root is not a path');
  assert.equal(redactPathLikeText('yes / no'), 'yes / no', 'a prose slash is not a path');
  assert.equal(redactPathLikeText('/etc'), REDACTED_PATH_TOKEN);
  assert.equal(redactPathLikeText('/a/b/'), `${REDACTED_PATH_TOKEN}/b/`);
  assert.equal(redactPathLikeText('a plain sentence with no paths'), 'a plain sentence with no paths');
});

test('quoted JSON POSIX values redact like their Windows twins; web URLs still legible', () => {
  assert.equal(
    redactPathLikeText('json {"path":"/etc/passwd"}'),
    `json {"path":"${REDACTED_PATH_TOKEN}/passwd"}`
  );
  assert.equal(redactPathLikeText('see "https://a.example/b"'), 'see "https://a.example/b"');
});

test('final path segments are capped at 80 characters', () => {
  const finalSegment = 'x'.repeat(90);
  assert.equal(
    redactPathLikeText(`/home/example/${finalSegment}`),
    `${REDACTED_PATH_TOKEN}/${'x'.repeat(80)}`
  );
});

test('tool-loop path redaction matches the export redactor on the shared path fixtures', () => {
  const pathCases = canonicalFixtureCases.filter(({ name }) => /_is_presented$/.test(name));
  assert.equal(pathCases.length, 4);
  for (const item of pathCases) {
    const summary = item.input.payload.tool_input_summary;
    assert.notEqual(redactPathLikeText(summary), summary, item.name);
    assert.equal(redactPathLikeText(summary), redactTranscriptPaths(summary), item.name);
  }
});
