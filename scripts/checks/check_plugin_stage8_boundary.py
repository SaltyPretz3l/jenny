"""Focused Stage 8 privileged-adapter boundary proof."""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.checks.check_plugin_boundary import inspect_javascript  # noqa: E402

_ANY = object()
CONTROL_PLANE_STAGE = 8
SHA256_HEX_LENGTH = 64
JAVASCRIPT_PATHS = (
    "services/plugins/lifecycle/stage-gate.js",
    "services/feature-flags.js",
    "services/main/plugin-stage8-registration.js",
    "services/plugins/full-host/native-supervisor-client.js",
    "scripts/plugins/build-stage8-conformance-kit.mjs",
    "scripts/plugins/sign-stage8-conformance-request.mjs",
    "scripts/plugins/verify-stage8-conformance-package.mjs",
    "services/plugins/native-mcp/runtime-registry.js",
    "services/backend/secure-store.js",
)
PYTHON_PATHS = (
    "sidecar/ai/engines/plugin_host.py",
    "sidecar/runtime/plugin_host_bridge.py",
    "sidecar/ai/plugins/runtime_apply_stage8.py",
)
ATTESTATION_FIELDS = (
    "active_generation_id",
    "commit_epoch",
    "registry_revision",
    "dependency_graph_hash",
)


def _matches_expected(actual: object, expected: object) -> bool:
    if expected is _ANY:
        return True
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            key in actual and _matches_expected(actual[key], value)
            for key, value in expected.items()
        )
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            _matches_expected(actual_item, expected_item)
            for actual_item, expected_item in zip(actual, expected, strict=True)
        )
    return actual == expected


def _has_call(
    facts: dict[str, object],
    *,
    callee: str,
    function: str,
    arguments: tuple[object, ...] = (),
) -> bool:
    calls = facts.get("calls", [])
    return isinstance(calls, list) and any(
        isinstance(call, dict)
        and call.get("callee") == callee
        and call.get("function") == function
        and isinstance(call.get("args"), list)
        and all(
            _matches_expected(call["args"][index], value)
            for index, value in enumerate(arguments)
        )
        for call in calls
        if isinstance(call, dict) and len(call.get("args", [])) >= len(arguments)
    )


def _has_property(
    facts: dict[str, object],
    *,
    key: str,
    value: object,
    function: str | None = None,
) -> bool:
    properties = facts.get("properties", [])
    return isinstance(properties, list) and any(
        isinstance(item, dict)
        and item.get("key") == key
        and item.get("value") == value
        and (function is None or item.get("function") == function)
        for item in properties
    )


def _python_module(root: Path, relative: str) -> ast.Module | None:
    path = root / relative
    if not path.is_file():
        return None
    return ast.parse(path.read_text(encoding="utf-8"), filename=relative)


def _facts_at(
    facts_by_path: dict[str, dict[str, object]], root: Path, relative: str
) -> dict[str, object]:
    value = facts_by_path.get(str((root / relative).resolve()), {})
    return value if isinstance(value, dict) else {}


def _core_runtime_violations(
    root: Path, facts_by_path: dict[str, dict[str, object]]
) -> list[str]:
    violations: list[str] = []
    gate = _facts_at(facts_by_path, root, "services/plugins/lifecycle/stage-gate.js")
    declarations = gate.get("declarations", {})
    if (
        not isinstance(declarations, dict)
        or declarations.get("CONTROL_PLANE_STAGE") != CONTROL_PLANE_STAGE
    ):
        violations.append("control-plane stage does not match the Stage-8 policy checker")
    flags = _facts_at(facts_by_path, root, "services/feature-flags.js")
    if not _has_property(
        flags,
        key="privileged_plugins",
        value={"$call": "fe", "args": ["PRIVILEGED_PLUGINS", False]},
        function="buildFeatureFlagDefaults",
    ):
        violations.append("privileged plugin kill switch is not independently default-off")
    registration = _facts_at(
        facts_by_path, root, "services/main/plugin-stage8-registration.js"
    )
    imports = registration.get("imports", [])
    imports = imports if isinstance(imports, list) else []
    imports_native_client = any(
        isinstance(item, dict)
        and item.get("source") == "../plugins/full-host/native-supervisor-client"
        and "NativeSupervisorClient" in item.get("names", [])
        for item in imports
    )
    imports_child_process = any(
        isinstance(item, dict)
        and item.get("source") in {"child_process", "node:child_process"}
        for item in imports
    )
    if not imports_native_client or imports_child_process:
        violations.append(
            "Electron Stage-8 composition must launch only through the native supervisor client"
        )
    native_client = _facts_at(
        facts_by_path, root, "services/plugins/full-host/native-supervisor-client.js"
    )
    spawn_options = {
        "stdio": ["pipe", "pipe", "pipe", "pipe"],
        "env": {},
        "shell": False,
    }
    if not _has_call(
        native_client,
        callee="this._spawn",
        function="_connect",
        arguments=(_ANY, [], spawn_options),
    ):
        violations.append(
            "native supervisor launch does not prove an empty environment and no shell"
        )
    if not _has_call(
        native_client,
        callee="this._send",
        function="deliverSecret",
    ) or not _has_property(
        native_client,
        key="operation",
        value="deliver_secret",
        function="deliverSecret",
    ):
        violations.append("direct secrets do not use the dedicated supervisor pipe")
    return violations


