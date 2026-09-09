# Localhost and private browser hosting

Status: implementation under qualification. Do not treat a successful source
build as a qualified image or deployment. Linux container, HTTPS proxy and real
multi-device acceptance gates below must pass before release.

This host serves one owner's conversations from one canonical profile. Browsers
are interchangeable clients. Electron remains the desktop host; running Electron
inside Docker is not the browser architecture. Desktop Remote Control is a
separate integration and is not a build dependency.

For a new installation, use the [guided Docker quick start](HOSTED_QUICKSTART.md).
It needs no host Node/Python installation. The manual bind-mount procedure below
remains available for custom workspaces and existing deployments.

## Deployment contract

Default topology: a browser on this computer -> `http://127.0.0.1:8080` ->
Jenny's trusted Node host and managed inference sidecar -> an existing private
Ollama or OpenAI-compatible endpoint. Commands use a separate offline sandbox
container. The browser and inference sidecar do not own conversation history.
Tailscale is optional. Read the [execution boundary](HOSTED_EXECUTION.md) before
changing mounts or container restrictions.

Schema 2 requires `browser_access_mode`: `localhost_http` accepts only the exact
`http://127.0.0.1:<port>` canonical origin, with a matching configured port;
`private_https` requires HTTPS. Compose publishes only host `127.0.0.1:8080`.
Container `0.0.0.0` is an internal listener, not permission for LAN publication.
Do not change the published host address to `0.0.0.0` for local HTTP. Loopback
HTTP trusts native local processes and other services on the same host; it is
not a security boundary against a malicious local application.

