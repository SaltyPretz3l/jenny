from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType


def _load_script_module(script_name: str) -> ModuleType:
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "checks" / script_name
    spec = importlib.util.spec_from_file_location(f"test_loader_{script_name}", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive guard
        raise RuntimeError(f"unable to load script module: {script_name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_lines(path: Path, line_count: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(("line\n" * line_count).rstrip("\n"), encoding="utf-8")


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_plugin_boundary_resolves_relative_core_imports(tmp_path, monkeypatch) -> None:
    module = _load_script_module("check_plugin_boundary.py")
    _write_text(
        tmp_path / "services" / "backend" / "unexpected-core-seam.js",
        "const plugin = require('../plugins/example');\n",
    )
    _write_text(
        tmp_path / "services" / "plugins" / "example.js",
        "module.exports = {};\n",
    )
    monkeypatch.setattr(module, "ROOT", tmp_path)

    violations = module._check_js_core_references()

    assert violations == [
        "services/backend/unexpected-core-seam.js references services/plugins/ "
        "(core seam not allowlisted; see JS_CORE_ALLOWLIST)"
    ]


def test_plugin_boundary_python_reference_self_test_is_non_vacuous(monkeypatch) -> None:
    module = _load_script_module("check_plugin_boundary.py")

    assert module._self_test() == []

    monkeypatch.setattr(
        module,
        "PY_REFERENCE",
        module.re.compile(
            r"(?:from\s+sidecar\.ai\.plugins|import\s+sidecar\.ai\.plugins)"
        ),
    )

    failures = module._self_test()

    assert failures
    assert any(
        "wrongly matched '# see from sidecar.ai.plugins import policy'" in failure
        for failure in failures
    )


def test_stage5_budget_ownership_requires_executable_declarations(
    tmp_path, monkeypatch
) -> None:
    module = _load_script_module("check_plugin_stage5_budgets.py")
    ledger = {
        "budgets_schema_version": 1,
        "stage": 5,
        "status": "frozen",
        "frozen": True,
        "approved_packet": "stage5d_activation",
        "activation_stage": 5,
        **module.EXPECTED,
    }
    ledger_path = tmp_path / "config" / "plugins" / "stage5-budgets.json"
    _write_text(ledger_path, json.dumps(ledger))
    comment_markers = {
        "services/plugins/network/bounded-http-client.js": (
            "max_redirects: 5",
            "connect_timeout_ms: 10000",
            "first_byte_timeout_ms: 15000",
            "total_timeout_ms: 120000",
        ),
        "services/plugins/network/dns-pinning.js": ("MAX_DNS_ANSWERS = 16",),
        "services/plugins/distribution/distribution-limits.js": (
            "solverNodes: 64",
            "solverDecisions: 4096",
            "solverIncompatibilities: 8192",
            "cacheBytes: 512 * 1024 * 1024",
            "retainedGenerations: 3",
        ),
        "services/plugins/remote-mcp/operation-scheduler.js": (
            "global_inflight: 4",
            "descriptor_inflight: 1",
            "global_queue: 16",
            "descriptor_queue: 4",
        ),
        "services/plugins/remote-mcp/transport.js": (
            "RESPONSE_MAX_BYTES = 8 * 1024 * 1024",
        ),
        "services/plugins/remote-mcp/sse-parser.js": (
            "max_line_bytes: 64 * 1024",
            "max_events: 10000",
        ),
        "services/plugins/auth/oauth-flow-service.js": (
            "FLOW_TTL_MS = 10 * 60 * 1000",
            "MAX_FLOWS = 4",
            "MAX_STEP_UP_ATTEMPTS = 2",
            "MAX_SCOPES = 32",
        ),
    }
    for relative, markers in comment_markers.items():
        _write_text(
            tmp_path / relative,
            "\n".join(f"// {marker}" for marker in markers) + "\n",
        )
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "LEDGER", ledger_path)

    failures = module.violations()

    assert (
        "services/plugins/network/bounded-http-client.js runtime budget declarations "
        "do not match the frozen ledger"
    ) in failures


def test_stage8_ownership_requires_executable_structures(tmp_path) -> None:
    module = _load_script_module("check_plugin_stage8_boundary.py")
    sources = {
        "services/plugins/lifecycle/stage-gate.js": "// const CONTROL_PLANE_STAGE = 8;\n",
        "services/feature-flags.js": "// privileged_plugins: fe('PRIVILEGED_PLUGINS', false)\n",
        "services/main/plugin-stage8-registration.js": "// NativeSupervisorClient\n",
        "services/plugins/full-host/native-supervisor-client.js": (
            "// env: {}; shell: false; stdio: ['pipe', 'pipe', 'pipe', 'pipe']; "
            "operation: 'deliver_secret'\n"
        ),
        "scripts/plugins/build-stage8-conformance-kit.mjs": (
            "// materializeCommittedCrate; run('git', ['show', value])\n"
        ),
        "scripts/plugins/sign-stage8-conformance-request.mjs": (
            "// CURRENT_KEY_ID canonical_payload_sha256\n"
        ),
        "scripts/plugins/verify-stage8-conformance-package.mjs": (
            "// verifyLocalPackage stage8-conformance\n"
        ),
        "package.json": json.dumps({
            "description": (
                "build:full-host-supervisor:release "
                "build_full_host_supervisor_artifact.py --release"
            )
        }),
        "sidecar/runtime/plugin_host_bridge.py": (
            "# PLUGIN_HOST_METHOD = \"plugin.host\"\n"
        ),
        "sidecar/ai/engines/plugin_host.py": "",
        "sidecar/ai/plugins/runtime_apply_stage8.py": "",
        "services/plugins/native-mcp/runtime-registry.js": "",
        "services/backend/secure-store.js": "// getPluginFullHostSecret safeStorage\n",
        "config/plugins/v6/plugin-runtime-attestation.schema.json": json.dumps({
            "description": (
                "active_generation_id commit_epoch registry_revision dependency_graph_hash"
            )
        }),
    }
    for relative, source in sources.items():
        _write_text(tmp_path / relative, source)

    violations = module.stage8_violations(tmp_path)

    assert "control-plane stage does not match the Stage-8 policy checker" in violations
    assert "native supervisor launch does not prove an empty environment and no shell" in violations
    assert "release packaging does not require clean full-host source provenance" in violations
    assert "V6 runtime attestation omits active_generation_id" in violations


def test_plugin_stage_boundary_fails_closed_on_an_undefined_stage(
    monkeypatch, capsys
) -> None:
    """The invariant that survives the Stage-2..7 fence deletion.

    Owner decision 2026-08-25 (code-hygiene W6-07-F09/F11) accepted that each
    stage defines its OWN fence set and that flipping REPLACES rather than
    accumulates, and the Stage-2..7 definitions were deleted to match. That is
    only safe while a STAGE with no fence set defined here refuses to pass --
    otherwise the next forward flip silently gates nothing, which is precisely
    the failure mode the decision was about.

    This replaces test_plugin_stage_boundary_follows_the_stage3_composition_graph,
    whose subject (_stage3_violations) no longer exists. It is removed because the
    behaviour it pinned was retired by owner decision, not to quiet a red.
    """
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "scripts" / "checks"))
    module = _load_script_module("check_plugin_stage_boundary.py")

    assert module.main() == 0, "the current Stage-8 posture must pass"
    capsys.readouterr()

    monkeypatch.setattr(module, "STAGE", module.PRIVILEGED_ADAPTER_STAGE + 1)

    assert module.main() == 1
    assert "no explicit fence set" in capsys.readouterr().out