def _conformance_violations(
    root: Path,
    facts_by_path: dict[str, dict[str, object]],
    package_text: str,
) -> list[str]:
    violations: list[str] = []
    signing_kit = _facts_at(
        facts_by_path, root, "scripts/plugins/build-stage8-conformance-kit.mjs"
    )
    functions = signing_kit.get("functions", [])
    if "materializeCommittedCrate" not in functions or not _has_call(
        signing_kit,
        callee="run",
        function="committedBytes",
        arguments=("git", ["show", None]),
    ):
        violations.append("Stage-8 signing kit is not built from immutable Git blobs")
    offline_signer = _facts_at(
        facts_by_path, root, "scripts/plugins/sign-stage8-conformance-request.mjs"
    )
    signer_declarations = offline_signer.get("declarations", {})
    signer_members = offline_signer.get("members", [])
    key_id = (
        signer_declarations.get("CURRENT_KEY_ID")
        if isinstance(signer_declarations, dict)
        else None
    )
    has_canonical_digest = isinstance(signer_members, list) and any(
        isinstance(item, dict)
        and item.get("function") == "validateSigningRequest"
        and item.get("property") == "canonical_payload_sha256"
        for item in signer_members
    )
    if (
        not isinstance(key_id, str)
        or len(key_id) != SHA256_HEX_LENGTH
        or not has_canonical_digest
    ):
        violations.append("Stage-8 offline signer is not current-root and canonical-payload bound")
    package_verifier = _facts_at(
        facts_by_path, root, "scripts/plugins/verify-stage8-conformance-package.mjs"
    )
    literals = package_verifier.get("literals", [])
    if not _has_call(
        package_verifier,
        callee="intake.verifyLocalPackage",
        function="verifyStage8ConformancePackage",
    ) or not (
        isinstance(literals, list)
        and any(
            isinstance(item, dict)
            and item.get("function") == "verifyStage8ConformancePackage"
            and item.get("value") == "stage8-conformance"
            for item in literals
        )
    ):
        violations.append("Stage-8 signed package does not re-enter production intake")
    try:
        package_json = json.loads(package_text)
    except ValueError:
        package_json = {}
    scripts = package_json.get("scripts", {}) if isinstance(package_json, dict) else {}
    if not isinstance(scripts, dict) or scripts.get("build:full-host-supervisor:release") != (
        "python scripts/packaging/build_full_host_supervisor_artifact.py --release"
    ):
        violations.append("release packaging does not require clean full-host source provenance")
    return violations


