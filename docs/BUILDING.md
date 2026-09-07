# Building & Distribution

## Packaging Flow (Sidecar + Electron)

### Purpose
- Produce a deterministic sidecar artifact at `build/sidecar/sidecar(.exe)`.
- Package Electron with sidecar resources copied into `resources/sidecar`.
- Verify packaged runtime resolves and trusts the packaged sidecar artifact.

### Local Workflow
Use Node 22.23.2+ on 22.x or Node 24.19.0+ on 24.x with npm 10+. Other Node
majors are intentionally rejected before dependency installation.

1. Install the locked build backend and sidecar packaging dependencies:
   - `.\.venv\Scripts\python -m pip install --require-hashes --only-binary=:all: -r requirements-build-lock.txt`
   - `.\.venv\Scripts\python -m pip install --require-hashes -r requirements-lock.txt`
   - `.\.venv\Scripts\python -m pip install --no-build-isolation --no-deps -e .`
   - `.\.venv\Scripts\python -m pip check`
2. Build and verify the offline Windows managed-Python bundle:
   - `.\.venv\Scripts\python scripts\build-python-runtime-bundle.py`
   - `.\.venv\Scripts\python scripts\checks\check_python_runtime_bundle.py`
3. Build and package the unpacked desktop app:
   - `npm run pack:dir`
   - The pack command rebuilds the sidecar artifact before Electron Builder, so
     a missing or stale `build/sidecar` directory cannot silently produce an
     incomplete package.
4. Run full packaged-flow smoke:
   - `npm run release:smoke`
5. For a W1-A release candidate, run the redaction-safe packaged model and
   restart-persistence probes serially:
   - `npm run test:live-local-evidence -- --phase packaged --packaged-sidecar dist\win-unpacked\resources\sidecar\sidecar.exe --output artifacts\release-evidence\w1-a\packaged-sidecar.json`
   - `npm run test:packaged-attachment-rehydration -- --output artifacts\release-evidence\w1-a\packaged-rehydration.json`
   - These do not replace the visible packaged composer/relaunch rows in
     `MANUAL_TEST_MATRIX.md`.
