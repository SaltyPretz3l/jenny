'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { classifyCommand, loadRules, DEFAULT_RULES } = require('../services/work-leases/rules');
const RULES_JSON = require('../services/work-leases/work-lease-rules.json');

const ENVS = {
  win32: { p: path.win32, root: 'C:\\proj' },
  posix: { p: path.posix, root: '/proj' },
};
const ALIASES = { TR: ['tests:all', 'deps:1'], INS: ['deps:all'], GW: ['git-write:all'] };

// Expected takes are written as `kind:units[@subdir]`; TR / INS / GW expand to the take sets.
function expand(spec) {
  const out = [];
  for (const word of spec.split(/\s+/).filter(Boolean)) {
    const at = word.indexOf('@');
    const head = at < 0 ? word : word.slice(0, at);
    const tail = at < 0 ? '' : word.slice(at);
    for (const item of ALIASES[head] || [head]) out.push((item + tail).replace(/~/g, ' '));
  }
  return out;
}

function summarize(env, result) {
  return result.takes.map((take) => {
    const rel = env.p.relative(env.root, take.dir).replace(/\\/g, '/');
    return `${take.kind}:${take.units}${rel ? `@${rel}` : ''}`;
  });
}

function fakeReader(env, pkg, calls) {
  return (dir) => {
    if (calls) calls.push(dir);
    if (pkg === 'throw') throw new Error('boom');
    if (!pkg) return null;
    return { dir: pkg.dir ? env.p.join(env.root, pkg.dir) : env.root, scripts: pkg.scripts };
  };
}

const PK = (scripts, dir) => ({ scripts, dir });
const gitWriteRows = [
  'add', 'am', 'cherry-pick', 'clean', 'commit', 'fetch', 'gc', 'merge', 'mv', 'pull', 'push',
  'rebase', 'reset', 'restore', 'revert', 'rm', 'switch', 'checkout', 'update-index', 'update-ref',
  'submodule',
].map((sub) => [`git ${sub} writes`, `git ${sub} x`, 'GW', { label: `git ${sub}` }]);
const gitReadRows = [
  'status', 'log', 'diff', 'show', 'grep', 'blame', 'rev-parse', 'ls-files', 'describe', 'config --get a.b',
  'remote', 'init', 'clone u',
].map((cmd) => [`git ${cmd} takes nothing`, `git ${cmd}`, '', { label: '' }]);
const nested = (depth) => {
  let inner = 'pytest';
  for (let i = 0; i < depth; i += 1) inner = `bash -c "${inner.replace(/(["\\])/g, '\\$1')}"`;
  return inner;
};

