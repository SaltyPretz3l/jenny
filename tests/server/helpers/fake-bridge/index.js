'use strict';

// A stand-in for the `jenny-team-bridge` binary, for the suites that must run
// without it. `createFakeBridgeSpawner(fake)` returns a `spawnChild(mode)` that
// hands back a child-process-shaped object speaking the real control channel
// while the network part runs on the in-memory fake transport.
//
// Test hooks (read live from `options`, so a test may change them between spawns):
//   silent            never answers `start`
//   startFails        answers `start` with `error <reason>` and exits (bind_failed exits 3, else 2)
//   crashAfterReady   host exits 1 right after `ready`
//   garbageAfterReady host writes a non-JSON line right after `ready`
//   ignoreStop        `stop` is read and ignored (the parent has to kill the child)
//   childAdmitTimeout false: the child never gives up on an admit question itself
//   spawnThrows       spawnChild throws this error
// Every spawn is recorded in `spawner.spawns` and every child in `spawner.children`;
// `child.received` holds the parsed lines the parent wrote.

const { FakeChildProcess } = require('./fake-child');
const { createFakeHost } = require('./host-logic');
const { createFakeMember } = require('./member-logic');
const { base64url, parseHostStart, parseMemberStart } = require('./util');

function wire(child, mode, fake, options) {
  let controller = null;
  let started = false;
  let ending = false;

  const failStart = (reason, code) => {
    child.write({ t: 'error', reason });
    child.exit(code);
  };

  async function finish(announce) {
    if (ending) return;
    ending = true;
    if (controller) await controller.shutdown();
    if (announce) child.write({ t: 'stopped' });
    child.exit(0);
  }

  function beginHost(message) {
    const config = parseHostStart(message);
    if (!config) {
      failStart('start_invalid', 2);
      return;
    }
    controller = createFakeHost({ fake, child, config, options });
    controller.listen().then(({ publicKey, addresses }) => {
      child.write({ t: 'log', event: 'team.bridge.started', fields: {} });
      child.write({ t: 'ready', public_key: base64url(publicKey), addresses });
      if (options.garbageAfterReady) child.writeRaw('this is not json\n');
      if (options.crashAfterReady) child.crash();
    }, () => failStart('bind_failed', 3));
  }

  function beginMember(message) {
    const config = parseMemberStart(message);
    if (!config) {
      failStart('start_invalid', 2);
      return;
    }
    controller = createFakeMember({ fake, child, config });
    controller.run().catch(() => failStart('protocol_invalid', 2));
  }

  function begin(message) {
    if (options.silent) return;
    if (options.startFails) {
      failStart(options.startFails, options.startFails === 'bind_failed' ? 3 : 2);
      return;
    }
    if (mode === 'host') beginHost(message);
    else beginMember(message);
  }

  child.bind({
    onMessage(message) {
      if (!started) {
        if (message.t !== 'start') {
          failStart('protocol_invalid', 2);
          return;
        }
        started = true;
        child.startLine = message;
        begin(message);
        return;
      }
      if (message.t === 'stop') {
        if (!options.ignoreStop) finish(true);
        return;
      }
      if (controller) controller.onMessage(message);
    },
    onStdinEnd() {
      finish(false);
    },
    onTerminate() {
      if (controller) controller.abort();
    },
  });
}

function createFakeBridgeSpawner(fake, options = {}) {
  const spawns = [];
  const children = [];

  function spawnChild(mode, ...args) {
    spawns.push({ mode, args });
    if (options.spawnThrows) throw options.spawnThrows;
    const child = new FakeChildProcess();
    child.mode = mode;
    child.startLine = null;
    children.push(child);
    wire(child, mode, fake, options);
    return child;
  }

  spawnChild.spawns = spawns;
  spawnChild.children = children;
  spawnChild.options = options;
  spawnChild.last = () => children[children.length - 1];
  return spawnChild;
}

module.exports = { createFakeBridgeSpawner };