6. Record the candidate evidence:
   - update or attach the fields required by [Release Provenance and Evidence](#release-provenance-and-evidence)

### GitHub Stage Workflow
1. Create the trimmed GitHub-ready source stage:
   - `npm run stage:github`
   - or `python scripts/packaging/create_github_stage.py`
2. Review the staged copy in the sibling `jenny-github-stage` directory printed by the command.
3. Confirm the stage excludes dependencies, archives, local state, and generated analysis artifacts before publishing.
4. If you intentionally need to replace a different non-empty target directory, rerun with:
   - `python scripts/packaging/create_github_stage.py --force`

### CI Workflow
1. Install locked Python dependencies for the sidecar artifact profile:
   - `python -m pip install --require-hashes --only-binary=:all: -r requirements-build-lock.txt`
   - `python -m pip install --require-hashes -r requirements-lock.txt`
   - `python -m pip install --no-build-isolation --no-deps -e .`
   - `python -m pip check`
2. Populate and validate the managed-Python runtime resources on the Windows release leg:
   - `python scripts/build-python-runtime-bundle.py`
   - `python scripts/checks/check_python_runtime_bundle.py`
3. Build and package the unpacked desktop app:
   - `npm run pack:dir`
   - The pack command rebuilds the sidecar artifact before Electron Builder.
4. Run packaged-flow smoke:
   - `npm run release:smoke`

### Signing And Updates
- Windows release builds are configured for an NSIS installer, Authenticode
  SHA-256 signing, and GitHub Releases publishing in `electron-builder.yml`.
- CI must provision signing secrets through Electron Builder environment
  variables, never through committed certificate paths:
  - `WIN_CSC_LINK` or `CSC_LINK`
  - `WIN_CSC_KEY_PASSWORD` or `CSC_KEY_PASSWORD`
- `electron-builder.yml` intentionally omits `certificateFile` and
  `certificatePassword` so local unsigned smoke builds can pass without a
  developer certificate.
- Local unsigned smoke builds should continue to pass `--publish never`; release
  jobs publish only after the packaged-flow smoke succeeds.
- Emit the sidecar SBOM before publishing a release artifact:
  - `npm run sbom:sidecar`
- The runtime updater uses `electron-updater` and `latest.yml` SHA512 metadata.
  The release body also carries a SHA256 audit manifest generated with the
  maintainer tooling in the private source repository (`scripts/release/`,
  not part of this tree):
  - `python scripts/release/append_sha_manifest.py dist\*.exe dist\*.yml`
- Release versions are cut with the same maintainer tooling:
  - `python scripts/release/cut_release.py <version>`
  This mutates app-version sources only and does not bump sidecar API or schema
  versions.
- Release policy checks:
  - `python scripts/checks/check_release_metadata.py`
  - `python scripts/checks/check_release_manifest_block.py --require-assets`
  - `python scripts/checks/check_release_version_policy.py`
- Release provenance, signing/notarization state, rollback/reinstall decisions,
  and SBOM/dependency-audit expectations are owned by
  [Release Provenance and Evidence](#release-provenance-and-evidence).

### Uninstall packaging

- `npm run build:preload` builds both `preload.bundle.js` and the narrow
  `uninstall-preload.bundle.js`; source preloads remain excluded from the asar.
- Windows NSIS includes `build/installer.nsh`. Updates bypass the assistant,
  silent uninstall preserves data, and only fixed exit codes authorize residual
  profile cleanup.
- The macOS DMG includes `Uninstall Jenny.command` beside the app. Drag-to-Trash
  remains app-only because macOS exposes no reliable removal hook.
- Source distributions include all clone wrappers and `scripts/uninstall.js`.
  Packaging/static tests pin these inclusions; the installed Windows matrix and
  macOS DMG helper remain owner-run release gates.

See [Uninstall and Data Recovery](operations/UNINSTALL_AND_DATA_RECOVERY.md) for ownership
and failure semantics.

### Manual Release Review

After automated packaging smoke passes for a release candidate, run the manual
release checklist in `MANUAL_TEST_MATRIX.md`. It covers
packaged runtime UX, local-model readiness, speech/device checks, performance
baseline interpretation, and visual UI smoke states that automated tests do not
fully exercise.
Copy the completed evidence fields into `RELEASE_NOTES.md` or the release
evidence bundle so they are preserved with the candidate.

### Reproducibility Notes
- `requirements-build-lock.txt` owns the exact pip/setuptools/wheel backend,
  and `requirements-lock.txt` owns the sidecar artifact runtime. Artifact
  installs use `--no-build-isolation`, so pip cannot resolve an untracked
  backend in a temporary build environment.
- `requirements-python-runtime-lock.txt` is the complete hash-locked
  CPython 3.13 Windows x64 wheel closure used by `python_execute`.
- `config/python-runtime-bundle-lock.json` pins CPython 3.13.14's official
  embeddable ZIP and SHA-256
  `90b4e5b9898b72d744650524bff92377c367f44bd5fbd09e3148656c080ad907`.
- Generated interpreter and wheel files live under `vendor/python-embed/`
  and `vendor/python-runtime-wheels/`; only their `.gitignore` sentinels are
  tracked. `pack:*` and `release:windows` fail before Electron Builder when
  either tree, its manifest, a lock fingerprint, or a file checksum drifts.
- The Windows embeddable distribution omits `venv` and `ensurepip` by design.
  The managed runtime copies the verified distribution into its user-owned
  staging root and bootstraps pip only from the verified bundled wheel.
- macOS packages continue to include their native sidecar artifact but do not
  include the Windows-only CPython bundle.
- Regenerate the sidecar artifact lock only from a clean Python 3.11 virtual environment after
  dependency updates:
  Regenerate it only from a clean Python 3.11 virtual environment after
  dependency updates:
  - `python -m pip install --require-hashes --only-binary=:all: -r requirements-build-lock.txt`
  - `python -m pip install -e ".[packaging]"`
  - `python -m pip install pip-tools`
  - `python -m pip-compile --generate-hashes --extra packaging --output-file requirements-lock.txt pyproject.toml`
- `scripts/packaging/build_sidecar_artifact.py` always writes outputs to:
  - artifact: `build/sidecar/sidecar(.exe)`
  - manifest: `build/sidecar/manifest.json`
  The manifest records all three lock hashes, the managed-runtime bundle
  contract hash, and `build_isolation: false`.
- The sidecar artifact build intentionally excludes optional dev-only ML/audio stacks
  such as `torch`, `transformers`, and `faster_whisper` unless a future packaging
  plan explicitly bundles those features. This keeps CI packaging smoke focused on
  the local-first sidecar runtime instead of sweeping installed development extras.
- The optional `spreadsheet` extra pins `openpyxl==3.1.5` plus
  `defusedxml==0.7.1` for the default-off `spreadsheet_inspect` tool. It is
  intentionally outside `requirements-lock.txt` until a release-size review
  promotes spreadsheet inspection into the packaged sidecar artifact profile.
- Packaging command timeouts terminate their child process trees so interrupted
  smoke runs do not leave PyInstaller, electron-builder, or packaged-app children
  running in the workspace.
- Set `SOURCE_DATE_EPOCH` in local/CI environments for stable manifest timestamp metadata:
  - PowerShell: `$env:SOURCE_DATE_EPOCH = "1735689600"`
- The packaged launch resolver trusts sidecar binaries only when:
  - `resources/sidecar/manifest.json` is present,
  - `manifest.api_version` matches runtime `SIDECAR_API_VERSION`,
  - `manifest.sha256` matches the packaged artifact file bytes,
  - `manifest.git_commit` matches the current checkout, unless
    `scripts/packaging/smoke_packaged_flow.py --allow-stale-source` is used
    for an intentional stale-artifact check.
- Packaged builds resolve the sidecar through `services/backend/packaged-sidecar-launch.js` and fail closed when the packaged artifact is missing, untrusted, or not runnable. Packaged apps do not silently fall back to `python -m sidecar`.
- `python -m sidecar` remains the canonical development launch path and the packaging/bootstrap probe target.
- `scripts/packaging/smoke_packaged_flow.py` now validates packaged source freshness, records Windows signing status when `signtool` is available, runs a direct packaged-sidecar `initialize` probe that requires core built-in tools to register, launches the unpacked packaged app, clears `ELECTRON_RUN_AS_NODE` for the packaged app process, uses a temporary request/output-file handshake for smoke automation, waits for renderer-ready plus completed backend startup, and requires `launchSource == "packaged-binary"` before the smoke passes.
- Root-file packaging globs must continue to include the overlay companion assets:
  - `overlay.html`
  - `renderer/overlay/overlay-comet.js`
  - `preload-overlay.js`
- At runtime, packaged launch performs a preflight `--version` probe before the
  main process adopts the packaged sidecar command.
- Assistant reply TTS audio remains runtime-generated app data under the managed
  attachment store; packaging does not prebundle `.wav` reply assets.
- `llama_server_extract/` is local-only developer tooling by default. It is
  ignored by git and is not shipped by `electron-builder.yml`. Promoting it to a
  bundled runtime asset requires a provenance manifest with source URL, version,
  hashes, update policy, and explicit `electron-builder.yml` wiring.

## Distributing Jenny

Two ways someone can get Jenny running. Pick per audience.

| Path | For | What they need |
| --- | --- | --- |
| **Clone + setup script** | Developer friends | git, then `setup.ps1` / `setup.sh` (installs Node/Python/Ollama with consent) |
| **Packaged installer** | Non-technical friends | One download: `.exe` (Windows) or `.dmg` (macOS) |

Both paths download the default model (Ornith 1.5 9B, pulled as
`hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M`, ~5.6 GB) from the model
publisher's official Hugging Face GGUF repository on first run. **No model
files ship in the repo or the installer** — the install stays small and the
model is always fetched fresh. Ornith is text-only — Gemma 4 E4B remains
available in the model picker for image input.

---

### Clone + setup script

Clone users can remove Jenny with `npm run uninstall` or the platform wrapper.
Dependency/build cleanup and clone deletion are separate prompts. Clone deletion
fails closed unless repository identity is verified, Git is clean, and the
exact directory name is typed. No global runtime, model, or package-manager data
is removed.

See the README "Quick start". A friend clones the repo and runs the OS script;
it verifies prerequisites, installs everything, pulls the model, and launches
Jenny. Idempotent and re-runnable.

---

### Packaged installer

Windows Apps & features launches Jenny's removal assistant; silent uninstall
removes only the app and preserves data. The macOS DMG ships
`Uninstall Jenny.command`; dragging the app to Trash also preserves data. See
[Uninstall and Data Recovery](operations/UNINSTALL_AND_DATA_RECOVERY.md).

Installers are built and published by CI (`.github/workflows/release.yml`) on a
version tag.

#### One-time prerequisites

1. **App icons (already in the repo)** — the macOS build uses `build/icon.png`
   (a ~1024px source); `electron-builder` generates the multi-resolution `.icns`
   at build time, and the Windows build uses `build/icon.ico`. Both files ship in
   the repo, so no manual icon generation is required.
2. **(Optional) Code-signing secrets** — see "Signing" below. Without them,
   builds publish **unsigned** (shippable today, with OS warnings).

#### Cutting a release

```sh
# Bump version + tag (use the existing release helper if present), then:
git tag vX.Y.Z
git push origin vX.Y.Z
```

CI then, per OS runner:

1. Sets up Node (from `.nvmrc`) + Python 3.11.
2. Builds the platform sidecar (`scripts/packaging/build_sidecar_artifact.py` →
   `sidecar.exe` on Windows, `sidecar` on macOS).
3. Runs `electron-builder --win|--mac --publish always`.

This publishes to the GitHub Release for the tag (artifact names are
deliberately version-free so `releases/latest/download/...` URLs are
permanent):

- **Windows:** `Jenny-Setup-x64.exe` + `Jenny-Setup-x64.exe.blockmap` +
  `latest.yml`
- **macOS:** `Jenny-arm64.dmg` + `Jenny-arm64.zip` + `latest-mac.yml`
  (the `.zip` is required for electron-updater on macOS).

Both OSes publish to the same Release; electron-updater picks the right
manifest per platform.

> The macOS app **must** build on a macOS runner — electron-builder cannot
> produce or sign a `.app` from Windows, and the PyInstaller sidecar is
> platform-specific. The owner develops on Windows, so the macOS installer is
> entirely CI-gated.

#### What a friend downloads

One file for their OS. First launch runs the in-app setup checklist: it installs
Ollama (auto on Windows; manual link on macOS — see below), downloads the
default model, and configures workspace root + personality.

---

### Unsigned-build warnings (and how friends get past them)

Until signing is set up, expect:

- **Windows (SmartScreen):** "Windows protected your PC" → **More info** →
  **Run anyway**.
- **macOS (Gatekeeper):** "Apple could not verify…" → right-click the app →
  **Open** (once), or run
  `xattr -dr com.apple.quarantine "/Applications/Jenny.app"`.

Tell friends to expect this; it is normal for an unsigned indie app.

---

### Signing (upgrade path — removes the warnings)

Add these as GitHub Actions repo secrets; the release workflow uses them
automatically (no workflow edit needed):

- **Windows Authenticode:** `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.
- **Apple Developer ID** ($99/yr): `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Then add `notarize: true` to
  the `mac` block in `electron-builder.yml`.

#### Auto-update notes

- **Windows:** auto-update works from `latest.yml`. For an *unsigned* update
  channel set `verifyUpdateCodeSignature: false` in `electron-builder.yml`
  (the NSIS updater otherwise rejects unsigned updates); flip it back once
  Authenticode signing lands.
- **macOS:** Squirrel.Mac only applies updates to a **signed + notarized** app.
  Until then, `services/update-service.js` reports auto-update as disabled on
  macOS with a "download the latest DMG" hint. When you ship signed mac builds,
  enable it by making the build set the runtime signal `JENNY_MAC_SIGNED=1`
  (read by `UpdateService`); the `-mac.zip` + `latest-mac.yml` are already
  published so no rebuild plumbing is needed.

### Ollama on macOS

The in-app SHA-pinned auto-installer is Windows-only
(`config/ollama-install-manifest.json`). On macOS the setup script offers
`brew install ollama`; the in-app wizard shows a manual
[ollama.com/download/mac](https://ollama.com/download/mac) link and re-scans.

## Release Provenance and Evidence

Last reviewed: 2026-08-12

### Purpose

This document turns Jenny's packaging, smoke, and failure-drill work into a
release evidence contract. It is Windows-first and extends the existing packaged
sidecar trust chain; it does not introduce a parallel package-integrity path.

Release evidence belongs with the release candidate, not only in local terminal
scrollback. Record the exact candidate values in `RELEASE_NOTES.md`, attach raw
logs or artifacts to the release evidence bundle, and keep this document as the
operator checklist for what must be present before promotion.

### Required Evidence Record

| Evidence | Source | Acceptance |
|---|---|---|
| App version | `package.json`, `pyproject.toml` | Versions match and release notes contain the version section. |
| Source revision | Release tag or commit SHA, plus `build/sidecar/manifest.json` `git_commit` | Release build is from the recorded commit. Dirty-tree builds are allowed only for local smoke and must not be called production-ready. |
| Release assets | `RELEASE_NOTES.md` SHA256 manifest block, `dist/latest.yml` updater metadata | SHA256 rows match current `dist/` files; updater SHA512 remains in `latest.yml`. |
| Packaged sidecar artifact | `build/sidecar/manifest.json` and packaged `resources/sidecar/manifest.json` | Manifest `api_version`, `artifact_name`, `sha256`, `git_commit`, and artifact bytes are recorded. |
| Builder environment | CI run metadata or local release worksheet | Windows builder, `.nvmrc`, npm lock install, Python 3.11, all three hashed Python locks, `--no-build-isolation`, `pip check`, and `SOURCE_DATE_EPOCH` state are recorded. |
| Managed Python runtime bundle | `config/python-runtime-bundle-lock.json`, generated embed/wheel manifests, packaged `resources/python-*` | CPython 3.13.14 source hash, lock fingerprints, every generated file hash, and packaged resource presence pass the fail-closed checker. |
| Signing state | `electron-builder.yml`, CI signing secrets, `signtool verify` when available | Release notes say signed, unsigned-dev, or blocked. Production-ready releases cannot be silently unsigned. |
| Notarization state | Platform release notes | Windows-only releases record `not applicable`; macOS notarization remains blocked until macOS packaging is explicitly enabled. |
| Automated packaged smoke | `npm run release:smoke`, `artifacts/logs/packaging-smoke-phase4.log` | Smoke validates sidecar manifest integrity, source freshness, initialize probe, launch resolver, packaged app readiness, and `launchSource == "packaged-binary"`. |
| Core local-model evidence | `docs/operations/release-evidence/w1-a-core-local-model.json` plus its ignored artifact references | Exact release targets, live Ollama reliability/sampling, direct-vLLM disposition, real vision/refusal, packaged readiness, and managed restart rehydration are explicit; any blocked direct engine or owner UI gate holds W1-A. |
| Manual smoke | Completed `MANUAL_TEST_MATRIX.md` template | Release notes include reviewer, machine, app path, temp profile, workspace, model/runtime, stream id, diagnostic paths, deviations, and release decision. |
| Failure drills | Packaged failure-drill notes plus focused test evidence | Missing manifest/artifact, hash mismatch, stale commit, launch-probe failure, and approval terminal outcomes fail closed and do not fall back to `python -m sidecar`. |
| SBOM and dependency audit | `dist/sidecar-sbom.json`, package locks, audit outputs | Existing sidecar SBOM is attached; npm/Python advisory results or explicit deferrals are recorded. |
| Bundled app/tool assets | `electron-builder.yml`, `skills/`, `services/tools/tool-manifest.json`, `vendor/` | First-party bundles are named; vendored or promoted third-party assets have source, version, license, hash, and rollback notes. |
| External official image plugin | External `local-image-generation-1.0.0-win32-x64.jenny-plugin`, signing-kit provenance, production-intake output, and owner qualification worksheet | Package is current-key signed, absent from installer/root plugin inputs, source/host/package digests match, and real NVIDIA peaks stay below 80% of `gpu_image_v1`; install/adopt/provision/generate/cancel/repair/remove/update/disable/uninstall/tree-empty/manual UI gates are recorded before distribution. |
| Rollback and reinstall decision | Release notes and support handoff | Decision says promote, hold, rollback, reinstall, or rebuild, with the reason and data-preservation expectation. |

### Source Identity

Record the release tag or commit SHA before packaging. The sidecar artifact
manifest also carries `git_commit` and `git_dirty`; the packaged smoke rejects
stale sidecar commits unless `--allow-stale-source` is used for an intentional
negative check. A dirty local smoke is useful evidence, but it is not production
provenance.

Minimum source fields:

- Release tag or commit SHA.
- `git status --short` state at build time.
- `build/sidecar/manifest.json` `git_commit` and `git_dirty`.
- GitHub Actions run id or local builder identity.
- Release notes section that names the exact candidate.

### Release Notes Evidence Block

`RELEASE_NOTES.md` contains a `Release Evidence` template for the current
candidate. Fill every field before publish. Use `not run`, `blocked`, or
`not applicable` when evidence is intentionally absent so an empty row cannot be
mistaken for a passing gate.

### Artifact Hash Expectations

Jenny currently has three hash layers:

- Human release audit: `RELEASE_NOTES.md` contains a SHA256 manifest block for
  published `dist/` assets. The maintainer runs
  `python scripts/release/append_sha_manifest.py dist\*.exe dist\*.yml`
  (private source repository tooling) after building the release candidate.
- Updater metadata: `electron-updater` uses `latest.yml` SHA512 metadata for
  update verification.
- Packaged sidecar trust: `build/sidecar/manifest.json` records the sidecar
  artifact SHA256, API version, source commit, dirty state, Python executable,
  PyInstaller version, and build timestamp metadata.
- External official-plugin trust: the local-image signing kit binds the source
  tree, contract lock, build/packager scripts, host and provenance; the returned
  current-key signature covers canonical package metadata, and production V6
  intake recomputes every archive/content/executable digest before install.

Before publish, the release operator should run:

```powershell
python scripts/checks/check_release_manifest_block.py --require-assets
python scripts/checks/check_release_metadata.py
python scripts/checks/check_release_version_policy.py
```

For documentation-only updates, the non-strict manifest-block check is enough to
validate the release-notes block shape when `dist/` assets are unavailable.

### Packaged Sidecar Trust Chain

The packaged sidecar trust model is:

1. `python scripts/packaging/build_sidecar_artifact.py` builds
   `build/sidecar/sidecar(.exe)` and writes `build/sidecar/manifest.json`.
2. `electron-builder.yml` copies `build/sidecar/**` to packaged
   `resources/sidecar`.
3. `services/backend/packaged-sidecar-launch.js` accepts the packaged sidecar
   only when `resources/sidecar/manifest.json` is present, `api_version` matches
   `SIDECAR_API_VERSION`, `artifact_name` is a filename inside the sidecar
   directory, the artifact SHA256 matches the manifest, and a `--version` probe
   reports the expected API version.
4. `scripts/packaging/smoke_packaged_flow.py` repeats the manifest/hash/source
   checks, probes packaged `initialize`, launches the unpacked packaged app, and
   requires `launchSource == "packaged-binary"`.

Packaged builds must fail closed when the packaged artifact is missing,
untrusted, stale, or not runnable. They must not silently fall back to
`python -m sidecar`; that launch path remains development-only.

### Builder Environment

Release candidates should be built on Windows with:

- Node from `.nvmrc` and `npm ci` from `package-lock.json`.
- Python 3.11.
- Build backend installed with
  `python -m pip install --require-hashes --only-binary=:all: -r requirements-build-lock.txt`.
- Sidecar packaging dependencies installed with
  `python -m pip install --require-hashes -r requirements-lock.txt`.
- Editable sidecar install with
  `python -m pip install --no-build-isolation --no-deps -e .`, followed by
  `python -m pip check`.
- The Windows runtime bundle generated with
  `python scripts/build-python-runtime-bundle.py` and accepted by
  `python scripts/checks/check_python_runtime_bundle.py`.
- Optional `SOURCE_DATE_EPOCH` recorded for stable manifest timestamp metadata.
- Signing secrets supplied through CI or local environment variables, never
  committed certificate paths.

The GitHub release attestation workflow uploads and attests `build/sidecar/**`
and `dist/**`. That attestation is evidence for the built outputs, not a
replacement for the release-notes hash manifest or manual smoke decision.

### Signing and Notarization

Windows signing is configured through `electron-builder.yml` with Authenticode
SHA-256 signing and `verifyUpdateCodeSignature: true`. Local unsigned smoke
builds are allowed so developers can validate packaging without a certificate.

Release notes must record one of:

- `signed`: Authenticode verification passed and the signing identity is named.
- `unsigned-dev`: local smoke only; not production-ready.
- `blocked`: signing was required but failed or could not be verified.

Notarization is not applicable for current Windows-first releases. If macOS
packaging is enabled later, notarization evidence becomes a required row in the
release evidence record before macOS promotion.

### Smoke and Failure-Drill Evidence

Automated packaged smoke evidence comes from `npm run release:smoke`. Attach or
copy the relevant lines from `artifacts/logs/packaging-smoke-phase4.log`,
including:

- Sidecar artifact path and manifest path.
- Manifest API version, source commit, and artifact SHA256.
- Signing status, if `signtool` was available.
- Packaged launch-probe result.
- Packaged sidecar `initialize` probe result.
- Packaged app smoke result and `launchSource`.

Manual smoke evidence comes from `MANUAL_TEST_MATRIX.md`. Keep a
completed copy or pasted template in the release evidence bundle and summarize
the decision in `RELEASE_NOTES.md`.

Failure-drill evidence should state the failed condition, expected behavior, and
actual result. Minimum drills for this baseline:

- Missing packaged sidecar manifest or artifact blocks packaged startup.
- Sidecar artifact SHA mismatch blocks packaged startup.
- Stale sidecar `git_commit` blocks packaged smoke unless explicitly allowed for
  the negative drill.
- Packaged launch resolver does not choose `python -m sidecar`.
- Managed approval denied, cancelled, timed out, and preempted outcomes produce
  terminal tool results instead of hanging or executing the side-effecting tool.

### Rollback and Reinstall Decision Points

| Condition | Decision |
|---|---|
| Hash mismatch, missing sidecar artifact, missing manifest, stale commit, or failed packaged initialize probe | Hold the candidate. Rebuild or repair packaging; do not publish and do not bypass with dev fallback. |
| Signing verification unavailable on local smoke | Mark as `unsigned-dev`; do not call the artifact production-ready. |
| Signing verification fails for a release candidate | Block publish until signing is fixed and smoke is rerun. |
| Manual smoke fails on clean temp profile | Hold candidate and capture diagnostic dumps plus the representative stream id. |
| Failure drill does not fail closed | Block release; this is a trust-chain regression. |
| User needs reinstall of the same version | Reinstall the signed installer; preserve `%APPDATA%\jenny` unless the user explicitly chooses a data reset. |
| User needs rollback to a prior release | Prefer the previous signed installer and updater metadata. Verify release-compat coverage before downgrading across schema changes; export user data first if rollback safety is uncertain. |
| Local model or tool asset failure | Repair the local engine/tool installation separately. Current release packages do not bundle model weights, `llama_server_extract/`, language servers, or optional ML/audio/content extras. |

### Manual vs Automated

Automated today:

- Sidecar packaging build and manifest emission.
- Sidecar SBOM emission through `npm run sbom:sidecar`.
- Electron package commands that run sidecar SBOM first.
- Packaged smoke through `npm run release:smoke`.
- Release metadata, version-policy, and SHA256 manifest-block checks.
- GitHub release evidence upload and attestation for build outputs.

Manual today:

- Choosing and recording the release source commit or tag.
- Provisioning and verifying signing identity for production release builds.
- Running and recording the manual test matrix.
- Interpreting local model, speech device, visual UI, and performance-baseline
  evidence.
- Recording failure-drill evidence and release decision in the release notes.
- Deciding rollback/reinstall behavior for a failed or withdrawn candidate.

### SBOM and Dependency-Audit Plan

Existing sidecar SBOM path:

- `npm run sbom:sidecar` runs `python scripts/packaging/emit_sbom.py`.
- Output is `dist/sidecar-sbom.json`.
- Sources are `requirements-lock.txt`, `requirements-build-lock.txt`,
  `requirements-python-runtime-lock.txt`, and the pinned CPython bundle
  contract. The SBOM labels each dependency scope and records lock/manifest
  hashes plus the interpreter source hash.
- The SBOM covers the packaged sidecar, build backend, and managed data runtime.
  It is not a substitute for the sidecar binary or generated-resource manifests.

Npm dependency plan:

- Keep `package-lock.json` as the npm install source for release builds.
- Run `npm audit --omit=dev` for production dependency advisory evidence and
  record the result, accepted exceptions, and any override rationale.
- Add a pinned npm SBOM generator in a follow-up release-tooling task. Prefer an
  npm-native SBOM command when the pinned npm version supports the desired
  CycloneDX output; otherwise pin a CycloneDX npm generator as a dev tool and
  emit `dist/npm-sbom.json`.
- Include app version, package-lock hash, production/dev dependency distinction,
  and npm override notes in the generated SBOM or adjacent evidence.

Python dependency plan:

- Keep `requirements-lock.txt` as the packaged sidecar dependency lock and
  require hashes for artifact builds.
- Keep the build backend in `requirements-build-lock.txt`, align its exact
  setuptools/wheel pins with `pyproject.toml`, and install the project with
  `--no-build-isolation` so the backend cannot be independently resolved.
- Keep the complete CPython 3.13 Windows x64 wheel closure in
  `requirements-python-runtime-lock.txt`; runtime bundle generation accepts
  binary wheels only and requires every artifact hash.
- Keep optional `content`, `media`, `spreadsheet`, `office`, `speech`, `dev`,
  and `all` extras out of the packaged artifact profile unless a release plan
  explicitly promotes them.
- Add a pinned Python advisory gate in a follow-up release-tooling task, such as
  a lockfile-oriented `pip-audit` run, and record accepted advisories with owner,
  reason, and expiry.
- If an optional extra is promoted into packaged runtime, regenerate the lock,
  update the sidecar SBOM, run package smoke, and record the package-size and
  feature-risk decision.

Packaged sidecar artifact plan:

- Treat `build/sidecar/manifest.json` as the artifact-integrity source of truth.
- Attach or copy the packaged `resources/sidecar/manifest.json` fields into the
  release evidence bundle.
- Keep the sidecar SBOM dependency-oriented. Do not replace the binary trust
  chain with SBOM-only evidence.

Bundled model, runtime, and tool asset plan:

- Current state: Windows v1 bundles the verified CPython 3.13.14 embeddable
  interpreter and managed data-runtime wheelhouse. Model weights,
  `llama_server_extract/`, language servers, and optional ML/audio/content
  stacks are not bundled.
- Current first-party packaged tool assets include `services/tools/tool-manifest.json`
  and `skills/**`.
- Current app-resource bundles include `vendor/pretext-layout.umd.js`, which is
  derived from the npm-locked `@chenglou/pretext` dependency. Record its source
  package version, generation/update command if known, license, and SHA256 in
  the release evidence until a dedicated vendor-asset manifest exists.
- Vendored UI asset record: `renderer/inventory/assets/search.svg` comes from
  Tabler Icons v3.46.0 release commit `8ac7d81` at
  `https://github.com/tabler/tabler-icons/blob/v3.46.0/icons/outline/search.svg`,
  under the MIT License (Copyright (c) 2020-2026 Paweł Kuna). Jenny's packaged
  copy has SHA256 `58EBAB223F1EA91FB48F172AEB5779D8B26BE274E794948245A6E64996B0560D`
  and differs only by its embedded attribution/license comment. Update policy:
  review a pinned upstream release, replace the SVG, retain the notice, and
  refresh this hash plus focused tests in the same change. Packaging path:
  `renderer/inventory/assets/search.svg` through the builder's `renderer/**/*`
  rule. Rollback: restore the last reviewed asset/hash or revert the shared
  search-icon CSS in the same release. Smoke coverage: package-contract verifies
  the hash, notice, provenance fields, and builder inclusion; the owner GUI gate
  verifies the search glyph in Chats and Settings.
- Any additional non-lock vendored assets need explicit source, license,
  version, hash, update policy, and rollback evidence.
- Before bundling any local model, model server, language server, native helper,
  or third-party tool asset, add a provenance manifest with source URL, upstream
  version, license, SHA256, update policy, packaging path, rollback behavior,
  and smoke coverage.

### Evidence Locations

- `RELEASE_NOTES.md`: release-visible summary, SHA256 manifest block, manual
  matrix summary, signing state, known deviations, and release decision.
- `docs/BUILDING.md` (this document, Release Provenance and Evidence
  section): stable evidence contract and operator checklist.
- `docs/BUILDING.md` (this document, Packaging Flow section): build and
  smoke commands plus sidecar trust-chain notes.
- `MANUAL_TEST_MATRIX.md`: manual evidence template.
- `artifacts/logs/packaging-smoke-phase4.log`: raw packaged smoke log.
- `dist/sidecar-sbom.json`: sidecar dependency SBOM.
- `docs/operations/release-evidence/w1-a-core-local-model.json`: sanitized,
  durable W1-A result and blocker record; referenced raw artifacts remain under
  ignored `artifacts/release-evidence/` and must obey the same redaction rules.
- GitHub Actions release evidence artifact: build outputs and attestation for
  `build/sidecar/**` and `dist/**`.
