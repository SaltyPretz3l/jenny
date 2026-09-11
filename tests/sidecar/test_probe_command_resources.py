import sys

import pytest

from scripts.packaging.probe_command_resources import run_probe


@pytest.mark.skipif(sys.platform != "win32", reason="Windows resource probe")
def test_real_native_command_exceeds_old_shared_memory_limit():
    evidence = run_probe()
    assert [item["exit_code"] for item in evidence] == [1, 0]
    assert all(item["subsequent_call"] == "passed" for item in evidence)
