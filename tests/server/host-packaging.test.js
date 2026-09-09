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
