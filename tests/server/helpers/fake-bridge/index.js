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
//   noBulk            stands in for a binary from before bulk streams (slice 6-6): a member child has one port,
//                     names no `bulk_port` and sends no class byte; a host child says no `bulk` in `ready` and passes
//                     every stream byte to loopback unread
//   firstByteMs       the host child's window for a stream's first request byte (the binary's 3 s by default)
//   refusedCooldownMs the host child's refused-key cooldown instead of the start line's `refused_cooldown_ms` (the
//                     binary's 60 s by default), read at each refusal
//   oldHost           the host child closes a cooling key and a timed-out admit with the refused code, as a host
//                     bridge from before review round two did (its member then says `host_refused` for both)
// `spawner.bulk` counts what the children saw: `sockets` (member sockets carried from the bulk port) and `streams`
// (host streams that began with the class byte).
// Every spawn is recorded in `spawner.spawns` and every child in `spawner.children`;
// `child.received` holds the parsed lines the parent wrote.

const { FakeChildProcess } = require('./fake-child');
const { createFakeHost } = require('./host-logic');
const { createFakeMember } = require('./member-logic');
const { base64url, parseHostStart, parseMemberStart } = require('./util');

function wire(child, mode, fake, options) {
  // Counted on the spawner, where a test reads them.
  options = Object.create(options, { bulkSeen: { value: child.bulkSeen } });
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
      child.write({ t: 'ready', public_key: base64url(publicKey), addresses, ...(options.noBulk ? {} : { bulk: 1 }) });
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
    controller = createFakeMember({ fake, child, config, options });
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
  const bulk = { sockets: 0, streams: 0 };

  function spawnChild(mode, ...args) {
    spawns.push({ mode, args });
    if (options.spawnThrows) throw options.spawnThrows;
    const child = new FakeChildProcess();
    child.mode = mode;
    child.startLine = null;
    child.bulkSeen = bulk;
    children.push(child);
    wire(child, mode, fake, options);
    return child;
  }

  spawnChild.spawns = spawns;
  spawnChild.children = children;
  spawnChild.options = options;
  spawnChild.bulk = bulk;
  spawnChild.last = () => children[children.length - 1];
  return spawnChild;
}

module.exports = { createFakeBridgeSpawner };
