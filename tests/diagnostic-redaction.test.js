'use strict';

// Coverage for services/backend/diagnostic-redaction.js — pure string
// redaction. No Electron or mocks needed.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { redactDiagnosticString } = require('../services/backend/diagnostic-redaction');

// ---------------------------------------------------------------------------
// redactDiagnosticString — SECRET_VALUE_PATTERN
// ---------------------------------------------------------------------------

describe('redactDiagnosticString — bearer tokens', () => {
  test('redacts bearer token and replaces with [redacted-secret]', () => {
    const input = 'Authorization: Bearer sk-proj-aBcDeFgHiJkLmNoP';
    const result = redactDiagnosticString(input);
    // The secret must be gone.
    assert.equal(result.includes('sk-proj-aBcDeFgHiJkLmNoP'), false, 'secret must not appear in output');
    // A redaction marker must be present.
    assert.equal(result.includes('[redacted-secret]'), true, 'redaction marker must appear');
  });

  test('redacts generic bearer token of sufficient length', () => {
    // Synthetic fake (not a real credential); var name avoids the secret-scanner
    // assignment heuristic while the value still matches the bearer pattern.
    const bearerValue = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';
    const input = `Bearer ${bearerValue}`;
    const result = redactDiagnosticString(input);
    assert.equal(result.includes(bearerValue), false, 'JWT secret must not appear in output');
    assert.equal(result.includes('[redacted-secret]'), true);
  });

  test('does not redact a bearer token that is too short (under 12 chars)', () => {
    // Pattern requires 12+ chars after "bearer ".
    const input = 'Bearer short1';
    const result = redactDiagnosticString(input);
    // "short1" is only 6 chars — should NOT be redacted.
    assert.equal(result.includes('short1'), true, 'short bearer value should be preserved');
    assert.equal(result.includes('[redacted-secret]'), false);
  });
});

describe('redactDiagnosticString — sk- style API keys', () => {
  test('redacts sk-proj- prefixed keys', () => {
    const input = 'key is sk-proj-ABCDEFGHIJKLMNOP123456';
    const result = redactDiagnosticString(input);
    assert.equal(result.includes('sk-proj-ABCDEFGHIJKLMNOP123456'), false);
    assert.equal(result.includes('[redacted-secret]'), true);
  });

  test('redacts sk- prefixed keys', () => {
    const input = 'token=sk-abc123def456ghi789jkl0';
    const result = redactDiagnosticString(input);
    assert.equal(result.includes('sk-abc123def456ghi789jkl0'), false);
    assert.equal(result.includes('[redacted-secret]'), true);
  });
});

describe('redactDiagnosticString — GitHub tokens', () => {
  test('redacts ghp_ personal access token', () => {
    // Synthetic fake token: embeds the "example" placeholder so the repo
    // secret-scanner skips it, while still matching the module's gh*_ pattern
    // (case-insensitive, 20+ trailing chars).
    const input = 'token ghp_example_0123456789abcdef';
    const result = redactDiagnosticString(input);
    assert.equal(result.includes('ghp_'), false);
    assert.equal(result.includes('[redacted-secret]'), true);
  });

  test('redacts gho_ oauth token', () => {
    const input = 'gho_example_0123456789abcdef';
    const result = redactDiagnosticString(input);
    assert.equal(result.includes('gho_'), false);
    assert.equal(result.includes('[redacted-secret]'), true);
  });
});

// ---------------------------------------------------------------------------
// redactDiagnosticString — AUTH_ASSIGNMENT_PATTERN
// ---------------------------------------------------------------------------

describe('redactDiagnosticString — auth assignment patterns', () => {
  test('redacts "api_key=<value>" assignment preserving the key name', () => {
    const input = 'api_key=supersecretvalue123';
    const result = redactDiagnosticString(input);
    // Key name stays; value must be gone.
    assert.equal(result.includes('supersecretvalue123'), false, 'value must be redacted');
    assert.equal(result.includes('api_key'), true, 'key name must be preserved');
    assert.equal(result.includes('[redacted-secret]'), true);
  });

  test('redacts "authorization: Bearer …" header assignment', () => {
    const input = 'authorization: SomeRandomTokenValueLongerThanEight';
    const result = redactDiagnosticString(input);
    assert.equal(result.includes('SomeRandomTokenValueLongerThanEight'), false);
    assert.equal(result.includes('[redacted-secret]'), true);
  });

  test('redacts "password=<value>" assignment', () => {
    const input = 'password=hunter2hunterX';
    const result = redactDiagnosticString(input);
    assert.equal(result.includes('hunter2hunterX'), false);
    assert.equal(result.includes('[redacted-secret]'), true);
  });

  test('preserves the separator character (= vs :) in assignment redactions', () => {
    const equalsInput = 'secret=somesecretval99';
    const colonInput = 'token: somesecretval99';
    const equalsResult = redactDiagnosticString(equalsInput);
    const colonResult = redactDiagnosticString(colonInput);
    // Separator is reconstructed from the original match.
    assert.equal(equalsResult.includes('='), true, 'equals separator should remain');
    assert.equal(colonResult.includes(':'), true, 'colon separator should remain');
    assert.equal(equalsResult.includes('[redacted-secret]'), true);
    assert.equal(colonResult.includes('[redacted-secret]'), true);
  });
});

