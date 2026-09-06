"""Run all policy checks in a deterministic order."""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.checks.bounded_process import run_bounded  # noqa: E402

# The pre-commit hook runs this driver, and the driver had no wall clock: any
# check that wedged blocked every commit indefinitely with nothing printed.
# Bounding the two plugin Node probes closed the known instances; this closes
# the class for all 50. The whole gate is ~35-85s and the slowest single check
# is ~9s, so this ceiling only fires on a genuine wedge.
CHECK_TIMEOUT_SECONDS = 600

CHECKS = [
    "check_boundary.py",
    "check_no_port_bundle_runtime_imports.py",
    "check_backend_seam_boundary.py",
    "check_file_size.py",
    "check_no_utf8_bom.py",
    "check_no_mojibake.py",
    "check_markdown_links.py",
    "check_docs_freshness.py",
    "check_hotspot_size.py",
    "check_monaco_pin.py",
    "check_complexity_ratchets.py",
    "check_css_typography_contract.py",
    "check_protocol_contract.py",
    "check_event_taxonomy_drift.py",
    "check_sidecar_reachability.py",
    "check_dead_code_candidates.py",
    "check_changed_target_test_map.py",
    "check_chat_lifecycle_v2_matrix.py",
    "check_chat_lifecycle_contract_parity.py",
    "check_plugin_contract_parity.py",
    "check_plugin_content_pins.py",
    "check_plugin_contract_freeze.py",
    "measure_plugin_budgets.py",
    "check_plugin_boundary.py",
    "check_plugin_stage_boundary.py",
    # check_plugin_stage8_boundary.py is a library consumed by the stage-boundary check.
    "check_plugin_stage5_budgets.py",
    "check_plugin_stage6_budgets.py",
    "check_plugin_stage7_budgets.py",
    "check_plugin_stage8_budgets.py",
    "check_provider_descriptor_fixtures.py",
    "check_test_coverage_map.py",
    "check_vacuous_oracle.py",
    "check_renderer_app_dispose.py",
    "check_release_compat_registered.py",
    "check_gui_smoke_registered.py",
    "check_quarantine_list.py",
    "check_workspace_manifest.py",
    "check_doc_as_code.py",
    "check_no_stdout_print.py",
    "check_no_raw_html_primitives.py",
    "check_no_os_getenv.py",
    "check_no_secrets.py",
    "check_phase3_security_invariants.py",
    "check_release_metadata.py",
    "check_release_manifest_block.py",
    "check_release_version_policy.py",
    "check_import_fanout.py",
    "check_complexity_contract.py",
    "check_error_codes.py",
    "check_js_logging_contract.py",
    "check_sidecar_packaging.py",
]


# A passing check's own "PASS:" line is dropped when forwarding (this driver prints
# its own), and the remainder is capped. Successful checks used to have their output
# discarded entirely, which hid live WARN/INFO diagnostics; forwarding it verbatim
# swings too far, because check_dead_code_candidates alone prints a ~74-line advisory
# inventory on every commit. The tail stays addressable by running that one check.
FORWARDED_LINE_BUDGET = 12


def _forward_passing_output(check: str, stdout: str, stderr: str) -> None:
    lines = [
        line
        for line in f"{stdout}\n{stderr}".splitlines()
        if line.strip() and not line.startswith("PASS:")
    ]
    for line in lines[:FORWARDED_LINE_BUDGET]:
        print(line)
    hidden = len(lines) - FORWARDED_LINE_BUDGET
    if hidden > 0:
        print(f"  ... {hidden} more line(s); run scripts/checks/{check} to see them")


def main() -> int:
    total_started = time.perf_counter()
    total_checks = len(CHECKS)
    for index, check in enumerate(CHECKS, start=1):
        check_started = time.perf_counter()
        print(f"RUN [{index}/{total_checks}] {check}", flush=True)
        is_budget_check = check == "measure_plugin_budgets.py"
        script = ROOT / "scripts" / (check if is_budget_check else f"checks/{check}")
        command = [sys.executable, str(script)]
        if is_budget_check:
            command.append("--check")
        try:
            result = run_bounded(
                command,
                label=check,
                timeout_seconds=CHECK_TIMEOUT_SECONDS,
                cwd=ROOT,
                # Locale-native, as this driver has always decoded these checks:
                # reading a cp1252 byte as UTF-8 would corrupt the very FAIL text
                # an operator reads to find out what broke.
                encoding=None,
            )
        except RuntimeError as error:
            elapsed = time.perf_counter() - check_started
            print(str(error))
            print(f"FAIL: {check} ({elapsed:.2f}s)")
            return 1
        if result.returncode != 0:
            elapsed = time.perf_counter() - check_started
            if result.stdout:
                print(result.stdout.strip())
            if result.stderr:
                print(result.stderr.strip())
            print(f"FAIL: {check} ({elapsed:.2f}s)")
            return result.returncode
        _forward_passing_output(check, result.stdout or "", result.stderr or "")
        elapsed = time.perf_counter() - check_started
        print(f"PASS: {check} ({elapsed:.2f}s)")

    total_elapsed = time.perf_counter() - total_started
    print(f"PASS: all policy checks ({total_elapsed:.2f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
