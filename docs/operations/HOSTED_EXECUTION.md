# Hosted execution boundary

Jenny hosting and model-executed commands are separate boundaries. The hosted
application owns authentication, approvals, canonical conversations, typed
file tools, and the broker receipt. The offline worker owns one disposable
foreground command and its bounded terminal result. No command runs in the
application or inference-sidecar process, and there is no subprocess fallback.

## What can run

The current worker accepts only an approved foreground `run_command` request.
It runs one job per worker PID-1 incarnation, then persists its bounded terminal
receipt before the namespace exits. A different authenticated incarnation must
report the previous receipt before the broker treats the result as terminal.
An unfinished admission becomes `interrupted` after restart and is never
replayed. A cancel received while ready with no current job consumes that job ID
and recycles the incarnation, fencing a delayed submit.

The command runs as `/bin/sh -c` after a trusted helper has verified its fixed
job identity, copied the read-only input workspace, and reported readiness.
Command file changes are disposable. Typed file tools remain the durable path
for deliberate edits.

Shell commands may invoke the image's installed Python or Node interpreter.
The dedicated `python_execute` tool, terminals/PTYs, persistent background
services, Git/LSP/test-runner tool integrations, executable plugins, third-party
MCP and desktop-native execution adapters remain unavailable. One-off approval is required
for each admitted command; denial or an unavailable worker never reaches a
subprocess.

## Disposable copy and limits

The worker mounts the durable typed-tool workspace as read-only `/inputs` and
copies it into a fresh `/workspace` tmpfs for each job. The copy accepts regular
single-link files only and rejects symlinks, hardlinks, devices, FIFOs, sockets,
and other special entries. Linux traversal uses descriptor-relative
`O_NOFOLLOW` operations and bounded path handling.

The fixed limits are:

| Resource | Limit |
| --- | --- |
| Input snapshot | 64 MiB and 2,048 total entries, depth 32, paths up to 4,096 bytes |
| `/workspace` | 512 MiB tmpfs, 16,384 inodes |
| `/tmp` | 64 MiB tmpfs, 4,096 inodes |
| Per-file size | 64 MiB (`RLIMIT_FSIZE`) |
| Open file descriptors | 256 (`RLIMIT_NOFILE`) |
| Wall time | 120 seconds |
| Captured output | 256 KiB total stdout plus stderr; bridge/UI display may truncate further |
| Worker cgroup | 2 CPUs, 2 GiB memory, 128 PIDs, no swap |

The application service has separate limits of 2 CPUs, 2 GiB memory, and 256
PIDs. The worker’s network namespace is disabled. Compose also bounds the
tmpfs inode counts; Docker does not provide a portable named-volume disk quota
for the durable workspace.

## Process and identity boundary

The worker supervisor is PID 1, root:GID10003, with only SETUID and SETGID
capabilities. It is the trusted process that authenticates the control socket,
records admission and terminal state atomically with `fsync`, and exits after a
terminal result. Namespace exit removes descendants, including setsid,
double-fork, and other detached descendants; the supervisor does not rely on a
process-group kill capability.

The job helper is launched with UID/GID10001, supplementary groups `[]`, no
effective, permitted, inheritable, or ambient capabilities, and
`no-new-privileges`. It receives a fixed environment and only the descriptors
needed for its pipes. The helper closes the readiness descriptor before
executing `/bin/sh`.

The application and inference sidecar are one trusted application boundary.
The worker boundary covers the untrusted command job; it does not protect
against a compromised application container or a Docker administrator.

## Control protocol and durable fencing

The supervisor listens on an authenticated Unix socket in the private
`/run/jenny-worker` control directory. Requests and responses are newline-
delimited UTF-8 envelopes containing exactly a base64 JSON payload and an
HMAC-SHA256 over that exact base64 payload. The 32-byte controller key is
created or read as root:GID10003 with mode 0640; the directory is mode 0770 and
the socket is mode 0660. The supervisor checks the connecting application UID
with `SO_PEERCRED`.

Requests are schema version 1 and limited to `status`, `submit`, and `cancel`.
The request envelope is bounded to 128 KiB, the response to 3 MiB, and socket
transport waits are limited to five seconds. Submit retries match the complete
live admission exactly. A stale incarnation, mismatched job, malformed state,
receipt mismatch, or unavailable cleanup blocks further execution.

The control volume contains the controller key and the last admission/result
receipt. It must stay paired with the application profile receipt. Never delete
the control volume alone to resolve an ambiguous command.

## Container restrictions

The sandbox uses `network_mode: none`, a read-only root filesystem, no
privileged mode, all capabilities dropped except SETUID/SETGID, and
`no-new-privileges`. It has no profile, secret, host-home, Docker socket, daemon
API, writable host root, or host namespace mount. The application receives the
control directory read-only; the job receives no control socket or key.

The application’s model credentials remain in the mounted secret files owned by
the hosted configuration boundary. The worker never receives those files or
their values. Docker hosting alone does not make arbitrary code safe; these
restrictions are part of the explicit offline worker contract.

Docker or containerd socket access can grant host-level control by allowing new
containers and host mounts. A read-only socket mount does **not** make daemon
operations read-only. Never mount these sockets or expose a daemon API to Jenny.
Privileged containers, host PID/IPC/network namespaces, SYS_ADMIN, unconfined
security profiles and host credential mounts are outside this supported boundary.
The daemon and host kernel remain trusted; Docker is not a virtual-machine
security boundary against a kernel exploit. See [Docker security](https://docs.docker.com/engine/security/)
and [runtime privilege controls](https://docs.docker.com/engine/containers/run/).

## Operations and qualification

Stop both `jenny` and `sandbox` before a full backup or maintenance operation.
The app broker drains admitted work during shutdown; configure refuses a
running app. An idle sandbox can remain running during reconfiguration. Preserve the
profile, control, workspace, and configuration volumes together, and preserve
secrets separately. An uncertain result or cleanup state requires reconciliation
from the paired receipts; it must not be repaired by replaying the command or
deleting control metadata.

The real Docker Desktop Linux-amd64 localhost lane passed browser approval/
denial/cancellation, restart persistence, descendant cleanup, resource probes
and interrupted-admission recovery. CPU/memory controls were verified from
Docker/cgroup state; deliberate OOM pressure was not tested. Native Linux/other
runtimes, owner-model behavior and full backup/restore/upgrade qualification
remain release gates. See the batch record.
## Shared desktop worker implementation

The optional desktop command backend reuses a transport-independent broker and HMAC schema under `services/execution/`. `services/host/execution-broker.js` and `worker-transport.js` remain compatible Unix-socket adapters. The combined implementation includes hosted policy v2 and guided browser setup; desktop activation remains independently configured. See [Desktop command sandbox](DESKTOP_COMMAND_SANDBOX.md) for Electron ownership, setup, resource limits and actual Windows qualification.
