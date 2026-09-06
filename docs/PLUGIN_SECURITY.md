# Plugin Security & Trust Model

## Plugin Catalogs and MCP Trust

Date: 2026-08-17

This runbook covers Jenny's verified plugin catalog workflow and standalone MCP
connection trust review. Electron owns both durable configuration surfaces;
the renderer receives bounded identities and evidence, never catalog URLs,
local paths, pinned-root bytes, credentials, or safeStorage values.

### Plugin catalogs

Jenny ships with no hosted catalog endpoint or trust root. A fresh profile
therefore reports **No catalog configured** successfully. Remote sources may be
added only by app configuration with a pinned TUF root. Offline mirrors are
added through the native directory picker, then require a main-process review
of the sanitized mirror name and root fingerprint before Jenny pins the root.

Catalog sources use schema v1. Each source binds a source id, kind, display
name, root fingerprint, and pinned root. Electron-only source data contains the
remote metadata/target endpoints or resolved offline root. Public catalog rows
contain only publisher id, plugin id, display name, version, summary, package
size, and package digest. One invalid or unavailable source produces a bounded
failure row without suppressing valid sources.

Refresh verifies the pinned TUF chain, target metadata bounds, and signed
advisories before publishing entries. Advisory revocation may automatically
quarantine an installed plugin. Renderer code cannot force-release quarantine;
recovery is limited to a verified non-quarantined update, safe recovery retry,
or uninstall.

Install, update, rollback, and recovery use the existing immutable-generation
transaction. Expected-generation, publisher trust, managed policy, advisory,
data rollback barriers, retention, and cancellation remain authoritative.
Signed local packages remain available under **More** as an Advanced source;
equal, lower, or untrusted selections fail closed.

### Standalone MCP configuration

`mcp-servers.json` schema v1 stores `enabled` plus a trust record for each stdio
or gated-SSE server. The trust record binds the normalized configuration digest,
advertised-tools digest, review status, and review timestamp. Credentials remain
referenced through `secret_ref` and stored with Electron `safeStorage`.

Migration behavior is deliberately asymmetric:

- a missing file becomes an empty current configuration;
- valid legacy rows are preserved, atomically rewritten disabled, and marked
  pending review without changing `secret_ref` or safeStorage ciphertext;
- malformed rows, duplicate identities, plaintext secret fields, unknown lossy
  fields, and future schemas preserve the original bytes, enter read-only
  remediation, and forward no standalone server to the sidecar;
- writes use staged replacement, fsync, rename, and post-write verification;
  failed writes retain the previous effective configuration.

### Trust review and drift

Testing a server calls the versioned, one-shot `mcp.inspect` JSON-RPC request.
It never publishes tools into the live catalog or owns durable sidecar state.
Stdio inspection requires confirmation of the exact command and arguments.
SSE inspection retains the existing transport flag, network ceiling, SSRF,
DNS, and private-address policy. Results expose only sanitized identity,
transport, bounded tool names/descriptions/schema digests, aggregate tools
digest, latency, and a structured failure.

Approval binds the inspected tool digest to the current configuration. Only
enabled and approved rows are forwarded during normal sidecar initialization.
If a server later advertises a different material tool surface, the sidecar
refuses registration with `CMP-MCP-0009`; Electron then disables the row and
returns it to pending review. Editing a row also invalidates trust. Timeout,
shutdown, or probe failure closes probe-owned transports and processes and
returns bounded unavailable/failure state without credentials.

Plugin-declared remote or native MCP remains part of the signed plugin
generation and is reviewed in that plugin's detail drawer. It is never copied
into `mcp-servers.json`.

### Operator checks

1. Confirm catalog source fingerprints out of band before trusting them.
2. Review the exact stdio launch or remote identity and the complete bounded
   tool list before approval.
3. Treat a new pending-review state as configuration or tool-surface drift,
   not as a transient enablement failure.
4. Use Diagnostics for plugin platform revision/recovery evidence. Use the
   Plugins & Extensions overflow menu for the bounded redacted audit export.
5. Preserve read-only/future files for a newer Jenny version or deliberate
   manual remediation; do not downgrade or normalize them in place.

## Plugin Restricted Host

Stage 6 runs signed V4 restricted contributions in a separately packaged Jenny
Rust helper. Electron remains the authority and final gateway. The helper links
Wasmtime 47.0.3 without WASI and receives only the frozen
`jenny:plugin/restricted-host@1.0.0` capability ABI.

