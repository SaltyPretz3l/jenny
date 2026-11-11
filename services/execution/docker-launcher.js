'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { sandboxError } = require('./sandbox-errors');
const { findOnPath } = require('../backend/executable-on-path');
const OWNER = 'com.jenny.command.owner';
const VERSION = 'com.jenny.command.version';
const VERSION_VALUE = '1';
const MIRROR = 'com.jenny.command.mirror';
const MIRROR_ID = /^[a-f0-9]{16}$/u;
const OUTBOX_TARGET = '/run/jenny-sync/outbox';
const ID = /^[a-f0-9]{64}$/u;
const IMAGE = /^sha256:[a-f0-9]{64}$/u;
const RELAY = "import sys; sys.path.insert(0, '/app'); from server.worker.relay import main; main()";
// One container per run, removed once the successor incarnation reports: no readiness delay is
// needed to keep Docker's restart backoff down (the hosted long-lived worker keeps its 10 s).
const SUPERVISOR = "import sys; sys.path.insert(0, '/app'); from server.worker.supervisor import main; main(ready_delay=0.0)";
function environment(env) {
  const result = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles']) {
    if (typeof env[key] === 'string') result[key] = env[key];
  }
  return result;
}
function localEndpoint(value) {
  return typeof value === 'string' && (
    /^npipe:\/\/\/\/\.\/pipe\/[a-zA-Z0-9_.-]+$/u.test(value)
    || /^unix:\/\/\/[^\0\r\n]+$/u.test(value)
  );
}
function validBindSource(source, directory, platform) {
  if (typeof source !== 'string') return false;
  if (platform === 'win32') {
    const normalized = path.win32.resolve(directory).replaceAll('\\', '/');
    if (!/^[A-Za-z]:\//u.test(normalized)) return false;
    const vmPath = normalized[0].toLowerCase() + normalized.slice(2);
    return [normalized, '/run/desktop/mnt/host/' + vmPath, '/host_mnt/' + vmPath]
      .some(candidate => candidate.toLowerCase() === source.replaceAll('\\', '/').toLowerCase());
  }
  const normalized = platform === 'darwin' ? path.posix.resolve(directory) : path.resolve(directory);
  const candidates = platform === 'darwin' ? [normalized, '/host_mnt' + normalized, '/run/desktop/mnt/host' + normalized] : [normalized];
  return candidates.includes(source);
}
class DockerLauncher {
  constructor({ ownerId, spawnImpl = spawn, env = process.env, platform = process.platform } = {}) {
    if (!/^[a-f0-9]{32}$/u.test(ownerId)) throw sandboxError('owner_identity_invalid');
    this.ownerId = ownerId;
    this.spawn = spawnImpl;
    this.env = environment(env);
    this.platform = platform;
    const windowsDocker = path.join(env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe');
    // Windows spawn searches the cwd before PATH, so a bare name is resolved here; a miss is docker_missing.
    this.command = platform !== 'win32' ? 'docker'
      : fs.existsSync(windowsDocker) ? windowsDocker : findOnPath('docker', { env, platform });
    this.endpoint = null;
    this.volumeName = 'jenny-command-' + ownerId;
    this.pendingCommands = new Set();
  }
  hasPendingCommands() { return this.pendingCommands.size > 0; }
  async _run(args, { input = null, timeoutMs = 15000, maxBytes = 4 * 1024 * 1024, endpoint = true } = {}) {
    const prefix = endpoint ? ['--host', this.endpoint] : [];
    if (endpoint && !localEndpoint(this.endpoint)) throw sandboxError('docker_endpoint_invalid');
    if (!this.command) throw sandboxError('docker_missing');
    if (this.pendingCommands.size >= 32) throw sandboxError('docker_command_capacity');
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.command, [...prefix, ...args], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: this.env,
      });
      this.pendingCommands.add(child);
      const chunks = [];
      let bytes = 0;
      let stderrBytes = 0;
      let done = false;
      const timer = setTimeout(() => finish(sandboxError('docker_timeout')), timeoutMs);
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) child.kill();
        error ? reject(error) : resolve(value);
      };
      child.on('error', (error) => finish(sandboxError(error.code === 'ENOENT' ? 'docker_missing' : 'docker_unavailable')));
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) return finish(sandboxError('docker_output_limit'));
        chunks.push(chunk);
      });
      // Docker diagnostics may contain host paths or registry credentials; expose only bounded reasons.
      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > maxBytes) finish(sandboxError('docker_output_limit'));
      });
      child.stdin.on('error', () => { /* close/error supplies the outcome */ });
      child.on('close', (code) => {
        this.pendingCommands.delete(child);
        finish(code === 0 ? null : sandboxError('docker_operation_failed'), Buffer.concat(chunks));
      });
      child.stdin.end(input);
    });
  }
  async detect() {
    const context = JSON.parse((await this._run(['context', 'inspect'], { endpoint: false })).toString('utf8'));
    const endpoint = context?.[0]?.Endpoints?.docker?.Host;
    if (!localEndpoint(endpoint)) throw sandboxError('docker_local_daemon_required');
    if (this.endpoint && this.endpoint !== endpoint) throw sandboxError('docker_context_changed');
    this.endpoint = endpoint;
    const info = JSON.parse((await this._run(['info', '--format', '{{json .}}'])).toString('utf8'));
    if (info.OSType !== 'linux' || info.CgroupVersion !== '2') throw sandboxError('docker_linux_cgroup_v2_required');
    return { platform: this.platform, engine: 'linux', architecture: info.Architecture };
  }
  async build(contextDirectory, contextDigest) {
    if (!/^[a-f0-9]{64}$/u.test(contextDigest)) throw sandboxError('image_context_invalid');
    const tag = 'jenny-command-worker:' + contextDigest;
    const output = await this._run(['image', 'ls', '--no-trunc', '--format', '{{.ID}}', tag]);
    let imageId = output.toString('utf8').trim();
    if (!IMAGE.test(imageId)) {
      await this._run(['build', '--platform', 'linux/amd64', '--label', 'com.jenny.command.context=' + contextDigest,
        '--tag', tag, '--file', path.join(contextDirectory, 'Dockerfile.worker'), contextDirectory],
      { timeoutMs: 600000, maxBytes: 8 * 1024 * 1024 });
      imageId = JSON.parse((await this._run(['image', 'inspect', tag])).toString('utf8'))[0]?.Id;
    }
    if (!IMAGE.test(imageId)) throw sandboxError('image_identity_invalid');
    const image = JSON.parse((await this._run(['image', 'inspect', imageId])).toString('utf8'))[0];
    if (image?.Config?.Labels?.['com.jenny.command.context'] !== contextDigest
      || image.Os !== 'linux' || image.Architecture !== 'amd64') throw sandboxError('image_identity_invalid');
    return imageId;
  }
  async ensureVolume() {
    const found = (await this._run(['volume', 'ls', '--filter', 'name=^' + this.volumeName + '$', '--format', '{{.Name}}'])).toString().trim();
    if (!found) await this._run(['volume', 'create', '--label', OWNER + '=' + this.ownerId, '--label', VERSION + '=' + VERSION_VALUE, this.volumeName]);
    const volume = JSON.parse((await this._run(['volume', 'inspect', this.volumeName])).toString())[0];
    if (volume?.Name !== this.volumeName || volume?.Labels?.[OWNER] !== this.ownerId
      || volume?.Labels?.[VERSION] !== VERSION_VALUE || volume?.Driver !== 'local'
      || (volume.Options && Object.keys(volume.Options).length)) throw sandboxError('docker_volume_identity_invalid');
  }
  // Row 106: one persistent mirror volume per synced workspace, labelled like the control volume.
  mirrorVolumeName(mirrorId) {
    if (!MIRROR_ID.test(mirrorId)) throw sandboxError('docker_mirror_identity_invalid');
    return 'jenny-mirror-' + this.ownerId + '-' + mirrorId;
  }
  async ensureMirrorVolume(mirrorId) {
    const name = this.mirrorVolumeName(mirrorId);
    const found = (await this._run(['volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}'])).toString().trim();
    const created = !found;
    if (created) {
      await this._run(['volume', 'create', '--label', OWNER + '=' + this.ownerId, '--label', VERSION + '=' + VERSION_VALUE,
        '--label', MIRROR + '=' + mirrorId, name]);
    }
    const volume = JSON.parse((await this._run(['volume', 'inspect', name])).toString())[0];
    if (volume?.Name !== name || volume?.Labels?.[OWNER] !== this.ownerId || volume?.Labels?.[VERSION] !== VERSION_VALUE
      || volume?.Labels?.[MIRROR] !== mirrorId || volume?.Driver !== 'local'
      || (volume.Options && Object.keys(volume.Options).length)) throw sandboxError('docker_volume_identity_invalid');
    return { name, created };
  }
  async listMirrorVolumes() {
    const out = await this._run(['volume', 'ls', '--filter', 'label=' + OWNER + '=' + this.ownerId,
      '--filter', 'label=' + MIRROR, '--format', '{{.Name}}']);
    const prefix = 'jenny-mirror-' + this.ownerId + '-';
    const names = out.toString().trim().split(/\r?\n/u).filter(Boolean);
    if (names.length > 64 || names.some((name) => !name.startsWith(prefix) || !MIRROR_ID.test(name.slice(prefix.length)))) {
      throw sandboxError('docker_owned_resource_limit');
    }
    return names.map((name) => name.slice(prefix.length));
  }
  async removeMirrorVolume(mirrorId) {
    const name = this.mirrorVolumeName(mirrorId);
    const found = (await this._run(['volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}'])).toString().trim();
    if (!found) return;
    const volume = JSON.parse((await this._run(['volume', 'inspect', name])).toString())[0];
    if (volume?.Labels?.[OWNER] !== this.ownerId || volume?.Labels?.[MIRROR] !== mirrorId) throw sandboxError('docker_volume_identity_invalid');
    await this._run(['volume', 'rm', name]);
  }
  async listOwned() {
    const out = await this._run(['container', 'ls', '-a', '--no-trunc', '--filter', 'label=' + OWNER + '=' + this.ownerId,
      '--format', '{{.ID}}']);
    const ids = out.toString().trim().split(/\r?\n/u).filter(Boolean);
    if (ids.length > 16 || ids.some((id) => !ID.test(id))) throw sandboxError('docker_owned_resource_limit');
    return ids;
  }
  async inspect(id) {
    if (!ID.test(id)) throw sandboxError('docker_container_identity_invalid');
    const value = JSON.parse((await this._run(['container', 'inspect', id])).toString())[0];
    if (value?.Id !== id || value?.Config?.Labels?.[OWNER] !== this.ownerId
      || value?.Config?.Labels?.[VERSION] !== VERSION_VALUE
      || !value?.Name?.startsWith('/jenny-command-' + this.ownerId + '-')) throw sandboxError('docker_container_identity_invalid');
    return value;
  }
  // `mirror` ({volume, outboxDirectory}) selects the synced layout; its absence is the copy layout.
  // Both are exact: destinations, types, read-only flags, volume names and bind sources.
  async verify(id, { imageId, snapshotDirectory, mirror = null } = {}) {
    const value = await this.inspect(id);
    const host = value.HostConfig || {};
    const mounts = value.Mounts || [];
    const caps = (list) => [...(list || [])].map((item) => item.replace(/^CAP_/u, '')).sort().join(',');
    if ((imageId && value.Image !== imageId) || value.Config.User !== '0:10003'
      || !host.ReadonlyRootfs || host.Privileged || host.NetworkMode !== 'none'
      || host.PidMode || !['private', ''].includes(host.IpcMode) || host.UTSMode
      || host.Memory !== 2147483648 || host.MemorySwap !== 2147483648
      || host.PidsLimit !== 128 || host.NanoCpus !== 2000000000
      || caps(host.CapDrop) !== 'ALL' || caps(host.CapAdd) !== 'SETGID,SETUID'
      || !(host.SecurityOpt || []).includes('no-new-privileges:true')
      || (host.SecurityOpt || []).some((value) => value.includes('unconfined'))
      || (host.Devices || []).length || Object.keys(host.PortBindings || {}).length
      || mounts.filter((mount) => mount.Type !== 'tmpfs').length !== (mirror ? 4 : 2)) throw sandboxError('docker_security_contract_invalid');
    const inputs = mounts.find((mount) => mount.Destination === '/inputs');
    const control = mounts.find((mount) => mount.Destination === '/run/jenny-worker');
    if (!inputs || inputs.Type !== 'bind' || inputs.RW || !control || control.Type !== 'volume'
      || control.Name !== this.volumeName || !control.RW) throw sandboxError('docker_mount_contract_invalid');
    if (snapshotDirectory && !validBindSource(inputs.Source, snapshotDirectory, this.platform)) throw sandboxError('docker_mount_contract_invalid');
    const workspace = mounts.find((mount) => mount.Destination === '/workspace');
    const outbox = mounts.find((mount) => mount.Destination === OUTBOX_TARGET);
    if (mirror) {
      if (!workspace || workspace.Type !== 'volume' || workspace.Name !== mirror.volume || !workspace.RW
        || !outbox || outbox.Type !== 'bind' || !outbox.RW
        || !validBindSource(outbox.Source, mirror.outboxDirectory, this.platform)) throw sandboxError('docker_mount_contract_invalid');
    } else if ((workspace && workspace.Type !== 'tmpfs') || outbox) throw sandboxError('docker_mount_contract_invalid');
    return value;
  }
  async create({ imageId, snapshotDirectory, mirror = null }) {
    const unsafe = (value) => typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n,]/u.test(value);
    if (!IMAGE.test(imageId) || unsafe(snapshotDirectory)
      || (mirror && (unsafe(mirror.outboxDirectory) || mirror.volume !== this.mirrorVolumeName(mirror.mirrorId)))) {
      throw sandboxError('docker_create_arguments_invalid');
    }
    const workspace = mirror
      ? ['--mount', 'type=volume,source=' + mirror.volume + ',target=/workspace',
        '--mount', 'type=bind,source=' + mirror.outboxDirectory + ',target=' + OUTBOX_TARGET]
      : ['--tmpfs', '/workspace:size=536870912,nr_inodes=16384,mode=0700,uid=10001,gid=10001,nosuid,nodev'];
    const name = 'jenny-command-' + this.ownerId + '-' + randomUUID();
    const args = ['container', 'create', '--name', name, '--platform', 'linux/amd64',
      '--label', OWNER + '=' + this.ownerId, '--label', VERSION + '=' + VERSION_VALUE,
      '--user', '0:10003', '--restart', 'unless-stopped', '--network', 'none', '--ipc', 'private',
      '--read-only', '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
      '--security-opt', 'no-new-privileges:true', '--cpus', '2', '--memory', '2g', '--memory-swap', '2g',
      '--pids-limit', '128', '--stop-timeout', '10',
      '--mount', 'type=volume,source=' + this.volumeName + ',target=/run/jenny-worker',
      '--mount', 'type=bind,source=' + snapshotDirectory + ',target=/inputs,readonly',
      ...workspace,
      '--tmpfs', '/tmp:size=67108864,nr_inodes=4096,mode=1777,nosuid,nodev',
      '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2',
      '--entrypoint', 'python3', imageId, '-I', '-c', SUPERVISOR];
    const id = (await this._run(args)).toString().trim();
    if (!ID.test(id)) throw sandboxError('docker_container_identity_invalid');
    try {
      await this.verify(id, { imageId, snapshotDirectory, mirror });
      await this._run(['container', 'start', id]);
      return id;
    } catch (error) {
      try { await this.stopAndRemove(id); }
      catch { throw sandboxError('sandbox_cleanup_unconfirmed'); }
      throw error;
    }
  }
  async relay(id, operation, input = null, beforeSend = null) {
    await this.inspect(id);
    if (!['bootstrap', 'request'].includes(operation)) throw sandboxError('relay_operation_invalid');
    if (beforeSend) await beforeSend();
    return this._run(['container', 'exec', '-i', '--user', '0:10003', id, 'python3', '-I', '-c', RELAY, operation],
      { input, timeoutMs: 7000, maxBytes: 3 * 1024 * 1024 });
  }
  async stopAndRemove(id) {
    if (!ID.test(id)) throw sandboxError('docker_container_identity_invalid');
    const present = (await this._run(['container', 'ls', '-a', '--no-trunc', '--filter', 'id=' + id,
      '--format', '{{.ID}}'])).toString().trim().split(/\r?\n/u).filter(Boolean);
    if (present.some(value => value !== id)) throw sandboxError('docker_container_identity_invalid');
    if (!present.length) return { cleanupConfirmed: true };
    const before = await this.inspect(id);
    if (before.State.Running || before.State.Restarting) {
      await this._run(['container', 'stop', '--time', '10', id], { timeoutMs: 20000 });
    }
    const stopped = await this.inspect(id);
    if (stopped.State.Running || stopped.State.Restarting || stopped.State.Pid !== 0) throw sandboxError('sandbox_cleanup_unconfirmed');
    await this._run(['container', 'rm', id]);
    if ((await this.listOwned()).includes(id)) throw sandboxError('sandbox_cleanup_unconfirmed');
    return { cleanupConfirmed: true };
  }
}
module.exports = { DockerLauncher, localEndpoint, validBindSource, OWNER, VERSION, MIRROR, OUTBOX_TARGET, ID, IMAGE };
