const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Pure-function tests for scripts/dev/jenny-process-identity.ps1. The dev
// cleanup script itself is never executed here (it stops processes); only the
// function-only file is dot-sourced and fed synthetic records.

const IDENTITY_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'dev', 'jenny-process-identity.ps1');
const SKIP = process.platform === 'win32' ? false : 'Windows PowerShell only';
const REPO = 'G:\\repo';
const VENV_PYTHON = `${REPO}\\.venv\\Scripts\\python.exe`;
const ELECTRON = `${REPO}\\node_modules\\electron\\dist\\electron.exe`;
const INSTALL_DIR = 'C:\\Program Files\\Jenny';
const SIDECAR = `${INSTALL_DIR}\\resources\\sidecar\\sidecar.exe`;

function runPowerShell(script, env) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env }, timeout: 60000 }
  );
  assert.equal(result.status, 0, `powershell failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const OWNED_CASES = [
  { label: 'Jenny image is accepted without a path', name: 'Jenny.exe', expected: true },
  { label: 'Jenny Shell (pre-1.0) image is accepted', name: 'Jenny Shell.exe', expected: true },
  { label: 'jenny-sidecar image is accepted', name: 'jenny-sidecar.exe', expected: true },
  { label: 'electron from this checkout is accepted', name: 'electron.exe', exe: ELECTRON, expected: true },
  {
    label: 'electron path match ignores case',
    name: 'electron.exe',
    exe: 'g:\\REPO\\Node_Modules\\Electron\\dist\\electron.exe',
    expected: true,
  },
  {
    label: 'electron outside the repo is rejected',
    name: 'electron.exe',
    exe: 'C:\\Users\\someone\\AppData\\Local\\Slack\\app\\electron.exe',
    expected: false,
  },
  {
    label: 'electron under a sibling-prefix repo path is rejected',
    name: 'electron.exe',
    exe: 'G:\\repo2\\node_modules\\electron\\dist\\electron.exe',
    expected: false,
  },
  {
    label: 'electron under a sibling-prefix electron-* directory is rejected',
    name: 'electron.exe',
    exe: `${REPO}\\node_modules\\electron-builder\\vendor\\electron.exe`,
    expected: false,
  },
  { label: 'electron with no executable path is rejected', name: 'electron.exe', exe: null, expected: false },
  {
    label: 'packaged sidecar next to Jenny.exe is accepted',
    name: 'sidecar.exe',
    exe: SIDECAR,
    existing: [`${INSTALL_DIR}\\Jenny.exe`],
    expected: true,
  },
  {
    label: 'packaged sidecar next to Jenny Shell.exe is accepted',
    name: 'sidecar.exe',
    exe: SIDECAR,
    existing: [`${INSTALL_DIR}\\Jenny Shell.exe`],
    expected: true,
  },
  {
    label: 'sidecar without Jenny.exe two levels up is rejected',
    name: 'sidecar.exe',
    exe: SIDECAR,
    existing: [],
    expected: false,
  },
  {
    label: 'sidecar outside resources\\sidecar is rejected',
    name: 'sidecar.exe',
    exe: 'C:\\tools\\sidecar.exe',
    existing: ['C:\\Jenny.exe'],
    expected: false,
  },
  { label: 'sidecar with no executable path is rejected', name: 'sidecar.exe', exe: null, existing: [], expected: false },
  {
    label: 'venv python running -m sidecar is accepted',
    name: 'python.exe',
    exe: VENV_PYTHON,
    cmd: `"${VENV_PYTHON}" -m sidecar`,
    expected: true,
  },
  {
    label: 'venv python running sidecar.server is accepted',
    name: 'python.exe',
    exe: VENV_PYTHON,
    cmd: `"${VENV_PYTHON}" -m sidecar.server --stdio`,
    expected: true,
  },
  {
    label: 'venv python running sidecar\\server.py is accepted',
    name: 'python.exe',
    exe: VENV_PYTHON,
    cmd: `"${VENV_PYTHON}" ${REPO}\\sidecar\\server.py`,
    expected: true,
  },
  {
    label: 'python outside the repo venv with a sidecar command line is rejected',
    name: 'python.exe',
    exe: 'C:\\Python311\\python.exe',
    cmd: '"C:\\Python311\\python.exe" -m sidecar',
    expected: false,
  },
  {
    label: 'python in a sibling-prefix venv is rejected',
    name: 'python.exe',
    exe: 'G:\\repo2\\.venv\\Scripts\\python.exe',
    cmd: '-m sidecar',
    expected: false,
  },
  {
    label: 'venv python running something else is rejected',
    name: 'python.exe',
    exe: VENV_PYTHON,
    cmd: `"${VENV_PYTHON}" -m pytest tests/sidecar`,
    expected: false,
  },
  {
    label: 'venv python with no command line is rejected',
    name: 'python.exe',
    exe: VENV_PYTHON,
    cmd: null,
    expected: false,
  },
  { label: 'python with no executable path is rejected', name: 'python.exe', exe: null, cmd: '-m sidecar', expected: false },
  { label: 'unrelated image is rejected', name: 'notepad.exe', exe: 'C:\\Windows\\notepad.exe', expected: false },
  { label: 'ollama is not decided by the generic identity check', name: 'ollama.exe', exe: 'C:\\ollama\\ollama.exe', expected: false },
];

const OWNED_SCRIPT = [
  `. ($env:JENNY_TEST_IDENTITY_SCRIPT)`,
  `$cases = @(ConvertFrom-Json -InputObject $env:JENNY_TEST_CASES | ForEach-Object { $_ })`,
  `$results = @()`,
  `foreach ($c in $cases) {`,
  `  $existing = @($c.existing)`,
  `  $results += [bool](Test-JennyOwnedProcess -Name $c.name -ExecutablePath $c.exe -CommandLine $c.cmd -RepoRoot $env:JENNY_TEST_REPO -TestPath { param($p) $existing -contains $p })`,
  `}`,
  `ConvertTo-Json -InputObject @($results) -Compress`,
].join('\n');

let ownedResults = null;
function getOwnedResults() {
  if (!ownedResults) {
    ownedResults = JSON.parse(
      runPowerShell(OWNED_SCRIPT, {
        JENNY_TEST_IDENTITY_SCRIPT: IDENTITY_SCRIPT,
        JENNY_TEST_CASES: JSON.stringify(OWNED_CASES),
        JENNY_TEST_REPO: REPO,
      })
    );
  }
  return ownedResults;
}

test('Test-JennyOwnedProcess decides every synthetic identity as specified', { skip: SKIP }, () => {
  const results = getOwnedResults();
  assert.equal(results.length, OWNED_CASES.length);
  OWNED_CASES.forEach((entry, index) => {
    assert.equal(results[index], entry.expected, entry.label);
  });
});

const OLLAMA_RECORDS = [
  { label: 'valid record', body: { pid: 4321, command: 'ollama serve', app_owned: true }, expected: '4321' },
  { label: 'app_owned false', body: { pid: 4321, command: 'ollama serve', app_owned: false }, expected: 'null' },
  { label: 'app_owned as a string', body: { pid: 4321, command: 'ollama serve', app_owned: 'true' }, expected: 'null' },
  { label: 'app_owned missing', body: { pid: 4321, command: 'ollama serve' }, expected: 'null' },
  { label: 'zero pid', body: { pid: 0, command: 'ollama serve', app_owned: true }, expected: 'null' },
  { label: 'negative pid', body: { pid: -5, command: 'ollama serve', app_owned: true }, expected: 'null' },
  { label: 'string pid', body: { pid: '4321', command: 'ollama serve', app_owned: true }, expected: 'null' },
  { label: 'fractional pid', body: { pid: 12.5, command: 'ollama serve', app_owned: true }, expected: 'null' },
  { label: 'missing file', body: undefined, expected: 'null' },
  { label: 'malformed JSON', raw: '{ not json', expected: 'null' },
];

test('Get-JennyOwnedOllamaPid trusts only a complete app-owned record', { skip: SKIP }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-record-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = OLLAMA_RECORDS.map((entry, index) => {
    const dir = path.join(root, `case-${index}`);
    fs.mkdirSync(dir);
    if (entry.raw !== undefined) {
      fs.writeFileSync(path.join(dir, 'ollama-process.json'), entry.raw);
    } else if (entry.body !== undefined) {
      fs.writeFileSync(path.join(dir, 'ollama-process.json'), JSON.stringify(entry.body));
    }
    return dir;
  });
  const script = [
    `. ($env:JENNY_TEST_IDENTITY_SCRIPT)`,
    `$dirs = @(ConvertFrom-Json -InputObject $env:JENNY_TEST_DIRS | ForEach-Object { $_ })`,
    `$out = @()`,
    `foreach ($d in $dirs) {`,
    `  $r = Get-JennyOwnedOllamaPid -ProfileRoot $d`,
    `  if ($null -eq $r) { $out += 'null' } else { $out += ([string]$r + ':' + $r.GetType().Name) }`,
    `}`,
    `ConvertTo-Json -InputObject @($out) -Compress`,
  ].join('\n');
  const results = JSON.parse(
    runPowerShell(script, {
      JENNY_TEST_IDENTITY_SCRIPT: IDENTITY_SCRIPT,
      JENNY_TEST_DIRS: JSON.stringify(dirs),
    })
  );
  assert.equal(results.length, OLLAMA_RECORDS.length);
  OLLAMA_RECORDS.forEach((entry, index) => {
    const expected = entry.expected === 'null' ? 'null' : `${entry.expected}:Int32`;
    assert.equal(results[index], expected, entry.label);
  });
});

test('Get-JennyDescendantPids lists the whole child tree, children before parents', { skip: SKIP }, () => {
  const at = (minute) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const processes = [
    { ProcessId: 10, ParentProcessId: 1, CreationDate: at(10) },
    { ProcessId: 20, ParentProcessId: 10, CreationDate: at(11) },
    { ProcessId: 30, ParentProcessId: 20, CreationDate: at(12) },
    { ProcessId: 40, ParentProcessId: 10, CreationDate: at(10) },
    { ProcessId: 50, ParentProcessId: 99, CreationDate: at(10) },
    { ProcessId: 60, ParentProcessId: 60, CreationDate: at(10) },
    // Older than pid 10: its parent pid was reused, so it is not a child.
    { ProcessId: 70, ParentProcessId: 10, CreationDate: at(5) },
    { ProcessId: 71, ParentProcessId: 70, CreationDate: at(6) },
    // No readable creation time: never counted.
    { ProcessId: 80, ParentProcessId: 10 },
    { ProcessId: 81, ParentProcessId: 10, CreationDate: 'not a date' },
  ];
  const script = [
    `. ($env:JENNY_TEST_IDENTITY_SCRIPT)`,
    `$procs = @(ConvertFrom-Json -InputObject $env:JENNY_TEST_PROCS | ForEach-Object { $_ })`,
    `$tree = @(Get-JennyDescendantPids -Processes $procs -RootPid 10)`,
    `$none = @(Get-JennyDescendantPids -Processes $procs -RootPid 50)`,
    `$self = @(Get-JennyDescendantPids -Processes $procs -RootPid 60)`,
    `ConvertTo-Json -InputObject @{ tree = $tree; none = $none; self = $self } -Compress`,
  ].join('\n');
  const result = JSON.parse(
    runPowerShell(script, {
      JENNY_TEST_IDENTITY_SCRIPT: IDENTITY_SCRIPT,
      JENNY_TEST_PROCS: JSON.stringify(processes),
    })
  );
  assert.deepEqual([...result.tree].sort((a, b) => a - b), [20, 30, 40]);
  assert.ok(result.tree.indexOf(30) < result.tree.indexOf(20), 'grandchild is listed before its parent');
  assert.equal(result.tree.includes(10), false);
  assert.deepEqual([].concat(result.none), []);
  assert.deepEqual([].concat(result.self), []);
});

test('a recorded Ollama pid matches only a process created by the recorded start', { skip: SKIP }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-match-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const withStart = path.join(root, 'with-start');
  const withoutStart = path.join(root, 'without-start');
  fs.mkdirSync(withStart);
  fs.mkdirSync(withoutStart);
  const startedAt = '2026-10-01T10:00:00.000Z';
  fs.writeFileSync(path.join(withStart, 'ollama-process.json'),
    JSON.stringify({ pid: 4242, command: 'ollama serve', startedAt, app_owned: true }));
  fs.writeFileSync(path.join(withoutStart, 'ollama-process.json'),
    JSON.stringify({ pid: 4242, command: 'ollama serve', app_owned: true }));
  const script = [
    `. ($env:JENNY_TEST_IDENTITY_SCRIPT)`,
    `$with = Get-JennyOwnedOllamaRecord -ProfileRoot $env:JENNY_TEST_WITH`,
    `$without = Get-JennyOwnedOllamaRecord -ProfileRoot $env:JENNY_TEST_WITHOUT`,
    `$out = [ordered]@{`,
    `  pid = $with.ProcessId`,
    `  hasStart = ($null -ne $with.StartedAt)`,
    `  before = [bool](Test-JennyRecordedProcessMatch -ProcessCreated '2026-10-01T09:59:59.500Z' -RecordedStart $with.StartedAt)`,
    `  within = [bool](Test-JennyRecordedProcessMatch -ProcessCreated '2026-10-01T10:00:03.000Z' -RecordedStart $with.StartedAt)`,
    `  reused = [bool](Test-JennyRecordedProcessMatch -ProcessCreated '2026-10-01T10:30:00.000Z' -RecordedStart $with.StartedAt)`,
    `  local = [bool](Test-JennyRecordedProcessMatch -ProcessCreated ([datetime]::Parse('2026-10-01T09:59:00Z')) -RecordedStart $with.StartedAt)`,
    `  noCreation = [bool](Test-JennyRecordedProcessMatch -ProcessCreated $null -RecordedStart $with.StartedAt)`,
    `  noStartPid = $without.ProcessId`,
    `  noStart = [bool](Test-JennyRecordedProcessMatch -ProcessCreated '2026-10-01T09:59:59.500Z' -RecordedStart $without.StartedAt)`,
    `}`,
    `ConvertTo-Json -InputObject $out -Compress`,
  ].join('\n');
  const result = JSON.parse(
    runPowerShell(script, {
      JENNY_TEST_IDENTITY_SCRIPT: IDENTITY_SCRIPT,
      JENNY_TEST_WITH: withStart,
      JENNY_TEST_WITHOUT: withoutStart,
    })
  );
  assert.deepEqual(result, {
    pid: 4242,
    hasStart: true,
    before: true,
    within: true,
    reused: false,
    local: true,
    noCreation: false,
    noStartPid: 4242,
    noStart: false,
  });
});
