# Packaging, signing, and installing

## The honest state of distribution

Packages signed by a publisher in `config/plugins/trusted-publishers.json` use
the normal trusted-publisher path. A local package whose publisher is not
pretrusted may instead install through the default-on developer profile. Jenny
still parses the required signature bundle and runs every manifest, identity,
content-digest, contribution, budget, executable-payload, and display-string
check; only trusted-publisher lookup and Ed25519 verification are skipped.

Developer installs share the normal plugin store and retain the same
`local_package` package-record source identity as signed local installs. A
deterministic unsigned signing-key token distinguishes them; source-trust
evidence and the renderer-facing summary derive `developer_link` from that
token, so Settings labels them `developer (unsigned)`. Catalog and offline-mirror
updates cannot replace them; install a normally signed local package to promote
the same plugin identity. Developer packages cannot use the
privileged `session_provider`, `native_mcp`, `engine_adapter`, or `hook`
contribution kinds in this wave. Publisher ids reserved by configured trust
roots remain unavailable to developer packages.

`JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE=0` disables unsigned developer intake.

## Installing a package you are building

Build a `.jenny-plugin` zip with `plugin.json` and
`META-JENNY/signature-bundle.json` at its root, plus every content, view,
component, or host file declared by the manifest. The developer profile still
requires a structurally valid signature bundle and applies all non-signature
intake checks; it is not a folder loader.

In Settings ▸ Plugins & Extensions, use the header **Install plugin** picker or
drop a `.jenny-plugin` file on the Installed section. The drop zone resolves the
selected file and calls the validated install-from-path seam; the picker uses
the normal local-package install seam. Successful developer installs appear as
`developer (unsigned)`. The privileged contribution kinds listed above are
refused, and the environment-variable kill switch disables this path entirely.
Validate the authored folder before packaging and the completed archive before
installing with `npm run plugin:validate -- <folder-or-archive>`; the full
output and exit-code contract is in `TESTING.md`.

### Exact unsigned bundle and archive recipe

The [permissionless prompt walkthrough](AUTHORING_OVERVIEW.md#empty-folder-to-enabled-a-permissionless-prompt-plugin)
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

## Building a signed package (official pipeline shape)

The official pipelines are the model: build a kit into a directory outside the worktree, export a signing request, sign offline with the protected key, finalize to an external destination, verify with production intake.

```powershell
node scripts/plugins/build-stage8-conformance-kit.mjs --destination D:\jenny-signing
node scripts/plugins/export-stage8-conformance-signing-request.mjs --kit <kit> > <external>\signing-request.json
# offline machine
node sign-stage8-conformance-request.mjs --request signing-request.json --private-key <key-file> --output returned-stage8-signature.json
# back on the build machine
node scripts/plugins/finalize-stage8-signed-conformance-package.mjs --kit <kit> --signature <external>\returned-stage8-signature.json --output <external>\stage8-conformance.jenny-plugin
node scripts/plugins/verify-stage8-conformance-package.mjs --package <external>\stage8-conformance.jenny-plugin
```

Packagers refuse dirty inputs, mutable or oversized files, identity drift, the wrong publisher root, signature mismatch, host packages above 256 MiB, and archives above 300 MiB. Never copy a finished archive into the source checkout; the private build-input directory for bundled official packages is not part of the public repository.

## What ships with Jenny

`electron-builder.yml` can copy finalized `.jenny-plugin` archives supplied to a release build as extra resources. The public repository includes neither those archives nor their source trees. Removing an externally supplied archive from the build input removes that bundled plugin; nothing in core needs to change.

There is no generic packager for third-party authors. The shipping `scripts/plugins/jenny-plugin-packager.mjs` is fixed to the `jenny-official/stage4b-owner-smoke` fixture and rejects other fixture identities; the other shipping packagers are likewise stage- or official-package-specific. The repository-local walkthrough above closes the manual package-shape gap but is not a supported authoring CLI.
