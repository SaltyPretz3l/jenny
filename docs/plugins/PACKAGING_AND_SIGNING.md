# Packaging, signing, and installing

## The honest state of distribution

Packages signed by a publisher in `config/plugins/trusted-publishers.json` use
the normal trusted-publisher path. A local package whose publisher is not
pretrusted may instead install through the developer profile, which is off by
default and turned on with `JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE=1`. Jenny
still parses the required signature bundle and runs every manifest, identity,
content-digest, contribution, budget, executable-payload, and display-string
check; only trusted-publisher lookup and Ed25519 verification are skipped.

Developer installs share the normal plugin store and retain the same
`local_package` package-record source identity as signed local installs. A
deterministic unsigned signing-key token distinguishes them; source-trust
evidence and the renderer-facing summary derive `developer_link` from that
token, so Settings labels them `developer (unsigned)`. Install a normally
signed local package to promote the same plugin identity. Developer packages
cannot declare any retired contribution kind (plugin-supplied MCP, the Wasm
restricted kinds, and the privileged `session_provider`, `native_mcp`,
`engine_adapter`, `hook` and full-host kinds; also `provider_descriptor`,
`setup_scene`, `command` and `workflow`). Publisher ids reserved by configured
trust roots remain unavailable to developer packages.

Unsigned developer intake is off by default (owner, 2026-10-02). Start Jenny
with `JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE=1` to accept unsigned packages. While
it is off, an unsigned install is refused as an untrusted publisher and an
unsigned plugin that is already installed stays listed but does not load.

## Installing a package you are building

Build a `.jenny-plugin` zip with `plugin.json` and
`META-JENNY/signature-bundle.json` at its root, plus every content or view
file declared by the manifest. The developer profile still
requires a structurally valid signature bundle and applies all non-signature
intake checks; it is not a folder loader.

In Settings ▸ Plugins & Extensions, use the header **Install plugin** picker or
drop a `.jenny-plugin` file on the Installed section. The drop zone resolves the
selected file and calls the validated install-from-path seam; the picker uses
the normal local-package install seam. Successful developer installs appear as
`developer (unsigned)`. The retired contribution kinds listed above are
refused, and the environment-variable kill switch disables this path entirely.
Validate the authored folder before packaging and the completed archive before
installing with `npm run plugin:validate -- <folder-or-archive>`; the full
output and exit-code contract is in `TESTING.md`.

### Exact unsigned bundle and archive recipe

The [permissionless prompt intake walkthrough](AUTHORING_OVERVIEW.md#empty-folder-to-installed-a-permissionless-prompt-fixture)
contains the complete `META-JENNY/signature-bundle.json`, exact content and
manifest digests, required root archive layout, deterministic repository-local
zip command, generated-contract validation command, and production
developer-profile intake command. Its bundle has exactly
`signature_bundle_version`, `signed_payload`, and `signatures`; each signature
entry has exactly `algorithm`, `canonicalization_version`, `key_id`, and a
canonical-base64 64-byte `signature`. The developer profile skips trust lookup
and Ed25519 verification, not structural, path, digest, identity, contract,
budget, or content checks.

No generic packager ships today. Use that verified one-off recipe for local
developer work, or use a publisher-owned signing pipeline for distribution.
The walkthrough's third-party V1 fixture installs disabled but cannot activate;
successful production intake is not proof of activation eligibility.

## Building a signed package (official pipeline shape)

Retired 2026-10-02 (plugin platform retirement stage 4). The kit, signing
request, offline signer, finalize and verify scripts (the `plugin:stage8:*`
npm scripts and the V6 packager) were deleted with the privileged tier, and
the official-package pipeline went with the ChatGPT plugin, so there is no
generic signing pipeline in the repository. The signing root procedure and the
one remaining fixed packager are in the signing-root runbook.
Never copy a finished archive into the source checkout.

## What ships with Jenny

`electron-builder.yml` retains an extra-resource glob for finalized `.jenny-plugin` archives. No official package is currently bundled: `config/plugins/bundled-plugins.json` has an empty `plugins` array and the official source/build/sign pipeline was removed. Startup removes the retired ChatGPT and Remote Control packages from older profiles. A new bundled package would need an explicit trusted inventory pin and startup wiring; copying an archive into build inputs alone does not register or activate it.

There is no generic packager for third-party authors. The retained `scripts/plugins/jenny-plugin-packager.mjs` is the only packager left; it is fixed to the `jenny-official/stage4b-owner-smoke` fixture and rejects other fixture identities (see the signing-root runbook). The repository-local walkthrough above closes the manual package-shape gap but is not a supported authoring CLI.
