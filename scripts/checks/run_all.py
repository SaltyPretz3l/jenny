"""Run all policy checks and report them in a deterministic order."""
from __future__ import annotations

import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.checks.bounded_process import run_bounded  # noqa: E402

# The pre-commit hook runs this driver, and the driver had no wall clock: any
# check that wedged blocked every commit indefinitely with nothing printed.
# This closes the class of wedged checks for every check in the list. The whole
# gate is ~35-85s and the slowest single check is ~9s, so this ceiling only fires
# on a genuine wedge.
CHECK_TIMEOUT_SECONDS = 600
# The checks are independent read-only scans, one subprocess each, so several run
# at once (run serially the stage took 46-55 s of every gate and commit,
# 2026-10-04). Results are still printed in list order and the first failing
# check in that order decides the exit code, as when they ran one at a time.
MAX_PARALLEL_CHECKS = 6

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
    "check_css_logical_direction.py",
    "check_protocol_contract.py",
    "check_event_taxonomy_drift.py",
    "check_sidecar_reachability.py",
    "check_dead_code_candidates.py",
    "check_changed_target_test_map.py",
    "check_chat_lifecycle_v2_matrix.py",
    "check_chat_lifecycle_contract_parity.py",
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
    "check_icon_button_labels.py",
    "check_i18n_ledger.py",
    "check_i18n_catalogs.py",
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
# swings too far, because check_dead_code_candidates alone prints a multi-line advisory
# inventory on every commit (74 candidates on 2026-09-25 after the entrypoint
# repair, down from 208). The tail stays addressable by running that one check.
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


def _run_check(check: str) -> tuple[subprocess.CompletedProcess[str] | None, str, float]:
    check_started = time.perf_counter()
    script = ROOT / "scripts" / "checks" / check
    command = [sys.executable, str(script)]
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
        return None, str(error), time.perf_counter() - check_started
    return result, "", time.perf_counter() - check_started


def _report_check(check: str, result: subprocess.CompletedProcess[str] | None, error: str,
                  elapsed: float) -> int:
    if result is None:
        print(error)
        print(f"FAIL: {check} ({elapsed:.2f}s)")
        return 1
    if result.returncode != 0:
        if result.stdout:
            print(result.stdout.strip())
        if result.stderr:
            print(result.stderr.strip())
        print(f"FAIL: {check} ({elapsed:.2f}s)")
        return result.returncode
    _forward_passing_output(check, result.stdout or "", result.stderr or "")
    print(f"PASS: {check} ({elapsed:.2f}s)")
    return 0


def main() -> int:
    total_started = time.perf_counter()
    total_checks = len(CHECKS)
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_CHECKS) as pool:
        futures = [pool.submit(_run_check, check) for check in CHECKS]
        try:
            for index, (check, future) in enumerate(zip(CHECKS, futures, strict=True), start=1):
                print(f"RUN [{index}/{total_checks}] {check}", flush=True)
                exit_code = _report_check(check, *future.result())
                if exit_code != 0:
                    return exit_code
        finally:
            # On a failure or an interrupt, queued checks never start; the few
            # already running are bounded. A no-op when every check finished.
            for pending in futures:
                pending.cancel()

    total_elapsed = time.perf_counter() - total_started
    print(f"PASS: all policy checks ({total_elapsed:.2f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