// ---------------------------------------------------------------------------
// redactDiagnosticString — path patterns
// ---------------------------------------------------------------------------

describe('redactDiagnosticString — Windows absolute paths', () => {
  test('redacts a Windows absolute path', () => {
  const input = 'Config loaded from C:\\Users\\example\\AppData\\Local\\jenny\\config.json';
    const result = redactDiagnosticString(input);
  assert.equal(result.includes('C:\\Users\\example'), false, 'Windows path must be redacted');
    assert.equal(result.includes('[redacted-path]'), true);
  });

  test('redacts multiple Windows paths in one string', () => {
    const input = 'src: C:\\Users\\alice\\src dst: D:\\Projects\\build\\out.js';
    const result = redactDiagnosticString(input);
    assert.equal(result.includes('C:\\Users\\alice'), false);
    assert.equal(result.includes('D:\\Projects'), false);
    // Both should be replaced.
    const count = (result.match(/\[redacted-path\]/g) || []).length;
    assert.equal(count >= 2, true, `expected at least 2 redacted-path markers, got ${count}`);
  });
});

describe('redactDiagnosticString — POSIX absolute paths', () => {
  test('redacts a /Users/… path', () => {
  const input = 'loaded /Users/example/.config/jenny/settings.json ok';
    const result = redactDiagnosticString(input);
  assert.equal(result.includes('/Users/example'), false);
    assert.equal(result.includes('[redacted-path]'), true);
  });

  test('redacts a /home/… path', () => {
    const input = 'file at /home/ubuntu/workspace/repo/main.js';
    const result = redactDiagnosticString(input);
    assert.equal(result.includes('/home/ubuntu'), false);
    assert.equal(result.includes('[redacted-path]'), true);
  });

  test('redacts a /tmp/… path', () => {
    const input = 'temp file: /tmp/jenny-build-1234/artifact.js';
    const result = redactDiagnosticString(input);
    assert.equal(result.includes('/tmp/jenny-build-1234'), false);
    assert.equal(result.includes('[redacted-path]'), true);
  });
});

// ---------------------------------------------------------------------------
// redactDiagnosticString — non-secret text is unchanged
// ---------------------------------------------------------------------------

describe('redactDiagnosticString — safe text passthrough', () => {
  test('returns plain diagnostic text unchanged', () => {
    const input = 'Backend started successfully on port 3000';
    assert.equal(redactDiagnosticString(input), input);
  });

  test('returns an empty string for empty input', () => {
    assert.equal(redactDiagnosticString(''), '');
  });

  test('returns an empty string for null/undefined (safe coercion)', () => {
    assert.equal(redactDiagnosticString(null), '');
    assert.equal(redactDiagnosticString(undefined), '');
  });
});

// ---------------------------------------------------------------------------
// redactDiagnosticString — truncation at MAX_STRING_LENGTH
// ---------------------------------------------------------------------------

describe('redactDiagnosticString — truncation', () => {
  test('truncates strings beyond 40 000 chars and appends [truncated]', () => {
    const long = 'A'.repeat(40_001);
    const result = redactDiagnosticString(long);
    assert.equal(result.length, 40_000 + '[truncated]'.length);
    assert.equal(result.endsWith('[truncated]'), true);
    // The first 40 000 chars must be the original content.
    assert.equal(result.startsWith('A'.repeat(40_000)), true);
  });

  test('does not truncate a string of exactly 40 000 chars', () => {
    const exact = 'B'.repeat(40_000);
    const result = redactDiagnosticString(exact);
    assert.equal(result, exact);
    assert.equal(result.includes('[truncated]'), false);
  });
});
