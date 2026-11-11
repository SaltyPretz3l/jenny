'use strict';

// A test-only entry for the team host child process (slice 1f-2 integration
// test). It is services/team/host/host-entry.js with one difference: the bridge
// binary is started with `loopback_only`, so no socket listens on a real
// interface and no firewall prompt can appear during a test run. The parent
// channel is the real one over `process.send`; everything else is the real
// team host. The binary path arrives in JENNY_TEST_TEAM_BRIDGE (a path, never a
// secret).

const { TEAM_START_FLAGS, startHostedServer } = require('../../server/main');
const { log } = require('../../server/host-core');
const { createParentChannel } = require('../../server/team/parent-channel');
const { spawnBridgeChild } = require('../../server/team/transport/control-channel');
const { forceLoopbackOnly } = require('../server/helpers/team-bridge-binary');

let parent = null;

async function run() {
  const at = process.argv.indexOf('--config');
  const args = at < 0 ? [] : process.argv.slice(at);
  const binaryPath = process.env.JENNY_TEST_TEAM_BRIDGE;
  const host = await startHostedServer(args[1], {
    ...(Object.hasOwn(TEAM_START_FLAGS, args[2] ?? '') ? { [TEAM_START_FLAGS[args[2]]]: true } : {}),
    createParent: () => { parent = createParentChannel(process); return parent; },
    spawnBridge: (mode) => forceLoopbackOnly(spawnBridgeChild(mode, { binaryPath })),
  });
  host.stopped.then(() => parent?.close(), () => { process.exitCode = 1; parent?.close(); });
}

run().catch(() => { log('ERROR', 'host.start_failed'); process.exitCode = 1; parent?.close(); });
