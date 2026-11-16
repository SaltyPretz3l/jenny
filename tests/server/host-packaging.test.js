'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  initializeOwner,
  parseCliArgs,
} = require('../../server/cli');
const { buildBrowser } = require('../../scripts/build-browser');

const ROOT = path.resolve(__dirname, '../..');

test('owner-init parses only the concrete offline initialization command', () => {
  assert.deepEqual(parseCliArgs(['owner-init', '--config', '/etc/jenny/host.json']), {
    command: 'owner-init', configPath: '/etc/jenny/host.json',
  });
  assert.throws(() => parseCliArgs(['owner-sessions', '--config', '/etc/jenny/host.json']));
  assert.throws(() => parseCliArgs(['owner-init']));
});

test('owner initialization takes the profile lock before constructing auth state', async () => {
  const events = [];
  const output = { write(value) { events.push(`output:${value}`); } };
  let initializedPassword = '';
  class FakeStore {
    constructor(options) { events.push(`store:${options.filePath}`); }
  }
  class FakeAuth {
    constructor() { events.push('auth'); }
    isConfigured() { return false; }
    async initializePassword(value) { initializedPassword = value; return { ok: true }; }
  }
  const result = await initializeOwner({
    config: { userDataPath: path.join(ROOT, 'tmp-owner-profile') },
    acquireProfileImpl() {
      events.push('lock');
      return { release() { events.push('release'); } };
    },
    AuthStoreImpl: FakeStore,
    AuthServiceImpl: FakeAuth,
    readPasswordImpl: (() => {
      const values = ['correct horse battery staple', 'correct horse battery staple'];
      return () => Promise.resolve(values.shift());
    })(),
    output,
    confirmOutput: output,
  });
  assert.equal(result.ok, true);
  assert.equal(initializedPassword, 'correct horse battery staple');
  assert.deepEqual(events.slice(0, 3), ['lock', `store:${path.join(ROOT, 'tmp-owner-profile', 'auth.json')}`, 'auth']);
  assert.equal(events.at(-1), 'release');
  assert.equal(events.some((entry) => entry.includes('correct horse')), false);
});

test('browser build has no fallback when the explicit source allowlist is absent', () => {
  const root = fs.mkdtempSync(path.join(ROOT, 'tmp-browser-build-'));
  try {
    assert.throws(() => buildBrowser({ root }), /Browser input is missing/);
    assert.equal(fs.existsSync(path.join(root, 'build', 'browser')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Docker packaging uses a stable runtime allowlist and host hardening', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const ignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  const compose = fs.readFileSync(path.join(ROOT, 'compose.host.yml'), 'utf8');
  const pinnedBase = 'node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df';
  assert.equal(dockerfile.split(pinnedBase).length - 1, 2);
  assert.equal((dockerfile.match(/^FROM /gm) || []).length, 2);
  assert.doesNotMatch(dockerfile, /HOME=\/data/);
  assert.match(dockerfile, /HOME=\/tmp\/jenny-host-runtime/);
  assert.match(dockerfile, /python3\.11/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /COPY --from=browser-builder \/src\/build\/browser/);
  assert.match(dockerfile, /COPY renderer\/features\/renderer-plan-document\.js \.\/renderer\/features\/renderer-plan-document\.js/);
  assert.match(dockerfile, /COPY locales\/\*\.json \.\/locales\//);
  assert.match(ignore, /(^|\n)!locales\r?\n/);
  assert.match(ignore, /(^|\n)!locales\/\*\.json\r?\n/);
  assert.match(ignore, /(^|\n)!renderer\/features\r?\n/);
  assert.match(ignore, /(^|\n)!renderer\/features\/renderer-plan-document\.js\r?\n/);
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s+\.?\/?/);
  assert.doesNotMatch(dockerfile, /COPY\s+(?:tests|plugins|\.git)\b/);
  assert.match(ignore, /(^|\n)tests\r?\n/);
  assert.match(ignore, /(^|\n)plugins\r?\n/);
  assert.match(compose, /127\.0\.0\.1:8080:8080/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /cap_drop:[\s\S]*- ALL/);
  assert.match(compose, /pids_limit:\s*256/);
  assert.match(compose, /pids:\s*256/);
  assert.match(compose, /stop_grace_period:\s*30s/);
  assert.match(compose, /healthcheck:[\s\S]*server\/healthcheck\.js[\s\S]*--ready/);
  assert.match(compose, /cpus:\s*["']?2\.0/);
  assert.match(compose, /memory:\s*2G/);
  assert.match(compose, /\/tmp:size=268435456/);
  assert.match(compose, /\/run\/jenny-secrets:ro/);
  assert.doesNotMatch(compose, /docker\.sock|network_mode:\s*host|pid:\s*host|privileged:\s*true/);
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'hosted.yml'), 'utf8');
  for (const input of ['renderer/shared/**', 'renderer/chat/**', 'renderer/inventory/**', 'renderer/features/renderer-plan-document.js', 'locales/**']) {
    assert.ok(workflow.includes(`- '${input}'`), `hosted workflow must rebuild when ${input} changes`);
  }
});

test('hosted workflow boots the real image entrypoint against a fresh profile', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'hosted.yml'), 'utf8');
  const smoke = fs.readFileSync(path.join(ROOT, 'scripts', 'packaging', 'smoke-host-container.sh'), 'utf8');
  const ownerInit = fs.readFileSync(path.join(ROOT, 'scripts', 'packaging', 'owner-init-container.py'), 'utf8');
  assert.match(workflow, /smoke-host-container\.sh jenny-host:ci/);
  assert.match(ownerInit, /"server\/cli\.js", "owner-init"/);
  assert.match(smoke, /docker run -d/);
  assert.match(smoke, /probe-host-container\.js/);
  assert.match(smoke, /docker volume create/);
});

