# Plugin Security & Trust Model

## Surviving plugins and standalone MCP trust

Reviewed: 2026-10-03 (catalog and plugin-MCP parts retired 2026-10-02)

This runbook covers Jenny's standalone MCP connection trust review and the
retirement notes for the plugin surfaces that used to sit beside it. What
remains of the plugin platform is local-file declarative packages (`skill`,
`prompt`, `theme`, `settings_schema`), sandboxed `panel`/`artifact_renderer`
views, the opt-in developer profile and enable/disable/uninstall. Electron owns the
durable configuration surfaces; the renderer receives bounded identities and
evidence, never local paths, credentials, or safeStorage values.

The platform defaults on; `JENNY_ENABLE_PLUGINS=0` disables it. Unsigned intake
defaults off and requires `JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE=1`. Its fallback
skips publisher lookup and Ed25519 verification only after an untrusted-publisher
result, keeps all structural/digest/budget checks and reserves configured publisher
identities. With the flag off, installed unsigned packages remain listed but
ineligible. V1/V2 activation is first-party/current-key, permissionless and
dependency-free; V3 admits permissionless skills/prompts. Intake does not prove
activation eligibility. No official package is bundled.

Views use digest-bound packaged assets, a deny-all permission policy and
`connect-src 'none'`. Their fixed bridge supplies bounded context/settings and
artifact operations. Accepted frozen permission names do not restore a network
broker or expose secret values. Provider bridge operations are rejected at content
validation; ChatGPT authentication is now core-owned.

### Plugin catalogs

Retired 2026-10-02 (plugin platform retirement stage 4). Verified catalogs,
offline mirrors, TUF-backed refresh, catalog advisory quarantine, rollback and
the plugin network broker are deleted. Jenny shipped no catalog endpoint or
trust root, so no user had a source. Install and update go through the native
package picker or validated drag-and-drop local-file path; signed packages use
publisher trust and unsigned packages require the developer profile above. Equal
or lower versions and untrusted selections without that profile
fail closed, and a request for any other source kind (git,
https_url, catalog) fails closed without network access. The immutable
generation transaction, expected-generation checks, publisher trust, retention
and cancellation remain authoritative for local installs.

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

Plugin-supplied MCP (remote or native) is retired (2026-10-02, plugin platform
retirement stage 4): a plugin can no longer contribute an MCP server, so the
standalone manager above is the only MCP trust path and `mcp-servers.json` is
its sole store.

### Operator checks

1. Review the exact stdio launch or remote identity and the complete bounded
   tool list before approval.
2. Treat a new pending-review state as configuration or tool-surface drift,
   not as a transient enablement failure.
3. Use Diagnostics for plugin platform revision/recovery evidence. Use
   Settings > Plugins & Extensions > Advanced > Export audit log for the bounded
   redacted audit export.
4. Preserve read-only/future files for a newer Jenny version or deliberate
   manual remediation; do not downgrade or normalize them in place.

## Plugin Restricted Host

Retired 2026-10-02 (plugin platform retirement stage 4). The restricted (Wasm)
tier never shipped: its Electron host, the Rust/Wasmtime helper, the broker and
packaging are deleted. Installed leftover V4 packages still parse and reverify
(`services/plugins/package/restricted-content-validator.js`), but their
restricted contributions are inert, a new package declaring one is refused, and
enabling a leftover returns `POLICY_BLOCKED` with `contribution_kind_retired`.
The frozen capability ABI and contract locks stay in place so older stores
still read.

## Privileged plugin full-host operations

The privileged (full-host) plugin tier was retired on 2026-10-02 (plugin
retirement stage 4); it never shipped. V6 native MCP, session-provider,
engine-adapter, hook and full-host contributions are inert: they are never
compiled into a runtime snapshot, never launched, and an install or enable that
needs one is refused. The `privileged_plugins` flag is gone; a stored override
is dropped on load and `JENNY_ENABLE_PRIVILEGED_PLUGINS` is accepted and
ignored until 1.2.2. Plugin bytes never load in Electron or the Python sidecar.

Startup removes the tier's leftover state once, never throwing and never
logging paths: `runtime/full-host-cleanup-v6.json`,
`runtime/full-host-crash-quarantine-v6.json`,
`runtime/secret-delivery-grants-v6.json`, `runtime/hook-outbox-v6.json` and
the `session-provider-staging/` directory under the plugin store root, plus any
`plugin_full_host:` secret in the secure store. Process receipts are dropped
without native proof: the Windows supervisor held its sessions in a
kill-on-close job object and in memory, and POSIX could never launch a host, so
no host process survives the app. Saved image-generation chats stay readable as
ordinary transcripts and can be deleted like any chat. The frozen V6 contract
schemas and locks stay in place so older stores still read.

Verification:

```powershell
.\.venv\Scripts\python.exe scripts\checks\check_plugin_contract_freeze.py
.\.venv\Scripts\python.exe scripts\checks\check_plugin_boundary.py
```

## Plugin managed policy

Managed (enterprise) policy was retired on 2026-10-02 (plugin retirement stage 4). Plugins have no enterprise policy source: Jenny reads no registry key, managed preference or policy file, keeps no policy state, and exposes no policy status call. Every install behaves as the former unmanaged install did, and stored generations keep their `policy_grant_ref` fields with the unmanaged values.
