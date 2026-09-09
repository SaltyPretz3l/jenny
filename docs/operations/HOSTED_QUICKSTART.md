# Run Jenny with Docker

Experimental source workflow for the 1.1 candidate. This guide does not imply
a published image or qualified installer; read the qualification status below.

The guided Docker profile runs Jenny on one computer and serves its browser UI
on `http://127.0.0.1:8080`. The fresh setup wizard defaults to this localhost
address, creates an owner login, checks the model endpoint, and can enable the
offline command sandbox. No Tailscale account, domain, certificate, Node.js,
Python, or npm installation on the host computer is required.

Private HTTPS remains available for an existing or explicitly configured remote
deployment. It is a separate access mode. New setup uses localhost HTTP; an
existing configuration keeps its current secure mode until you explicitly
configure a different mode.

## Before you start

- A Linux x64 Docker host, or Docker Desktop using Linux containers, with
  Docker Compose 2.24.4 or newer and cgroup v2 enabled. The worker service is
  created by Compose even when execution is disabled, so cgroup v2 is required
  for the easy profile in either case. Native ARM images are not qualified.
- A checkout containing `compose.host.easy.yml`. The first build needs internet
  access to obtain image dependencies and may take several minutes.
- An Ollama or OpenAI-compatible model server with an installed model. Its
  address is entered as seen from Docker; for a model server on the Docker
  host, start with `http://host.docker.internal:11434` or
  `http://host.docker.internal:1234/v1`.

The Jenny service is limited to 2 CPUs, 2 GiB of memory, and 256 PIDs. The
offline sandbox is limited to 2 CPUs, 2 GiB, 128 PIDs, and no swap. These
limits are in addition to the resources required by the model server.

## Set up and start

Run the launcher from the checkout in an interactive terminal:

**Windows PowerShell**

```powershell
.\docker-setup.ps1
```

**Linux or macOS Bash**

```sh
bash docker-setup.sh
```

The wizard asks for browser access, the model server and URL, an optional
hidden API key, an installed model, typed file tools, the offline disposable
command sandbox, and the owner password. The owner password is entered without
echo and must be at least 12 bytes. Credentials are stored in the dedicated
secret volume rather than Compose environment variables or command arguments.