test('hosted workflow runs the Windows file-access crate and tests with the library required', () => {
  const raw = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'hosted.yml'), 'utf8');
  const workflow = raw.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  const start = workflow.indexOf('\n  windows-host:');
  assert.ok(start > 0, 'hosted workflow needs a windows-host job');
  const rest = workflow.slice(start + 1);
  const next = rest.slice(rest.indexOf('\n') + 1).search(/^ {2}[\w-]+:\s*$/m);
  const job = next < 0 ? rest : rest.slice(0, rest.indexOf('\n') + 1 + next);
  assert.ok(workflow.includes("- 'native/jenny-file-access/**'"), 'crate changes must trigger the workflow');
  assert.match(job, /runs-on: windows-latest/);
  assert.match(job, /timeout-minutes: 30/);
  assert.match(job, /JENNY_REQUIRE_FILE_ACCESS: '1'/);
  assert.match(job, /cargo fmt --check/);
  assert.match(job, /cargo clippy --release --all-targets --locked -- -D warnings/);
  assert.match(job, /cargo test --release --locked --features test-seams --target-dir target\/seams/);
  assert.match(job, /scripts\/packaging\/build_file_access\.py\s*$/m);
  assert.match(job, /build', 'sidecar', 'jenny_file_access\.dll'/);
  for (const name of [
    'test_hosted_file_io', 'test_hosted_file_io_backend_selection', 'test_hosted_file_io_abi_contract',
    'test_hosted_file_io_win32_client', 'test_hosted_file_io_win32_loader', 'test_hosted_file_io_win32_e2e',
    'test_build_file_access', 'test_builtin_server_hosted_degrade', 'test_host_execution_policy',
    'test_host_policy_dispatch',
  ]) {
    assert.ok(job.includes(`tests/sidecar/${name}.py`), `windows-host must run ${name}.py`);
  }
  assert.ok(job.includes('tests/server/host-windows-workspace-root.test.js'));
  assert.match(job, /--junitxml/);
  assert.match(job, /skipped == 0/);
  assert.match(job, /total > 0/);
  assert.doesNotMatch(workflow, /--allow-missing-toolchain/);
  assert.doesNotMatch(workflow, /CARGO_TARGET_DIR/);
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  const linux = workflow.slice(workflow.indexOf('\n  linux-host:'), start);
  assert.match(linux, /working-directory: native\/jenny-file-access/);
  assert.match(linux, /^ +cargo test --locked$/m);
});

function browserBuildFixture() {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jenny-browser-build-'));
  const input = path.join(root, 'renderer', 'browser');
  const output = path.join(root, 'build', 'browser');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(path.join(root, 'locales'));
  for (const tag of [...require('../../renderer/shared/i18n-utils').SUPPORTED_TAGS, 'qps-ploc']) {
    fs.writeFileSync(path.join(root, 'locales', `${tag}.json`), '{}');
  }
  for (const file of ['index.html', 'app.js', 'styles.css']) {
    fs.writeFileSync(path.join(input, file), `new ${file}`);
    fs.writeFileSync(path.join(output, file), `old ${file}`);
  }
  return { root, output };
}

