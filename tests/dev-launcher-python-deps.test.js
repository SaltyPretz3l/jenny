const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Pure-function tests for scripts/dev/jenny-dev-deps.ps1. The dev launcher
// itself is never executed here (it runs pip/npm and starts the app); only the
// function-only file is dot-sourced against temp directories.

const DEPS_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'dev', 'jenny-dev-deps.ps1');
const SKIP = process.platform === 'win32' ? false : 'Windows PowerShell only';

function runPowerShell(script, env) {
  const childEnv = { ...process.env, ...env };
  // A Node child of PowerShell 7 inherits its module path. Windows PowerShell
  // must discover its own Utility module (including Get-FileHash).
  delete childEnv.PSModulePath;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, env: childEnv, timeout: 60000 }
  );
  assert.equal(result.status, 0, `powershell failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

test('Python dependency fingerprint and stamp checks follow their inputs', { skip: SKIP }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-dev-deps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoA = path.join(root, 'repo-a');
  const repoB = path.join(root, 'repo-b');
  const repoMissing = path.join(root, 'repo-missing');
  for (const dir of [repoA, repoB, repoMissing]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(repoA, 'pyproject.toml'), '[project]\ndependencies = ["one"]\n');
  fs.writeFileSync(path.join(repoB, 'pyproject.toml'), '[project]\ndependencies = ["one", "two"]\n');

  const stampDir = path.join(root, 'stamps');
  fs.mkdirSync(stampDir);
  fs.writeFileSync(path.join(stampDir, 'garbage.json'), 'not json {');
  fs.writeFileSync(path.join(stampDir, 'no-fingerprint.json'), JSON.stringify({ written_at: 'x' }));
  fs.writeFileSync(path.join(stampDir, 'empty.json'), '');

  const script = [
    `Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility') -ErrorAction Stop`,
    `. ($env:JENNY_TEST_DEPS_SCRIPT)`,
    `$a = $env:JENNY_TEST_REPO_A`,
    `$b = $env:JENNY_TEST_REPO_B`,
    `$s = $env:JENNY_TEST_STAMP_DIR`,
    `$v1 = 'Python 3.11.9'`,
    `$v2 = 'Python 3.12.1'`,
    `$fpA = Get-JennyPythonDepsFingerprint -RepoRoot $a -PythonVersion $v1`,
    `$fpAgain = Get-JennyPythonDepsFingerprint -RepoRoot $a -PythonVersion $v1`,
    `$fpAPadded = Get-JennyPythonDepsFingerprint -RepoRoot $a -PythonVersion ($v1 + [Environment]::NewLine)`,
    `$fpB = Get-JennyPythonDepsFingerprint -RepoRoot $b -PythonVersion $v1`,
    `$fpAv2 = Get-JennyPythonDepsFingerprint -RepoRoot $a -PythonVersion $v2`,
    `$fpNoToml = Get-JennyPythonDepsFingerprint -RepoRoot $env:JENNY_TEST_REPO_MISSING -PythonVersion $v1`,
    `$fpNoVersion = Get-JennyPythonDepsFingerprint -RepoRoot $a -PythonVersion ''`,
    `$stamp = Join-Path $s 'current.json'`,
    `@{ fingerprint = $fpA; written_at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Out-File -FilePath $stamp -Encoding utf8`,
    `$out = [ordered]@{`,
    `  fpA = $fpA`,
    `  same = ($fpA -ceq $fpAgain)`,
    `  trimmed = ($fpA -ceq $fpAPadded)`,
    `  contentChanged = ($fpA -cne $fpB)`,
    `  versionChanged = ($fpA -cne $fpAv2)`,
    `  noToml = ($null -eq $fpNoToml)`,
    `  noVersion = ($null -eq $fpNoVersion)`,
    `  current = [bool](Test-JennyDepsStampCurrent -StampPath $stamp -Fingerprint $fpA)`,
    `  differentContent = [bool](Test-JennyDepsStampCurrent -StampPath $stamp -Fingerprint $fpB)`,
    `  differentVersion = [bool](Test-JennyDepsStampCurrent -StampPath $stamp -Fingerprint $fpAv2)`,
    `  missing = [bool](Test-JennyDepsStampCurrent -StampPath (Join-Path $s 'absent.json') -Fingerprint $fpA)`,
    `  garbage = [bool](Test-JennyDepsStampCurrent -StampPath (Join-Path $s 'garbage.json') -Fingerprint $fpA)`,
    `  noFingerprintProperty = [bool](Test-JennyDepsStampCurrent -StampPath (Join-Path $s 'no-fingerprint.json') -Fingerprint $fpA)`,
    `  emptyFile = [bool](Test-JennyDepsStampCurrent -StampPath (Join-Path $s 'empty.json') -Fingerprint $fpA)`,
    `  nullFingerprint = [bool](Test-JennyDepsStampCurrent -StampPath $stamp -Fingerprint $null)`,
    `  errors = @($Error | ForEach-Object { $_.ToString() })`,
    `}`,
    `ConvertTo-Json -InputObject $out -Compress`,
  ].join('\n');

  const result = JSON.parse(
    runPowerShell(script, {
      JENNY_TEST_DEPS_SCRIPT: DEPS_SCRIPT,
      JENNY_TEST_REPO_A: repoA,
      JENNY_TEST_REPO_B: repoB,
      JENNY_TEST_REPO_MISSING: repoMissing,
      JENNY_TEST_STAMP_DIR: stampDir,
    })
  );

  assert.match(result.fpA || '', /^[0-9A-F]{64}\|Python 3\.11\.9$/, JSON.stringify(result));
  assert.equal(result.same, true, 'fingerprint is deterministic');
  assert.equal(result.trimmed, true, 'trailing whitespace on the version is ignored');
  assert.equal(result.contentChanged, true, 'pyproject.toml content changes the fingerprint');
  assert.equal(result.versionChanged, true, 'the Python version string changes the fingerprint');
  assert.equal(result.noToml, true, 'a missing pyproject.toml gives no fingerprint');
  assert.equal(result.noVersion, true, 'an empty version gives no fingerprint');
  assert.equal(result.current, true, 'a stamp written by the launcher is current');
  assert.equal(result.differentContent, false);
  assert.equal(result.differentVersion, false);
  assert.equal(result.missing, false);
  assert.equal(result.garbage, false);
  assert.equal(result.noFingerprintProperty, false);
  assert.equal(result.emptyFile, false);
  assert.equal(result.nullFingerprint, false);
});
