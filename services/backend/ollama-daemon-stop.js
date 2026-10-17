'use strict';

const { identifyOllamaDaemon } = require('./ollama-daemon-identity');
const { readDaemonProcess, isServiceCgroup } = require('./ollama-daemon-proc');
const { readLinuxListeners, withDeadline } = require('./ollama-daemon-port');

async function stopUserOllamaProcess({
  expectedPid, expectedStartTime, expectedProgram, platform = process.platform, getOwnedPid = () => 0,
  identifyImpl = identifyOllamaDaemon, readProcessImpl = readDaemonProcess,
  readListenersImpl = readLinuxListeners, killImpl = process.kill.bind(process),
  delayImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowImpl = Date.now,
} = {}) {
  const denied = { stopped: false, reason: 'identity_unconfirmed' };
  if (typeof expectedProgram !== 'string' || !expectedProgram || expectedProgram.length > 256
    || platform !== 'linux' || !Number.isSafeInteger(expectedPid) || expectedPid <= 0
    || typeof expectedStartTime !== 'string' || !/^\d{1,24}$/.test(expectedStartTime)) return denied;
  const daemon = await identifyImpl({ platform, getOwnedPid });
  if (!daemon || daemon.kind !== 'process' || !daemon.sameUser || daemon.confidence !== 'confirmed'
    || daemon.program !== expectedProgram || daemon.pid !== expectedPid || daemon.startTime !== expectedStartTime) return denied;
  const verified = await withDeadline(async () => {
    const listeners = await readListenersImpl();
    const proc = await readProcessImpl(expectedPid, { inodes: listeners.inodes || [] });
    return listeners.state === 'occupied' && listeners.inodes.length > 0
      && proc && proc.ollama && proc.sameUser && typeof proc.cgroup === 'string'
      && !isServiceCgroup(proc.cgroup)
      && listeners.inodes.every((inode) => proc.matched.includes(inode))
      && proc.program === expectedProgram && proc.startTime === expectedStartTime && expectedPid !== Number(await getOwnedPid());
  }, 1500, false);
  if (!verified) return denied;
  try { killImpl(expectedPid, 'SIGTERM'); } catch (_error) { return { stopped: false, reason: 'stop_failed' }; }
  const end = nowImpl() + 3000;
  while (nowImpl() < end) {
    try { killImpl(expectedPid, 0); } catch (error) {
      if (error?.code === 'ESRCH') return { stopped: true, pid: expectedPid };
      return { stopped: false, pid: expectedPid, reason: 'exit_unconfirmed' };
    }
    await delayImpl(100);
  }
  return { stopped: false, pid: expectedPid, reason: 'exit_unconfirmed' };
}

module.exports = { stopUserOllamaProcess };