test('failed browser bundling preserves the complete previous build', () => {
  const { root, output } = browserBuildFixture();
  try {
    assert.throws(() => buildBrowser({ root, esbuildImpl: {
      buildSync() { throw new Error('compiler unavailable'); },
    } }), /compiler unavailable/);
    for (const file of ['index.html', 'app.js', 'styles.css']) {
      assert.equal(fs.readFileSync(path.join(output, file), 'utf8'), `old ${file}`);
    }
    assert.deepEqual(fs.readdirSync(path.dirname(output)), ['browser']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed browser promotion restores the previous build and removes staging', () => {
  const { root, output } = browserBuildFixture();
  const rename = fs.renameSync;
  let promotionFailed = false;
  try {
    fs.renameSync = (source, destination) => {
      if (!promotionFailed && path.basename(source).startsWith('.browser-next-')) {
        promotionFailed = true;
        throw new Error('promotion unavailable');
      }
      return rename(source, destination);
    };
    assert.throws(() => buildBrowser({ root, esbuildImpl: {
      buildSync({ outfile }) { fs.writeFileSync(outfile, 'new bundle'); },
    } }), /promotion unavailable/);
    assert.equal(promotionFailed, true);
    for (const file of ['index.html', 'app.js', 'styles.css']) {
      assert.equal(fs.readFileSync(path.join(output, file), 'utf8'), `old ${file}`);
    }
    assert.deepEqual(fs.readdirSync(path.dirname(output)), ['browser']);
  } finally {
    fs.renameSync = rename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('guided Docker setup ships its launchers and reuses the canonical runtime', () => {
  const easy = fs.readFileSync(path.join(ROOT, 'compose.host.easy.yml'), 'utf8');
  // The public export omits its private generation manifest; verify actual files
  // in both trees and additionally check export selection in the source tree.
  const manifest = require('../../package.json').distribution === true
    ? null
    : JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/packaging/dist_manifest.json'), 'utf8'));
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/hosted.yml'), 'utf8');
  assert.match(easy, /file: compose.host.yml/);
  assert.match(easy, /jenny_config:\/etc\/jenny:ro/);
  assert.match(easy, /jenny_secrets:\/run\/jenny-secrets:ro/);
  assert.doesNotMatch(easy, /privileged:\s*true|docker\.sock|user:\s*["']?0/);
  for (const filename of ['docker-setup.sh', 'docker-setup.ps1', 'compose.host.easy.yml']) {
    if (manifest) assert.ok(manifest.include_paths.includes(filename));
    assert.ok(fs.statSync(path.join(ROOT, filename)).isFile());
  }
  assert.match(workflow, /smoke-host-setup\.js jenny-host:ci/);
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const ignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  assert.equal((dockerfile.match(/COPY renderer\/features\/renderer-plan-document.js/g) || []).length, 2);
  assert.match(ignore, /!renderer\/features\/renderer-plan-document.js/);
});

// Slice 3-11: the team host image and compose file (decision E4). Dockerfile and compose.host.yml stay
// as pinned above; the team files are separate.
const yaml = require('js-yaml');
const SECRET_SHAPED = /key|token|secret|password|seed|invite|credential/i;
const readText = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n');

// Dockerfile instructions with comments dropped and `\` continuations joined, each with its stage index.
function dockerInstructions(text) {
  const out = [];
  let stage = -1;
  let pending = '';
  for (const raw of text.split('\n')) {
    if (/^\s*#/.test(raw) && pending === '') continue;
    const line = raw.replace(/\s+$/, '');
    if (line.endsWith('\\')) { pending += `${line.slice(0, -1)} `; continue; }
    const whole = (pending + line).trim();
    pending = '';
    if (!whole) continue;
    const keyword = whole.split(/\s+/, 1)[0].toUpperCase();
    if (keyword === 'FROM') stage += 1;
    out.push({ stage, keyword, text: whole.replace(/\s+/g, ' ') });
  }
  return out;
}

// The package names a RUN installs with apt-get or pip (flags dropped; a requirements file kept by name).
function installedPackages(instructions) {
  const names = new Set();
  for (const { keyword, text } of instructions) {
    if (keyword !== 'RUN') continue;
    for (const part of text.slice(4).split('&&')) {
      const match = part.trim().match(/(?:apt-get install|pip install)\s+(.*)$/);
      if (!match) continue;
      for (const word of match[1].split(/\s+/)) if (word && !word.startsWith('-')) names.add(word);
    }
  }
  return names;
}

test('3-11: Dockerfile.team is the hosted runtime plus the prebuilt bridge, with no toolchain, sandbox or secret', () => {
  const text = readText('Dockerfile.team');
  const hostedText = readText('Dockerfile');
  const team = dockerInstructions(text);
  const hosted = dockerInstructions(hostedText);
  const pinnedBase = hostedText.match(/^FROM --platform=linux\/amd64 (\S+) AS browser-builder$/m)[1];
  assert.equal(text.split(pinnedBase).length - 1, 2);
  assert.equal(team.filter((entry) => entry.keyword === 'FROM').length, 2);
  assert.match(text, /^USER 10001:10001$/m);
  assert.match(text, /useradd --uid 10001 --gid 10001/);
  assert.match(text, /HOME=\/tmp\/jenny-host-runtime/);
  assert.match(text, /^ENTRYPOINT \["node", "server\/main\.js"\]$/m);
  // No secret in any ENV or ARG instruction of either stage.
  for (const { keyword, text: instruction } of team) {
    if (keyword === 'ENV' || keyword === 'ARG') assert.doesNotMatch(instruction, SECRET_SHAPED, instruction);
  }
  // The builder stage is the hosted one, instruction for instruction.
  const stageOf = (list, index) => list.filter((entry) => entry.stage === index).map((entry) => entry.text);
  assert.deepEqual(stageOf(team, 0), stageOf(hosted, 0));
  // The runtime COPY set is the hosted one plus exactly the bridge, copied (not built) to the path
  // bridge-binary.js reads in a checkout (/app/build/sidecar/), and run once at build time.
  const copies = (list) => list.filter((entry) => entry.stage === 1 && entry.keyword === 'COPY').map((entry) => entry.text);
  const bridge = 'COPY --chmod=0555 build/sidecar/jenny-team-bridge ./build/sidecar/jenny-team-bridge';
  assert.deepEqual(new Set(copies(team)), new Set([...copies(hosted), bridge]));
  assert.equal(copies(team).length, copies(hosted).length + 1);
  assert.match(text, /jenny-team-bridge --version \| grep -qx 'jenny-team-bridge protocol 1'/);
  // No RUN installs a package the hosted image does not.
  const extra = [...installedPackages(team)].filter((name) => !installedPackages(hosted).has(name));
  assert.deepEqual(extra, []);
  assert.ok(installedPackages(team).has('python3.11'), 'the parser sees the apt-get line');
  // No sandbox: no worker volume, control group, staging or command workspace.
  assert.doesNotMatch(text, /jenny-worker|jenny-control|jenny-staging|\/inputs|\/workspace\b|EXPOSE/);
  // The data volume's root and its projects/ exist in the image, owned by the host user.
  assert.match(text, /install -d -m 0700 -o 10001 -g 10001 \/data \/run\/jenny-secrets \/etc\/jenny \/tmp \\\n\s+\/srv\/jenny-team \/srv\/jenny-team\/projects/);
});

// Every key and value of a compose service, as `path=value` lines; mount strings are left out, since the
// secrets volume is named for what it holds and they are pinned exactly below.
function serviceLeaves(value, at = '') {
  if (Array.isArray(value)) return value.flatMap((item, index) => (at.endsWith('volumes') ? [] : serviceLeaves(item, `${at}[${index}]`)));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => [`${at}.${key}`, ...serviceLeaves(item, `${at}.${key}`)]);
  return [`${at}=${value}`];
}

test('3-11: compose.team.yml is hardened, publishes one UDP port and no TCP, and keeps projects and trash on one mount', () => {
  const compose = yaml.load(readText('compose.team.yml'));
  assert.deepEqual(Object.keys(compose.services), ['team', 'setup']);
  const { team, setup } = compose.services;
  assert.equal(team.build.dockerfile, 'Dockerfile.team');
  assert.equal(team.read_only, true);
  assert.deepEqual(team.cap_drop, ['ALL']);
  assert.deepEqual(team.security_opt, ['no-new-privileges:true']);
  assert.equal(team.pids_limit, 256);
  assert.equal(team.user, '10001:10001');
  assert.deepEqual(team.tmpfs, ['/tmp:size=268435456,mode=1777']);
  assert.equal(team.logging.driver, 'local');
  assert.deepEqual(team.ports, ['41700:41700/udp'], 'one UDP port, nothing on TCP');
  assert.deepEqual(team.healthcheck.test, ['CMD', 'node', 'server/healthcheck.js', '--config', '/etc/jenny/team-host.json', '--ready']);
  assert.deepEqual(team.command, ['--config', '/etc/jenny/team-host.json'], 'the server prints no invite');
  assert.equal(team.entrypoint, undefined);
  assert.equal(team.network_mode, undefined);
  const mounts = ['jenny_team_profile:/data', 'jenny_team_data:/srv/jenny-team', './team-config:/etc/jenny:ro'];
  assert.deepEqual(team.volumes, [mounts[0], mounts[1], 'jenny_team_secrets:/run/jenny-secrets:ro', mounts[2]]);
  // The example config's paths sit on the team service's mounts: the profile and the secrets are mount
  // targets, the config file and the projects root lie directly under one (so the trash, the projects
  // root's sibling, is on the same mount).
  const targets = team.volumes.map((entry) => entry.split(':')[1]);
  const example = JSON.parse(readText('config/team-host.example.json'));
  assert.ok(targets.includes(example.user_data_path), 'user_data_path is a mount');
  assert.ok(targets.includes(example.secrets_dir), 'secrets_dir is a mount');
  assert.ok(targets.includes(path.posix.dirname(team.command[1])), 'the --config file is in the config mount');
  assert.deepEqual(team.healthcheck.test.slice(3, 5), team.command);
  assert.ok(targets.includes(path.posix.dirname(example.team.projects_root)), 'projects_root is directly under the data mount');
  assert.equal(path.posix.dirname(example.team.projects_root), '/srv/jenny-team');
  assert.equal(`${example.team.direct_port}:${example.team.direct_port}/udp`, team.ports[0]);
  // Setup: same image, no logs, no network, exactly the team mounts with the secrets writable for it alone,
  // plus (slices 3-13, 3-14) the read-only import folder and the writable exchange folder, on setup only.
  assert.deepEqual(setup.profiles, ['setup']);
  assert.equal(setup.image, team.image);
  assert.deepEqual(setup.logging, { driver: 'none' });
  assert.equal(setup.network_mode, 'none');
  assert.equal(setup.read_only, true);
  assert.deepEqual(setup.cap_drop, ['ALL']);
  assert.deepEqual(setup.volumes, [mounts[0], mounts[1], 'jenny_team_secrets:/run/jenny-secrets', mounts[2],
    './team-import:/mnt/jenny-import:ro', './team-exchange:/mnt/jenny-exchange']);
  assert.equal(example.team.import_dir, '/mnt/jenny-import', 'the example names the import mount');
  assert.equal(example.team.exchange_dir, '/mnt/jenny-exchange', 'the example names the exchange mount');
  assert.ok(!targets.includes(example.team.import_dir) && !targets.includes(example.team.exchange_dir), 'the team service mounts neither');
  assert.equal(setup.ports, undefined);
  for (const service of [team, setup]) {
    // No key, value or name anywhere in the service is secret-shaped (no environment can carry one).
    for (const leaf of serviceLeaves(service)) assert.doesNotMatch(leaf, SECRET_SHAPED, leaf);
    assert.notEqual(service.privileged, true);
    assert.doesNotMatch(JSON.stringify(service), /docker\.sock|pid":"host|"network_mode":"host"/);
  }
  assert.doesNotMatch(readText('compose.team.yml').replace(/^\s*#.*$/gm, ''), /team-init|team-recover|environment:|env_file:/);
  assert.deepEqual(Object.keys(compose.volumes), ['jenny_team_profile', 'jenny_team_data', 'jenny_team_secrets']);
});

test('3-11: the team config example loads, with a secret-file key, no pool and no model endpoint', () => {
  const { loadHostConfig } = require('../../server/config');
  const config = loadHostConfig(path.join(ROOT, 'config', 'team-host.example.json'));
  assert.equal(config.team.keySource, 'secret_file');
  assert.equal(config.team.pool, undefined);
  assert.equal(config.modelEndpoint, null);
  assert.equal(config.listenHost, '127.0.0.1');
  assert.equal(config.team.directPort, 41700);
  assert.equal(config.workspaceRoot, null);
  assert.equal(path.basename(config.team.projectsRoot), 'projects');
  assert.equal(config.team.importDir, path.resolve('/mnt/jenny-import'));
  assert.equal(config.team.exchangeDir, path.resolve('/mnt/jenny-exchange'));
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'team-host.example.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(raw), /api_key|token|password|"model_endpoint"|"pool"/);
});
