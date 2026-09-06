# Testing a plugin

## Offline contract validation

The generated validators are the authority in both runtimes and must agree byte for byte:

```powershell
.\.venv\Scripts\python.exe scripts\generate_plugin_contracts.py --check
node scripts/run-node-tests-safe.js tests/plugin-contract-parity.test.js --timeout-ms=600000
```

Never use bare `python` in this Windows repository. Contract maintainers add
cases to a parity shard under
`tests/fixtures/plugins/contract-parity/shards/` (one shard per author, each
under 600 lines) and run the parity suite.

## Validate a plugin folder or archive

From the Jenny repository root, validate a working folder containing
`plugin.json` or a completed `.jenny-plugin` archive with one command:

```powershell
npm run plugin:validate -- C:\path\to\plugin-or-theme
npm run plugin:validate -- C:\path\to\plugin.jenny-plugin
```

Checks run in this fixed order:

1. `archive-structure`
2. `manifest-schema`
3. `display-strings`
4. `content-schema` (once per contribution)
5. `content-semantics` (once per contribution)
6. `content-digests` (once per contribution)
7. `budgets`
8. `signature-bundle-shape`
9. `developer-profile-intake`

Folder-only and archive-only checks are reported as `skip`, so a clean
authored folder can pass without a signature bundle while a completed archive
must include one. Archive intake uses the production developer-profile path.

Exit code `0` means no check failed, `1` means at least one validation check
failed, and `2` means the target could not be used (missing, unreadable, the
wrong file type, or an archive passed to `--write-digests`). For automation,
add `--json`; stdout is exactly one result object containing every check and
the pass/fail/skip totals:

```powershell
npm run plugin:validate -- C:\path\to\plugin-or-theme --json
```

For a folder, `--write-digests` recomputes every contribution's exact-byte
SHA-256, rewrites `plugin.json` as normalized two-space JSON, and then runs the
full validation. Review the manifest diff before packaging:

```powershell
npm run plugin:validate -- C:\path\to\plugin-or-theme --write-digests
```

## Budgets and boundaries

Package, view, and host budgets are enforced by `scripts/checks/check_plugin_stage5_budgets.py` through `scripts/checks/check_plugin_stage8_budgets.py` and `scripts/measure_plugin_budgets.py`. Exceeding a budget is a hard reject at intake, so measure before you sign.

## Conformance kits

- Stage 8 full-host conformance: `scripts/plugins/build-stage8-conformance-kit.mjs`, then `scripts/plugins/verify-stage8-conformance-package.mjs`. Real-app intake lives in `tests/helpers/plugins/stage8-signed-package-smoke.js`.
- The public repository does not include an official plugin source tree or a generic third-party source-check template; add focused tests for your own content, view, and host code.

## Error codes

Every rejection is a `CMP-PLUGIN-*` code from `services/backend/error-codes.js`, for example `MANIFEST_INVALID` (0001), `UNSUPPORTED_CONTRACT_VERSION` (0002), `INTEGRITY_FAILED` (0004), `SIGNATURE_INVALID` (0005), `PUBLISHER_UNTRUSTED` (0006), `POLICY_BLOCKED` (0015), `FEATURE_DISABLED` (0022), `CONSENT_REQUIRED` (0023), `RESOURCE_LIMIT_EXCEEDED` (0035). Match on the code, not the message.

## Owner-run gates

Real-app GUI smoke, clean-profile install, consent screens, uninstall and data-removal flows, and full-host tree-empty proofs are owner-run gates. Unit tests and synthetic host bytes do not substitute for them.