// [name, command, expected takes, options { only, pkg, label }]
const CASES = [
  // test runners
  ['pytest', 'pytest -x tests', 'TR', { label: 'pytest' }],
  ['py.test', 'py.test', 'TR'],
  ['python -m pytest', 'python -m pytest -k x', 'TR', { label: 'python -m pytest' }],
  ['python3 -m unittest', 'python3 -m unittest discover', 'TR'],
  ['py launcher flag', 'py -3 -m pytest', 'TR'],
  ['venv python forward slash', '.venv/bin/python -m pytest', 'TR'],
  ['venv python backslash', '.venv\\Scripts\\python.exe -m pytest', 'TR', { only: 'win32' }],
  ['upper-case exe on win32', 'PYTEST.EXE', 'TR', { only: 'win32' }],
  ['node --test', 'node --test tests/a.test.js', 'TR', { label: 'node --test' }],
  ['safe runner', 'node scripts/run-node-tests-safe.js tests/a.test.js', 'TR', { label: 'node run-node-tests-safe.js' }],
  ['run_ci', 'python scripts/run_ci.py', 'TR'],
  ['jest', 'jest', 'TR'],
  ['vitest', 'vitest run', 'TR'],
  ['playwright test', 'playwright test', 'TR'],
  ['playwright install is not a test', 'playwright install', ''],
  ['cargo test', 'cargo test', 'TR'],
  ['cargo nextest', 'cargo nextest run', 'TR'],
  ['go test', 'go test ./...', 'TR'],
  ['dotnet test', 'dotnet test', 'TR'],
  ['make test', 'make test', 'TR', { label: 'make test' }],
  ['make check-all', 'make check-all', 'TR'],
  ['make test glob', 'make test-unit', 'TR'],
  ['make -j value then target', 'make -j 4 test', 'TR'],
  ['make -C', 'make -C sub test', 'TR@sub'],
  ['make build', 'make build', ''],
  ['node script is not tests', 'node server.js', ''],
  ['plain python script', 'python tool.py --test', ''],
  ['python -c code', 'python -c "import pytest"', ''],
  // installs
  ['npm ci', 'npm ci', 'INS', { label: 'npm ci' }],
  ['npm install pkg', 'npm install left-pad', 'INS'],
  ['pnpm add', 'pnpm add x', 'INS'],
  ['yarn remove', 'yarn remove x', 'INS'],
  ['npm update', 'npm update', 'INS'],
  ['npm outdated is read-only', 'npm outdated', ''],
  ['pip install', 'pip install -r requirements.txt', 'INS'],
  ['python -m pip install', 'python -m pip install x', 'INS'],
  ['uv sync', 'uv sync', 'INS'],
  ['uv pip install', 'uv pip install x', 'INS', { label: 'uv pip install' }],
  ['npm ci then npm test merges deps to all', 'npm ci && npm test', 'INS tests:all'],
  // git writes
  ...gitWriteRows,
  ...gitReadRows,
  ['stash is a write', 'git stash', 'GW'],
  ['stash push', 'git stash push -m x', 'GW'],
  ['stash pop', 'git stash pop', 'GW'],
  ['stash list', 'git stash list', ''],
  ['branch list', 'git branch', ''],
  ['branch -a', 'git branch -a', ''],
  ['branch -vv', 'git branch -vv', ''],
  ['branch --list pattern', "git branch --list \"f*\"", ''],
  ['branch --show-current', 'git branch --show-current', ''],
  ['branch create', 'git branch feat', 'GW'],
  ['branch -m', 'git branch -m a b', 'GW'],
  ['branch --set-upstream-to', 'git branch --set-upstream-to=origin/main', 'GW'],
  ['tag list', 'git tag', ''],
  ['tag -l', 'git tag -l "v*"', ''],
  ['tag create', 'git tag v1', 'GW'],
  ['tag annotated', 'git tag -a v1 -m x', 'GW'],
  ['worktree list', 'git worktree list', ''],
  ['worktree add', 'git worktree add ../w', 'GW'],
  ['remote -v', 'git remote -v', ''],
  ['notes list', 'git notes list', ''],
  ['notes add', 'git notes add -m x', 'GW'],
  ['apply plain', 'git apply p.patch', ''],
  ['apply --index', 'git apply --index p.patch', 'GW'],
  ['apply --3way', 'git apply --3way p.patch', 'GW'],
  // git global options
  ['git -C', 'git -C sub commit -m x', 'GW@sub'],
  ['git -C cumulative', 'git -C sub -C deeper push', 'GW@sub/deeper'],
  ['git -C parent', 'git -C .. add .', 'GW@..'],
  ['git --git-dir= and work-tree=', 'git --git-dir=.git --work-tree=. add .', 'GW'],
  ['git many globals', 'git -c user.name=x --no-pager -p -C sub push', 'GW@sub'],
  ['git alone', 'git', ''],
  // script resolution
  ['npm test', 'npm test', 'TR', { pkg: PK({ test: 'jest' }), label: 'npm test' }],
  ['npm test without package.json', 'npm test', 'TR'],
  ['npm test reader throws', 'npm test', 'TR', { pkg: 'throw' }],
  ['npm t', 'npm t', 'TR'],
  ['npm run lint takes nothing', 'npm run lint', '', { pkg: PK({ lint: 'eslint .' }) }],
  ['npm run body classified', 'npm run check', 'TR', { pkg: PK({ check: 'pytest' }), label: 'npm run check' }],
  ['npm run nested into test', 'npm run build', 'TR', { pkg: PK({ build: 'npm test' }) }],
  ['npm run-script', 'npm run-script verify', 'TR', { pkg: PK({ verify: 'vitest' }) }],
  ['npm run name glob with opaque body', 'npm run test:affected', 'TR', { pkg: PK({ 'test:affected': 'node scripts/select-affected-tests.js' }) }],
  ['npm run name glob without package', 'npm run test:unit', 'TR', { pkg: 'throw' }],
  ['npm run tests glob', 'npm run tests', 'TR'],
  ['npm run non-test name without package', 'npm run lint', '', { pkg: 'throw' }],
  ['npm run with no script', 'npm run', ''],
  ['pnpm test', 'pnpm test', 'TR'],
  ['yarn test', 'yarn test', 'TR'],
  ['yarn bare script', 'yarn lint', 'TR', { pkg: PK({ lint: 'jest' }) }],
  ['yarn bare name that is no script', 'yarn lint', '', { pkg: PK({ other: 'jest' }) }],
  ['pretest hook merges', 'npm test', 'INS tests:all', { pkg: PK({ pretest: 'npm install', test: 'echo ok' }) }],
  ['posttest hook', 'npm test', 'TR GW', { pkg: PK({ test: 'jest', posttest: 'git add -A' }) }],
  ['pre hook on run', 'npm run build', 'GW', { pkg: PK({ prebuild: 'git fetch', build: 'tsc' }) }],
  ['script cycle terminates', 'npm run a', 'TR', { pkg: PK({ a: 'npm run b', b: 'npm run a && pytest' }) }],
  ['script depth 3 reached', 'npm run s1', 'TR', { pkg: PK({ s1: 'npm run s2', s2: 'npm run s3', s3: 'pytest' }) }],
  ['script depth 4 cut', 'npm run s1', '', { pkg: PK({ s1: 'npm run s2', s2: 'npm run s3', s3: 'npm run s4', s4: 'pytest' }) }],
  ['package.json dir wins', 'npm test', 'TR@pkg', { pkg: PK({ test: 'jest' }, 'pkg') }],
  ['npm --prefix', 'npm --prefix sub test', 'TR@sub'],
  ['npm --prefix=', 'npm test --prefix=sub', 'TR@sub'],
  ['pnpm -C', 'pnpm -C sub test', 'TR@sub'],
  ['yarn --cwd', 'yarn --cwd sub test', 'TR@sub'],
  ['npm --prefix install', 'npm --prefix sub ci', 'INS@sub'],
  // wrappers
  ['env prefix assignment', 'CI=1 pytest', 'TR'],
  ['env wrapper', 'env CI=1 FOO=2 pytest', 'TR'],
  ['time', 'time pytest', 'TR'],
  ['command', 'command pytest', 'TR'],
  ['command -v is a lookup', 'command -v pytest', ''],
  ['npx --yes', 'npx --yes vitest run', 'TR'],
  ['npx -p', 'npx -p pkg vitest', 'TR'],
  ['pnpm dlx', 'pnpm dlx vitest', 'TR'],
  ['pnpm exec', 'pnpm exec vitest', 'TR'],
  ['pnpm -C exec', 'pnpm -C sub exec vitest', 'TR@sub'],
  ['yarn dlx', 'yarn dlx jest', 'TR'],
  ['uv run', 'uv run pytest', 'TR'],
  // arguments are not commands
  ['echo npm test', 'echo npm test', ''],
  ['grep pytest', 'grep pytest file', ''],
  ['commit message with commands', 'git commit -m "npm test && x"', 'GW', { label: 'git commit' }],
  ['commit message semicolon', 'git commit -m "a; b | c"', 'GW'],
  // compound commands and directories
  ['and chain', 'echo hi && pytest', 'TR'],
  ['or chain', 'false || pytest', 'TR'],
  ['semicolon', 'echo a; pytest', 'TR'],
  ['pipe', 'pytest | tee out.txt', 'TR'],
  ['single ampersand', 'echo a & pytest', 'TR'],
  ['redirect ampersand is not a separator', 'pytest 2>&1', 'TR'],
  ['dedupe repeated command', 'pytest && pytest -x', 'TR'],
  ['two directories', 'pytest && cd sub && pytest', 'TR TR@sub'],
  ['write and test', 'git add . && pytest', 'GW TR'],
  ['cd', 'cd sub && pytest', 'TR@sub'],
  ['cd then back', 'cd sub; cd ..; pytest', 'TR'],
  ['cd /d', 'cd /d sub && pytest', 'TR@sub'],
  ['cd quoted with space', 'cd "my dir" && pytest', 'TR@my~dir'],
  ['cd parent sibling', 'cd ../other && pytest', 'TR@../other'],
  ['cd without arg', 'cd && pytest', 'TR'],
  ['cd home', 'cd ~ && pytest', 'TR'],
  ['cd variable', 'cd $HOME && pytest', 'TR'],
  ['pushd', 'pushd sub && pytest', 'TR@sub'],
  ['Set-Location', 'Set-Location sub; pytest', 'TR@sub'],
  ['cd in front of git -C', 'cd a && git -C b commit -m x', 'GW@a/b'],
  ['export is a no-op', 'export A=1 && pytest', 'TR'],
  ['set is a no-op', 'set A=1 && pytest', 'TR'],
  ['subshell parens', '(cd sub && pytest)', 'TR@sub'],
  ['subshell cd does not leak', 'cd sub && (cd ../x && ls) && pytest', 'TR@sub', { only: 'posix' }],
  ['cmd parens are a group, not a subshell', 'cd sub && (cd ../x && ls) && pytest', 'TR@x', { only: 'win32' }],
  ['command substitution cd does not leak', 'echo $(cd sub && pwd) && pytest', 'TR', { only: 'posix' }],
  ['popd returns to the pushd directory', 'pushd sub && popd && pytest', 'TR'],
  ['popd without pushd stays', 'popd && pytest', 'TR'],
  ['Push-Location then Pop-Location', 'Push-Location sub; Pop-Location; pytest', 'TR'],
  // shell wrappers
  ['cmd /c quoted', 'cmd /c "cd /d sub && npm test"', 'TR@sub'],
  ['cmd /d /s /c', 'cmd /d /s /c "pytest"', 'TR'],
  ['cmd.exe /C rest of line', 'cmd.exe /C npm test', 'TR'],
  ['cmd /c rest of line with chain', 'cmd /c cd sub && npm test', 'TR@sub'],
  ['cmd /c does not leak cd', 'cmd /c "cd sub" && pytest', 'TR'],
  ['powershell -Command', 'powershell -NoProfile -Command "Set-Location sub; npm test"', 'TR@sub'],
  ['pwsh full flags', 'pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -c "pytest"', 'TR'],
  ['powershell single quotes inside', "powershell -Command \"Set-Location 'my dir'; pytest\"", 'TR@my~dir'],
  ['powershell rest of line', 'powershell -Command Set-Location sub; pytest', 'TR@sub'],
  ['powershell.exe path', 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "git push"', 'GW'],
  ['powershell call operator', '& "C:/tools/python.exe" -m pytest', 'TR'],
  ['bash -c double quotes', 'bash -c "git commit -am x"', 'GW'],
  ['bash -c single quotes', "bash -c 'git commit -am x'", 'GW', { only: 'posix' }],
  ['bash -c single quotes nested', 'bash -c "bash -c \'pytest\'"', 'TR'],
  ['sh -lc', 'sh -lc "cd sub && pytest"', 'TR@sub'],
  ['bash script file is not unwrapped', 'bash run.sh', ''],
  ['shell nesting depth 3', nested(3), 'TR', { only: 'posix' }],
  ['shell nesting depth 5 is cut', nested(5), '', { only: 'posix' }],
  // unknown or hostile input
  ['inherited property names', 'toString && constructor x && __proto__ && pytest', 'TR'],
  ['git subcommand named like a property', 'git constructor && git __proto__ && git commit', 'GW'],
  ['unknown command', 'ls -la', ''],
  ['empty', '', ''],
  ['blank', '   \n\t ', ''],
  ['only separators', '&& ;; || | &', ''],
  ['lone quote', '"', ''],
];

for (const platform of ['win32', 'posix']) {
  for (const [name, command, spec, opts = {}] of CASES) {
    if (opts.only && opts.only !== platform) continue;
    test(`${platform}: ${name}`, () => {
      const env = ENVS[platform];
      const result = classifyCommand(command, {
        cwd: env.root, platform, readPackageJson: fakeReader(env, opts.pkg),
      });
      assert.deepEqual(summarize(env, result), expand(spec));
      if (opts.label !== undefined) assert.equal(result.label, opts.label);
    });
  }
}

test('rows cover at least sixty distinct cases', () => {
  assert.ok(new Set(CASES.map((row) => row[0])).size >= 60);
});

test('labels are short and free of secrets', () => {
  const env = ENVS.posix;
  const opts = { cwd: env.root, platform: 'posix', readPackageJson: fakeReader(env, null) };
  assert.equal(classifyCommand('git push https://user:tok@host/x', opts).label, 'git push');
  assert.equal(classifyCommand('FOO=sekret pytest --token abc', opts).label, 'pytest');
  assert.equal(classifyCommand('npm run test:unit', opts).label, 'npm run test:unit');
  assert.equal(classifyCommand('git commit -m "pw=hunter2"', opts).label, 'git commit');
  assert.equal(classifyCommand('echo hi', opts).label, '');
  assert.equal(classifyCommand('git status', opts).label, '');
  for (const command of ['git push https://user:tok@host/x', 'pytest --token abc']) {
    assert.doesNotMatch(classifyCommand(command, opts).label, /tok|abc|@/);
  }
});

test('label comes from the first classified segment', () => {
  const env = ENVS.posix;
  const opts = { cwd: env.root, platform: 'posix', readPackageJson: fakeReader(env, null) };
  assert.equal(classifyCommand('echo a && git add . && pytest', opts).label, 'git add');
  assert.equal(classifyCommand('npm ci && npm test', opts).label, 'npm ci');
});

test('take records carry scope, capacity, dir and the rule id', () => {
  const env = ENVS.posix;
  const result = classifyCommand('cd sub && pytest && git commit -m x', {
    cwd: env.root, platform: 'posix', readPackageJson: fakeReader(env, null),
  });
  assert.deepEqual(result.takes.map((take) => ({ ...take })), [
    { kind: 'tests', scope: 'tree', dir: '/proj/sub', units: 'all', capacity: 1, rule: 'pytest' },
    { kind: 'deps', scope: 'tree', dir: '/proj/sub', units: 1, capacity: null, rule: 'pytest' },
    { kind: 'git-write', scope: 'repo', dir: '/proj/sub', units: 'all', capacity: 1, rule: 'git:commit' },
  ]);
});

test('results are frozen', () => {
  const env = ENVS.posix;
  const result = classifyCommand('pytest', { cwd: env.root, platform: 'posix', readPackageJson: fakeReader(env) });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.takes));
  assert.ok(result.takes.every((take) => Object.isFrozen(take)));
  assert.ok(Object.isFrozen(classifyCommand('ls', { cwd: env.root, platform: 'posix' }).takes));
});