For other devices, explicitly configure `private_https` and place a private VPN
HTTPS proxy (for example Tailscale Serve) in front of the loopback port. Preserve
the canonical Host and stream SSE without buffering. Jenny ignores forwarded
identity and still requires its own owner login. Keep public Funnel/ingress and
host networking disabled. See [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

Existing schema-1 configurations remain private HTTPS with policy 1 and command
execution disabled. Repeated setup does not silently downgrade access or enable
commands. Stopped `configure` upgrades to schema 2; an access mode/origin change
requires explicit confirmation and revokes all browser sessions before saving,
preserving owner credentials and canonical history. Set `execution` to `null`
or `{"mode":"offline-copy"}`; the latter requires policy version 2 and workspace
`/workspaces/default`. Policy 2 is acknowledged by the managed sidecar only when
the host supplies the worker capability. Manual `config/host.example.json` retains
the schema-1 HTTPS compatibility example; the wizard creates current defaults.

The browser uses its language setting unless `jenny.ui.language` is already
saved in this origin's local storage. The language is selected at page load;
Arabic also sets right-to-left document direction. The build includes all
shipped language catalogs at fixed `/locales/<tag>.json` routes available before
login. If a catalog cannot load, the login and application remain usable in
English. Desktop language preferences remain independently owned by Electron.

Build with `docker compose -f compose.host.yml build`. Before starting, copy
`config/host.example.json` to private `config/host.json`, set the real origin,
model name and endpoint, and create `secrets/` outside version control. The sample
model is illustrative; Jenny does not install or pull it. Bind-mount any model
credential as `secrets/model-api-key`, readable by container UID/GID 10001 and
unreadable to unrelated host users. The mount is read-only. Never put the key in
the JSON, URL, command arguments or environment. A mounted secret is not encrypted
at rest; encrypt the host disk and protect backups. Desktop safeStorage blobs
cannot be transplanted into this host.

Initialize the owner through a local interactive terminal while the host is
stopped:

```sh
docker compose -f compose.host.yml run --rm --no-deps --entrypoint node jenny server/cli.js owner-init --config /etc/jenny/host.json
docker compose -f compose.host.yml up -d
```

The first command prompts twice without echo. It acquires the profile lock and
never starts inference. The host refuses an existing desktop profile, a second
writer, an uninitialized owner or an unfinished import. Do not remove lock/owner
markers to work around those refusals. Do not mount a live desktop profile.

The image targets Linux amd64, Node 24.19 and Python 3.11. Runtime Python wheels
are hash-locked in `server/requirements-lock.txt`; regeneration uses
`scripts/packaging/build_host_lock.py`. Both Node base references are pinned to
the verified OCI digest in `Dockerfile` (checked 2026-09-08). Debian package
resolution still prevents a full reproducibility claim; qualification records
the resulting application image digest and SBOM. The build context uses a positive source allowlist. No model weights,
installed plugins or user profile is copied into the image.

Container loopback is not host loopback. The example uses
`host.docker.internal` with Linux `host-gateway`; a model bound only to host
127.0.0.1 may require an operator-approved private listener/firewall change.
Compose peers can use service DNS. Jenny does not alter model listeners, start,
stop, unload or kill externally owned models. Missing models leave history/login
available and inference unready. See [Docker networking](https://docs.docker.com/engine/network/).

## Browser and transport behavior

API v1 is a closed service vocabulary in `server/api-contract.js`, not an IPC
proxy. The login page and its static bundle are public; APIs, SSE, attachments,
artifacts, exports and previews require authentication. Private HTTPS sets a
Secure, HttpOnly, SameSite=Strict `__Host-jenny` cookie. Explicit localhost HTTP
sets a host-only HttpOnly, SameSite=Strict `jenny-localhost` cookie without Secure;
both have Path=/ and retain exact Host/Origin/CSRF checks. Cookie policy comes
from validated server mode, never a forwarded header. Scrypt password verification is
serialized. Up to 16 owner login sessions have seven-day
idle and 30-day absolute expiry. Device management lists/revokes those sessions.
Revocation removes clients/control and fences asynchronous responses. CSRF is
required for mutations; browser credentials and transcripts are not persisted in
localStorage. Tabs obtain a public client ID and private client token, sent in
headers with CSRF. Tokens never appear in SSE URLs. Cookie plus CSRF validation
on active mutations refreshes the idle window, with durable writes throttled to
once per minute. Registration and logout POSTs carry no request body.

Client registration is bounded at 32 globally and eight per login session. New
credentials have a ten-second admission grace; valid use refreshes that grace.
Capacity pressure reclaims the oldest eligible disconnected registration while
preserving attached clients. SSE close alone does not revoke in-flight authority.

All authenticated devices can observe sessions. One tab holds a transferable
60-second control lease and heartbeats every 15 seconds. Takeover changes its
generation; stale sends, cancels, approvals and answers are rejected. Hidden
tabs suspend heartbeats and recover on focus/visibility or after SSE reconnect
and snapshot refresh. Expired leases are reacquired without takeover; another
controller retains ownership. Delayed responses cannot resurrect stale control.
Only one foreground inference turn is admitted globally. Busy rejection precedes canonical
user append. Disconnect or takeover does not cancel an admitted turn. Cancellation
and terminal UI follow backend acknowledgement, not optimistic local settlement.
Cancel acceptance reports `awaiting_settlement` at acknowledgement time; exact
receipt retries reproduce that result, while terminal events and snapshots show
current settlement. The bounded retry record remains tied to device, client and
control generation.
Approvals bind exact live session/stream/request/revision and are one-off; there
are no persisted blanket browser approvals. Pending decisions survive a browser
reconnect; host restart interrupts work and clears live decision/control authority.

SSE uses one connection per tab, monotonic cursors, 2 MiB/two-minute replay per
stream, 16 MiB total replay and 1 MiB slow-client queues, with at most 32 clients.
A gap or new boot requires a canonical snapshot. Request IDs bind durable receipts
to login identity and exact payload; settled receipts expire after 24 hours (cap
10,000). Pending receipts do not expire into automatic replay. After ambiguity,
`requests.status` reconciles the receipt; the browser must not resubmit a mutation
with a new ID automatically. One in-memory mutation slot is reserved before
sending. Timeout, lost connection, malformed reply or a nonauthoritative retryable
gateway failure retains the original envelope. **Check request** reads its receipt:
settled restores the result; unknown retries that exact envelope; pending or
indeterminate keeps changes blocked. Reads and control lease operations remain
available. Sign-in changes discard replay authority and require reviewing history
and reloading before a new change. Recovery preserves newer drafts/attachments
and does not apply an old conversation's send result to a newly selected one.
Per-session mutation serialization preserves expected-revision conflicts through
backend acknowledgement. Settled receipt TTL applies during lookup as well as
new admission. Ordinary browser requests, uploads and downloads have a 90-second
deadline covering response consumption; reconnect backoff includes bounded jitter.
Current-generation 401 responses invalidate credentials and pending UI generations.

Eight selected attachments may include at most four images (5 MiB combined,
4 MiB each) plus UTF-8 text (1,000,000 bytes each, 12,000 prepared characters each,
40,000 combined). Image staging checks type/signature; the canonical decoder
validates the complete image when sent. Text truncation is disclosed. Staged data
is device-bound and expires after 24 hours; referenced text/image bytes remain
managed assets. Full message/download routes require canonical session references.
Generated artifacts resolve through the existing artifact owner and are bounded
to 10 MiB. HTML/SVG previews use an opaque sandbox and restrictive CSP with scripts,
forms, network and same-origin privileges disabled. Downloads use authenticated
bytes, never browser-supplied server paths.

Snapshot refreshes buffer at most 256 live events/1 MiB in the browser. A stale
response cannot replace newer events or another conversation. A failed refresh
blocks new sends and offers **Reload conversation**; cancellation remains routed
for an admitted turn. Buffer overflow closes the stream and requires canonical
recovery. A sleeping browser with an expired client registration re-registers
under its still-valid login, then restores the session list and snapshot.

## Persistence, import, backup and upgrades

Named `jenny_profile` and `jenny_workspace` volumes are independent. The
`jenny_control` volume contains the private worker controller key and bounded
last admission/result metadata. Preserve it with the profile admission receipt;
neither receipt is a conversation store. Never delete either in isolation to
bypass uncertain cleanup. The guided
`compose.host.easy.yml` deployment also has `jenny_config` and `jenny_secrets`
volumes under the fixed `jenny-host` project; back up configuration with the
profile/workspace and protect credentials separately. A version-1
`.setup-pending.json` in the config volume blocks startup after an interrupted
configuration/key update. Stop Jenny and rerun the wizard; never delete the
marker to bypass revalidation. Profile
contents include canonical split sessions (schema 20), journal, shadow/repair,
attachment bytes, auth/receipt metadata, shell configuration and the bounded
sidecar-owned memory database. The latter is not conversation history. Browser
history/cache and Python request state are not backups. Optional config-v1
`runtime_home` defaults to `jenny-host-runtime` under the OS temporary directory
(`/tmp/jenny-host-runtime` in Docker). HOME/XDG caches stay there, outside the
profile, secrets and workspace; they are disposable and excluded from profile
backup. The canonical memory database remains in the profile. Native hosts may
bind `127.0.0.1` or `::1` behind private HTTPS; containers bind `0.0.0.0`.
Workspace selection is
explicit; null blocks file tools. See [Docker volumes](https://docs.docker.com/engine/storage/volumes/).

For conversation-only migration, export a Jenny portable archive v1 from the
source, keep it unchanged, mount it read-only at `/backup`, and run the stopped
host CLI `import-conversations --archive /backup/source.archive --config
/etc/jenny/host.json` using the same `--entrypoint node ... server/cli.js` pattern.
The passphrase is prompted, never supplied in argv/environment. Import accepts a
fresh canonical and shadow store, rejects malformed UTF-8 bytes, preserves
session IDs and restores embedded images through
existing migration owners. Bounds: 1,000 archive entries/256 MiB total, 128 sessions,
16 MiB per session. The result reports skipped non-conversation categories. It
does not restore workspace paths, preferences, credentials or a full host profile.
Legacy text metadata without embedded bytes remains unavailable, never silently
read from an old desktop path. Host text bytes require full-volume backup.

Import writes a pending receipt before any canonical mutation and marks completion
only after flush. An exact completed retry returns its receipt; changed source
conflicts. A partial import blocks startup and automatic retry. Preserve the failed
profile for diagnosis, create a fresh stopped profile and retry the unchanged source;
never delete the pending receipt to resume partially applied imports. Staging
cleanup failures emit `host.import_staging_cleanup_failed` without paths and
retry a bounded set of validated host-created staging directories on later
import attempts. Legacy inline text downloads use the existing text-size bound
and prefer managed attachment bytes when present.

Full backup procedure: stop admission, then stop `jenny` and `sandbox` (Compose
orders the dependent app first). Require confirmed clean shutdown, then take an
offline snapshot of profile, selected workspace, configuration and control
volumes together. A pending admission requires reconciliation before making a
clean backup; preserve failed snapshots for diagnosis, never clear their markers. A stopped Python process closes SQLite;
include the entire database directory and any WAL/SHM files in the snapshot. Record
image digest, config/schema versions, volume identity and checksums. Back up keys
separately with restricted encryption/access. Do not prune conversations to meet a
backup quota. Restore into new stopped volumes, retain the original backup, verify
checksums/ownership and canonical history, re-provision secrets, rebind workspace
roots, and revoke old browser sessions before exposing the restored host.

Upgrade only after a verified backup and a canary restore. Pin the qualified image
digest. Existing canonical migration owners run the forward upgrade and refuse
future schemas. Rolling back requires the prior compatible data snapshot as well
as the prior image; never run an old image against already-upgraded live data.
One profile has one writer throughout backup, migration and rollout.

## Operations and release gates

Application Compose defaults: 2 CPUs, 2 GiB RAM, 256 PIDs, 256 MiB temporary filesystem,
read-only rootfs, UID/GID 10001, all capabilities dropped and no-new-privileges.
The sandbox separately has 2 CPUs, 2 GiB RAM without swap, 128 PIDs, no external
network and bounded disposable tmpfs mounts. It runs a trusted PID-1 supervisor
with only SETUID/SETGID before dropping job privileges; see HOSTED_EXECUTION.md.
Compose precreates it even with execution disabled; cgroup v2 is therefore a
prerequisite for both profiles. The app mounts worker control read-only. The
30-second app stop grace allows the broker to cancel and confirm namespace
recycling before profile release; ambiguous shutdown retains its admission.
Compose probes readiness with `node server/healthcheck.js --config
/etc/jenny/host.json --ready`. An unhealthy status is an operator/proxy signal:
Docker restart policies react to process exit and do not restart a process only
because its healthcheck fails. See the [restart policy contract](https://docs.docker.com/engine/containers/start-containers-automatically/)
and [healthcheck reference](https://docs.docker.com/reference/compose-file/services/#healthcheck).
Service and deploy PID limits both specify 256, as required by the
[Compose consistency contract](https://docs.docker.com/reference/compose-file/services/#pids_limit)
(checked 2026-09-08).
New sessions/sends/edits and uploads fail admission below a 256 MiB filesystem
reserve; history, cancellation and decisions remain routed. This is a reserve,
not a volume quota: enforce disk quotas at the host and monitor free space.
Docker stdout logs rotate at 3 x 10 MiB. Existing sidecar diagnostics retain their
canonical rolling budgets (5 MiB segments, 50 MiB/layer, 200 MiB global, 14 days);
turn diagnostic dumps use seven days/100 MiB plus existing count limits. Do not
collect raw keys, cookies, prompts or provider bodies into operational exports.
`/healthz` is liveness; `/readyz` requires the current sidecar's policy and engine
acknowledgement, including streaming/cancellation transport support. Structured logs carry boot/request/stream correlation where
applicable. Alert on repeated readiness failure, disk pressure, incomplete import,
uncertain shutdown, write failure and authentication failures. Worker receipt
logs use job IDs and bounded reasons (`host.sandbox_admitted`, `_settled`,
`_blocked`, `_recovered`); they never log commands, model keys or captured output.
`bootstrap.tools.execution` reports enabled/available/busy, disposable workspace
and offline-network capability. Doctor probes the real worker when configured.

Required qualification: `npm run build:browser`, `npm run test:host`,
`npm run test:host:browser`, focused
Python policy/descriptor tests, desktop seam regressions and contract checks;
then `.github/workflows/hosted.yml` on Linux and a real image build/run. The
workflow runs `bash scripts/packaging/smoke-host-container.sh jenny-host:ci`: a
fresh named volume, interactive owner CLI, actual image entrypoint, readiness,
login, authenticated bootstrap and one SSE frame. Readiness proves the sidecar
and hosted-policy acknowledgement; inference model loading remains lazy.
The separate browser test uses provisioned Playwright Chromium, two isolated
contexts, a local HTTPS proxy and the real replay sidecar. It does not launch
Electron or use the owner profile. Install Chromium in CI with the repository
Playwright CLI; Windows certificate setup requires PowerShell 7, Linux OpenSSL. Confirm
fresh-volume bootstrap, profile-lock exclusion, graceful/forced stop, durable
restart, encrypted import rejection, full snapshot restore and schema rollback.
Exercise two independent browsers through real private HTTPS: simultaneous sends,
control takeover during approval, reconnect/replay gaps, cancellation, revocation,
mobile sleep and host restart. Run the owner-authorized Electron GUI smoke/manual
regression gate separately. Measure resource limits under stream/upload pressure.
Do not publish an image or deploy until these gates pass.