def _python_bridge_violations(root: Path) -> list[str]:
    violations: list[str] = []
    sidecar_bridge = _python_module(root, "sidecar/runtime/plugin_host_bridge.py")
    bridge_constant = None
    if sidecar_bridge is not None:
        for node in sidecar_bridge.body:
            if (
                isinstance(node, ast.Assign)
                and any(
                    isinstance(target, ast.Name) and target.id == "PLUGIN_HOST_METHOD"
                    for target in node.targets
                )
                and isinstance(node.value, ast.Constant)
            ):
                bridge_constant = node.value.value
    if bridge_constant != "plugin.host":
        violations.append("sidecar privileged reverse RPC is not the fixed Jenny-owned method")
    for relative in PYTHON_PATHS:
        module = _python_module(root, relative)
        imported_modules = set()
        if module is not None:
            for node in ast.walk(module):
                if isinstance(node, ast.Import):
                    imported_modules.update(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported_modules.add(node.module)
        if any(
            name == "subprocess"
            or name.startswith("subprocess.")
            or name.startswith("sidecar.ai.mcp.transport_stdio")
            for name in imported_modules
        ):
            violations.append(f"{relative} opens a forbidden privileged process/stdio seam")
    return violations


def _authority_violations(
    root: Path, facts_by_path: dict[str, dict[str, object]]
) -> list[str]:
    violations: list[str] = []
    native_registry = _facts_at(
        facts_by_path, root, "services/plugins/native-mcp/runtime-registry.js"
    )
    registry_keys = {
        item.get("key")
        for item in native_registry.get("properties", [])
        if isinstance(item, dict)
    } | {
        item.get("property")
        for item in native_registry.get("members", [])
        if isinstance(item, dict)
    }
    registry_declarations = native_registry.get("declarations", {})
    registry_literals = native_registry.get("literals", [])
    if (
        "mcp_servers" in registry_keys
        or isinstance(registry_declarations, dict) and "mcp_servers" in registry_declarations
        or any(
            isinstance(item, dict) and item.get("value") == "mcp_servers"
            for item in registry_literals
        )
    ):
        violations.append("native MCP authority is mixed into user-authored mcp_servers state")
    secure_store = _facts_at(facts_by_path, root, "services/backend/secure-store.js")
    secure_functions = secure_store.get("functions", [])
    secure_members = secure_store.get("members", [])
    if "getPluginFullHostSecret" not in secure_functions or not any(
        isinstance(item, dict) and item.get("property") == "safeStorage"
        for item in secure_members
    ):
        violations.append("full-host secrets are not owned by Electron safeStorage")
    return violations


def _attestation_violations(attestation_text: str) -> list[str]:
    try:
        attestation = json.loads(attestation_text)
    except ValueError:
        attestation = {}
    attestation_root = attestation.get("root", {}) if isinstance(attestation, dict) else {}
    required = attestation_root.get("required", []) if isinstance(attestation_root, dict) else []
    properties = (
        attestation_root.get("properties", {}) if isinstance(attestation_root, dict) else {}
    )
    return [
        f"V6 runtime attestation omits {field}"
        for field in ATTESTATION_FIELDS
        if field not in required or not isinstance(properties, dict) or field not in properties
    ]


def stage8_violations(root: Path) -> list[str]:
    violations: list[str] = []

    def text(relative: str) -> str:
        path = root / relative
        if not path.is_file():
            violations.append(f"missing Stage 8 boundary owner: {relative}")
            return ""
        return path.read_text(encoding="utf-8", errors="replace")

    for relative in JAVASCRIPT_PATHS:
        text(relative)
    try:
        facts_by_path = inspect_javascript(
            root,
            [root / relative for relative in JAVASCRIPT_PATHS if (root / relative).is_file()],
        )
    except (OSError, RuntimeError, ValueError) as error:
        violations.append(str(error))
        facts_by_path = {}
    for relative in PYTHON_PATHS:
        text(relative)
    violations.extend(_core_runtime_violations(root, facts_by_path))
    violations.extend(_conformance_violations(root, facts_by_path, text("package.json")))
    violations.extend(_python_bridge_violations(root))
    violations.extend(_authority_violations(root, facts_by_path))
    violations.extend(
        _attestation_violations(text("config/plugins/v6/plugin-runtime-attestation.schema.json"))
    )
    return violations


def run_stage8_check(root: Path) -> int:
    violations = stage8_violations(root)
    if violations:
        print("FAIL: plugin stage boundary check (stage 8)")
        for item in violations:
            print(f"  - {item}")
        return 1
    print("PASS: plugin stage boundary check (stage 8; default-off native supervisor, "
          "fixed authenticated broker, generation-bound MCP/engine/hook authority, safeStorage secrets)")
    return 0