### Runtime boundaries

- Helper identity, target, commit, binary digest, protocol digest, ABI digest,
  and Wasmtime version must match the packaged manifest before spawn.
- Spawn uses no plugin-derived argv, a scrubbed environment, ignored
  stdin/stdout, bounded stderr, a non-workspace cwd, and authenticated local
  transport. Exact verified component bytes are streamed by Electron.
- Guest linear memory is capped at 64 MiB. The helper process is capped at
  128 MiB by a Windows Job Object or a macOS working-set watchdog.
- There is one active invocation per helper. Queue, stream, frame, result,
  token, deadline, restart, and retention limits come only from
  `config/plugins/stage6-budgets.json`.
- No filesystem, environment, socket, DNS, subprocess, stdio, wall-clock, or
  random capability is linked into the guest.

### Brokers and cancellation

Network and secret operations are Electron broker calls with exact,
use-counted tokens. Network authority is limited to approved HTTPS origins and
the existing SSRF/redirect/response ceilings. Secret values never enter the
guest; a five-second one-use handle authorizes Electron to apply a credential
inside an already authorized broker operation.

Cancellation is kill-first: Electron aborts broker work, terminates the helper,
and gives cancellation precedence over a racing success terminal. The kill
starts immediately under the 250 ms guest-cancel ceiling and must settle within
the one-second host bound. `control.cancelled` is reserved in ABI V1 but is not
claimed as a graceful Stage 6 delivery mechanism.

### Failure and recovery

Missing, corrupt, wrong-target, wrong-version, or unattested helpers block only
restricted contributions. Local chat, V1/V2 declarative plugins, and V3 remote
MCP remain available. Unexpected exits use 100 ms, 500 ms, and 2 second restart
delays; three crashes in ten minutes open the circuit and request durable
quarantine. Quarantine never auto-reactivates.

The native package picker sends every signed package through the evidence-bound
distribution transaction. V4 packages are committed as generation schema 4
with their verified restricted-module digests; the legacy local installer
continues to reject restricted contribution kinds. Store recovery completes
after selection and verification but before a detached distribution receipt is
minted, so a first state query cannot misclassify a live install as an orphan.
Shutdown aborts and awaits detached distribution work before releasing the
store.

Diagnostics are bounded and redact sensitive keys, secret-looking values,
URLs, and local paths. Never copy raw component bytes, credentials, package
paths, plugin inputs, or broker payloads into an incident record.

### Verification

Use `cargo test --manifest-path restricted-host/Cargo.toml --locked`, the
focused tests under `tests/plugins/restricted-host/`, the Stage 6 contract,
budget, boundary, release-compatibility checks, and the packaged-flow smoke.
`real-host-process.test.js` runs the packager's exact embedded component when
`JENNY_RESTRICTED_HOST_BINARY` names the built helper. The authorized control
plane GUI gate is `plugin-control-plane.smoke.js`; the externally signed V4
proof is `plugin-restricted-contribution.smoke.js` with
`JENNY_STAGE6_SIGNED_PACKAGE` set as documented in
`plugin-signing-root.md`. Private signing material never enters either test.

## Privileged plugin full-host operations

Stage 8 adds V6 native MCP, session-provider, engine-adapter, and hook
contributions. They are trusted native applications supervised by Jenny, not
sandboxes: after explicit delivery, native code can copy a secret or use the
signed-in user's files and network access. Plugin bytes never load in Electron
or the Python sidecar. Electron owns the committed generation, consent,
safeStorage secret source, receipts, cleanup evidence, and reverse-RPC gateway;
the Rust supervisor is the separate least-authority process owner.

### Enablement and rollback

`privileged_plugins` is independently default-off. Set
`JENNY_ENABLE_PRIVILEGED_PLUGINS=1` only for an owner-approved V6 conformance
run. `JENNY_ENABLE_PRIVILEGED_PLUGINS=0` is the immediate kill switch and does
not disable Stage 1-7 plugins or local chat. Disabling the flag prevents new
privileged authority; startup cleanup still reconciles previously owned process
trees. V1-V5 stores remain readable. A Stage 7 binary sees retained V6 state as
future and read-only; V7 and newer remain the Stage 8 forward-compatibility
freeze.

### Managed-policy ceiling