test('npm-style scripts read package.json from the segment directory', () => {
  const env = ENVS.posix;
  const calls = [];
  classifyCommand('cd sub && npm run lint && npm --prefix other test', {
    cwd: env.root, platform: 'posix', readPackageJson: fakeReader(env, PK({ lint: 'echo' }), calls),
  });
  assert.deepEqual(calls, ['/proj/sub', '/proj/sub/other']);
});

test('a missing cwd is a programming error', () => {
  assert.throws(() => classifyCommand('pytest', {}), TypeError);
  assert.throws(() => classifyCommand('pytest'), TypeError);
});

test('non-string commands take nothing', () => {
  for (const value of [undefined, null, 5, {}, []]) {
    assert.deepEqual(classifyCommand(value, { cwd: '/proj', platform: 'posix' }).takes, []);
  }
});

test('default package.json reader walks up and tolerates bad files', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-wl-rules-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const good = path.join(base, 'good');
  const deep = path.join(good, 'a', 'b');
  const bad = path.join(base, 'bad');
  fs.mkdirSync(deep, { recursive: true });
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(good, 'package.json'), JSON.stringify({ scripts: { check: 'pytest', lint: 'eslint .' } }));
  fs.writeFileSync(path.join(bad, 'package.json'), '{ not json');
  const found = classifyCommand('npm run check', { cwd: deep });
  assert.deepEqual(found.takes.map((take) => [take.kind, take.dir]), [['tests', good], ['deps', good]]);
  assert.deepEqual(classifyCommand('npm run lint', { cwd: deep }).takes, []);
  assert.deepEqual(classifyCommand('npm run check', { cwd: bad }).takes, []);
  assert.deepEqual(classifyCommand('npm run test:x', { cwd: bad }).takes.map((take) => take.kind), ['tests', 'deps']);
});

