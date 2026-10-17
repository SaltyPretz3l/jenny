"""Readiness-marker checks shared by the real-install harnesses (row 47).

The packaged app logs ``window.ready`` after a successful renderer start AND after a
failed load or a startup timeout; only the ``source`` field tells them apart. These
fixtures prove both the POSIX ``markers.sh`` and the Windows harness's probe mode
accept only successful sources, require the managed-sidecar marker from the same
run, and ignore runs that existed before the install.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MARKERS = ROOT / 'scripts' / 'packaging' / 'install-native-linux' / 'markers.sh'
WINDOWS_HARNESS = ROOT / 'scripts' / 'packaging' / 'install-native-windows.ps1'


def _line(event: str, run_id: str, source: str | None = None, startup_ms: int = 700) -> str:
    details = '{"message":"%s","status":"ok"}' % event
    if source is not None:
        details = '{"source":"%s","width":1280,"height":930,"startupMs":%d}' % (source, startup_ms)
    return ('{"ts":"2026-10-13T20:52:03.983Z","level":"INFO","event":"%s","details":%s,'
            '"layer":"electron","component":"electron.main","data":%s,"source":"electron",'
            '"run_id":"%s","sequence":19}' % (event, details, details, run_id))


def _log(tmp_path: Path, lines: list[str]) -> Path:
    log = tmp_path / 'shell.log'
    log.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return log


OLD_RUN = [_line('window.ready', 'old-run', 'renderer-ready', 500),
           _line('backend.managed_sidecar_initialized', 'old-run')]

CASES = {
    'success': ([_line('window.ready', 'new-run', 'renderer-ready', 731),
                 _line('backend.managed_sidecar_initialized', 'new-run')], 0, 'run_id=new-run boot_ms=731'),
    'combined_source': ([_line('window.ready', 'new-run', 'did-finish-load+renderer-ready', 640),
                         _line('backend.managed_sidecar_initialized', 'new-run')], 0, 'run_id=new-run boot_ms=640'),
    'did_fail_load': ([_line('window.ready', 'new-run', 'did-fail-load', 900),
                       _line('backend.managed_sidecar_initialized', 'new-run')], 2, 'FAIL source=did-fail-load'),
    'startup_timeout': ([_line('window.ready', 'new-run', 'startup-timeout', 15000),
                         _line('backend.managed_sidecar_initialized', 'new-run')], 2, 'FAIL source=startup-timeout'),
    'sidecar_missing': ([_line('window.ready', 'new-run', 'renderer-ready', 731)], 1, ''),
    'sidecar_from_other_run': ([_line('window.ready', 'new-run', 'renderer-ready', 731),
                                _line('backend.managed_sidecar_initialized', 'other-run')], 1, ''),
    'only_old_run': ([], 1, ''),
}


@pytest.mark.parametrize('case', sorted(CASES))
def test_posix_markers(tmp_path: Path, case: str) -> None:
    shell = shutil.which('sh')
    if not shell:
        pytest.skip('a POSIX sh is required')
    new_lines, expected_rc, expected_out = CASES[case]
    log = _log(tmp_path, OLD_RUN + new_lines)
    result = subprocess.run([shell, str(MARKERS), str(log), str(len(OLD_RUN))],
                            capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == expected_rc, result.stdout + result.stderr
    assert result.stdout.strip() == expected_out


def test_posix_markers_offset_zero_sees_the_old_run(tmp_path: Path) -> None:
    shell = shutil.which('sh')
    if not shell:
        pytest.skip('a POSIX sh is required')
    log = _log(tmp_path, OLD_RUN)
    result = subprocess.run([shell, str(MARKERS), str(log), '0'],
                            capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0 and result.stdout.strip() == 'run_id=old-run boot_ms=500'


@pytest.mark.parametrize('case', sorted(CASES))
def test_windows_probe(tmp_path: Path, case: str) -> None:
    if sys.platform != 'win32':
        pytest.skip('Windows PowerShell 5.1 is required')
    shell = shutil.which('powershell.exe')
    assert shell, 'Windows PowerShell 5.1 must be tested'
    new_lines, expected_rc, expected_out = CASES[case]
    log = _log(tmp_path, OLD_RUN + new_lines)
    result = subprocess.run([shell, '-NoProfile', '-File', str(WINDOWS_HARNESS),
                             '-ProbeLog', str(log), '-ProbeKnownRunIds', 'old-run'],
                            capture_output=True, text=True, timeout=60, check=False)
    assert result.returncode == expected_rc, result.stdout + result.stderr
    if expected_out:
        assert expected_out in result.stdout
