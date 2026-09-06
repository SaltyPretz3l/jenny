# Plugin control plane (Stage 8 privileged adapters; default-off)

Electron-owned plugin-platform code lives here. Canonical architecture:
`PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md`;
domain manifest: `docs/manifests/plugin-system.md`;
completed execution program: `docs/archive/PLUGIN_PROGRAM_EXECUTION.md`.

Current stage posture (enforced by `scripts/checks/check_plugin_stage_boundary.py`
and `scripts/checks/check_plugin_boundary.py`):

- **Stage 7 is active by default with `JENNY_ENABLE_PLUGINS=0` as the emergency
  kill switch.** The sole
  Electron composition seam owns native-picker package distribution,
  recoverable V3 commits, network consent, loopback OAuth, remote HTTP MCP
  discovery/invocation, generation-bound sidecar descriptor publication, and
  the separately packaged restricted-host supervisor and brokers.
- Signed V4 packages may contain one bounded restricted contribution:
  `restricted_transform`, `restricted_formatter`, `restricted_renderer`, or
  `restricted_compute`. Electron streams verified component bytes into the
  no-WASI Rust/Wasmtime helper and retains all network, secret, tool, lifecycle,
  and settlement authority.
- Signed V5 packages may additionally contain digest-bound sandboxed views and
  provider descriptors. Jenny owns trust chrome, session policy, bridge
  vocabulary, provider authentication, credential storage, and runtime
  generation authority; plugin assets never receive credentials.
- Signed V6 packages are additive: legacy declarative, restricted, view, and
  provider contributions retain their Stage 1-7 semantics, while `native_mcp`,
  `session_provider`, `engine_adapter`, and `hook` contributions remain behind
  the independent default-off `privileged_plugins` gate. Electron owns their
  authority and the Rust full-host supervisor owns native process trees;
  privileged bytes never load here, in Electron, or in the sidecar.
- The official `jenny-official/local-image-generation@1.0.0` package uses that
  existing hybrid surface: one V5 sandboxed panel and one V6 session provider.
  Generic owners under `session-provider/`, `artifacts/`, `view/`, and
  `full-host/` bind persisted session identity, CAS state, GPU exclusion,
  artifact publication, attachment tickets, workload policy, and tree-empty
  cleanup. Image UI/provisioning/Python/worker/model code remains entirely under
  `plugins/official/local-image-generation/`.
- V1/V2 local packages remain compatible. Their first Stage-5 distribution
  mutation re-verifies exact stored bytes and promotes immutable identity,
  source-trust, advisory, and data evidence into the V3 generation; missing or
  rotated trust fails closed.
- Verified catalogs are the primary user workflow. Jenny configures no hosted
  endpoint by default; remote sources require an app-configured pinned TUF root,
  while offline mirrors require native selection and main-process fingerprint
  review before pinning. `catalog/` and `store/catalog-source-store.js` keep
  endpoints, roots, and real paths inside Electron and expose only bounded
  target identity, version, summary, size, and digest. One malformed source
  cannot suppress valid sources.
- External package and MCP traffic requires both plugin intent and a separately
  provisioned system network ceiling. Renderer consent never mints that ceiling.
- Remote tools remain namespaced and use the existing `tool.execute_electron`
  reverse bridge. Electron rechecks generation, provenance, consent, advisory,
  authorization, schema, and arguments on every invocation.
- **Stage 4B — bounded declarative activation.** Electron may activate only
  current-key `jenny-official`,
  permissionless, dependency-free V1 skill/prompt packages or V2 declarative
  theme, settings-schema, prompt, command, workflow, and inert MCP descriptors.
- `services/main/plugins-ipc-registration.js` is the sole main-process
  composition seam. Catalog installation is primary; the native package picker
  remains an Advanced source. Contribution toggles and typed settings updates
  use expected-generation CAS. No raw
  package path crosses IPC, logs, state, diagnostics, or audit.
- `CONTROL_PLANE_STAGE` is `8`; committed generations may persist only
  `installed_disabled`, `active`, `blocked`, or `quarantined`. Transitional `preparing`/`disabling` rows,
  future schemas, and corrupt state fail closed and block mutation.
- Enable, disable, active uninstall, restart rehydration, and recovery use one
  transactional coordinator. The active pointer cannot flip without exact
  sidecar attestation; ambiguous apply remains fenced until reconciliation.
- V1 overlays remain verbatim. V2 prompt substitution is exact single-pass;
  workflows are bounded DAGs interpreted by Jenny and may dispatch only
  positively marked read-only tools after digest, policy, and approval rechecks.
- Themes are scoped to `#chatView`; settings are typed/content-addressed.
  V6 full-host sessions, native MCP, engine adapters, and fixed lifecycle hooks
  are reachable only through generation-bound Jenny brokers when the privileged
  flag is enabled and high-consequence consent succeeds. Native MCP never
  becomes user-authored `mcp_servers`, and direct secrets use safeStorage plus
  one-shot destination-bound grants and a dedicated supervisor pipe.
- Standalone user-authored MCP connections are not plugin definitions. They are
  owned by `services/mcp-config-store.js` and
  `services/mcp-discovery-service.js`, require explicit tool-surface review,
  and appear beside plugins in Plugins & Extensions. Plugin-declared MCP stays
  generation-bound and appears only in the owning plugin's detail drawer.
- Plugin code is never imported into Electron main, the renderer, or the sidecar
  (architecture invariant 1); this tree is Jenny-owned control-plane code, not
  plugin code.
- Every file (production and test) stays ≤ 600 raw lines — the shared complexity
  ratchet counts files over 600 and the program forbids moving that baseline.
- `CMP-PLUGIN-*` codes are never inlined here; import them from
  `services/backend/error-codes.js` (enforced by `check_error_codes.py`).
- `services/plugins/contracts/` holds only generated artifacts from
  `scripts/generate_plugin_contracts.py` — never hand-edit them.
- `config/plugins/trusted-publishers.json` fails closed when empty. The
  `jenny-official` public root is supplied only through the offline owner
  ceremony in `docs/operations/plugin-signing-root.md`; private key material is
  never a repository input.
- `scripts/plugins/jenny-plugin-packager.mjs` is a standalone owner-smoke
  generator that is copied outside the worktree before use. It embeds only the
  public current-key identity, accepts a sibling key file through its local
  process, and never loads Jenny source while the key is present.