test('fuzz: 500 random strings never throw', () => {
  let seed = 0x9e3779b9;
  const rand = (n) => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
    return seed % n;
  };
  const atoms = [
    'git', 'commit', '-C', '-c', 'npm', 'run', 'test', 'pytest', 'python', '-m', 'cd', '/d', 'sub', '..', 'cmd', '/c',
    'bash', '-lc', 'powershell', '-Command', '&&', '||', ';', '|', '&', '\n', '"', "'", '\\', '(', ')', '`', '$',
    '=', 'A=B', '>', '2>&1', '--prefix', 'x', 'env', 'npx', 'uv', 'run', 'pip', 'install', 'stash', 'branch', '-d',
    '--', '%', '~', '\u0000', '\u00e9', 'node', '--test', 'yarn', ' ', '  ',
  ];
  for (let i = 0; i < 500; i += 1) {
    let text = '';
    const parts = rand(24);
    for (let j = 0; j < parts; j += 1) text += atoms[rand(atoms.length)] + (rand(3) ? ' ' : '');
    for (const platform of ['win32', 'posix']) {
      const env = ENVS[platform];
      const result = classifyCommand(text, { cwd: env.root, platform, readPackageJson: fakeReader(env, PK({ test: 'npm run test', x: 'x' })) });
      assert.ok(Array.isArray(result.takes) && typeof result.label === 'string');
      assert.ok(result.takes.every((take) => typeof take.dir === 'string' && take.dir.length > 0));
    }
  }
  const long = 'git add . && '.repeat(20_000);
  assert.ok(classifyCommand(long, { cwd: '/proj', platform: 'posix' }).takes.length <= 1);
});

