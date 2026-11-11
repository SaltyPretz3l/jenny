'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const BRIDGE_CARGO = 'native/jenny-team-bridge/Cargo.toml';
const IROH_MANIFEST = '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\niroh = "=1.4.1"\n';

function runCheck(rootDir) {
  const args = ['scripts/checks/check_team_transport_boundary.py'];
  if (rootDir) args.push('--root', rootDir);
  const result = spawnSync('python', args, { cwd: ROOT, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function withTree(files, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-boundary-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
    }
    return body(runCheck(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the boundary check passes on the real tree', () => {
  const result = runCheck();
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /^PASS/m);
});

test('a Cargo.toml outside the bridge crate that names iroh fails', () => {
  withTree({ 'native/other/Cargo.toml': IROH_MANIFEST }, (result) => {
    assert.notEqual(result.status, 0, result.out);
    assert.match(result.out, /native[\\/]other[\\/]Cargo\.toml: iroh dependency outside native\/jenny-team-bridge/);
  });
});

test('every dependency table and a renamed iroh crate are caught outside the bridge crate', () => {
  const tables = {
    'a/Cargo.toml': '[dev-dependencies]\niroh-base = "1"\n',
    'b/Cargo.toml': '[build-dependencies]\niroh_relay = "1"\n',
    'c/Cargo.toml': '[target.\'cfg(unix)\'.dependencies]\niroh = "1"\n',
    'd/Cargo.toml': '[dependencies]\nsomething = { package = "iroh-quinn", version = "1" }\n',
    'e/Cargo.toml': '[dependencies]\nserde = "1"\nirohish = "1"\n',
  };
  withTree(tables, (result) => {
    assert.notEqual(result.status, 0, result.out);
    for (const dir of ['a', 'b', 'c', 'd']) {
      assert.match(result.out, new RegExp(`${dir}[\\\\/]Cargo\\.toml: iroh dependency outside`), dir);
    }
    assert.doesNotMatch(result.out, /e[\\/]Cargo\.toml/);
  });
});

test('iroh inside the bridge crate is allowed', () => {
  withTree({ [BRIDGE_CARGO]: IROH_MANIFEST }, (result) => {
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /^PASS/m);
  });
});

test('a target directory, node_modules and dot directories are not searched for manifests', () => {
  withTree({
    'native/jenny-team-bridge/target/release/build/x/Cargo.toml': IROH_MANIFEST,
    'native/other/target/Cargo.toml': IROH_MANIFEST,
    'node_modules/pkg/Cargo.toml': IROH_MANIFEST,
    '.claude/worktrees/w/native/x/Cargo.toml': IROH_MANIFEST,
    'tests/fixtures/Cargo.toml': IROH_MANIFEST,
  }, (result) => {
    assert.equal(result.status, 0, result.out);
  });
});

test('a manifest that cannot be parsed is reported, not skipped', () => {
  withTree({ 'native/broken/Cargo.toml': '[dependencies\niroh = ' }, (result) => {
    assert.notEqual(result.status, 0, result.out);
    assert.match(result.out, /native[\\/]broken[\\/]Cargo\.toml: cannot parse/);
  });
});

test('naming the Node binding is reported with file and line, inside the transport directories too', () => {
  withTree({
    'server/team/transport/adapter.js': "'use strict';\nconst iroh = require('@number0/iroh');\n",
    'server/other.js': "'use strict';\n\nconst bad = require('@number0/iroh');\n",
    'services/late.mjs': "import { Endpoint } from '@number0/iroh';\n",
    'services/dyn.ts': 'const m = await import("@number0/iroh");\n',
    'services/comment.cjs': "'use strict';\n// the binding @number0/iroh is gone\n",
    'scripts/build/bundle.js': "'use strict';\nconst x = require(\n  '@number0/iroh'\n);\n",
    'scripts/tests/helper.js': "require('@number0/iroh');\n",
    'server/clean.js': "'use strict';\nconst fine = require('node:fs');\n",
    // Never searched: the top-level test tree and build output, dependencies, dot directories.
    'tests/ignored.js': "require('@number0/iroh');\n",
    'build/output.js': "require('@number0/iroh');\n",
    'node_modules/x/index.js': "require('@number0/iroh');\n",
    '.claude/worktrees/w/server/stray.js': "require('@number0/iroh');\n",
  }, (result) => {
    assert.notEqual(result.status, 0, result.out);
    assert.match(result.out, /server[\\/]team[\\/]transport[\\/]adapter\.js:2/);
    assert.match(result.out, /server[\\/]other\.js:3/);
    assert.match(result.out, /services[\\/]late\.mjs:1/);
    assert.match(result.out, /services[\\/]dyn\.ts:1/);
    assert.match(result.out, /services[\\/]comment\.cjs:2/);
    assert.match(result.out, /scripts[\\/]build[\\/]bundle\.js:3/);
    assert.match(result.out, /scripts[\\/]tests[\\/]helper\.js:1/);
    assert.doesNotMatch(result.out, /output\.js/);
    assert.doesNotMatch(result.out, /ignored\.js/);
    assert.doesNotMatch(result.out, /node_modules/);
    assert.doesNotMatch(result.out, /\.claude/);
    assert.doesNotMatch(result.out, /clean\.js/);
  });
});

test('the bridge binary is named only inside the two transport directories', () => {
  withTree({
    'server/team/transport/supervisor.js': "'use strict';\nconst name = 'jenny-team-bridge';\n",
    'services/team/transport/member.js': "'use strict';\nconst name = 'jenny-team-bridge.exe';\n",
    'services/other.js': "'use strict';\n\nconst spawnIt = 'jenny-team-bridge';\n",
    'server/team/lookup.mjs': "export const BIN = `${dir}/jenny-team-bridge`;\n",
  }, (result) => {
    assert.notEqual(result.status, 0, result.out);
    assert.match(result.out, /services[\\/]other\.js:3/);
    assert.match(result.out, /server[\\/]team[\\/]lookup\.mjs:1/);
    assert.doesNotMatch(result.out, /supervisor\.js/);
    assert.doesNotMatch(result.out, /member\.js/);
  });
});

test('the bridge binary name inside the transport directories passes', () => {
  withTree({
    'server/team/transport/x.js': "'use strict';\nmodule.exports = 'jenny-team-bridge';\n",
  }, (result) => {
    assert.equal(result.status, 0, result.out);
  });
});

test('the transport directories may not import from sidecar', () => {
  withTree({
    'server/team/transport/leak.js': "'use strict';\nconst s = require('../../../sidecar/ai/thing');\n",
    'services/team/transport/dyn.mjs': "const s = await import('../../../sidecar/x.js');\n",
    'services/team/transport/fine.js': "'use strict';\nconst p = require('node:path');\nconst q = require('./sibling');\n",
    'server/elsewhere.js': "'use strict';\nconst s = require('../sidecar/thing');\n",
  }, (result) => {
    assert.notEqual(result.status, 0, result.out);
    assert.match(result.out, /server[\\/]team[\\/]transport[\\/]leak\.js:2/);
    assert.match(result.out, /services[\\/]team[\\/]transport[\\/]dyn\.mjs:1/);
    assert.doesNotMatch(result.out, /fine\.js/);
    assert.doesNotMatch(result.out, /elsewhere\.js/);
  });
});
