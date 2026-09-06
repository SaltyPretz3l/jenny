# ADR-0009: Sidecar Packaging Strategy

## Status
Accepted (Phase 4 hardening)

## Context
Phase 4 requires sidecar packaging hardening and Electron packaging integration prep while preserving
the JSON-RPC over stdio boundary between Electron and Python.

## Decision
- Keep `python -m sidecar` as the canonical development launch path.
- Add a deterministic sidecar artifact producer pipeline:
  - `scripts/packaging/build_sidecar_artifact.py` outputs:
    - `build/sidecar/sidecar(.exe)`,
    - `build/sidecar/manifest.json`.
- Add sidecar entrypoint probes:
  - `python -m sidecar --self-check` for packaging/bootstrap validation,
  - `python -m sidecar --version` for quick runtime version probe.
- Add CI packaging proof (`scripts/checks/check_sidecar_packaging.py`) to continuously validate
  module entrypoint viability.
- Add Electron launch resolution that validates a packaged sidecar binary from
  `resources/sidecar/manifest.json`, preflights it with `--version`, and fails closed when the
  packaged runtime is missing, stale, or untrusted.
- Harden packaged launch trust:
  - packaged binary is accepted only when `resources/sidecar/manifest.json` exists,
  - manifest `api_version` matches Electron runtime contract,
  - manifest `sha256` matches packaged artifact bytes,
  - artifact path remains confined to `resources/sidecar/`,
  - packaged binary passes a local `--version` probe before launch.
- Prepare electron-builder resource mapping (`build/sidecar -> resources/sidecar`) for packaged
  sidecar artifact inclusion.

## Consequences
- Development and tests remain stable without requiring packaged binaries.
- Packaging pipeline can progressively move from module launch to bundled executable without changing
  runtime protocol contracts.
- CI now catches sidecar entrypoint regressions before packaging/release stages.
- Packaged runtime now has an integrity/version gate at the packaging/runtime boundary, reducing
  risk of launching swapped or stale sidecar binaries.
- Packaged builds intentionally do not fall back to `python -m sidecar`; packaged-runtime defects now
  fail loudly during smoke or startup instead of hiding behind the dev launch path.