test('exponential script graphs stay bounded', () => {
  const scripts = {};
  for (let i = 0; i < 6; i += 1) scripts[`s${i}`] = `${'npm run s' + (i + 1) + ' && '}`.repeat(40) + 'echo';
  const env = ENVS.posix;
  const started = Date.now();
  classifyCommand('npm run s0', { cwd: env.root, platform: 'posix', readPackageJson: fakeReader(env, PK(scripts)) });
  assert.ok(Date.now() - started < 2_000);
});

test('default rules are a frozen, loaded copy of the JSON table', () => {
  assert.ok(Object.isFrozen(DEFAULT_RULES));
  assert.ok(Object.isFrozen(DEFAULT_RULES.rules));
  assert.ok(Object.isFrozen(DEFAULT_RULES.take_sets));
  assert.deepEqual(DEFAULT_RULES.take_sets['test-run'].map((take) => `${take.kind}:${take.units}`), ['tests:all', 'deps:1']);
  assert.deepEqual(DEFAULT_RULES.take_sets.install.map((take) => `${take.kind}:${take.units}`), ['deps:all']);
  assert.deepEqual({ ...DEFAULT_RULES.resources.tests }, { scope: 'tree', capacity: 1 });
  assert.deepEqual({ ...DEFAULT_RULES.resources.deps }, { scope: 'tree', capacity: null });
  assert.deepEqual({ ...DEFAULT_RULES.resources['git-write'] }, { scope: 'repo', capacity: 1 });
  assert.deepEqual([...DEFAULT_RULES.npm_script_name_globs], ['test', 'test:*', 'tests']);
  const again = loadRules(JSON.parse(JSON.stringify(RULES_JSON)));
  assert.notEqual(again, DEFAULT_RULES);
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(DEFAULT_RULES)));
});

