'use strict';

const path = require('node:path');
const { loadHostConfig } = require('./config');
const { assertImportComplete } = require('../services/host/maintenance-commands');
const { ExecutionBroker } = require('../services/host/execution-broker');
const { AuthService } = require('./auth-service');
const { ClientRegistry } = require('./client-registry');
const { ControlLeases } = require('./control-leases');
const { createHttpServer } = require('./http-server');
const { log, acquireConfiguredProfile, createHostCore } = require('./host-core');
const { createParentChannel } = require('./team/parent-channel');

// The owner-invite start flags of a team host: at most one, after `--config <path>`.
const TEAM_START_FLAGS = Object.freeze({ '--team-init': 'teamInit', '--team-recover': 'teamRecover' });

// `options.parent` (or `options.createParent`, called only for a team host),
// `options.teamInit` and `options.teamRecover` belong to a team host; the rest
// are test seams the team host reads (`createBackend`, `acquireProfileImpl`, ...).
async function startHostedServer(configPath, options = {}) {
  if (options.teamInit && options.teamRecover) throw new Error('invalid_arguments');
  const team = loadHostConfig(configPath).team;
  if (team) {
    // Required lazily so a single-owner host never loads a team module.
    const parent = options.parent ?? options.createParent?.() ?? null;
    return require('./team/team-main').startTeamHost(configPath, parent, options);
  }
  if (options.teamInit || options.teamRecover) throw new Error('invalid_arguments');
  const { config, lock } = await acquireConfiguredProfile(configPath);
  let core;
  let executionBroker;
  let transport;
  let stopPromise;
  let ready = false;
  let coreHandle;
  const stop = () => {
    stopPromise ||= (async () => {
      ready = false;
      const failures = [];
      try { await transport?.close(); } catch (error) { failures.push(error); }
      // Keep the exclusive profile lock on an uncertain child exit. The
      // process/container shutdown watchdog is the final teardown boundary.
      if (coreHandle) {
        try { await coreHandle.dispose(); } finally { if (coreHandle.canReleaseLock()) lock.release(); }
      } else {
        await executionBroker?.close();
        lock.release();
      }
      if (failures.length) throw new AggregateError(failures, 'host_transport_stop_failed');
    })();
    return stopPromise;
  };
  try {
    assertImportComplete(config.userDataPath);
    const clients = new ClientRegistry();
    const leases = new ControlLeases();
    const auth = new AuthService({ filePath: path.join(config.userDataPath, 'auth.json'), logger: log,
      onInvalidate: (deviceId) => {
        clients.revokeDevice(deviceId);
        leases.revokeDevice(deviceId);
        core?.events.revokeDevice(deviceId);
      } });
    if (!auth.isConfigured()) throw new Error('owner_initialization_required');
    if (config.execution) {
      executionBroker = new ExecutionBroker({ userDataPath: config.userDataPath, logger: log });
      await executionBroker.prepare();
    }
    try {
      core = createHostCore({ config, clients, leases, executionBroker });
    } catch (error) { coreHandle = error.hostCore; throw error; }
    coreHandle = core;
    transport = createHttpServer({ canonicalOrigin: config.canonicalOrigin,
      browserAccessMode: config.browserAccessMode,
      executionStatus: () => executionBroker?.status().available === true,
      staticRoot: path.resolve(__dirname, '..', 'build', 'browser'),
      auth, clients, events: core.events, router: core.router, bootEpoch: core.bootEpoch,
      resourceLimits: config.resourceLimits,
      isReady: () => ready && core.isBackendReady(),
      assetRoutes: core.assetRoutes,
      logger: log });
    await core.startBackend();
    ready = true;
    await new Promise((resolve, reject) => {
      transport.server.once('error', reject);
      transport.server.listen(config.port, config.listenHost, () => {
        transport.server.off('error', reject); resolve();
      });
    });
    log('INFO', 'host.listening', { boot_epoch: core.bootEpoch, ready: core.isBackendReady() });
    return { stop };
  } catch (error) {
    try { await stop(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'host_start_cleanup_failed', { cause: cleanupError });
    }
    throw error;
  }
}

async function main(argv = process.argv.slice(2), { processLike = process } = {}) {
  if (!(argv.length === 2 || (argv.length === 3 && Object.hasOwn(TEAM_START_FLAGS, argv[2])))
    || argv[0] !== '--config' || !path.isAbsolute(argv[1])) throw new Error('invalid_arguments');
  const flag = argv.length === 3 ? { [TEAM_START_FLAGS[argv[2]]]: true } : {};
  let parent = null;
  const createParent = () => { parent = createParentChannel(processLike); return parent; };
  let host;
  try { host = await startHostedServer(argv[1], { createParent, ...flag }); }
  catch (error) { parent?.close(); throw error; }
  const armWatchdog = () => {
    const watchdog = setTimeout(() => { process.exitCode = 1; process.exit(1); }, 20_000);
    watchdog.unref();
    return watchdog;
  };
  // A team host can stop on its own (lost lock, the parent's stop message);
  // the parent channel keeps a Node process alive until it is closed. A stop
  // that failed may have left a child running: exit non-zero, by the watchdog if need be.
  host.stopped?.then(() => parent?.close(), () => {
    log('ERROR', 'host.stop_failed');
    process.exitCode = 1;
    armWatchdog();
    parent?.close();
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const watchdog = armWatchdog();
    host.stop().then(() => { clearTimeout(watchdog); log('INFO', 'host.stopped'); })
      .catch(() => { log('ERROR', 'host.stop_failed'); process.exitCode = 1; })
      .finally(() => parent?.close());
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return host;
}

if (require.main === module) {
  main().catch(() => { log('ERROR', 'host.start_failed'); process.exitCode = 1; });
}

module.exports = { TEAM_START_FLAGS, startHostedServer, main, acquireConfiguredProfile };
