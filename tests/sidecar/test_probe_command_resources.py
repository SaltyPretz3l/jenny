from scripts.packaging.probe_command_resources import run_probe
from tests.sidecar._platform_skips import windows_only


@windows_only("native command resource probe")
def test_real_native_command_exceeds_old_shared_memory_limit():
    evidence = run_probe()
    assert [item["exit_code"] for item in evidence] == [1, 0]
    assert all(item["subsequent_call"] == "passed" for item in evidence)