test('loadRules copies its input', () => {
  const source = JSON.parse(JSON.stringify(RULES_JSON));
  const loaded = loadRules(source);
  source.rules[0].exe.push('hacked');
  source.take_sets['test-run'].length = 0;
  assert.ok(!loaded.rules[0].exe.includes('hacked'));
  assert.equal(loaded.take_sets['test-run'].length, 2);
});

test('loadRules rejects invalid tables with TypeError', () => {
  const clone = () => JSON.parse(JSON.stringify(RULES_JSON));
  const mutations = {
    'null table': () => null,
    'missing resources': (t) => { delete t.resources; return t; },
    'bad kind name': (t) => { t.resources.Bad_Kind = { scope: 'tree', capacity: 1 }; return t; },
    'bad scope': (t) => { t.resources.tests.scope = 'machine'; return t; },
    'zero capacity': (t) => { t.resources.tests.capacity = 0; return t; },
    'take set with unknown kind': (t) => { t.take_sets.install = [{ kind: 'nope', units: 'all' }]; return t; },
    'duplicate rule id': (t) => { t.rules[1].id = t.rules[0].id; return t; },
    'rule without action': (t) => { delete t.rules[0].takes; return t; },
    'rule with both actions': (t) => { t.rules[0].runs_script = 'test'; return t; },
    'rule with unknown take set': (t) => { t.rules[0].takes = 'nope'; return t; },
    'rule without exe': (t) => { delete t.rules[0].exe; return t; },
    'bad match mode': (t) => { t.rules[0].match = 'some'; return t; },
    'unknown script take set': (t) => { t.script_take_set = 'nope'; return t; },
    'git conditional with unknown key': (t) => { t.git.conditional.stash.bogus = []; return t; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    assert.throws(() => loadRules(mutate(clone())), TypeError, name);
  }
});

test('custom tables merge units: all beats a number, otherwise the larger wins', () => {
  const rules = loadRules({
    version: 1,
    resources: { gpu: { scope: 'tree', capacity: 4 } },
    take_sets: { two: [{ kind: 'gpu', units: 2 }], three: [{ kind: 'gpu', units: 3 }], full: [{ kind: 'gpu', units: 'all' }] },
    npm_script_name_globs: [],
    script_take_set: 'two',
    directory_commands: ['cd'],
    directory_push_commands: ['pushd'],
    directory_pop_commands: ['popd'],
    shells: { cmd: ['cmd'], powershell: ['pwsh'], posix: ['sh'] },
    wrappers: [],
    dir_flags: [],
    interpreters: {},
    git: {
      exe: ['git'], take_set: 'two', global_flags_with_value: ['-c'], write_subcommands: ['commit'], conditional: {},
    },
    rules: [
      { id: 'a', exe: ['aa'], takes: 'two' },
      { id: 'b', exe: ['bb'], takes: 'three' },
      { id: 'c', exe: ['cc'], takes: 'full' },
    ],
  });
  const run = (command) => classifyCommand(command, { cwd: '/p', platform: 'posix', rules }).takes.map((take) => `${take.kind}:${take.units}:${take.capacity}`);
  assert.deepEqual(run('aa && bb'), ['gpu:3:4']);
  assert.deepEqual(run('bb && aa'), ['gpu:3:4']);
  assert.deepEqual(run('aa && cc && bb'), ['gpu:all:4']);
  assert.deepEqual(run('cc && aa'), ['gpu:all:4']);
  assert.deepEqual(run('pytest'), []);
});