Stage 9 adds a machine-admin ceiling above every V6 privilege. A valid
`privileged_execution: deny`, an invalid/unreadable present policy, corrupt
policy high-water state, or a failed policy-state write blocks new publication
immediately. Pending launches, engine streams, hooks, consent receipts, direct
secret grants, and active host sessions recheck the captured policy revision
and are cancelled/revoked when it changes. A later allow policy requires fresh
generation/epoch authority; it cannot revive the old four-field authority.

The feature flag remains an independent lower ceiling. Cleanup can truthfully
settle as `termination_failed` or `pending_restart`, but those states never
restore logical authority or block ordinary local chat. Source deployment,
bundle fields, audit behavior, and recovery procedures are documented in
[Plugin managed policy](#plugin-managed-policy) below.

### Admission and trust window

Only current-key, pretrusted, signed V6 archive entries can materialize an
executable object. Jenny hashes the verified archive bytes into immutable
storage and the native supervisor reopens and identity-locks the exact image
through suspended launch and Job Object attachment. The isolated Jenny Trust
Window is single-instance, sandboxed, nonpersistent, main-frame and exact-file
bound, and denies navigation, popups, downloads, permissions, and remote
requests. Closing, timing out, crashing, reloading, or superseding it denies the
operation. Renderer input never supplies authority or approval metadata.

Every launch receipt binds publisher/plugin/contribution, artifact and
executable digests, the exact four-field V6 authority, process/session identity,
launch nonce, containment profile/capabilities, peer identity, and time. Native
MCP descriptors are immutable generation state and never enter user-authored
`mcp_servers`; each call rechecks the current session epoch and launch receipt.

### Bounds and failure behavior

The default limits remain the Stage 8 posture, now materialized as
`default_full_host_v1` in `config/plugins/workload-profiles-v1.json`: a
16-process tree cap, 2 GiB process/job memory caps, and a 75% CPU hard cap.
Electron additionally enforces two full-host
sessions globally, one per plugin/contribution, five-minute idle eviction, and
a one-hour absolute lease. Each authenticated host operation refreshes only the
idle timer; it never extends the absolute lease. Native streams, discovery, hook queues, direct-secret
grants, diagnostics, and stderr are separately bounded by that ledger.

The exact current-key official identity
`jenny-official/local-image-generation:local_image_generation` on Windows x64
receives the separately frozen `gpu_image_v1` profile: 192 processes, 32 GiB
per-process and 48 GiB job memory, 90% CPU, a five-hour absolute lease, and a
30-second forced-termination proof. Those are runtime-enforced. The same frozen
profile declares a four-hour provisioning qualification deadline, 64 GiB
retained and 96 GiB transient data qualification budgets, and 60 GiB free-disk /
16 GiB total-VRAM / 14 GiB free-VRAM plugin preflights. The package builder
checks the signed runtime manifest and static data floors against those values;
the host performs the hardware/disk preflights. No display name or plugin-authored field can select that profile;
the current publisher key, full contribution identity, platform, and
architecture must match `official-workload-bindings-v1.json`. Qualification
stops for profile review if a measured peak reaches 80% of a hard cap.

Session-provider calls are renderer-bound through the existing V5 view bridge,
then resolved from the schema-v18 persisted session binding. The plugin payload
cannot name a session, provider, generation, or host. Long operations start
quickly and are polled; every terminal path terminates the full supervised job.
Cancellation during launch waits for the pending host result and proves the late
process tree empty before persisted settlement or exclusive-GPU release.
Only the native `tree_empty` receipt can release an exclusive GPU lease.

All privileged failures are fail-closed and return bounded `CMP-PLUGIN-*`
diagnostics. Plugin-engine failure never selects Mock or a fallback model.
Ambiguous publication keeps privileged admission fenced and reconciles to the
durable pointer; it never restarts the whole sidecar under an active core turn.
Ambiguous invocation is terminal unless a fixed hook descriptor explicitly
permits one definitely-not-dispatched replay.

### Secrets

Secret values are stored only by Electron `safeStorage`. A direct-delivery grant
binds the safeStorage source fingerprint, destination artifact/session,
generation, purpose, policy, nonce, and expiry. The grant is atomically spent
before bytes cross a dedicated inherited pipe; the value is absent from generic
JSON-RPC, argv, environment, normal stdin/stdout, disk, renderer IPC, and
diagnostics. A lost or malformed receipt remains spent and forces session-tree
termination. Full-host approval never authorizes secret delivery.

### Cleanup and incident response

Unproven tree death is not success. Jenny retains session accounting and writes
`runtime/full-host-cleanup-v6.json`; crash-loop state is bounded and persisted in
`runtime/full-host-crash-quarantine-v6.json`. On restart, cleanup runs even when
the feature flag is off. Quarantine clears only after a verified executable
upgrade or explicit owner repair.

For an incident:

1. Set `JENNY_ENABLE_PRIVILEGED_PLUGINS=0` and restart Jenny.
2. Confirm Plugin Manager reports privileged runtime cold/disabled and cleanup
   is `complete`; `termination_failed` means the owned tree is not proved dead.
3. Do not delete cleanup/quarantine records or immutable executable objects.
   Preserve logs and the redacted receipt identifiers for diagnosis.
4. If cleanup remains unproved, terminate the positively identified process
   tree outside Jenny, restart, and allow cleanup reconciliation to settle it.
5. Re-enable only after signature, executable digest, generation, policy, and
   quarantine evidence have been reviewed.

### Verification commands

Use bounded runs only:

```powershell
.\.venv\Scripts\python.exe scripts\checks\check_plugin_contract_freeze.py
.\.venv\Scripts\python.exe scripts\checks\check_plugin_stage_boundary.py
node scripts\run-node-tests-safe.js tests/plugins/full-host/*.test.js tests/plugins/native-mcp/*.test.js tests/plugins/engine-adapter/*.test.js tests/plugins/hooks/*.test.js
cargo test --manifest-path native\plugin-full-host-supervisor\Cargo.toml
```

Packaging builds and verifies `build/plugin-full-host-supervisor` through
`npm run build:full-host-supervisor`; `scripts/packaging/smoke_packaged_flow.py`
checks the packaged binary, manifest, source commit, V6 lock digest, and private
authenticated-pipe provenance.

The fixed owner-signed V6 archive is accepted with the bounded development and
packaged commands in `docs/operations/plugin-signing-root.md`. Use
`JENNY_STAGE8_SIGNED_INSTALL_ONLY=1` for production intake/rehydration without
native execution; removing it is a distinct owner-authorized privileged gate.

Stage 8 owner acceptance completed on 2026-08-10 with package SHA-256
`5d2e14401786c9337a9e19468b74d239021ce2e738b4c4734b83ea5f9012cff3`.
The signed development flow covered native MCP, plugin-host engine output,
safeStorage-backed one-shot synthetic secret delivery, and disable cleanup.
Native Windows drills covered cancellation, three-crash quarantine, explicit
verified-repair release, named-Job restart cleanup, and tree-empty reap. The
packaged activation/restart/disable flow also passed. No production credential
or external side effect was used.

## Plugin managed policy

Jenny's Stage 9 policy is a local machine-administration boundary. It does not
require a tenant, hosted service, device inventory, SSO, RBAC, or network
connection. Electron owns source discovery, verification, durable high-water
state, enforcement, audit projection, and user-visible status. The Rust
full-host supervisor remains the process owner; policy only constrains whether
privileged authority may be published or retained.

### Administrator source

Jenny checks one fixed, machine-scoped source for a UTF-8 JSON bundle:

| Platform | Source | Operational posture |
|---|---|---|
| Windows | `HKLM\SOFTWARE\Policies\Jenny`, string value `ManagedPolicyBundle` | Computer policy; read with `reg.exe` without a shell |
| macOS | managed preference domain `com.jenny.shell`, key `ManagedPolicyBundle` | Device-channel Managed Preferences; read from `/Library/Managed Preferences` |
| Linux development | `/etc/jenny/managed-policy.json` | Root-owned regular file; group/world writes and symbolic-link traversal are rejected |

Windows places computer policy beneath `HKEY_LOCAL_MACHINE\Software\Policies`,
matching Microsoft's registry-policy convention. macOS uses an application
preference domain in the Managed Preferences payload described by Apple. The
exact source identifiers are packaged in
`config/plugins/managed-policy-defaults.json`; source values and local paths are
never returned through plugin IPC, diagnostics, Settings, or audit export.

References: [Microsoft Administrative Template format](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/policy/administrative-template-file-format),
[Apple ManagedPreferences](https://developer.apple.com/documentation/devicemanagement/managedpreferences).

### Bundle contract

The source value is a `managed_policy_bundle_version: 1` envelope containing an
exact-key `policy` object and an Ed25519 signature record. The public key is
part of the administrator-controlled machine artifact and is not a Jenny plugin
publisher key. The source's machine-administrator access control is the trust
anchor; the signature supplies portable corruption and integrity evidence.

The signed policy carries:

- a positive monotonic `revision`, issue/expiry timestamps, and a maximum
  366-day validity window;
- `privileged_execution: allow|deny` and `installation: allow_inactive|deny`;
- `update_ring: stable|preview|frozen`;
- bounded allowed source kinds, publishers, and exact source-identity SHA-256
  fingerprints;
- required signed SBOM/build-provenance presence and an audit export cap.

The serialized bundle is capped at 256 KiB. Unknown keys, unsupported versions,
invalid timestamps, malformed base64/key binding, invalid signatures, expired
bundles, and out-of-range arrays or integers fail closed for plugin privilege.

### Precedence and runtime behavior

The enforcement order is:

1. Jenny hard safety invariants and feature kill switches.
2. Valid machine policy ceilings.
3. Existing user/global/workspace grants, which can only narrow authority.
4. Signed plugin manifest requests, which never grant themselves authority.

No source means the existing unmanaged local behavior is preserved. A present
but invalid/unreadable policy, corrupt policy state, or failed state write
blocks privileged execution and plugin mutations without blocking Jenny
startup or ordinary local chat. A lower source revision is rejected as a
downgrade; a different payload at the same revision is rejected as
equivocation. Removing a valid policy returns to unmanaged behavior but retains
the revision/digest high-water so an older bundle cannot later be replayed.

Policy changes are live. New privileged work is fenced synchronously, and
pending host launch/descriptor probes, native MCP calls, provider work, engine
streams, hooks, approval receipts, secret grants, and host sessions recheck the
captured policy revision across asynchronous boundaries. Old four-field runtime
authority is tombstoned; a policy change cannot revive A through an A -> B -> A
cycle without a new generation/epoch. Cleanup is best effort and truthful:
`termination_failed` and `pending_restart` never restore logical authority.

Install/update/downgrade operations capture the policy revision, recheck it
before commit, bind the current policy reference into the generation, and
enforce publisher, source identity, and signed procurement metadata after the
package verifier identifies the actual candidate. Security catalog refresh may
continue while mutation is blocked. Rollback revalidates current trust, policy,
advisories, and data barriers and never reuses historical policy authority.

### Recovery and disaster-recovery posture

State is an internal `ManagedPolicyStateV1` document under the Electron-owned
plugin store and uses the standard staged-write, fsync, atomic-rename recipe.
It records only bounded revision/digest/status/provenance facts. The policy
bundle itself remains in the OS-admin source and is not copied into user data.

For same-machine recovery, restore plugin package/cache data only after the
machine policy has been restored. Jenny re-verifies packages, publisher trust,
current policy, advisories, and data barriers before rollback or activation.
For cross-machine restore, plugin code may be restored only as disabled data;
machine policy, grants, safeStorage ciphertext, consent receipts, runtime
authority, and source identity are nonportable and must be re-established
locally. A corrupt high-water record deliberately blocks plugin mutation until
an administrator repairs or removes the plugin store state and then supplies a
valid current policy. This does not block core startup.

### Audit and troubleshooting

The plugin detail drawer shows only bounded policy effects relevant to that
plugin. Platform stage, store, recovery, policy revision, and distribution
revision evidence live in Diagnostics. Audit export remains available from the
Plugins & Extensions overflow menu; it includes the same atomic summary and
clamps entry count to the stricter of the caller request, policy cap, and 1000.
It never includes the raw bundle, public key bytes, source value, local source
path, package path, prompt, secret, or provider payload.

Useful reason codes include:

- `managed_policy_absent`: unmanaged defaults are active.
- `managed_policy_active`: a valid allow policy is active.
- `managed_policy_privileged_denied`: the active policy prohibits privilege.
- `managed_policy_downgrade_blocked` / `managed_policy_equivocation_blocked`:
  revision protection rejected the source.
- `managed_policy_state_corrupt` / `managed_policy_state_write_failed`:
  durable authority cannot be proved, so plugin mutation and privilege are
  fenced.

The source is polled every 30 seconds. Restart is not required for revocation.
Jenny intentionally provides no UI or IPC operation that writes machine policy.
