'use strict';
// Row 106 P0a/P0b: what a live workspace bind does on this Docker host before any product code relies
// on it. One throwaway container from the cached command-worker image with the worker's isolation
// flags (no supervisor), the planned layout (workspace rw, protected paths ro on top) and a probe label;
// `--rm` removes it. Prints one JSON object per case, then a verdict. Owner go required (real Docker).
//   node scripts/packaging/probe-workspace-mount.js [--image <sha256:...>] [--repo <dir to time>]
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('../../services/fs-remove-no-follow');
const { createWorkspaceSnapshot, removeSnapshot } = require('../../services/execution/desktop-workspace-snapshot');

const LABEL = 'com.jenny.probe=row106';
const PROTECTED = ['.git', '.husky', 'node_modules', '.bare', 'tools/hooks'];

function docker(args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    execFile('docker', args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

async function workerImage(explicit) {
  if (explicit) return explicit;
  const listed = await docker(['image', 'ls', '--no-trunc', '--format', '{{.ID}}', '--filter', 'reference=jenny-command-worker']);
  const id = listed.stdout.split(/\r?\n/u).find((line) => /^sha256:[a-f0-9]{64}$/u.test(line.trim()));
  if (!id) throw new Error('no cached jenny-command-worker image; enable the sandbox once to build it');
  return id.trim();
}

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

async function fixture(base) {
  const ws = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await write(path.join(outside, 'secret.txt'), 'outside the workspace');
  await write(path.join(ws, 'a.txt'), 'edit me');
  await write(path.join(ws, 'del.txt'), 'delete me');
  await write(path.join(ws, '.git', 'config'), '[core]\n\tbare = false\n');
  await write(path.join(ws, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh\n');
  await write(path.join(ws, '.husky', 'pre-commit'), '#!/bin/sh\nnpm test\n');
  await write(path.join(ws, 'node_modules', '.bin', 'tool'), '#!/bin/sh\necho tool\n');
  await write(path.join(ws, 'sub', '.git'), 'gitdir: ../.bare\n');
  await write(path.join(ws, '.bare', 'config'), '[core]\n\tbare = true\n');
  await write(path.join(ws, 'tools', 'hooks', 'h.sh'), '#!/bin/sh\n');
  await fs.symlink(outside, path.join(ws, 'junction_out'), 'junction');
  return { ws, outside };
}

async function hashTree(dir) {
  const out = {};
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out[path.relative(dir, full)] = crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex');
    }
  }
  await walk(dir).catch(() => {});
  return out;
}

// Runs inside the container as uid 10001. Each case prints {"case", "ok", "detail"}; ok means the
// operation succeeded (for a write into a protected path, ok:true is a FAILURE of the boundary).
const CONTAINER_SCRIPT = String.raw`
import json, os, time, errno
W = "/workspace"
def case(name, fn):
    try:
        detail = fn()
        print(json.dumps({"case": name, "ok": True, "detail": detail}))
    except OSError as e:
        print(json.dumps({"case": name, "ok": False, "detail": errno.errorcode.get(e.errno, str(e.errno))}))
def put(p, text="x"):
    with open(p, "w") as f: f.write(text)
    return p
case("uid", lambda: [os.getuid(), os.getgid()])
case("write_new", lambda: put(W + "/new.txt", "made in container"))
case("edit_existing", lambda: put(W + "/a.txt", "edited"))
case("delete_existing", lambda: os.remove(W + "/del.txt"))
case("mkdir", lambda: os.makedirs(W + "/made/dir"))
case("stat_new_owner", lambda: [os.stat(W + "/new.txt").st_uid, oct(os.stat(W + "/new.txt").st_mode)])
for name in [".git/config", ".git/hooks/pre-commit", ".GIT/config", ".Git/hooks/pre-commit",
             "GIT~1/config", ".git./config", ".git /config", ".git::$INDEX_ALLOCATION/config"]:
    case("protected_git:" + name, lambda n=name: put(W + "/" + n, "planted"))
for name in [".husky/pre-commit", ".HUSKY/pre-commit", "node_modules/.bin/tool", "NODE_MODULES/.bin/tool",
             ".bare/config", ".BARE/config", "sub/.git", "sub/.GIT"]:
    case("protected:" + name, lambda n=name: put(W + "/" + n, "planted"))
case("rename_git_dir", lambda: os.rename(W + "/.git", W + "/git_moved"))
case("rename_parent_of_nested", lambda: os.rename(W + "/tools", W + "/tools_moved"))
case("recreate_nested_after_parent_rename", lambda: (os.makedirs(W + "/tools/hooks", exist_ok=True), put(W + "/tools/hooks/h.sh", "planted"))[1])
case("rename_into_protected", lambda: os.rename(W + "/a.txt", W + "/.GIT/a.txt"))
case("symlink_absolute", lambda: os.symlink("/etc/passwd", W + "/link_abs"))
case("symlink_escape_relative", lambda: os.symlink("../outside/secret.txt", W + "/link_rel"))
case("hardlink", lambda: os.link(W + "/new.txt", W + "/new_hard.txt"))
case("junction_list", lambda: os.listdir(W + "/junction_out"))
case("junction_read", lambda: open(W + "/junction_out/secret.txt").read())
case("chmod_exec", lambda: (os.chmod(W + "/new.txt", 0o755), oct(os.stat(W + "/new.txt").st_mode))[1])
def bench(root, n=2000):
    os.makedirs(root, exist_ok=True)
    t = time.perf_counter()
    for i in range(n): put(root + "/f%d.txt" % i, "y" * 512)
    w = time.perf_counter() - t
    t = time.perf_counter()
    for i in range(n): open(root + "/f%d.txt" % i).read()
    r = time.perf_counter() - t
    return {"files": n, "write_s": round(w, 3), "read_s": round(r, 3)}
case("bench_bind", lambda: bench(W + "/bench"))
case("bench_tmpfs", lambda: bench("/tmp/bench"))
`;

const REPO_SCRIPT = String.raw`
import json, os, time
t = time.perf_counter(); files = 0; size = 0
for root, dirs, names in os.walk("/repo"):
    dirs[:] = [d for d in dirs if d not in ("__pycache__", ".pytest_cache")]
    for n in names:
        try:
            with open(os.path.join(root, n), "rb") as f: size += len(f.read()); files += 1
        except OSError: pass
print(json.dumps({"case": "bench_repo_walk_read", "ok": True, "detail": {"files": files, "bytes": size, "seconds": round(time.perf_counter() - t, 3)}}))
`;

function isolationArgs(name, image) {
  return ['run', '--rm', '--name', name, '--label', LABEL, '--platform', 'linux/amd64', '--user', '10001:10001',
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '128', '--memory', '2g', '--tmpfs', '/tmp:size=268435456', '--entrypoint', 'python3'];
}

function parseCases(stdout) {
  return stdout.split(/\r?\n/u).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
}

async function hostChecks(ws, before) {
  const after = await hashTree(path.join(ws, '.git'));
  const lstat = (rel) => fs.lstat(path.join(ws, rel)).then((s) => ({ symlink: s.isSymbolicLink(), file: s.isFile(), nlink: s.nlink }), () => null);
  const readlink = (rel) => fs.readlink(path.join(ws, rel)).catch(() => null);
  return {
    git_unchanged: JSON.stringify(before) === JSON.stringify(after),
    git_after: after,
    new_txt_on_host: await fs.readFile(path.join(ws, 'new.txt'), 'utf8').catch(() => null),
    del_gone: await fs.stat(path.join(ws, 'del.txt')).then(() => false, () => true),
    husky: await fs.readFile(path.join(ws, '.husky', 'pre-commit'), 'utf8').catch(() => null),
    node_bin: await fs.readFile(path.join(ws, 'node_modules', '.bin', 'tool'), 'utf8').catch(() => null),
    bare: await fs.readFile(path.join(ws, '.bare', 'config'), 'utf8').catch(() => null),
    gitfile: await fs.readFile(path.join(ws, 'sub', '.git'), 'utf8').catch(() => null),
    nested_hook: await fs.readFile(path.join(ws, 'tools', 'hooks', 'h.sh'), 'utf8').catch(() => null),
    tools_moved_exists: await fs.stat(path.join(ws, 'tools_moved')).then(() => true, () => false),
    link_abs: { lstat: await lstat('link_abs'), target: await readlink('link_abs') },
    link_rel: { lstat: await lstat('link_rel'), target: await readlink('link_rel') },
    new_hard: await lstat('new_hard.txt'),
    root_entries: (await fs.readdir(ws)).sort(),
  };
}

async function repoTiming(image, repo) {
  const timings = {};
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-probe-staging-'));
  const started = Date.now();
  try {
    const snapshot = await createWorkspaceSnapshot({ root: repo, stagingRoot: staging,
      limits: { bytes: 4 * 1024 * 1024 * 1024, entries: 500000, depth: 64, pathBytes: 4096 } });
    timings.copy_mode_host_stage_s = (Date.now() - started) / 1000;
    await removeSnapshot({ directory: snapshot.directory, stagingRoot: staging });
  } catch (error) {
    timings.copy_mode_host_stage = 'refused: ' + (error.reason || error.code || error.message);
  } finally { await removeTree(staging); }
  const name = 'jenny-probe-row106-repo-' + crypto.randomBytes(4).toString('hex');
  const run = await docker([...isolationArgs(name, image), '--mount', `type=bind,source=${repo},target=/repo,readonly`, image, '-I', '-c', REPO_SCRIPT], 600000);
  timings.live_mode = parseCases(run.stdout)[0] || { error: run.stderr.slice(0, 500) };
  return timings;
}

async function main() {
  const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
  const image = await workerImage(arg('--image'));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-probe-row106-'));
  const name = 'jenny-probe-row106-' + crypto.randomBytes(4).toString('hex');
  console.log(JSON.stringify({ image, base, container: name }));
  try {
    const { ws } = await fixture(base);
    const before = await hashTree(path.join(ws, '.git'));
    const mounts = ['--mount', `type=bind,source=${ws},target=/workspace`];
    for (const rel of PROTECTED) {
      mounts.push('--mount', `type=bind,source=${path.join(ws, rel)},target=/workspace/${rel},readonly`);
    }
    const run = await docker([...isolationArgs(name, image), ...mounts, image, '-I', '-c', CONTAINER_SCRIPT]);
    if (run.code !== 0 && !run.stdout) throw new Error('docker run failed: ' + run.stderr.slice(0, 800));
    const cases = parseCases(run.stdout);
    for (const entry of cases) console.log(JSON.stringify(entry));
    const host = await hostChecks(ws, before);
    console.log(JSON.stringify({ host }));
    const breaches = cases.filter((c) => (c.case.startsWith('protected') || c.case === 'rename_into_protected') && c.ok);
    const verdict = {
      alias_or_protected_writes_succeeded: breaches.map((c) => c.case),
      git_unchanged_on_host: host.git_unchanged,
      parent_rename_moved_nested_mount: cases.find((c) => c.case === 'rename_parent_of_nested')?.ok === true,
      junction_reached_outside: cases.some((c) => c.case.startsWith('junction') && c.ok),
      layout: breaches.length || !host.git_unchanged ? 'FALLBACK (per-entry binds)' : 'PRIMARY (rw root + ro children)',
    };
    console.log(JSON.stringify({ verdict }));
    const repo = arg('--repo');
    if (repo) console.log(JSON.stringify({ repo_timing: await repoTiming(image, path.resolve(repo)) }));
  } finally {
    const leftover = await docker(['container', 'ls', '-a', '--filter', 'name=^' + name + '$', '--filter', 'label=' + LABEL, '--format', '{{.ID}}']);
    if (leftover.stdout.trim()) await docker(['container', 'rm', '-f', leftover.stdout.trim()]);
    await removeTree(base);
  }
}

main().catch((error) => { console.error(error.stack || String(error)); process.exitCode = 1; });
