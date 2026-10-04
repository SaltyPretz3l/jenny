# Plugin control plane

Electron-owned plugin-platform code lives here. Canonical architecture:
`PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md`;
domain manifest: `docs/manifests/plugin-system.md`;
completed execution program: `docs/archive/PLUGIN_PROGRAM_EXECUTION.md`.

Current posture (enforced by `scripts/checks/check_plugin_boundary.py`; the
platform is being retired in place, see `NEXT_STEPS.md` row 27):

- **The surviving platform is active by default with `JENNY_ENABLE_PLUGINS=0`
  as the emergency kill switch.** Unsigned authoring is separately default-off
  (`JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE=1`). The sole
  Electron composition seam owns native-picker local package distribution,
  recoverable V3 commits, and generation-bound sidecar descriptor publication.
  Retired 2026-10-02 (plugin platform retirement stage 4): git and https_url
  acquisition, catalogs, offline mirrors, rollback, the network broker, loopback
  OAuth and remote HTTP MCP. Any other source kind fails closed without network
  access.
- The restricted (Wasm) tier is retired. Installed V4 packages that declare
  `restricted_transform`, `restricted_formatter`, `restricted_renderer`, or
  `restricted_compute` still parse and reverify
  (`package/restricted-content-validator.js`) but execute nothing, and new
  installs or enables of them are refused.
- Signed V5 packages may additionally contain digest-bound sandboxed views.
  Jenny owns trust chrome, session policy and bridge vocabulary; plugin assets
  never receive credentials. Provider descriptors and the `setup_scene` kind are
  retired (ChatGPT is a core cloud model); old session-bound views are not
  supported.
- V6 schemas and generation readers remain for compatibility, but the privileged tier is retired
  (2026-10-02): `native_mcp`, `session_provider`, `engine_adapter`, `hook` and
  full-host contributions are inert, never compiled and never launched, and the
  runtime snapshot carries them as empty arrays. `privileged_plugins` is a
  retired flag; startup sweeps the tier's leftover state once
  (`lifecycle/privileged-tier-retirement.js`).
- The official `jenny-official/local-image-generation@1.0.0` package was
  archived on 2026-10-02 (code recoverable from the tag
  `archive/local-image-generation`); its old image chats open read-only as
  ordinary transcripts.
- V1/V2 local packages remain compatible. Their first Stage-5 distribution
  mutation re-verifies exact stored bytes and promotes immutable identity,
  source-trust, advisory, and data evidence into the V3 generation; missing or
  rotated trust fails closed.
- Verified catalogs, offline mirrors and the plugin network ceiling are retired
  (stage 4); the `catalog/`, `network/` and `remote-mcp/` trees no longer exist.
- V1/V2 activation requires current-key `jenny-official`, no permissions and no
  dependencies. V1 supports skills/prompts; V2 adds themes/settings schemas.
  V3 supports permissionless skills/prompts from a verified publisher or the
  enabled developer profile. The admission list separately refuses all retired
  kinds; schema acceptance is not permission to install or enable them.
- `services/main/plugins-ipc-registration.js` is the sole main-process
  composition seam. The native package picker is the install source (catalogs
  are retired). Contribution toggles and typed settings updates
  use expected-generation CAS. The trusted-sender `installPackageFromPath`
  invoke accepts the selected local path for drag-and-drop; the native picker
  keeps its path in main. Package records retain path digests, and results,
  logs, diagnostics and audit expose no raw package path.
- `CONTROL_PLANE_STAGE` is `8` (reported by `getState`); committed generations may persist only
  `installed_disabled`, `active`, `blocked`, or `quarantined`. Transitional `preparing`/`disabling` rows,
  future schemas, and corrupt state fail closed and block mutation.
- Enable, disable, active uninstall, restart rehydration, and recovery use one
  transactional coordinator. The active pointer cannot flip without exact
  sidecar attestation; ambiguous apply remains fenced until reconciliation.
- V1 overlays remain verbatim. V2 prompt substitution is exact single-pass;
  the deterministic workflow interpreter is retired.
- Themes are scoped to `#chatView`; settings are typed/content-addressed.
- Standalone user-authored MCP connections are not plugin definitions. They are
  owned by `services/mcp-config-store.js` and
  `services/mcp-discovery-service.js`, require explicit tool-surface review,
  and appear beside plugins in Plugins & Extensions. Plugin-supplied MCP is
  retired (stage 4).
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
- `config/plugins/bundled-plugins.json` is empty. ChatGPT sign-in/models and
  image generation are core features; no official plugin package ships.
- `scripts/plugins/jenny-plugin-packager.mjs` is a standalone owner-smoke
  generator that is copied outside the worktree before use. It embeds only the
  public current-key identity, accepts a sibling key file through its local
  process, and never loads Jenny source while the key is present.
  The pre-retirement reviewed script digest no longer matches; production-key
  use requires a current owner-approved code identity in the signing handoff.
