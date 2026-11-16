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
// The bridge crate's own shape: iroh without its default features (they include its port mapper).
const BRIDGE_MANIFEST = '[package]\nname = "jenny-team-bridge"\nversion = "0.1.0"\n\n[dependencies]\n'
  + 'iroh = { version = "=1.4.1", default-features = false, features = ["tls-ring"] }\n'
  + 'portmapper = { version = "=0.19.3", default-features = false }\n';
const PORTMAP_RS = 'native/jenny-team-bridge/src/portmap.rs';

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
  withTree({ [BRIDGE_CARGO]: BRIDGE_MANIFEST, [PORTMAP_RS]: 'use portmapper::Client;\n' }, (result) => {
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /^PASS/m);
  });
});

test("iroh's own port mapper stays off in the bridge crate", () => {
  const manifests = [
    IROH_MANIFEST,
    BRIDGE_MANIFEST.replace('default-features = false, features = ["tls-ring"]', 'features = ["tls-ring"]'),
    BRIDGE_MANIFEST.replace('features = ["tls-ring"]', 'features = ["tls-ring", "portmapper"]'),
    BRIDGE_MANIFEST.replace('features = ["tls-ring"]', 'features = ["default"]'),
  ];
  for (const manifest of manifests) {
    withTree({ [BRIDGE_CARGO]: manifest }, (result) => {
      assert.notEqual(result.status, 0, manifest);
      assert.match(result.out, /Cargo\.toml: iroh's portmapper feature must stay off/, manifest);
    });
  }
});

test('portmapper is named only in portmap.rs and the bridge manifest', () => {
  withTree({
    [BRIDGE_CARGO]: BRIDGE_MANIFEST,
    [PORTMAP_RS]: 'use portmapper::Client;\n',
    'native/jenny-team-bridge/src/host.rs': 'fn a() {}\nlet c = portmapper::Client::default();\n',
    'native/jenny-team-bridge/tests/t.rs': '// portmapper\n',
    'native/jenny-team-bridge/target/debug/build/x.rs': 'portmapper\n',
    'native/other/Cargo.toml': '[dependencies]\nportmapper = "0.19"\n',
  }, (result) => {
    assert.notEqual(result.status, 0, result.out);
    assert.match(result.out, /src[\\/]host\.rs:2: .*portmapper named outside src\/portmap\.rs/);
    assert.match(result.out, /tests[\\/]t\.rs:1: /);
    assert.match(result.out, /native[\\/]other[\\/]Cargo\.toml: portmapper dependency outside/);
    assert.doesNotMatch(result.out, /portmap\.rs:1/);
    assert.doesNotMatch(result.out, /target/);
  });
});

test('a renamed portmapper in the bridge manifest and a re-export from portmap.rs fail', () => {
  const renamed = BRIDGE_MANIFEST.replace('portmapper = {', 'pm = { package = "portmapper",');
  withTree({
    [BRIDGE_CARGO]: renamed,
    [PORTMAP_RS]: 'use portmapper::Client;\npub use portmapper::Config;\n',
    'native/jenny-team-bridge/src/host.rs': 'use pm::Client;\n',
  }, (result) => {
    assert.notEqual(result.status, 0, result.out);
    assert.match(result.out, /jenny-team-bridge[\\/]Cargo\.toml: portmapper renamed/);
    assert.match(result.out, /portmap\.rs:2: .*portmapper re-exported/);
    assert.doesNotMatch(result.out, /portmap\.rs:1/);
  });
  withTree({ [BRIDGE_CARGO]: BRIDGE_MANIFEST, [PORTMAP_RS]: 'pub use portmapper;\n' }, (result) => {
    assert.notEqual(result.status, 0, result.out);
    assert.match(result.out, /portmap\.rs:1: .*portmapper re-exported/);
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

// The owner's relay (TEAM_INTERNET_SPEC slice 5-4): one custom relay, nothing iroh would add.
test('the bridge crate source names no default relay, preset, environment proxy or address lookup', () => {
  const forbidden = [
    'let b = Endpoint::builder(presets::N0);',
    'use iroh::endpoint::presets::N0;',
    '.relay_mode(RelayMode::Default)',
    '.relay_mode(RelayMode::Staging)',
    '.proxy_from_env()',
    '.address_lookup(x)',
    'const RELAY: &str = "https://use1-1.relay.iroh.link";',
  ];
  withTree({
    'native/jenny-team-bridge/src/relay.rs': `${forbidden.join('\n')}\n`,
    'native/jenny-team-bridge/src/fine.rs': '// an address lookup, in words, is fine\nRelayMode::Custom(map)\n',
    'native/jenny-team-bridge/tests/probe.rs': `${forbidden.join('\n')}\n`,
  }, (result) => {
    assert.notEqual(result.status, 0, result.out);
    forbidden.forEach((_, index) => {
      assert.match(result.out, new RegExp(`src[\\\\/]relay\\.rs:${index + 1}: .*\\[relay or lookup iroh would add\\]`), String(index));
    });
    assert.doesNotMatch(result.out, /fine\.rs/);
    assert.doesNotMatch(result.out, /probe\.rs/, 'the crate tests may use them');
  });
});

test("iroh's test-utils feature is allowed under [dev-dependencies] only", () => {
  const dev = '\n[dev-dependencies]\niroh = { version = "=1.4.1", default-features = false, features = ["tls-ring", "test-utils"] }\n';
  withTree({ [BRIDGE_CARGO]: `${BRIDGE_MANIFEST}${dev}` }, (result) => {
    assert.equal(result.status, 0, result.out);
  });
  const shipped = [
    BRIDGE_MANIFEST.replace('features = ["tls-ring"]', 'features = ["tls-ring", "test-utils"]'),
    `${BRIDGE_MANIFEST}\n[target.'cfg(unix)'.dependencies]\niroh = { version = "=1.4.1", default-features = false, features = ["test_utils"] }\n`,
    `${BRIDGE_MANIFEST}\n[build-dependencies]\niroh = { version = "=1.4.1", default-features = false, features = ["test-utils"] }\n`,
    `${BRIDGE_MANIFEST}${dev}\n[features]\ntrust = ["iroh/test-utils"]\n`,
  ];
  for (const manifest of shipped) {
    withTree({ [BRIDGE_CARGO]: manifest }, (result) => {
      assert.notEqual(result.status, 0, manifest);
      assert.match(result.out, /iroh's test-utils feature outside \[dev-dependencies\]/, manifest);
    });
  }
});

test('the test-only relay trust cannot be turned on by the shipped binary', () => {
  const cases = {
    'native/jenny-team-bridge/src/main.rs': 'let options = RunOptions { relay_tls: Some(tls), ..Default::default() };\n',
    'native/jenny-team-bridge/src/lib.rs': 'let tls = CaTlsConfig::insecure_skip_verify();\n',
    'scripts/packaging/build_team_bridge.py': 'command = [cargo, "build", "--release", "--features", "x"]\n',
  };
  for (const [rel, text] of Object.entries(cases)) {
    withTree({ [rel]: text }, (result) => {
      assert.notEqual(result.status, 0, rel);
      assert.match(result.out, /\[test-only relay trust reachable\]/, rel);
    });
  }
  for (const text of ['x = ["--all-features"]\n', 'x = ["-F", "y"]\n', '# test-utils\n']) {
    withTree({ 'scripts/packaging/build_team_bridge.py': text }, (result) => {
      assert.notEqual(result.status, 0, text);
      assert.match(result.out, /build_team_bridge\.py:1: .*\[test-only relay trust reachable\]/, text);
    });
  }
  withTree({
    'native/jenny-team-bridge/src/main.rs': 'jenny_team_bridge::run_host(input, tx).await\n',
    'native/jenny-team-bridge/src/host.rs': 'relay_tls: options.relay_tls.as_ref(),\n',
    'native/jenny-team-bridge/tests/common/relay.rs': 'relay_tls: Some(CaTlsConfig::insecure_skip_verify()),\n',
    'scripts/packaging/build_team_bridge.py': 'command = [cargo, "build", "--release", "--locked"]\n',
  }, (result) => {
    assert.equal(result.status, 0, result.out);
  });
});

test('iroh-relay is a [dev-dependencies] crate of the bridge and is named only in its tests', () => {
  const dev = '\n[dev-dependencies]\niroh-relay = { version = "=1.4.1", default-features = false, features = ["server"] }\n';
  withTree({
    [BRIDGE_CARGO]: `${BRIDGE_MANIFEST}${dev}`,
    'native/jenny-team-bridge/tests/common/relay.rs': 'use iroh_relay::server::AccessControl;\n',
  }, (result) => {
    assert.equal(result.status, 0, result.out);
  });
  const relayDep = 'iroh-relay = { version = "=1.4.1", default-features = false, features = ["server"] }\n';
  for (const manifest of [
    BRIDGE_MANIFEST + relayDep,
    `${BRIDGE_MANIFEST}\n[target.'cfg(unix)'.dependencies]\n${relayDep}`,
    `${BRIDGE_MANIFEST}\n[dependencies.relay]\npackage = "iroh_relay"\nversion = "=1.4.1"\n`,
  ]) {
    withTree({ [BRIDGE_CARGO]: manifest }, (result) => {
      assert.notEqual(result.status, 0, manifest);
      assert.match(result.out, /iroh-relay outside \[dev-dependencies\]/, manifest);
    });
  }
  withTree({ 'native/jenny-team-bridge/src/host.rs': 'use iroh_relay::server::Server;\n' }, (result) => {
    assert.notEqual(result.status, 0, result.out);
    assert.match(result.out, /src[\\/]host\.rs:1: .*\[iroh_relay named in src\/\]/);
  });
});

test("no preset but Minimal, no default relay map and no workspace-inherited iroh crate in the bridge", () => {
  const spellings = [
    'let b = Endpoint::builder(presets::N0DisableRelay);',
    'use iroh::endpoint::presets::{Minimal, N0};',
    '.relay_mode(RelayMode::Custom(iroh::defaults::prod::default_relay_map()))',
    'let map = default_relay_map();',
    'use iroh::defaults;',
    'let m = defaults::prod::default_relay_map;',
    'let m = defaults::staging::default_relay_map;',
  ];
  withTree({ 'native/jenny-team-bridge/src/relay.rs': `${spellings.join('\n')}\n` }, (result) => {
    assert.notEqual(result.status, 0, result.out);
    spellings.forEach((_, index) => {
      assert.match(result.out, new RegExp(`src[\\\\/]relay\\.rs:${index + 1}: .*\\[relay or lookup iroh would add\\]`), String(index));
    });
  });
  withTree({
    'native/jenny-team-bridge/src/host.rs': 'let b = Endpoint::builder(presets::Minimal);\nuse iroh::endpoint::{presets, BindOpts};\n',
  }, (result) => {
    assert.equal(result.status, 0, result.out);
  });
  for (const extra of [
    '\n[dev-dependencies]\niroh = { workspace = true }\n',
    '\n[dev-dependencies]\niroh-relay = { workspace = true, features = ["server"] }\n',
    '\n[dependencies.relay]\npackage = "iroh-relay"\nworkspace = true\n',
  ]) {
    withTree({ [BRIDGE_CARGO]: `${BRIDGE_MANIFEST}${extra}` }, (result) => {
      assert.notEqual(result.status, 0, extra);
      assert.match(result.out, /iroh crate inherited from a workspace/, extra);
    });
  }
});

test('sidecar/ai and sidecar/protocol.py gain no team knowledge: imports, identifiers and string literals', () => {
  withTree({
    'sidecar/ai/engines/x.py': 'def pick(model):\n    if model == "team-pool":\n        return 1\n',
    'sidecar/ai/routing/y.py': 'from server.team import thing\nimport services.team.host\n',
    'sidecar/ai/tools/z.py': "def run(teamName, node_id, ctx):\n    return ctx['owner_member_id']\n",
    'sidecar/protocol.py': 'TEAM_METHOD = 1\nPATH = "server/team/x.js"\n',
  }, (result) => {
    assert.notEqual(result.status, 0, result.out);
    assert.match(result.out, /sidecar[\\/]ai[\\/]engines[\\/]x\.py:2: .*\[team vocabulary in sidecar\]/u);
    assert.match(result.out, /sidecar[\\/]ai[\\/]routing[\\/]y\.py:1: .*\[team import in sidecar\]/u);
    assert.match(result.out, /sidecar[\\/]ai[\\/]routing[\\/]y\.py:2: .*\[team import in sidecar\]/u);
    assert.match(result.out, /sidecar[\\/]ai[\\/]tools[\\/]z\.py:1: /u);
    assert.match(result.out, /sidecar[\\/]ai[\\/]tools[\\/]z\.py:2: /u);
    assert.match(result.out, /sidecar[\\/]protocol\.py:1: /u);
    assert.match(result.out, /sidecar[\\/]protocol\.py:2: /u);
  });
});

test('comments, docstrings, lease and pool, and the rest of the sidecar pass the team vocabulary rule', () => {
  withTree({
    'sidecar/ai/engines/fine.py': '"""Talks to a team of servers."""\n# the team pool\n'
      + 'def lease(pool, node_identity, steam):\n    """A team docstring."""\n    return pool, "steamy", "esteem"\n',
    'sidecar/other.py': 'TEAM = "team"\n',
  }, (result) => {
    assert.equal(result.status, 0, result.out);
  });
});
