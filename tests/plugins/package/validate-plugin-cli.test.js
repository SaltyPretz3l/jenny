'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildSignedPluginPackage } = require('../../helpers/plugins/zip-fixture-builder');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join('scripts', 'plugins', 'validate-plugin.mjs');
const SKILL = path.join(ROOT, 'docs', 'plugins', 'examples', 'declarative', 'skill');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
  });
}

function tempCopy(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-validate-cli-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, 'plugin');
  fs.cpSync(SKILL, target, { recursive: true });
  return target;
}

function readManifest(target) {
  return JSON.parse(fs.readFileSync(path.join(target, 'plugin.json'), 'utf8'));
}

function writeManifest(target, manifest) {
  fs.writeFileSync(path.join(target, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('clean folder exits zero with machine-scannable text lines', () => {
  const result = run([SKILL]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trimEnd().split(/\r?\n/);
  for (const line of lines.slice(0, -1)) assert.match(line, /^(pass|FAIL|skip)\s{2}\S+\s+/);
  assert.match(lines.at(-1), /^\d+ checks passed, 0 failed, \d+ skipped/);
});

test('failing folder exits one and prints problem and hint lines', (t) => {
  const target = tempCopy(t);
  const manifest = readManifest(target);
  manifest.contributions[0].content_sha256 = '0'.repeat(64);
  writeManifest(target, manifest);
  const result = run([target]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL\s{2}content-digests/m);
  assert.match(result.stdout, /^ {2}problem: /m);
  assert.match(result.stdout, /^ {2}hint: /m);
});

test('missing target and unsupported file exit two with one error line', (t) => {
  const missing = run([path.join(os.tmpdir(), `missing-${Date.now()}`)]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^error: [^\r\n]+\r?\n$/);
  assert.equal(missing.stdout, '');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-validate-cli-file-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const textFile = path.join(temp, 'plugin.txt');
  fs.writeFileSync(textFile, 'not a plugin');
  const unsupported = run([textFile]);
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /^error: [^\r\n]+\r?\n$/);
});

test('--json emits exactly one result object agreeing with text status', () => {
  const textResult = run([SKILL]);
  const jsonResult = run([SKILL, '--json']);
  assert.equal(jsonResult.status, textResult.status);
  assert.equal(jsonResult.stderr, '');
  const parsed = JSON.parse(jsonResult.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.target_kind, 'folder');
  assert.equal(parsed.summary.failed, 0);
  assert.deepEqual(new Set(parsed.checks.map((check) => check.status)), new Set(['pass', 'skip']));
});

test('malformed contribution entries produce a JSON validation failure, not a target error', (t) => {
  const target = tempCopy(t);
  const manifest = readManifest(target);
  manifest.contributions = [null];
  writeManifest(target, manifest);

  const result = run([target, '--json']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.checks.find((check) => check.id === 'manifest-schema').status, 'fail');
});

test('--write-digests repairs a folder and a second run stays clean', (t) => {
  const target = tempCopy(t);
  const manifest = readManifest(target);
  manifest.contributions[0].content_sha256 = '0'.repeat(64);
  writeManifest(target, manifest);

  const repaired = run([target, '--write-digests']);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout,
    /^note: plugin\.json rewritten with current digests \(formatting normalized\)$/m);
  const current = readManifest(target);
  const contentBytes = fs.readFileSync(path.join(target, ...current.contributions[0].content_path.split('/')));
  assert.equal(current.contributions[0].content_sha256, digest(contentBytes));
  const second = run([target]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /0 failed/);
});

test('--write-digests refuses archives without changing their bytes', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-validate-cli-archive-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const target = path.join(temp, 'fixture.jenny-plugin');
  fs.writeFileSync(target, buildSignedPluginPackage().bytes);
  const before = digest(fs.readFileSync(target));
  const result = run([target, '--write-digests']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^error: --write-digests is available only for plugin folders\r?\n$/);
  assert.equal(digest(fs.readFileSync(target)), before);
});
