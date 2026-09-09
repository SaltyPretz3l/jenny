---
kind: operations-guide
last_reviewed: 2026-09-09
---

# Desktop Docker command sandbox

Jenny can run foreground commands in a disposable Linux Docker worker while Electron continues to own chat history, approvals, credentials and local inference. This is optional; shell-config v53 migrates existing profiles with the setting off. Enabling requires idle chats and an acknowledged sidecar execution policy. It does not enable hosted mode.

## Setup

1. Install and start Docker independently. Jenny never installs Docker, changes Docker settings or prunes resources. On Windows, Docker Desktop must use its Linux engine with cgroup v2.
2. Open Jenny and configure a tools workspace.
3. Open Settings → Tools → Docker command sandbox and enable it.
4. Wait for Ready. Initial preparation builds the application-owned worker image locally from a digest-pinned Linux amd64 base and may download build dependencies. Subsequent commands have no network access. Required emulation must work on non-amd64 hosts.
5. Chat and approve foreground commands normally. Existing current Electron auto/deny policy still applies. Plan/read-only mode prevents command admission.

For source testing, use the repository's normal launch instructions. The 1.1 candidate has not yet been qualified as an installed package; consult this release's notes before assuming an older installation contains the sandbox.

## Files and commands

Commands always use Linux `/bin/sh`, including on Windows/macOS. `cwd` is a relative Linux path inside the configured workspace copy (default `.`). A command can use installed Python and Node. There is no background option. Maximum duration is 120 seconds and combined output is limited to 256 KiB.

Electron stages a snapshot before approval: at most 64 MiB, 2,048 entries, depth 32 and bounded paths. Links, junctions/reparse points, hardlinks, special files, profile overlap and detected source changes are rejected. Staging files and directories are made read-only, then the content digest and workspace root identity are checked again immediately before admission. The live workspace is never mounted. The worker copies read-only staging into its disposable `/workspace`. **All command-created or edited files are discarded.** Use Jenny's reviewed typed `write_file`/`edit_file` path for durable changes. Large repositories may exceed snapshot limits and must use a suitably bounded workspace.

The worker has no network, profile, credentials or Docker socket; root filesystem is read-only. Jobs run as UID/GID 10001 without effective capabilities. The trusted PID-1 supervisor keeps only SETUID/SETGID and enforces seccomp/no-new-privileges plus Docker's private namespaces, 2 CPUs, 2 GiB with no swap, 128 PIDs, 512 MiB workspace and 64 MiB temporary storage. A container incarnation accepts one job. Its successor authenticates the terminal result; Docker's changed startup identity confirms namespace replacement before cleanup is reported.

## Unsupported execution

Only foreground `run_command` is qualified. Temporary scripts, `python_execute`, background commands/monitors, Git subprocess tools, verification runners, LSP, third-party MCP, executable plugin tools, delegation, automatic checkpoints/worktrees and provider-owned execution integrations are unavailable. Reviewed typed file tools and ordinary user-operated desktop controls remain separate. Local managed model inference is unchanged. A command cannot fall back to host execution when Docker fails or the setting is disabled.

## State and recovery

Disabled means the optional backend is off. Preparing includes image build and a real worker contract check. Ready admits one transaction. Busy includes snapshot preparation, approval and execution; competing conversations get a bounded refusal and are not queued. Workspace changes invalidate approval and cancel admitted work. Settings cannot change during a transaction or an active chat.

Unavailable reports a prerequisite/preparation failure. Start Docker with the Linux engine and select a local Docker context, then Retry. Remote TCP/SSH Docker endpoints are rejected. Recovery required means Jenny cannot prove cleanup; new execution stays blocked. Retry inspects only resources with this profile's deterministic Jenny ownership labels, stops/removes their namespaces and reconciles pending receipts without replaying commands. Restoring Docker access may be necessary. Do not treat killing a CLI or shell as cleanup proof.

Admission is flushed to a bounded profile journal before submission. Bounded terminal results are flushed before pending state clears. Startup discovers owned containers even with missing receipts; torn data is preserved for diagnosis and reconciled only after namespace cleanup. Unresolved receipts are not compacted away. Shutdown stops only this profile's Jenny resources. Prepared images and the protected control volume may remain for reuse; Jenny performs no broad cleanup.

## Qualification

On 2026-09-09 the real Windows Docker Desktop Linux amd64 daemon (Engine 29.7.2, cgroup v2) built and ran the packaged allowlisted worker context. Confirmed: UID/GID 10001; host workspace unchanged; external network and controller-key access denied; no daemon socket; timeout; cancellation; 256 KiB output truncation; detached-descendant namespace cleanup; temporary storage exhaustion; PID exhaustion at 124 child processes; memory termination (exit 137); authenticated successor results and owned-container removal; profile service restart; actual controller termination during admission followed by startup recovery with intact, missing and torn Windows journals (no replay). The reproducible probe is `node scripts/packaging/probe-desktop-command-worker.js`; `--recovery` exercises controller termination and intact/missing/torn receipts with disposable profiles. `--wire` exercised the actual Docker stdin relay: malformed frames, forged authentication, trailing data, idempotent duplicate submission (one execution), competing jobs, stale incarnation rejection and exact Windows staging-mount identity. `--smoke` repeats the isolation case. Windows journal tests also cover repeated corruption with bounded diagnostic archive rotation.

An owner-authorized Windows computer-use pass also drove the actual Electron Settings and chat UI with deterministic replay commands: enabling to Ready, Allow once with real Docker output, Deny with no admission, Stop with confirmed cleanup and a Cancelled tool card, and full app close/relaunch preserving successful and cancelled Docker result metadata. The pass found and fixed private-attribution argument forwarding and cancellation-result persistence.

Linux and macOS adapters are implemented but not live-qualified. Unit/fake tests do not qualify a host platform. The complete GUI smoke suite, full CI, packaged installer launch and a machine-wide Docker daemon stop/restart remain outstanding owner/environment gates. The test suite simulates Docker loss without disrupting other Docker workloads.