When setup completes, open [http://127.0.0.1:8080](http://127.0.0.1:8080) on
the Docker host computer and sign in. Jenny retains canonical conversations in
the profile volume. Multiple browsers can observe a session; conversation
control remains explicit and one tab controls a conversation at a time.

## Connect your model server

The server URL must work **from inside Docker**. For a server on this computer,
use `http://host.docker.internal:11434` for Ollama or
`http://host.docker.internal:1234/v1` for an OpenAI-compatible server, replacing
the port with its actual port. Container `localhost` means that container.
On Linux, `host-gateway` cannot reach a service listening only on host loopback;
configure its private listener/firewall deliberately. Jenny does not change model
listeners, install models, or control externally owned servers. The model runs
outside the offline command worker.

A successful model listing checks connectivity, not generation. Send a short
chat after login. If Docker reports a missing `dockerDesktopLinuxEngine` pipe,
start Docker Desktop in Linux-container mode and wait for `docker info` to show
a running server; `docker compose version` alone only checks the client.

## Access from another device

Localhost mode is intentionally bound to the Docker host computer. To use
another device, run `configure` and choose private HTTPS, then place a private
HTTPS proxy in front of `http://127.0.0.1:8080`. The proxy must preserve the
Host header and stream SSE without buffering. Tailscale Serve is optional for
that mode; it is not part of localhost setup and public Funnel must remain
disabled.

Changing browser access mode or its origin signs out existing browsers. The
wizard asks for explicit confirmation before making that change. Existing
secure HTTPS configurations are not silently downgraded.

## Check, configure, and stop

Use the launcher for diagnostics and configuration:

```powershell
.\docker-setup.ps1 doctor
.\docker-setup.ps1 configure
```

```sh
bash docker-setup.sh doctor
bash docker-setup.sh configure
```

The configure flow requires Jenny to be stopped and preserves the profile,
owner login, conversations, and typed-tool files. It revalidates settings and
revokes browser sessions when access mode or origin changes. Stop the Jenny service explicitly before configure; its broker drains admitted
commands during shutdown. An idle sandbox may remain running.

For logs and an ordinary stop that retains data:

```sh
docker compose -p jenny-host -f compose.host.easy.yml logs --tail 100 jenny
docker compose -p jenny-host -f compose.host.easy.yml stop jenny
```

For a full stop before backup, maintenance, or host shutdown, stop both
services:

```sh
docker compose -p jenny-host -f compose.host.easy.yml stop jenny sandbox
```

`down --volumes`, volume pruning, and deleting the control volume are not
repair procedures. If a command result or cleanup state is uncertain, preserve
the control volume and profile together and use the documented recovery path.

## Persistent volumes

The easy profile uses the fixed Compose project `jenny-host` and five named
volumes:

| Volume | Contents |
| --- | --- |
| `jenny-host_jenny_control` | Private worker controller key and last admission/terminal receipt; paired with the profile receipt |
| `jenny-host_jenny_profile` | Canonical conversations, attachments, owner login, and runtime metadata |
| `jenny-host_jenny_workspace` | Durable files created by enabled typed tools and the read-only input workspace for the sandbox |
| `jenny-host_jenny_config` | Hosted settings, browser mode, model selection, and endpoint configuration |
| `jenny-host_jenny_secrets` | Mounted model API key, when configured |

Back up the profile, control, workspace, and configuration volumes together;
protect the secret backup separately. Never delete `jenny_control` alone to
repair an uncertain job: its receipt must remain paired with the profile
receipt. Secrets are private files and are not encrypted at rest by Docker;
protect the host disk and restricted backups.

## Offline command sandbox

When the wizard enables execution, only foreground `run_command` calls reach
the offline worker, after the existing one-off approval. The worker runs one
job per PID-1 incarnation and waits about 10 seconds before reporting ready
after namespace recycling. Commands run with no external network in a
disposable copy of `/inputs`: at most 64 MiB and 2,048 total entries, depth 32,
and no symlinks, hardlinks, devices, or other special files. `/workspace` is a
512 MiB tmpfs with 16,384 inodes; `/tmp` is a separate 64 MiB tmpfs with 4,096
inodes. Each file is limited to 64 MiB, wall time to 120 seconds, and captured
stdout plus stderr to 256 KiB (the existing bridge or UI may further truncate
what is displayed).

Command changes are discarded when the job ends. Use typed file tools to save
durable changes. Shell commands can use the installed Python and Node runtimes.
Dedicated Python/artifact execution, terminal/background-service, Git/LSP tool
integrations, executable plugins, third-party MCP and desktop-native adapters
remain unavailable.

The trusted supervisor is root:GID10003 with only SETUID and SETGID; the job
runs as UID/GID10001 with no supplementary groups, capabilities, or new
privileges. The application and sidecar are one trusted application boundary.
The worker receives no profile, secret, host-home, Docker socket, or host
namespace mount. Its controller directory is separate, and the application’s
control mount is read-only to the application while the job cannot access it.

## Qualification status

The Docker Desktop Linux-amd64 localhost packaging lane passed with a real
Chromium browser and deterministic model fixture, including approvals, denial,
cancellation, restart persistence and worker cleanup/resource checks. Your
actual model endpoint still needs a chat/tool test. Native Linux/other runtime
qualification, full backup/restore/upgrade and optional private HTTPS/mobile
acceptance remain release gates; no public image is assumed.

Further background is in [HOSTED_JENNY.md](HOSTED_JENNY.md) and
[HOSTED_EXECUTION.md](HOSTED_EXECUTION.md).