def test_check_protocol_contract_passes_for_current_protocol(capsys) -> None:
    module = _load_script_module("check_protocol_contract.py")

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: protocol contract check" in output


def test_check_protocol_contract_fails_when_required_constant_mismatches(
    monkeypatch, capsys
) -> None:
    module = _load_script_module("check_protocol_contract.py")
    monkeypatch.setattr(
        module,
        "parse_string_constants",
        lambda path: {"INITIALIZE_METHOD": "initialize", "CHAT_SEND_METHOD": "wrong"},
    )

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: protocol contract drift detected" in output
    assert "CHAT_SEND_METHOD" in output


def test_protocol_contract_fails_closed_on_unsupported_allowlist_shape(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_protocol_contract.py")
    protocol_path = tmp_path / "protocol.py"
    constants = {
        **module.REQUIRED_CONSTANTS,
        "ALLOWED_NOTIFICATION_METHODS": None,
    }
    source = "\n".join(
        f"{name} = {value!r}"
        for name, value in constants.items()
        if value is not None
    )
    protocol_path.write_text(
        f"{source}\nALLOWED_NOTIFICATION_METHODS = frozenset([CHAT_TOKEN_METHOD])\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(module, "PROTOCOL_PATH", protocol_path)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "ALLOWED_NOTIFICATION_METHODS has an unsupported declaration shape" in output


def test_release_metadata_rejects_lookalike_repository_url(monkeypatch) -> None:
    module = _load_script_module("check_release_metadata.py")
    hostile = "https://attacker.example/SaltyPretz3l/jenny.git"
    monkeypatch.setattr(
        module,
        "_package_metadata",
        lambda root: (
            "0.9.1",
            hostile,
            {"dependencies": {"electron-updater": "1"}, "devDependencies": {}},
        ),
    )
    monkeypatch.setattr(module, "_pyproject_version", lambda root: "0.9.1")
    monkeypatch.setattr(module, "_python_api_version", lambda root: "1")
    monkeypatch.setattr(module, "_electron_api_version", lambda root: "1")
    monkeypatch.setattr(module, "_managed_client_versions", lambda root: [])
    monkeypatch.setattr(module, "_managed_uses_app_version", lambda root: True)
    monkeypatch.setattr(
        module,
        "_electron_builder_publish",
        lambda root: (module.EXPECTED_GITHUB_OWNER, module.EXPECTED_GITHUB_REPO, True),
    )
    monkeypatch.setattr(module, "_validate_updater_release_notes", lambda *args, **kwargs: [])

    violations = module.validate_release_metadata(Path("unused-test-root"))

    assert violations == [
        f"package repository {hostile!r} does not point at SaltyPretz3l/jenny"
    ]


def test_release_workflow_same_step_preload_must_precede_builder(
    tmp_path, monkeypatch
) -> None:
    module = _load_script_module("check_release_version_policy.py")
    workflow = tmp_path / "release.yml"
    workflow.write_text(
        "jobs:\n"
        "  build:\n"
        "    steps:\n"
        "      - run: npm exec -- electron-builder && npm run build:preload\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(module, "RELEASE_WORKFLOWS", (Path("release.yml"),))

    violations = module._validate_release_workflows(tmp_path)

    assert violations == [
        "release.yml job 'build' runs electron-builder without a preceding "
        "'npm run build:preload' command"
    ]


def test_release_version_policy_semver_matches_release_tool() -> None:
    module = _load_script_module("check_release_version_policy.py")
    valid_versions = (
        "0.9.1",
        "0.9.0",
        "1.0.0-alpha.1",
        "1.0.0-rc.1+build.5",
        "1.0.0+20130313144700",
    )
    invalid_versions = ("01.0.0", "1.0.0-01")

    accepted_invalid = [
        version for version in invalid_versions if module.SEMVER_RE.fullmatch(version)
    ]
    rejected_valid = [
        version for version in valid_versions if not module.SEMVER_RE.fullmatch(version)
    ]

    assert accepted_invalid == []
    assert rejected_valid == []


def test_check_hotspot_size_passes_for_small_hotspot_files(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module("check_hotspot_size.py")
    repo_root = tmp_path / "repo"
    for relative_path, cap in module.HOTSPOT_CAPS.items():
        _write_lines(repo_root / relative_path, cap)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: hotspot size check" in output


def test_check_hotspot_size_fails_for_oversized_hotspot_file(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module("check_hotspot_size.py")
    repo_root = tmp_path / "repo"
    for relative_path, cap in module.HOTSPOT_CAPS.items():
        _write_lines(repo_root / relative_path, cap)
    relative_path, cap = next(iter(module.HOTSPOT_CAPS.items()))
    _write_lines(repo_root / relative_path, cap + 1)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "FAIL: hotspot size check" in output
    assert f"{relative_path} ({cap + 1} lines, cap {cap})" in output


def test_check_hotspot_size_fails_for_missing_configured_path(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module("check_hotspot_size.py")
    relative_path = next(iter(module.HOTSPOT_CAPS))
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "HOTSPOT_CAPS", {relative_path: 1})

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert relative_path in output
    assert "update HOTSPOT_CAPS" in output


def test_dead_code_relative_import_from_nested_entrypoint_is_reachable(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_dead_code_candidates.py")
    entrypoint = tmp_path / "app" / "entry.js"
    used = tmp_path / "app" / "lib" / "used.js"
    _write_lines(used, 1)
    entrypoint.write_text("import './lib/used.js';\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "ENTRYPOINTS", [entrypoint])

    exit_code = module.main([])
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 0
    assert "PASS: no obvious dead files found" in output
    assert "app/lib/used.js" not in output


def test_dead_code_python_policy_entrypoint_reaches_javascript_probe() -> None:
    module = _load_script_module("check_dead_code_candidates.py")
    probe_path = module.ROOT / "scripts" / "checks" / "chat_lifecycle_contract_probe.js"

    assert probe_path in module.collect_references()


def test_dead_code_reports_genuinely_unreferenced_file(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module("check_dead_code_candidates.py")
    entrypoint = tmp_path / "index.html"
    orphan = tmp_path / "orphan.js"
    _write_lines(entrypoint, 1)
    _write_lines(orphan, 1)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "ENTRYPOINTS", [entrypoint])

    exit_code = module.main([])
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 0
    assert "WARN: candidate dead files" in output
    assert "orphan.js" in output


def test_dead_code_strict_fails_with_candidate_and_passes_without_one(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_dead_code_candidates.py")
    entrypoint = tmp_path / "index.html"
    orphan = tmp_path / "orphan.js"
    _write_lines(entrypoint, 1)
    _write_lines(orphan, 1)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "ENTRYPOINTS", [entrypoint])

    assert module.main(["--strict"]) == 1
    output = capsys.readouterr().out.replace("\\", "/")
    assert "WARN: candidate dead files" in output
    assert "orphan.js" in output

    entrypoint.write_text('<script src="orphan.js"></script>\n', encoding="utf-8")
    assert module.main(["--strict"]) == 0
    assert "PASS: no obvious dead files found" in capsys.readouterr().out


def test_dead_code_ignored_dirs_are_not_candidates(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module("check_dead_code_candidates.py")
    entrypoint = tmp_path / "index.html"
    _write_lines(entrypoint, 1)
    ignored_dirs = {
        ".jenny", "artifacts", "coverage", "repomix", "prototypes", "study",
        "llama_server_extract", ".claude",
    }
    for directory in ignored_dirs:
        _write_lines(tmp_path / directory / "orphan.js", 1)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "ENTRYPOINTS", [entrypoint])

    exit_code = module.main(["--strict"])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: no obvious dead files found" in output
    assert "orphan.js" not in output


def test_check_no_utf8_bom_passes_when_files_are_utf8_without_bom(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_utf8_bom.py")
    repo_root = tmp_path / "repo"
    sample_file = repo_root / "sidecar" / "sample.py"
    sample_file.parent.mkdir(parents=True, exist_ok=True)
    sample_file.write_text("print('ok')\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: no UTF-8 BOM detected" in output


def test_check_no_utf8_bom_fails_when_file_contains_bom(tmp_path, monkeypatch, capsys) -> None:
    module = _load_script_module("check_no_utf8_bom.py")
    repo_root = tmp_path / "repo"
    sample_file = repo_root / "renderer" / "App.tsx"
    sample_file.parent.mkdir(parents=True, exist_ok=True)
    sample_file.write_bytes(module.UTF8_BOM + b"const value = 1;\n")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "FAIL: UTF-8 BOM detected" in output
    assert "renderer/App.tsx" in output


def test_check_no_mojibake_passes_when_canonical_docs_are_clean(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_mojibake.py")
    repo_root = tmp_path / "repo"
    (repo_root / "docs" / "manifests").mkdir(parents=True, exist_ok=True)
    for relative_path in module.CANONICAL_DOCS:
        path = repo_root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# Clean doc\n", encoding="utf-8")
    (repo_root / "docs" / "manifests" / "ui-ux.md").write_text(
        "# Clean manifest\n", encoding="utf-8"
    )
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: no mojibake markers detected in canonical docs" in output


def test_check_no_mojibake_fails_when_canonical_doc_contains_marker(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_mojibake.py")
    repo_root = tmp_path / "repo"
    (repo_root / "docs" / "manifests").mkdir(parents=True, exist_ok=True)
    for relative_path in module.CANONICAL_DOCS:
        path = repo_root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# Clean doc\n", encoding="utf-8")
    manifest_path = repo_root / "docs" / "manifests" / "ui-ux.md"
    manifest_path.write_text("broken \u00c3\u00a2\u201a\u00ac marker\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "FAIL: mojibake markers detected in canonical docs" in output
    assert "docs/manifests/ui-ux.md:1 contains" in output


def test_check_no_mojibake_fails_when_canonical_doc_contains_common_utf8_latin1_corruption(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_mojibake.py")
    repo_root = tmp_path / "repo"
    (repo_root / "docs" / "manifests").mkdir(parents=True, exist_ok=True)
    for relative_path in module.CANONICAL_DOCS:
        path = repo_root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# Clean doc\n", encoding="utf-8")
    target = repo_root / "README.md"
    target.write_text("caf\u00c3\u00a9\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "README.md:1 contains Ã" in output


def test_check_no_port_bundle_runtime_imports_passes_when_runtime_is_clean(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_port_bundle_runtime_imports.py")
    repo_root = tmp_path / "repo"
    sample = repo_root / "renderer" / "App.tsx"
    sample.parent.mkdir(parents=True, exist_ok=True)
    sample.write_text("import { ChatPanel } from './features/chat/ChatPanel';\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: no runtime imports from PORT_BUNDLES" in output


def test_check_no_port_bundle_runtime_imports_fails_on_runtime_import(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_port_bundle_runtime_imports.py")
    repo_root = tmp_path / "repo"
    sample = repo_root / "renderer" / "App.tsx"
    sample.parent.mkdir(parents=True, exist_ok=True)
    sample.write_text(
        "import { Ref } from '../PORT_BUNDLES/ui_salvage_20260304_1550/files/reference/mock';\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "FAIL: runtime code imports from PORT_BUNDLES" in output
    assert "renderer/App.tsx:1" in output


def test_check_no_raw_html_primitives_scans_active_root_by_default(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_raw_html_primitives.py")
    repo_root = tmp_path / "repo"
    (repo_root / "renderer" / "inventory").mkdir(parents=True, exist_ok=True)
    (repo_root / "index.html").write_text('<button type="button">Raw</button>\n', encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "RENDERER", repo_root / "renderer")
    monkeypatch.setattr(module, "INVENTORY", repo_root / "renderer" / "inventory")
    monkeypatch.setattr(module, "LEGACY_RAW_PRIMITIVE_ALLOWLIST", {}, raising=False)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "FAIL: raw HTML primitives found outside renderer/inventory" in output
    assert "index.html:1" in output


def test_check_no_raw_html_primitives_scans_root_renderer_create_element(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_raw_html_primitives.py")
    repo_root = tmp_path / "repo"
    (repo_root / "renderer" / "inventory").mkdir(parents=True, exist_ok=True)
    sample = repo_root / "renderer" / "shell" / "renderer-workspace-chrome-utils.js"
    sample.parent.mkdir(parents=True, exist_ok=True)
    sample.write_text(
        "export function build(doc) { return doc.createElement('button'); }\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "RENDERER", repo_root / "renderer")
    monkeypatch.setattr(module, "INVENTORY", repo_root / "renderer" / "inventory")
    monkeypatch.setattr(module, "LEGACY_RAW_PRIMITIVE_ALLOWLIST", {}, raising=False)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "renderer/shell/renderer-workspace-chrome-utils.js:1" in output


def test_check_changed_target_test_map_passes_with_valid_mapping(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_changed_target_test_map.py")
    repo_root = tmp_path / "repo"
    checks_dir = repo_root / "scripts" / "checks"
    checks_dir.mkdir(parents=True, exist_ok=True)

    (repo_root / "tests" / "sidecar" / "ai" / "engines").mkdir(parents=True, exist_ok=True)
    (repo_root / "tests" / "sidecar" / "ai" / "engines" / "test_factory.py").write_text(
        "def test_stub() -> None:\n    assert True\n",
        encoding="utf-8",
    )

    mapping = {
        "required_target_prefixes": ["sidecar/ai/engines/"],
        "rules": [
            {
                "target_prefixes": ["sidecar/ai/engines/"],
                "required_tests": ["tests/sidecar/ai/engines/test_factory.py"],
            }
        ],
    }
    map_path = checks_dir / "changed_target_test_map.json"
    map_path.write_text(json.dumps(mapping), encoding="utf-8")

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "MAP_PATH", map_path)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: changed-target test mapping contract" in output


def test_check_changed_target_test_map_fails_when_required_prefix_is_uncovered(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_changed_target_test_map.py")
    repo_root = tmp_path / "repo"
    checks_dir = repo_root / "scripts" / "checks"
    checks_dir.mkdir(parents=True, exist_ok=True)
    map_path = checks_dir / "changed_target_test_map.json"
    map_path.write_text(
        json.dumps(
            {
                "required_target_prefixes": ["sidecar/ai/engines/"],
                "rules": [
                    {
                        "target_prefixes": ["sidecar/ai/tools/"],
                        "required_tests": ["tests/sidecar/ai/tools/test_executor.py"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "MAP_PATH", map_path)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: changed-target test mapping contract" in output
    assert "no rule covers required target prefix: sidecar/ai/engines/" in output


def test_check_changed_target_test_map_rejects_partial_prefix_matches(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_changed_target_test_map.py")
    repo_root = tmp_path / "repo"
    checks_dir = repo_root / "scripts" / "checks"
    checks_dir.mkdir(parents=True, exist_ok=True)
    map_path = checks_dir / "changed_target_test_map.json"
    map_path.write_text(
        json.dumps(
            {
                "required_target_prefixes": ["sidecar/ai/engines/"],
                "rules": [
                    {
                        "target_prefixes": ["sidecar/ai/eng"],
                        "required_tests": ["tests/sidecar/ai/tools/test_executor.py"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "MAP_PATH", map_path)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "no rule covers required target prefix: sidecar/ai/engines/" in output


def test_check_changed_target_test_map_requires_python_tests_under_sidecar_tests_root(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_changed_target_test_map.py")
    repo_root = tmp_path / "repo"
    checks_dir = repo_root / "scripts" / "checks"
    checks_dir.mkdir(parents=True, exist_ok=True)
    map_path = checks_dir / "changed_target_test_map.json"
    map_path.write_text(
        json.dumps(
            {
                "required_target_prefixes": ["sidecar/ai/tools/"],
                "rules": [
                    {
                        "target_prefixes": ["sidecar/ai/tools/"],
                        "required_tests": ["tests/other/test_misc.txt"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "MAP_PATH", map_path)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "test path must be a pytest under tests/sidecar/ or node test under tests/" in output


def test_check_changed_target_test_map_accepts_root_node_tests_for_electron_paths(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_changed_target_test_map.py")
    repo_root = tmp_path / "repo"
    checks_dir = repo_root / "scripts" / "checks"
    checks_dir.mkdir(parents=True, exist_ok=True)
    node_test = repo_root / "tests" / "backend-service-utils.test.js"
    node_test.parent.mkdir(parents=True, exist_ok=True)
    node_test.write_text("'use strict';\n", encoding="utf-8")
    map_path = checks_dir / "changed_target_test_map.json"
    map_path.write_text(
        json.dumps(
            {
                "required_target_prefixes": ["services/"],
                "rules": [
                    {
                        "target_prefixes": ["services/"],
                        "required_tests": ["tests/backend-service-utils.test.js"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "MAP_PATH", map_path)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: changed-target test mapping contract" in output


def test_check_changed_target_test_map_preserves_exact_file_selectors() -> None:
    module = _load_script_module("check_changed_target_test_map.py")
    selector = "services/backend/backend-auth.js"

    assert module._as_non_empty_selector_list([selector]) == [selector]
    assert module._selector_matches_path(selector=selector, path=selector)
    assert not module._selector_matches_path(
        selector=selector,
        path="services/backend/backend-auth-extra.js",
    )


def test_run_all_includes_every_active_policy_check() -> None:
    module = _load_script_module("run_all.py")
    checks_dir = Path(__file__).resolve().parents[2] / "scripts" / "checks"
    # Lane-scoped checks run outside the fast per-commit policy step in
    # run_all.py because they need artifacts that step does not produce:
    # - check_coverage_ratchet.py: coverage CI lanes (after coverage:js:stable
    #   / test:sidecar:cov); needs fresh coverage artifacts. See its module
    #   docstring and docs/plans/TEST_COVERAGE_RATCHET.md.
    # - check_python_runtime_bundle.py: packaging lane (package.json wires
    #   check:python-runtime-bundle before SBOM emission and Electron Builder);
    #   it fails closed unless the gitignored vendor/python-embed bundle has
    #   been built, so a normal dev checkout can never pass it per-commit.
    lane_scoped_checks = {
        "check_coverage_ratchet.py",
        "check_python_runtime_bundle.py",
        # Composed by check_plugin_stage_boundary.py; it has no standalone main.
        "check_plugin_stage8_boundary.py",
    }
    active_checks = sorted([
        path.name
        for path in checks_dir.glob("check_*.py")
        if path.name not in lane_scoped_checks
    ] + ["measure_plugin_budgets.py"])

    assert sorted(module.CHECKS) == active_checks
    assert module.CHECKS.index("check_no_port_bundle_runtime_imports.py") < module.CHECKS.index(
        "check_file_size.py"
    )
    assert "check_changed_target_test_map.py" in module.CHECKS
    assert module.CHECKS.index("check_changed_target_test_map.py") < module.CHECKS.index(
        "check_workspace_manifest.py"
    )
    assert "check_no_mojibake.py" in module.CHECKS
    assert module.CHECKS.index("check_no_utf8_bom.py") < module.CHECKS.index("check_no_mojibake.py")
    assert module.CHECKS.index("check_no_mojibake.py") < module.CHECKS.index(
        "check_workspace_manifest.py"
    )
    assert "check_workspace_manifest.py" in module.CHECKS
    assert module.CHECKS.index("check_workspace_manifest.py") < module.CHECKS.index(
        "check_no_stdout_print.py"
    )
    assert "check_dead_code_candidates.py" in module.CHECKS
    assert "check_sidecar_packaging.py" in module.CHECKS
    assert "check_no_secrets.py" in module.CHECKS


def test_run_all_forwards_successful_check_output(monkeypatch, capsys) -> None:
    module = _load_script_module("run_all.py")
    monkeypatch.setattr(module, "CHECKS", ["fake_check.py"])
    monkeypatch.setattr(
        module,
        "run_bounded",
        lambda *_args, **_kwargs: type(
            "Completed",
            (),
            {
                "returncode": 0,
                "stdout": "WARN: actionable warning\n",
                "stderr": "INFO: diagnostic detail\n",
            },
        )(),
    )

    exit_code = module.main()
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "WARN: actionable warning" in captured.out
    assert "INFO: diagnostic detail" in captured.out
    assert "PASS: fake_check.py" in captured.out


def test_run_all_caps_forwarded_output_and_drops_the_checks_own_pass_line(
    monkeypatch, capsys
) -> None:
    """Forwarding must surface diagnostics without burying them.

    Forwarding a passing check's output verbatim took the pre-commit hook from ~95
    lines to 225: every check's own PASS line printed immediately before this
    driver's, and check_dead_code_candidates dumped its full ~74-entry advisory
    inventory on every commit. A hook that prints a wall of text on every commit
    gets skipped, which loses the WARNs the forwarding exists to surface.
    """
    module = _load_script_module("run_all.py")
    monkeypatch.setattr(module, "CHECKS", ["fake_check.py"])
    noisy = "\n".join(
        ["PASS: fake check succeeded", "WARN: actionable warning"]
        + [f"  - candidate-{index}.js" for index in range(40)]
    )
    monkeypatch.setattr(
        module,
        "run_bounded",
        lambda *_args, **_kwargs: type(
            "Completed", (), {"returncode": 0, "stdout": noisy + "\n", "stderr": ""}
        )(),
    )

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    # The driver prints its own PASS line; the check's must not be echoed beside it.
    assert "PASS: fake check succeeded" not in output
    assert "PASS: fake_check.py" in output
    # The actionable line survives the cap because it comes first ...
    assert "WARN: actionable warning" in output
    # ... while the advisory tail is bounded rather than dumped, and stays reachable.
    assert "candidate-0.js" in output
    assert "candidate-39.js" not in output
    assert "more line(s); run scripts/checks/fake_check.py" in output


def test_test_coverage_allowlist_rejects_malformed_entry_shapes(
    tmp_path, monkeypatch
) -> None:
    from scripts.checks import check_test_coverage_map as module

    repo_root = tmp_path / "repo"
    allowlist_path = repo_root / "scripts" / "checks" / "test_coverage_allowlist.json"
    allowlist_path.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "ALLOWLIST_PATH", allowlist_path)

    malformed_documents = (
        ({"entries": "not-a-list"}, "'entries' must be a list"),
        (["not-an-object"], "entry 1 must be an object"),
    )
    for document, expected in malformed_documents:
        allowlist_path.write_text(json.dumps(document), encoding="utf-8")
        try:
            module._load_allowlist()
        except SystemExit as error:
            assert expected in str(error)
        else:
            raise AssertionError(f"malformed allowlist was accepted: {document!r}")


def test_plugin_parity_corpus_rejects_case_without_string_id(
    tmp_path, monkeypatch
) -> None:
    module = _load_script_module("plugin_parity_corpus.py")
    shard_path = tmp_path / "malformed.json"
    shard_path.write_text('{"cases":[{}],"expectations":{}}', encoding="utf-8")
    monkeypatch.setattr(module, "shard_paths", lambda: [shard_path])

    try:
        module.load_parity_corpus()
    except module.ParityCorpusError as error:
        assert "malformed.json: case 1" in str(error)
        assert "non-empty string 'id'" in str(error)
    else:
        raise AssertionError("malformed parity case was accepted")


def test_provider_descriptor_fixture_rejects_non_string_binding() -> None:
    module = _load_script_module("provider_descriptor_fixtures.py")
    case = {
        "case_id": "x",
        "executable": True,
        "rule": "r",
        "binding": [],
        "input": {},
        "expect": {"value": 1},
    }

    errors = module._validate_case("fixture", case, set())

    assert errors == ["fixture#x: binding [] is outside the closed vocabulary"]


def test_check_no_os_getenv_catches_aliases_and_environ_access(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_os_getenv.py")
    repo_root = tmp_path / "repo"
    target = repo_root / "sidecar" / "runtime" / "env_uses.py"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        "\n".join(
            [
                "import os",
                "import os as system",
                "from os import getenv, environ",
                "a = os.getenv('A')",
                "b = os.environ.get('B')",
                "c = os.environ['C']",
                "d = system.getenv('D')",
                "e = getenv('E')",
                "f = environ.get('F')",
                "g = environ['G']",
            ]
        ),
        encoding="utf-8",
    )
    allowed = repo_root / "sidecar" / "ai" / "config.py"
    allowed.parent.mkdir(parents=True, exist_ok=True)
    allowed.write_text("import os\nVALUE = os.getenv('ALLOWED')\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "SIDECAR", repo_root / "sidecar")
    monkeypatch.setattr(module, "ALLOWED", allowed.resolve())

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "sidecar/runtime/env_uses.py:4" in output
    assert "sidecar/runtime/env_uses.py:5" in output
    assert "sidecar/runtime/env_uses.py:6" in output
    assert "sidecar/runtime/env_uses.py:7" in output
    assert "sidecar/runtime/env_uses.py:8" in output
    assert "sidecar/runtime/env_uses.py:9" in output
    assert "sidecar/runtime/env_uses.py:10" in output
    assert "  - sidecar/ai/config.py" not in output


def test_check_no_stdout_print_ignores_method_named_print(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_stdout_print.py")
    repo_root = tmp_path / "repo"
    sidecar = repo_root / "sidecar"
    sample = sidecar / "runtime" / "writer.py"
    sample.parent.mkdir(parents=True, exist_ok=True)
    sample.write_text("writer.print('ok')\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "TARGET", sidecar)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: no print() in sidecar runtime code" in output


def test_check_no_stdout_print_rejects_direct_print_call(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_stdout_print.py")
    repo_root = tmp_path / "repo"
    sidecar = repo_root / "sidecar"
    sample = sidecar / "runtime" / "writer.py"
    sample.parent.mkdir(parents=True, exist_ok=True)
    sample.write_text("print('leak')\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "TARGET", sidecar)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "sidecar/runtime/writer.py:1" in output


def test_check_no_secrets_flags_high_confidence_tokens(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_secrets.py")
    repo_root = tmp_path / "repo"
    sample = repo_root / "sidecar" / "runtime" / "bad_secret.py"
    sample.parent.mkdir(parents=True, exist_ok=True)
    sample.write_text(
        "API_KEY = 'sk-" + ("a" * 48) + "'\n"
        "PLACEHOLDER = 'sk-your-placeholder-value'\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "FAIL: potential secrets detected" in output
    assert "sidecar/runtime/bad_secret.py:1" in output
    assert "sidecar/runtime/bad_secret.py:2" not in output


def test_check_no_secrets_skips_generated_and_placeholder_values(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_secrets.py")
    repo_root = tmp_path / "repo"
    generated = repo_root / "dist" / "bundle.js"
    generated.parent.mkdir(parents=True, exist_ok=True)
    generated.write_text("const token = 'ghp_" + ("a" * 36) + "';\n", encoding="utf-8")
    example = repo_root / "config.example.json"
    example.write_text('{"api_key": "your-api-key-here"}\n', encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: no high-confidence secrets detected" in output


def test_check_no_secrets_skips_ignored_local_logs_and_context_dumps(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_secrets.py")
    repo_root = tmp_path / "repo"
    for relative_path in [
        ".jenny/session.json",
        ".claude/settings.local.json",
        "tmp-node-safe-current.log",
        "repomix_codebase.md",
        "config.json",
        ".env",
    ]:
        target = repo_root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("api_key = 'sk-" + ("b" * 48) + "'\n", encoding="utf-8")
    active = repo_root / "sidecar" / "runtime" / "safe.py"
    active.parent.mkdir(parents=True, exist_ok=True)
    active.write_text("API_KEY = 'sk-your-placeholder-value'\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: no high-confidence secrets detected" in output


def test_check_no_secrets_scope_is_git_visible_content_only(
    tmp_path, monkeypatch, capsys
) -> None:
    # Intended scope (documented in the script docstring): tracked plus
    # non-ignored untracked files. Gitignored local runtime state holds real
    # user secrets by design, cannot be committed or exported, and is
    # deliberately not scanned.
    import subprocess

    module = _load_script_module("check_no_secrets.py")
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo_root, check=True)
    (repo_root / ".gitignore").write_text("local-config.json\n", encoding="utf-8")
    ignored = repo_root / "local-config.json"
    ignored.write_text("api_key = 'sk-" + ("c" * 48) + "'\n", encoding="utf-8")
    tracked = repo_root / "clean.py"
    tracked.write_text("API_KEY = 'sk-your-placeholder-value'\n", encoding="utf-8")
    subprocess.run(["git", "add", ".gitignore", "clean.py"], cwd=repo_root, check=True)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: no high-confidence secrets detected" in output

    # The same secret in a non-ignored untracked file IS in scope.
    leaking = repo_root / "leaking.py"
    leaking.write_text("api_key = 'sk-" + ("d" * 48) + "'\n", encoding="utf-8")

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "leaking.py:1" in output


def test_check_no_secrets_scans_packaged_vendor_file_but_skips_vendor_snapshots(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_secrets.py")
    repo_root = tmp_path / "repo"
    packaged_vendor = repo_root / "vendor" / "pretext-layout.umd.js"
    skipped_vendor = repo_root / "vendor" / "unsloth" / "snapshot.js"
    packaged_vendor.parent.mkdir(parents=True, exist_ok=True)
    skipped_vendor.parent.mkdir(parents=True, exist_ok=True)
    packaged_vendor.write_text("const token = 'ghp_" + ("c" * 36) + "';\n", encoding="utf-8")
    skipped_vendor.write_text("const token = 'ghp_" + ("d" * 36) + "';\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "vendor/pretext-layout.umd.js:1" in output
    assert "vendor/unsloth/snapshot.js" not in output


def test_check_no_secrets_scans_only_git_visible_candidates(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("check_no_secrets.py")
    repo_root = tmp_path / "repo"
    active = repo_root / "sidecar" / "runtime" / "bad_secret.py"
    ignored = repo_root / "coverage" / "raw.json"
    active.parent.mkdir(parents=True, exist_ok=True)
    ignored.parent.mkdir(parents=True, exist_ok=True)
    active.write_text("API_KEY = 'sk-" + ("e" * 48) + "'\n", encoding="utf-8")
    ignored.write_text("API_KEY = 'sk-" + ("f" * 48) + "'\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_git_visible_paths", lambda: [active])

    exit_code = module.main()
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "sidecar/runtime/bad_secret.py:1" in output
    assert "coverage/raw.json" not in output


def test_clean_workspace_skips_deferred_hygiene_roots(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("clean_workspace.py")
    repo_root = tmp_path / "repo"
    removed_paths = [
        repo_root / "build" / "sidecar" / "artifact.txt",
        repo_root / "dist" / "app" / "bundle.js",
        repo_root / "sidecar" / "runtime" / "__pycache__" / "chat.pyc",
    ]
    preserved_paths = [
        repo_root / "archive" / "legacy" / "build" / "keep.txt",
        repo_root / "vendor" / "unsloth" / "dist" / "keep.js",
        repo_root / "node_modules" / "pkg" / "build" / "keep.js",
        repo_root / ".jenny" / "artifacts" / "session" / "keep.md",
        repo_root / "repomix" / "outputs" / "keep.xml",
        repo_root / "llama_server_extract" / "dist" / "keep.exe",
    ]
    for path in [*removed_paths, *preserved_paths]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: clean complete" in output
    for path in removed_paths:
        assert not path.exists(), f"expected cleanup to remove {path}"
    for path in preserved_paths:
        assert path.exists(), f"expected cleanup to preserve {path}"


def test_clean_workspace_dry_run_reports_without_removing_targets(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("clean_workspace.py")
    repo_root = tmp_path / "repo"
    target = repo_root / "build" / "artifact.txt"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("x\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(["--dry-run"])
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 0
    assert "PASS: clean dry-run" in output
    assert "build" in output
    assert target.exists()


def test_clean_workspace_reports_directory_deletion_failure(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("clean_workspace.py")
    repo_root = tmp_path / "repo"
    target = repo_root / "build"
    target.mkdir(parents=True)
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_cleanup_targets", lambda **_kwargs: [target])

    # Windows does not reliably expose an undeletable temp directory. Model the
    # ignore_errors contract: the old call silently returns, while a strict call raises.
    def _blocked_rmtree(_path, **kwargs) -> None:
        if kwargs.get("ignore_errors"):
            return
        raise OSError("access denied")

    monkeypatch.setattr(module.shutil, "rmtree", _blocked_rmtree)

    exit_code = module.main([])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: could not remove build: access denied" in output
    assert target.exists()


def test_clean_workspace_root_clutter_and_models_are_opt_in(
    tmp_path, monkeypatch, capsys
) -> None:
    module = _load_script_module("clean_workspace.py")
    repo_root = tmp_path / "repo"
    clutter_dir_file = repo_root / "%SystemDrive%" / "Users" / "dump.txt"
    clutter_file = repo_root / "tmp-node-safe-current.log"
    repomix_log = repo_root / "repomix_nontest.log"
    model_file = repo_root / "gemma-4.gguf"
    preserved_paths = [
        repo_root / ".jenny" / "session.json",
        repo_root / ".venv" / "pyvenv.cfg",
        repo_root / "node_modules" / "pkg" / "index.js",
        repo_root / "vendor" / "pretext-layout.umd.js",
        repo_root / "prototypes" / "idea.md",
    ]
    for path in [clutter_dir_file, clutter_file, repomix_log, model_file, *preserved_paths]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x\n", encoding="utf-8")
    monkeypatch.setattr(module, "ROOT", repo_root)

    assert module.main([]) == 0
    capsys.readouterr()
    for path in [clutter_dir_file, clutter_file, repomix_log, model_file, *preserved_paths]:
        assert path.exists(), f"default cleanup should preserve {path}"

    exit_code = module.main(["--include-root-clutter", "--include-local-models"])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: clean complete" in output
    assert not (repo_root / "%SystemDrive%").exists()
    assert not clutter_file.exists()
    assert not repomix_log.exists()
    assert not model_file.exists()
    for path in preserved_paths:
        assert path.exists(), f"opt-in cleanup should preserve {path}"


def test_check_sidecar_packaging_passes_when_probes_succeed(monkeypatch, capsys) -> None:
    module = _load_script_module("check_sidecar_packaging.py")

    observed: list[list[str]] = []

    def _fake_run(command: list[str], **_kwargs):
        observed.append(command)
        if command[-1] == "--version":
            return type(
                "Completed",
                (),
                {"returncode": 0, "stdout": "", "stderr": f"{module.API_VERSION}\n"},
            )()
        return type("Completed", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    monkeypatch.setattr(module.subprocess, "run", _fake_run)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert observed == [
        [module.sys.executable, "-m", "sidecar", "--self-check"],
        [module.sys.executable, "-m", "sidecar", "--version"],
    ]
    assert "PASS: sidecar packaging proof" in output


def test_check_sidecar_packaging_fails_when_probe_fails(monkeypatch, capsys) -> None:
    module = _load_script_module("check_sidecar_packaging.py")

    def _fake_run(command: list[str], **_kwargs):
        if command[-1] == "--self-check":
            return type(
                "Completed",
                (),
                {"returncode": 12, "stdout": "bad", "stderr": "failed import"},
            )()
        return type("Completed", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    monkeypatch.setattr(module.subprocess, "run", _fake_run)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 12
    assert "FAIL: sidecar packaging proof" in output
    assert "--self-check" in output


def test_check_sidecar_packaging_fails_when_version_output_is_missing(monkeypatch, capsys) -> None:
    module = _load_script_module("check_sidecar_packaging.py")

    def _fake_run(command: list[str], **_kwargs):
        if command[-1] == "--version":
            return type("Completed", (), {"returncode": 0, "stdout": "", "stderr": "unknown\n"})()
        return type("Completed", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    monkeypatch.setattr(module.subprocess, "run", _fake_run)

    exit_code = module.main()
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "missing expected api version" in output


def test_run_all_fails_the_gate_when_a_check_wedges(monkeypatch, capsys) -> None:
    """A wedged check must fail the gate, not block the commit forever.

    This driver runs from .git/hooks/pre-commit and had no wall clock of its own,
    so a check that never exited hung every commit with nothing printed.
    """
    module = _load_script_module("run_all.py")
    monkeypatch.setattr(module, "CHECKS", ["fake_check.py"])

    def _wedged(*_args, **_kwargs):
        raise RuntimeError("fake_check.py exceeded 600s and was killed: python fake_check.py")

    monkeypatch.setattr(module, "run_bounded", _wedged)

    exit_code = module.main()
    captured = capsys.readouterr()

    assert exit_code == 1
    assert "exceeded 600s and was killed" in captured.out
    assert "FAIL: fake_check.py" in captured.out


def test_run_all_gives_every_check_a_ceiling(monkeypatch) -> None:
    module = _load_script_module("run_all.py")
    recorded: dict[str, object] = {}

    def _record(command, **kwargs):
        recorded.update(kwargs)
        recorded["command"] = command
        return type("Completed", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    monkeypatch.setattr(module, "CHECKS", ["fake_check.py"])
    monkeypatch.setattr(module, "run_bounded", _record)

    assert module.main() == 0
    assert recorded["timeout_seconds"] == module.CHECK_TIMEOUT_SECONDS
    assert module.CHECK_TIMEOUT_SECONDS > 0
    # Locale-native decoding, as this driver has always read its checks: reading
    # a cp1252 byte as UTF-8 would corrupt the FAIL text an operator relies on.
    assert recorded["encoding"] is None
