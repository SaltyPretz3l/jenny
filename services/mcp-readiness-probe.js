'use strict';

const path = require('node:path');
const { execFile: nodeExecFile } = require('node:child_process');
const { killProcessTree } = require('./backend/process-utils');
const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');

function readinessProbeArgs(server) {
  if (server?.name !== 'rea' || server.transport !== 'stdio'
    || !String(server.command || '').trim() || !Array.isArray(server.args)
    || server.args.at(-1) !== 'mcp') return null;
  return [...server.args.slice(0, -1), 'mcp', 'doctor', '--json'];
}

// Node refuses to spawn a .cmd/.bat shim without a shell (EINVAL since 20.12). The Route A
// preset's npx.cmd is the one shim the probe knows: it runs what the shim itself runs, the
// node.exe and npx-cli.js beside it, so no shell and no quoting are involved. Any other shim
// has no probe.
function readinessProbeLaunch(server, platform = process.platform) {
  const args = readinessProbeArgs(server);
  if (!args) return null;
  const command = String(server.command).trim();
  if (!/\.(cmd|bat)$/i.test(command)) return { file: command, args };
  if (platform !== 'win32' || path.win32.basename(command).toLowerCase() !== 'npx.cmd') return null;
  const dir = path.win32.dirname(command);
  return { file: path.win32.join(dir, 'node.exe'),
    args: [path.win32.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'), ...args] };
}

async function probeMcpReadiness({ server, execFile = nodeExecFile, timeoutMs = 30000,
  now = () => new Date(), platform = process.platform, killProcessTreeImpl = killProcessTree } = {}) {
  const result = { healthy: false, tools: 0, prompts: 0, checkedAt: now().toISOString(), reason: '' };
  const launch = readinessProbeLaunch(server, platform);
  if (!launch) return { ...result, reason: 'probe_unavailable' };
  const { error, stdout } = await new Promise((resolve) => {
    let child = null;
    try {
      child = execFile(launch.file, launch.args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024,
        env: { ...sanitizeSpawnEnv(process.env, { extraDeny: [/^JENNY_/i] }), ...(server.env || {}) } },
      (error, stdout) => {
        // The timeout kills only the launcher; the doctor it started goes with it.
        if (error && (error.killed || error.signal) && child?.pid) {
          Promise.resolve().then(() => killProcessTreeImpl(child.pid)).catch(() => {});
        }
        resolve({ error, stdout });
      });
    } catch (error) { resolve({ error, stdout: '' }); }
  });
  result.checkedAt = now().toISOString();
  if (error) result.reason = error.killed || error.signal ? 'timed_out' : 'exit_nonzero';
  try {
    const output = JSON.parse(stdout);
    if (!output || typeof output !== 'object' || Array.isArray(output)
      || typeof output.healthy !== 'boolean') throw new Error('Invalid readiness output');
    result.healthy = !error && output.healthy;
    for (const key of ['tools', 'prompts']) {
      const count = output.inventory?.[key]?.observed;
      result[key] = Number.isInteger(count) && count >= 0 ? count : 0;
    }
  } catch (_error) { if (!error) result.reason = 'invalid_output'; }
  return result;
}

module.exports = { readinessProbeArgs, readinessProbeLaunch, probeMcpReadiness };
